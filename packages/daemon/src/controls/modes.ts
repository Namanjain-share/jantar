/**
 * Permission modes (controls addendum; research controls.md 2.4).
 *
 * Reading: Claude's status line under the input box says the mode
 * ("⏸ manual mode on", "⏵⏵ accept edits on (shift+tab to cycle)", ...).
 * When no line matches, the mode is unknown (an older Claude, a narrow
 * window, a dialog over the footer): never guessed, and the switch is
 * refused. The latest hook's `permission_mode` (session.mode) is not asked:
 * a Shift+Tab at the Mac fires no hook, so it can be stale.
 *
 * Switching: never a counted burst, since whether bypassPermissions and auto
 * are in this session's cycle is unknown. A verified-step loop under the
 * pane's writer lock instead: check the gates (no dialog, an empty input
 * box: Terminal's Return after Shift+Tab would send a draft), press
 * Shift+Tab once, poll the screen every 150 ms for up to 1.5 s until the
 * status line changes, re-read, stop at the target. It gives up after 6
 * presses, when a dialog appears or the box fills (the user started
 * typing), when the line does not change, or when a mode comes round again
 * before the target (409 mode_unavailable: not in this session's cycle).
 * The mode it ends on is published as session.mode.
 *
 * Following: a Shift+Tab pressed at the Mac fires no hook, so every text
 * peek (GET /sessions/:sid/screen) reads the mode off the screen it
 * returns and publishes it as session.mode when it changed (noteScreenMode):
 * the mode chip follows. Only the mode goes out, never the screen's text.
 */
import type { PermissionModeName } from '@jantar/protocol';
import type { ControlResult, DaemonContext } from '../contracts.js';
import type { ScreenState } from '../terminal/screen.js';
import { readScreenState, unframe } from '../terminal/screen.js';
import {
  DIALOG_REASON,
  controlsOn,
  foregroundGate,
  locate,
  readState,
  refuse,
  stateGate,
  withLock,
  type ControlsDeps,
  type Refusal,
} from './common.js';
import { INPUT_NOT_EMPTY, NO_INPUT_BOX } from './keys.js';

/** A mode as the status line shows it: the switchable ones plus dontAsk (never in the cycle). */
export type ScreenMode = PermissionModeName | 'dontAsk';

