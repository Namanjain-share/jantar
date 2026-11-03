/**
 * v0.13 Work: one search across Jantar (GET /v1/search). An owner route on
 * his host (control scope, never under /v1/p/), with no switch of its own:
 * each group answers only while its own part is on (search/index.ts). The
 * request log keeps the route and status only, never the query string, and
 * a read writes no audit row.
 */
import type { SearchQuery } from '@jantar/protocol/work';
import { searchAll } from '../../search/index.js';
import { needActor, type Call, type RouteTable } from '../route-kit.js';

export const SEARCH_ROUTE_IMPLS: RouteTable = {
  search: {
    handle: (c: Call<Record<string, string>, SearchQuery>, s) =>
      searchAll(c.query.q, c.query.limit, needActor(c.auth), {
        settings: () => s.ctx.settings.get(),
        life: s.deps.life,
        meetings: s.deps.meetings,
        intel: s.deps.intel,
        sessions: () => s.ctx.store.getState().sessions,
        home: s.ctx.paths.userHome,
        log: s.ctx.log.child({ part: 'search' }),
      }),
  },
};
