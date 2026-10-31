/**
 * @jantar/life-core: the pure logic of the Life modules. No I/O, no clock of
 * its own, no zod: callers pass day keys, instants and the Life time zone.
 *
 * - Copied from Noblot with their tests (docs/PROVENANCE.md): adherence.ts
 *   (which days and times a dose is due, the day checklist, adherence),
 *   meds.ts (pill supply), recurrence.ts (`computeNextRunAt`, `isRuleDay`).
 * - Ours: tz.ts (day keys and wall-clock times in a zone), repeat.ts (a
 *   repeating todo's next day), slots.ts (a dose time's next ping),
 *   snooze.ts (the snooze presets).
 */
export {
  DOSE_GRACE_MINUTES,
  buildDayChecklist,
  computeAdherence,
  isLateDose,
  isScheduledOn,
  scheduleForDay,
  scheduledTimesOn,
  slotPeriod,
  type AdherenceResult,
  type ChecklistGroup,
  type ChecklistItem,
  type DoseLogEntry,
  type MedScheduleLike,
  type MedWindow,
} from './adherence.js';
export { DEFAULT_REFILL_THRESHOLD_DAYS, consumeDose, dosesPerDayForSchedule, projectSupply, type SupplyProjection } from './meds.js';
export { computeNextRunAt, isRuleDay } from './recurrence.js';
export type { RecurrenceRule } from './recurrence-rule.js';
export { dayKeyOf, daysBetween, hhmmOf, instantAt, isValidTimeZone, monthOf, shiftDay, shiftMonths, weekdayOf } from './tz.js';
export { nextRepeat, repeatRule, type RepeatLike } from './repeat.js';
export { nextMedSlot, type MedSlotSource } from './slots.js';
export { SNOOZE_MORNING, SNOOZE_TONIGHT, snoozeTarget, type SnoozePresetName, type SnoozeTarget } from './snooze.js';
