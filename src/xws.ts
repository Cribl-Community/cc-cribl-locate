// Cross-workspace (Cribl.Cloud org-level) client — SPIKE.
//
// Goal of this module: prove that a sandboxed App Platform app can (a) reach
// external Cribl.Cloud domains through the fetch proxy, (b) mint an OAuth
// client-credentials token, and (c) list the org's workspaces. Per-workspace
// leader fan-out (which needs egress to each workspace's leader FQDN) is a
// later step and intentionally NOT done here.
//
// Auth flow (see AGENTS.md + config/proxies.yml):
//   1. POST https://login.cribl.cloud/oauth/token  (client_id/secret in body)
//   2. Stash access_token in the app KV store.
//   3. GET https://api.cribl.cloud/v2/organizations/:orgId/workspaces
//      — the platform injects `Authorization: Bearer <kv.xwsAccessToken>`
//        via proxies.yml, because apps cannot set the Authorization header
//        directly (the proxy strips it).

const API = () => window.CRIBL_API_URL;

const LOGIN_URL = 'https://login.cribl.cloud/oauth/token';
const CLOUD_API = 'https://api.cribl.cloud';
const AUDIENCE = 'https://api.cribl.cloud';

/** KV key the proxies.yml Authorization injection reads (`kv.xwsAccessToken`). */
const KV_TOKEN_KEY = 'xwsAccessToken';
/** KV key holding the saved connection config (org id + client credentials). */
const KV_CONFIG_KEY = 'xwsConfig';

export interface XwsConfig {
  orgId: string;
  clientId: string;
  clientSecret: string;
}

/** A workspace as returned by the org-level workspaces API. */
export interface Workspace {
  workspaceId: string;
  name?: string;
  alias?: string;
  state?: string;
  region?: string;
  leaderFQDN?: string;
  dnsNames?: string[];
  version?: string;
}

/**
 * A worker group within a workspace, as returned by the org-level
 * `.../workspaces/{name}/workergroups` API. `dnsNames` holds the leader FQDN(s)
 * used to reach that group's control-plane API — needed for the later fan-out.
 */
export interface WorkerGroup {
  /** Group id — the segment used in leader `/m/<id>/...` paths. Falls back to name. */
  id?: string;
  name: string;
  dnsNames?: string[];
  egressIpAddresses?: string[];
  ingressIpAddresses?: string[];
  isFleet?: boolean;
  onPrem?: boolean;
  // Product discriminators. The v2 management-plane response mostly flattens
  // everything to `kind: "worker_group"`, so these are best-effort — see
  // isSearchGroup for why we combine several signals.
  kind?: string;
  type?: string;
  product?: string;
  isSearch?: boolean;
}

/**
 * Stable identifier for a worker group. The leader (`/products/stream/groups`)
 * keys groups by `id` (the segment used in `/m/<id>/...`); the management-plane
 * endpoint only has `name`. Prefer id, fall back to name.
 */
export function groupId(g: WorkerGroup): string {
  return g.id ?? g.name;
}

/** Human label for a worker group — name if present, else the id. */
export function groupLabel(g: WorkerGroup): string {
  return g.name || g.id || '(unnamed group)';
}

/**
 * True when a worker group is a Cribl *Search* group, which we exclude from the
 * search scope (it holds no Stream/Edge sources, pipelines, or routes for Locate
 * to search). The v2 endpoint doesn't cleanly label product type, so mirror the
 * health-checker heuristic: trust an `isSearch` flag, the reserved group name
 * `search`, or any type/product/kind field naming "search".
 */
export function isSearchGroup(g: WorkerGroup): boolean {
  if (g.isSearch) return true;
  if ((g.name ?? '').toLowerCase() === 'search' || (g.id ?? '').toLowerCase() === 'search') return true;
  return [g.type, g.product, g.kind].some((v) => (v ?? '').toLowerCase().includes('search'));
}

/** One line of the spike diagnostic log, surfaced in the UI. */
export interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
}

export class XwsError extends Error {
  readonly steps: StepResult[];
  constructor(message: string, steps: StepResult[]) {
    super(message);
    this.name = 'XwsError';
    this.steps = steps;
  }
}

