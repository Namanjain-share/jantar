// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// Medication adherence math (LIFE-OS §Meds deepen) — pure, tz-free. Callers hand in day keys
// (YYYY-MM-DD) already resolved in the user's timezone, so nothing here touches Date.
//
// THE distinction this module exists to make: a SKIPPED dose (you decided not to take it, with a
// reason) is not a MISSED dose (nothing happened). A skip is excluded from `adherencePct`'s
// denominator — it cannot hold your number down — but it IS counted against `strictPct` for the
// honest "how much of the plan actually went in" view. Missing shows up in both.
//
// Doses are stored as `metrics` rows (kind "med:<id>", value 1 taken / 0 skipped) so the existing
// metric + rollup pipeline serves them; this module only interprets the (day, slot, status) tuples.
//
// TWO AXES, one denominator: `times[]` says WHEN in the day a dose is due, `schedule` says WHICH
// DAYS. Every scheduled-slot count in this file (and in meds.ts's miss patterns) goes through the
// single predicate `isScheduledOn` — a weekly injection must read as one scheduled dose that week,
// not as six chronic misses, and two implementations of "is a dose due today" is exactly how a
// safety feature rots.

/** What a logged dose says happened. "missed" is never logged — it is the absence of a log. */
export type DoseStatus = "taken" | "skipped";
/** What a scheduled slot resolved to once the log set is applied. */
export type SlotStatus = DoseStatus | "missed" | "pending";

/** Time-of-day buckets the daily checklist groups by. "anytime" holds as-needed (PRN) meds. */
export const DOSE_PERIODS = ["morning", "afternoon", "night", "anytime"] as const;
export type DosePeriod = (typeof DOSE_PERIODS)[number];

/** Minutes after which a dose taken past its slot counts as late (not missed — still taken). */
export const DOSE_GRACE_MINUTES = 60;

