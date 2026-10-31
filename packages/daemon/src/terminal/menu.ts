// Portions adapted from Shed (c) 2026 Sukhad Anand, MIT. See THIRD_PARTY_NOTICES.md
/**
 * The choice a Claude dialog is offering, read from screen text.
 *
 * Claude draws a list with a pointer (❯ or ›) on the highlighted option and
 * a hint line under it, for example:
 *
 *    ❯ No, exit                                 ❯ 1. Yes
 *      Yes, I trust this folder                   2. Yes, and don't ask again for this command
 *                                                 3. No, and tell Claude what to do differently (esc)
 *    Enter to confirm · Esc to cancel
 *                                               Esc to cancel · Tab to amend
 *
 * Some lists are numbered and some are not. Ported from Shed's `parseMenu`
 * (server/menu.js) to TypeScript; behaviour is unchanged apart from typing
 * and the input being a list of lines or a string.
 *
 * v0.4.2: `parseMenuRows` gives the rows themselves (number, columns, the
 * mark in the pointer column, continuation lines), which terminal/dialog.ts
 * checks before it offers a button. It also reads two shapes `parseMenu` did
 * not: the plan approval (no hint; a `ctrl+g to edit …` footer under the
 * rows) and a list with Claude's box edges under it (the questions' review).
 * It reads the whole list around the pointer, across the rule above "Chat
 * about this", and a `↓`/`↑` in the pointer column as a row's mark.
 * `parseMenu` is that list cut to the rows Shed's walk saw, so its output
 * changes only for those two new shapes; readScreenState (the writer, the
 * controls and the launcher) uses it only to refuse.
 */
import { isBoxEdge } from './screen.js';

export interface ScreenMenu {
  /** Option labels, top to bottom (continuation lines joined with a space). */
  options: string[];
  /** Index of the highlighted option. */
  current: number;
}

/** One row of a list, as drawn. */
export interface MenuRow {
  /** The row's first line without its pointer and number ("Yes", "[ ] Apple", "Submit"). */
  text: string;
  /** Its deeper-indented continuation lines, each trimmed. */
  more: string[];
  /** N of an "N. " prefix, or null. */
  number: number | null;
  /** Where the row starts after the pointer column ("N." or the label). */
  col: number;
  /** Where the label starts (after "N. " when numbered). */
  labelCol: number;
  /** The mark in the pointer column: the highlight, a scroll arrow (more rows that way), or none. */
  marker: '❯' | '›' | '↓' | '↑' | ' ';
  /** Index in the lines given. */
  line: number;
  /** Kept only because its trimmed text is exactly "Submit" or "Next" (it is not at the rows' column). */
  lone: boolean;
}

export interface MenuRows {
  rows: MenuRow[];
  /** Index into `rows` of the highlighted row. */
  current: number;
  /** The first row's line, and the last line of the last row (its last continuation). */
  start: number;
  end: number;
  /** The hint line under the rows, or -1 when the list ends the screen (no hint). */
  hint: number;
}

const POINTER = /^(\s*)([❯›])\s+(\S.*)$/;
const SCROLL = /^(\s*)([↓↑])\s+(\S.*)$/u;
const HINT = /Enter to confirm|Esc to cancel|Press enter|to cancel|Tab to amend|enter to select|to navigate/i;
const RULE = /^\s*[─━]{3,}\s*$/;
const NUMBER = /^(\d{1,2})\.\s+/u;
/** Questions with several options and a description under each put the hint far below the pointer. */
const HINT_REACH = 30;
/** The plan approval's footer under its rows (Claude 2.1.314: "ctrl+g to edit in <editor> · <plan file>"). */
const PLAN_FOOTER = /^ctrl\+g to edit\b/iu;
const PLAN_SAVED = /^✔\s*Plan saved!?$/u;

function pointerText(line: string): string | null {
  const m = POINTER.exec(line);
  return m ? (m[3] as string) : null;
}

const textAt = (line: string) => line.length - line.trimStart().length;
const isSubmit = (line: string) => /^(Submit|Next)$/.test(line.trim());

