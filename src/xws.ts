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
  version?: string;
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
    return JSON.parse(text) as XwsConfig;
  } catch {
    return null;
  }
}

// Config is stored unencrypted so the app can read the client secret back to
// perform the OAuth exchange (encrypted values are redacted on read). The
// minted access token, by contrast, is stored encrypted — see stashToken.
export function saveConfig(cfg: XwsConfig, signal?: AbortSignal): Promise<void> {
  return kvPutText(KV_CONFIG_KEY, JSON.stringify(cfg), false, signal);
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
