/**
 * The Intel shelf (feature `intel`), on ctl.sock too so a bot or a session
 * can add a capture with `jantar intel`. No route returns a path; only a
 * capture over ctl.sock takes one (its `cwd`, the folder the CLI ran in).
 * Captures are rate limited per device or the CLI (s.intelCaptureLimiter).
 *
 * The pipeline has already checked control scope and the switch (a broken
 * life.db never closes the shelf), validated the strict bodies, and refused
 * a TCP capture carrying `cwd` (CTL_ONLY_FIELDS): a capture from ctl.sock
 * is `{ via: 'cli', cwd: body.cwd }`, from a device `{ via: 'phone' }`. The
 * capture's audit is its id and whether it was a duplicate, nothing else.
 */
import type { IntelCaptureBody, IntelListQuery } from '@jantar/protocol';
import type { CaptureFrom } from '../../intel/capture.js';
import { ApiError } from '../errors.js';
import { actorName } from '../request.js';
import { lifeAudit, lifeValue, type Call, type RouteTable } from '../route-kit.js';

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
      const { cwd, ...body } = c.body;
      const from: CaptureFrom = c.auth.transport === 'ctl' ? { via: 'cli', ...(cwd !== undefined ? { cwd } : {}) } : { via: 'phone' };
      const out = lifeValue(await s.deps.intel.capture(body, from));
      c.scratch.duplicate = out.duplicate;
      return out;
    },
    audit: (c: Call<Record<string, string>>, out) => ({ ...lifeAudit(c, out), params: c.scratch.duplicate === undefined ? {} : { duplicate: c.scratch.duplicate } }),
  },

  intelSources: {
    handle: (_c: Call, s) => ({ sources: s.deps.intel.sources() }),
  },
};
