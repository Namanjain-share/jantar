/**
 * New Terminal windows for launches (work package L owns this file and its
 * own constant script in open-script.ts).
 *
 * One `osascript - <command>` with TERMINAL_OPEN_SCRIPT on stdin: it reads
 * the front window's id, runs `do script <command>` (a new window, never
 * `in` an existing tab), finds the new window by its tty and re-raises the
 * old front window. The reply must be exactly `ok\n/dev/ttysNNN\n<id>`, or
 * `ok\n/dev/ttysNNN\n` when the window could not be found by its tty: the
 * command is running then, and the launcher watches it by tty alone (the
 * window id comes back as ""). Anything else means Terminal did not report
 * the window.
 *
 * `command` is refused when it holds a control character (a line feed in
 * `do script` would run a second command) and is never logged.
 */
import type { OpResult } from '../../contracts.js';
import type { TerminalAppHost } from './host.js';
import { TERMINAL_OPEN_SCRIPT } from './open-script.js';

/** The open script's good answers: the tty, then the window id when it was found. */
export const OPEN_REPLY_RE = /^ok\n(\/dev\/ttys\d{3,4})\n(\d*)$/u;
/** Per open: spec 4.5.5's osascript timeout. */
export const OPEN_TIMEOUT_MS = 15_000;
/** Longer than any command the launcher builds (a deep folder path and every flag). */
export const OPEN_COMMAND_MAX = 4_096;

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;

export const NO_WINDOW_REASON = "Terminal didn't report the new window. Check Terminal on the Mac.";

export async function openWindowImpl(host: TerminalAppHost, command: string): Promise<OpResult<{ tty: string; windowId: string }>> {
  if (command.trim() === '') return { ok: false, code: 'failed', reason: 'there is nothing to run' };
  if (CONTROL_RE.test(command)) return { ok: false, code: 'unsupported', reason: 'the command contains control characters' };
  if (command.length > OPEN_COMMAND_MAX) return { ok: false, code: 'unsupported', reason: 'the command is too long' };
  const r = await host.runScript(TERMINAL_OPEN_SCRIPT, [command], { timeoutMs: OPEN_TIMEOUT_MS, label: 'open' });
  if (!r.ok) return r;
  const m = OPEN_REPLY_RE.exec(r.out);
  if (!m) {
    host.ctx.log.warn('Terminal gave an unexpected answer to open', { length: r.out.length });
    return { ok: false, code: 'failed', reason: NO_WINDOW_REASON };
  }
  return { ok: true, tty: m[1] as string, windowId: m[2] ?? '' };
}
