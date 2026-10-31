/**
 * A repeating todo's next day: strictly after the day given, on the weekday
 * and date of the anchor, with month ends clamped and recovered.
 */
import { describe, expect, it } from 'vitest';
import { nextRepeat, weekdayOf } from '../src/index.js';

describe('nextRepeat', () => {
  it('every day: the day after', () => {
    expect(nextRepeat({ freq: 'daily' }, '2026-10-30', '2026-10-30')).toBe('2026-10-31');
    expect(nextRepeat({ freq: 'daily' }, '2026-10-01', '2026-12-31')).toBe('2027-01-01');
  });

  it("every week with no days chosen: the anchor's weekday", () => {
    // 2026-10-28 is a Wednesday.
    expect(nextRepeat({ freq: 'weekly' }, '2026-10-28', '2026-10-28')).toBe('2026-11-04');
    expect(nextRepeat({ freq: 'weekly' }, '2026-10-28', '2026-10-30')).toBe('2026-11-04');
    expect(weekdayOf(nextRepeat({ freq: 'weekly' }, '2026-10-28', '2026-11-20'))).toBe(3);
  });

  it('every week on chosen days: the next chosen day after', () => {
    const monWedFri = { freq: 'weekly' as const, byWeekday: [1, 3, 5] };
    expect(nextRepeat(monWedFri, '2026-10-28', '2026-10-28')).toBe('2026-10-30'); // Wed -> Fri
    expect(nextRepeat(monWedFri, '2026-10-28', '2026-10-30')).toBe('2026-11-02'); // Fri -> Mon
    expect(nextRepeat({ freq: 'weekly', byWeekday: [0] }, '2026-10-28', '2026-10-31')).toBe('2026-11-01');
  });

  it('every month: the same date, the 29th to 31st clamped to short months and recovered after', () => {
    expect(nextRepeat({ freq: 'monthly' }, '2026-10-15', '2026-10-15')).toBe('2026-11-15');
    expect(nextRepeat({ freq: 'monthly' }, '2026-01-31', '2026-01-31')).toBe('2026-02-28');
    expect(nextRepeat({ freq: 'monthly' }, '2026-01-31', '2026-02-28')).toBe('2026-03-31');
    expect(nextRepeat({ freq: 'monthly' }, '2026-01-30', '2026-02-10')).toBe('2026-02-28');
    expect(nextRepeat({ freq: 'monthly' }, '2026-01-29', '2026-02-28')).toBe('2026-03-29');
    expect(nextRepeat({ freq: 'monthly' }, '2028-01-31', '2028-01-31')).toBe('2028-02-29');
  });

  it('every month on byMonthDay: Done from a clamped due day comes back to the 31st', () => {
    const on31 = { freq: 'monthly' as const, byMonthDay: 31 };
    // Done each time with the current due day as the anchor, as the daemon does.
    let due = '2026-01-31';
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      due = nextRepeat(on31, due, due);
      seen.push(due);
    }
    expect(seen).toEqual(['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
    // Without byMonthDay the clamped day becomes the anchor and the 31st is lost.
    expect(nextRepeat({ freq: 'monthly' }, '2026-02-28', '2026-02-28')).toBe('2026-03-28');
    expect(nextRepeat({ freq: 'monthly', byMonthDay: 29 }, '2028-01-29', '2028-01-29')).toBe('2028-02-29');
  });

  it('skips past days: an overdue todo done today moves after today, not after its old due day', () => {
    // Due Monday the 26th, done on Friday the 30th: the next weekly Monday after the 30th.
    expect(nextRepeat({ freq: 'weekly' }, '2026-10-26', '2026-10-30')).toBe('2026-11-02');
    expect(nextRepeat({ freq: 'monthly' }, '2026-08-31', '2026-10-30')).toBe('2026-10-31');
  });
});
