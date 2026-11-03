/**
 * What the medicines screens read: one day's dose checklist (MedsDay), and
 * each medicine with its supply and its last 30 days' adherence.
 *
 * All of it is life-core's copied logic (`buildDayChecklist`,
 * `computeAdherence`, `projectSupply`), fed the schedule and the dose times
 * that were in force on each day, so a later edit re-judges no past day.
 * The rules added here:
 * - On today (and any later day Today may ask for) an unlogged dose is
 *   `pending`, never `missed`: it can still be taken. It is `overdue` once
 *   it is more than DOSE_GRACE_MINUTES past its time. Only a past day has
 *   misses.
 * - A logged dose whose time is not on that day's list comes back from
 *   life-core under 'anytime'; MedsDay has no such group, so it is folded
 *   back under the period of the time it was logged for, where Undo can
 *   still reach it. (A times edit keeps today's logged times on today's
 *   list, so this is a guard.)
 * - On the day a medicine was stopped, only the dose times up to the Stop
 *   were due (`stopTime`): a later one leaves that day's list and is never
 *   a miss. One already logged stays, folded back as above.
 * - On the day a medicine was added, a dose time already gone by
 *   (`startTime`) was not due unless it was logged: on today it stays on
 *   the list as `beforeAdded` (a dose taken before it was added can still
 *   be logged), never overdue; on a past day it is not on the list; it is
 *   never a miss.
 * - Adherence is `adherencePct` only (skips left out), 0 to 100. Its misses
 *   (and so the two-day concern's) are read as of DOSE_GRACE_MINUTES ago:
 *   a dose is not a miss until it is overdue, the same rule as `overdue`.
 */
import {
  DEFAULT_REFILL_THRESHOLD_DAYS,
  DOSE_GRACE_MINUTES,
  buildDayChecklist,
  computeAdherence,
  dayKeyOf,
  dosesPerDayForSchedule,
  hhmmOf,
  instantAt,
  isLateDose,
  isScheduledOn,
  projectSupply,
  scheduleForDay,
  shiftDay,
  slotPeriod,
  type DoseLogEntry,
  type MedWindow,
} from '@jantar/life-core';
import type { MedicineView, MedsDay, MedsDayItem } from '@jantar/protocol';
import type { LifeCore } from '../../contracts.js';
import { publicMed, type DoseRow, type MedsRepo, type StoredMedicine } from './repo.js';

/** The adherence window: today and the 29 days before it. */
export const ADHERENCE_DAYS = 30;

const PERIODS = ['morning', 'afternoon', 'night'] as const;
type Period = (typeof PERIODS)[number];

/** `times` cut at the Stop when `day` is the day it was stopped. */
function upToStop(med: StoredMedicine, day: string, times: string[]): string[] {
  const at = med.stopTime;
  return at !== undefined && day === med.stoppedOn ? times.filter((t) => t <= at) : times;
}

/** The dose times in force on `day` (the first entry stands for any day before it; on the day of a Stop, those up to it). */
export function timesOn(med: StoredMedicine, day: string): string[] {
  let chosen = med.timesHistory[0]?.times ?? med.times;
  for (const e of med.timesHistory) {
    if (e.from <= day) chosen = e.times;
    else break;
  }
  return upToStop(med, day, chosen);
}

/**
 * Whether `slot` on `day` had gone by when the medicine was added (its
 * first day, before `startTime`). Such a dose can still be logged (taken
 * before it was added), but unlogged it was never due: never a miss, never
 * overdue, never "not logged".
 */
export function beforeAdded(med: StoredMedicine, day: string, slot: string): boolean {
  return med.startTime !== undefined && day === med.startedOn && slot < med.startTime;
}

/** The schedule in force on `day`, as adherence reads it. */
export function scheduleOn(med: StoredMedicine, day: string) {
  return scheduleForDay({ schedule: med.schedule, scheduleHistory: med.history }, day);
}

/** Whether the medicine was being taken on `day` at all (started, not stopped before it). */
export function takenOn(med: StoredMedicine, day: string): boolean {
  return med.startedOn <= day && (med.stoppedOn === undefined || day <= med.stoppedOn);
}

/** Whether a dose of `med` at `slot` was due on `day`. */
export function isDueOn(med: StoredMedicine, day: string, slot: string): boolean {
  return takenOn(med, day) && timesOn(med, day).includes(slot) && isScheduledOn(scheduleOn(med, day), day);
}

/**
 * A taken dose more than DOSE_GRACE_MINUTES after its time. Taken on its own
 * day this is life-core's `isLateDose`; taken on a later day it is late, on
 * an earlier one it is not.
 */
