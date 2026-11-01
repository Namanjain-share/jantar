/**
 * A repeating todo's next day.
 *
 * A repeat is protocol's `RepeatSchema`: every day, every week on chosen
 * weekdays (none chosen = the due day's weekday), every month on its
 * `byMonthDay` (none = the due day's date), or (v0.5.3) every year on the
 * due day's month and its `byMonthDay`. It is a strict subset of
 * Noblot's recurrence rule, so the day walk is `computeNextRunAt`'s, run in
 * UTC over day keys (no zone can move a calendar day). Month ends clamp and
 * recover: a todo on the 31st repeats on 28 Feb, then on 31 Mar, as long as
 * the 31st is kept in `byMonthDay` (the daemon sets it from the first due
 * day; the due day itself is the 28th by then). A yearly 29 Feb falls on
 * 28 Feb in other years and comes back to the 29th in a leap year. The
 * repeat's `at` (the series' time of day) is the daemon's: ignored here.
 */
import type { RecurrenceRule } from './recurrence-rule.js';
import { computeNextRunAt } from './recurrence.js';
import { dayKeyOf, shiftDay, weekdayOf } from './tz.js';

/** = protocol `Repeat`. */
export interface RepeatLike {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  /** Weekly only: 0 = Sunday ... 6 = Saturday. Absent = the anchor day's weekday. */
  byWeekday?: readonly number[];
  /** Monthly or yearly only: the date, 1 to 31. Absent = the anchor day's date. */
  byMonthDay?: number;
}

/** The rule `computeNextRunAt` walks for a repeat anchored on `anchorDay` (its weekday, its month, and its date unless `byMonthDay` names one). */
export function repeatRule(repeat: RepeatLike, anchorDay: string): RecurrenceRule {
  switch (repeat.freq) {
    case 'daily':
      return { freq: 'daily', interval: 1 };
    case 'weekly':
      return {
        freq: 'weekly',
        interval: 1,
        byWeekday: repeat.byWeekday && repeat.byWeekday.length > 0 ? [...repeat.byWeekday] : [weekdayOf(anchorDay)],
      };
    case 'monthly':
      return { freq: 'monthly', interval: 1, byMonthDay: repeat.byMonthDay ?? Number(anchorDay.slice(8, 10)) };
    case 'yearly':
      return { freq: 'yearly', interval: 1, byMonth: Number(anchorDay.slice(5, 7)), byMonthDay: repeat.byMonthDay ?? Number(anchorDay.slice(8, 10)) };
  }
}

/**
 * The first day strictly after `afterDay` that `repeat` allows, counted from
 * `anchorDay` (which gives the weekday, and the day of the month when
 * `repeat.byMonthDay` is absent). Done on a repeating todo moves its due day
 * to `nextRepeat(repeat, due.day, max(due.day, today))`.
 */
export function nextRepeat(repeat: RepeatLike, anchorDay: string, afterDay: string): string {
  // Noon UTC of `afterDay`: the walk keeps that time of day, so every step lands on a whole day.
  const from = new Date(`${afterDay}T12:00:00.000Z`);
  if (Number.isNaN(from.getTime())) throw new RangeError(`not a day key: "${afterDay}"`);
  const next = computeNextRunAt(repeatRule(repeat, anchorDay), from, 'UTC');
  // Every rule here always has a next day; the fallback only guards the type.
  return next ? dayKeyOf(next, 'UTC') : shiftDay(afterDay, 1);
}
