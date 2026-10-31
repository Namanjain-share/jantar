/**
 * Food, calories, weight and Ask Claude (feature `food`, WP-FF). Device
 * routes only, never on ctl.sock. Each calls `s.deps.life.food`
 * (life/food/module.ts).
 *
 * The pipeline has already checked control scope, the switch and a broken
 * life.db, validated the strict bodies and counted every write against
 * s.lifeWriteLimiter. Write replies carry ids only (`lifeValue` turns a
 * LifeResult into the value or the API error); writes audit their target id
 * and nothing else (`lifeAudit`).
 *
 * foodEstimate is the one reply that carries text (schema-checked rows). It
 * saves nothing and sets no idempotency entry (the pipeline skips it, whatever
 * the client sends); on top of the Life write limit it counts against
 * s.estimateLimiter (10 a minute) and s.estimateDayBudget (100 a day) per
 * device. The run is aborted when the request goes away. Its own audit row
 * (`food.estimate`: length, ms, account, model, outcome) is the module's.
 */
import type { FoodBody, FoodEstimateBody, FoodPatch, FoodTargetsBody, WeightBody } from '@jantar/protocol';
import type { LifeResult } from '../../contracts.js';
import { ApiError } from '../errors.js';
import { actorName } from '../request.js';
import { lifeAudit, lifeValue, needActor, type Call, type RouteTable } from '../route-kit.js';
import { V04_LIMITS } from '../services.js';

type Id = { id: string };
type Day = { day: string };

export const ESTIMATE_LIMITED = 'Too many estimates from this device; try again in a minute.';
export const ESTIMATE_DAY_LIMITED = `This device has asked Claude for ${V04_LIMITS.estimateDay.limit} estimates today. Type the calories instead.`;

/** A write that answers `{ ok: true }`: the module's refusal as the API error, else ok. */
function okOf(r: LifeResult): { ok: true } {
  lifeValue(r);
  return { ok: true };
}

export const FOOD_ROUTE_IMPLS: RouteTable = {
  foodDay: {
    handle: (c: Call<unknown, { day?: string }>, s) => lifeValue(s.deps.life.food.day(c.query.day)),
  },
  foodAdd: {
    handle: (c: Call<unknown, unknown, FoodBody>, s) => lifeValue(s.deps.life.food.add(c.body, needActor(c.auth))),
    audit: lifeAudit,
  },
  foodUpdate: {
    handle: (c: Call<Id, unknown, FoodPatch>, s) => okOf(s.deps.life.food.update(c.params.id, c.body, needActor(c.auth))),
    audit: lifeAudit,
  },
  foodDelete: {
    handle: (c: Call<Id>, s) => okOf(s.deps.life.food.remove(c.params.id, needActor(c.auth))),
    audit: lifeAudit,
  },
  foodSavedDelete: {
    handle: (c: Call<Id>, s) => okOf(s.deps.life.food.removeSaved(c.params.id, needActor(c.auth))),
    audit: lifeAudit,
  },
  foodTargets: {
    handle: (c: Call<unknown, unknown, FoodTargetsBody>, s) => okOf(s.deps.life.food.setTargets(c.body, needActor(c.auth))),
    audit: lifeAudit,
  },
  foodEstimate: {
    handle: async (c: Call<unknown, unknown, FoodEstimateBody>, s) => {
      const actor = needActor(c.auth);
      const who = actorName(c.auth);
      for (const [limiter, message] of [
        [s.estimateLimiter, ESTIMATE_LIMITED],
        [s.estimateDayBudget, ESTIMATE_DAY_LIMITED],
      ] as const) {
        const limited = limiter.hit(who);
        if (!limited.ok) throw new ApiError('rate_limited', message, { 'retry-after': String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))) });
      }
      const module = s.deps.life.food;
      // The phone gave up (closed the request): stop the run instead of finishing it for nobody.
      const gone = new AbortController();
      const res = c.reply.raw;
      const onClose = () => {
        if (!res.writableFinished) gone.abort();
      };
      res.once('close', onClose);
      try {
        return lifeValue(await module.estimate(c.body.text, gone.signal, actor));
      } finally {
        res.off('close', onClose);
      }
    },
    audit: lifeAudit,
  },
  weightSet: {
    handle: (c: Call<Day, unknown, WeightBody>, s) => okOf(s.deps.life.food.setWeight(c.params.day, c.body, needActor(c.auth))),
    audit: lifeAudit,
  },
  weightDelete: {
    handle: (c: Call<Day>, s) => okOf(s.deps.life.food.removeWeight(c.params.day, needActor(c.auth))),
    audit: lifeAudit,
  },
};
