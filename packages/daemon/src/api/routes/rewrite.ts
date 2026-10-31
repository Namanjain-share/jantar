/**
 * Rewrite routes (WP-R owns this file): rewriteStart, rewriteGet,
 * rewriteCancel. Each calls `s.deps.rewrite` (RewriteService).
 *
 * The pipeline in app.ts has already checked the device, the control
 * scope, Origin, the device secret and `rewrite.enabled`, and validated the
 * params and body. Here:
 * - owner checks answer 404, never 403 (job ids reveal nothing);
 * - `s.rewriteLimiter` per device (6 starts per minute), and the service's
 *   own cap on unfinished jobs; both 429s carry retry-after;
 * - no reply carries text except rewriteGet (the idempotency cache keeps
 *   write replies);
 * - the audit gets ids, the model and lengths, never text (the run's own
 *   outcome row, {sid, jobId, account, model, ms, outcome}, is the
 *   service's `rewrite.run`).
 * The send itself is POST /sessions/:sid/prompt with `rewriteJobId`
 * (routes.ts: originFor claims the job, then markSent or releaseOrigin).
 */
import type { ErrorCode, RewriteStartBody } from '@jantar/protocol';
import type { RewriteSubmitResult } from '../../contracts.js';
import { ApiError } from '../errors.js';
import { actorName } from '../request.js';
import { needActor, sessionOr404, type Call, type RouteTable } from '../route-kit.js';

type Sid = { sid: string };
type JobId = { jobId: string };

const SUBMIT_ERROR: Readonly<Record<Extract<RewriteSubmitResult, { ok: false }>['code'], ErrorCode>> = {
  not_found: 'not_found',
  refused: 'refused',
  rate_limited: 'rate_limited',
  unavailable: 'unavailable',
};

const NO_SUCH_JOB = 'no such rewrite job (it may have expired)';
/** A Discard while the prompt is being sent (sendPrompt answers a second send the same). */
export const ALREADY_SENDING = 'This prompt is already being sent.';

/** retry-after (seconds) when the device's unfinished rewrites are at the service's cap: a run takes about this long. */
export const ACTIVE_RETRY_AFTER_S = 10;

export const REWRITE_ROUTE_IMPLS: RouteTable = {
  rewriteStart: {
    handle: async (c: Call<Sid, unknown, RewriteStartBody>, s) => {
      const actor = needActor(c.auth);
      const limited = s.rewriteLimiter.hit(actorName(c.auth));
      if (!limited.ok) {
        throw new ApiError('rate_limited', 'too many rewrites; wait a minute and try again', {
          'retry-after': String(Math.ceil(limited.retryAfterMs / 1000)),
        });
      }
      sessionOr404(s, c.params.sid);
      const req: { sid: string; text: string; model?: RewriteStartBody['model'] } = { sid: c.params.sid, text: c.body.text };
      if (c.body.model) req.model = c.body.model;
      const r = await s.deps.rewrite.submit(req, actor);
      if (!r.ok) {
        // rate_limited here is the cap on unfinished jobs: they end within a run's time.
        const headers = r.code === 'rate_limited' ? { 'retry-after': String(ACTIVE_RETRY_AFTER_S) } : undefined;
        throw new ApiError(SUBMIT_ERROR[r.code], r.reason, headers);
      }
      c.scratch.jobId = r.job.id;
      c.scratch.model = r.job.model;
      return { jobId: r.job.id, job: r.job };
    },
    audit: (c: Call<Sid, unknown, RewriteStartBody>) => ({
      target: c.params.sid,
      params: {
        jobId: c.scratch.jobId,
        model: c.scratch.model ?? c.body.model,
        inputLength: c.body.text.trim().length,
      },
    }),
  },

  rewriteGet: {
    handle: (c: Call<JobId>, s) => {
      const detail = s.deps.rewrite.get(c.params.jobId, needActor(c.auth));
      if (!detail) throw new ApiError('not_found', NO_SUCH_JOB);
      return detail;
    },
  },

  rewriteCancel: {
    handle: (c: Call<JobId>, s) => {
      const job = s.deps.rewrite.cancel(c.params.jobId, needActor(c.auth));
      if (!job) throw new ApiError('not_found', NO_SUCH_JOB);
      if (job === 'claimed') throw new ApiError('conflict', ALREADY_SENDING);
      c.scratch.sid = job.sid;
      c.scratch.state = job.state;
      return { job };
    },
    audit: (c: Call<JobId>) => ({
      target: c.params.jobId,
      params: { sid: c.scratch.sid, state: c.scratch.state },
    }),
  },
};
