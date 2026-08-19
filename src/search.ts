import {
  type ConfigGroup,
  type ConfigItem,
  type ResourceKind,
  type RouteConf,
  listCollectors,
  listDestinations,
  listPipelines,
  listRoutingTables,
  listSources,
} from './api';

export type MatchMode = 'any' | 'all';

export interface SearchResult {
  kind: ResourceKind;
  group: ConfigGroup;
  /** Stable-ish identifier for the resource. */
  id: string;
  /** Display name (falls back to id). */
  name: string;
  /** Sub-type (e.g. "syslog", "s3") for sources/destinations. */
  subType?: string;
  disabled?: boolean;
  /** For routes: the routing table id the route belongs to. */
  tableId?: string;
  /** Fields that matched, with the matched term, for context. */
  matches: FieldMatch[];
  /** The raw config object, for the details view. */
  raw: unknown;
}

export interface FieldMatch {
  field: string;
  value: string;
  terms: string[];
}

export interface GroupError {
  group: ConfigGroup;
  message: string;
}

export interface SearchOutcome {
  results: SearchResult[];
  errors: GroupError[];
  groupsSearched: number;
}

function csvCell(value: string): string {
  // Prefix leading =, +, -, @ to guard against spreadsheet formula injection.
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** Serialize search results to CSV text. */
export function resultsToCsv(results: SearchResult[]): string {
  const header = [
    'Type',
    'Group',
    'Group ID',
    'Name',
    'ID',
    'Sub-type',
    'Disabled',
    'Route group',
    'Matched fields',
    'Matched terms',
  ];
  const rows = results.map((r) => {
    const matchedTerms = Array.from(new Set(r.matches.flatMap((m) => m.terms)));
    return [
      r.kind,
      r.group.name || r.group.id,
      r.group.id,
      r.name,
      r.id,
      r.subType ?? '',
      r.disabled ? 'yes' : 'no',
      r.tableId ?? '',
      r.matches.map((m) => m.field).join('; '),
      matchedTerms.join('; '),
    ].map((v) => csvCell(String(v)));
  });
  return [header.map(csvCell), ...rows].map((cols) => cols.join(',')).join('\r\n');
}

/** Parse the raw query box into individual lowercase terms (comma / newline / whitespace separated). */
export function parseTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .split(/[\n,]+/)
        .flatMap((part) => part.trim().split(/\s+/))
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

/** Return the terms that appear in `value`, or null if none do. */
function termsIn(value: unknown, terms: string[]): string[] | null {
  if (value == null) return null;
  const hay = String(value).toLowerCase();
  const hits = terms.filter((t) => hay.includes(t));
  return hits.length ? hits : null;
}

/**
 * Match named fields first (so we can show where the hit is), then fall back to
 * a deep scan of the whole config object so nested settings (hosts, tokens,
 * pipeline names, etc.) are still found.
 */
function matchFields(
  obj: Record<string, unknown>,
  namedFields: string[],
  terms: string[],
): FieldMatch[] {
  const matches: FieldMatch[] = [];
  const seen = new Set<string>();

  for (const field of namedFields) {
    const hits = termsIn(obj[field], terms);
    if (hits) {
      matches.push({ field, value: String(obj[field]), terms: hits });
      seen.add(field);
    }
  }

  // Deep scan the rest of the config for any term not already surfaced.
  const surfaced = new Set(matches.flatMap((m) => m.terms));
  const remaining = terms.filter((t) => !surfaced.has(t));
  if (remaining.length) {
    const deepHits = termsIn(JSON.stringify(obj), remaining);
    if (deepHits) {
      matches.push({ field: 'config', value: '(nested configuration)', terms: deepHits });
    }
  }

  return matches;
}

const ITEM_FIELDS: Record<ResourceKind, string[]> = {
  source: ['id', 'type', 'host', 'description', 'metadata'],
  destination: ['id', 'type', 'host', 'description', 'metadata'],
  route: ['name', 'id', 'filter', 'pipeline', 'output', 'description'],
  pipeline: ['id', 'description'],
};

/** In "all" mode, require every term to appear somewhere in the item. */
function passesMode(matches: FieldMatch[], terms: string[], mode: MatchMode): boolean {
  if (!matches.length) return false;
  if (mode === 'any') return true;
  const found = new Set(matches.flatMap((m) => m.terms));
  return terms.every((t) => found.has(t));
}

function matchConfigItem(
  item: ConfigItem,
  kind: ResourceKind,
  group: ConfigGroup,
  terms: string[],
  mode: MatchMode,
): SearchResult | null {
  const matches = matchFields(item as Record<string, unknown>, ITEM_FIELDS[kind], terms);
  if (!passesMode(matches, terms, mode)) return null;
  const id = String(item.id ?? '(unknown)');
  return {
    kind,
    group,
    id,
    name: id,
    subType: item.type ? String(item.type) : undefined,
    disabled: Boolean(item.disabled),
    matches,
    raw: item,
  };
}

function matchRoute(
  route: RouteConf,
  tableId: string | undefined,
  group: ConfigGroup,
  terms: string[],
  mode: MatchMode,
): SearchResult | null {
  const matches = matchFields(route as Record<string, unknown>, ITEM_FIELDS.route, terms);
  if (!passesMode(matches, terms, mode)) return null;
  const id = String(route.id ?? route.name ?? '(unnamed route)');
  return {
    kind: 'route',
    group,
    id,
    name: String(route.name ?? id),
    subType: route.pipeline ? String(route.pipeline) : undefined,
    disabled: Boolean(route.disabled),
    tableId,
    matches,
    raw: route,
  };
}

async function searchGroup(
  group: ConfigGroup,
  kinds: Set<ResourceKind>,
  terms: string[],
  mode: MatchMode,
  signal: AbortSignal | undefined,
  onError: (message: string) => void,
): Promise<SearchResult[]> {
  const out: SearchResult[] = [];
  const gid = group.id;

  const tasks: Promise<void>[] = [];

  const scanItems = (
    kind: ResourceKind,
    label: string,
    fetcher: (gid: string, signal?: AbortSignal) => Promise<ConfigItem[]>,
  ) => {
    tasks.push(
      fetcher(gid, signal)
        .then((items) => {
          for (const it of items) {
            const r = matchConfigItem(it, kind, group, terms, mode);
            if (r) out.push(r);
          }
        })
        .catch((e: Error) => onError(`${label}: ${e.message}`)),
    );
  };

  if (kinds.has('source')) {
    // Collectors are a kind of Source in Cribl, so they're bundled under Sources.
    scanItems('source', 'Sources', listSources);
    scanItems('source', 'Collectors', listCollectors);
  }
  if (kinds.has('destination')) scanItems('destination', 'Destinations', listDestinations);
  if (kinds.has('pipeline')) scanItems('pipeline', 'Pipelines', listPipelines);

  if (kinds.has('route')) {
    tasks.push(
      listRoutingTables(gid, signal)
        .then((tables) => {
          for (const table of tables) {
            for (const route of table.routes ?? []) {
              const r = matchRoute(route, table.id, group, terms, mode);
              if (r) out.push(r);
            }
          }
        })
        .catch((e: Error) => onError(`Routes: ${e.message}`)),
    );
  }

  await Promise.all(tasks);
  return out;
}

/**
 * Search the given groups for resources matching any of the terms.
 * Groups are queried with limited concurrency so a large deployment
 * doesn't fire hundreds of requests at once.
 */
export async function searchAll(opts: {
  groups: ConfigGroup[];
  kinds: Set<ResourceKind>;
  terms: string[];
  mode: MatchMode;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}): Promise<SearchOutcome> {
  const { groups, kinds, terms, mode, signal, onProgress } = opts;
  const results: SearchResult[] = [];
  const errors: GroupError[] = [];
  const CONCURRENCY = 6;
  let done = 0;

  let cursor = 0;
  async function worker() {
    while (cursor < groups.length) {
      if (signal?.aborted) return;
      const group = groups[cursor++];
      const groupResults = await searchGroup(group, kinds, terms, mode, signal, (message) =>
        errors.push({ group, message }),
      );
      results.push(...groupResults);
      done += 1;
      onProgress?.(done, groups.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, groups.length) }, () => worker()),
  );

  return { results, errors, groupsSearched: done };
}
