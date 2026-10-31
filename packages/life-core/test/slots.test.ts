/**
 * nextMedSlot: the next due instant of one dose time, over every day, chosen
 * weekdays, every N days, a start in the future, a stop and a schedule edit.
 */
import { describe, expect, it } from 'vitest';
import { instantAt, nextMedSlot, type MedSlotSource } from '../src/index.js';

const IST = 'Asia/Kolkata';
const at = (day: string, hhmm: string) => instantAt(day, hhmm, IST);
const iso = (d: Date | null) => d?.toISOString() ?? null;

describe('nextMedSlot', () => {
  const daily: MedSlotSource = { schedule: { freq: 'daily', startDay: '2026-10-01' }, startedOn: '2026-10-01' };

  it('every day: later today when the time is still ahead, else tomorrow', () => {
    expect(iso(nextMedSlot(daily, '08:00', at('2026-10-30', '07:00'), IST))).toBe(iso(at('2026-10-30', '08:00')));
    expect(iso(nextMedSlot(daily, '08:00', at('2026-10-30', '08:00'), IST))).toBe(iso(at('2026-10-31', '08:00')));
    expect(iso(nextMedSlot(daily, '21:00', at('2026-10-30', '09:00'), IST))).toBe(iso(at('2026-10-30', '21:00')));
  });

  it('chosen weekdays: the next one of them', () => {
    // Mondays and Thursdays; 2026-10-30 is a Friday.
    const med: MedSlotSource = { schedule: { freq: 'weekly', byWeekday: [1, 4], startDay: '2026-10-01' } };
    expect(iso(nextMedSlot(med, '08:00', at('2026-10-30', '07:00'), IST))).toBe(iso(at('2026-11-02', '08:00')));
    expect(iso(nextMedSlot(med, '08:00', at('2026-11-02', '09:00'), IST))).toBe(iso(at('2026-11-05', '08:00')));
  });

  it('every N days, phased from the start day', () => {
    const med: MedSlotSource = { schedule: { freq: 'interval', interval: 3, startDay: '2026-10-01' } };
    // Due on the 1st, 4th, ... 28th, 31st.
    expect(iso(nextMedSlot(med, '08:00', at('2026-10-29', '07:00'), IST))).toBe(iso(at('2026-10-31', '08:00')));
    expect(iso(nextMedSlot(med, '08:00', at('2026-10-28', '07:00'), IST))).toBe(iso(at('2026-10-28', '08:00')));
  });

  it('a start in the future: nothing before it', () => {
    const med: MedSlotSource = { schedule: { freq: 'daily', startDay: '2026-11-10' }, startedOn: '2026-11-10' };
    expect(iso(nextMedSlot(med, '08:00', at('2026-10-30', '09:00'), IST))).toBe(iso(at('2026-11-10', '08:00')));
  });

  it('a stop: nothing after it', () => {
    const med: MedSlotSource = { ...daily, stoppedOn: '2026-10-30' };
    expect(iso(nextMedSlot(med, '21:00', at('2026-10-30', '09:00'), IST))).toBe(iso(at('2026-10-30', '21:00')));
    expect(nextMedSlot(med, '08:00', at('2026-10-30', '09:00'), IST)).toBeNull();
  });

  it('a schedule edit applies from its own day only (history)', () => {
    // Daily until the 31st; from 1 Nov only on Sundays (2026-11-01 and 2026-11-08 are Sundays).
    const med: MedSlotSource = {
      schedule: { freq: 'weekly', byWeekday: [0], startDay: '2026-10-01' },
      history: [
        { from: '2026-10-01', schedule: { freq: 'daily', startDay: '2026-10-01' } },
        { from: '2026-11-01', schedule: { freq: 'weekly', byWeekday: [0], startDay: '2026-10-01' } },
      ],
      startedOn: '2026-10-01',
    };
    expect(iso(nextMedSlot(med, '08:00', at('2026-10-30', '09:00'), IST))).toBe(iso(at('2026-10-31', '08:00')));
    expect(iso(nextMedSlot(med, '08:00', at('2026-10-31', '09:00'), IST))).toBe(iso(at('2026-11-01', '08:00')));
    expect(iso(nextMedSlot(med, '08:00', at('2026-11-01', '09:00'), IST))).toBe(iso(at('2026-11-08', '08:00')));
  });
});
