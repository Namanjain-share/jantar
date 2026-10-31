/**
 * When a medicine's dose time next comes round.
 *
 * Which days a dose is due on comes from the copied adherence code
 * (`scheduleForDay` picks the schedule in force on a day from the medicine's
 * history, `isScheduledOn` says whether that schedule covers it), so the
 * pings, the day checklist and adherence agree on what "due" means.
 */
import { isScheduledOn, scheduleForDay, type MedScheduleLike } from './adherence.js';
import { dayKeyOf, instantAt, shiftDay } from './tz.js';

/** What `nextMedSlot` reads of a medicine (protocol `Medicine` fits). */
export interface MedSlotSource {
  schedule: MedScheduleLike;
  /** The schedule in force from each day, ascending by `from`. Absent or empty: `schedule` every day. */
  history?: readonly { from: string; schedule: MedScheduleLike }[];
  /** Nothing is due before this day. */
  startedOn?: string;
  /** Nothing is due after this day. */
  stoppedOn?: string;
}

/**
 * Enough days to find the next due day of any schedule a medicine can have
 * (every 60 days at most, or one weekday a week), with room for a start
 * that lies in the future.
 */
const SCAN_DAYS = 2 * 366;

/**
 * The first instant strictly after `after` at which `hhmm` is due for `med`
 * in `tz`: on a day the schedule in force covers, not before the start, not
 * after a stop. Null when there is none (stopped, or nothing in the scan).
 */
export function nextMedSlot(med: MedSlotSource, hhmm: string, after: Date, tz: string): Date | null {
  let day = dayKeyOf(after, tz);
  if (med.startedOn && day < med.startedOn) day = med.startedOn;
  const window = { schedule: med.schedule, scheduleHistory: med.history ?? [] };
  for (let i = 0; i < SCAN_DAYS; i++, day = shiftDay(day, 1)) {
    if (med.stoppedOn && day > med.stoppedOn) return null;
    if (!isScheduledOn(scheduleForDay(window, day), day)) continue;
    const at = instantAt(day, hhmm, tz);
    if (at.getTime() > after.getTime()) return at;
  }
  return null;
}
