/**
 * A Claude dialog read from the terminal's text (v0.4.2, spec 2.3), and the
 * keys a compare-and-type write checks against. Pure functions over screen
 * text, like screen.ts and menu.ts.
 *
 * - `dialogOfScreen(text, gates)`: the dialog the screen shows as buttons
 *   (TerminalDialog), or a note saying why a dialog-looking screen gets
 *   none, plus the dialog's own lines (`block`, indices into
 *   `screenLines(text)`, daemon-only) for the write's check. `readDialog`
 *   and `pointerRowHolds` add what the answer route needs to judge the
 *   screen after a write.
 * - `screenKey(text, lines)` / `screenKeyRange(text, lines)`: the keypad's
 *   guard, a hash of exactly the lines the phone was shown (lastLines), the
 *   ones under the last box edge left out unless a pointer row comes after
 *   it (Claude's mode and status lines change on their own; a picker drawn
 *   under a lone rule keeps its rows), and where those lines are. The
 *   dialog's own auto-block countdown among them (readDialog's) is hashed as
 *   one fixed line.
 * - `rawSlice(raw, from, to)`: lines `from..to` of the terminal's own text,
 *   separators and trailing spaces kept; `rawExpect(raw, from, to,
 *   countdown)`: the same, or its two parts around the countdown's time, for
 *   `PressKeyOptions.expect`.
 * - `countdownEndingAt(lines, end, after)`: Claude Code's auto-block
 *   countdown sentence (v0.5.2), the one text Jantar knows to change by
 *   itself inside a dialog (step 8).
 *
 * How a dialog is read (each step decided from the rows' structure; fixed
 * strings only say which kind it is):
 * 1. `parseMenuRows` on the last 60 lines (the API's screen read and the
 *    answer route's raw read see the same 60, so they agree on the model,
 *    the fingerprint and the block). No list, no dialog. The prompt box is
 *    never consulted: the pointer on "Chat about this" sits right under a
 *    rule, where findInputBox would see the box.
 * 2. A row marked ↓/↑ (more rows off screen) or a preview question (`n to
 *    add notes`) gets a note and no buttons.
 * 2b. A live dialog ends the screen: under its last line (the hint, the
 *    plan's footer, else its last row) come only blank lines and box edges
 *    (the session's name may sit in one). Anything else there means the list
 *    read is text above the live screen (a `cat` of a saved screen, a test's
 *    fixture printed in the transcript) over something without a pointer
 *    (an MCP form's text field, the ctrl+o view): `unsure`.
 * 3. The question is the paragraph right above the rows; with the rows it
 *    says the kind: review, multi-select, question, plan, permission.
 *    Anything else gets no buttons and no note (the keypad).
 * 4. The rows must be numbered 1..N in screen order, "Chat about this" last
 *    and under a rule, and the only unnumbered row a multi-select's
 *    Submit/Next at its boxes' label column right under the last box. A row
 *    miscounted here would shift every arrow below it by one, so any other
 *    shape gets the `unsure` note. No numbers at all is the No-first layout
 *    (DIALOG_GATES.noFirst).
 * 5. The dialog's top is the `Ready to code?` line under the plan box's own
 *    rule (plan), or the line under the nearest solid rule at column 0 above
 *    the question; lines above it (the transcript, a background agent
 *    ticking) are not the dialog's. With neither on screen the dialog gets
 *    no buttons (`unsure`): two queued asks that differ only above the lines
 *    read (a long heredoc writing to another folder) would share one
 *    fingerprint, so a tap meant for one could answer the other. What a
 *    dialog shows (a command, a heredoc, a diff, a plan's text) is drawn
 *    inside it, so a line there that looks like Claude's own (another solid
 *    rule, a second `Ready to code?` or `Here is Claude's plan:`, a plan
 *    header quoted above the real one) or a question without its `☐` header
 *    under the rule gets the `unsure` note: read as the top, it would hide
 *    what is above it.
 * 6. The gates lock what no real-Mac spike has tried: rows above the
 *    pointer (`up`), and every row but the pointer's on a dialog whose body
 *    shows a scroll mark (a plan box or a diff that scrolls: `tall`).
 *    Whatever the gates, a row the arrows would reach only from or across a
 *    row that holds typed text is locked (`pastTyped`): no spike has moved
 *    through such a row, and its text field may take the arrows itself.
 * 7. The phone gets at most 40 body lines: past that, the first 19, a line
 *    saying how many more the Mac shows, and the last 20 (what a command
 *    runs is at its start; the fingerprint covers every line).
 * 8. Claude's auto-block countdown (v0.5.2; Claude Code 2.1.316 draws it in
 *    an unattended agent's ask, a workflow's or a subagent's: `⚠ Claude Code
 *    will automatically block this request in 1:33, to avoid holding up an
 *    unattended session`) ticks every second, so a fingerprint over it never
 *    matched by the time a tap arrived. Only the one Claude draws counts: a
 *    permission's, its last lines above the question with at least one blank
 *    line between (Claude's margin), under the dialog's first line, the
 *    sentence matched whole (COUNTDOWN: every word, the order, the
 *    punctuation and the case; the `⚠` aside; only a time DIALOG_COUNTDOWN_TIME
 *    allows), wrapped over at most COUNTDOWN_LINES lines. Its lines are left
 *    out of the body (the phone's, the fingerprint's and the after-reads'),
 *    so out of screenId too; its time goes to the phone as `blocksIn`, in no
 *    hash, and its place to the answer route as `countdown`. That sentence
 *    anywhere else (a line of a plan, a question's text, a Bash command's
 *    description: all written by the model, none in a box) is the dialog's
 *    own text and counts like any other line, as do a line inside the
 *    command's box (`│ ...`) and everything around it, so two queued prompts
 *    that differ only in their command still differ. The compare-and-type
 *    write leaves out only the time itself (`rawExpect`).
 */
