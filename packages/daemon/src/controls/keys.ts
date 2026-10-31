/**
 * Control keys from the phone (controls addendum; research controls.md 2.3).
 *
 * Gates, all checked again under the pane's writer lock right before the
 * key is typed (the backend's pressKey is a whitelist, not a gate):
 * - controls are on; the session runs and Claude holds its pane's foreground;
 * - no open card for the session (answer the card instead), no ccw move;
 * - no dialog on screen. On a permission prompt Shift+Tab means "allow for
 *   the session" and Esc means "No"; a waiting session counts as a dialog;
 * - shiftTab: Claude's input box shows and is empty, since the Return that
 *   Terminal appends to every write would send a draft;
 * - clearInput: refused while settings.controls.clearVerified is off. Its
 *   bytes are cut to the rows read here, under the lock (terminal-app/
 *   keys.ts): End once per row, then two Ctrl+U per row, both padded. One
 *   Ctrl+U clears one row only, and on a draft of several rows the appended
 *   Return then sent the rest (spike, docs/real-mac-checks.md). So it is
 *   refused whenever the rows read could be fewer than the draft's, or End
 *   and Ctrl+U might not clear them: no box on screen, or not its bottom
 *   edge (blank rows at the bottom would not be counted); vim mode out of
 *   INSERT (Claude 2.1.314's NORMAL mode drops End, its Ctrl+U keeps the
 *   cursor's character, and the Return submits there); more than
 *   CLEAR_MAX_ROWS rows; and a box as tall as Claude's full-screen display
 *   shows in this tab (boxRowsShownAtMost: it shows only the rows around the
 *   cursor, with no sign of the rest), or a tab whose height can't be read;
 * - interrupt and escape: no draft in the input box. Whether Ctrl+C (or Esc)
 *   mid-run clears a draft or keeps it is unverified (spike S1): cleared,
 *   the run goes on and "Interrupt sent" is false; kept, Terminal's Return
 *   sends it;
 * - Ctrl+C (interrupt): never two to one pane within 3 s, since a second
 *   Ctrl+C quits Claude;
 * - escape: refused while settings.controls.escapeVerified is off (on by
 *   default since the spike showed Escape interrupts a turn and leaves an
 *   idle draft alone). Interrupt sends settings.controls.interruptKey
 *   (Ctrl+C by default).
 *
 * Never pressed from here: up, down and enter (each one's Return is a menu
 * selection, and nothing checks the option it lands on; the launcher answers
 * its trust dialog through the backend's pressKey itself), and quit (it ends
 * the session, and the phone has no confirm for it).
 *
 * The API audits each press as { sid, key, sent }, never screen text.
 */
import type { ControlKey } from '@jantar/protocol';
import type { ControlResult, DaemonContext, PressKeyOptions } from '../contracts.js';
import { boxRowsShownAtMost, vimModeBelow, type ScreenState } from '../terminal/screen.js';
import { CLEAR_MAX_ROWS } from '../terminal/terminal-app/keys.js';
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

/** Menu keys: refused here (see above). */
export const MENU_KEYS: ReadonlySet<ControlKey> = new Set(['up', 'down', 'enter']);
/** Keys that type Ctrl+C. */
export const CTRL_C_KEYS: ReadonlySet<ControlKey> = new Set(['interrupt', 'quit']);
/** Two Ctrl+C to one pane closer than this would quit Claude. */
export const CTRL_C_SPACING_MS = 3_000;

export const ESCAPE_UNVERIFIED = 'Escape is off on this Mac. Turn it on at your Mac: jantar controls escape on';
export const CLEAR_UNVERIFIED = 'Clear draft is off on this Mac; clear the draft there, or turn it on: jantar controls clear-draft on';
export const INPUT_NOT_EMPTY = "Claude's input box holds a draft (the key's Return would send it); clear it first";
export const NO_INPUT_BOX = "Claude's input box isn't on screen";
export const DRAFT_TOO_TALL = `the draft is taller than ${CLEAR_MAX_ROWS} rows; clear it at the Mac`;
export const BOX_CUT_OFF = "the bottom of Claude's input box isn't on screen; clear the draft at the Mac";
export const VIM_NOT_INSERT = "Claude's input is in vim NORMAL or VISUAL mode, where the Return would send part of the draft; clear it at the Mac";
export const DRAFT_MAY_BE_HIDDEN = 'the draft fills as many rows as Claude may show in this window, so some may be hidden; clear it at the Mac';
export const NO_TAB_ROWS = "the Terminal tab's height couldn't be read, so Claude may be hiding rows of the draft; clear it at the Mac";
export const MENU_REFUSED = "answer menus with the dialog's buttons or the keypad in the app";
export const QUIT_REFUSED = 'quit Claude at the Mac (the phone has no confirm for it)';

