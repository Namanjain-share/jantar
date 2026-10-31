/**
 * Food, calories and weight (spec 4.6; WP-FF). What you ate with its
 * calories (no macros, meal slots or food database), a daily total against a
 * target, saved foods for one tap, one weight a day (weight.ts) and Ask
 * Claude (estimate.ts, which saves nothing).
 *
 * - An entry's `at` is now when its day is today, else 12:00 that day.
 *   `save: true` also keeps it as a saved food (found again by its
 *   lowercased, trimmed name); adding a saved food by id copies it into a
 *   new entry. Both count a use, and FoodDay lists the 30 most used.
 * - The calorie target (default KCAL_TARGET_DEFAULT) and the goal weight
 *   are set from the phone and kept in life.db's meta, not in settings.
 * - Caps (LIFE_LIMITS) answer conflict with a fixed sentence. Every write
 *   ends with `core.changed()` (life.changed {}); replies carry ids only.
 * - Food has no pings, so it registers no handler.
 */
import { instantAt, shiftDay } from '@jantar/life-core';
import { FoodEntrySchema, LIFE_LIMITS, type FoodBody, type FoodEntry, type FoodPatch, type FoodTargetsBody, type WeightBody } from '@jantar/protocol';
import type { Actor, FoodModule, LifeCore, LifeModuleDeps, LifeResult } from '../../contracts.js';
import { FoodEstimator } from './estimate.js';
import { FoodRepo, GOAL_KG10_KEY, KCAL_TARGET_KEY } from './repo.js';
import { kg10Of, latestWeight, removeWeight, setWeight, weightSummary } from './weight.js';

/** How many saved foods FoodDay lists. */
export const SAVED_SHOWN = 30;
/** The time an entry logged for another day gets. */
export const OTHER_DAY_AT = '12:00';

export const FOOD_SENTENCES = {
  noDay: 'That date does not exist.',
  noEntry: 'That food is not in the log any more.',
  noSaved: 'That saved food is gone.',
  dayFull: `You have ${LIFE_LIMITS.foodPerDay} foods logged that day. Delete one to add another.`,
  savedFull: `You have ${LIFE_LIMITS.savedFoods} saved foods. Forget one to save another.`,
  invalid: 'That food is not valid.',
} as const;

/** A day key that names a real date (the key's pattern lets 2026-02-31 through). */
export function isRealDay(day: string): boolean {
  try {
    return shiftDay(day, 0) === day;
  } catch {
    return false;
  }
}

function fail(code: 'invalid_request' | 'not_found' | 'conflict', reason: string): LifeResult<never> {
  return { ok: false, code, reason };
}