/** True when running inside Cribl (the fetch proxy + CRIBL_API_URL exist). */
export function inCribl(): boolean {
  return typeof API() === 'string' && API().length > 0;
}

// --- App KV store helpers ----------------------------------------------------

// The app KV store takes the value as the RAW request body with
// `Content-Type: text/plain` — not a JSON object. Structured data must be
// stringified by us and parsed back on read. Secrets are written with
// `?encrypted=true`; they can then only be read at the proxy egress boundary
// (where proxies.yml injects them) and are redacted if the app reads them back.

/** Read a key's raw text value. Returns null on 404 / empty. */
async function kvGetText(key: string, signal?: AbortSignal): Promise<string | null> {
  const res = await fetch(`${API()}/kvstore/${key}`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV get ${key}: ${res.status} ${res.statusText}`);
  const text = await res.text();
  return text ? text : null;
}

/** Write a raw scalar value. Pass `encrypted` for secrets (e.g. tokens). */
async function kvPutText(
  key: string,
  value: string,
  encrypted: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const url = `${API()}/kvstore/${key}${encrypted ? '?encrypted=true' : ''}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: value,
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`KV put ${key}: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
}

// --- Config persistence ------------------------------------------------------

export async function loadConfig(signal?: AbortSignal): Promise<XwsConfig | null> {
  const text = await kvGetText(KV_CONFIG_KEY, signal);
  if (!text) return null;
  try {
    // The persisted config never contains the secret (see saveConfig); normalize
    // to a full XwsConfig with an empty secret so callers don't hit undefined.
    const saved = JSON.parse(text) as Partial<XwsConfig>;
    return {
      orgId: saved.orgId ?? '',
      clientId: saved.clientId ?? '',
      clientSecret: '',
    };
  } catch {
    return null;
  }
}

// SECURITY: the client secret is NEVER persisted. It's used in-memory once to
// mint an access token (see mintToken); only that token is stored, and it's
// stored encrypted (stashToken). We persist just the non-sensitive orgId +
// clientId so the UI can pre-fill them and resume the session with the saved
// token on reload. When the token expires, the user re-enters the secret.
export function saveConfig(cfg: XwsConfig, signal?: AbortSignal): Promise<void> {
  const nonSecret = { orgId: cfg.orgId, clientId: cfg.clientId };
  return kvPutText(KV_CONFIG_KEY, JSON.stringify(nonSecret), false, signal);
}

// --- OAuth + workspace listing ----------------------------------------------

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

/**
 * Exchange client credentials for an access token. Returns the raw token so
 * callers can log a fingerprint (never the whole token) and stash it in KV.
 */
async function mintToken(cfg: XwsConfig, signal?: AbortSignal): Promise<string> {
  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      audience: AUDIENCE,
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`token exchange: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  const data = (await res.json()) as TokenResponse;
  if (!data.access_token) throw new Error('token exchange: response missing access_token');
  return data.access_token;
}

/**
 * Stash the Bearer token in KV (encrypted) so proxies.yml can inject it as the
 * Authorization header at the egress boundary. Written as a raw string, since
 * `kv.xwsAccessToken` is a whole-key lookup used directly as `'Bearer ' + kv...`.
 */
function stashToken(token: string, signal?: AbortSignal): Promise<void> {
  return kvPutText(KV_TOKEN_KEY, token, true, signal);
}

interface WorkspacesResponse {
  items?: Workspace[];
}

/** List the org's workspaces. Requires the Bearer token to be present in KV. */
async function fetchWorkspaces(orgId: string, signal?: AbortSignal): Promise<Workspace[]> {
  const url = `${CLOUD_API}/v2/organizations/${encodeURIComponent(orgId)}/workspaces`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`list workspaces: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  const data = (await res.json()) as WorkspacesResponse | Workspace[];
  // The API has been observed to return either a bare array or a paginated shape.
  return Array.isArray(data) ? data : (data.items ?? []);
}

/**
 * List a workspace's worker groups via the management-plane API. Uses the same
 * proxied `Authorization: Bearer <kv.xwsAccessToken>` injection as the workspace
 * listing, so it needs a valid token already stashed in KV (i.e. call
 * testConnection first). The `{name}` path segment is the workspace *name*
 * (e.g. `main`/`logstream`), not a UUID. Returns a bare array.
 */
export async function fetchWorkerGroups(
  orgId: string,
  workspaceName: string,
  signal?: AbortSignal,
): Promise<WorkerGroup[]> {
  const url = `${CLOUD_API}/v2/organizations/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceName)}/workergroups`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`list worker groups (${workspaceName}): ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  const data = (await res.json()) as WorkerGroup[] | { items?: WorkerGroup[] };
  const all = Array.isArray(data) ? data : (data.items ?? []);
  // Only Stream Worker Groups are a valid config-search scope — drop Search and
  // Edge Fleet groups here so they never surface as options or get auto-selected.
  return all.filter((g) => !isSearchGroup(g) && !g.isFleet);
}

