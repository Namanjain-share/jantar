/**
 * v0.11 People: every `:day` and `:night` path parameter of the People
 * routes is PeopleDaySchema, a day key that is also a date on the calendar
 * (the key's pattern lets 2026-02-30 through). Leap years by the Gregorian
 * rule.
 */
import { describe, expect, it } from 'vitest';
import { PeopleDaySchema, isCalendarDay } from '../src/people.js';

describe('a People day is a date on the calendar', () => {
  it('refuses days the pattern lets through, keeps leap days by the Gregorian rule', () => {
    for (const bad of ['2026-02-29', '2026-02-30', '2026-02-31', '2026-04-31', '2026-06-31', '2026-09-31', '2026-11-31', '2100-02-29', '1900-02-29', '2026-13-01', '2026-00-10', '2026-01-00', '26-01-01']) {
      expect(isCalendarDay(bad), bad).toBe(false);
      expect(PeopleDaySchema.safeParse(bad).success, bad).toBe(false);
    }
    for (const ok of ['2024-02-29', '2000-02-29', '2026-02-28', '2026-12-31', '2026-01-31', '2026-11-30']) {
      expect(isCalendarDay(ok), ok).toBe(true);
      expect(PeopleDaySchema.parse(ok)).toBe(ok);
    }
  });
});
