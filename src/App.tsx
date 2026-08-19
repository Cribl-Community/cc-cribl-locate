import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Divider,
  EmptyState,
  Link,
  Radio,
  RadioGroup,
  Spinner,
  Tag,
  Text,
} from '@capra/core';
import {
  ApiOutlined,
  ChevronDown,
  DatabaseOutlined,
  LinkOutlined,
  NodesOutlined,
  PartitionOutlined,
  ReloadOutlined,
  SearchOutlined,
  WarningOutlined,
} from '@capra/icons';
import type { SvgIcon } from '@capra/icons';
import { type ConfigGroup, type ResourceKind, listGroups } from './api';
import {
  type GroupError,
  type MatchMode,
  type SearchResult,
  parseTerms,
  resultsToCsv,
  searchAll,
} from './search';

type KindColor = 'info' | 'success' | 'accent' | 'highlight';

const KIND_META: Record<
  ResourceKind,
  { label: string; plural: string; icon: SvgIcon; color: KindColor }
> = {
  source: { label: 'Source', plural: 'Sources', icon: ApiOutlined, color: 'info' },
  destination: {
    label: 'Destination',
    plural: 'Destinations',
    icon: DatabaseOutlined,
    color: 'success',
  },
  route: { label: 'Route', plural: 'Routes', icon: PartitionOutlined, color: 'accent' },
  pipeline: { label: 'Pipeline', plural: 'Pipelines', icon: NodesOutlined, color: 'highlight' },
};

const ALL_KINDS: ResourceKind[] = ['source', 'destination', 'route', 'pipeline'];

const emptyCounts = (): Record<ResourceKind, number> => ({
  source: 0,
  destination: 0,
  route: 0,
  pipeline: 0,
});

type GroupCategory = 'stream' | 'edge';

const CATEGORY_ORDER: GroupCategory[] = ['stream', 'edge'];

const CATEGORY_LABEL: Record<GroupCategory, string> = {
  stream: 'Stream Worker Groups',
  edge: 'Edge Fleets',
};

/** Classify a config group so Edge Fleets can be scoped separately from Stream Worker Groups. */
function groupCategory(g: ConfigGroup): GroupCategory {
  return g.isFleet ? 'edge' : 'stream';
}

/** Outpost groups aren't Stream Worker Groups or Edge Fleets, so we hide them. */
function isOutpostGroup(g: ConfigGroup): boolean {
  return [g.product, g.type].some((v) => typeof v === 'string' && v.toLowerCase().includes('outpost'));
}