// --- Leader (control-plane) access ------------------------------------------

/**
 * Resolve a workspace's leader FQDN — the host serving its control-plane API
 * (`https://<fqdn>/api/v1/...`). Prefer an explicit field from the API, else
 * construct the documented Cribl.Cloud pattern `<workspaceName>-<orgId>.cribl.cloud`.
 */
export function leaderFqdnFor(orgId: string, ws: Workspace): string {
  const looksLikeHost = (v?: string) => !!v && v.includes('.') && v.endsWith('cribl.cloud');
  if (looksLikeHost(ws.leaderFQDN)) return ws.leaderFQDN as string;
  const dns = ws.dnsNames?.find(looksLikeHost);
  if (dns) return dns;
  const name = ws.name || ws.workspaceId;
  return `${name}-${orgId}.cribl.cloud`;
}

/**
 * The control-plane API root for a workspace's leader — the base the shared
 * config fetchers (api.ts list*) target for cross-workspace search. Mirrors the
 * local `window.CRIBL_API_URL` shape, which already ends in `/api/v1`.
 */
export function leaderApiBase(leaderFqdn: string): string {
  return `https://${leaderFqdn}/api/v1`;
}

/**
 * Best-effort leader host of the workspace this app is installed in. Used to
 * detect the local workspace in the org listing so it isn't searched twice
 * (once locally via CRIBL_API_URL, once as a remote leader). Prefers the host of
 * an absolute CRIBL_API_URL, else the iframe's own hostname if it's a Cribl
 * leader. Returns null when it can't be determined (then nothing is treated as
 * local and every org workspace is reached via its leader FQDN).
 */
