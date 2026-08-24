// Thin client for the Cribl REST API endpoints this app reads.
// All calls are GET (read-only) and go through the platform fetch proxy,
// which injects auth and scopes the request to this app.

const API = () => window.CRIBL_API_URL;

export type ResourceKind = 'source' | 'destination' | 'route' | 'pipeline';

export interface ConfigGroup {
  id: string;
  name?: string;
  type?: string;
  isFleet?: boolean;
  isSearch?: boolean;
  product?: string;
  description?: string;
}

/** A source/destination config item — free-form config plus a few known fields. */
export interface ConfigItem {
  id?: string;
  type?: string;
  disabled?: boolean;
  [key: string]: unknown;
}

/** A single entry in a routing table. */
export interface RouteConf {
  id?: string;
  name?: string;
  filter?: string;
  pipeline?: string;
  output?: string;
  description?: string;
  disabled?: boolean;
  final?: boolean;
  [key: string]: unknown;
}

export interface RoutingTable {
  id?: string;
  routes?: RouteConf[];
}

interface Paginated<T> {
  items: T[];
  count?: number;
}

// `base` is the API root a call targets. It defaults to the local workspace's
// proxied leader (`window.CRIBL_API_URL`); cross-workspace search passes another
// workspace's leader API base (`https://<leader>/api/v1`) so the same fetchers
// read config from remote leaders.
async function getJson<T>(path: string, signal?: AbortSignal, base?: string): Promise<T> {
  const res = await fetch(`${base ?? API()}${path}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/** List all config groups (Worker Groups, Edge Fleets, Search groups). */
export async function listGroups(signal?: AbortSignal): Promise<ConfigGroup[]> {
  const data = await getJson<Paginated<ConfigGroup>>('/master/groups', signal);
  return data.items ?? [];
}

/** List Sources (inputs) in a group. */
export function listSources(gid: string, signal?: AbortSignal, base?: string): Promise<ConfigItem[]> {
  return getJson<Paginated<ConfigItem>>(
    `/m/${encodeURIComponent(gid)}/system/inputs`,
    signal,
    base,
  ).then((d) => d.items ?? []);
}

/** List Destinations (outputs) in a group. */
export function listDestinations(gid: string, signal?: AbortSignal, base?: string): Promise<ConfigItem[]> {
  return getJson<Paginated<ConfigItem>>(
    `/m/${encodeURIComponent(gid)}/system/outputs`,
    signal,
    base,
  ).then((d) => d.items ?? []);
}

/** List routing tables in a group (flattened to individual routes by the caller). */
export function listRoutingTables(gid: string, signal?: AbortSignal, base?: string): Promise<RoutingTable[]> {
  return getJson<Paginated<RoutingTable>>(
    `/m/${encodeURIComponent(gid)}/routes`,
    signal,
    base,
  ).then((d) => d.items ?? []);
}

/** List Pipelines in a group. */
export function listPipelines(gid: string, signal?: AbortSignal, base?: string): Promise<ConfigItem[]> {
  return getJson<Paginated<ConfigItem>>(
    `/m/${encodeURIComponent(gid)}/pipelines`,
    signal,
    base,
  ).then((d) => d.items ?? []);
}

/** List Collectors in a group. */
export function listCollectors(gid: string, signal?: AbortSignal, base?: string): Promise<ConfigItem[]> {
  return getJson<Paginated<ConfigItem>>(
    `/m/${encodeURIComponent(gid)}/collectors`,
    signal,
    base,
  ).then((d) => d.items ?? []);
}
