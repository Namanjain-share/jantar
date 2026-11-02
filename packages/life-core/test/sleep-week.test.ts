// v0.12 People: her sleep log's arithmetic (spec 3.12): the night key's 12:00 boundary, minutes and "short", the
// week's averages and spread, and a trend arrow only when both weeks have four logged nights.
import { describe, expect, it } from 'vitest';
import { SLEEP_SHORT_MIN, axisMinute, hoursLabel, minutesAsleep, mondayOf, nightOf, sleepWeek, type SleepNightLike } from '../src/sleep-week.js';
import { instantAt, shiftDay } from '../src/tz.js';

const TZ = 'Asia/Kolkata';
const at = (day: string, hhmm: string) => instantAt(day, hhmm, TZ);

function night(day: string, bed: string, wakeDay: string, wake: string, quality?: number): SleepNightLike {
  return { night: day, bedAt: at(day === wakeDay && bed < '12:00' ? day : day, bed), wakeAt: at(wakeDay, wake), ...(quality ? { quality } : {}) };
}

describe('nights', () => {
  it('a bedtime from 12:00 belongs to that day, one before 12:00 to the day before', () => {
    expect(nightOf(at('2026-11-03', '23:40'), TZ)).toBe('2026-11-03');
    expect(nightOf(at('2026-11-04', '00:30'), TZ)).toBe('2026-11-03');
    expect(nightOf(at('2026-11-04', '11:59'), TZ)).toBe('2026-11-03');
    expect(nightOf(at('2026-11-04', '12:00'), TZ)).toBe('2026-11-04');
  });

  it('minutes asleep, and none while open', () => {
    expect(minutesAsleep(at('2026-11-03', '23:40'), at('2026-11-04', '06:45'))).toBe(425);
    expect(minutesAsleep(at('2026-11-03', '23:40'), null)).toBeNull();
    expect(SLEEP_SHORT_MIN).toBe(360);
    expect(hoursLabel(425)).toBe('7 h 05 m');
  });

  it('the axis runs 18:00 to 14:00 the next day', () => {
    expect(axisMinute('2026-11-03', at('2026-11-03', '18:00'), TZ)).toBe(0);
    expect(axisMinute('2026-11-03', at('2026-11-04', '00:00'), TZ)).toBe(360);
    expect(axisMinute('2026-11-03', at('2026-11-04', '14:00'), TZ)).toBe(1200);
    expect(axisMinute('2026-11-03', at('2026-11-04', '16:00'), TZ)).toBe(1200);
  });

  it("the Monday of a day's week", () => {
    expect(mondayOf('2026-11-03')).toBe('2026-11-02'); // Tuesday
    expect(mondayOf('2026-11-02')).toBe('2026-11-02');
    expect(mondayOf('2026-11-08')).toBe('2026-11-02'); // Sunday
  });
});

describe('the week', () => {
  const monday = '2026-10-26';
  const week = (bed: string, wake: string, n: number): SleepNightLike[] =>
    Array.from({ length: n }, (_, i) => {
      const d = shiftDay(monday, i);
      return night(d, bed, shiftDay(d, 1), wake, 4);
    });

  it('averages, spread and quality', () => {
    const nights = [night('2026-10-26', '23:00', '2026-10-27', '07:00'), night('2026-10-27', '23:40', '2026-10-28', '06:40', 5)];
    const w = sleepWeek(monday, nights, [], TZ);
    expect(w).toMatchObject({ from: monday, to: '2026-11-01', logged: 2, avgMinutes: 450, avgBed: '23:20', avgWake: '06:50', bedSpreadMin: 40, trend: null, avgQuality: 5 });
  });

  it('open nights and nights without a wake time count for nothing', () => {
    const w = sleepWeek(monday, [{ night: monday, bedAt: at(monday, '23:00'), wakeAt: null }], [], TZ);
    expect(w).toMatchObject({ logged: 0, avgMinutes: null, avgBed: null, bedSpreadMin: null });
  });

  it('a trend arrow only when both weeks have four nights', () => {
    const prev = Array.from({ length: 4 }, (_, i) => {
      const d = shiftDay(monday, i - 7);
      return night(d, '00:00', shiftDay(d, 1), '06:00');
    }).map((n) => ({ ...n, bedAt: at(shiftDay(n.night, 1), '00:00') }));
    expect(sleepWeek(monday, week('23:00', '07:00', 4), prev, TZ).trend).toBe('up');
    expect(sleepWeek(monday, week('23:00', '07:00', 3), prev, TZ).trend).toBeNull();
    expect(sleepWeek(monday, week('23:00', '07:00', 4), prev.slice(0, 3), TZ).trend).toBeNull();
    expect(sleepWeek(monday, week('23:00', '04:00', 4), prev, TZ).trend).toBe('down');
  });
});
