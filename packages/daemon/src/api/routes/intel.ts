/**
 * The Intel shelf (feature `intel`), on ctl.sock too so a bot or a session
 * can add a capture with `jantar intel`. No route returns a path; only a
 * capture over ctl.sock takes one (its `cwd`, the folder the CLI ran in).
 * Captures are rate limited per device or the CLI (s.intelCaptureLimiter).
 *
 * The pipeline has already checked control scope and the switch (a broken
 * life.db never closes the shelf), validated the strict bodies, and refused
 * a TCP capture carrying `cwd` or `via` (CTL_ONLY_FIELDS): a capture from
 * ctl.sock is `{ via: 'cli', cwd: body.cwd }` (v0.5.3: `via: 'claude'` when
 * `jantar mcp` sent it so), from a device `{ via: 'phone' }`. The capture's
 * audit is its id and whether it was a duplicate, nothing else.
 *
 * v0.8 (Intel reads links): save and read (`intelRead`, behind the
 * `intelRead` switch: from ctl.sock `via: 'cli'`, from a device `'phone'`),
 * Retry and Read again (`intelReread`), the jobs, Delete (captures only),
 * a read item's thumbnails (raw JPEG) and the Mac-only status. Wave 0: each
 * is a stub that answers 501 until lane A replaces it in this table.
 */
import type { IntelCaptureBody, IntelListQuery } from '@jantar/protocol';
import type { CaptureFrom } from '../../intel/capture.js';
import { ApiError } from '../errors.js';
import { actorName } from '../request.js';
import { lifeAudit, lifeValue, notImplementedRoute, type Call, type RouteTable } from '../route-kit.js';

export const NO_SUCH_ITEM = 'That item is no longer on the shelf.';
export const TOO_MANY_CAPTURES = 'Too many captures; wait a minute and try again.';

export const INTEL_ROUTE_IMPLS: RouteTable = {
  intelList: {
    handle: (c: Call<Record<string, string>, IntelListQuery>, s) => s.deps.intel.list(c.query),
  },

  intelGet: {
    handle: (c: Call<{ id: string }>, s) => {
      const item = s.deps.intel.get(c.params.id);
      if (!item) throw new ApiError('not_found', NO_SUCH_ITEM);
      return { item };
    },
  },

  intelCapture: {
    handle: async (c: Call<Record<string, string>, unknown, IntelCaptureBody>, s) => {
      const limited = s.intelCaptureLimiter.hit(actorName(c.auth));
      if (!limited.ok) {
        throw new ApiError('rate_limited', TOO_MANY_CAPTURES, { 'retry-after': String(Math.ceil(limited.retryAfterMs / 1000)) });
      }
      const { cwd, via, ...body } = c.body;
      const from: CaptureFrom = c.auth.transport === 'ctl' ? { via: via ?? 'cli', ...(cwd !== undefined ? { cwd } : {}) } : { via: 'phone' };
      const out = lifeValue(await s.deps.intel.capture(body, from));
      c.scratch.duplicate = out.duplicate;
      return out;
    },
    audit: (c: Call<Record<string, string>>, out) => ({ ...lifeAudit(c, out), params: c.scratch.duplicate === undefined ? {} : { duplicate: c.scratch.duplicate } }),
  },

  intelSources: {
    handle: (_c: Call, s) => ({ sources: s.deps.intel.sources() }),
  },

  // v0.8 (wave 0 stubs)
  intelRead: notImplementedRoute('Reading links'),
  intelReread: notImplementedRoute('Reading links'),
  intelJobs: notImplementedRoute('Reading links'),
  intelDelete: notImplementedRoute('Reading links'),
  intelFrame: notImplementedRoute('Reading links'),
  intelReadStatus: notImplementedRoute('Reading links'),
};
