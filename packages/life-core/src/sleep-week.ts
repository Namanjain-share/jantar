/**
 * v0.11 People: her sleep log's arithmetic (spec 3.12). Pure: instants, day
 * keys and the Life time zone in.
 *
 * - A night's key is the day of the evening it started: a bedtime from
 *   12:00 on belongs to that day, one before 12:00 to the day before.
 * - Minutes asleep and "short" (under SLEEP_SHORT_MIN, Noblot's 6 hours,
 *   `SHORT_SLEEP_HOURS` in its `packages/core/src/health-report.ts`) are
 *   derived on read, never stored. "Short" is a plain label, never an alert.
 * - The week: average time asleep, average bedtime and wake time, how much
 *   bedtime varies, and a trend arrow only against a real baseline (both
 *   weeks with at least SLEEP_TREND_MIN_NIGHTS logged nights, Noblot's
 *   `digestLine` rule); otherwise no arrow.
 * - Bars run on an 18:00–14:00 axis (minutes from 18:00 of the night's day).
 *
 * Nothing here creates an item, an alert or a score: sleep only describes.
 */
import { dayKeyOf, hhmmOf, instantAt, shiftDay, weekdayOf } from './tz.js';

/** Under this many minutes is a "short night" (Noblot's 6 h). */
export const SLEEP_SHORT_MIN = 360;
/** A night with no wake time closes this long after bedtime, with no time invented. */
export const SLEEP_OPEN_MAX_H = 20;
/** An open night holds alerts for at most this long. */
export const SLEEP_HOLD_MAX_H = 14;
/** Logged nights both weeks need before a trend arrow shows. */
export const SLEEP_TREND_MIN_NIGHTS = 4;
/** The weekly view's axis: 18:00 of the night's day to 14:00 the next day. */
export const SLEEP_AXIS_START = '18:00';
export const SLEEP_AXIS_MIN = 20 * 60;

const MIN = 60_000;

/** The night a bedtime belongs to: its day from 12:00, the day before until then. */
export function nightOf(bedAt: Date, tz: string): string {
  const day = dayKeyOf(bedAt, tz);
  return hhmmOf(bedAt, tz) >= '12:00' ? day : shiftDay(day, -1);
}

/** The Monday of the week holding `day`. */
export function mondayOf(day: string): string {
  const wd = weekdayOf(day); // 0 Sunday
  return shiftDay(day, -((wd + 6) % 7));
}

/** Whole minutes from bed to wake (null while open, or with no wake time). */
export function minutesAsleep(bedAt: Date, wakeAt: Date | null | undefined): number | null {
  if (!wakeAt) return null;
  const m = Math.round((wakeAt.getTime() - bedAt.getTime()) / MIN);
  return m >= 0 ? m : null;
}

/** Where a bedtime or wake time sits on the night's 18:00–14:00 axis, in minutes (clamped to the axis). */
export function axisMinute(night: string, at: Date, tz: string): number {
  const start = instantAt(night, SLEEP_AXIS_START, tz).getTime();
  const m = Math.round((at.getTime() - start) / MIN);
  return Math.max(0, Math.min(SLEEP_AXIS_MIN, m));
}

/** One logged night, as the week reads it. */
export interface SleepNightLike {
  night: string;
  bedAt: Date;
  /** null: open, or closed with no wake time logged. */
  wakeAt: Date | null;
  quality?: number | undefined;
}

export interface SleepWeekSummary {
  from: string;
  to: string;
  /** Nights with a bedtime and a wake time in the week. */
  logged: number;
  avgMinutes: number | null;
  avgBed: string | null;
  avgWake: string | null;
  /** Latest minus earliest bedtime on the axis, in minutes (null under two nights). */
  bedSpreadMin: number | null;
  trend: 'up' | 'down' | null;
  avgQuality: number | null;
}

function hhmmOfAxis(m: number): string {
  const total = (18 * 60 + Math.round(m)) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function complete(nights: readonly SleepNightLike[]): SleepNightLike[] {
  return nights.filter((n) => n.wakeAt !== null && minutesAsleep(n.bedAt, n.wakeAt) !== null);
}

function avg(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * The week from `monday` (seven nights) and its summary. `previous` is the
 * week before, read only for the trend.
 */
export function sleepWeek(monday: string, nights: readonly SleepNightLike[], previous: readonly SleepNightLike[], tz: string): SleepWeekSummary {
  const to = shiftDay(monday, 6);
  const inWeek = complete(nights.filter((n) => n.night >= monday && n.night <= to));
  const mins = inWeek.map((n) => minutesAsleep(n.bedAt, n.wakeAt) as number);
  const beds = inWeek.map((n) => axisMinute(n.night, n.bedAt, tz));
  const wakes = inWeek.map((n) => axisMinute(n.night, n.wakeAt as Date, tz));
  const avgMinutes = avg(mins);
  const prevFrom = shiftDay(monday, -7);
  const prevWeek = complete(previous.filter((n) => n.night >= prevFrom && n.night < monday));
  const prevAvg = avg(prevWeek.map((n) => minutesAsleep(n.bedAt, n.wakeAt) as number));
  let trend: SleepWeekSummary['trend'] = null;
  if (inWeek.length >= SLEEP_TREND_MIN_NIGHTS && prevWeek.length >= SLEEP_TREND_MIN_NIGHTS && avgMinutes !== null && prevAvg !== null) {
    const diff = Math.round(avgMinutes) - Math.round(prevAvg);
    trend = diff > 0 ? 'up' : diff < 0 ? 'down' : null;
  }
  const quality = inWeek.map((n) => n.quality).filter((q): q is number => typeof q === 'number');
  const avgBed = avg(beds);
  const avgWake = avg(wakes);
  const avgQ = avg(quality);
  return {
    from: monday,
    to,
    logged: inWeek.length,
    avgMinutes: avgMinutes === null ? null : Math.round(avgMinutes),
    avgBed: avgBed === null ? null : hhmmOfAxis(avgBed),
    avgWake: avgWake === null ? null : hhmmOfAxis(avgWake),
    bedSpreadMin: beds.length >= 2 ? Math.max(...beds) - Math.min(...beds) : null,
    trend,
    avgQuality: avgQ === null ? null : Math.round(avgQ * 10) / 10,
  };
}

/** "7 h 05 m" for minutes. */
export function hoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h} h ${String(m).padStart(2, '0')} m`;
}