import {
  DIALOG_COUNTDOWN_TIME,
  DIALOG_GATES,
  DIALOG_NOTES,
  type DialogGates,
  type DialogHold,
  type DialogKind,
  type DialogOption,
  type TerminalDialog,
} from '@jantar/protocol';
import { canonicalJson, sha256Hex } from '../core/hash.js';
import { parseMenuRows, type MenuRow, type MenuRows } from './menu.js';
import { isBoxEdge, screenLines, squash } from './screen.js';

/** Line indices into `screenLines(text)`, `from` through `to`. */
export interface LineRange {
  from: number;
  to: number;
}

export interface DialogRead {
  /** The dialog as buttons, or null. */
  dialog: TerminalDialog | null;
  /** Why a dialog-looking screen gets no buttons (one of DIALOG_NOTES), or null. */
  note: string | null;
  /** The dialog's own lines, its top through its last line (daemon-only: never sent to a client). */
  block: LineRange | null;
}

/** A dialog without its fingerprint. */
export type DialogModel = Omit<TerminalDialog, 'fingerprint'>;

/** What the answer route reads from a screen (daemon-only: nothing here goes to a client but `dialog`). */
export interface DialogDetail extends DialogRead {
  /** The model before the gates: the rows as Claude draws them, nothing cut (the phone's model is clipped). */
  open: DialogModel | null;
  /** answerKey(open): what the dialog asks, not where the pointer is. */
  answerKey: string | null;
  /** screenId: answerKey, title and body (a new dialog read twice the same). */
  screenId: string | null;
  /** Per option, the row's whole text as drawn (label and wrapped lines, uncut). */
  rowText: string[];
  /** The body's lines with their own indent, uncut (the "grew at the top" test). */
  bodyLines: string[];
  /**
   * The dialog's top (its rule, or `Ready to code?`) is on screen; false when the read starts inside it.
   * Such a read has no `dialog` (the `unsure` note), but keeps the rest for the answer route's after-reads,
   * which must tell the dialog answered, scrolled out of view, from another one.
   */
  topOnScreen: boolean;
  /**
   * Claude's own auto-block countdown in this dialog (step 8): its lines, as indices into
   * `screenLines(text)`, and its time; null without one. Read whether or not the top is on screen.
   */
  countdown: Countdown | null;
}

/** The lines the parser reads: the bottom of the screen (getScreen reads at least as many). */
export const DIALOG_LINES = 60;

const NONE: DialogDetail = Object.freeze({
  dialog: null,
  note: null,
  block: null,
  open: null,
  answerKey: null,
  screenId: null,
  rowText: [],
  bodyLines: [],
  topOnScreen: false,
  countdown: null,
}) as DialogDetail;

/** Claude's full-width rule: 20 or more of ─/━ and nothing else. Dashed runs are inner edges. */
const SOLID_RULE = /^[─━]{20,}$/u;
/** Any edge line inside or around a dialog: solid, dashed (a diff's, the plan box's). */
const EDGE = /^[─━╌┄┈]{3,}$/u;
/** A rule between two rows (the one above "Chat about this"). */
const ROW_RULE = /^[─━]{3,}$/u;
/** A multi-select row's box: `[ ]`, `[✔]`, `[x]`. */
const BOX = /^\[(.)\]\s+/u;
const READY = 'Ready to code?';
const PLAN_HEAD = /^Here is Claude.s plan:$/u;
const PLAN_FOOTER = /^ctrl\+g to edit\b/iu;
const FEEDBACK_HINT = /^shift\+tab to approve with this feedback$/iu;
const PREVIEW = /\bn to add notes\b/iu;
const CHAT = 'Chat about this';
/** A box that scrolls marks it at the end of a line: `↓` (more below) or `↑`, alone or after a space. */
const SCROLL_MARK = /(?:^|\s)[↓↑]$/u;

/** The countdown's time (DIALOG_COUNTDOWN_TIME without its anchors). */
const COUNTDOWN_TIME = DIALOG_COUNTDOWN_TIME.source.replace(/^\^|\$$/gu, '');
/**
 * Claude Code's auto-block countdown, whole (its wrapped lines trimmed and
 * joined with one space): the sentence from 2.1.316's own source, case
 * considered, `⚠` optional (with or without its emoji selector), and the
 * time captured. Nothing may come before or after it on its lines (so never
 * a command box's `│ ...` line).
 */
