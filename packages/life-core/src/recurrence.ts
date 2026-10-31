// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// computeNextRunAt — the ONE pure recurrence function shared by web/mobile/MCP so a
// reminder written by AI round-trips identically to one typed in the UI.
//
// Contract: given a recurrence rule, a `from` instant (the previous fire — it encodes the
// wall-clock time-of-day in `timezone`), and an IANA timezone, return the next occurrence
// STRICTLY AFTER `from` as a UTC Date, or null when the series has ended (past `until`).
//
// All calendar math runs in `timezone` via @date-fns/tz TZDate. Month/year occurrences
// clamp to the month end when the anchor day doesn't exist (Jan-31 monthly → Feb-28;
// Feb-29 yearly → Feb-28 in non-leap years). Because byMonthDay/byMonth carry the anchor,
// each occurrence is derived from the rule — not from the (possibly clamped) previous fire —
// so a Jan-31 monthly series recovers to the 31st in March instead of drifting to the 28th.
//
// Two rule fields change what "the next occurrence" means, and both are handled here so every
// surface that walks this function (the reminder poller, `expandRecurrence` for calendar events,
// the ICS export) inherits them without knowing they exist:
//   · `bySetPos` picks the month's day by WEEKDAY POSITION ("the 2nd Tuesday", "the last Friday")
//     instead of by number, inside the monthly/yearly branches.
//   · `timesOfDay` gives one series several fire times per day, via the `nextAcrossTimes` wrapper.
import { TZDate } from "@date-fns/tz";
import type { RecurrenceRule } from "./recurrence-rule.js";

const DAYS_SCAN_CAP = 366 * 8; // safety bound for weekly scanning (interval can be large)

/** Wall-clock components of an instant, as observed in a timezone. */
interface Wall {
  year: number;
  month: number; // 0-11
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
  ms: number;
  weekday: number; // 0=Sun..6=Sat
}

function wallOf(instant: Date, tz: string): Wall {
  const z = new TZDate(instant.getTime(), tz);
  return {
    year: z.getFullYear(),
    month: z.getMonth(),
    day: z.getDate(),
    hours: z.getHours(),
    minutes: z.getMinutes(),
    seconds: z.getSeconds(),
    ms: z.getMilliseconds(),
    weekday: z.getDay(),
  };
}

/** Build the UTC instant for a wall-clock (y, m0, d, …) in `tz`. Day overflow normalizes. */
function instantOf(
  year: number,
  month: number,
  day: number,
  w: Wall,
  tz: string,
): Date {
  const z = new TZDate(
    year,
    month,
    day,
    w.hours,
    w.minutes,
    w.seconds,
    w.ms,
    tz,
  );
  return new Date(z.getTime());
}

