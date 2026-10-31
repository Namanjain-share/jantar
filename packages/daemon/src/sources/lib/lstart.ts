/**
 * Process start times in `ps -o lstart=` format ("Thu Jan 15 09:00:00 2026").
 *
 * Claude Code writes `procStart` into its session file in that format, in UTC.
 * We run `ps` with LC_ALL=C (English names whatever the user's locale) and
 * TZ=UTC (so both sides are UTC and no local-time or DST guessing is needed).
 */

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const LSTART_RE = /^\s*(?:[A-Za-z]{3},?\s+)?([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/;

/** Epoch ms of an lstart string read in UTC (or the daemon's local zone), or null if it doesn't parse. */
export function parseLstart(s: string | undefined, zone: 'utc' | 'local' = 'utc'): number | null {
  if (!s) return null;
  const m = LSTART_RE.exec(s);
  if (!m) return null;
  const month = MONTHS[(m[1] ?? '').toLowerCase()];
  if (month === undefined) return null;
  const [day, h, mi, sec, year] = [m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number];
  if (day < 1 || day > 31 || h > 23 || mi > 59 || sec > 60) return null;
  const ms = zone === 'utc' ? Date.UTC(year, month, day, h, mi, sec) : new Date(year, month, day, h, mi, sec).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Start times closer than this are the same process (ccw used 5 s too). */
export const SAME_START_TOLERANCE_MS = 5000;

/**
 * Whether the process `ps` reports (start `psStartUtcMs`, from `ps` run with
 * TZ=UTC) is the one that wrote a session file with `procStart`.
 *
 * - A missing or unparseable procStart cannot be checked: true (fail open, as ccw does).
 * - procStart is read as UTC; as a safety net it is also accepted when it
 *   matches as local time, so a future Claude that writes local time does
 *   not make every session disappear.
 */
export function sameProcessStart(procStart: string | undefined, psStartUtcMs: number): boolean {
  const utc = parseLstart(procStart, 'utc');
  if (utc === null) return true;
  if (Math.abs(utc - psStartUtcMs) < SAME_START_TOLERANCE_MS) return true;
  const local = parseLstart(procStart, 'local');
  return local !== null && Math.abs(local - psStartUtcMs) < SAME_START_TOLERANCE_MS;
}

export interface PsRow {
  pid: number;
  /** "ttys003"; undefined when the process has no terminal ("??"). */
  tty?: string;
  startMs: number | null;
}

/** Parse `ps -o pid=,tty=,lstart=` output. */
export function parsePsRows(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const tty = m[2] && m[2] !== '??' && m[2] !== '-' ? m[2].replace(/^\/dev\//, '') : undefined;
    const row: PsRow = { pid: Number(m[1]), startMs: parseLstart(m[3], 'utc') };
    if (tty) row.tty = tty;
    rows.push(row);
  }
  return rows;
}