const COUNTDOWN = new RegExp(
  `^(?:⚠\\uFE0F?\\s*)?Claude Code will automatically block this request in (${COUNTDOWN_TIME}), to avoid holding up an unattended session$`,
  'u',
);
/** The most lines one countdown wraps over (four in a 30-column window). */
export const COUNTDOWN_LINES = 4;
/**
 * The time inside a countdown's own text, as the terminal has it (`rawExpect`): `M:SS` (the comma after it
 * is the sentence's), or the N of "about N minutes", a line end and an indent allowed around it. The
 * sentence holds no other digit or colon.
 */
const COUNTDOWN_TIME_RAW = /\d{1,2}:\d{2}(?=,)|(?<=\babout\s+)\d{1,3}(?=\s+(?:minute|second)s?,)/gu;
/** What the keypad's screen key hashes in place of a countdown's lines: one fixed line, never screen text. */
const COUNTDOWN_KEY = '\u0000countdown';

/** An edge that may carry the session's name, drawn solid or dashed (mac-1's bottom line: `╌╌╌ name ─`). */
const NAMED_EDGE = /^[─━╌┄┈]{3,}(?:\s+[^─━╌┄┈]+?\s+[─━╌┄┈]{1,8})?$/u;

const isSolid = (line: string) => SOLID_RULE.test(line.trim());
const isEdge = (line: string) => EDGE.test(line.trim());
/** What may come under a live dialog's last line: nothing, or the box's and the window's edges. */
const isTail = (line: string) => !line.trim() || isBoxEdge(line) || NAMED_EDGE.test(line.trim());
const textAt = (line: string) => line.length - line.trimStart().length;

/** Claude's countdown: the lines its sentence takes, and the time it showed. */
export interface Countdown extends LineRange {
  time: string;
}

/**
 * The countdown sentence whose last line is `end` (an index into `lines`, as
 * screenLines gives them), all of it below line `after`: a run of 1 to
 * COUNTDOWN_LINES non-blank lines that, trimmed and joined with one space,
 * read exactly as COUNTDOWN; null when there is none. Where such a run is
 * Claude's own, not the dialog's text, is readLines' call (step 8).
 */
export function countdownEndingAt(lines: readonly string[], end: number, after: number): Countdown | null {
  let joined = '';
  for (let from = end; from > after && from >= 0 && end - from < COUNTDOWN_LINES; from--) {
    const t = (lines[from] ?? '').trim();
    if (!t) return null;
    joined = joined ? `${t} ${joined}` : t;
    const m = COUNTDOWN.exec(joined);
    if (m) return { from, to: end, time: m[1] as string };
  }
  return null;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * What choosing a row saves or switches (spec 2.3 step 10), first match
 * wins; undefined for a plain choice. The phone holds such a row for 2 s and
 * the daemon wants `confirm: true`.
 */
export function holdKind(label: string): DialogHold | undefined {
  if (/clear context/iu.test(label)) return 'context';
  if (/\bblock\b/iu.test(label) && /from now on/iu.test(label)) return 'block';
  if (/keep allowing/iu.test(label) && /outside/iu.test(label)) return 'reads';
  // Write prompts offer "Yes, and switch to accept edits (auto-approve file edits …) for this session" (SP6).
  if (/auto mode|bypass|switch to accept edits/iu.test(label)) return 'mode';
  if (/don.?t ask again|\balways\b|from now on|keep allowing|all future/iu.test(label)) return 'rule';
  return undefined;
}

/**
 * What a dialog asks, without where its pointer is: kind, question, tabs and
 * each row's label, detail, role and box, on the model before the gates
 * (so rows a moved pointer greys never read as a new dialog). `skip` leaves
 * one row out (the input row a text answer fills).
 */
export function answerKey(model: DialogModel, skip = -1): string {
  const options = model.options.map((o, i) => (i === skip ? null : [o.label, o.detail ?? '', o.role, o.checked ?? null]));
  return sha256Hex(canonicalJson({ kind: model.kind, question: model.question, tabs: model.tabs, options }));
}

/** answerKey with the title and body: two reads of one new dialog agree on it. */
export function screenId(key: string, title: string, body: readonly string[]): string {
  return sha256Hex(canonicalJson({ answerKey: key, title, body }));
}

/**
 * The fingerprint the phone answers with: what it was shown, the pointer and
 * the gates' locks included, hashed from the model before it is clipped, so
 * two dialogs that differ only past the clip (the middle of a body over 40
 * lines, a label past 400 characters) never share one. `blocksIn` is left
 * out (step 8): it ticks every second.
 */
function fingerprintOf(d: DialogModel): string {
  return sha256Hex(
    canonicalJson({
      kind: d.kind,
      title: d.title,
      question: d.question,
      body: sha256Hex(d.body.join('\n')),
      tabs: d.tabs,
      options: d.options.map((o) => [o.label, o.detail ?? '', o.role, o.checked ?? null, o.hold ?? null, o.note ?? null]),
      current: d.current,
    }),
  );
}

interface TabBar {
  tabs: { label: string; answered: boolean }[];
  /** Arrows or `✔ Submit` drawn: several questions. Without them a single `☐ X` is the question's header. */
  bar: boolean;
}

/** A questions' tab bar (`←  ☒ Level  ☐ Scope  ✔ Submit  →`) or a single question's `☐ Colour` header. */
function tabBar(line: string): TabBar | null {
  const t = line.trim();
  if (!t) return null;
  const tabs: TabBar['tabs'] = [];
  let bar = false;
  for (const part of t.split(/\s{2,}/u)) {
    if (part === '←' || part === '→' || part === '✔ Submit') {
      bar = true;
      continue;
    }
    const m = /^([☐☒])\s+(\S.*)$/u.exec(part);
    if (!m) return null;
    tabs.push({ label: clip(m[2] as string, 80), answered: m[1] === '☒' });
  }
  if (!tabs.length) return null;
  return { tabs: tabs.slice(0, 12), bar: bar || tabs.length > 1 };
}

/** The question: the nearest run of non-blank lines above the first row, at most 4, ending at a blank line or an edge. */
function paragraphAbove(lines: readonly string[], row: number): LineRange | null {
  let i = row - 1;
  while (i >= 0 && !(lines[i] as string).trim()) i--;
  const to = i;
  while (i >= 0 && to - i < 4) {
    const line = lines[i] as string;
    if (!line.trim() || isEdge(line) || isBoxEdge(line) || tabBar(line)) break;
    i--;
  }
  return i === to ? null : { from: i + 1, to };
}

/**
 * Claude's own countdown in a permission (step 8): the sentence whose last line is the last non-blank line
 * above the question (`paraFrom`), at least one blank line between (Claude's margin), and all of it under the
 * dialog's first line (`head`, its title). Null otherwise: such a sentence anywhere else is the dialog's text.
 */
function ownCountdown(lines: readonly string[], head: number, paraFrom: number): Countdown | null {
  let end = paraFrom - 1;
  while (end > head && !(lines[end] as string).trim()) end--;
  return end > head && end < paraFrom - 1 ? countdownEndingAt(lines, end, head) : null;
}

/** The dialog's last line: its hint and the hint's wrapped lines, else the plan's footer and its wrap, else the last row's. */
function lastLineOf(lines: readonly string[], menu: MenuRows): number {
  const runFrom = (at: number) => {
    const indent = textAt(lines[at] as string);
    let to = at;
    for (let i = at + 1; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!line.trim() || isBoxEdge(line) || isEdge(line) || textAt(line) !== indent) break;
      to = i;
    }
    return to;
  };
  if (menu.hint >= 0) return runFrom(menu.hint);
  for (let i = menu.end + 1; i < lines.length; i++) {
    const t = (lines[i] as string).trim();
    if (!t) continue;
    return PLAN_FOOTER.test(t) ? runFrom(i) : menu.end;
  }
  return menu.end;
}

