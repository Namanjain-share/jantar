/**
 * v0.6 Fleet: which tmux pane a session runs in (spec 4.2, S22).
 *
 * One `list-panes -a` on the server, then the pane is bound to the session:
 * the pane whose `#{pane_tty}` is the session's tty; only when the session
 * has no tty yet, the pane whose `#{pane_pid}` is the session's pid or one
 * of its ancestors (`/proc/<pid>/stat`, at most ANCESTRY_MAX steps up). A
 * pane id alone never names a pane: ids restart at %0 with each tmux server
 * and another server (`tmux -L other`) has its own %3. Dead panes
 * (remain-on-exit) are never bound.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DaemonContext, TerminalErrorCode } from '../../contracts.js';
import { normalizeTty } from '../tty.js';
import type { TmuxBackendOptions } from './index.js';
import { FIELD_SEP, PANE_ID_RE, PTS_RE, runTmux, tmuxFailure } from './write.js';

/** One line of `list-panes -a`. */
export interface TmuxPaneRow {
  /** "%3" */
  id: string;
  /** "/dev/pts/3" */
  tty: string;
  pid: number;
  height: number;
  dead: boolean;
}

/** `list-panes -F`: the fields TmuxPaneRow keeps, FIELD_SEP between them. */
export const LIST_FORMAT = ['#{pane_id}', '#{pane_tty}', '#{pane_pid}', '#{pane_height}', '#{pane_dead}'].join(FIELD_SEP);

/** Steps up the parent chain from a session's pid when it has no tty. */
export const ANCESTRY_MAX = 16;

/** The rows that parse; anything else (a field missing, a tty that isn't /dev/pts/N) is left out. */
export function parsePaneRows(stdout: string): TmuxPaneRow[] {
  const rows: TmuxPaneRow[] = [];
  for (const line of stdout.split('\n')) {
    const [id = '', tty = '', pid = '', height = '', dead = ''] = line.split(FIELD_SEP);
    if (!PANE_ID_RE.test(id) || !PTS_RE.test(tty) || !/^\d{1,9}$/u.test(pid) || !/^\d{1,5}$/u.test(height)) continue;
    rows.push({ id, tty, pid: Number(pid), height: Number(height), dead: dead === '1' });
  }
  return rows;
}

export type PaneList = { ok: true; rows: TmuxPaneRow[] } | { ok: false; code: TerminalErrorCode; reason: string };

/** Every pane on the server; none at all when no server is running. */
export async function listPanes(ctx: DaemonContext, opts: TmuxBackendOptions): Promise<PaneList> {
  const r = await runTmux(ctx, opts, ['list-panes', '-a', '-F', LIST_FORMAT]);
  if (r && !r.spawnError && !r.timedOut && r.code === 0) return { ok: true, rows: parsePaneRows(r.stdout) };
  const why = tmuxFailure(r);
  // No server is no pane, not a failure.
  if (why.code === 'not_found') return { ok: true, rows: [] };
  return why;
}

/** The parent pid in `/proc/<pid>/stat` (the field after the state, past the `(comm)` that may hold spaces), or null. */
export function parentFromStat(stat: string): number | null {
  const end = stat.lastIndexOf(')');
  if (end < 0) return null;
  const ppid = stat.slice(end + 2).split(' ')[1];
  return ppid && /^\d{1,9}$/u.test(ppid) ? Number(ppid) : null;
}

/** `pid` and its ancestors, nearest first, at most ANCESTRY_MAX steps up; stops at pid 1 or an unreadable stat. */
export async function ancestorsOf(pid: number, procRoot: string): Promise<number[]> {
  const chain = [pid];
  let cur = pid;
  for (let i = 0; i < ANCESTRY_MAX; i++) {
    let stat: string;
    try {
      stat = await readFile(join(procRoot, String(cur), 'stat'), 'utf8');
    } catch {
      break;
    }
    const parent = parentFromStat(stat);
    if (parent === null || parent <= 1 || chain.includes(parent)) break;
    chain.push(parent);
    cur = parent;
  }
  return chain;
}

/** The session's pane: by tty, or with no tty by pid ancestry; null when none is bound. */
export async function bindPane(
  rows: readonly TmuxPaneRow[],
  session: { tty?: string | undefined; pid?: number | undefined },
  procRoot: string,
): Promise<TmuxPaneRow | null> {
  const live = rows.filter((r) => !r.dead);
  const tty = normalizeTty(session.tty);
  if (tty) return live.find((r) => r.tty === tty) ?? null;
  const pid = session.pid;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return null;
  const chain = await ancestorsOf(pid, procRoot);
  for (const p of chain) {
    const hit = live.find((r) => r.pid === p);
    if (hit) return hit;
  }
  return null;
}
