/**
 * v0.5.3 Ask (feature `ask`): each route calls `s.deps.ask` (ask/service.ts)
 * with the device as actor. Device routes only, never on ctl.sock.
 *
 * The pipeline has already checked control scope (reads too), the Ask
 * switch, --read-only (askSend only: it spends quota), parsed the params
 * and the strict bodies, and counted every write against
 * s.lifeWriteLimiter. askSend also counts against s.askLimiter (10 a
 * minute) and s.askDayBudget (100 a day) per device: both are checked
 * first and counted only once the part takes the message, so a refusal
 * (busy, not ready) spends neither.
 *
 * Write replies carry ids only (`{ id }`: the turn's for askSend, the new
 * item's for askAdd; else `{ ok }`), so the idempotency cache never keeps
 * text, and askSend's replay is the same turn with no second run.
 * `lifeValue` turns the part's answer into the value or the API error with
 * its fixed sentence; writes audit the turn id (askSend: the reply's id)
 * and nothing else. askList is the one reply with text, the owner's own.
 */
import type { AskAddBody, AskCardParams, AskSendBody } from '@jantar/protocol';
import type { LifeResult } from '../../contracts.js';
import { ApiError } from '../errors.js';
import { actorName } from '../request.js';
import { lifeAudit, lifeValue, needActor, type Call, type RouteTable } from '../route-kit.js';
import { ASK_LIMITS } from '../services.js';

type Id = { id: string };

export const ASK_SEND_LIMITED = 'Too many messages from this device; try again in a minute.';
export const ASK_SEND_DAY_LIMITED = `This device has asked ${ASK_LIMITS.sendDay.limit} times today. Try again tomorrow.`;

/** A write that answers `{ ok: true }`: the part's refusal as the API error, else ok. */
function okOf(r: LifeResult): { ok: true } {
  lifeValue(r);
  return { ok: true };
}

export const ASK_ROUTE_IMPLS: RouteTable = {
  askList: {
    handle: (c: Call, s) => lifeValue(s.deps.ask.list(needActor(c.auth))),
  },
  askSend: {
    handle: (c: Call<unknown, unknown, AskSendBody>, s) => {
      const actor = needActor(c.auth);
      const who = actorName(c.auth);
      const limits = [
        [s.askLimiter, ASK_SEND_LIMITED],
        [s.askDayBudget, ASK_SEND_DAY_LIMITED],
      ] as const;
      for (const [limiter, message] of limits) {
        const limited = limiter.check(who);
        if (!limited.ok) throw new ApiError('rate_limited', message, { 'retry-after': String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))) });
      }
      // A refusal throws here, before anything is counted.
      const sent = lifeValue(s.deps.ask.send(c.body.text, actor));
      for (const [limiter] of limits) limiter.hit(who);
      return sent;
    },
    audit: lifeAudit,
  },
  askClear: {
    handle: (c: Call, s) => okOf(s.deps.ask.clear(needActor(c.auth))),
    audit: lifeAudit,
  },
  askCancel: {
    handle: (c: Call<Id>, s) => okOf(s.deps.ask.cancel(c.params.id, needActor(c.auth))),
    audit: lifeAudit,
  },
  askAdd: {
    handle: (c: Call<AskCardParams, unknown, AskAddBody>, s) => lifeValue(s.deps.ask.add(c.params.id, c.params.n, c.body?.edit, needActor(c.auth))),
    // The turn's id, never the new item's (lifeAudit reads `:id` first).
    audit: lifeAudit,
  },
  askSkip: {
    handle: (c: Call<AskCardParams>, s) => okOf(s.deps.ask.skip(c.params.id, c.params.n, needActor(c.auth))),
    audit: lifeAudit,
  },
  askUndo: {
    handle: (c: Call<AskCardParams>, s) => okOf(s.deps.ask.undo(c.params.id, c.params.n, needActor(c.auth))),
    audit: lifeAudit,
  },
};
