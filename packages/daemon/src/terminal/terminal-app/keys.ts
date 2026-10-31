/**
 * Whitelisted control keys for Terminal.app (work package C owns this file).
 *
 * `pressKeyImpl` looks the key up in KEY_BYTES, repeats an arrow
 * `opts.repeat` times in ONE payload, and hands it to `host.typeBytes` (the
 * backend's `type` script mode: `do script <bytes> in <tab>`, never a focus).
 * Only ControlKey names come in, so no other bytes can be typed outside a
 * prompt. `escape` stays refused here unless settings.controls.escapeVerified
 * (spike S2), and `clearInput` unless settings.controls.clearVerified (spike
 * S1). The gates (claude in front, no card, no dialog, the writer
 * lock) live in controls/keys.ts, not here.
 *
 * Clear draft's bytes depend on the draft: `clearInputBytes(opts.rows)`, the
 * rows Claude's input box showed when the caller read it under the lock.
 * Without a row count (or with more than CLEAR_MAX_ROWS) nothing is typed.
 * The 30 Oct 2026 spike (docs/real-mac-checks.md) found that End and ONE
 * Ctrl+U clear only the cursor's row: on a two-row draft the cursor sat on
 * the empty last row, and Terminal's Return then sent the first. Claude
 * 2.1's End goes to the end of the row, or to the end of the next row when
 * it is there already; its Ctrl+U deletes to the start of the row, or just
 * the line break when the cursor is at a row's start. So End once per row
 * reaches the end of the draft from any row, and two Ctrl+U per row (the
 * row's text, the break before it) empty it. Both are padded, since spares
 * cost nothing (End at the end of the last row stays put; Ctrl+U in an empty
 * box deletes nothing, as the spike's eight on two rows showed): two more
 * End and six more Ctrl+U, for a row or two typed at the Mac between the
 * read and the write. Which drafts the caller may clear at all (a box cut
 * off, Claude's full-screen display, vim mode) is decided in
 * controls/keys.ts.
 *
 * Every `do script` ends with one Return: after an arrow that Return is the
 * menu selection itself; after Shift+Tab it would submit a draft, which is
 * why the gate wants an empty input box. Quit is Ctrl+C twice in one write:
 * the Return after a lone Ctrl+C cancels Claude's "press again to exit".
 *
 * `enter` is therefore an empty write: that Return alone picks the
 * highlighted option. The legacy ccw tool's startup_answer answers menus
 * exactly so (`do script ""`, or an arrow and nothing else). A "\r" there
 * would be two Returns, and the second would answer whatever screen comes
 * next (the bypass warning's "No, exit", a trust dialog's "Yes"). Enter in
 * the input box is the backend's pressEnter ("\r"), not this key.
 *
 * v0.4.2, compare-and-type: with `opts.expect` the write goes through
 * `host.typeBytesIf` (the script's `typeif` mode), so it lands only while the
 * tab still shows that exact text; `changed` otherwise, nothing typed. An
 * empty `expect`, or one holding NUL, is refused before anything runs.
 * v0.5.2: `expect` may be the parts of a dialog around the time in Claude's
 * ticking countdown (terminal/dialog.ts rawExpect, script.ts
 * TYPEIF_GAP_CHARS): 1 to EXPECT_PARTS_MAX of them,
 * none empty or holding NUL, and, when there are several, each with at
 * least EXPECT_PART_MIN characters other than white space, so that no part
 * can be found on a screen by accident; refused before anything runs
 * otherwise. With
 * `opts.text` (up, down and enter only, and only with `expect`) the text is
 * typed after the arrows in the same write, for a dialog's input row: 2 to
 * 700 characters on one line, no control characters, no leading or trailing
 * space, not starting with / ! # or @ and no @ after a space (the rules of
 * DialogTextSchema: one printable character can be a key, and a slash, bang,
 * hash or mention may be taken as a command).
 */
