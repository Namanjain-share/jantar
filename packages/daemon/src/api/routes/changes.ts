/**
 * Changed-files routes (WP-FC owns this file): filesChanges,
 * sessionChanges, sessionChange. Each calls `s.deps.changes`
 * (ChangesService). No git, no diffs (U9): a change opens in the viewer at
 * the file's current content through its rootId and rel, which a protected
 * file never has.
 *
 * The pipeline has already checked the device, the control scope and
 * `files.enabled`. Each call counts against the per-device files limit
 * (300 per 5 min). Unknown sessions and changes answer 404. The replies hold
 * paths, times, tools and counts, never file content, so nothing here is
 * audited.
 */
import type { FilesChangesQuery } from '@jantar/protocol';
import { ApiError } from '../errors.js';
import { actorName } from '../request.js';
import { sessionOr404, type Call, type RouteTable } from '../route-kit.js';
import type { ApiServices } from '../services.js';

type Sid = { sid: string };
type ChangeParams = { sid: string; changeId: string };

function limitFiles(c: Pick<Call, 'auth'>, s: ApiServices): void {
  const r = s.filesLimiter.hit(actorName(c.auth));
  if (!r.ok) {
    throw new ApiError('rate_limited', 'too many file requests; wait a few minutes and try again', {
      'retry-after': String(Math.ceil(r.retryAfterMs / 1000)),
    });
  }
}

export const CHANGES_ROUTE_IMPLS: RouteTable = {
  filesChanges: {
    handle: (c: Call<Record<string, string>, FilesChangesQuery>, s) => {
      limitFiles(c, s);
      const opts: { since?: string; limit: number } = { limit: c.query.limit };
      if (c.query.since) opts.since = c.query.since;
      return { changes: s.deps.changes.recent(opts) };
    },
  },

  sessionChanges: {
    handle: async (c: Call<Sid>, s) => {
      limitFiles(c, s);
      sessionOr404(s, c.params.sid);
      const r = await s.deps.changes.forSession(c.params.sid);
      if (!r) throw new ApiError('not_found', 'no such session');
      return r;
    },
  },

  sessionChange: {
    handle: async (c: Call<ChangeParams>, s) => {
      limitFiles(c, s);
      sessionOr404(s, c.params.sid);
      const r = await s.deps.changes.change(c.params.sid, c.params.changeId);
      if (!r) throw new ApiError('not_found', 'no such change in this session');
      return r;
    },
  },
};
