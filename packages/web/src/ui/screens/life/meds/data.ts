/**
 * What the medicine screens share (v0.4 spec 5.2, 5.4): the words for a
 * schedule, a supply and a dose; the Life clock (day keys and times are the
 * Life zone's, which LifeStatus names; the phone's own zone stands in until
 * it is known); "Took it at…" as an instant; and one write at a time with a
 * kept Idempotency-Key, so a retry of the same tap is replayed, never done
 * twice.
 */
import { useCallback, useRef, useState } from 'react';
import type { MedSchedule, MedicineView, MedsDay, MedsDayItem } from '@jantar/protocol';
import { newIdempotencyKey } from '../../../../lib/ids.js';
import { useApp } from '../../../context.js';
import { dayLabel, shiftDayKey } from '../shared/DayNav.js';

export const NO_MEDS_TODAY = 'No medicines today.';
export const NOTHING_DUE = 'No doses on this day.';
/** Under the list (spec 5.4), with the Life zone. */
export const zoneNote = (tz: string) => `Times are in ${tz}. Pings need your Mac awake; keep a phone alarm for doses you must not miss.`;

// ---------------------------------------------------------------------------
// Words

/** Monday first, as the week reads. */
export const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;
export const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
/** The one-letter buttons of "On these days". */
export const WEEKDAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;

/** "every day", "Mon, Thu", "every 3 days". */
export function scheduleText(s: MedSchedule): string {
  if (s.freq === 'interval') return `every ${s.interval ?? 2} days`;
  if (s.freq === 'weekly' && s.byWeekday && new Set(s.byWeekday).size < 7) {
    return WEEK.filter((d) => s.byWeekday?.includes(d)).map((d) => WEEKDAY[d]).join(', ');
  }
  return 'every day';
}

/** "Testamol 500 mg". */
export const medLabel = (m: { name: string; dose?: string | undefined }) => (m.dose ? `${m.name} ${m.dose}` : m.name);

/** "3 days left", "1 day left", "runs out today". */
export function daysLeftText(days: number): string {
  if (days <= 0) return 'runs out today';
  return days === 1 ? '1 day left' : `${days} days left`;
}

/**
 * The supply line's parts: the pill count, then when it runs out (low: the
 * days left, which the row shows in ember), then the 30-day adherence.
 */
export function supplyParts(m: MedicineView): { pills: string | null; runs: string | null; low: boolean; pct: string | null } {
  const pct = m.adherencePct === null ? null : `${m.adherencePct}% in 30 days`;
  if (!m.pills) return { pills: null, runs: null, low: false, pct };
  const s = m.supply;
  const low = !m.stoppedOn && !!s?.low;
  let runs: string | null = null;
  if (s && s.daysLeft !== null && !m.stoppedOn) runs = low ? daysLeftText(s.daysLeft) : s.runsOut ? `runs out ${dayLabel(s.runsOut).replace(/^\w+ /, '')}` : null;
  return { pills: `${m.pills.left} left`, runs, low, pct };
}

/** Every item of a day, in time order. */
export function dayItems(day: MedsDay): MedsDayItem[] {
  return day.groups.flatMap((g) => g.items);
}

/** Whether a pending dose's time has come on the Life clock. */
export function isDue(item: MedsDayItem, day: string, now: LifeNow): boolean {
  if (item.status !== 'pending') return false;
  if (item.overdue || day < now.day) return true;
  return day === now.day && item.slot <= now.hhmm;
}

/** "2 taken today", "1 taken, 1 skipped today". */
export function loggedText(items: readonly MedsDayItem[]): string {
  const taken = items.filter((i) => i.status === 'taken').length;
  const skipped = items.length - taken;
  const parts = [taken ? `${taken} taken` : null, skipped ? `${skipped} skipped` : null].filter(Boolean);
  return `${parts.join(', ')} today`;
}

