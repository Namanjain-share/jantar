/**
 * 0.13.0 Work: the owner's client for Work's routes, in Work's lazy chunk
 * (and the palette's, for the search), so the main load carries none of
 * it. The calls go through the app's own `api.request` (the device secret
 * and an Idempotency-Key on a write, as every call). Every path is one of
 * `@jantar/protocol/work`'s WORK_ROUTES, taken here as words so the chunk
 * carries no schema (test/work/client.test.ts compares them).
 *
 * Owner-only: every route here is a control route on his host. Her app
 * (src/partner) never imports this file (test/work/isolation.test.ts).
 */
import type { ProjectHub, SearchResponse, WorkClientNamesReply, WorkSeedBody, WorkSeedReply } from '@jantar/protocol/work';
import type { Api, ApiRoute } from '../../../lib/api.js';

export const WORK_PATHS = {
  projectGet: { method: 'GET', path: '/v1/projects/:id' },
  search: { method: 'GET', path: '/v1/search' },
  foldersSeed: { method: 'POST', path: '/v1/work/seed' },
  workClientNames: { method: 'GET', path: '/v1/work/clients/names' },
} as const satisfies Record<string, ApiRoute>;

/** The search's shortest query, once trimmed (WORK_LIMITS.searchMin). */
export const SEARCH_MIN = 2;
/** And its longest (WORK_LIMITS.searchMax). */
export const SEARCH_MAX = 80;

export interface WorkClient {
  /** One project as a hub (GET /v1/projects/:id; the Todos switch). */
  projectHub(id: string): Promise<ProjectHub>;
  /** One search across Jantar: each group only while its part is on (2 to 80 characters). */
  search(q: string, signal?: AbortSignal): Promise<SearchResponse>;
  /** One project per folder under a root, its folder linked; `clients`: a company client each too. */
  seed(body: WorkSeedBody, idempotencyKey?: string): Promise<WorkSeedReply>;
  /** Clients' names by id (at most 100), for the client on a project row. */
  clientNames(ids: readonly string[]): Promise<WorkClientNamesReply>;
}

export function workClient(api: Api): WorkClient {
  return {
    projectHub: (id) => api.request(WORK_PATHS.projectGet, { params: { id } }),
    search: (q, signal) => api.request(WORK_PATHS.search, { query: { q: q.trim().slice(0, SEARCH_MAX) }, ...(signal ? { signal } : {}) }),
    seed: (body, idempotencyKey) => api.request(WORK_PATHS.foldersSeed, { body, ...(idempotencyKey ? { idempotencyKey } : {}) }),
    clientNames: (ids) => api.request(WORK_PATHS.workClientNames, { query: { ids: ids.slice(0, 100).join(',') } }),
  };
}
