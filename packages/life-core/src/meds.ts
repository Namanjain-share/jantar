// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// meds — the pure math the medication module needs BEYOND raw adherence (which lives in
// adherence.ts and stays the single source of truth for what a taken / skipped / missed dose is).
// Two things live here:
//
//   1. INVENTORY — pills remaining, days-of-supply projection, refill threshold. Running out on a
//      weekend is the most common real-world medication failure, and it is entirely preventable
//      from data the app already has (schedule × pills per dose).
//   2. MISS PATTERNS — "the evening dose is missed 40% of Fridays". Adherence tells you the number;
//      the pattern tells you what to change. It reuses adherence.ts's own slot resolution rather
//      than re-deriving what a missed slot is, so the two can never disagree.
//
// Pure and tz-free: day keys arrive already resolved in the user's timezone.
import { isPausedOn, resolveDay, scheduleForDay, slotPeriod, type AdherenceAsOf, type DoseLogEntry, type MedScheduleLike, type MedWindow } from "./adherence.js";

// ── Inventory & refills ──────────────────────────────────────────────────────────────────────

/** Days of supply at or below which the refill alert fires. A week is the shortest notice that
 *  survives a weekend plus a pharmacy that has to order it in. */
export const DEFAULT_REFILL_THRESHOLD_DAYS = 7;

export interface MedInventory {
  /** Units (pills/ml/puffs) left in hand. */
  unitsRemaining: number;
  /** Units consumed per scheduled dose. Defaults to 1. */
  unitsPerDose?: number;
  /** Alert when the projection drops to this many days or fewer. */
  refillThresholdDays?: number;
}

export type InventoryLevel = "unknown" | "ok" | "low" | "out";

export interface SupplyProjection {
  unitsRemaining: number;
  /** Units the schedule burns per day. Zero for an as-needed med (no `times[]`). */
  unitsPerDay: number;
  /** Whole days of supply left, or `null` when the burn rate is unknowable (PRN / paused). */
  daysRemaining: number | null;
  level: InventoryLevel;
  /** `YYYY-MM-DD` the supply runs out, or null when it can't be projected. */
  runsOutDay: string | null;
}