/** No rows between `a` and `b` (lines) but `a`'s own: nothing blank or ruled in between. */
function adjoins(lines: readonly string[], a: MenuRow, b: MenuRow): boolean {
  for (let i = a.line + 1; i < b.line; i++) {
    const line = lines[i] as string;
    if (!line.trim() || isEdge(line)) return false;
  }
  return true;
}

/**
 * Why the rows can't be trusted to be Claude's own, counted the way the
 * arrows will count them (spec 2.3 step 4), or null when they can.
 */
function structureProblem(lines: readonly string[], rows: readonly MenuRow[], kind: DialogKind, gates: Readonly<DialogGates>): string | null {
  const numbered = rows.filter((r) => r.number !== null);
  if (!numbered.length) {
    // Claude's hideIndexes layouts (No first): unconfirmed, and only a permission prompt is known to use it.
    if (!gates.noFirst) return DIALOG_NOTES.noFirst;
    return kind === 'permission' && !rows.some((r) => r.lone) ? null : DIALOG_NOTES.unsure;
  }
  if (numbered.some((r, i) => r.number !== i + 1)) return DIALOG_NOTES.unsure;
  const chat = rows.findIndex((r) => r.text === CHAT);
  if (chat >= 0) {
    const above = rows[chat - 1];
    if (chat !== rows.length - 1 || rows[chat]?.number === null || !above) return DIALOG_NOTES.unsure;
    let ruled = false;
    for (let i = above.line + 1; i < (rows[chat] as MenuRow).line; i++) if (ROW_RULE.test((lines[i] as string).trim())) ruled = true;
    if (!ruled) return DIALOG_NOTES.unsure;
  }
  const boxes = rows.filter((r) => BOX.test(r.text));
  if (kind === 'multi' && numbered.some((r) => r.text !== CHAT && !BOX.test(r.text))) return DIALOG_NOTES.unsure;
  const loose = rows.filter((r) => r.number === null);
  if (loose.length > 1) return DIALOG_NOTES.unsure;
  const submit = loose[0];
  if (submit) {
    // Only a multi-select's Submit/Next: at its boxes' label column, right under the last box, before the rule and Chat.
    const at = rows.indexOf(submit);
    const last = boxes[boxes.length - 1];
    if (kind !== 'multi' || !submit.lone || !last || rows[at - 1] !== last || submit.col !== last.labelCol || !adjoins(lines, last, submit)) {
      return DIALOG_NOTES.unsure;
    }
    if (at !== (chat >= 0 ? chat - 1 : rows.length - 1)) return DIALOG_NOTES.unsure;
  }
  return null;
}