export function localLeaderHost(): string | null {
  const api = API();
  try {
    if (api && /^https?:\/\//i.test(api)) return new URL(api).hostname;
  } catch {
    /* not an absolute URL — fall through */
  }
  try {
    const host = window.location?.hostname;
    return host && host.endsWith('cribl.cloud') ? host : null;
  } catch {
    return null;
  }
}

interface LeaderGroupsResponse {
  items?: WorkerGroup[];
}

/**
 * List a workspace's worker groups from its LEADER — the authoritative, complete
 * inventory (includes hybrid/on-prem groups the management-plane endpoint omits).
 * Uses `/products/stream/groups`, which is product-isolated (no Fleet/Search).
 *
 * Requires the leader FQDN to be declared in proxies.yml (see generateProxiesYaml)
 * so the platform proxy allows egress and injects the Bearer token. Until then
 * this throws (egress blocked) and callers should fall back to fetchWorkerGroups.
 */
export async function fetchLeaderGroups(leaderFqdn: string, signal?: AbortSignal): Promise<WorkerGroup[]> {
  const url = `https://${leaderFqdn}/api/v1/products/stream/groups`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`leader groups (${leaderFqdn}): ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  const data = (await res.json()) as LeaderGroupsResponse | WorkerGroup[];
  const all = Array.isArray(data) ? data : (data.items ?? []);
  // `/products/stream/groups` already excludes Search, but filter defensively;
  // also drop Edge Fleets so only Stream Worker Groups are in scope.
  return all.filter((g) => !isSearchGroup(g) && !g.isFleet);
}

/**
 * Build the proxies.yml host block declaring each workspace's leader FQDN, so
 * the platform allows control-plane egress + Bearer injection. The admin pastes
 * this into config/proxies.yml and repacks — leader FQDNs aren't known at pack
 * time and proxies.yml can't wildcard, so this closes that gap explicitly.
 */
export function generateProxiesYaml(orgId: string, workspaces: Workspace[]): string {
  const hosts = Array.from(new Set(workspaces.map((w) => leaderFqdnFor(orgId, w)))).sort();
  return hosts
    .map(
      (host) =>
        `${host}:\n` +
        `  paths:\n` +
        `    allowlist:\n` +
        `      - /api/v1/products/stream/groups\n` +
        `      - /api/v1/m/\n` +
        `  headers:\n` +
        `    inject:\n` +
        `      Authorization: "'Bearer ' + kv.xwsAccessToken"\n` +
        `    allowlist: [Content-Type, Accept]\n` +
        `  timeout: 30000\n` +
        `  rejectUnauthorized: true`,
    )
    .join('\n');
}

/**
 * Full spike: mint token → list workspaces. Returns the workspaces on success.
 * On failure throws an XwsError whose `steps` pinpoint where it broke (egress,
 * auth, KV injection, or permissions) so the UI can show a precise diagnosis.
 */
export async function testConnection(
  cfg: XwsConfig,
  signal?: AbortSignal,
): Promise<{ workspaces: Workspace[]; steps: StepResult[] }> {
  const steps: StepResult[] = [];

  if (!inCribl()) {
    throw new XwsError(
      'Not running inside Cribl — the fetch proxy is unavailable, so external calls cannot be tested from `npm run dev`. Install the app in Cribl Cloud to run this spike.',
      steps,
    );
  }

  let token: string;
  try {
    token = await mintToken(cfg, signal);
    steps.push({
      step: 'OAuth token exchange (login.cribl.cloud)',
      ok: true,
      detail: `Minted access token (…${token.slice(-6)}).`,
    });
  } catch (e) {
    steps.push({ step: 'OAuth token exchange (login.cribl.cloud)', ok: false, detail: (e as Error).message });
    throw new XwsError('Could not mint an access token.', steps);
  }

  try {
    await stashToken(token, signal);
    steps.push({
      step: 'Stash token in KV store',
      ok: true,
      detail: `Wrote the token to KV "${KV_TOKEN_KEY}" for Authorization injection.`,
    });
  } catch (e) {
    steps.push({ step: 'Stash token in KV store', ok: false, detail: (e as Error).message });
    throw new XwsError('Minted a token but could not persist it to KV for header injection.', steps);
  }

  try {
    const workspaces = await fetchWorkspaces(cfg.orgId, signal);
    steps.push({
      step: 'List workspaces (api.cribl.cloud)',
      ok: true,
      detail: `Returned ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}.`,
    });
    return { workspaces, steps };
  } catch (e) {
    steps.push({ step: 'List workspaces (api.cribl.cloud)', ok: false, detail: (e as Error).message });
    throw new XwsError('Token minted, but listing workspaces failed (check org id, permissions, or the Authorization injection).', steps);
  }
}

/**
 * Resume a session WITHOUT the client secret, using the access token already
 * stashed in KV (the proxy injects it). Used on reload/auto-connect so the app
 * never needs the secret again while the token is valid. If the token is missing
 * or expired, listing 401s and this throws an XwsError prompting re-auth.
 */
export async function resumeConnection(
  orgId: string,
  signal?: AbortSignal,
): Promise<{ workspaces: Workspace[]; steps: StepResult[] }> {
  const steps: StepResult[] = [];

  if (!inCribl()) {
    throw new XwsError(
      'Not running inside Cribl — the fetch proxy is unavailable, so external calls cannot be tested from `npm run dev`. Install the app in Cribl Cloud.',
      steps,
    );
  }

  try {
    const workspaces = await fetchWorkspaces(orgId, signal);
    steps.push({
      step: 'Resume with saved session token',
      ok: true,
      detail: `Returned ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'} using the stored token.`,
    });
    return { workspaces, steps };
  } catch (e) {
    steps.push({ step: 'Resume with saved session token', ok: false, detail: (e as Error).message });
    throw new XwsError(
      'Saved session has expired (or no token is stored). Re-enter the API client secret and click Test connection.',
      steps,
    );
  }
}
