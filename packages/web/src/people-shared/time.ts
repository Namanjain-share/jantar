/**
 * v0.12 People: small date helpers both sides share (her app and his
 * Partner screen). Day keys are the daemon's (`YYYY-MM-DD` in the Life
 * zone); nothing here reads the device's zone except `hmOf`, for an
 * instant the daemon sent.
 */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function utc(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

/** "Tue 3 Nov". */
export function dayLabel(day: string): string {
  const d = utc(day);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "3 Nov". */
export function shortDay(day: string): string {
  const d = utc(day);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function weekdayOf(day: string): string {
  return WEEKDAYS[utc(day).getUTCDay()] ?? '';
}

export function shiftDay(day: string, n: number): string {
  const d = utc(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "23:40" for an instant, on this device's clock. */
export function hmOf(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "7 h 05 m" (or "45 m"). */
export function minutesLabel(m: number): string {
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return h > 0 ? `${h} h ${String(r).padStart(2, '0')} m` : `${r} m`;
}

/** Faces for a 1–5 mood or quality, saddest first (never colours; real faces, not progress glyphs). */
export const FACES = ['😞', '🙁', '😐', '🙂', '😄'] as const;
export function face(n: number | undefined): string {
  return n !== undefined && n >= 1 && n <= 5 ? (FACES[n - 1] ?? '') : '';
}
