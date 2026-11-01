/**
 * What every control shares: finding the session's pane, holding the pane's
 * writer lock without waiting forever, and the state gates (session alive,
 * no open card, no ccw move, Claude in front, the screen read). v0.4.2:
 * `dialogGate`, the same for the screen path (a waiting session is the
 * point, and a subagent's card doesn't stop it), and the screen read's raw
 * text for compare-and-type.
 *
 * Refusal reasons are fixed daemon sentences. They never quote the screen
 * (a dialog's title is screen text): a reason goes to the phone, into the
 * audit row's detail and into logs.
 */
import { localSession, localSessions } from '@jantar/protocol';
import type { Pane, Session } from '@jantar/protocol';
import type { ControlResult, DaemonContext, Factories, TimerId } from '../contracts.js';
import { DIALOG_OPEN, readScreenState, type ScreenState } from '../terminal/screen.js';
import { MOVING_STEPS, ccwCheck, openCards } from '../writer/preconditions.js';

export type ControlsDeps = Parameters<Factories['controls']>[1];

export type Refusal = Extract<ControlResult, { ok: false }>;

export function refuse(code: Refusal['code'], reason: string): Refusal {
  return { ok: false, code, reason };
}

/** How long a control waits for the pane's lock (a send holds it until its proof). */
export const LOCK_WAIT_MS = 8_000;
/** Screen lines read for the gates and the mode line. */
export const SCREEN_LINES = 60;

export const BUSY_REASON = 'a prompt is still being sent to this session; try again once it has arrived';

/** The sentence for a switch that is off (as the API's FEATURE_OFF says it). */
export const CONTROLS_OFF = 'Controls are off. Turn them on at your Mac: jantar controls on';
export const SCREENSHOTS_OFF = 'Screenshots are off. Turn them on at your Mac: jantar screenshots on';

export interface Located {
  session: Session;
  pane: Pane;
}

/** The running session and its terminal pane. */
export async function locate(ctx: DaemonContext, deps: ControlsDeps, sid: string): Promise<ControlResult<Located>> {
  const session = localSession(ctx.store.getState(), sid);
  if (!session) return refuse('not_found', 'no such session is running');
  if (session.status === 'ended') return refuse('refused', 'the session has ended');
  const pane = await deps.terminal.findPane({ ...(session.tty ? { tty: session.tty } : {}), pid: session.pid, sid });
  if (!pane) {
    const why = (deps.terminal as { lastError?: { code?: Refusal['code']; reason?: string } | null }).lastError;
    return refuse(why?.code ?? 'not_found', why?.reason ? `no terminal tab found for this session (${why.reason})` : 'no terminal tab found for this session');
  }
  return { ok: true, session, pane };
}

/**
 * Run `task` holding the pane's writer lock, or refuse once `waitMs` has
 * passed without getting it. A task that gets the lock after its caller gave
 * up does nothing (so a late key press never lands).
 */
export async function withLock<T extends object>(
  ctx: DaemonContext,
  deps: ControlsDeps,
  pane: Pane,
  task: () => Promise<ControlResult<T>>,
  waitMs = LOCK_WAIT_MS,
): Promise<ControlResult<T>> {
  let gaveUp = false;
  let timer: TimerId | undefined;
  const late = new Promise<ControlResult<T>>((resolve) => {
    timer = ctx.clock.setTimeout(() => {
      gaveUp = true;
      resolve(refuse('refused', BUSY_REASON));
    }, waitMs);
  });
  const run = deps.writer.withPaneLock(pane, async () => {
    if (gaveUp) return refuse('refused', BUSY_REASON) as ControlResult<T>;
    ctx.clock.clearTimeout(timer);
    return task();
  });
  try {
    return await Promise.race([run, late]);
  } finally {
    ctx.clock.clearTimeout(timer);
  }
}

const CARD_WORD: Record<string, string> = {
  permission: 'permission',
  question: 'question',
  plan: 'plan approval',
  'subagent-info': 'subagent',
};

/**
 * Daemon state that rules a control out: the session gone or ended, an open
 * card (answer it through the card), a ccw move. With `waiting: false` a
 * session waiting in the terminal is refused too (a dialog is up).
 */
