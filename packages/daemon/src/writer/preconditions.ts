/**
 * Preconditions for typing into a session (send-with-proof, step 1 in send.ts).
 * Each check returns a short, user-facing reason to refuse, or null.
 *
 * - The pid is alive and its procStart matches (proc-start.ts).
 * - Claude is the foreground program of its pane.
 * - The session is not waiting and has no open card (hook cards included).
 * - The screen is readable and shows no dialog; an unreadable screen or a
 *   screen without Claude's input box means refuse, never type blind.
 * - While the legacy ccw tool runs: no ccw move for this sid is saving,
 *   restarting or continuing, and ccw does not hold its move lock. A parked
 *   session only gets a note (the prompt un-parks it).
 */
import type { Move, PendingRequest, Session } from '@jantar/protocol';
import type { CcwLegacySource, DaemonContext, HooksBridge, TerminalBackend } from '../contracts.js';
import type { Pane } from '@jantar/protocol';
import { readScreenState, screenBlocker, type ScreenState } from '../terminal/screen.js';

/** ccw move steps during which nothing may type into the session. */
export const MOVING_STEPS: ReadonlySet<Move['step']> = new Set(['saving', 'restarting', 'continuing']);

const CARD_WORD: Record<PendingRequest['kind'], string> = {
  permission: 'permission',
  question: 'question',
  plan: 'plan approval',
  'subagent-info': 'subagent',
};

export function lookupSession(ctx: DaemonContext, sid: string): Session | null {
  // An own key only: "constructor" or "__proto__" from a URL is no session.
  const sessions = ctx.store.getState().sessions;
  return Object.hasOwn(sessions, sid) ? (sessions[sid] ?? null) : null;
}

/** Open cards for a session, from the store and from the hooks bridge. */
export function openCards(ctx: DaemonContext, hooks: HooksBridge, sid: string): PendingRequest[] {
  const byId = new Map<string, PendingRequest>();
  for (const p of Object.values(ctx.store.getState().pending)) if (p.sid === sid && p.state === 'open') byId.set(p.id, p);
  let fromHooks: PendingRequest[] = [];
  try {
    fromHooks = hooks.open();
  } catch {
    fromHooks = [];
  }
  for (const p of fromHooks) if (p.sid === sid && p.state === 'open') byId.set(p.id, p);
  return [...byId.values()];
}

/** Checks that need only daemon state: ended, waiting, an open card, a move recorded on the session. */
export function stateBlocker(ctx: DaemonContext, hooks: HooksBridge, session: Session): string | null {
  if (session.status === 'ended') return 'the session has ended';
  if (session.status === 'waiting') {
    return `the session is waiting for an answer${session.waitingFor ? ` (${session.waitingFor})` : ''}`;
  }
  const cards = openCards(ctx, hooks, session.sid);
  const card = cards[0];
  if (card) return `a ${CARD_WORD[card.kind]} card is open for this session; answer it first`;
  if (session.move && MOVING_STEPS.has(session.move.step)) return `ccw is moving this session (${session.move.step})`;
  return null;
}

export interface CcwCheck {
  blocker: string | null;
  note?: string;
}

/** The legacy ccw tool's move state for this session (read-only). */
export async function ccwCheck(ccw: CcwLegacySource, sid: string): Promise<CcwCheck> {
  try {
    if (!ccw.present()) return { blocker: null };
    const move = await ccw.moveFor(sid);
    if (move && MOVING_STEPS.has(move.step)) return { blocker: `ccw is moving this session (${move.step})` };
    if (await ccw.moveLocked(sid)) return { blocker: "ccw holds this session's move lock (a move is in progress)" };
    if (move?.step === 'parked') return { blocker: null, note: 'ccw had parked this session; this prompt un-parks it' };
    return { blocker: null };
  } catch {
    return { blocker: "ccw's move state for this session couldn't be checked" };
  }
}

export type PaneCheck = { ok: true; screen: ScreenState } | { ok: false; reason: string };

/** Claude in the foreground, and a readable screen with its input box and no dialog. */
export async function paneCheck(
  terminal: TerminalBackend,
  pane: Pane,
  opts: { screenLines: number; requireInputBox: boolean },
): Promise<PaneCheck> {
  const fg = await terminal.foregroundOf(pane);
  if (fg !== 'claude') {
    return {
      ok: false,
      reason: fg === 'gone' ? 'the terminal tab has no running program' : `Claude isn't the foreground program in its terminal tab (${fg})`,
    };
  }
  const screen = await terminal.readScreen(pane, { lines: opts.screenLines });
  if (!screen.ok) return { ok: false, reason: `the terminal screen couldn't be read (${screen.reason})` };
  const state = readScreenState(screen.text);
  const blocker = screenBlocker(state, { requireInputBox: opts.requireInputBox });
  if (blocker) return { ok: false, reason: blocker };
  return { ok: true, screen: state };
}
