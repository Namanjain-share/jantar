/**
 * Reading Claude Code's screen: its input box and any dialog on top of it.
 *
 * Ported from the legacy ccw tool's `input_box`, `dialog_body` and
 * `dialog_title` (the maintainer's own code, relicensed with this project)
 * and extended:
 * - The input box is the last `❯` line with Claude's full-width rule directly
 *   above it (or the older `╭──╮` frame). Menu pointers never sit right under
 *   a rule, so a highlighted dialog option is not mistaken for the box.
 * - A dialog is looked for only *below* the input box: an answered dialog in
 *   the scrollback above it does not count. While a dialog is open Claude
 *   hides its input box, so with no box on screen the whole bottom of the
 *   screen is searched.
 * - Signals: a hint footer ("Enter to confirm", "Esc to cancel", ...), a
 *   numbered pointer option ("❯ 1. Yes"), the trust dialog's options, and,
 *   with no input box, the question lines Claude's dialogs ask.
 *
 * The screen is used to *refuse* (never type into a dialog, never type
 * blind). It is never used as proof that a prompt was sent.
 *
 * Pure functions over plain text: Terminal.app's `contents of tab`, or
 * tmux capture output (escape sequences are stripped first).
 */
import { parseMenu } from './menu.js';

// CSI, OSC (BEL or ST terminated), DCS/SOS/PM/APC strings, and two-byte escapes.
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[PX^_][^\u001b]*\u001b\\|\u001b[@-Z\\-_]/g;

/** Screen text as lines: escapes stripped, line ends normalised, trailing spaces and blank lines dropped. */
export function screenLines(text: string): string[] {
  const lines = text
    .replace(ANSI_RE, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/u, ''));
  while (lines.length > 0 && !lines[lines.length - 1]) lines.pop();
  return lines;
}

/** The last `n` lines of `text` (see screenLines). */
export function lastLines(text: string, n: number): string[] {
  const lines = screenLines(text);
  return n > 0 ? lines.slice(-n) : [];
}

/** Whitespace runs to one space, trimmed (ccw's `squash`). */
export function squash(s: string): string {
  return s.replace(/\s+/gu, ' ').trim();
}

/** A line without the box frame Claude draws around some dialogs ("│ text │" -> "text"). */
export function unframe(line: string): string {
  return line.replace(/^[\s│┃]+/u, '').replace(/[\s│┃]+$/u, '');
}

/**
 * The full-width rule above and below Claude's input box, or the older ╭──╮ / ╰──╯ frame edges. For a
 * named session Claude Code writes the name into the rule above the box (`──── my-session ─`), so a
 * rule may carry one label as long as it still ends in rule characters (prose after dashes does not).
 */
export function isBoxEdge(line: string): boolean {
  const t = line.trim();
  return /^[─━]{8,}(?:\s+[^─━]+?\s+[─━]{1,8})?$/u.test(t) || /^[╭╰][─━]{3,}[╮╯]$/u.test(t);
}

/** ccw's dialog divider: a run of line-drawing or dash characters. */
function isRule(line: string): boolean {
  const t = unframe(line);
  return t.length >= 3 && /^[─╌┄┈━═\-–—_ ╭╮╰╯]+$/u.test(t) && /[─╌┄┈━═\-–—_]{3}/u.test(t);
}

// ---------------------------------------------------------------------------
// Input box

export interface InputBox {
  /** Index (in the lines searched) of the `❯` line. */
  row: number;
  /** Index of the box's bottom edge, or of the last line when the edge is cut off. */
  end: number;
  /** The bottom edge is on screen. Without it `rows` counts only to the last line that isn't blank. */
  closed: boolean;
  /** Screen rows the typed text spans. */
  rows: number;
  /** Squashed text in the box; '' when empty or only Claude's placeholder shows. */
  text: string;
  /** The box shows one of Claude's stock placeholders ("Try "..."") rather than typed text. */
  placeholder: boolean;
}

