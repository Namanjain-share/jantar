/**
 * Where a todo's snooze presets move its due day and time, in the Life time zone:
 *
 *   1h        now plus one hour (minutes kept, seconds dropped)
 *   tonight   20:00 today; once 20:00 has passed, 20:00 tomorrow
 *   tomorrow  09:00 tomorrow
 *   nextWeek  09:00 on the next Monday after today
 */
import { dayKeyOf, hhmmOf, shiftDay, weekdayOf } from './tz.js';

/** = protocol `SnoozePreset`. */
export type SnoozePresetName = '1h' | 'tonight' | 'tomorrow' | 'nextWeek';

/** A due day with a time (protocol `Due` with `time` set). */
export interface SnoozeTarget {
  day: string;
  time: string;
}

export const SNOOZE_TONIGHT = '20:00';
export const SNOOZE_MORNING = '09:00';

export function snoozeTarget(preset: SnoozePresetName, now: Date, tz: string): SnoozeTarget {
  const today = dayKeyOf(now, tz);
  switch (preset) {
    case '1h': {
      const at = new Date(now.getTime() + 60 * 60_000);
      return { day: dayKeyOf(at, tz), time: hhmmOf(at, tz) };
    }
    case 'tonight':
      return hhmmOf(now, tz) < SNOOZE_TONIGHT ? { day: today, time: SNOOZE_TONIGHT } : { day: shiftDay(today, 1), time: SNOOZE_TONIGHT };
    case 'tomorrow':
      return { day: shiftDay(today, 1), time: SNOOZE_MORNING };
    case 'nextWeek': {
      // Days to the next Monday (1), never today: Monday itself goes a whole week on.
      const ahead = ((1 - weekdayOf(today) + 7) % 7) || 7;
      return { day: shiftDay(today, ahead), time: SNOOZE_MORNING };
    }
  }
}