/**
 * How a list with no hint under it ends the screen, after its pointer row
 * at `at`: 'shed' when every line below is a row, a deeper line or blank
 * and one is a numbered row (Shed's rule), 'footer' when below the rows and
 * their continuations come only blank lines, box edges, the plan's
 * `ctrl+g to edit` footer (and its wrapped lines) or `✔ Plan saved!`, with
 * at least one of those (`stop` is the first), else null.
 */
function endsScreen(lines: readonly string[], at: number): { how: 'shed' } | { how: 'footer'; stop: number } | null {
  const below = lines.slice(at + 1);
  const rowish = (line: string) => !line.trim() || /^\s+(\d+\.\s|\s{3,}\S)/.test(line);
  if (below.every(rowish) && below.some((line) => /^\s+\d+\.\s/.test(line))) return { how: 'shed' };
  let stop = -1;
  let footer = false;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    const t = line.trim();
    if (!t) {
      footer = false;
      continue;
    }
    if (isBoxEdge(line) || PLAN_SAVED.test(t)) {
      footer = false;
    } else if (PLAN_FOOTER.test(t)) {
      footer = true;
    } else if (footer) {
      // the footer's path wrapped onto the next line
    } else if (stop < 0 && rowish(line)) {
      continue;
    } else {
      return null;
    }
    if (stop < 0) stop = i;
  }
  return stop < 0 ? null : { how: 'footer', stop };
}

interface Parsed extends MenuRows {
  /** Each row's first line as Shed's parseMenu labels it (number kept, pointer dropped). */
  heads: string[];
  /** Where Shed's walk up from the pointer stopped: parseMenu's rows start here. */
  shedStart: number;
}

