/**
 * Weight (spec 4.6, with food since the 13:55 update): one weight a day in
 * kg, stored as kg x 10 in an integer so one decimal is exact; logging again
 * that day replaces it. The summary is the latest weight, its change over 7
 * and 30 days, the newest 30 and the goal. No BMI, vitals or pounds.
 *
 * changeN = latest minus the newest weight on or before N days before the
 * latest's day (so a week with a gap still compares with the last weight
 * before it), in kg with one decimal; null when there is none that old.
 */
import { shiftDay } from '@jantar/life-core';
import { LIFE_LIMITS, type Weight, type WeightSummary } from '@jantar/protocol';
import type { LifeCore, LifeResult } from '../../contracts.js';
import { GOAL_KG10_KEY } from './repo.js';

export const WEIGHT_SENTENCES = {
  future: "A weight can't be logged for a day after today.",
  none: 'No weight is logged for that day.',
  range: 'A weight is between 20 and 400 kg.',
  full: `You have ${LIFE_LIMITS.weights.toLocaleString('en')} weights logged. Delete an old one to log another.`,
} as const;

/** kg as stored: kg x 10, rounded (72.45 is 725). */
export function kg10Of(kg: number): number {
  return Math.round(kg * 10);
}

function kgOf(kg10: number): number {
  return kg10 / 10;
}

/** Log `day`'s weight (replacing one logged that day). `day` is a real day key (the module checks). */
export function setWeight(core: LifeCore, day: string, kg: number): LifeResult {
  if (day > core.today()) return { ok: false, code: 'invalid_request', reason: WEIGHT_SENTENCES.future };
  const kg10 = kg10Of(kg);
  // The table's own CHECK: 20 to 400 kg (WeightBodySchema's range, after rounding).
  if (!Number.isFinite(kg) || kg10 < 200 || kg10 > 4000) return { ok: false, code: 'invalid_request', reason: WEIGHT_SENTENCES.range };
  const db = core.db;
  return db.tx((): LifeResult => {
    const had = db.prepare('SELECT 1 FROM weights WHERE day = ?').get(day) !== undefined;
    if (!had && (db.prepare('SELECT COUNT(*) AS n FROM weights').get() as { n: number }).n >= LIFE_LIMITS.weights) {
      return { ok: false, code: 'conflict', reason: WEIGHT_SENTENCES.full };
    }
    db.prepare('INSERT INTO weights (day, kg10, at) VALUES (?, ?, ?) ON CONFLICT (day) DO UPDATE SET kg10 = excluded.kg10, at = excluded.at').run(
      day,
      kg10,
      core.now().toISOString(),
    );
    return { ok: true, value: true };
  });
}

export function removeWeight(core: LifeCore, day: string): LifeResult {
  const n = Number(core.db.prepare('DELETE FROM weights WHERE day = ?').run(day).changes);
  return n > 0 ? { ok: true, value: true } : { ok: false, code: 'not_found', reason: WEIGHT_SENTENCES.none };
}

/** The newest weight on or before `day`, in kg x 10. */
function onOrBefore(core: LifeCore, day: string): number | null {
  const row = core.db.prepare('SELECT kg10 FROM weights WHERE day <= ? ORDER BY day DESC LIMIT 1').get(day) as { kg10: number } | undefined;
  return row ? row.kg10 : null;
}

export function weightSummary(core: LifeCore): WeightSummary {
  const rows = core.db.prepare('SELECT day, kg10 FROM weights ORDER BY day DESC LIMIT 30').all() as { day: string; kg10: number }[];
  const recent: Weight[] = rows.map((r) => ({ day: r.day, kg: kgOf(r.kg10) }));
  const latest = rows[0] ?? null;
  const change = (days: number): number | null => {
    if (!latest) return null;
    const then = onOrBefore(core, shiftDay(latest.day, -days));
    return then === null ? null : kgOf(latest.kg10 - then);
  };
  const goal = Number(core.db.meta(GOAL_KG10_KEY));
  return {
    latest: latest ? { day: latest.day, kg: kgOf(latest.kg10) } : null,
    change7: change(7),
    change30: change(30),
    goalKg: Number.isInteger(goal) && goal > 0 ? kgOf(goal) : null,
    recent,
  };
}

/** The latest weight, for Today. */
export function latestWeight(core: LifeCore): Weight | null {
  const row = core.db.prepare('SELECT day, kg10 FROM weights ORDER BY day DESC LIMIT 1').get() as { day: string; kg10: number } | undefined;
  return row ? { day: row.day, kg: kgOf(row.kg10) } : null;
}