export function isLate(d: DoseRow, tz: string): boolean {
  if (d.status !== 'taken') return false;
  const at = new Date(d.at);
  const takenDay = dayKeyOf(at, tz);
  if (takenDay === d.day) return isLateDose(d.slot, hhmmOf(at, tz));
  return takenDay > d.day;
}

function logOf(d: DoseRow, tz: string): DoseLogEntry {
  return { id: d.id, medId: d.medId, day: d.day, slot: d.slot, status: d.status, ...(isLate(d, tz) ? { late: true } : {}) };
}

/** One day's checklist for the medicines taken that day (the doses read from `repo`'s space). */
export function medsDay(core: LifeCore, repo: MedsRepo, meds: readonly StoredMedicine[], day: string): MedsDay {
  const tz = core.tz();
  const now = core.now();
  const today = core.today();
  const active = meds.filter((m) => takenOn(m, day));
  const byMed = new Map(active.map((m) => [m.id, m]));
  const ids = new Set(byMed.keys());
  const rows = repo.dosesOn(day).filter((d) => ids.has(d.medId));
  const byId = new Map(rows.map((d) => [d.id, d]));
  // No asOf: every unlogged slot comes back 'missed', and today's are turned to pending below.
  const groups = buildDayChecklist({
    day,
    meds: active.map((m) => {
      const schedule = scheduleOn(m, day);
      return { medId: m.id, name: m.name, ...(m.dose ? { dosage: m.dose } : {}), times: timesOn(m, day), ...(schedule ? { schedule } : {}) };
    }),
    logs: rows.map((d) => logOf(d, tz)),
  });

  const out = new Map<Period, MedsDayItem[]>(PERIODS.map((p) => [p, []]));
  for (const g of groups) {
    for (const item of g.items) {
      const dose = item.logId ? byId.get(item.logId) : undefined;
      const slot = item.slot ?? dose?.slot;
      // A pending 'anytime' row only exists for a medicine with no times, which the schema forbids.
      if (!slot) continue;
      const med = byMed.get(item.medId);
      // A time gone by when it was added: on today it stays to be logged if taken, never overdue; on a past day it was never due.
      const pre = !dose && med !== undefined && beforeAdded(med, day, slot);
      if (pre && day < today) continue;
      const status = item.status === 'missed' && day >= today ? 'pending' : item.status;
      const overdue = !pre && status === 'pending' && day === today && now.getTime() - instantAt(day, slot, tz).getTime() > DOSE_GRACE_MINUTES * 60_000;
      const row: MedsDayItem = {
        medId: item.medId,
        name: item.name,
        ...(item.dosage ? { dose: item.dosage } : {}),
        slot,
        status,
        ...(pre ? { beforeAdded: true as const } : {}),
        ...(item.late ? { late: true } : {}),
        ...(dose ? { doseId: dose.id, at: dose.at } : {}),
        overdue,
      };
      out.get(slotPeriod(slot) as Period)?.push(row);
    }
  }
  return {
    day,
    today,
    groups: PERIODS.map((period) => ({
      period,
      items: (out.get(period) ?? []).sort((a, b) => a.slot.localeCompare(b.slot) || a.name.localeCompare(b.name)),
    })).filter((g) => g.items.length > 0),
  };
}

/** Days of supply from the pill count (low at a week or less), or null when the medicine keeps no count. */
export function supplyOf(med: StoredMedicine, today: string): MedicineView['supply'] {
  if (!med.pills) return null;
  const perDay = dosesPerDayForSchedule({ times: med.times, schedule: med.schedule, active: med.stoppedOn === undefined }, today);
  const s = projectSupply({ unitsRemaining: med.pills.left, unitsPerDose: med.pills.perDose }, perDay, today);
  return { daysLeft: s.daysRemaining, runsOut: s.runsOutDay, low: s.daysRemaining !== null && s.daysRemaining <= DEFAULT_REFILL_THRESHOLD_DAYS };
}

/**
 * The adherence windows of one medicine: one per entry of `timesHistory`,
 * each clamped to the days its times were in force (life-core reads one
 * list of times per window), with the day it was added and the day of a
 * Stop each a window of its own. The day it was added holds the times from
 * the add on, plus any earlier one that was logged (`logged`); the day of a
 * Stop, the times up to it. The windows share the medicine's id, so
 * life-core adds them up under it.
 */