/** "08:30" → 510. Malformed input yields 0 rather than NaN so downstream comparisons stay total. */
export function minutesOfDay(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Which checklist bucket a scheduled HH:MM belongs to: <12:00 morning, <18:00 afternoon, else night. */
export function slotPeriod(hhmm: string): DosePeriod {
  const mins = minutesOfDay(hhmm);
  if (mins < 12 * 60) return "morning";
  if (mins < 18 * 60) return "afternoon";
  return "night";
}

/** The scheduled time a dose taken at `hhmm` most plausibly fulfils. Null for an unscheduled med. */
export function nearestSlot(times: string[], hhmm: string): string | null {
  if (times.length === 0) return null;
  const at = minutesOfDay(hhmm);
  let best = times[0]!;
  let bestDist = Math.abs(minutesOfDay(best) - at);
  for (const t of times.slice(1)) {
    const d = Math.abs(minutesOfDay(t) - at);
    if (d < bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}

/** True when a dose taken at `hhmm` landed more than `graceMinutes` AFTER its slot. Early is never late. */
export function isLateDose(slot: string, hhmm: string, graceMinutes = DOSE_GRACE_MINUTES): boolean {
  return minutesOfDay(hhmm) - minutesOfDay(slot) > graceMinutes;
}

/** One logged dose, already resolved to the user's local day. `slot` null = unscheduled (PRN/extra). */
export interface DoseLogEntry {
  id?: string;
  medId: string;
  day: string;
  slot?: string | null;
  status: DoseStatus;
  late?: boolean;
  reason?: string;
}

/**
 * The day-axis recurrence a medication can express — declared STRUCTURALLY (exactly as habits.ts
 * declares `HabitScheduleLike`) so this file stays free of the zod schema layer; `MedSchedule` from
 * schemas/medication.ts satisfies it.
 *
 * INVARIANT: `undefined` means "daily, every day, no course dates" — the behaviour every med had
 * before schedules existed. That is what makes this a zero-migration change, and no caller may
 * give an absent schedule any other meaning.
 */
export interface MedScheduleLike {
  freq: "daily" | "weekly" | "interval";
  /** freq "interval" only: due every Nth day counting from `startDay`. */
  interval?: number;
  /** freq "weekly" only: 0 = Sunday … 6 = Saturday (JS `getUTCDay`) — the same convention as
   *  `recurrenceRule.byWeekday`, `habits.isHabitDay` and `meds.weekdayOfDayKey`. */
  byWeekday?: readonly number[];
  /** Course start (inclusive) and the "interval" phase anchor. */
  startDay?: string;
  /** Course end (inclusive). */
  endDay?: string;
}

/**
 * ONE version of a med's day-axis schedule, and the day it came into force.
 *
 * Why the history exists at all. A medication doc stores exactly ONE `schedule`, and a schedule
 * edit replaces it wholesale. Reading the whole analysed window through the CURRENT schedule
 * therefore re-interprets every past day under a rule that did not exist then, and silently
 * rewrites the adherence record — the number a person shows a prescriber — in both directions:
 * moving a daily med to every-other-day erased eight real misses and reclassified twenty real
 * takes as unscheduled extras, and moving a Mon/Thu injection to daily invented twenty-four
 * misses out of a perfect record. Neither said anything on screen.
 *
 * So a schedule is EFFECTIVE-DATED. Each entry means "from `from` (inclusive) onward, this was the
 * schedule", and a day is judged by the entry in force ON IT.
 */
export interface MedScheduleVersionLike {
  /** `YYYY-MM-DD` the version came into force, inclusive. */
  from: string;
  /** The schedule in force from `from`. Absent ⇒ the daily-every-day default (`MedScheduleLike`). */
  schedule?: MedScheduleLike;
}

/** A med's schedule over the analysed window. `startDay`/`endDay` clamp it so a med added mid-window
 *  (or paused) is not charged for days it did not exist — those are the med's LIFETIME bounds, and
 *  they are independent of `schedule.startDay`/`endDay`, which are the PRESCRIPTION's course dates
 *  (a med created in January can carry a course that only runs in March). Both apply. */
export interface MedWindow {
  medId: string;
  times: string[];
  /** Which DAYS the times[] are due on TODAY. Absent ⇒ every day (see `MedScheduleLike`). Only the
   *  fallback for a med with no recorded history — `scheduleHistory` wins wherever it exists. */
  schedule?: MedScheduleLike;
  /** The effective-dated schedule versions, ASCENDING by `from`. Absent/empty ⇒ the med has no
   *  recorded history and every day is judged by `schedule` (the pre-history behaviour). */
  scheduleHistory?: readonly MedScheduleVersionLike[];
  startDay?: string;
  endDay?: string;
  /** Stretches the med was PAUSED for, `[from, to]` inclusive day keys. A paused day is not
   *  scheduled, so it can never be counted as a miss — and unlike `endDay` (which only describes a
   *  med that is paused RIGHT NOW) this survives the resume. */
  pausedRanges?: readonly { from: string; to: string }[];
}

/**
 * The schedule that governed `day` — the history entry in force on it, else the current one.
 *
 * Days BEFORE the first recorded version fall back to that first version rather than to the
 * daily-every-day default: the first entry is stamped when the med is created (or on its first
 * schedule edit, which also back-stamps what was there before), so anything earlier is outside the
 * med's own lifetime and `MedWindow.startDay` already excludes it.
 */
export function scheduleForDay(
  m: Pick<MedWindow, "schedule" | "scheduleHistory">,
  day: string,
): MedScheduleLike | undefined {
  const history = m.scheduleHistory;
  if (!history || history.length === 0) return m.schedule;
  let chosen = history[0]!;
  for (const v of history) {
    if (v.from <= day) chosen = v;
    else break; // ascending by `from` — nothing later can be in force on an earlier day
  }
  return chosen.schedule;
}

/** Was the med paused across the whole of `day`? A paused day schedules nothing at all. */
export function isPausedOn(m: Pick<MedWindow, "pausedRanges">, day: string): boolean {
  return (m.pausedRanges ?? []).some((r) => day >= r.from && day <= r.to);
}

const MS_PER_DAY = 86_400_000;

/** 0 = Sunday … 6 = Saturday for a `YYYY-MM-DD` key. `Date.UTC` here is pure calendar arithmetic
 *  over an already-tz-resolved label — no clock and no zone is ever read, so this file stays tz-free
 *  (same technique as habits.shiftDayKey and meds.weekdayOfDayKey). */
function weekdayOfDay(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Whole days from `from` to `to`, negative when `to` is earlier. */
function dayDelta(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / MS_PER_DAY);
}

/**
 * THE predicate: is this medication due on `day` at all? Every scheduled-slot count, adherence
 * percentage, streak, heatmap cell and miss-pattern bucket goes through this one function, and so
 * must the router and the reminder pre-send guard — a dose the checklist says isn't due today must
 * not be one the notification says is.
 *
 * A day outside `[startDay, endDay]` is NOT scheduled, so it can never be counted as a miss: a
 * finished 10-day course goes quiet instead of decaying the number. (A repeating on/off CYCLE —
 * 21 on, 7 off — is deliberately NOT representable here: `medSchedule` offers daily, named
 * weekdays and every-Nth-day plus ONE `startDay`..`endDay` window, none of which has a period of
 * `onDays + offDays`. Do not document a spelling this schema cannot express; the honest answer to
 * a cycle today is a plain daily schedule and a pause for the off block.)
 *
 * Pure string/UTC day-key math — `day` is a `YYYY-MM-DD` label already resolved in the user's zone.
 */
export function isScheduledOn(schedule: MedScheduleLike | undefined, day: string): boolean {
  if (!schedule) return true; // the zero-migration default: daily, every day, forever
  if (schedule.startDay && day < schedule.startDay) return false;
  if (schedule.endDay && day > schedule.endDay) return false;
  switch (schedule.freq) {
    case "weekly":
      // An empty weekday set is rejected by the schema; treat it as "every day" rather than
      // "never", because silently scheduling NOTHING would hide doses instead of over-showing them.
      if (!schedule.byWeekday || schedule.byWeekday.length === 0) return true;
      return schedule.byWeekday.includes(weekdayOfDay(day));
    case "interval": {
      const n = schedule.interval ?? 1;
      if (n <= 1) return true;
      // `startDay` is the phase anchor and the schema requires it for this freq. Without one the
      // alternation is unresolvable, so fall back to every day (over-showing, never hiding).
      if (!schedule.startDay) return true;
      const delta = dayDelta(schedule.startDay, day);
      return delta >= 0 && delta % n === 0;
    }
    default:
      return true; // "daily"
  }
}

/** The med's `times[]` on `day` — empty on a day the schedule does not cover. The one-line form the
 *  router and the pre-send guard should use so "which doses are due today" has a single answer. */
export function scheduledTimesOn(m: Pick<MedWindow, "times" | "schedule">, day: string): string[] {
  return isScheduledOn(m.schedule, day) ? m.times : [];
}

/** The instant the window is evaluated at — slots at/after it are `pending`, never `missed`. */
export interface AdherenceAsOf {
  day: string;
  time: string;
}

export interface AdherenceCounts {
  /** Scheduled slots in the window (times[] × the days the med's `schedule` actually covers),
   *  pending ones included. A weekly med contributes its times[] ONCE a week, not seven times. */
  scheduled: number;
  taken: number;
  skipped: number;
  missed: number;
  /** Scheduled slots not yet due at `asOf`. */
  pending: number;
  /** Takes with no scheduled slot to fill: as-needed meds and same-slot duplicates. */
  extraTaken: number;
  /** Of `taken`, how many landed past the grace window. */
  lateTaken: number;
  /** taken / (taken + missed) — SKIPS EXCLUDED. Null when nothing resolved for/against you. */
  adherencePct: number | null;
  /** taken / (taken + skipped + missed) — skips counted against. Null when nothing resolved. */
  strictPct: number | null;
}

export interface AdherenceDay extends AdherenceCounts {
  day: string;
}

export interface AdherenceResult {
  overall: AdherenceCounts;
  perMed: Record<string, AdherenceCounts>;
  perDay: AdherenceDay[];
  /** Consecutive trailing days with ≥1 taken dose and zero missed ones. */
  streakDays: number;
}

function emptyCounts(): AdherenceCounts {
  return { scheduled: 0, taken: 0, skipped: 0, missed: 0, pending: 0, extraTaken: 0, lateTaken: 0, adherencePct: null, strictPct: null };
}

function finalize(c: AdherenceCounts): AdherenceCounts {
  const held = c.taken + c.missed;
  const resolved = c.taken + c.skipped + c.missed;
  c.adherencePct = held > 0 ? c.taken / held : null;
  c.strictPct = resolved > 0 ? c.taken / resolved : null;
  return c;
}

function addTo(target: AdherenceCounts, status: SlotStatus, late: boolean): void {
  if (status === "taken") {
    target.taken += 1;
    if (late) target.lateTaken += 1;
  } else if (status === "skipped") target.skipped += 1;
  else if (status === "missed") target.missed += 1;
  else target.pending += 1;
  target.scheduled += 1;
}

/** Is `day` inside the med's own active window? */
function inWindow(m: MedWindow, day: string): boolean {
  if (m.startDay && day < m.startDay) return false;
  if (m.endDay && day > m.endDay) return false;
  return true;
}

/** Is a slot on `day` still in the future relative to `asOf`? */
function isPending(day: string, slot: string, asOf: AdherenceAsOf | undefined): boolean {
  if (!asOf) return false;
  if (day > asOf.day) return true;
  if (day < asOf.day) return false;
  return minutesOfDay(slot) > minutesOfDay(asOf.time);
}

/**
 * Resolve one (med, day)'s scheduled slots against that day's logs. Each slot consumes at most one
 * log; leftover logs (as-needed takes, same-slot duplicates, logs whose slot was later removed from
 * the schedule, doses taken on an OFF day) come back as `extra` so they are visible without
 * inflating adherence.
 *
 * The day predicate lives HERE rather than at the call sites so that every caller — adherence,
 * checklist, miss patterns — is filtered by construction and they cannot drift apart.
 */
export function resolveDay(
  m: Pick<MedWindow, "times" | "schedule">,
  day: string,
  logs: DoseLogEntry[],
  asOf: AdherenceAsOf | undefined,
): { slots: { slot: string; status: SlotStatus; log?: DoseLogEntry }[]; extra: DoseLogEntry[] } {
  const unused = [...logs];
  const slots = scheduledTimesOn(m, day).map((slot) => {
    const i = unused.findIndex((l) => l.slot === slot);
    if (i >= 0) {
      const [l] = unused.splice(i, 1);
      return { slot, status: l!.status as SlotStatus, log: l! };
    }
    return { slot, status: isPending(day, slot, asOf) ? ("pending" as const) : ("missed" as const) };
  });
  return { slots, extra: unused };
}

/** Bucket the logs by (medId, day). The composite key uses `\0` — written as the ESCAPE, never as
 *  a literal NUL byte in the source, or git classifies this file as binary and stops producing a
 *  diff for the module that decides what counts as a missed dose. A separator that cannot occur in
 *  either half is the point: a med id containing the delimiter would collide two meds' days. */
function groupLogs(logs: DoseLogEntry[]): Map<string, DoseLogEntry[]> {
  const by = new Map<string, DoseLogEntry[]>();
  for (const l of logs) {
    const k = `${l.medId}\0${l.day}`;
    const bucket = by.get(k);
    if (bucket) bucket.push(l);
    else by.set(k, [l]);
  }
  return by;
}

/**
 * Adherence over a day window: overall, per-med, per-day, plus the streak. `days` must be ascending
 * YYYY-MM-DD keys in the user's timezone; `logs` are that window's dose rows.
 */
export function computeAdherence(args: {
  days: string[];
  meds: MedWindow[];
  logs: DoseLogEntry[];
  asOf?: AdherenceAsOf;
}): AdherenceResult {
  const { days, meds, logs, asOf } = args;
  const byMedDay = groupLogs(logs);
  const overall = emptyCounts();
  const perMed: Record<string, AdherenceCounts> = {};
  const perDay: AdherenceDay[] = [];

  for (const m of meds) perMed[m.medId] = emptyCounts();

  for (const day of days) {
    const dayCounts = emptyCounts();
    for (const m of meds) {
      const medCounts = perMed[m.medId]!;
      const dayLogs = byMedDay.get(`${m.medId}\0${day}`) ?? [];
      // The day is judged by the schedule that was IN FORCE ON IT (never by today's), and a day
      // the med was paused across schedules nothing at all.
      const active = inWindow(m, day) && !isPausedOn(m, day);
      const schedule = scheduleForDay(m, day);
      const { slots, extra } = resolveDay(
        { times: active ? m.times : [], ...(schedule ? { schedule } : {}) },
        day,
        dayLogs,
        asOf,
      );
      for (const s of slots) {
        const late = s.log?.late === true;
        addTo(medCounts, s.status, late);
        addTo(dayCounts, s.status, late);
        addTo(overall, s.status, late);
      }
      const extraTaken = extra.filter((l) => l.status === "taken").length;
      medCounts.extraTaken += extraTaken;
      dayCounts.extraTaken += extraTaken;
      overall.extraTaken += extraTaken;
    }
    perDay.push({ day, ...finalize(dayCounts) });
  }

  for (const k of Object.keys(perMed)) finalize(perMed[k]!);
  finalize(overall);

  return { overall, perMed, perDay, streakDays: adherenceStreak(perDay) };
}

/**
 * Consecutive trailing days (newest backwards) with zero missed doses and at least one taken.
 * A day with nothing scheduled — or one whose scheduled doses were all deliberately SKIPPED —
 * neither builds nor breaks the run; only a real miss stops it.
 */
export function adherenceStreak(perDay: AdherenceDay[]): number {
  let streak = 0;
  for (let i = perDay.length - 1; i >= 0; i--) {
    const d = perDay[i]!;
    if (d.missed > 0) break;
    if (d.taken > 0) streak += 1;
  }
  return streak;
}

// ── Today's checklist ────────────────────────────────────────────────────────────────────────
export interface ChecklistMed {
  medId: string;
  name: string;
  dosage?: string;
  times: string[];
  /** Which days those times are due on. Absent ⇒ every day (see `MedScheduleLike`). */
  schedule?: MedScheduleLike;
}

export interface ChecklistItem {
  medId: string;
  name: string;
  dosage?: string;
  /** The scheduled HH:MM this row is for; null on an as-needed row. */
  slot: string | null;
  period: DosePeriod;
  status: SlotStatus;
  late?: boolean;
  reason?: string;
  /** Present once logged — what edit/delete acts on. */
  logId?: string;
}

export interface ChecklistGroup {
  period: DosePeriod;
  items: ChecklistItem[];
}

/**
 * One day's dose checklist, grouped by time-of-day and driven by each medication's `times[]` on the
 * days its `schedule` covers. Scheduled slots render taken / skipped / missed / pending; as-needed
 * meds (and any dose logged outside the schedule, including one taken on an OFF day) collect under
 * "anytime", each followed by one pending row to log another.
 *
 * A med the schedule does not cover today contributes NO rows — the Monday-only injection is simply
 * absent from Tuesday's list rather than sitting there as six standing misses a week.
 */
export function buildDayChecklist(args: {
  day: string;
  meds: ChecklistMed[];
  logs: DoseLogEntry[];
  asOf?: AdherenceAsOf;
}): ChecklistGroup[] {
  const { day, meds, logs, asOf } = args;
  const byMedDay = groupLogs(logs.filter((l) => l.day === day));
  const buckets = new Map<DosePeriod, ChecklistItem[]>(DOSE_PERIODS.map((p) => [p, []]));

  for (const m of meds) {
    const base = { medId: m.medId, name: m.name, ...(m.dosage ? { dosage: m.dosage } : {}) };
    const { slots, extra } = resolveDay(m, day, byMedDay.get(`${m.medId}\0${day}`) ?? [], asOf);
    for (const s of slots) {
      buckets.get(slotPeriod(s.slot))!.push({
        ...base,
        slot: s.slot,
        period: slotPeriod(s.slot),
        status: s.status,
        ...(s.log?.late ? { late: true } : {}),
        ...(s.log?.reason ? { reason: s.log.reason } : {}),
        ...(s.log?.id ? { logId: s.log.id } : {}),
      });
    }
    const anytime = buckets.get("anytime")!;
    for (const l of extra) {
      anytime.push({
        ...base,
        slot: null,
        period: "anytime",
        status: l.status,
        ...(l.late ? { late: true } : {}),
        ...(l.reason ? { reason: l.reason } : {}),
        ...(l.id ? { logId: l.id } : {}),
      });
    }
    // As-needed meds always keep one open row so there is something to tap.
    if (m.times.length === 0) anytime.push({ ...base, slot: null, period: "anytime", status: "pending" });
  }

  for (const items of buckets.values()) items.sort((a, b) => (a.slot ?? "").localeCompare(b.slot ?? "") || a.name.localeCompare(b.name));
  return DOSE_PERIODS.map((period) => ({ period, items: buckets.get(period)! })).filter((g) => g.items.length > 0);
}
