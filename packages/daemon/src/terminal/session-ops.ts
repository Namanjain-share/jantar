/**
 * Session-level terminal operations for the API (GET /v1/sessions/:sid/screen,
 * POST /v1/sessions/:sid/focus): find the session's pane, then read or focus
 * it. Neither ever types.
 */
import { localSession } from '@jantar/protocol';
import type { DaemonContext, OpResult, TerminalBackend, TerminalErrorCode } from '../contracts.js';
import { screenLines } from './screen.js';

export type SessionOpResult<T extends object> =
  | ({ ok: true } & T)
  | { ok: false; code: TerminalErrorCode | 'no_session'; reason: string };

async function paneFor(ctx: DaemonContext, terminal: TerminalBackend, sid: string) {
  const s = localSession(ctx.store.getState(), sid);
  if (!s) return { ok: false as const, code: 'no_session' as const, reason: 'no such session is running' };
  const pane = await terminal.findPane({ ...(s.tty ? { tty: s.tty } : {}), pid: s.pid, sid });
  if (!pane) {
    const why = (terminal as { lastError?: { code?: TerminalErrorCode; reason?: string } | null }).lastError;
    return { ok: false as const, code: why?.code ?? ('not_found' as const), reason: why?.reason ?? 'no terminal tab found for this session' };
  }
  return { ok: true as const, pane };
}

/** The last `lines` lines of the session's tab, shaped like ScreenResponse. */
export async function readSessionScreen(
  ctx: DaemonContext,
  terminal: TerminalBackend,
  sid: string,
  lines = 80,
): Promise<SessionOpResult<{ text: string; lines: number; at: string; backend: string }>> {
  const found = await paneFor(ctx, terminal, sid);
  if (!found.ok) return found;
  const r = await terminal.readScreen(found.pane, { lines });
  if (!r.ok) return r;
  return { ok: true, text: r.text, lines: r.text ? screenLines(r.text).length : 0, at: r.at, backend: terminal.kind };
}

/** Bring the session's tab to the front. */
export async function focusSession(ctx: DaemonContext, terminal: TerminalBackend, sid: string): Promise<SessionOpResult<object>> {
  const found = await paneFor(ctx, terminal, sid);
  if (!found.ok) return found;
  const r: OpResult = await terminal.focus(found.pane);
  return r.ok ? { ok: true } : r;
}
