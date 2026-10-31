/**
 * Clock and duration text for the Accounts and Alerts screens. 24-hour,
 * locale-free and pure (the current time is passed in), as in dir-k.html:
 * "16:30", "Sat 19:00", "in 2h22", "1h54".
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const pad = (n: number) => String(n).padStart(2, '0');

/** "16:30" (local time). */
export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** "16:30" today, "Sat 19:00" on another day. */
export function dayClock(ms: number, now: number): string {
  return sameDay(ms, now) ? hhmm(ms) : `${DAYS[new Date(ms).getDay()]} ${hhmm(ms)}`;
}

/** "12m", "2h02", "<1m"; days as "3d 4h". */
export function dur(ms: number): string {
  if (!Number.isFinite(ms) || ms < MIN) return '<1m';
  const m = Math.floor(ms / MIN);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${pad(m % 60)}`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Local midnight of the day `ms` falls on. */
export function dayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Day rail words: "Today", "Yesterday", then "Mon 26 Oct". */
export function dayLabel(ms: number, now: number): string {
  const days = Math.round((dayStart(now) - dayStart(ms)) / (24 * HOUR));
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** The first whole hour after `now`, in ms. */
export function nextHour(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
}

/** One query parameter of the page URL (empty in tests and outside a browser). */
export function searchParam(path: string, name: string): string | null {
  try {
    if (typeof window === 'undefined' || window.location.pathname !== path) return null;
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}