export async function stateGate(ctx: DaemonContext, deps: ControlsDeps, sid: string, opts: { waiting: boolean }): Promise<Refusal | null> {
  const session = localSession(ctx.store.getState(), sid);
  if (!session) return refuse('not_found', 'no such session is running');
  if (session.status === 'ended') return refuse('refused', 'the session has ended');
  if (!opts.waiting && session.status === 'waiting') return refuse('dialog_open', WAITING_REASON);
  const card = openCards(ctx, deps.hooks, sid)[0];
  if (card) return refuse('refused', `a ${CARD_WORD[card.kind] ?? 'pending'} card is open for this session; answer it first`);
  if (session.move && MOVING_STEPS.has(session.move.step)) return refuse('refused', `ccw is moving this session (${session.move.step})`);
  const ccw = await ccwCheck(deps.ccwLegacy, sid);
  if (ccw.blocker) return refuse('refused', ccw.blocker);
  return null;
}

/** Claude holds the pane's foreground. */
export async function foregroundGate(deps: ControlsDeps, pane: Pane): Promise<Refusal | null> {
  const fg = await deps.terminal.foregroundOf(pane);
  if (fg === 'claude') return null;
  return refuse('refused', fg === 'gone' ? 'the terminal tab has no running program' : `Claude isn't the foreground program in its terminal tab (${fg})`);
}

/**
 * Read the bottom of the pane's screen, the tab's height in rows when the
 * backend can tell (null: it can't), and v0.4.2's `raw`, the tab's text
 * exactly as the terminal gave it (null when the backend can't give it).
 * The keypad reads as many lines as the phone was shown, when that is more.
 */
export async function readState(
  deps: ControlsDeps,
  pane: Pane,
  lines = SCREEN_LINES,
): Promise<ControlResult<{ state: ScreenState; tabRows: number | null; raw: string | null }>> {
  const r = await deps.terminal.readScreen(pane, { lines });
  if (!r.ok) return refuse(r.code === 'failed' ? 'unreadable' : r.code, `the terminal screen couldn't be read (${r.reason})`);
  return { ok: true, state: readScreenState(r.text), tabRows: r.tabRows ?? null, raw: r.raw ?? null };
}

export const SHARED_PROCESS =
  "Another session runs in this Claude process too (a /resume there?), so Jantar can't tell whose dialog the terminal shows. Answer it at the Mac.";

/**
 * v0.4.2, the dialog answers and the keypad: the session runs and has not
 * ended, no other running session shares its Claude process (a /resume
 * inside it leaves the old sid beside the new one, on the same pane: the
 * screen would be answered under the wrong session), no card is open but a
 * subagent's (a main card answers through Claude's own hook while the
 * terminal shows the same dialog: the card wins), no ccw move. A waiting
 * session is allowed: answering it is the point.
 */
export async function dialogGate(ctx: DaemonContext, deps: ControlsDeps, sid: string): Promise<Refusal | null> {
  // v0.6: the Mac's own sessions only: pids repeat across machines.
  const sessions = localSessions(ctx.store.getState());
  const session = sessions[sid];
  if (!session) return refuse('not_found', 'no such session is running');
  if (session.status === 'ended') return refuse('refused', 'the session has ended');
  if (Object.values(sessions).some((o) => o.sid !== sid && o.pid === session.pid && o.status !== 'ended')) return refuse('refused', SHARED_PROCESS);
  const card = openCards(ctx, deps.hooks, sid).find((p) => p.kind !== 'subagent-info');
  if (card) return refuse('refused', `A ${CARD_WORD[card.kind] ?? 'pending'} card is open for this session; answer the card.`);
  if (session.move && MOVING_STEPS.has(session.move.step)) return refuse('refused', `ccw is moving this session (${session.move.step})`);
  const ccw = await ccwCheck(deps.ccwLegacy, sid);
  if (ccw.blocker) return refuse('refused', ccw.blocker);
  return null;
}

export const DIALOG_REASON = DIALOG_OPEN;
export const WAITING_REASON = 'Claude is waiting in the terminal; answer it from the dialog in the app, or at the Mac';

/** The settings switch for keys, modes and commands. */
export function controlsOn(ctx: DaemonContext): Refusal | null {
  return ctx.settings.get().controls.enabled ? null : refuse('forbidden', CONTROLS_OFF);
}