const BOX_POINTER = /^([❯>])(?:\s|$)/u;
const PLACEHOLDERS = [/^Try\s+["“]/u, /^Press up to edit queued messages$/iu];

/** Claude's input box: the last `❯` line with a box edge directly above it, down to the next edge. */
export function findInputBox(lines: readonly string[]): InputBox | null {
  for (let i = lines.length - 1; i > 0; i--) {
    const line = unframe(lines[i] ?? '');
    if (!BOX_POINTER.test(line)) continue;
    if (!isBoxEdge(lines[i - 1] ?? '')) continue;
    const parts = [line.slice(1)];
    let end = lines.length - 1;
    for (let j = i + 1; j < lines.length; j++) {
      const lj = lines[j] ?? '';
      if (isBoxEdge(lj)) {
        end = j;
        break;
      }
      parts.push(unframe(lj));
    }
    const closed = isBoxEdge(lines[end] ?? '');
    const rows = Math.max(1, (closed ? end : end + 1) - i);
    const text = squash(parts.join(' '));
    const placeholder = text !== '' && PLACEHOLDERS.some((re) => re.test(text));
    return { row: i, end, closed, rows, text: placeholder ? '' : text, placeholder };
  }
  return null;
}

/**
 * The most rows of its input box Claude Code's full-screen display shows in a
 * tab `tabRows` tall (2.1.314, with settings `tui: "fullscreen"` or
 * CLAUDE_CODE_NO_FLICKER=1): the rows around the cursor, with no sign that
 * others are hidden. The screen text does not say which display runs, so a
 * box this tall may hold more draft than it shows.
 */
export function boxRowsShownAtMost(tabRows: number): number {
  return Math.max(3, Math.floor(tabRows / 2) - 5);
}

/** The vim mode Claude writes, dim, under its input box: `-- INSERT --`, `-- NORMAL --`, `-- VISUAL LINE --`. */
const VIM_MODE_RE = /(?:^|\s)-- ([A-Z]+(?: [A-Z]+)?) --(?:\s|$)/u;

/**
 * The vim mode shown under the input box ('INSERT', 'NORMAL', 'VISUAL',
 * 'VISUAL LINE'), or null: vim mode is off, or nothing below the box is on
 * screen.
 */
export function vimModeBelow(lines: readonly string[], box: InputBox): string | null {
  for (let i = box.end + 1; i < lines.length; i++) {
    const m = VIM_MODE_RE.exec(unframe(lines[i] ?? ''));
    if (m) return m[1] ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dialogs

export type DialogKind = 'confirm' | 'menu' | 'question';

export interface ScreenDialog {
  /**
   * confirm: a hint footer ("Enter to confirm · Esc to cancel");
   * menu: a highlighted, numbered (or known) option list;
   * question: a dialog question with no input box on screen.
   */
  kind: DialogKind;
  /** The dialog's first line, for messages ("a dialog is open: <title>"). */
  title: string;
  options?: string[];
  current?: number;
}

export interface ScreenState {
  /** The lines that were searched (the bottom of the screen). */
  lines: string[];
  inputBox: InputBox | null;
  dialog: ScreenDialog | null;
}

const HINT_RE = /\b(?:enter to confirm|esc to cancel|tab to amend|press enter to (?:confirm|continue))\b/iu;
const NUMBERED_POINTER_RE = /^[❯›]\s*\d+[.)]\s+\S/u;
const KNOWN_OPTION_RE = /^[❯›]?\s*(?:yes, i trust this folder|no, exit)$/iu;
const QUESTION_RE =
  /\b(?:do you want to (?:proceed|make this edit|create|allow|continue|overwrite)|would you like to (?:proceed|continue)|do you trust the files|trust this folder|is this a project you created or one you trust)\b/iu;
/** How far up from the bottom a question is looked for when no input box shows. */
const QUESTION_REACH = 20;
/** How much of the screen bottom is searched at all. */
const SCREEN_WINDOW = 60;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function findSignal(region: readonly string[], noBox: boolean): { at: number; kind: DialogKind } | null {
  for (let i = region.length - 1; i >= 0; i--) {
    if (HINT_RE.test(unframe(region[i] ?? ''))) return { at: i, kind: 'confirm' };
  }
  for (let i = region.length - 1; i >= 0; i--) {
    const l = unframe(region[i] ?? '');
    if (NUMBERED_POINTER_RE.test(l) || KNOWN_OPTION_RE.test(l)) return { at: i, kind: 'menu' };
  }
  if (noBox) {
    for (let i = region.length - 1; i >= Math.max(0, region.length - QUESTION_REACH); i--) {
      if (QUESTION_RE.test(unframe(region[i] ?? ''))) return { at: i, kind: 'question' };
    }
  }
  return null;
}

/** ccw's dialog_title: the first line under the divider above the dialog that isn't an option or a hint. */
function dialogTitle(region: readonly string[], at: number): string {
  let top = -1;
  for (let i = at - 1; i >= 0; i--) {
    if (isRule(region[i] ?? '')) {
      top = i;
      break;
    }
  }
  for (let i = top + 1; i <= at; i++) {
    const l = unframe(region[i] ?? '');
    if (!l || HINT_RE.test(l) || /^[❯›]/u.test(l) || /^\d+[.)]\s/u.test(l)) continue;
    return clip(l, 120);
  }
  return 'dialog';
}

/** Read the bottom of a screen: where the input box is and whether a dialog is open. */
export function readScreenState(text: string): ScreenState {
  const lines = screenLines(text).slice(-SCREEN_WINDOW);
  const inputBox = findInputBox(lines);
  const region = inputBox ? lines.slice(inputBox.end + 1) : lines;
  const signal = findSignal(region, inputBox === null);
  if (!signal) return { lines, inputBox, dialog: null };
  const dialog: ScreenDialog = { kind: signal.kind, title: dialogTitle(region, signal.at) };
  const menu = parseMenu(region);
  if (menu) {
    dialog.options = menu.options;
    dialog.current = menu.current;
  }
  return { lines, inputBox, dialog };
}

/** The ccw rule exactly: the screen ends with an "Enter to confirm" footer (from `dialog_body`). */
export function endsWithConfirmFooter(text: string): boolean {
  const lines = screenLines(text);
  const last = lines.length > 0 ? unframe(lines[lines.length - 1] as string) : '';
  return last.startsWith('Enter to confirm');
}

/**
 * The reason for a dialog in the way: a fixed sentence, never the dialog's
 * title (screen text). It goes into a send's reason, its progress events,
 * the log, the audit row and a push.
 */
export const DIALOG_OPEN = 'a dialog is open in the terminal; answer it from the dialog in the app, or at the Mac';

/**
 * Why typing into this screen would be wrong, or null when it looks safe:
 * a dialog is open (Enter would answer it), or Claude's input box isn't
 * visible (an unknown screen: never type blind).
 */
export function screenBlocker(state: ScreenState, opts: { requireInputBox?: boolean } = {}): string | null {
  if (state.dialog) return DIALOG_OPEN;
  if ((opts.requireInputBox ?? true) && !state.inputBox) return "Claude's input box isn't on screen";
  return null;
}