export const PERIOD_LABEL = { morning: 'Morning', afternoon: 'Afternoon', night: 'Night' } as const;

/**
 * The day a medicine push for `slot` is about: the latest `slot` at or
 * before now on the Life clock. A push never comes before its time and a
 * catch-up is at most 6 hours late, so a 23:00 push tapped at 00:30 opens
 * last night's dose, not tonight's.
 */
export function doseDay(slot: string, now: LifeNow): string {
  return slot <= now.hhmm ? now.day : shiftDayKey(now.day, -1);
}

/**
 * `<medId>@<HHMM>` (Today's ?dose=, from a medicine push) as the medicine,
 * its HH:MM and the day it is for (`doseDay`). The key carries no day: the
 * dose sheet must be given this one, not today.
 */
export function parseDoseKey(key: string, now: LifeNow): { medId: string; slot: string; day: string } | null {
  const m = /^([0-9A-HJKMNP-TV-Z]{26})@([01]\d|2[0-3])([0-5]\d)$/.exec(key);
  if (!m) return null;
  const slot = `${m[2]}:${m[3]}`;
  return { medId: m[1] as string, slot, day: doseDay(slot, now) };
}

// ---------------------------------------------------------------------------
// The Life clock

export interface LifeNow {
  day: string;
  hhmm: string;
}

function partsIn(ms: number, tz: string | null | undefined): Intl.DateTimeFormatPart[] {
  const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...opts, ...(tz ? { timeZone: tz } : {}) }).formatToParts(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat('en-GB', opts).formatToParts(new Date(ms));
  }
}

function fieldsIn(ms: number, tz: string | null | undefined) {
  const p = partsIn(ms, tz);
  const n = (t: Intl.DateTimeFormatPartTypes) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return { y: n('year'), mo: n('month'), d: n('day'), h: n('hour'), mi: n('minute'), s: n('second') };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The day and the time of `ms` in the Life zone. */
export function lifeNow(ms: number, tz: string | null | undefined): LifeNow {
  const f = fieldsIn(ms, tz);
  return { day: `${f.y}-${pad(f.mo)}-${pad(f.d)}`, hhmm: `${pad(f.h)}:${pad(f.mi)}` };
}

/** HH:MM of an ISO instant in the Life zone. */
export function hhmmIn(iso: string, tz: string | null | undefined): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? lifeNow(t, tz).hhmm : '';
}

/** The instant of HH:MM on `day` in the Life zone (two passes over the zone's offset). */
export function instantIn(day: string, hhmm: string, tz: string | null | undefined): Date {
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (ms: number) => {
    const f = fieldsIn(ms, tz);
    return Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s) - Math.floor(ms / 1000) * 1000;
  };
  const first = wall - offset(wall);
  return new Date(wall - offset(first));
}

// ---------------------------------------------------------------------------
// Writes

/** The connection is down: the last list stays, writes are off. */
export function useOffline(): boolean {
  return useApp((s) => s.conn.status === 'offline');
}

export type WriteResult<T> = { ok: true; value: T } | { ok: false };

/**
 * One write at a time, its failure kept for NotSaved. A retry of the same
 * thing (`sig`) keeps its Idempotency-Key; a new thing, or a success, gets
 * a new one (the daemon refuses one key with two bodies).
 */
export function useMedWrite() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const kept = useRef<{ sig: string; key: string } | null>(null);
  const run = useCallback(async <T>(sig: string, fn: (key: string) => Promise<T>): Promise<WriteResult<T>> => {
    if (!kept.current || kept.current.sig !== sig) kept.current = { sig, key: newIdempotencyKey() };
    const key = kept.current.key;
    setBusy(true);
    setError(null);
    try {
      const value = await fn(key);
      kept.current = null;
      return { ok: true, value };
    } catch (e) {
      setError(e);
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }, []);
  const clear = useCallback(() => setError(null), []);
  return { busy, error, run, clear };
}