import { DIALOG_TEXT_MAX, DIALOG_TEXT_MIN, type ControlKey, type Pane } from '@jantar/protocol';
import type { OpResult, PressKeyOptions } from '../../contracts.js';
import type { TerminalAppHost } from './host.js';

/** The bytes for each key but Clear draft (controls addendum). Nothing else is ever typed outside a prompt. */
export const KEY_BYTES: Readonly<Record<Exclude<ControlKey, 'clearInput'>, string>> = {
  up: '\u001b[A',
  down: '\u001b[B',
  enter: '',
  shiftTab: '\u001b[Z',
  interrupt: '\u0003',
  quit: '\u0003\u0003',
  // CSI-u Escape: a lone ESC would reach Claude as ESC + Return, which is Meta+Return.
  escape: '\u001b[27u',
};

/** End: the end of the cursor's row, or of the next row when the cursor is there already. */
const END = '\u001b[F';
/** Ctrl+U: to the start of the row, or the line break before the cursor. */
const CTRL_U = '\u0015';

/** The tallest draft Clear draft takes on; a taller one is cleared at the Mac. */
export const CLEAR_MAX_ROWS = 30;

/** Why Clear draft typed nothing: its row count is missing or out of range. */
export const CLEAR_ROWS_REASON = `Clear draft needs the rows of Claude's input box (1 to ${CLEAR_MAX_ROWS}), read just before; nothing was typed`;

/** How many End take the cursor to the end of a draft on `rows` rows from any row: one a row, and two spare. */
export function clearEndCount(rows: number): number {
  return rows + 2;
}

/** How many Ctrl+U clear a draft on `rows` rows: two a row (its text, the break before it), and six spare. */
export function clearCtrlUCount(rows: number): number {
  return 2 * rows + 6;
}

function clearWrite(rows: number): string {
  return END.repeat(clearEndCount(rows)) + CTRL_U.repeat(clearCtrlUCount(rows));
}

/**
 * Clear draft's one write for a draft on `rows` screen rows: clearEndCount
 * End, so the cursor ends on the draft's last row wherever it was, then
 * clearCtrlUCount Ctrl+U. Null when `rows` is not a whole number from 1 to
 * CLEAR_MAX_ROWS: never typed blind.
 */
export function clearInputBytes(rows: number | undefined): string | null {
  if (rows === undefined || !Number.isInteger(rows) || rows < 1 || rows > CLEAR_MAX_ROWS) return null;
  return clearWrite(rows);
}

/**
 * The writer's clean-up of its own unsent one-row prompt (the backend's
 * clearInput): the same write for one row. A lone Ctrl+U would keep the text
 * right of a cursor moved at the Mac, for the Return to send.
 */
export const CLEAR_ONE_ROW = clearWrite(1);

/** The most parts one compare-and-type write checks (a dialog shows one countdown). */
export const EXPECT_PARTS_MAX = 8;
/** Each of several parts holds at least this many characters other than white space. */
export const EXPECT_PART_MIN = 16;

/** `expect` as the texts the script checks in order, or why it can't be checked (nothing is typed then). */
function expectParts(expect: unknown): { parts: readonly string[] } | { problem: string } {
  if (typeof expect === 'string') {
    return expect === '' || expect.includes('\u0000') ? { problem: 'the text to compare is empty or holds NUL; nothing was typed' } : { parts: [expect] };
  }
  if (!Array.isArray(expect) || expect.length === 0 || expect.length > EXPECT_PARTS_MAX) {
    return { problem: `the text to compare comes in 1 to ${EXPECT_PARTS_MAX} parts; nothing was typed` };
  }
  for (const p of expect as unknown[]) {
    if (typeof p !== 'string' || p === '' || p.includes('\u0000')) return { problem: 'a part of the text to compare is empty or holds NUL; nothing was typed' };
    if (expect.length > 1 && p.replace(/\s+/gu, '').length < EXPECT_PART_MIN) {
      return { problem: `a part of the text to compare is under ${EXPECT_PART_MIN} characters; nothing was typed` };
    }
  }
  return { parts: expect as string[] };
}