/** What a press of `key` types: Interrupt follows settings.controls.interruptKey. */
export function keySent(ctx: DaemonContext, key: ControlKey): ControlKey {
  return key === 'interrupt' ? ctx.settings.get().controls.interruptKey : key;
}

/**
 * Why a key may not be pressed on this screen, or null. `key` is the one
 * typed (see keySent); `tabRows` is the tab's height (null: unknown).
 */
export function screenGate(key: ControlKey, state: Pick<ScreenState, 'dialog' | 'inputBox' | 'lines'>, tabRows: number | null): Refusal | null {
  if (MENU_KEYS.has(key)) return refuse('refused', MENU_REFUSED);
  if (state.dialog) return refuse('dialog_open', DIALOG_REASON);
  if (key === 'shiftTab') {
    if (!state.inputBox) return refuse('refused', NO_INPUT_BOX);
    if (state.inputBox.text !== '') return refuse('input_not_empty', INPUT_NOT_EMPTY);
  }
  if ((key === 'interrupt' || key === 'escape') && state.inputBox && state.inputBox.text !== '') {
    return refuse('input_not_empty', INPUT_NOT_EMPTY);
  }
  if (key === 'clearInput') {
    // With no box the Return would land on an unknown screen, and the rows to
    // clear are unknown. The cursor can't be seen here: the Ends find the end.
    const box = state.inputBox;
    if (!box) return refuse('refused', NO_INPUT_BOX);
    if (!box.closed) return refuse('refused', BOX_CUT_OFF);
    const vim = vimModeBelow(state.lines, box);
    if (vim !== null && vim !== 'INSERT') return refuse('refused', VIM_NOT_INSERT);
    if (box.rows > CLEAR_MAX_ROWS) return refuse('refused', DRAFT_TOO_TALL);
    if (tabRows === null) return refuse('refused', NO_TAB_ROWS);
    if (box.rows >= boxRowsShownAtMost(tabRows)) return refuse('refused', DRAFT_MAY_BE_HIDDEN);
  }
  return null;
}

/** The press's options: Clear draft carries the rows of the box just read (screenGate passed, so it shows). */
export function keyOptions(key: ControlKey, state: { inputBox: { rows: number } | null }): PressKeyOptions | undefined {
  return key === 'clearInput' && state.inputBox ? { rows: state.inputBox.rows } : undefined;
}

export class KeyControl {
  /** When Ctrl+C last went to each pane (by tty). */
  private readonly lastCtrlC = new Map<string, number>();

  constructor(
    private readonly ctx: DaemonContext,
    private readonly deps: ControlsDeps,
  ) {}

  async press(sid: string, key: ControlKey): Promise<ControlResult> {
    const off = controlsOn(this.ctx);
    if (off) return off;
    if (MENU_KEYS.has(key)) return refuse('refused', MENU_REFUSED);
    if (key === 'quit') return refuse('refused', QUIT_REFUSED);
    const sent = keySent(this.ctx, key);
    if (sent === 'escape' && !this.ctx.settings.get().controls.escapeVerified) return refuse('escape_unverified', ESCAPE_UNVERIFIED);
    if (sent === 'clearInput' && !this.ctx.settings.get().controls.clearVerified) return refuse('refused', CLEAR_UNVERIFIED);
    const pressKey = this.deps.terminal.pressKey?.bind(this.deps.terminal);
    if (!pressKey) return refuse('unsupported', 'this terminal cannot press keys');
    // Cheap checks first, then all of them again under the lock.
    const early = await stateGate(this.ctx, this.deps, sid, { waiting: false });
    if (early) return early;
    const found = await locate(this.ctx, this.deps, sid);
    if (!found.ok) return found;
    const { pane } = found;
    return withLock(this.ctx, this.deps, pane, async () => {
      const state = await stateGate(this.ctx, this.deps, sid, { waiting: false });
      if (state) return state;
      const fg = await foregroundGate(this.deps, pane);
      if (fg) return fg;
      const screen = await readState(this.deps, pane);
      if (!screen.ok) return screen;
      const blocked = screenGate(sent, screen.state, screen.tabRows);
      if (blocked) return blocked;
      if (CTRL_C_KEYS.has(sent)) {
        const last = this.lastCtrlC.get(pane.tty);
        const now = this.ctx.clock.now();
        if (last !== undefined && now - last < CTRL_C_SPACING_MS) {
          return refuse('rate_limited', 'Ctrl+C went to this session less than 3 seconds ago (a second one would quit Claude)');
        }
        // Recorded before typing: a timed-out write may still arrive.
        this.lastCtrlC.set(pane.tty, now);
      }
      const r = await pressKey(pane, sent, keyOptions(sent, screen.state));
      return r.ok ? { ok: true } : r;
    });
  }
}
