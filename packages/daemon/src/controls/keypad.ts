/**
 * The keypad (v0.4.2, spec 3): arrows and one Return, in one write, on a
 * screen Jantar can't turn into buttons. No text, ever; Up only with
 * DIALOG_GATES.up (on since SP14) and Escape only with KEYPAD_ESCAPE and
 * controls.escapeVerified.
 *
 * In order, each refusal types nothing: the Controls switch (and Escape's
 * two switches); `dialogGate`; then under the pane's writer lock: the gate
 * again, Claude in front, a fresh read with `raw`, `screenKey(raw,
 * body.lines)` against the phone's (409 `conflict`), no parsed dialog (it
 * has buttons), not Claude's prompt box (its bash-mode `!` box included), a
 * visible ❯ or › in the hashed lines whose list ends them (only blank lines
 * and edges under it, as under a live dialog), then one compare-and-type
 * write with `expect` = those lines' raw text.
 *
 * Terminal adds a Return to every write, so a move can't be typed without
 * choosing: the phone composes the moves and sends them with Enter, and
 * they are typed as "move n and choose" in one write. The screen key and
 * its range come from `raw`, not the backend's trimmed text, so the range's
 * indices fit `rawSlice(raw, …)` in a window taller than the lines read
 * (the key is the same: both hash the last `lines` lines). Each check reads
 * only lines the phone was shown (screenKeyRange). If they never hold still
 * (something on screen ticks), every send is a 409 and the phone says so.
 *
 * The API audits { sid, move, key }, never screen text.
 */
import { DIALOG_GATES, KEYPAD_ESCAPE, type DialogGates, type SessionKeypadBody } from '@jantar/protocol';
import type { Actor, ControlResult, DaemonContext } from '../contracts.js';
import { dialogOfScreen, pointerListEnds, rawSlice, screenKey, screenKeyRange } from '../terminal/dialog.js';
import { isBoxEdge, screenLines } from '../terminal/screen.js';
import { CANT_CHECK } from './dialog.js';
import { ESCAPE_UNVERIFIED } from './keys.js';
import { SCREEN_LINES, controlsOn, dialogGate, foregroundGate, locate, readState, refuse, withLock, type ControlsDeps } from './common.js';

export const KEYPAD_ESCAPE_OFF = "Escape isn't on the keypad yet: it isn't confirmed on a real Mac. Answer it at the Mac.";
export const KEYPAD_UP_OFF = "Moving up isn't confirmed on this Mac yet. Answer it at the Mac.";
export const SCREEN_CHANGED = 'The terminal changed. Look at it again.';
export const HAS_BUTTONS = 'This dialog has buttons in the app: use them.';
export const PROMPT_BOX = "Claude's prompt box is showing: use the composer. (↑ would bring back your last prompt and Return would send it.)";
export const NO_POINTER = "Jantar can't see which row is highlighted on this screen (Terminal shares no colours). Answer it at the Mac.";
export const POINTER_NOT_LAST =
  "The highlighted row Jantar sees isn't at the bottom of the screen, so it can't tell what Return would choose there. Answer it at the Mac.";

/** A row with the highlight: ❯ or › first on its line. */
const POINTER_ROW = /^\s*[❯›]/u;
/** Claude's prompt box in bash mode: `!` where the box's ❯ goes (findInputBox knows only ❯ and >). */
const BASH_BOX = /^(?:[│┃] ?)?!(?:\s|$)/u;

/** A bash-mode prompt box among `lines`: a `!` line right under a box edge. Return there would run its draft. */
function bashBox(lines: readonly string[]): boolean {
  return lines.some((line, i) => i > 0 && BASH_BOX.test(line) && isBoxEdge(lines[i - 1] as string));
}

/** `gates`: the shipped DIALOG_GATES; a test passes others to try a gate's other side. */
export async function pressKeypad(
  ctx: DaemonContext,
  deps: ControlsDeps,
  sid: string,
  body: SessionKeypadBody,
  _actor: Actor,
  gates: Readonly<DialogGates> = DIALOG_GATES,
): Promise<ControlResult> {
  const off = controlsOn(ctx);
  if (off) return off;
  if (body.key === 'escape') {
    if (!KEYPAD_ESCAPE) return refuse('refused', KEYPAD_ESCAPE_OFF);
    if (!ctx.settings.get().controls.escapeVerified) return refuse('escape_unverified', ESCAPE_UNVERIFIED);
    if (body.move !== 0) return refuse('invalid_request', 'Escape takes no moves');
  }
  if (body.move < 0 && !gates.up) return refuse('invalid_request', KEYPAD_UP_OFF);
  const pressKey = deps.terminal.pressKey?.bind(deps.terminal);
  if (!pressKey) return refuse('unsupported', 'this terminal cannot press keys');
  const early = await dialogGate(ctx, deps, sid);
  if (early) return early;
  const found = await locate(ctx, deps, sid);
  if (!found.ok) return found;
  const { pane } = found;
  return withLock(ctx, deps, pane, async (): Promise<ControlResult> => {
    const gate = await dialogGate(ctx, deps, sid);
    if (gate) return gate;
    const fg = await foregroundGate(deps, pane);
    if (fg) return fg;
    const read = await readState(deps, pane, Math.max(body.lines, SCREEN_LINES));
    if (!read.ok) return read;
    const { raw, state } = read;
    if (raw === null) return refuse('unsupported', CANT_CHECK);
    if (screenKey(raw, body.lines) !== body.screen) return refuse('conflict', SCREEN_CHANGED);
    // A dialog with buttons first: the pointer on "Chat about this" also looks like a prompt box to readScreenState.
    if (dialogOfScreen(raw, gates).dialog) return refuse('refused', HAS_BUTTONS);
    const range = screenKeyRange(raw, body.lines);
    const below = screenLines(raw).slice(range.from);
    const shown = below.slice(0, range.to - range.from + 1);
    if ((state.inputBox && !state.dialog) || bashBox(shown)) return refuse('refused', PROMPT_BOX);
    if (!shown.some((l) => POINTER_ROW.test(l))) return refuse('refused', NO_POINTER);
    // A ❯ in Claude's output (a saved screen printed) above a live screen without one is not the live pointer.
    // Checked to the screen's end: the hashed lines stop at the last box edge, and a form's own top rule is one.
    if (!pointerListEnds(below)) return refuse('refused', POINTER_NOT_LAST);
    const expect = rawSlice(raw, range.from, range.to);
    const r =
      body.key === 'escape'
        ? await pressKey(pane, 'escape', { expect })
        : await pressKey(pane, body.move < 0 ? 'up' : body.move > 0 ? 'down' : 'enter', { expect, ...(body.move !== 0 ? { repeat: Math.abs(body.move) } : {}) });
    if (!r.ok) return r.code === 'changed' ? refuse('conflict', SCREEN_CHANGED) : r;
    return { ok: true };
  });
}