export const MODE_LINE = /^\s*(?:⏸|⏵⏵)\s+(manual mode|plan mode|accept edits|auto mode|don['’]t ask|bypass permissions) on\b/u;

const INDICATOR: Readonly<Record<string, ScreenMode>> = {
  'manual mode': 'default',
  'plan mode': 'plan',
  'accept edits': 'acceptEdits',
  'auto mode': 'auto',
  "don't ask": 'dontAsk',
  'bypass permissions': 'bypassPermissions',
};

/** The mode in words, as Claude's status line says it. */
export const MODE_WORDS: Readonly<Record<ScreenMode, string>> = {
  default: 'manual mode',
  plan: 'plan mode',
  acceptEdits: 'accept edits',
  auto: 'auto mode',
  dontAsk: "don't ask",
  bypassPermissions: 'bypass permissions',
};

export const MAX_MODE_STEPS = 6;
export const STEP_POLL_MS = 150;
export const STEP_WAIT_MS = 1_500;
/** How far up from the bottom the mode line is looked for when the input box is not found. */
const NO_BOX_REACH = 12;

/** The mode on Claude's status line (under the input box), or null when it is not on screen. */
export function parseMode(state: Pick<ScreenState, 'lines' | 'inputBox'>): ScreenMode | null {
  const lines = state.lines;
  const from = state.inputBox ? state.inputBox.end + 1 : Math.max(0, lines.length - NO_BOX_REACH);
  for (let i = from; i < lines.length; i++) {
    const m = MODE_LINE.exec(unframe(lines[i] ?? ''));
    if (m) return INDICATOR[(m[1] as string).replace('’', "'")] ?? null;
  }
  return null;
}

/** Why another Shift+Tab may not be pressed on this screen, or null. */
function stepGate(state: ScreenState, requireBox: boolean): Refusal | null {
  if (state.dialog) return refuse('dialog_open', DIALOG_REASON);
  if (!state.inputBox) return requireBox ? refuse('refused', NO_INPUT_BOX) : null;
  if (state.inputBox.text !== '') return refuse('input_not_empty', INPUT_NOT_EMPTY);
  return null;
}

/** Tell every client the mode the screen showed last (the next hook would, later). */
function publishMode(ctx: DaemonContext, sid: string, mode: ScreenMode | null): void {
  if (!mode) return;
  const sessions = ctx.store.getState().sessions;
  const s = Object.hasOwn(sessions, sid) ? sessions[sid] : undefined;
  if (!s || s.mode === mode) return;
  ctx.store.emit({ type: 'session.updated', sid, data: { patch: { mode } } });
}

/** The mode a text peek of this session's screen shows, published as session.mode when it changed. Never throws. */
export function noteScreenMode(ctx: DaemonContext, sid: string, text: string): void {
  try {
    publishMode(ctx, sid, parseMode(readScreenState(text)));
  } catch (e) {
    ctx.log.warn('could not publish the mode read off the screen', { sid, error: String(e) });
  }
}

export async function switchMode(
  ctx: DaemonContext,
  deps: ControlsDeps,
  sid: string,
  target: PermissionModeName,
): Promise<ControlResult<{ mode: PermissionModeName; steps: number }>> {
  const off = controlsOn(ctx);
  if (off) return off;
  const pressKey = deps.terminal.pressKey?.bind(deps.terminal);
  if (!pressKey) return refuse('unsupported', 'this terminal cannot press keys');
  const early = await stateGate(ctx, deps, sid, { waiting: false });
  if (early) return early;
  const found = await locate(ctx, deps, sid);
  if (!found.ok) return found;
  const { pane } = found;

  return withLock(ctx, deps, pane, async () => {
    const state = await stateGate(ctx, deps, sid, { waiting: false });
    if (state) return state;
    const fg = await foregroundGate(deps, pane);
    if (fg) return fg;
    const first = await readState(deps, pane);
    if (!first.ok) return first;
    const blocked = stepGate(first.state, true);
    if (blocked) return blocked;

    let current = parseMode(first.state);
    if (current === null) return refuse('refused', "the mode isn't shown under Claude's input box (the window may be too narrow); switch it at the Mac");
    const seen = new Set<ScreenMode>([current]);
    let steps = 0;
    try {
      while (current !== target) {
        if (steps >= MAX_MODE_STEPS) {
          return refuse('mode_unavailable', `${MODE_WORDS[target]} was not reached in ${MAX_MODE_STEPS} steps (it is now ${MODE_WORDS[current]})`);
        }
        const r = await pressKey(pane, 'shiftTab');
        steps += 1;
        if (!r.ok) return r;
        let next: ScreenMode | null = null;
        let last: ScreenState | null = null;
        for (let waited = 0; waited < STEP_WAIT_MS && next === null; waited += STEP_POLL_MS) {
          await ctx.clock.sleep(STEP_POLL_MS);
          const s = await readState(deps, pane);
          if (!s.ok) return s;
          const stop = stepGate(s.state, false);
          if (stop) return stop;
          const m = parseMode(s.state);
          if (m !== null && m !== current) {
            next = m;
            last = s.state;
          }
        }
        if (next === null || last === null) {
          return refuse('refused', `the mode did not change after Shift+Tab (still ${MODE_WORDS[current]})`);
        }
        current = next;
        if (current === target) break;
        if (seen.has(current)) {
          return refuse('mode_unavailable', `${MODE_WORDS[target]} is not in this session's cycle (it is now ${MODE_WORDS[current]})`);
        }
        seen.add(current);
        // The next press needs the same screen the gates wanted at the start.
        const again = stepGate(last, true);
        if (again) return again;
      }
      return { ok: true, mode: target, steps };
    } finally {
      publishMode(ctx, sid, current);
    }
  });
}
