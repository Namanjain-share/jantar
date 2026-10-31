// Portions adapted from Shed (c) 2026 Sukhad Anand, MIT. See THIRD_PARTY_NOTICES.md
/**
 * Which program holds a terminal's foreground: Claude, a shell, something
 * else, or nothing (the tab is gone).
 *
 * Shed's `agentInForeground` reads `ps -t <tty> -o stat=,comm=` and looks for
 * a '+' in stat (the tty's foreground process group). We also ask for the
 * pid, so when the session's own pid is known the answer is exact: Claude is
 * in the foreground only when *its* process carries the '+'. Without a pid,
 * a foreground `claude` or `node` (npm's shim) counts as Claude.
 */
import type { PaneForeground } from '@jantar/protocol';

export interface PsRow {
  pid: number;
  stat: string;
  comm: string;
}

/** Arguments for `ps` (run with LC_ALL=C) listing one tty's processes. */
export function foregroundPsArgs(ttyName: string): string[] {
  return ['-t', ttyName, '-o', 'pid=,stat=,comm='];
}

/** Parse `ps -o pid=,stat=,comm=` output. `comm` may contain spaces (paths). */
export function parsePsRows(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), stat: m[2] as string, comm: m[3] as string });
  }
  return rows;
}

const SHELLS = new Set([
  'login',
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'tcsh',
  'csh',
  'nu',
  'tmux',
  'screen',
]);

function base(comm: string): string {
  const b = comm.split('/').pop() ?? comm;
  return b.replace(/^-/, '');
}

/** A shell (login shells show as "-zsh"). */
export function isShellComm(comm: string): boolean {
  return SHELLS.has(base(comm));
}

/** Claude Code's own binary, or the node shim an npm install runs it under. */
export function isClaudeComm(comm: string): boolean {
  const b = base(comm);
  if (b === 'claude' || b === 'node') return true;
  // The native installer keeps versioned binaries: .../claude/versions/2.1.312
  return /\/claude\/versions\/[^/]+$/.test(comm);
}

/**
 * Classify a tty's foreground from its process rows.
 * - `pid` known: 'claude' only if that pid is in the foreground group.
 * - no rows at all: 'gone'.
 */
export function classifyForeground(rows: readonly PsRow[], pid?: number): PaneForeground {
  if (rows.length === 0) return 'gone';
  const fg = rows.filter((r) => r.stat.includes('+'));
  if (pid !== undefined) {
    const own = rows.find((r) => r.pid === pid);
    if (own && own.stat.includes('+')) return 'claude';
  } else if (fg.some((r) => isClaudeComm(r.comm))) {
    return 'claude';
  }
  if (fg.some((r) => isShellComm(r.comm))) return 'shell';
  if (fg.length > 0) return 'other';
  // Nobody holds the foreground (e.g. everything stopped): only a shell left counts as a shell.
  return rows.some((r) => isShellComm(r.comm)) ? 'shell' : 'other';
}
