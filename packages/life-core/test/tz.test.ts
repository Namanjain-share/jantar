/**
 * Day keys and wall-clock times in a zone (LS7's life-core half): a daily
 * 01:30 in America/New_York has one instant on 2026-11-01 (clocks back), a
 * daily 02:30 on 2026-03-08 (clocks forward) lands at 03:30, Asia/Kolkata
 * never moves.
 */
import { describe, expect, it } from 'vitest';
import { dayKeyOf, daysBetween, hhmmOf, instantAt, isValidTimeZone, monthOf, shiftDay, shiftMonths, weekdayOf } from '../src/index.js';

const NY = 'America/New_York';
const IST = 'Asia/Kolkata';

/** The instants of `hhmm` on each day from `from` for `n` days. */
function dailyInstants(from: string, n: number, hhmm: string, tz: string): Date[] {
  return Array.from({ length: n }, (_, i) => instantAt(shiftDay(from, i), hhmm, tz));
}

describe('instantAt across DST (LS7)', () => {
  it('01:30 on the fall-back day is one instant: the first 01:30 (EDT)', () => {
    expect(instantAt('2026-11-01', '01:30', NY).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    const week = dailyInstants('2026-10-29', 7, '01:30', NY);
    // One instant per day, each strictly later, and exactly one on the 1st.
    expect(new Set(week.map((d) => d.toISOString())).size).toBe(7);
    for (let i = 1; i < week.length; i++) expect(week[i]!.getTime()).toBeGreaterThan(week[i - 1]!.getTime());
    expect(week.filter((d) => dayKeyOf(d, NY) === '2026-11-01')).toHaveLength(1);
    expect(week.map((d) => hhmmOf(d, NY))).toEqual(Array(7).fill('01:30'));
  });

  it('02:30 on the spring-forward day does not exist: it lands at 03:30, once', () => {
    const at = instantAt('2026-03-08', '02:30', NY);
    expect(at.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(hhmmOf(at, NY)).toBe('03:30');
    expect(dayKeyOf(at, NY)).toBe('2026-03-08');
    const week = dailyInstants('2026-03-05', 7, '02:30', NY);
    expect(week.filter((d) => dayKeyOf(d, NY) === '2026-03-08')).toHaveLength(1);
    expect(week.map((d) => hhmmOf(d, NY))).toEqual(['02:30', '02:30', '02:30', '03:30', '02:30', '02:30', '02:30']);
  });

  it('Asia/Kolkata has no DST: 08:00 is always 02:30Z', () => {
    for (const day of ['2026-03-08', '2026-11-01', '2026-06-21', '2026-12-31']) {
      const at = instantAt(day, '08:00', IST);
      expect(at.toISOString()).toBe(`${day}T02:30:00.000Z`);
      expect(dayKeyOf(at, IST)).toBe(day);
    }
  });

  it('refuses a bad day or time', () => {
    expect(() => instantAt('2026-3-8', '08:00', IST)).toThrow(RangeError);
    expect(() => instantAt('2026-03-08', '24:00', IST)).toThrow(RangeError);
  });
});

describe('day keys', () => {
  it('dayKeyOf reads the day in the zone, not in UTC', () => {
    const lateUtc = new Date('2026-10-30T20:00:00.000Z');
    expect(dayKeyOf(lateUtc, 'UTC')).toBe('2026-10-30');
    expect(dayKeyOf(lateUtc, IST)).toBe('2026-10-31');
    expect(dayKeyOf(lateUtc, NY)).toBe('2026-10-30');
  });

  it('shiftDay crosses months, years and leap days', () => {
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDay('2028-03-01', -1)).toBe('2028-02-29');
    expect(shiftDay('2026-03-08', 30)).toBe('2026-04-07');
    expect(shiftDay('2026-03-08', -7)).toBe('2026-03-01');
  });

  it('shiftMonths clamps the 29th to the 31st to the month end', () => {
    expect(shiftMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(shiftMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(shiftMonths('2026-01-30', 1)).toBe('2026-02-28');
    expect(shiftMonths('2026-01-29', 1)).toBe('2026-02-28');
    expect(shiftMonths('2026-03-31', 1)).toBe('2026-04-30');
    expect(shiftMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(shiftMonths('2026-01-31', -2)).toBe('2025-11-30');
    // A year on: 29 Feb becomes 28 Feb.
    expect(shiftMonths('2028-02-29', 12)).toBe('2029-02-28');
    // A bill keeps its date: from a clamped day back to the 31st (and the 29th of a leap year).
    expect(shiftMonths('2026-02-28', 1, 31)).toBe('2026-03-31');
    expect(shiftMonths('2026-03-31', 1, 31)).toBe('2026-04-30');
    expect(shiftMonths('2029-02-28', 12, 29)).toBe('2030-02-28');
    expect(shiftMonths('2031-02-28', 12, 29)).toBe('2032-02-29');
    expect(() => shiftMonths('2026-01-31', 1, 0)).toThrow(RangeError);
    expect(() => shiftMonths('2026-01-31', 1, 32)).toThrow(RangeError);
  });

  it('weekdayOf, monthOf, daysBetween', () => {
    expect(weekdayOf('2026-10-30')).toBe(5); // a Friday
    expect(weekdayOf('2026-11-01')).toBe(0);
    expect(monthOf('2026-10-30')).toBe('2026-10');
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30);
    expect(daysBetween('2026-10-31', '2026-10-01')).toBe(-30);
  });

  it('isValidTimeZone', () => {
    expect(isValidTimeZone(IST)).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