/** A row as drawn, nothing cut (`clipped` cuts it for the phone). */
function option(label: string, role: DialogOption['role'], more: { detail?: string[]; checked?: boolean; note?: string } = {}): DialogOption {
  const o: DialogOption = { label, role };
  if (more.detail?.length) o.detail = more.detail.join(' ');
  if (more.checked !== undefined) o.checked = more.checked;
  if (role === 'pick') {
    const hold = holdKind(label);
    if (hold) o.hold = hold;
  }
  if (more.note) o.note = more.note;
  return o;
}

/** The options as Claude's rows, before the gates (spec 2.3 step 10). */
function optionsOf(kind: DialogKind, rows: readonly MenuRow[]): DialogOption[] {
  const last = rows.length - 1;
  const chat = rows.findIndex((r) => r.text === CHAT);
  const lastBox = rows.reduce((at, r, i) => (BOX.test(r.text) ? i : at), -1);
  return rows.map((r, i) => {
    const joined = [r.text, ...r.more].join(' ');
    switch (kind) {
      case 'question':
        if (i === chat) return option(r.text, 'chat');
        // The input row: the last numbered row before the rule and Chat about this.
        if (i === (chat >= 0 ? chat - 1 : last)) {
          return r.text === 'Type something.' && !r.more.length
            ? option(r.text, 'text')
            : option(r.text, 'locked', { detail: r.more, note: DIALOG_NOTES.typed });
        }
        return option(r.text, 'pick', { detail: r.more });
      case 'multi': {
        if (i === chat) return option(r.text, 'chat');
        const box = BOX.exec(r.text);
        if (!box) return option(r.text, 'submit');
        const label = r.text.slice(box[0].length);
        const checked = box[1] !== ' ';
        // The last box is "Type something": typing into it is left to the Mac.
        if (i === lastBox) return option(label, 'locked', { detail: r.more, checked, note: DIALOG_NOTES.multiText });
        return option(label, 'toggle', { detail: r.more, checked });
      }
      case 'plan':
        if (i === last) {
          const label = [r.text, ...r.more.filter((m) => !FEEDBACK_HINT.test(m))].join(' ');
          return label === 'Tell Claude what to change' ? option(label, 'text') : option(label, 'locked', { note: DIALOG_NOTES.typed });
        }
        return option(joined, 'pick');
      default:
        return option(joined, 'pick');
    }
  });
}

/** The body lines the phone gets at most (TerminalDialogSchema), and how many of them come from the body's start. */
const BODY_MAX = 40;
const BODY_HEAD = 19;

/** In place of the body lines the phone isn't sent: a fixed sentence with their count, never screen text. */
export function bodyCut(n: number): string {
  return `… ${n} more line${n === 1 ? '' : 's'} on the Mac …`;
}

/**
 * A body of at most BODY_MAX lines: a longer one keeps its first BODY_HEAD lines (a command's start, what
 * a permission says it will run), then bodyCut, then its last lines (the end the question follows).
 */
function shortBody(body: readonly string[]): string[] {
  if (body.length <= BODY_MAX) return [...body];
  const tail = BODY_MAX - BODY_HEAD - 1;
  return [...body.slice(0, BODY_HEAD), bodyCut(body.length - BODY_HEAD - tail), ...body.slice(-tail)];
}

/** The model the phone gets: cut to TerminalDialogSchema's limits (a long body with a line saying what is left out). */
function clipped(d: DialogModel): DialogModel {
  return {
    ...d,
    title: clip(d.title, 120),
    question: clip(d.question, 600),
    body: shortBody(d.body).map((l) => clip(l, 300)),
    options: d.options.map((o) => ({ ...o, label: clip(o.label, 400), ...(o.detail !== undefined ? { detail: clip(o.detail, 300) } : {}) })),
  };
}

