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
 * `intelRead` switch: from ctl.sock `via: 'cli'`, from a device `'phone'`,
 * sharing the capture limiter), Retry and Read again (`intelReread`), the
 * jobs, Delete (captures only; 403 for another source's item), a read
 * item's thumbnails (raw JPEG, nosniff, a sandbox CSP, private no-store,
 * counted against the device's raw-byte budget like meeting shots) and the
 * Mac-only status. Audits carry the item id and counts only, never a link
 * or text.
 */
import type { IntelCaptureBody, IntelDepth, IntelListQuery, IntelReadBody } from '@jantar/protocol';
import type { CaptureFrom } from '../../intel/capture.js';
import { ApiError } from '../errors.js';
import { actorName } from '../request.js';
import { lifeAudit, lifeValue, type Call, type RawReply, type RouteTable } from '../route-kit.js';

export const NO_SUCH_ITEM = 'That item is no longer on the shelf.';
export const TOO_MANY_CAPTURES = 'Too many captures; wait a minute and try again.';
/** intelFrame: no such thumbnail. */
export const NO_SUCH_FRAME = 'That picture is not on the Mac.';
/** intelFrame's 429 once a device has read its bytes for the window (shared with meeting shots). */
export const FRAME_READS_LIMITED = 'too many picture bytes in the last 10 minutes; wait a little and try again';

type Id = { id: string };
const OK = { ok: true as const };

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

  // v0.8
  intelRead: {
    handle: async (c: Call<Record<string, string>, unknown, IntelReadBody>, s) => {
      const limited = s.intelCaptureLimiter.hit(actorName(c.auth));
      if (!limited.ok) {
        throw new ApiError('rate_limited', TOO_MANY_CAPTURES, { 'retry-after': String(Math.ceil(limited.retryAfterMs / 1000)) });
      }
      const out = lifeValue(await s.deps.intel.read(c.body, { via: c.auth.transport === 'ctl' ? 'cli' : 'phone' }));
      c.scratch.duplicate = out.duplicate;
      c.scratch.queued = out.queued;
      return out;
    },
    audit: (c: Call<Record<string, string>>, out) => ({
      ...lifeAudit(c, out),
      params: c.scratch.duplicate === undefined ? {} : { duplicate: c.scratch.duplicate, queued: c.scratch.queued },
    }),
  },

  intelReread: {
    handle: (c: Call<Id, unknown, { depth?: IntelDepth }>, s) => lifeValue(s.deps.intel.reread(c.params.id, c.body.depth)),
    audit: (c: Call<Id, Record<string, unknown>, { depth?: IntelDepth }>, out) => ({ ...lifeAudit(c, out), params: c.body?.depth ? { depth: c.body.depth } : {} }),
  },

  intelJobs: {
    handle: (_c: Call, s) => s.deps.intel.jobs(),
  },

  intelDelete: {
    handle: async (c: Call<Id>, s) => {
      lifeValue(await s.deps.intel.remove(c.params.id));
      return OK;
    },
    audit: lifeAudit,
  },

  intelFrame: {
    handle: async (c: Call<{ id: string; n: number }>, s): Promise<RawReply> => {
      const body = await s.deps.intel.frame(c.params.id, Number(c.params.n));
      if (!body) throw new ApiError('not_found', NO_SUCH_FRAME);
      if (c.auth.transport === 'tcp') {
        const budget = s.rawBytesBudget.take(actorName(c.auth), body.length);
        if (!budget.ok) throw new ApiError('rate_limited', FRAME_READS_LIMITED, { 'retry-after': String(Math.max(1, Math.ceil(budget.retryAfterMs / 1000))) });
      }
      return {
        kind: 'raw',
        type: 'image/jpeg',
        body,
        headers: {
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'cache-control': 'private, no-store',
          'cross-origin-resource-policy': 'same-origin',
        },
      };
    },
  },

  intelReadStatus: {
    handle: (_c: Call, s) => s.deps.intel.readStatus(),
  },
};
