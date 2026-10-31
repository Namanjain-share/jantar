/**
 * Is the session's pid still the process Claude wrote its session file from?
 *
 * Claude records `procStart` in its session file in the format
 * `ps -o lstart=` prints ("Thu Jan 15 09:00:00 2026"), in UTC. We run
 * `ps -o lstart= -p <pid>` with LC_ALL=C (English names whatever the user's
 * locale) and TZ=UTC, so both sides are UTC and compare directly. As a guard
 * against a Claude version that writes local time instead, the recorded value
 * is also tried as local time; a reused pid matches neither.
 *
 * ISO strings and epoch numbers are accepted as well, in case the format
 * changes.
 */
import type { DaemonContext } from '../contracts.js';
import { cLocale } from '../core/exec.js';

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

const LSTART_RE = /^(?:[A-Za-z]{3}\s+)?([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/u;

/** Tolerance for comparing two start times (ps has 1 s resolution). */
export const PROC_START_TOLERANCE_MS = 1500;

/** Candidate epoch-ms values for a recorded start time (UTC reading first). */
export function procStartCandidates(value: string): number[] {
  const v = value.trim();
  if (!v) return [];
  if (/^\d{9,13}$/u.test(v)) {
    const n = Number(v);
    return [v.length <= 10 ? n * 1000 : n];
  }
  const m = LSTART_RE.exec(v);
  if (m) {
    const month = MONTHS[m[1] as string];
    if (month === undefined) return [];
    const [d, h, mi, s, y] = [m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number];
    const utc = Date.UTC(y, month, d, h, mi, s);
    const local = new Date(y, month, d, h, mi, s).getTime();
    return utc === local ? [utc] : [utc, local];
  }
  if (/^\d{4}-\d{2}-\d{2}T/u.test(v)) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? [] : [ms];
  }
  return [];
}

/** `ps -o lstart=` output (run with TZ=UTC) as epoch ms, or null. */
export function parsePsLstartUtc(out: string): number | null {
  const m = LSTART_RE.exec(out.trim());
  if (!m) return null;
  const month = MONTHS[m[1] as string];
  if (month === undefined) return null;
  const [d, h, mi, s, y] = [m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number];
  return Date.UTC(y, month, d, h, mi, s);
}

export type ProcessCheck = { ok: true } | { ok: false; reason: string };

/** pid alive and started when the session file says. */
export async function checkSessionProcess(
  ctx: DaemonContext,
  pid: number,
  procStart: string,
): Promise<ProcessCheck> {
  if (!Number.isInteger(pid) || pid <= 0 || !ctx.proc.isAlive(pid)) {
    return { ok: false, reason: "the session's process has exited" };
  }
  const recorded = procStartCandidates(procStart);
  if (recorded.length === 0) return { ok: false, reason: "the session file's process start time can't be read" };
  const r = await ctx.exec(ctx.bins.ps, ['-o', 'lstart=', '-p', String(pid)], {
    env: { ...cLocale(ctx.env), TZ: 'UTC' },
    timeoutMs: 5000,
  });
  if (r.spawnError || r.timedOut) return { ok: false, reason: "the process start time couldn't be checked" };
  const line = r.stdout.trim().split('\n')[0] ?? '';
  if (r.code !== 0 || !line) return { ok: false, reason: "the session's process has exited" };
  const actual = parsePsLstartUtc(line);
  if (actual === null) return { ok: false, reason: "the process start time couldn't be read" };
  if (!recorded.some((ms) => Math.abs(ms - actual) <= PROC_START_TOLERANCE_MS)) {
    return { ok: false, reason: "the session's pid now belongs to another process" };
  }
  return { ok: true };
}