function readLines(all: readonly string[], gates: Readonly<DialogGates>): DialogDetail {
  const base = Math.max(0, all.length - DIALOG_LINES);
  const lines = all.slice(base);
  const menu = parseMenuRows(lines);
  if (!menu) return NONE;
  const { rows } = menu;
  const noted = (note: string): DialogDetail => ({ ...NONE, note });

  if (rows.some((r) => r.marker === '↓' || r.marker === '↑')) return noted(DIALOG_NOTES.scrolled);
  const end = lastLineOf(lines, menu);
  // A live dialog ends the screen (step 2b): text under it means these rows are output above the live screen.
  if (!lines.slice(end + 1).every(isTail)) return noted(DIALOG_NOTES.unsure);
  if (lines.slice(menu.start, end + 1).some((l) => PREVIEW.test(l)) || rows.some((r) => r.more.some((m) => /^Notes:/u.test(m)))) {
    return noted(DIALOG_NOTES.preview);
  }

  // The question, the rules above it, and a tab bar or header right under the nearest rule.
  const first = rows[0] as MenuRow;
  const para = paragraphAbove(lines, first.line);
  const paraFrom = para ? para.from : first.line;
  const question = para ? squash(lines.slice(para.from, para.to + 1).join(' ')) : '';
  // `rule`: the nearest solid rule above the question, at any column (a plan box's bottom edge). `edge`: the
  // nearest at column 0, Claude's own top edge for the other kinds (mac-1: the dialog's text starts at column
  // 1, and a command, a heredoc or a diff is drawn inside it, so a rule of theirs never starts at column 0).
  let rule = -1;
  let edge = -1;
  for (let i = paraFrom - 1; i >= 0 && edge < 0; i--) {
    const line = lines[i] as string;
    if (!isSolid(line)) continue;
    if (rule < 0) rule = i;
    if (textAt(line) === 0) edge = i;
  }
  let head = -1;
  for (let i = rule + 1; i < paraFrom; i++) {
    if ((lines[i] as string).trim()) {
      head = i;
      break;
    }
  }
  const bar = head >= 0 ? tabBar(lines[head] as string) : null;
  // `Ready to code?` right under the plan box's own top rule, which starts left of it (mac-3: the rule at
  // column 2, the box's text at 3). The plan's text can quote that header (a code block, deeper indented,
  // under a rule of its own): with two such lines above the question, neither can be told for the top.
  let ready = -1;
  let readies = 0;
  for (let i = paraFrom - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (line.trim() !== READY) continue;
    let above = i - 1;
    while (above >= 0 && !(lines[above] as string).trim()) above--;
    if (above >= 0 && isSolid(lines[above] as string) && textAt(lines[above] as string) < textAt(line)) {
      readies++;
      if (ready < 0) ready = i;
    }
  }

  // The kind: structure first, fixed strings only to classify.
  const texts = rows.map((r) => r.text);
  const lastRow = rows[rows.length - 1] as MenuRow;
  const headText = head >= 0 ? (lines[head] as string).trim() : '';
  let kind: DialogKind | null = null;
  if (question === 'Ready to submit your answers?' && texts.includes('Submit answers')) kind = 'review';
  else if (rows.some((r) => BOX.test(r.text))) kind = 'multi';
  else if (bar || (texts.includes('Type something.') && texts.includes(CHAT))) kind = 'question';
  else if (
    /Would you like to proceed\?$/u.test(question) &&
    (ready >= 0 || lastRow.text === 'Tell Claude what to change' || rows.some((r) => r.more.some((m) => FEEDBACK_HINT.test(m))))
  ) {
    kind = 'plan';
  } else if (
    /Do you want to [^?]*\?$/u.test(question) ||
    /Claude wants to (?:exit|enter) plan mode/u.test(question) ||
    headText === 'Enter plan mode?' ||
    headText === 'Exit plan mode?'
  ) {
    kind = 'permission';
  }
  if (!kind) return NONE;
  const problem = structureProblem(lines, rows, kind, gates);
  if (problem) return noted(problem);
  if (kind === 'plan' && readies > 1) return noted(DIALOG_NOTES.unsure);
  // A solid rule between Claude's edge and the question is the dialog's own text drawing one (a heredoc's
  // line): read as the top, it would leave what the dialog shows above it (the command, a queued twin's file
  // name) out of the phone's view, the fingerprint and the block.
  if (kind !== 'plan' && rule !== edge) return noted(DIALOG_NOTES.unsure);
  // A question's text starts at column 0 too, so a rule it draws is one at column 0: under Claude's own
  // rule comes its `☐ X` header or tab bar.
  if ((kind === 'question' || kind === 'multi' || kind === 'review') && edge >= 0 && !bar) return noted(DIALOG_NOTES.unsure);

  // The dialog's top, title and body.
  let top: number;
  let onScreen = true;
  if (kind === 'plan') top = ready;
  else top = edge >= 0 ? edge + 1 : -1;
  if (top < 0) {
    top = 0;
    onScreen = false;
  }
  // Claude's own countdown (step 8): in no part of the model but `blocksIn`. Never the title: it starts under
  // `head`, which a permission's top (or the first line read, its top off screen) always is.
  const countdown = kind === 'permission' && head >= 0 ? ownCountdown(lines, head, paraFrom) : null;
  const ticking = (i: number) => countdown !== null && i >= countdown.from && i <= countdown.to;
  let title = '';
  let bodyFrom = top;
  if (onScreen && kind === 'plan') {
    title = READY;
    bodyFrom = top + 1;
    // `Here is Claude's plan:` is the first line under it; the plan's text starts after that.
    let at = bodyFrom;
    while (at < paraFrom && !(lines[at] as string).trim()) at++;
    if (at < paraFrom && PLAN_HEAD.test((lines[at] as string).trim())) bodyFrom = at + 1;
  } else if (onScreen) {
    for (let i = top; i < paraFrom; i++) {
      if (!(lines[i] as string).trim()) continue;
      if (i === head && bar) {
        bodyFrom = i + 1;
        if (bar.bar) continue; // a tab bar is never the title
        title = (bar.tabs[0] as TabBar['tabs'][number]).label;
        break;
      }
      title = (lines[i] as string).trim();
      bodyFrom = i + 1;
      break;
    }
  }
  let bodyTo = paraFrom;
  if (kind === 'plan') {
    // Either header line again in the body is the plan's text drawing it: it could pass for the plan's top.
    for (let i = bodyFrom; i < paraFrom; i++) {
      const t = (lines[i] as string).trim();
      if (t === READY || PLAN_HEAD.test(t)) return noted(DIALOG_NOTES.unsure);
    }
    if (rule >= bodyFrom) bodyTo = rule;
  }
  const bodyLines: string[] = [];
  for (let i = bodyFrom; i < bodyTo; i++) {
    const line = lines[i] as string;
    if (!line.trim() || isEdge(line) || isBoxEdge(line) || (i === head && bar) || ticking(i)) continue;
    bodyLines.push(line);
  }
  const indent = Math.min(...bodyLines.map(textAt));
  const body = bodyLines.map((l) => l.slice(indent));

  const open: DialogModel = {
    kind,
    title,
    question,
    body,
    ...(bar?.bar ? { tabs: bar.tabs } : {}),
    options: optionsOf(kind, rows),
    current: menu.current,
    ...(countdown ? { blocksIn: countdown.time } : {}),
  };

  // The gates, last: a row already locked keeps its own note. A body that scrolls (any kind: a plan box, a
  // diff or a command box) is tall, as Down there may scroll it instead of moving the pointer (SP15).
  const tall = bodyLines.some((l) => SCROLL_MARK.test(l));
  // Rows that hold text: an input row typed into (`typed`), and a multi-select's last box once something
  // other than its "Type something" shows there. No spike has sent an arrow from or across one: the text
  // field may take ↑/↓ as moves inside the text, and Terminal's Return would then submit that text instead
  // of the row tapped. So a row reached only from or across one is locked, whatever the gates.
  const holds = open.options.map(
    (o) => o.note === DIALOG_NOTES.typed || (o.note === DIALOG_NOTES.multiText && (o.label !== 'Type something' || o.detail !== undefined)),
  );
  // The rows the arrows leave or cross on the way to row i: the pointer's, and every row between.
  const pastTyped = (i: number) => {
    const [from, to] = i > open.current ? [open.current, i - 1] : [i + 1, open.current];
    return holds.slice(from, to + 1).some(Boolean);
  };
  const options = open.options.map((o, i): DialogOption => {
    if (o.role === 'locked') return o;
    if (!gates.up && i < open.current) return { ...o, role: 'locked', note: DIALOG_NOTES.up };
    if (!gates.tall && tall && i !== open.current) return { ...o, role: 'locked', note: DIALOG_NOTES.tall };
    if (i !== open.current && pastTyped(i)) return { ...o, role: 'locked', note: DIALOG_NOTES.pastTyped };
    return o;
  });
  const shown: DialogModel = { ...open, options };
  const key = answerKey(open);
  const detail = {
    block: { from: base + top, to: base + end },
    open,
    answerKey: key,
    screenId: screenId(key, title, body),
    rowText: rows.map((r, i) => (kind === 'plan' && i === rows.length - 1 ? [r.text, ...r.more.filter((m) => !FEEDBACK_HINT.test(m))] : [r.text, ...r.more]).join(' ')),
    bodyLines,
    countdown: countdown ? { from: base + countdown.from, to: base + countdown.to, time: countdown.time } : null,
  };
  // The top off screen (step 5): no buttons. The rest stays for the after-reads (the dialog answered,
  // scrolled out of view, is not gone).
  if (!onScreen) return { ...detail, dialog: null, note: DIALOG_NOTES.unsure, topOnScreen: false };
  return { ...detail, dialog: { ...clipped(shown), fingerprint: fingerprintOf(shown) }, note: null, topOnScreen: true };
}