/** Shift a `YYYY-MM-DD` key by whole days. UTC-parsed, so DST can never move the answer. */
function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new RangeError(`shiftDay: invalid day key "${day}"`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The AVERAGE doses a schedule burns per calendar day — `times[]` weighted by how often the day
 * axis actually comes round. Daily ⇒ times.length; a once-weekly injection ⇒ 1/7 of that; every
 * other day ⇒ half. Callers hand the result to `projectSupply`, which is why a weekly med no
 * longer burns its box seven times too fast (and alerts for a refill seven times too early).
 *
 * Fractional on purpose: `projectSupply` floors the days-of-supply, so 1/7 doses per day over 30
 * pills is 210 safe days, not a rounded-to-1 four-week panic. An inactive med burns nothing.
 *
 * `today` is optional and does exactly one thing: a FINISHED course (a `schedule.endDay` already
 * behind us) burns nothing either. Without it, a 10-day antibiotic that ended in March keeps
 * projecting a burn rate forever, which keeps its refill alert armed — `syncRefillReminder` removes
 * the alert precisely when `daysRemaining` comes back `null`, and `null` is what `projectSupply`
 * returns once the rate is zero. Pass it wherever you already have the day key; omitting it keeps
 * the pre-course-dates behaviour. A course that has not STARTED yet deliberately still projects:
 * "get this filled before Monday" is a useful alert, "you are running out of a course you finished"
 * is not.
 */
export function dosesPerDayForSchedule(
  med: { times: readonly string[]; active?: boolean; schedule?: MedScheduleLike },
  today?: string,
): number {
  if (med.active === false) return 0;
  const perDueDay = med.times.length;
  if (perDueDay === 0) return 0;
  const s = med.schedule;
  if (!s) return perDueDay;
  if (today !== undefined && s.endDay !== undefined && today > s.endDay) return 0;
  switch (s.freq) {
    case "weekly": {
      const days = s.byWeekday && s.byWeekday.length > 0 ? new Set(s.byWeekday).size : 7;
      return (perDueDay * days) / 7;
    }
    case "interval": {
      const n = s.interval && s.interval >= 1 ? s.interval : 1;
      return perDueDay / n;
    }
    default:
      return perDueDay;
  }
}

/**
 * Project how long the supply lasts. `dosesPerDay` comes from the med's schedule — use
 * `dosesPerDayForSchedule`, NOT `times.length`, or a non-daily med's projection is wrong by the
 * schedule's own factor. A paused or as-needed med — which burns nothing predictable — reports
 * `null` days rather than an invented number. Floor, not round: 6.9 days of supply is six safe days.
 */
export function projectSupply(
  inventory: MedInventory | undefined,
  dosesPerDay: number,
  today: string,
): SupplyProjection {
  const unitsRemaining = inventory?.unitsRemaining ?? 0;
  const unitsPerDay = dosesPerDay * (inventory?.unitsPerDose ?? 1);
  if (!inventory) {
    return { unitsRemaining: 0, unitsPerDay, daysRemaining: null, level: "unknown", runsOutDay: null };
  }
  if (unitsPerDay <= 0) {
    return { unitsRemaining, unitsPerDay: 0, daysRemaining: null, level: unitsRemaining > 0 ? "ok" : "out", runsOutDay: null };
  }
  const daysRemaining = Math.floor(unitsRemaining / unitsPerDay);
  const threshold = inventory.refillThresholdDays ?? DEFAULT_REFILL_THRESHOLD_DAYS;
  return {
    unitsRemaining,
    unitsPerDay,
    daysRemaining,
    level: daysRemaining <= 0 ? "out" : daysRemaining <= threshold ? "low" : "ok",
    runsOutDay: shiftDay(today, daysRemaining),
  };
}

/** Consume `unitsPerDose` from the inventory — never below zero, because a negative pill count is
 *  a display bug that makes the whole projection untrustworthy. Returns the new units in hand. */
export function consumeDose(inventory: MedInventory): number {
  return Math.max(0, inventory.unitsRemaining - (inventory.unitsPerDose ?? 1));
}

// ── Miss patterns ────────────────────────────────────────────────────────────────────────────

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** 0=Sunday..6=Saturday for a `YYYY-MM-DD` key, read as UTC (day keys carry no time zone). */
export function weekdayOfDayKey(day: string): number {
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new RangeError(`weekdayOfDayKey: invalid day key "${day}"`);
  return d.getUTCDay();
}

export interface MissBucket {
  /** Scheduled slots that fell in this bucket and are already resolved (pending ones excluded). */
  scheduled: number;
  missed: number;
  /** missed / scheduled, or null when nothing in the bucket has resolved yet. */
  missRate: number | null;
}

export interface MissPatternInsight {
  /** Which axis the pattern is on. */
  dimension: "weekday" | "period" | "slot";
  /** "Friday" / "night" / "22:00". */
  label: string;
  missRate: number;
  missed: number;
  scheduled: number;
  /** The miss rate across every OTHER bucket on the same axis — what makes this one stand out. */
  baselineMissRate: number;
}

export interface MissPatterns {
  byWeekday: Record<string, MissBucket>;
  byPeriod: Record<string, MissBucket>;
  bySlot: Record<string, MissBucket>;
  /** The buckets worth telling the user about, worst first. Empty when nothing stands out. */
  insights: MissPatternInsight[];
}

/** A bucket needs this many resolved slots before its rate is worth quoting — three Fridays is
 *  noise, not a pattern. */
export const MIN_PATTERN_SAMPLE = 4;

/** How much worse than the rest a bucket must be to be called out. Below this it's just variance. */
export const MIN_PATTERN_EXCESS = 0.15;

function emptyBucket(): MissBucket {
  return { scheduled: 0, missed: 0, missRate: null };
}

function bump(map: Record<string, MissBucket>, key: string, missed: boolean): void {
  const b = (map[key] ??= emptyBucket());
  b.scheduled += 1;
  if (missed) b.missed += 1;
}

function finalize(map: Record<string, MissBucket>): void {
  for (const b of Object.values(map)) b.missRate = b.scheduled > 0 ? b.missed / b.scheduled : null;
}

/** Buckets that miss materially more than every other bucket on their axis, worst first. */
function callOut(map: Record<string, MissBucket>, dimension: MissPatternInsight["dimension"]): MissPatternInsight[] {
  const entries = Object.entries(map);
  const totalScheduled = entries.reduce((a, [, b]) => a + b.scheduled, 0);
  const totalMissed = entries.reduce((a, [, b]) => a + b.missed, 0);
  const out: MissPatternInsight[] = [];
  for (const [label, b] of entries) {
    if (b.scheduled < MIN_PATTERN_SAMPLE || b.missRate === null) continue;
    const otherScheduled = totalScheduled - b.scheduled;
    // With only one populated bucket there is nothing to stand out FROM — a 100% miss rate on the
    // only slot you have is just your adherence number, not a pattern.
    if (otherScheduled <= 0) continue;
    const baseline = (totalMissed - b.missed) / otherScheduled;
    if (b.missRate - baseline < MIN_PATTERN_EXCESS) continue;
    out.push({ dimension, label, missRate: b.missRate, missed: b.missed, scheduled: b.scheduled, baselineMissRate: baseline });
  }
  return out.sort((a, b) => b.missRate - a.missRate);
}

/**
 * Where the misses cluster: by weekday, by time-of-day period, and by the exact scheduled slot.
 * PENDING slots (not yet due) are excluded entirely — counting tonight's untaken dose as a miss
 * would make every evening slot look terrible every single afternoon. Days a med's own `schedule`
 * does not cover are excluded the same way, via the shared `isScheduledOn` predicate inside
 * `resolveDay`: "you miss this every Tuesday" must never mean "you don't take it on Tuesdays".
 */
export function medMissPatterns(args: {
  days: string[];
  meds: MedWindow[];
  logs: DoseLogEntry[];
  asOf?: AdherenceAsOf;
}): MissPatterns {
  const byWeekday: Record<string, MissBucket> = {};
  const byPeriod: Record<string, MissBucket> = {};
  const bySlot: Record<string, MissBucket> = {};

  const byMedDay = new Map<string, DoseLogEntry[]>();
  for (const l of args.logs) {
    const k = `${l.medId} ${l.day}`;
    const bucket = byMedDay.get(k);
    if (bucket) bucket.push(l);
    else byMedDay.set(k, [l]);
  }

  for (const day of args.days) {
    const weekday = WEEKDAY_NAMES[weekdayOfDayKey(day)]!;
    for (const m of args.meds) {
      const active = (!m.startDay || day >= m.startDay) && (!m.endDay || day <= m.endDay);
      if (!active || isPausedOn(m, day)) continue;
      // `resolveDay` applies the med's own schedule (a Mon/Thu injection resolves no slots on a
      // Tuesday), so an off day contributes nothing to any bucket — it is not a miss. The schedule
      // is the one that was IN FORCE ON `day`, so changing a regimen can never retro-invent a
      // pattern ("you miss 100% of Tuesdays") out of days the old schedule never scheduled.
      const schedule = scheduleForDay(m, day);
      const { slots } = resolveDay(
        { times: m.times, ...(schedule ? { schedule } : {}) },
        day,
        byMedDay.get(`${m.medId} ${day}`) ?? [],
        args.asOf,
      );
      for (const s of slots) {
        if (s.status === "pending") continue;
        const missed = s.status === "missed";
        bump(byWeekday, weekday, missed);
        bump(byPeriod, slotPeriod(s.slot), missed);
        bump(bySlot, s.slot, missed);
      }
    }
  }

  finalize(byWeekday);
  finalize(byPeriod);
  finalize(bySlot);

  return {
    byWeekday,
    byPeriod,
    bySlot,
    insights: [...callOut(byWeekday, "weekday"), ...callOut(bySlot, "slot"), ...callOut(byPeriod, "period")].sort(
      (a, b) => b.missRate - a.missRate,
    ),
  };
}
