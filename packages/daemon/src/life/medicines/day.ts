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
 * - Adherence is `adherencePct` only (skips left out), 0 to 100.
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
import { dosesBetween, dosesOn, publicMed, type DoseRow, type StoredMedicine } from './repo.js';

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

/** One day's checklist for the medicines taken that day. */
export function medsDay(core: LifeCore, meds: readonly StoredMedicine[], day: string): MedsDay {
  const tz = core.tz();
  const now = core.now();
  const today = core.today();
  const active = meds.filter((m) => takenOn(m, day));
  const ids = new Set(active.map((m) => m.id));
  const rows = dosesOn(core, day).filter((d) => ids.has(d.medId));
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
      const status = item.status === 'missed' && day >= today ? 'pending' : item.status;
      const overdue = status === 'pending' && day === today && now.getTime() - instantAt(day, slot, tz).getTime() > DOSE_GRACE_MINUTES * 60_000;
      const row: MedsDayItem = {
        medId: item.medId,
        name: item.name,
        ...(item.dosage ? { dose: item.dosage } : {}),
        slot,
        status,
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
 * list of times per window), and the day of a Stop on its own with the
 * times up to it. The windows share the medicine's id, so life-core adds
 * them up under it.
 */
function windowsOf(med: StoredMedicine): MedWindow[] {
  const entries = med.timesHistory;
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
    // The window that holds the day of a Stop ends the day before it; that day is a window of its own.
    if (med.stopTime === undefined || end === undefined || end !== med.stoppedOn || start > end) return [span(e.times, start, end)];
    const last = upToStop(med, end, e.times);
    return [...(start < end ? [span(e.times, start, shiftDay(end, -1))] : []), ...(last.length ? [span(last, end, end)] : [])];
  });
}

/** Each medicine's last 30 days, skips left out: 0 to 100, or null when nothing was due and past. */
export function adherenceOf(core: LifeCore, meds: readonly StoredMedicine[]): Map<string, number | null> {
  const tz = core.tz();
  const now = core.now();
  const today = core.today();
  const days = Array.from({ length: ADHERENCE_DAYS }, (_, i) => shiftDay(today, i - (ADHERENCE_DAYS - 1)));
  const logs = dosesBetween(core, days[0] ?? today, today).map((d) => logOf(d, tz));
  const result = computeAdherence({ days, meds: meds.flatMap(windowsOf), logs, asOf: { day: today, time: hhmmOf(now, tz) } });
  const out = new Map<string, number | null>();
  for (const m of meds) {
    const pct = result.perMed[m.id]?.adherencePct ?? null;
    out.set(m.id, pct === null ? null : Math.round(pct * 100));
  }
  return out;
}

/** Every medicine as the screen shows it: taking first by name, stopped ones last. */
export function medViews(core: LifeCore, meds: readonly StoredMedicine[]): MedicineView[] {
  const today = core.today();
  const pct = adherenceOf(core, meds);
  const order = [...meds].sort((a, b) => Number(a.stoppedOn !== undefined) - Number(b.stoppedOn !== undefined) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return order.map((m) => ({ ...publicMed(m), supply: supplyOf(m, today), adherencePct: pct.get(m.id) ?? null }));
}