/** The dialog with what the answer route needs to judge the next screen (daemon-only). */
export function readDialog(text: string, gates: Readonly<DialogGates> = DIALOG_GATES): DialogDetail {
  return readLines(screenLines(text), gates);
}

/** The dialog the screen shows as buttons, why a dialog-looking screen gets none, and the dialog's own lines. */
export function dialogOfScreen(text: string, gates: Readonly<DialogGates> = DIALOG_GATES): DialogRead {
  const r = readDialog(text, gates);
  return { dialog: r.dialog, note: r.note, block: r.dialog ? r.block : null };
}

/**
 * The list with the highlight at the bottom of `lines` ends them (step 2b): under its last line come only
 * blank lines and edges. False with no such list. The keypad's check that the ❯ it sees is the live
 * screen's, not one in Claude's output above a screen without a pointer.
 */
export function pointerListEnds(lines: readonly string[]): boolean {
  const menu = parseMenuRows(lines);
  return menu !== null && lines.slice(lastLineOf(lines, menu) + 1).every(isTail);
}

/**
 * The highlighted row of the list at the bottom of `text` holds exactly
 * `typed`, white space aside: its wrapped lines (a plan's `shift+tab …` line
 * left out), then any lone `Next`/`Submit` line the wrap left under it. A
 * long answer waiting in its row reads so even when the screen no longer
 * reads as a dialog (its header scrolled off, the wrap left a word alone),
 * so the answer route never takes such a screen for the dialog gone.
 */