/** Wrap matched terms in <mark> for highlighting. */
function highlight(value: string, terms: string[]) {
  if (!terms.length) return value;
  const escaped = terms
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  const re = new RegExp(`(${escaped.join('|')})`, 'ig');
  const parts = value.split(re);
  const termSet = new Set(terms.map((t) => t.toLowerCase()));
  return parts.map((part, i) =>
    termSet.has(part.toLowerCase()) ? (
      <mark key={i} className="hl">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

/** Best-effort deep link to the group's management page in the Cribl leader UI. */
function groupHref(group: ConfigGroup): string {
  const base = group.isFleet ? '/manage/fleets' : '/manage/groups';
  return `${base}/${encodeURIComponent(group.id)}`;
}

function ResultRow({ result }: { result: SearchResult }) {
  const [open, setOpen] = useState(false);
  const meta = KIND_META[result.kind];
  const Icon = meta.icon;

  return (
    <div className="result-row">
      <div className="result-main">
        <div className="result-icon" aria-hidden>
          <Icon size="sm" />
        </div>
        <div className="result-body">
          <div className="result-title-line">
            <span className="result-name">
              <strong>{result.name}</strong>
            </span>
            {result.subType && <Tag color="default" size="sm">{result.subType}</Tag>}
            {result.disabled && (
              <Tag color="warning" size="sm">
                disabled
              </Tag>
            )}
          </div>
          <div className="result-meta">
            <Tag color={meta.color} size="sm" icon={Icon}>
              {meta.label}
            </Tag>
            <Tag color="brand" size="sm">
              {result.group.name || result.group.id}
            </Tag>
            {result.group.isFleet && (
              <Tag color="default" size="sm">
                fleet
              </Tag>
            )}
            {result.tableId && (
              <span className="result-dim">route group: {result.tableId}</span>
            )}
          </div>
          <ul className="match-list">
            {result.matches.map((m, i) => (
              <li key={i}>
                <span className="match-field">{m.field}</span>
                <span className="match-value">{highlight(m.value, m.terms)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="result-actions">
          <Link href={groupHref(result.group)} target="_top">
            Open group <LinkOutlined size="xs" />
          </Link>
          <button className="linklike" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide config' : 'View config'}
          </button>
        </div>
      </div>
      {open && (
        <pre className="config-dump">{JSON.stringify(result.raw, null, 2)}</pre>
      )}
    </div>
  );
}

function App() {
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<Set<ResourceKind>>(new Set(ALL_KINDS));
  const [mode, setMode] = useState<MatchMode>('any');
  const [showEnabled, setShowEnabled] = useState(true);
  const [showDisabled, setShowDisabled] = useState(true);
  const [collapsedKinds, setCollapsedKinds] = useState<Set<ResourceKind>>(new Set());

  const toggleCollapsed = (k: ResourceKind) =>
    setCollapsedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const [groups, setGroups] = useState<ConfigGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [showGroupPicker, setShowGroupPicker] = useState(false);

  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [errors, setErrors] = useState<GroupError[]>([]);
  const [lastTerms, setLastTerms] = useState<string[]>([]);

  const abortRef = useRef<AbortController | null>(null);

  const loadGroups = useCallback(() => {
    setGroupsLoading(true);
    setGroupsError(null);
    const ac = new AbortController();
    listGroups(ac.signal)
      .then((all) => {
        // Only Stream Worker Groups and Edge Fleets — exclude Search and Outpost groups.
        const gs = all.filter((g) => !g.isSearch && !isOutpostGroup(g));
        setGroups(gs);
        setSelectedGroups(new Set(gs.map((g) => g.id)));
      })
      .catch((e: Error) => {
        // Ignore aborts (e.g. React StrictMode remount, unmount) — they aren't real failures.
        if (ac.signal.aborted) return;
        setGroupsError(e.message);
      })
      .finally(() => {
        if (!ac.signal.aborted) setGroupsLoading(false);
      });
    return () => ac.abort();
  }, []);

  // loadGroups resets loading/error state synchronously (needed for the Retry
  // button); running it on mount to fetch groups is a valid external-sync effect.
  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => loadGroups(), [loadGroups]);

  const terms = useMemo(() => parseTerms(query), [query]);
  const canSearch =
    terms.length > 0 && kinds.size > 0 && selectedGroups.size > 0 && !searching;

  const toggleKind = (k: ResourceKind) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const toggleGroup = (id: string) =>
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Groups split by category, in a stable display order, hiding empty categories.
  const categories = useMemo(() => {
    const byCat: Record<GroupCategory, ConfigGroup[]> = { stream: [], edge: [] };
    for (const g of groups) byCat[groupCategory(g)].push(g);
    for (const cat of CATEGORY_ORDER)
      byCat[cat].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    return CATEGORY_ORDER.filter((cat) => byCat[cat].length > 0).map((cat) => ({
      cat,
      groups: byCat[cat],
    }));
  }, [groups]);

  const setCategorySelected = (catGroups: ConfigGroup[], selected: boolean) =>
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      for (const g of catGroups) {
        if (selected) next.add(g.id);
        else next.delete(g.id);
      }
      return next;
    });

  const runSearch = useCallback(async () => {
    if (terms.length === 0 || kinds.size === 0) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const scope = groups.filter((g) => selectedGroups.has(g.id));
    setSearching(true);
    setResults(null);
    setErrors([]);
    setLastTerms(terms);
    setProgress({ done: 0, total: scope.length });

    try {
      const outcome = await searchAll({
        groups: scope,
        kinds,
        terms,
        mode,
        signal: ac.signal,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      if (!ac.signal.aborted) {
        setResults(outcome.results);
        setErrors(outcome.errors);
      }
    } catch (e) {
      if (!ac.signal.aborted) {
        setErrors([{ group: { id: '—' }, message: (e as Error).message }]);
        setResults([]);
      }
    } finally {
      if (abortRef.current === ac) {
        setSearching(false);
        setProgress(null);
      }
    }
  }, [groups, kinds, selectedGroups, terms, mode]);

  const cancelSearch = () => {
    abortRef.current?.abort();
    setSearching(false);
    setProgress(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSearch) runSearch();
  };

  // Instant status filter applied to the already-fetched results.
  const visibleResults = useMemo(
    () => (results ?? []).filter((r) => (r.disabled ? showDisabled : showEnabled)),
    [results, showEnabled, showDisabled],
  );

  const exportCsv = () => {
    if (!visibleResults.length) return;
    const blob = new Blob([resultsToCsv(visibleResults)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cribl-locate-${lastTerms.join('_') || 'results'}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const counts = useMemo(() => {
    const c = emptyCounts();
    for (const r of visibleResults) c[r.kind] += 1;
    return c;
  }, [visibleResults]);

  const grouped = useMemo(() => {
    const byKind: Record<ResourceKind, SearchResult[]> = {
      source: [],
      destination: [],
      route: [],
      pipeline: [],
    };
    for (const r of visibleResults) byKind[r.kind].push(r);
    for (const k of ALL_KINDS)
      byKind[k].sort(
        (a, b) =>
          (a.group.name || a.group.id).localeCompare(b.group.name || b.group.id) ||
          a.name.localeCompare(b.name),
      );
    return byKind;
  }, [visibleResults]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <SearchOutlined size="md" />
          <Text as="h1" variant="heading">
            Cribl Locate
          </Text>
        </div>
        <div className="app-subtitle">
          <Text>
            Find Sources, Destinations, and Routes by keyword across every Worker Group and
            Fleet.
          </Text>
        </div>
      </header>

      {groupsError && (
        <Alert appearance="danger" title="Couldn't load Worker Groups">
          {groupsError}. This app must run inside Cribl to reach the API.{' '}
          <button className="linklike" onClick={loadGroups}>
            Retry
          </button>
        </Alert>
      )}

      <section className="search-panel">
        <textarea
          className="query-input"
          placeholder="Enter one or more keywords (e.g. splunk, s3, prod-token). Separate with spaces, commas, or new lines."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
        />

        <div className="controls">
          <div className="kind-toggles">
            {ALL_KINDS.map((k) => (
              <Checkbox
                key={k}
                checked={kinds.has(k)}
                onChange={() => toggleKind(k)}
              >
                {KIND_META[k].plural}
              </Checkbox>
            ))}
          </div>

          <div className="mode-toggle">
            <RadioGroup
              value={mode}
              onChange={(e) => setMode(e.target.value as MatchMode)}
              layout="horizontal"
              aria-label="Keyword match mode"
            >
              <Radio value="any">Match any keyword</Radio>
              <Radio value="all">Match all keywords</Radio>
            </RadioGroup>
          </div>

          <div className="control-actions">
            <span className="scope-label">
              {groupsLoading
                ? 'Loading groups…'
                : `${selectedGroups.size} of ${groups.length} group${groups.length === 1 ? '' : 's'}`}
            </span>
            {groups.length > 0 && (
              <button
                className="linklike"
                onClick={() => setShowGroupPicker((s) => !s)}
              >
                {showGroupPicker ? 'Hide groups' : 'Choose groups'}
              </button>
            )}
            {searching ? (
              <Button variant="secondary" onPress={cancelSearch}>
                Cancel
              </Button>
            ) : (
              <Button
                variant="primary"
                leadingIcon={SearchOutlined}
                disabled={!canSearch}
                onPress={runSearch}
              >
                Search
              </Button>
            )}
          </div>
        </div>

        {!groupsLoading && categories.length > 1 && (
          <div className="scope-categories">
            <span className="scope-cat-label">Scope:</span>
            {categories.map(({ cat, groups: cg }) => {
              const selCount = cg.filter((g) => selectedGroups.has(g.id)).length;
              const all = selCount === cg.length;
              return (
                <Checkbox
                  key={cat}
                  checked={all}
                  indeterminate={selCount > 0 && !all}
                  onChange={() => setCategorySelected(cg, !all)}
                >
                  {`${CATEGORY_LABEL[cat]} (${selCount}/${cg.length})`}
                </Checkbox>
              );
            })}
          </div>
        )}

        {showGroupPicker && groups.length > 0 && (
          <div className="group-picker">
            <div className="group-picker-head">
              <button
                className="linklike"
                onClick={() => setSelectedGroups(new Set(groups.map((g) => g.id)))}
              >
                Select all
              </button>
              <button className="linklike" onClick={() => setSelectedGroups(new Set())}>
                Clear
              </button>
            </div>
            {categories.map(({ cat, groups: cg }) => (
              <div key={cat} className="group-cat">
                <div className="group-cat-head">
                  <Text variant="body">
                    <strong>{CATEGORY_LABEL[cat]}</strong>
                  </Text>
                  <button className="linklike" onClick={() => setCategorySelected(cg, true)}>
                    all
                  </button>
                  <button className="linklike" onClick={() => setCategorySelected(cg, false)}>
                    none
                  </button>
                </div>
                <div className="group-grid">
                  {cg.map((g) => (
                    <Checkbox
                      key={g.id}
                      checked={selectedGroups.has(g.id)}
                      onChange={() => toggleGroup(g.id)}
                    >
                      {g.name || g.id}
                    </Checkbox>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {searching && progress && (
        <div className="progress">
          <Spinner size="sm" />
          <Text>
            Searching group {progress.done} of {progress.total}…
          </Text>
        </div>
      )}

      {results && !searching && (
        <section className="results">
          <div className="results-summary">
            <Text variant="body">
              <strong>{visibleResults.length}</strong> match
              {visibleResults.length === 1 ? '' : 'es'} for{' '}
              {lastTerms.map((t, i) => (
                <span key={t}>
                  {i > 0 && ', '}
                  <code className="term-chip">{t}</code>
                </span>
              ))}
            </Text>
            <div className="summary-badges">
              {ALL_KINDS.filter((k) => kinds.has(k)).map((k) => (
                <span key={k} className="summary-badge">
                  <Tag color={KIND_META[k].color} size="sm" icon={KIND_META[k].icon}>
                    {`${counts[k]} ${KIND_META[k].plural}`}
                  </Tag>
                </span>
              ))}
              {visibleResults.length > 0 && (
                <Button size="sm" variant="secondary" onPress={exportCsv}>
                  Export CSV
                </Button>
              )}
            </div>
          </div>

          <div className="status-filter">
            <span className="scope-cat-label">Status:</span>
            <Checkbox checked={showEnabled} onChange={() => setShowEnabled((v) => !v)}>
              Enabled
            </Checkbox>
            <Checkbox checked={showDisabled} onChange={() => setShowDisabled((v) => !v)}>
              Disabled
            </Checkbox>
          </div>

          {errors.length > 0 && (
            <Alert appearance="warning" layout="inline" title={`${errors.length} group query error${errors.length === 1 ? '' : 's'}`}>
              <ul className="error-list">
                {errors.map((e, i) => (
                  <li key={i}>
                    <WarningOutlined size="xs" /> {e.group.name || e.group.id}: {e.message}
                  </li>
                ))}
              </ul>
            </Alert>
          )}

          {visibleResults.length === 0 ? (
            <EmptyState
              illustration="EmptyFolder"
              title="No matches"
              description={
                results.length > 0
                  ? `${results.length} match${results.length === 1 ? '' : 'es'} hidden by the current status filter. Enable "Enabled" or "Disabled" above to show them.`
                  : 'No Sources, Destinations, Routes, or Pipelines matched your keywords in the selected groups.'
              }
            />
          ) : (
            ALL_KINDS.filter((k) => kinds.has(k) && grouped[k].length > 0).map((k) => {
              const isCollapsed = collapsedKinds.has(k);
              return (
                <div key={k} className="result-section">
                  <button
                    type="button"
                    className="section-head"
                    onClick={() => toggleCollapsed(k)}
                    aria-expanded={!isCollapsed}
                  >
                    <span className={`section-caret${isCollapsed ? ' collapsed' : ''}`} aria-hidden>
                      <ChevronDown size="xs" />
                    </span>
                    <Text variant="body">
                      <strong>{KIND_META[k].plural}</strong>
                    </Text>
                    <Badge
                      appearance="neutral"
                      count={grouped[k].length}
                      showZero
                      aria-label={`${grouped[k].length} ${KIND_META[k].plural}`}
                    />
                  </button>
                  {!isCollapsed && (
                    <>
                      <Divider />
                      {grouped[k].map((r) => (
                        <ResultRow
                          key={`${r.kind}:${r.group.id}:${r.tableId ?? ''}:${r.id}`}
                          result={r}
                        />
                      ))}
                    </>
                  )}
                </div>
              );
            })
          )}
        </section>
      )}

      {!results && !searching && !groupsLoading && !groupsError && (
        <div className="hint">
          <ReloadOutlined size="xs" /> Ready — enter keywords above and search across{' '}
          {selectedGroups.size} of {groups.length} group{groups.length === 1 ? '' : 's'}.
        </div>
      )}
    </div>
  );
}

export default App;
