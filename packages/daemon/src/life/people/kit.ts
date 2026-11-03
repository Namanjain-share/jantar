/**
 * v0.11 People (P2): small helpers the plan, alert, journal and sleep
 * modules share. Nothing here reads or writes a row.
 */
import { dayKeyOf, hhmmOf, minuteOf, weekdayOf } from '@jantar/life-core';
import type { LifeCore, LifeResult } from '../../contracts.js';
import { newId } from '../../core/ids.js';

export type Refusal = Extract<LifeResult, { ok: false }>;
export const refuse = (code: Refusal['code'], reason: string): Refusal => ({ ok: false, code, reason });
export const OK: LifeResult = { ok: true, value: true };
/** The one answer for a person, area or row the caller may not see (a refusal confirms nothing). */
export const NO_PERSON = 'No such person.';
export const CLOSED = 'Life is not open right now. Try again in a moment.';

export const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;

/** A step's or check-between's id: the ten random characters of a new ulid. */
export function shortId(): string {
  return newId().slice(-10);
}

/** Now in the Life zone: the day key, `HH:MM`, minute of the day and weekday (0 Sunday). */
export function localNow(core: Pick<LifeCore, 'now' | 'tz'>): { day: string; hhmm: string; minute: number; weekday: number; ms: number } {
  const now = core.now();
  const day = dayKeyOf(now, core.tz());
  const hhmm = hhmmOf(now, core.tz());
  return { day, hhmm, minute: minuteOf(hhmm), weekday: weekdayOf(day), ms: now.getTime() };
}

/** The first `n` characters of a line, on one line (push bodies). */
export function clipLine(s: string, n = 60): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** "Tue 3 Nov" for a day key. */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][at.getUTCDay()];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return `${wd} ${d} ${mon}`;
}
