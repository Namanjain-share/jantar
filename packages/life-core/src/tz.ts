/**
 * Day keys and wall-clock times in the Life time zone (`life.timezone`).
 *
 * A day key is `YYYY-MM-DD`, already resolved in that zone; the arithmetic on
 * keys (`shiftDay`, `shiftMonths`, `weekdayOf`) is calendar arithmetic in UTC,
 * so a DST change can never move it. Only `dayKeyOf` and `instantAt` read a
 * zone, through @date-fns/tz.
 *
 * Wall-clock times a zone skips or repeats: `instantAt` gives one instant for
 * every (day, HH:MM). 02:30 on a spring-forward day is 03:30 (the clock jumps
 * over it); 01:30 on a fall-back day is the first 01:30. So a daily ping
 * rings exactly once on both days.
 */
import { TZDate } from '@date-fns/tz';

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parts(day: string): [number, number, number] {
  const m = DAY_KEY.exec(day);
  if (!m) throw new RangeError(`not a day key: "${day}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function keyOf(y: number, m1: number, d: number): string {
  return `${pad(y, 4)}-${pad(m1)}-${pad(d)}`;
}

/** Whether `tz` is an IANA zone this runtime knows. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The day key of `instant` as seen in `tz`. */
export function dayKeyOf(instant: Date, tz: string): string {
  const z = new TZDate(instant.getTime(), tz);
  return keyOf(z.getFullYear(), z.getMonth() + 1, z.getDate());
}

/** `HH:MM` of `instant` as seen in `tz` (seconds dropped). */
export function hhmmOf(instant: Date, tz: string): string {
  const z = new TZDate(instant.getTime(), tz);
  return `${pad(z.getHours())}:${pad(z.getMinutes())}`;
}

/** The instant of `hhmm` on `day` in `tz` (see the file comment for skipped and repeated times). */
export function instantAt(day: string, hhmm: string, tz: string): Date {
  const [y, m1, d] = parts(day);
  const t = HH_MM.exec(hhmm);
  if (!t) throw new RangeError(`not a time: "${hhmm}"`);
  const z = new TZDate(y, m1 - 1, d, Number(t[1]), Number(t[2]), 0, 0, tz);
  return new Date(z.getTime());
}

/** `day` moved by `n` whole days (negative goes back). */
export function shiftDay(day: string, n: number): string {
  const [y, m1, d] = parts(day);
  const at = new Date(Date.UTC(y, m1 - 1, d + n));
  return keyOf(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
}

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * `day` moved by `n` months, landing on `onDay` (1 to 31; default `day`'s
 * own date); a date the target month lacks becomes its last day (31 Jan + 1
 * = 28 Feb). A bill keeps its date in `onDay`, so 28 Feb + 1 on the 31st is
 * 31 Mar, not 28 Mar.
 */
export function shiftMonths(day: string, n: number, onDay?: number): string {
  const [y, m1, d] = parts(day);
  if (onDay !== undefined && !(Number.isInteger(onDay) && onDay >= 1 && onDay <= 31)) throw new RangeError(`not a day of the month: ${onDay}`);
  const total = y * 12 + (m1 - 1) + n;
  const year = Math.floor(total / 12);
  const month0 = ((total % 12) + 12) % 12;
  return keyOf(year, month0 + 1, Math.min(onDay ?? d, daysInMonth(year, month0)));
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekdayOf(day: string): number {
  const [y, m1, d] = parts(day);
  return new Date(Date.UTC(y, m1 - 1, d)).getUTCDay();
}

/** `YYYY-MM` of a day key. */
export function monthOf(day: string): string {
  parts(day);
  return day.slice(0, 7);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}
