import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Divider,
  EmptyState,
  Link,
  PasswordField,
  Radio,
  RadioGroup,
  Spinner,
  Tag,
  Text,
  TextField,
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
// localLeaderHost lets the panel recognize the workspace this app is installed in.
import {
  type StepResult,
  type WorkerGroup,
  type Workspace,
  type XwsConfig,
  XwsError,
  fetchLeaderGroups,
  fetchWorkerGroups,
  groupId,
  groupLabel,
  inCribl,
  leaderApiBase,
  leaderFqdnFor,
  loadConfig,
  localLeaderHost,
  resumeConnection,
  saveConfig,
  testConnection,
} from './xws';
import {
  type GroupError,
  type MatchMode,
  type ScopeGroup,
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

/** Group and sort search results by resource kind. */
function groupByKind(list: SearchResult[]): Record<ResourceKind, SearchResult[]> {
  const byKind: Record<ResourceKind, SearchResult[]> = {
    source: [],
    destination: [],
    route: [],
    pipeline: [],
  };
  for (const r of list) byKind[r.kind].push(r);
  for (const k of ALL_KINDS)
    byKind[k].sort(
      (a, b) =>
        (a.group.name || a.group.id).localeCompare(b.group.name || b.group.id) ||
        a.name.localeCompare(b.name),
    );
  return byKind;
}

/** Outpost groups aren't Stream Worker Groups, so we hide them. */
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
            {result.workspace && (
              <Tag color="highlight" size="sm">
                {result.workspace}
              </Tag>
            )}
            <Tag color="brand" size="sm">
              {result.group.name || result.group.id}
            </Tag>
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
          {!result.workspace && (
            <Link href={groupHref(result.group)} target="_top">
              Open group <LinkOutlined size="xs" />
            </Link>
          )}
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

/**
 * SPIKE panel: verifies the app can reach Cribl.Cloud, mint an OAuth token, and
 * list the org's workspaces. This proves external egress + auth before the full
 * cross-workspace search (per-leader fan-out) is built.
 */
function CrossWorkspacePanel({
  onScopeChange,
}: {
  /** Reports the currently-selected remote worker groups so the main Search can fan out to them. */
  onScopeChange: (scope: ScopeGroup[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<XwsConfig>({ orgId: '', clientId: '', clientSecret: '' });
  const [testing, setTesting] = useState(false);
  const [steps, setSteps] = useState<StepResult[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Per-workspace worker-group state. Keyed by workspace name (the path param
  // the management-plane API expects). Groups are loaded lazily when a
  // workspace row is expanded, so we don't fan out to every workspace up front.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [wgByWs, setWgByWs] = useState<Record<string, WorkerGroup[]>>({});
  const [wgLoading, setWgLoading] = useState<Set<string>>(new Set());
  const [wgError, setWgError] = useState<Record<string, string>>({});
  // Workspaces whose groups came from the incomplete management-plane fallback
  // (leader egress not yet declared in proxies.yml) — hybrid groups may be missing.
  // Value is the resolved leader FQDN + why the direct leader read failed, so the
  // warning can show the real cause (blocked egress vs 401 audience vs wrong FQDN).
  const [wgIncomplete, setWgIncomplete] = useState<Record<string, { fqdn: string; reason: string }>>(
    {},
  );
  // Search scope: set of `${workspaceName}::${groupName}` keys — defaults to
  // every non-search worker group across every workspace (see the eager-load
  // effect below). The per-workspace checkboxes let the user narrow it down.
  const [scope, setScope] = useState<Set<string>>(new Set());
  const wgAbortsRef = useRef<AbortController[]>([]);

  // Abort any in-flight worker-group loads when the panel unmounts.
  useEffect(
    () => () => {
      for (const ac of wgAbortsRef.current) ac.abort();
    },
    [],
  );

  const scopeKey = (wsName: string, groupName: string) => `${wsName}::${groupName}`;

  // Leader host of the workspace this app is installed in (if determinable). The
  // org workspace listing includes this workspace, so we recognize it to (a) read
  // its complete group list from the local leader (/master, incl. hybrid) and (b)
  // search it via CRIBL_API_URL — no proxies.yml entry needed for our own host.
  const localHost = useMemo(() => localLeaderHost(), []);

  const loadWorkerGroups = useCallback(
    async (ws: Workspace) => {
      const wsName = ws.name || ws.workspaceId;
      if (wgByWs[wsName] || wgLoading.has(wsName)) return; // already loaded / loading
      const orgId = (cfg.orgId ?? '').trim();
      setWgLoading((prev) => new Set(prev).add(wsName));
      setWgError((prev) => {
        const next = { ...prev };
        delete next[wsName];
        return next;
      });
      const ac = new AbortController();
      wgAbortsRef.current.push(ac);
      try {
        const fqdn = leaderFqdnFor(orgId, ws);
        const isLocal = localHost != null && fqdn === localHost;
        let gs: WorkerGroup[];
        let leaderErr: string | null = null;
        if (isLocal) {
          // Our own workspace: read the complete group list from the local leader
          // (/master/groups via CRIBL_API_URL, includes hybrid/on-prem) — the same
          // source the local-only search uses, and no proxies.yml entry required.
          const local = await listGroups(ac.signal);
          gs = local
            .filter((g) => !g.isSearch && !g.isFleet && !isOutpostGroup(g))
            .map((g) => ({
              id: g.id,
              name: g.name ?? g.id,
              isFleet: g.isFleet,
              isSearch: g.isSearch,
              type: g.type,
              product: g.product,
            }));
        } else {
          // Prefer the leader's complete inventory (includes hybrid/on-prem groups);
          // if its FQDN isn't declared in proxies.yml yet, egress is blocked, so
          // fall back to the management-plane list and flag it as incomplete.
          try {
            gs = await fetchLeaderGroups(fqdn, ac.signal);
          } catch (le) {
            if (ac.signal.aborted) return;
            leaderErr = (le as Error).message;
            gs = await fetchWorkerGroups(orgId, wsName, ac.signal);
          }
        }
        if (ac.signal.aborted) return;
        setWgByWs((prev) => ({ ...prev, [wsName]: gs }));
        setWgIncomplete((prev) => {
          const next = { ...prev };
          if (leaderErr) next[wsName] = { fqdn, reason: leaderErr };
          else delete next[wsName];
          return next;
        });
        // Default to searching every group in the workspace; the user narrows down.
        setScope((prev) => {
          const next = new Set(prev);
          for (const g of gs) next.add(scopeKey(wsName, groupId(g)));
          return next;
        });
      } catch (e) {
        if (ac.signal.aborted) return;
        setWgError((prev) => ({ ...prev, [wsName]: (e as Error).message }));
      } finally {
        if (!ac.signal.aborted) {
          setWgLoading((prev) => {
            const next = new Set(prev);
            next.delete(wsName);
            return next;
          });
        }
      }
    },
    [cfg.orgId, wgByWs, wgLoading, localHost],
  );

  // The app searches across ALL workspaces and ALL their (non-search) worker
  // groups by default, so load every workspace's groups as soon as they're
  // listed — each load auto-selects its groups into the scope. loadWorkerGroups
  // is idempotent (it no-ops for workspaces already loaded/loading), so this is
  // safe to re-run; expanding a row just reveals what's already loaded.
  useEffect(() => {
    if (!workspaces) return;
    for (const ws of workspaces) void loadWorkerGroups(ws);
  }, [workspaces, loadWorkerGroups]);

  // The full search scope, resolved to searchable targets. Because the org
  // workspace listing includes the workspace this app is installed in, this is
  // the single source of truth for the main Search — the local workspace is
  // routed via CRIBL_API_URL (no `base`, no workspace label, so its results keep
  // the "Local workspace" grouping and Open-group links), and every other
  // workspace via its leader API base. This means Search never double-counts or
  // double-searches the local workspace.
  const remoteScope = useMemo<ScopeGroup[]>(() => {
    if (!workspaces) return [];
    const orgId = (cfg.orgId ?? '').trim();
    const out: ScopeGroup[] = [];
    for (const ws of workspaces) {
      const wsName = ws.name || ws.workspaceId;
      const groups = wgByWs[wsName];
      if (!groups) continue;
      const fqdn = leaderFqdnFor(orgId, ws);
      const isLocal = localHost != null && fqdn === localHost;
      const base = isLocal ? undefined : leaderApiBase(fqdn);
      for (const g of groups) {
        if (!scope.has(scopeKey(wsName, groupId(g)))) continue;
        out.push({
          group: {
            id: groupId(g),
            name: groupLabel(g),
            isFleet: g.isFleet,
            isSearch: g.isSearch,
            type: g.type,
            product: g.product,
          },
          base,
          workspace: isLocal ? undefined : wsName,
        });
      }
    }
    return out;
  }, [workspaces, wgByWs, scope, cfg.orgId, localHost]);

  // setRemoteScope from the parent is stable, so this just mirrors the derived
  // scope up whenever the selection changes.
  useEffect(() => onScopeChange(remoteScope), [remoteScope, onScopeChange]);

  const toggleExpand = (ws: Workspace) => {
    const wsName = ws.name || ws.workspaceId;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(wsName)) next.delete(wsName);
      else {
        next.add(wsName);
        void loadWorkerGroups(ws);
      }
      return next;
    });
  };

  const toggleGroup = (wsName: string, groupName: string) => {
    const key = scopeKey(wsName, groupName);
    setScope((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Select / clear every group in a workspace at once.
  const setAllGroups = (wsName: string, groups: WorkerGroup[], select: boolean) => {
    setScope((prev) => {
      const next = new Set(prev);
      for (const g of groups) {
        const key = scopeKey(wsName, groupId(g));
        if (select) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  const configComplete = (c: XwsConfig) =>
    (c.orgId ?? '').trim() !== '' &&
    (c.clientId ?? '').trim() !== '' &&
    (c.clientSecret ?? '').trim() !== '';

  // Connect and (via the eager-load effect) pull every workspace's worker groups
  // into the search scope. When the client secret is present (user clicked Test
  // connection) this mints a fresh token; otherwise it resumes using the token
  // already stored in KV — so the secret is never needed on reload. Takes the
  // config explicitly so it can run from a fresh `cfg` or just-loaded saved
  // credentials without waiting for a state update. Stable identity (only stable
  // setters captured) so effects can depend on it safely.
  const connect = useCallback(async (config: XwsConfig) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setTesting(true);
    setError(null);
    setSteps([]);
    setWorkspaces(null);
    // A fresh connection invalidates any previously-loaded worker groups/scope.
    setExpanded(new Set());
    setWgByWs({});
    setWgError({});
    setWgIncomplete({});
    setScope(new Set());
    try {
      // Persist the non-sensitive fields (orgId/clientId) so they survive a
      // reload; the secret is never written (see saveConfig).
      await saveConfig(config, ac.signal).catch(() => {});
      const hasSecret = (config.clientSecret ?? '').trim() !== '';
      const outcome = hasSecret
        ? await testConnection(config, ac.signal)
        : await resumeConnection(config.orgId, ac.signal);
      if (ac.signal.aborted) return;
      setSteps(outcome.steps);
      setWorkspaces(outcome.workspaces);
    } catch (e) {
      if (ac.signal.aborted) return;
      if (e instanceof XwsError) {
        setSteps(e.steps);
        setError(e.message);
      } else {
        setError((e as Error).message);
      }
    } finally {
      if (abortRef.current === ac) setTesting(false);
    }
  }, []);

  // Load any previously-saved connection config from the app KV store and, if
  // it's complete, auto-connect — so cross-workspace groups are already in scope
  // when the user searches, with no manual "Test connection" step.
  // Normalize every field to a string — a saved value with a missing field (or
  // an unexpected KV shape) must not leave `cfg.<field>` undefined, or the
  // `.trim()` guards below throw and crash the panel.
  useEffect(() => {
    if (!inCribl()) return;
    const ac = new AbortController();
    loadConfig(ac.signal)
      .then((saved) => {
        if (saved && !ac.signal.aborted) {
          const next: XwsConfig = {
            orgId: saved.orgId ?? '',
            clientId: saved.clientId ?? '',
            clientSecret: saved.clientSecret ?? '',
          };
          setCfg(next);
          // The secret is never persisted, so `next` has none — auto-resume with
          // the stored token whenever we have an org + client to resume for.
          if ((next.orgId ?? '').trim() && (next.clientId ?? '').trim()) void connect(next);
        }
      })
      .catch(() => {
        /* no saved config yet — ignore */
      });
    return () => ac.abort();
  }, [connect]);

  const setField = (k: keyof XwsConfig) => (value: string) =>
    setCfg((prev) => ({ ...prev, [k]: value }));

  const canTest = configComplete(cfg) && !testing;

  // A successful "Resume with saved session token" step means the app
  // auto-connected from the token saved in KV — surface that in the heading.
  const resumedFromSaved = steps.some(
    (s) => s.ok && s.step === 'Resume with saved session token',
  );

  const runTest = useCallback(() => connect(cfg), [connect, cfg]);

  return (
    <section className="xws-panel">
      <button
        type="button"
        className="section-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={`section-caret${open ? '' : ' collapsed'}`} aria-hidden>
          <ChevronDown size="xs" />
        </span>
        <Text variant="body">
          <strong>Cross-workspace search</strong>
          {resumedFromSaved && <span className="result-dim"> (already configured)</span>}
        </Text>
      </button>

      {open && (
        <div className="xws-body">
          <Text>
            Connect an org-level Cribl.Cloud API credential to search across other
            workspaces. Enter an API client (Organization &rsaquo; API Credentials) with
            permission to read workspaces, then test the connection.
          </Text>

          {!inCribl() && (
            <Alert appearance="warning" layout="inline" title="Runs in Cribl only">
              External calls go through the platform proxy, which isn't available under{' '}
              <code>npm run dev</code>. Install the app in Cribl Cloud to test.
            </Alert>
          )}

          <div className="xws-form">
            <TextField
              label="Organization ID"
              placeholder="your-org-id"
              value={cfg.orgId}
              onChange={setField('orgId')}
            />
            <TextField
              label="API Client ID"
              placeholder="client id"
              value={cfg.clientId}
              onChange={setField('clientId')}
            />
            <PasswordField
              label="API Client Secret"
              placeholder={workspaces ? 'saved session active — re-enter to refresh' : 'client secret'}
              value={cfg.clientSecret}
              onChange={setField('clientSecret')}
            />
          </div>

          <span className="xws-hint result-dim">
            The client secret is used once to mint an access token and is never stored. Only the
            token is saved (encrypted); when it expires, re-enter the secret and test again.
          </span>

          <div className="xws-actions">
            <Button variant="primary" disabled={!canTest} onPress={runTest}>
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
            {testing && <Spinner size="sm" />}
          </div>

          {steps.length > 0 && (
            <ul className="xws-steps">
              {steps.map((s, i) => (
                <li key={i} className={s.ok ? 'ok' : 'fail'}>
                  <strong>{s.ok ? '✓' : '✗'} {s.step}</strong>
                  <span>{s.detail}</span>
                </li>
              ))}
            </ul>
          )}

          {error && (
            <Alert appearance="danger" layout="inline" title="Connection failed">
              {error}
            </Alert>
          )}

          {workspaces && (
            <div className="xws-results">
              <Text variant="body">
                <strong>{workspaces.length}</strong> workspace
                {workspaces.length === 1 ? '' : 's'} visible
                {scope.size > 0 && (
                  <>
                    {' — '}
                    <strong>{scope.size}</strong> worker group
                    {scope.size === 1 ? '' : 's'} selected for search scope
                  </>
                )}
                :
              </Text>
              <ul className="xws-ws-list">
                {workspaces.map((w) => {
                  const wsName = w.name || w.workspaceId;
                  const isOpen = expanded.has(wsName);
                  const groups = wgByWs[wsName];
                  const loading = wgLoading.has(wsName);
                  const err = wgError[wsName];
                  const incomplete = wgIncomplete[wsName];
                  const selectedCount = groups
                    ? groups.filter((g) => scope.has(scopeKey(wsName, groupId(g)))).length
                    : 0;
                  return (
                    <li key={w.workspaceId} className="xws-ws-item">
                      <button
                        type="button"
                        className="xws-ws-head"
                        onClick={() => toggleExpand(w)}
                        aria-expanded={isOpen}
                      >
                        <span className={`section-caret${isOpen ? '' : ' collapsed'}`} aria-hidden>
                          <ChevronDown size="xs" />
                        </span>
                        <Tag color="brand" size="sm">
                          {wsName}
                        </Tag>
                        {w.state && <span className="result-dim">{w.state}</span>}
                        {groups && (
                          <span className="result-dim">
                            {selectedCount}/{groups.length} group
                            {groups.length === 1 ? '' : 's'}
                          </span>
                        )}
                        {w.leaderFQDN && <code className="term-chip">{w.leaderFQDN}</code>}
                      </button>

                      {isOpen && (
                        <div className="xws-wg">
                          {loading && (
                            <span className="result-dim">
                              <Spinner size="sm" /> Loading worker groups…
                            </span>
                          )}
                          {err && (
                            <Alert appearance="danger" layout="inline" title="Couldn't list worker groups">
                              {err}
                            </Alert>
                          )}
                          {incomplete && !err && (
                            <Alert
                              appearance="warning"
                              layout="inline"
                              title="Cloud-managed groups only"
                            >
                              Couldn't read this workspace's leader directly, so this list comes
                              from the management-plane API — hybrid/on-prem groups (e.g.{' '}
                              <code>default-hybrid</code>) may be missing. Add this workspace to{' '}
                              <code>config/xws-workspaces.json</code> and repack for the complete
                              list.
                              <br />
                              <span className="result-dim">
                                Leader <code>{incomplete.fqdn}</code> — {incomplete.reason}
                              </span>
                            </Alert>
                          )}
                          {groups && groups.length === 0 && (
                            <span className="result-dim">No worker groups in this workspace.</span>
                          )}
                          {groups && groups.length > 0 && (
                            <>
                              <div className="xws-wg-bulk">
                                <button
                                  type="button"
                                  className="linkish"
                                  onClick={() => setAllGroups(wsName, groups, true)}
                                >
                                  All
                                </button>
                                <button
                                  type="button"
                                  className="linkish"
                                  onClick={() => setAllGroups(wsName, groups, false)}
                                >
                                  None
                                </button>
                              </div>
                              <ul className="xws-wg-list">
                                {groups.map((g) => (
                                  <li key={groupId(g)}>
                                    <Checkbox
                                      checked={scope.has(scopeKey(wsName, groupId(g)))}
                                      onChange={() => toggleGroup(wsName, groupId(g))}
                                    >
                                      {groupLabel(g)}
                                    </Checkbox>
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>

            </div>
          )}
        </div>
      )}
    </section>
  );
}

function App() {
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<Set<ResourceKind>>(new Set(ALL_KINDS));
  const [mode, setMode] = useState<MatchMode>('any');
  const [showEnabled, setShowEnabled] = useState(true);
  const [showDisabled, setShowDisabled] = useState(true);
  const [collapsedKinds, setCollapsedKinds] = useState<Set<ResourceKind>>(new Set());
  // Collapsed workspace sections in the results ('' = the local workspace).
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set());

  const toggleCollapsed = (k: ResourceKind) =>
    setCollapsedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const toggleWorkspace = (key: string) =>
    setCollapsedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const [groups, setGroups] = useState<ConfigGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  // Selected worker groups in other workspaces, reported by CrossWorkspacePanel.
  const [remoteScope, setRemoteScope] = useState<ScopeGroup[]>([]);

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
        // Only Stream Worker Groups — exclude Edge Fleets, Search, and Outpost groups.
        const gs = all.filter((g) => !g.isSearch && !g.isFleet && !isOutpostGroup(g));
        setGroups(gs);
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
  // Everything the Search fans out to. When the cross-workspace panel is
  // connected it reports the FULL scope (the org listing already includes this
  // workspace, routed via CRIBL_API_URL), so it's authoritative and the separate
  // local `groups` list would double-count — use it only when not connected.
  const searchScope = useMemo<ScopeGroup[]>(
    () => (remoteScope.length ? remoteScope : groups.map((g) => ({ group: g }))),
    [groups, remoteScope],
  );
  // Distinct workspaces in scope. remoteScope carries the local workspace as an
  // `undefined` label, so the set already counts it — no +1. This matches the
  // panel's own "N workspaces visible" count.
  const workspaceCount = useMemo(
    () => new Set(remoteScope.map((s) => s.workspace)).size,
    [remoteScope],
  );
  const canSearch =
    terms.length > 0 && kinds.size > 0 && searchScope.length > 0 && !searching;

  const toggleKind = (k: ResourceKind) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const runSearch = useCallback(async () => {
    if (terms.length === 0 || kinds.size === 0) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    // Search every local Worker Group plus every selected group in other
    // workspaces — there's no picker to narrow scope.
    const scope = searchScope;
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
  }, [searchScope, kinds, terms, mode]);

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

  // Results grouped by workspace (local first), for the collapsible sections.
  // Only used when more than one workspace is present in the results.
  const byWorkspace = useMemo(() => {
    const map = new Map<string, SearchResult[]>();
    for (const r of visibleResults) {
      const key = r.workspace ?? '';
      const bucket = map.get(key);
      if (bucket) bucket.push(r);
      else map.set(key, [r]);
    }
    const keys = Array.from(map.keys()).sort((a, b) =>
      a === '' ? -1 : b === '' ? 1 : a.localeCompare(b),
    );
    return keys.map((key) => ({ key, results: map.get(key) as SearchResult[] }));
  }, [visibleResults]);

  // Render the per-kind collapsible sections for one workspace's (or all)
  // results. Reused for both the flat single-workspace layout and inside each
  // collapsible workspace section.
  const renderKindSections = (list: SearchResult[]) => {
    const grouped = groupByKind(list);
    return ALL_KINDS.filter((k) => kinds.has(k) && grouped[k].length > 0).map((k) => {
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
                  key={`${r.workspace ?? ''}:${r.kind}:${r.group.id}:${r.tableId ?? ''}:${r.id}`}
                  result={r}
                />
              ))}
            </>
          )}
        </div>
      );
    });
  };

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
            Find Sources, Destinations, and Routes by keyword across every Worker Group.
          </Text>
        </div>
      </header>

      <CrossWorkspacePanel onScopeChange={setRemoteScope} />

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
                : `${searchScope.length} Worker Group${searchScope.length === 1 ? '' : 's'}${
                    remoteScope.length ? ` across ${workspaceCount} workspaces` : ''
                  }`}
            </span>
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
                    <WarningOutlined size="xs" />{' '}
                    {e.workspace ? `${e.workspace} / ` : ''}
                    {e.group.name || e.group.id}: {e.message}
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
          ) : byWorkspace.length > 1 ? (
            byWorkspace.map(({ key, results: wsResults }) => {
              const collapsed = collapsedWorkspaces.has(key);
              const label = key === '' ? 'Local workspace' : key;
              return (
                <div key={key || '(local)'} className="workspace-section">
                  <button
                    type="button"
                    className="section-head workspace-head"
                    onClick={() => toggleWorkspace(key)}
                    aria-expanded={!collapsed}
                  >
                    <span className={`section-caret${collapsed ? ' collapsed' : ''}`} aria-hidden>
                      <ChevronDown size="xs" />
                    </span>
                    <Text variant="body">
                      <strong>{label}</strong>
                    </Text>
                    <Badge
                      appearance="neutral"
                      count={wsResults.length}
                      showZero
                      aria-label={`${wsResults.length} matches in ${label}`}
                    />
                  </button>
                  {!collapsed && <div className="workspace-body">{renderKindSections(wsResults)}</div>}
                </div>
              );
            })
          ) : (
            renderKindSections(visibleResults)
          )}
        </section>
      )}

      {!results && !searching && !groupsLoading && !groupsError && (
        <div className="hint">
          <ReloadOutlined size="xs" /> Ready — enter keywords above and search across all{' '}
          {searchScope.length} Worker Group{searchScope.length === 1 ? '' : 's'}
          {remoteScope.length ? ` in ${workspaceCount} workspaces` : ''}.
        </div>
      )}
    </div>
  );
}

export default App;
