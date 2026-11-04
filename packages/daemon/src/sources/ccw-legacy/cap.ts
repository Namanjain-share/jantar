/**
 * 0.14.0: an account's weekly cap from its `weekly_ramp` in ccw's
 * switch.json, by the cap rule ccw uses (the same rule, the same numbers;
 * the table in test/sources/ccw-legacy.test.ts is ccw's):
 *
 *   R = the account's weekly window reset (usage.sevenDay.resetsAt).
 *   No R: the global weekly_ceiling.
 *   t >= R (a stale reading: the week rolled): start = R; else start = R - 7 days.
 *   t < R and R - t <= 1 hour: last_hour.
 *   Otherwise day = floor((t - start) / 1 day) + 1, kept within 1..7: days[day - 1].
 *
 * An account without an entry has no cap of its own: weekly_ceiling, as before.
 * Times are epoch milliseconds here (ccw counts seconds; the boundaries are the same).
 */
import { rampSlot, type WeeklyRamp } from '@jantar/protocol';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_DAYS = 7;

/** The cap at `nowMs` for an account with `ramp`, whose weekly window resets at `resetMs` (null: no reading). */
export function rampCapAt(ramp: WeeklyRamp, resetMs: number | null, nowMs: number, weeklyCeiling: number): number {
  // 0.14.0: the rule itself is protocol's rampSlot, shared with the Switching rules sheet's "Day 4 · now".
  const slot = rampSlot(resetMs, nowMs);
  if (slot === null) return weeklyCeiling;
  return slot === 'lastHour' ? ramp.lastHour : (ramp.days[slot - 1] as number);
}

export interface WeeklyCap {
  /** The cap now, in % of the week. */
  cap: number;
  /** When it next changes (epoch ms): absent when it won't change before a new reading. */
  until?: number;
  /** What it changes to at `until`. */
  next?: number;
}

/**
 * The cap now and its next change. The moments a cap can change are each
 * day's start in the account's week, an hour before its reset, the reset,
 * and each day's start after it while the reading stays stale (a new reading
 * after the reset names the next reset, R + 7 days, so its days start at the
 * same moments). The first of them, from now on, whose cap differs.
 */
export function weeklyCapFor(ramp: WeeklyRamp, resetMs: number | null, nowMs: number, weeklyCeiling: number): WeeklyCap {
  const cap = rampCapAt(ramp, resetMs, nowMs, weeklyCeiling);
  if (resetMs === null) return { cap };
  const marks: number[] = [];
  if (nowMs < resetMs) {
    const start = resetMs - WEEK_DAYS * DAY_MS;
    for (let k = 1; k < WEEK_DAYS; k++) marks.push(start + k * DAY_MS);
    marks.push(resetMs - HOUR_MS, resetMs);
  }
  for (let k = 1; k < WEEK_DAYS; k++) marks.push(resetMs + k * DAY_MS);
  for (const at of marks.filter((m) => m > nowMs).sort((a, b) => a - b)) {
    const next = rampCapAt(ramp, resetMs, at, weeklyCeiling);
    if (next !== cap) return { cap, until: at, next };
  }
  return { cap };
}