function daysInMonth(year: number, month0: number): number {
  // Day 0 of the next month = last day of this month.
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

// Inlined from Noblot's habits.ts (`HabitScheduleLike`, `isHabitDay`); it uses the `daysInMonth` above,
// which is the same function habits.ts declares for itself.

/** The recurrence subset a habit schedule can express — structurally satisfied by `RecurrenceRule`
 *  (declared locally so this file stays free of the zod schema layer). */
export interface HabitScheduleLike {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval?: number;
  byWeekday?: readonly number[];
  byMonthDay?: number;
  byMonth?: number;
}

/**
 * Does a habit's schedule nominally cover this calendar day? Only the ANCHORED parts of the rule
 * narrow the set — `byWeekday` (weekly) and `byMonthDay` (monthly/yearly, clamped to the month's
 * last day exactly like `computeNextRunAt` does). An `interval > 1` is deliberately ignored: the
 * habit doc carries no series anchor (unlike a reminder, whose `nextRunAt` IS the anchor), so
 * "every 3 days" cannot be phase-resolved from a day key alone — treating each day as scheduled
 * is the honest fallback (it can only make a streak stricter, never fabricate one).
 * ponytail: add an explicit `anchorDay` to the habit doc if phase-exact interval schedules matter.
 */
export function isHabitDay(schedule: HabitScheduleLike, day: string): boolean {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  switch (schedule.freq) {
    case "weekly": {
      if (!schedule.byWeekday || schedule.byWeekday.length === 0) return true;
      return schedule.byWeekday.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
    }
    case "monthly":
      if (schedule.byMonthDay === undefined) return true;
      return d === Math.min(schedule.byMonthDay, daysInMonth(y, m - 1));
    case "yearly": {
      if (schedule.byMonth !== undefined && schedule.byMonth !== m) return false;
      if (schedule.byMonthDay === undefined) return true;
      return d === Math.min(schedule.byMonthDay, daysInMonth(y, m - 1));
    }
    default:
      return true;
  }
}

/** Advance a (year, month0) pair by n months, normalizing. */
function addMonths(year: number, month0: number, n: number): [number, number] {
  const total = year * 12 + month0 + n;
  return [Math.floor(total / 12), ((total % 12) + 12) % 12];
}

function withinUntil(result: Date, until: Date | undefined): Date | null {
  if (until && result.getTime() > until.getTime()) return null;
  return result;
}

/**
 * The day-of-month of the `pos`-th occurrence of any of `weekdays` in (year, month0), or null
 * when the month has no such occurrence. `pos` is 1-based; -1 means "the last one" — which is why
 * this counts the month's matches rather than doing `1 + 7 * (pos - 1)` arithmetic: a month has
 * four or five of each weekday, so "the last Friday" is the 29th in one month and the 22nd in the
 * next, and only enumeration gets both right.
 */
function nthWeekdayOfMonth(
  year: number,
  month0: number,
  weekdays: readonly number[],
  pos: number,
): number | null {
  const matches: number[] = [];
  const dim = daysInMonth(year, month0);
  for (let d = 1; d <= dim; d++) {
    // UTC arithmetic is safe here: this asks which weekday a CALENDAR date falls on, which no
    // timezone changes. The instant is built in `timezone` by the caller.
    if (weekdays.includes(new Date(Date.UTC(year, month0, d)).getUTCDay())) matches.push(d);
  }
  if (matches.length === 0) return null;
  if (pos === -1) return matches[matches.length - 1]!;
  return matches[pos - 1] ?? null;
}

/** True when the rule names its monthly day by weekday-position rather than by number. */
function usesSetPos(rule: RecurrenceRule): boolean {
  return (
    rule.bySetPos !== undefined &&
    rule.byWeekday !== undefined &&
    rule.byWeekday.length > 0 &&
    (rule.freq === "monthly" || rule.freq === "yearly")
  );
}

interface Slot {
  hours: number;
  minutes: number;
}

/** "08:30" → {hours:8, minutes:30}. The schema's regex has already vetted the shape. */
function parseSlot(t: string): Slot {
  return { hours: Number(t.slice(0, 2)), minutes: Number(t.slice(3, 5)) };
}

/** Sorted, de-duplicated fire times. Sorting is on the zero-padded HH:MM strings, which for this
 *  fixed-width format is the same order as the clock. */
function slotsOf(rule: RecurrenceRule): Slot[] {
  return [...new Set(rule.timesOfDay)].sort().map(parseSlot);
}

/** The instant of `slot` on the calendar day `w` names, in `timezone`. */
function atSlot(w: Wall, year: number, month: number, day: number, slot: Slot, tz: string): Date {
  return instantOf(year, month, day, { ...w, hours: slot.hours, minutes: slot.minutes, seconds: 0, ms: 0 }, tz);
}

export function computeNextRunAt(
  rule: RecurrenceRule,
  from: Date,
  timezone: string,
): Date | null {
  // `timesOfDay` changes WHICH INSTANT within a selected day fires, never which days are selected
  // — so it is a wrapper around the single-time walk below rather than a fifth branch inside it.
  if (rule.timesOfDay && rule.timesOfDay.length > 0) {
    return nextAcrossTimes(rule, from, timezone);
  }
  return nextSingleTime(rule, from, timezone);
}

/**
 * Multi-fire-time series ("08:00, 14:00, 20:00 every day"): the next slot on this day if one is
 * still ahead, otherwise the FIRST slot on the next day the rule selects.
 */
function nextAcrossTimes(rule: RecurrenceRule, from: Date, timezone: string): Date | null {
  const slots = slotsOf(rule);
  const first = slots[0]!;
  const last = slots[slots.length - 1]!;
  const w = wallOf(from, timezone);
  const fromMs = from.getTime();

  // 1. A later slot TODAY. Guarded by `isRuleDay` because `from` is not always a real occurrence:
  //    a caller may hand in an anchor (a schedule's time-of-day resolved onto today) that lands on
  //    a day the rule narrows away, and firing that day's slots would ignore the narrowing.
  if (isRuleDay(rule, from, timezone)) {
    for (const s of slots) {
      const cand = atSlot(w, w.year, w.month, w.day, s, timezone);
      if (cand.getTime() > fromMs) return withinUntil(cand, rule.until);
    }
  }

  // 2. Roll to the next selected DAY and land on its first slot. The roll walks off a probe at
  //    today's LAST slot so the day-walk cannot hand back a same-day instant step 1 already
  //    rejected, and it walks a copy of the rule with `until` stripped — the walk's intermediate
  //    instants carry the probe's time-of-day, not the slot's, so cutting the walk on `until`
  //    would drop an occurrence whose real (re-stamped) instant is still inside the bound.
  //    `until` is applied to the re-stamped instant instead, which is the one that actually fires.
  const probe = atSlot(w, w.year, w.month, w.day, last, timezone);
  const anchor = probe.getTime() > fromMs ? probe : from;
  const walkRule: RecurrenceRule = { ...rule, until: undefined, timesOfDay: undefined };
  let cursor = nextSingleTime(walkRule, anchor, timezone);
  for (let guard = 0; cursor && guard < DAYS_SCAN_CAP; guard++) {
    const cw = wallOf(cursor, timezone);
    const landed = atSlot(cw, cw.year, cw.month, cw.day, first, timezone);
    if (landed.getTime() > fromMs) return withinUntil(landed, rule.until);
    cursor = nextSingleTime(walkRule, cursor, timezone);
  }
  return null;
}

function nextSingleTime(
  rule: RecurrenceRule,
  from: Date,
  timezone: string,
): Date | null {
  const interval = rule.interval && rule.interval > 0 ? rule.interval : 1;
  const w = wallOf(from, timezone);

  switch (rule.freq) {
    case "daily": {
      const next = instantOf(w.year, w.month, w.day + interval, w, timezone);
      return withinUntil(next, rule.until);
    }

    case "weekly": {
      const days =
        rule.byWeekday && rule.byWeekday.length > 0
          ? [...new Set(rule.byWeekday)].sort((a, b) => a - b)
          : [w.weekday];
      // Days from Monday (WKST=MO) to `from`'s weekday.
      const fromDaysSinceMonday = (w.weekday + 6) % 7;
      for (let n = 1; n <= DAYS_SCAN_CAP; n++) {
        const candidateWeekday = (w.weekday + n) % 7;
        if (!days.includes(candidateWeekday)) continue;
        const weekOffset = Math.floor((fromDaysSinceMonday + n) / 7);
        if (weekOffset % interval !== 0) continue;
        const next = instantOf(w.year, w.month, w.day + n, w, timezone);
        return withinUntil(next, rule.until);
      }
      return null;
    }

    case "monthly": {
      const setPos = usesSetPos(rule);
      const targetDay = rule.byMonthDay ?? w.day;
      for (let offset = 0; offset <= 12 * interval + 12; offset++) {
        if (offset % interval !== 0) continue;
        const [year, month] = addMonths(w.year, w.month, offset);
        // "The 2nd Tuesday": the day is looked up per month rather than clamped, because the
        // position moves — a month with five Tuesdays puts the 2nd on a different date than one
        // with four does. `bySetPos` wins over `byMonthDay`; see the schema's note on why.
        const day = setPos
          ? nthWeekdayOfMonth(year, month, rule.byWeekday!, rule.bySetPos!)
          : Math.min(targetDay, daysInMonth(year, month));
        if (day === null) continue; // no such position this month (e.g. a 5th Friday) — skip it
        const next = instantOf(year, month, day, w, timezone);
        if (next.getTime() > from.getTime()) return withinUntil(next, rule.until);
      }
      return null;
    }

    case "yearly": {
      const setPos = usesSetPos(rule);
      const targetMonth = rule.byMonth ? rule.byMonth - 1 : w.month;
      const targetDay = rule.byMonthDay ?? w.day;
      for (let offset = 0; offset <= interval + 8; offset++) {
        if (offset % interval !== 0) continue;
        const year = w.year + offset;
        // Same nth-weekday rule as monthly, resolved inside the anchor MONTH ("the last Thursday
        // of November" — an anniversary that is a weekday, not a date).
        const day = setPos
          ? nthWeekdayOfMonth(year, targetMonth, rule.byWeekday!, rule.bySetPos!)
          : Math.min(targetDay, daysInMonth(year, targetMonth));
        if (day === null) continue;
        const next = instantOf(year, targetMonth, day, w, timezone);
        if (next.getTime() > from.getTime()) return withinUntil(next, rule.until);
      }
      return null;
    }
  }
}

/**
 * Does `instant` land on a day the rule ALLOWS, observed in `timezone`?
 *
 * `computeNextRunAt` derives every occurrence from the rule, so its output always does — but an
 * ANCHOR handed in by a caller (a schedule's time-of-day resolved onto today) has never been
 * checked against the rule's narrowing. That is what this is for: a Mon/Wed/Fri rule anchored on a
 * Tuesday must not fire on the Tuesday. Same narrowing as `isHabitDay` (`interval` deliberately
 * ignored — a lone instant carries no series phase).
 */
export function isRuleDay(rule: RecurrenceRule, instant: Date, timezone: string): boolean {
  const w = wallOf(instant, timezone);
  // `bySetPos` is answered HERE rather than delegated: `isHabitDay`'s monthly branch narrows on
  // `byMonthDay` alone, so a "2nd Tuesday" rule (which carries no byMonthDay) would fall through
  // its `return true` and call every day of the month a rule day — the exact opposite of the
  // narrowing this function exists to apply.
  if (usesSetPos(rule)) {
    if (rule.freq === "yearly" && rule.byMonth !== undefined && rule.byMonth !== w.month + 1) {
      return false;
    }
    return nthWeekdayOfMonth(w.year, w.month, rule.byWeekday!, rule.bySetPos!) === w.day;
  }
  return isHabitDay(rule, `${w.year}-${w.month + 1}-${w.day}`);
}

/**
 * One-line human summary of a rule — "Every 2 weeks on Tue, Thu until 30 Sep 2026".
 *
 * Here rather than in the web app because THREE surfaces now need the same sentence: the event
 * sheet's recurrence chip, the reminders CSV export, and the digest. A locale-formatted date is
 * the one impurity; `Intl` is in every runtime this ships to, and the alternative — passing a
 * formatter in — makes every call site noisier to save nothing.
 */
const RECURRENCE_WEEKDAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SET_POS_LABEL = ["1st", "2nd", "3rd", "4th"];

/** " on the 2nd Tue" for a set-position rule; null when the rule doesn't use one, so callers can
 *  fall back to their own by-number phrase with `??` and keep existing summaries byte-identical. */
function setPosPhrase(rule: { bySetPos?: number; byWeekday?: number[] }): string | null {
  if (rule.bySetPos === undefined || !rule.byWeekday?.length) return null;
  const ord = rule.bySetPos === -1 ? "last" : SET_POS_LABEL[rule.bySetPos - 1];
  if (!ord) return null;
  return ` on the ${ord} ${rule.byWeekday.map((d) => RECURRENCE_WEEKDAY_LABEL[d]).join("/")}`;
}

export function recurrenceSummary(
  rule: (Omit<RecurrenceRule, "interval"> & { interval?: number }) | null | undefined,
): string | undefined {
  if (!rule) return undefined;
  const n = rule.interval ?? 1;
  const every = n === 1 ? "Every" : `Every ${n}`;
  let base: string;
  switch (rule.freq) {
    case "daily":
      base = `${every} ${n === 1 ? "day" : "days"}`;
      break;
    case "weekly":
      base = rule.byWeekday?.length
        ? `${every} ${n === 1 ? "week" : "weeks"} on ${rule.byWeekday.map((d) => RECURRENCE_WEEKDAY_LABEL[d]).join(", ")}`
        : `${every} ${n === 1 ? "week" : "weeks"}`;
      break;
    case "monthly":
      base =
        `${every} ${n === 1 ? "month" : "months"}` +
        (setPosPhrase(rule) ?? (rule.byMonthDay ? ` on day ${rule.byMonthDay}` : ""));
      break;
    default:
      base = `${every} ${n === 1 ? "year" : "years"}${setPosPhrase(rule) ?? ""}`;
  }
  if (rule.timesOfDay?.length) {
    base += ` at ${[...new Set(rule.timesOfDay)].sort().join(", ")}`;
  }
  if (rule.until) {
    base += ` until ${new Date(rule.until).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  }
  return base;
}