function windowsOf(med: StoredMedicine, logged: (day: string) => ReadonlySet<string>): MedWindow[] {
  const entries = med.timesHistory;
  const isCut = (day: string) => (med.startTime !== undefined && day === med.startedOn) || (med.stopTime !== undefined && day === med.stoppedOn);
  const dueOn = (day: string, times: string[]) => {
    const kept = med.startTime !== undefined && day === med.startedOn ? times.filter((t) => !beforeAdded(med, day, t) || logged(day).has(t)) : times;
    return upToStop(med, day, kept);
  };
  return entries.flatMap((e, i) => {
    const next = entries[i + 1];
    const start = i === 0 || e.from < med.startedOn ? med.startedOn : e.from;
    let end = med.stoppedOn;
    if (next) {
      const before = shiftDay(next.from, -1);
      if (end === undefined || before < end) end = before;
    }
    const span = (times: string[], from: string, to: string | undefined): MedWindow => ({
      medId: med.id,
      times,
      schedule: med.schedule,
      scheduleHistory: med.history,
      startDay: from,
      ...(to !== undefined ? { endDay: to } : {}),
    });
    if (end !== undefined && start > end) return [span(e.times, start, end)];
    // The window's cut days (the add, the Stop) come out as one-day windows of their own.
    const cuts = [...new Set([med.startedOn, med.stoppedOn])].filter((d): d is string => d !== undefined && d >= start && (end === undefined || d <= end) && isCut(d)).sort();
    if (cuts.length === 0) return [span(e.times, start, end)];
    const out: MedWindow[] = [];
    let from = start;
    for (const day of cuts) {
      if (from < day) out.push(span(e.times, from, shiftDay(day, -1)));
      const due = dueOn(day, e.times);
      if (due.length) out.push(span(due, day, day));
      from = shiftDay(day, 1);
    }
    if (end === undefined || from <= end) out.push(span(e.times, from, end));
    return out;
  });
}

/**
 * Adherence's "as of": DOSE_GRACE_MINUTES before now, so a dose counts as
 * not logged only once it is overdue (MedsDay's rule), never the minute it
 * comes due. Just after midnight this is still yesterday: today has no miss.
 */
function graceAsOf(now: Date, tz: string): { day: string; time: string } {
  const at = new Date(now.getTime() - DOSE_GRACE_MINUTES * 60_000);
  return { day: dayKeyOf(at, tz), time: hhmmOf(at, tz) };
}

/**
 * The last 30 days of a space's medicines, skips left out (life-core's
 * `computeAdherence`): each medicine's percentage, the whole space's, and
 * each day's taken and missed counts (the two-day concern reads them). A
 * dose is a miss once it is past its grace (`graceAsOf`). Percentages are
 * 0 to 100, or null when nothing was due and past it.
 */
export function adherenceReport(
  core: LifeCore,
  repo: MedsRepo,
  meds: readonly StoredMedicine[],
): { perMed: Map<string, number | null>; overall: number | null; perDay: { day: string; taken: number; missed: number }[] } {
  const tz = core.tz();
  const now = core.now();
  const today = core.today();
  const days = Array.from({ length: ADHERENCE_DAYS }, (_, i) => shiftDay(today, i - (ADHERENCE_DAYS - 1)));
  const rows = repo.dosesBetween(days[0] ?? today, today);
  const slots = new Map<string, Set<string>>();
  for (const d of rows) {
    const key = `${d.medId}|${d.day}`;
    const set = slots.get(key) ?? new Set<string>();
    set.add(d.slot);
    slots.set(key, set);
  }
  const none: ReadonlySet<string> = new Set();
  const logs = rows.map((d) => logOf(d, tz));
  const windows = meds.flatMap((m) => windowsOf(m, (day) => slots.get(`${m.id}|${day}`) ?? none));
  const result = computeAdherence({ days, meds: windows, logs, asOf: graceAsOf(now, tz) });
  const pct = (p: number | null | undefined) => (p === null || p === undefined ? null : Math.round(p * 100));
  const perMed = new Map<string, number | null>();
  for (const m of meds) perMed.set(m.id, pct(result.perMed[m.id]?.adherencePct));
  return { perMed, overall: pct(result.overall.adherencePct), perDay: result.perDay.map((d) => ({ day: d.day, taken: d.taken, missed: d.missed })) };
}

/** Each medicine's last 30 days, skips left out: 0 to 100, or null when nothing was due and past. */
export function adherenceOf(core: LifeCore, repo: MedsRepo, meds: readonly StoredMedicine[]): Map<string, number | null> {
  return adherenceReport(core, repo, meds).perMed;
}

/** Every medicine as the screen shows it: taking first by name, stopped ones last. */
export function medViews(core: LifeCore, repo: MedsRepo, meds: readonly StoredMedicine[]): (MedicineView & { by?: string; editedBy?: string; editedAt?: string })[] {
  const today = core.today();
  const pct = adherenceOf(core, repo, meds);
  const order = [...meds].sort((a, b) => Number(a.stoppedOn !== undefined) - Number(b.stoppedOn !== undefined) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return order.map((m) => ({ ...publicMed(m), supply: supplyOf(m, today), adherencePct: pct.get(m.id) ?? null }));
}