function parse(screen: string | readonly string[]): Parsed | null {
  const source = typeof screen === 'string' ? screen.replace(/\r/g, '').split('\n') : [...screen];
  const offset = Math.max(0, source.length - 70);
  const lines = source.map((line) => line.replace(/\s+$/, '')).slice(-70);

  // The last pointer line with a hint below it (the input box's own ❯ has no hint, so it is skipped).
  let at = -1;
  let hint = -1;
  let bound = -1;
  let footer = false;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) {
    const text = pointerText(lines[i] as string);
    if (text === null) continue;
    const below = lines.slice(i + 1, i + 1 + HINT_REACH).findIndex((line) => HINT.test(line));
    if (below >= 0) {
      at = i;
      hint = i + 1 + below;
      bound = hint;
    } else if (/^\d+\.\s/.test(text)) {
      // Some questions have no hint (Claude's "Ready to submit your answers?", the plan approval): a numbered
      // list that ends the screen.
      const ends = endsScreen(lines, i);
      if (ends) {
        at = i;
        bound = ends.how === 'shed' ? lines.length : ends.stop;
        footer = ends.how === 'footer';
      }
    }
  }
  if (at < 0) return null;
  // A pointer after the hint is the input box: the question was already answered.
  if (hint >= 0 && lines.slice(hint + 1).some((line) => /^\s*[❯›](\s|$)/.test(line))) return null;

  const pointerLine = lines[at] as string;
  const first = pointerText(pointerLine) as string;
  const pointerCol = textAt(pointerLine);
  const column = pointerLine.length - first.length; // where the option text starts
  const scrollText = (line: string) => {
    const m = SCROLL.exec(line);
    return m && (m[1] as string).length === pointerCol && line.length - (m[3] as string).length === column ? (m[3] as string) : null;
  };
  // An option line starts its text in the same column as the highlighted one; deeper lines continue the option
  // above, except a multi-choice question's own "Next" or "Submit" row.
  const isOption = (line: string) =>
    Boolean(line.trim()) && !HINT.test(line) && !RULE.test(line) && (POINTER.test(line) || isSubmit(line) || textAt(line) === column);
  const isContinuation = (line: string) =>
    Boolean(line.trim()) && !HINT.test(line) && !RULE.test(line) && !POINTER.test(line) && !isSubmit(line) && textAt(line) > column;
  const isRow = (line: string) => isOption(line) || scrollText(line) !== null;

  // Shed's walk up stops at anything but an option or its continuation.
  let shedStart = at;
  while (shedStart > 0 && (isOption(lines[shedStart - 1] as string) || isContinuation(lines[shedStart - 1] as string))) shedStart--;
  while (shedStart < at && !isOption(lines[shedStart] as string)) shedStart++;
  // The whole list also takes rows above a rule (the pointer on "Chat about this") and above a scroll arrow.
  let start = at;
  while (start > 0) {
    const prev = lines[start - 1] as string;
    if (!(isRow(prev) || isContinuation(prev) || RULE.test(prev))) break;
    start--;
  }
  while (start < at && !isRow(lines[start] as string)) start++;

  const rows: MenuRow[] = [];
  const heads: string[] = [];
  let current = -1;
  let end = at;
  for (let i = start; i < bound; i++) {
    const line = lines[i] as string;
    const scrolled = scrollText(line);
    const pointed = pointerText(line);
    if (scrolled !== null || isOption(line)) {
      if (i === at) current = rows.length;
      const head = pointed ?? scrolled ?? line.trim();
      const col = pointed !== null || scrolled !== null ? column : textAt(line);
      const n = NUMBER.exec(head);
      let marker: MenuRow['marker'] = ' ';
      if (pointed !== null) marker = POINTER.exec(line)?.[2] as '❯' | '›';
      else if (scrolled !== null) marker = SCROLL.exec(line)?.[2] as '↓' | '↑';
      rows.push({
        text: n ? head.slice(n[0].length) : head,
        more: [],
        number: n ? Number(n[1]) : null,
        col,
        labelCol: col + (n ? n[0].length : 0),
        marker,
        line: offset + i,
        lone: pointed === null && scrolled === null && textAt(line) !== column,
      });
      heads.push(head);
      end = i;
    } else if (isContinuation(line) && rows.length) {
      (rows[rows.length - 1] as MenuRow).more.push(line.trim());
      end = i;
    } else if (!line.trim() || RULE.test(line)) {
      continue; // a gap or a divider between options (for example "Chat about this")
    } else {
      break;
    }
  }
  if (rows.length < 2 || current < 0 || rows.length > 12) return null;
  const firstRow = rows[0] as MenuRow;
  // A list ended by footers or box edges is numbered like Claude's, and doesn't start right under a box
  // edge: that is the input box holding a draft that looks like a list.
  if (footer && (rows.filter((r) => r.number !== null).length < 2 || isBoxEdge(lines[firstRow.line - offset - 1] ?? ''))) return null;
  return {
    rows,
    current,
    start: firstRow.line,
    end: offset + end,
    hint: hint >= 0 ? offset + hint : -1,
    heads,
    shedStart: offset + shedStart,
  };
}

/**
 * The list at the bottom of the screen with its rows as drawn, or null when
 * none is showing (no pointer with a hint or an end of screen under it, a
 * pointer under the hint, fewer than 2 or more than 12 rows). Line numbers
 * are indices into the lines given.
 */
export function parseMenuRows(screen: string | readonly string[]): MenuRows | null {
  const p = parse(screen);
  if (!p) return null;
  return { rows: p.rows, current: p.current, start: p.start, end: p.end, hint: p.hint };
}

/** The menu at the bottom of the screen, or null when none is showing. */
export function parseMenu(screen: string | readonly string[]): ScreenMenu | null {
  const p = parse(screen);
  if (!p) return null;
  // Shed's view: the rows from where its walk up stopped, up to a scroll arrow (it read neither).
  const options: string[] = [];
  let current = -1;
  for (let i = 0; i < p.rows.length; i++) {
    const row = p.rows[i] as MenuRow;
    if (row.line < p.shedStart) continue;
    if (row.marker === '↓' || row.marker === '↑') break;
    if (i === p.current) current = options.length;
    options.push([p.heads[i] as string, ...row.more].join(' '));
  }
  if (options.length < 2 || current < 0 || options.length > 12) return null;
  return { options, current };
}

/** The arrow keys that move the pointer from the highlighted option to `index` (Return then chooses). */
export function keysToChoose(menu: ScreenMenu, index: number): string {
  const steps = index - menu.current;
  return (steps > 0 ? '\u001b[B' : '\u001b[A').repeat(Math.abs(steps));
}