export function pointerRowHolds(text: string, typed: string): boolean {
  const want = typed.replace(/\s+/gu, '');
  const menu = want ? parseMenuRows(screenLines(text).slice(-DIALOG_LINES)) : null;
  if (!menu) return false;
  const row = menu.rows[menu.current] as MenuRow;
  let have = [row.text, ...row.more.filter((m) => !FEEDBACK_HINT.test(m))].join('').replace(/\s+/gu, '');
  if (have === want) return true;
  for (const next of menu.rows.slice(menu.current + 1)) {
    if (next.number !== null || !next.lone) break;
    have += [next.text, ...next.more].join('').replace(/\s+/gu, '');
    if (have === want) return true;
  }
  return false;
}

/**
 * The lines `screenKey` hashes, as indices into `screenLines(text)`: the
 * last `lines` lines (what the phone shows), cut after the last box edge
 * among them when no pointer row (❯ or ›) comes after it. Such an edge
 * closes Claude's input box or the fullscreen frame, and the mode and
 * status lines under it change on their own. A rule with a pointer row under
 * it is a dialog's top (a picker, a No-first ask outside fullscreen, which
 * draw no bottom edge), so its rows stay hashed and the keypad can see its
 * pointer. `to < from` when there are none.
 */
export function screenKeyRange(text: string, lines: number): LineRange {
  const all = screenLines(text);
  const from = lines > 0 ? Math.max(0, all.length - lines) : all.length;
  let to = all.length - 1;
  for (let i = all.length - 1; i >= from; i--) {
    const line = all[i] ?? '';
    if (/^\s*[❯›](\s|$)/u.test(line)) break;
    if (isBoxEdge(line)) {
      to = i;
      break;
    }
  }
  return { from, to };
}

/**
 * sha256 hex of the lines `screenKeyRange` names, joined with "\n", the
 * dialog's own countdown among them (`countdown`, readDialog's by default;
 * step 8) as one fixed line: its time changes on its own, that it is there
 * does not. Only that one: the same sentence in a dialog's text, or in the
 * transcript above it, is hashed as it is.
 */
export function screenKey(text: string, lines: number, countdown: Countdown | null = readDialog(text).countdown): string {
  const { from, to } = screenKeyRange(text, lines);
  const all = screenLines(text);
  const run = countdown && countdown.from >= from && countdown.to <= to ? countdown : null;
  const hashed: string[] = [];
  for (let i = from; i <= to; i++) {
    if (!run || i < run.from || i > run.to) hashed.push(all[i] as string);
    else if (i === run.from) hashed.push(COUNTDOWN_KEY);
  }
  return sha256Hex(hashed.join('\n'));
}

/** Where lines `from..to` of `raw` start and end in it (rawSlice), split where `screenLines` splits; 0..0 for none. */
function rawSpan(raw: string, from: number, to: number): { start: number; end: number } {
  const parts = raw.split(/(\r\n|\r|\n)/u);
  const count = Math.ceil(parts.length / 2);
  const first = Math.max(0, from);
  const last = Math.min(to, count - 1);
  if (last < first) return { start: 0, end: 0 };
  let start = 0;
  for (let i = 0; i < first * 2; i++) start += (parts[i] as string).length;
  let end = start;
  for (let i = first * 2; i <= last * 2; i++) end += (parts[i] as string).length;
  return { start, end };
}

/**
 * Lines `from..to` of `raw` exactly as they are in it: split where
 * `screenLines` splits (CRLF, CR, LF), so the indices agree for terminal
 * text (which holds no escape sequences), with the separators between them
 * and every trailing space kept, and without the last line's separator.
 * Always a substring of `raw` ('' when the range is empty).
 */
export function rawSlice(raw: string, from: number, to: number): string {
  const { start, end } = rawSpan(raw, from, to);
  return raw.slice(start, end);
}

/**
 * What a compare-and-type write must still find of lines `from..to` of
 * `raw` (`PressKeyOptions.expect`): `rawSlice`'s text, or, when the dialog's
 * own countdown (`countdown`, readDialog's; step 8) lies among those lines,
 * the two parts around its time alone: from the first line to just before
 * the time, and from just after it to the last line. The `⚠`, every word,
 * the indent and the line ends of the countdown stay in the parts, so the
 * script's typeif finds them only with a time (1 to TYPEIF_GAP_CHARS digits
 * and colons) between them. `M:SS` keeps its four characters for the
 * countdown's two minutes, so the sentence never wraps anew. Both parts are
 * substrings of `raw`. When the time can't be told apart (not exactly one
 * in the countdown's text), the whole slice: a tick is then a 409.
 */
export function rawExpect(raw: string, from: number, to: number, countdown: Countdown | null): string | string[] {
  const block = rawSpan(raw, from, to);
  if (!countdown || countdown.from < from || countdown.to > to) return raw.slice(block.start, block.end);
  const run = rawSpan(raw, countdown.from, countdown.to);
  const times = [...raw.slice(run.start, run.end).matchAll(COUNTDOWN_TIME_RAW)];
  const time = times.length === 1 ? times[0] : undefined;
  if (!time) return raw.slice(block.start, block.end);
  const at = run.start + time.index;
  return [raw.slice(block.start, at), raw.slice(at + time[0].length, block.end)];
}
