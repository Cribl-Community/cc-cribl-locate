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

async function kvGet<T>(key: string, signal?: AbortSignal): Promise<T | null> {
  const res = await fetch(`${API()}/kvstore/${key}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV get ${key}: ${res.status} ${res.statusText}`);
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Value was stored as a raw (non-JSON) string.
    return text as unknown as T;
  }
}

async function kvPut(key: string, value: unknown, signal?: AbortSignal): Promise<void> {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const res = await fetch(`${API()}/kvstore/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal,
  });
  if (!res.ok) throw new Error(`KV put ${key}: ${res.status} ${res.statusText}`);
}

// --- Config persistence ------------------------------------------------------

export function loadConfig(signal?: AbortSignal): Promise<XwsConfig | null> {
  return kvGet<XwsConfig>(KV_CONFIG_KEY, signal);
}

export function saveConfig(cfg: XwsConfig, signal?: AbortSignal): Promise<void> {
  return kvPut(KV_CONFIG_KEY, cfg, signal);
}

// --- OAuth + workspace listing ----------------------------------------------

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

/**
 * Exchange client credentials for an access token and stash it in KV so the
 * proxy can inject it as the Authorization header on the next call.
 * Returns the raw token so callers can log a fingerprint (never the whole token).
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
  await kvPut(KV_TOKEN_KEY, data.access_token, signal);
  return data.access_token;
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

  try {
    const token = await mintToken(cfg, signal);
    steps.push({
      step: 'OAuth token exchange (login.cribl.cloud)',
      ok: true,
      detail: `Minted access token (…${token.slice(-6)}) and wrote it to KV "${KV_TOKEN_KEY}".`,
    });
  } catch (e) {
    steps.push({ step: 'OAuth token exchange (login.cribl.cloud)', ok: false, detail: (e as Error).message });
    throw new XwsError('Could not mint an access token.', steps);
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