export function buildFoodModule(core: LifeCore, deps: LifeModuleDeps): FoodModule {
  const log = deps.ctx.log.child({ part: 'life', module: 'food' });
  const repo = new FoodRepo(core, log);
  const estimator = new FoodEstimator(deps);

  /** Now for today, else 12:00 that day in the Life zone. */
  const atFor = (day: string): string => (day === core.today() ? core.now() : instantAt(day, OTHER_DAY_AT, core.tz())).toISOString();

  /** A write that went through: tell every screen (life.changed {}). */
  const done = <T>(r: LifeResult<T>): LifeResult<T> => {
    if (r.ok) core.changed();
    return r;
  };

  return {
    name: 'food',

    day(day?: string) {
      const today = core.today();
      const d = day ?? today;
      if (!isRealDay(d)) return fail('invalid_request', FOOD_SENTENCES.noDay);
      const entries = repo.entriesOn(d);
      return {
        ok: true,
        value: {
          day: d,
          today,
          target: repo.kcalTarget(),
          kcal: entries.reduce((sum, e) => sum + e.kcal, 0),
          entries,
          saved: repo.topSaved(SAVED_SHOWN),
          weight: weightSummary(core),
        },
      };
    },

    add(body: FoodBody, _actor: Actor) {
      if (!isRealDay(body.day)) return fail('invalid_request', FOOD_SENTENCES.noDay);
      const now = core.now().toISOString();
      const result = core.db.tx((): LifeResult<{ id: string }> => {
        if (repo.countOn(body.day) >= LIFE_LIMITS.foodPerDay) return fail('conflict', FOOD_SENTENCES.dayFull);
        let item: { name: string; kcal: number };
        if ('savedId' in body) {
          const saved = repo.saved(body.savedId);
          if (!saved) return fail('not_found', FOOD_SENTENCES.noSaved);
          item = { name: saved.name, kcal: saved.kcal };
          repo.useSaved(saved.id, now);
        } else {
          item = { name: body.name.trim(), kcal: body.kcal };
          if (body.save) {
            const existing = repo.savedByName(item.name);
            if (existing) repo.useSaved(existing.id, now, item);
            else if (repo.savedCount() >= LIFE_LIMITS.savedFoods) return fail('conflict', FOOD_SENTENCES.savedFull);
            else repo.insertSaved({ id: core.newId(), ...item }, now);
          }
        }
        const entry: FoodEntry = { id: core.newId(), day: body.day, at: atFor(body.day), ...item, createdAt: now, updatedAt: now };
        if (!FoodEntrySchema.safeParse(entry).success) return fail('invalid_request', FOOD_SENTENCES.invalid);
        repo.putEntry(entry);
        return { ok: true, value: { id: entry.id } };
      });
      return done(result);
    },

    update(id: string, patch: FoodPatch, _actor: Actor) {
      const entry = repo.entry(id);
      if (!entry) return fail('not_found', FOOD_SENTENCES.noEntry);
      const next: FoodEntry = { ...entry, updatedAt: core.now().toISOString() };
      if (patch.name !== undefined) next.name = patch.name.trim();
      if (patch.kcal !== undefined) next.kcal = patch.kcal;
      if (!FoodEntrySchema.safeParse(next).success) return fail('invalid_request', FOOD_SENTENCES.invalid);
      repo.putEntry(next);
      return done({ ok: true, value: true });
    },

    remove(id: string, _actor: Actor) {
      return repo.deleteEntry(id) ? done({ ok: true, value: true }) : fail('not_found', FOOD_SENTENCES.noEntry);
    },

    removeSaved(id: string, _actor: Actor) {
      return repo.deleteSaved(id) ? done({ ok: true, value: true }) : fail('not_found', FOOD_SENTENCES.noSaved);
    },

    setTargets(body: FoodTargetsBody, _actor: Actor) {
      core.db.tx(() => {
        if (body.kcalTarget !== undefined) core.db.setMeta(KCAL_TARGET_KEY, String(body.kcalTarget));
        if (body.goalKg === null) core.db.deleteMeta(GOAL_KG10_KEY);
        else if (body.goalKg !== undefined) core.db.setMeta(GOAL_KG10_KEY, String(kg10Of(body.goalKg)));
      });
      return done({ ok: true, value: true });
    },

    setWeight(day: string, body: WeightBody, _actor: Actor) {
      if (!isRealDay(day)) return fail('invalid_request', FOOD_SENTENCES.noDay);
      return done(setWeight(core, day, body.kg));
    },

    removeWeight(day: string, _actor: Actor) {
      if (!isRealDay(day)) return fail('invalid_request', FOOD_SENTENCES.noDay);
      return done(removeWeight(core, day));
    },

    estimate(text: string, signal: AbortSignal, actor: Actor) {
      return estimator.estimate(text, signal, actor);
    },

    estimateStatus() {
      return estimator.status();
    },

    today(day: string) {
      return { food: { kcal: repo.kcalOn(day), target: repo.kcalTarget(), weight: latestWeight(core) } };
    },

    /** The daemon is stopping: kill any Ask Claude run still going. */
    stop() {
      estimator.stop();
    },
  };
}