/** Keys that may be pressed several times in one write (menus). */
const REPEATABLE: ReadonlySet<ControlKey> = new Set(['up', 'down']);

/** Most presses of one arrow in one write (a dialog never has more rows). */
export const MAX_KEY_REPEAT = 20;

/** Keys a dialog's input row may be reached with: the text follows the arrows (or the highlighted row's Return). */
const TEXT_KEYS: ReadonlySet<ControlKey> = new Set(['up', 'down', 'enter']);
// C0 and C1 controls and DEL: no line break, no tab, no escape inside a dialog's text.
const TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;

/** Why `text` can't be typed into a dialog's input row, or null. */
export function dialogTextProblem(text: string): string | null {
  if (text.length < DIALOG_TEXT_MIN || text.length > DIALOG_TEXT_MAX) return `the text must be ${DIALOG_TEXT_MIN} to ${DIALOG_TEXT_MAX} characters`;
  if (TEXT_CONTROLS.test(text)) return 'the text must be one line with no control characters';
  if (text.trim() !== text) return 'the text must not start or end with a space';
  if (/^[/!#@]/u.test(text) || /\s@/u.test(text)) return 'the text must not start with / ! # or @, nor mention with @';
  return null;
}

export async function pressKeyImpl(host: TerminalAppHost, pane: Pane, key: ControlKey, opts: PressKeyOptions = {}): Promise<OpResult> {
  // An own-property lookup: a name like "constructor" is not a key.
  if (typeof key !== 'string' || (key !== 'clearInput' && !Object.hasOwn(KEY_BYTES, key))) {
    return { ok: false, code: 'unsupported', reason: 'not a control key' };
  }
  if (key === 'escape' && !host.ctx.settings.get().controls.escapeVerified) {
    return { ok: false, code: 'unsupported', reason: 'Escape is off on this Mac (controls.escapeVerified)' };
  }
  if (key === 'clearInput' && !host.ctx.settings.get().controls.clearVerified) {
    return { ok: false, code: 'unsupported', reason: 'Clear draft is off on this Mac (controls.clearVerified)' };
  }
  const repeat = opts.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_KEY_REPEAT) {
    return { ok: false, code: 'unsupported', reason: `a key can be repeated 1 to ${MAX_KEY_REPEAT} times` };
  }
  if (repeat > 1 && !REPEATABLE.has(key)) {
    return { ok: false, code: 'unsupported', reason: 'only up and down can be repeated' };
  }
  if (opts.text !== undefined) {
    if (!TEXT_KEYS.has(key)) return { ok: false, code: 'unsupported', reason: 'text goes only after up, down or enter' };
    if (opts.expect === undefined) return { ok: false, code: 'unsupported', reason: 'text is typed only by a compare-and-type write' };
    const problem = typeof opts.text === 'string' ? dialogTextProblem(opts.text) : 'the text must be a string';
    if (problem) return { ok: false, code: 'unsupported', reason: problem };
  }
  if (opts.expect !== undefined) {
    const expect = expectParts(opts.expect);
    if ('problem' in expect) return { ok: false, code: 'unsupported', reason: expect.problem };
    if (!host.typeBytesIf) return { ok: false, code: 'unsupported', reason: "this terminal can't compare the screen as it types" };
    const bytes = key === 'clearInput' ? clearInputBytes(opts.rows) : KEY_BYTES[key].repeat(repeat) + (opts.text ?? '');
    if (bytes === null) return { ok: false, code: 'unsupported', reason: CLEAR_ROWS_REASON };
    return host.typeBytesIf(pane, bytes, expect.parts);
  }
  if (key === 'clearInput') {
    const bytes = clearInputBytes(opts.rows);
    if (bytes === null) return { ok: false, code: 'unsupported', reason: CLEAR_ROWS_REASON };
    return host.typeBytes(pane, bytes);
  }
  return host.typeBytes(pane, KEY_BYTES[key].repeat(repeat));
}
