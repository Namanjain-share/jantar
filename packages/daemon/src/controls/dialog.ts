/**
 * Answering a terminal dialog from the phone (v0.4.2, spec 2.4): the screen
 * path for sessions without a hook card and for subagent prompts.
 *
 * In order, each refusal a fixed sentence that types nothing: the Controls
 * switch; `dialogGate` (session alive, no open card but `subagent-info`, no
 * ccw move); then under the pane's writer lock: the gate again, Claude in
 * front, a fresh read with `raw`, `dialogOfScreen(raw)` and the phone's
 * fingerprint against it (409 `conflict` when it differs), the row's role,
 * text and hold rules, one compare-and-type write (`pressKey` with `expect`
 * = the dialog's raw block, arrows computed from the pointer just read),
 * and, still under the lock, the after-reads that decide `done` or
 * `unchanged` (and the one guarded lone Return for long text Terminal's CR
 * left in the row).
 *
 * The write is arrows and, for an input row, the text, in one `do script`
 * (Terminal adds the one Return that chooses): never a digit, Tab, Shift+Tab
 * or Left/Right, and Up only with DIALOG_GATES.up (spike SP14). Its
 * `expect` runs from the dialog's top, so the next queued ask with the same
 * question and rows but another command (SP4) doesn't match it.
 *
 * After the write, a read every AFTER_READ_STEP_MS for AFTER_READ_MS, each
 * judged against the dialog answered:
 * - gone: no dialog, and after a text answer no highlighted row holding the
 *   text (`pointerRowHolds`: a long answer still waiting in its row can
 *   leave a screen that reads as no dialog, its header scrolled off or a
 *   wrapped word alone on a line; that read is `same`);
 * - moved: a different one (another answerKey, another shown title, or a
 *   body that changed other than by growing at the top, or by losing lines
 *   at the top as the dialog's top goes off screen);
 * - pending, after a text answer: the same dialog with the pointer on the
 *   answered row and the typed text waiting in it (Terminal swallowed the
 *   Return after a long run, SP5);
 * - same: anything else (a pointer that moved, a title that appeared, a body
 *   grown at the top: the fullscreen display scrolling the dialog into view
 *   without taking the answer; or the reverse, the top scrolled out of view).
 *   A row holding text with anything else different is `same` too: it never
 *   gets the Return. A read whose top is off screen offers no buttons, so
 *   the phone gets no dialog back with it: the next queued ask drawn alike
 *   below its top (SP4) can't be told from this one, and one tap must never
 *   answer it.
 * `done` takes two `gone`, or two `moved` showing the same new dialog, in a
 * row (a half-drawn frame is not an answer). Two `pending` in a row get one
 * lone Return, compare-and-type on that read, at most once per answer.
 * Otherwise `unchanged`: Jantar saw no change, which is not "nothing was
 * chosen". Jantar never retries a write by itself.
 *
 * Nothing the screen shows (a label, the question, the body, typed text)
 * goes into a reason, a log line or the audit row: `kind`, `role` and the
 * row count go to the audit; `dialog` goes only to the phone.
 */
import { DIALOG_GATES, DIALOG_TEXT_MAX, DIALOG_TEXT_MIN, type DialogGates, type Pane, type SessionDialogBody, type TerminalDialog } from '@jantar/protocol';
import type { Actor, ControlResult, DaemonContext, DialogAnswer, PressKeyOptions, TerminalBackend } from '../contracts.js';
import { answerKey, pointerRowHolds, rawSlice, readDialog, type DialogDetail } from '../terminal/dialog.js';
import { SCREEN_LINES, controlsOn, dialogGate, foregroundGate, locate, refuse, withLock, type ControlsDeps, type Refusal } from './common.js';

/** How long the answer route keeps reading after its write, under the lock. */
export const AFTER_READ_MS = 1_500;
/** Between two of those reads. */
export const AFTER_READ_STEP_MS = 300;

export const CANT_CHECK = "This terminal can't be checked at the moment of typing, so Jantar won't answer from the phone.";
export const DIALOG_GONE = 'The dialog on the Mac is gone (answered there?)';
export const DIALOG_CHANGED = 'The dialog on the Mac changed. Look at it again.';
export const NO_SUCH_ROW = 'This dialog has no such row.';
export const ROW_LOCKED = "This row can't be answered from the phone. Choose it at the Mac.";
export const NEEDS_TEXT = `This row needs text (${DIALOG_TEXT_MIN} to ${DIALOG_TEXT_MAX} characters)`;
export const TEXT_ELSEWHERE = 'Only a row that takes text can take text';
export const HOLD_TO_CONFIRM = 'This choice saves something or switches mode; hold to confirm';
const NO_KEYS = 'this terminal cannot press keys';

type Verdict = 'gone' | 'moved' | 'pending' | 'same';
type PressKey = NonNullable<TerminalBackend['pressKey']>;

/** A read after the write: what it showed, the raw text it was cut from, and whether its highlighted row holds the typed text. */
interface After {
  read: DialogDetail;
  raw: string | null;
  holds: boolean;
}

function noWhitespace(s: string): string {
  return s.replace(/\s+/gu, '');
}

/** `small` is the end of `big`, line for line. */
function endsWith(big: readonly string[], small: readonly string[]): boolean {
  if (small.length > big.length) return false;
  const at = big.length - small.length;
  return small.every((line, i) => big[at + i] === line);
}

/** How a read after the write compares with the dialog that was answered (see the file comment). `holds`: pointerRowHolds of the typed text. */
function judge(a: DialogDetail, now: DialogDetail, option: number, text: string | undefined, holds: boolean): Verdict {
  const was = a.open as NonNullable<DialogDetail['open']>;
  const is = now.open;
  // No dialog read at all is gone; one whose top is off screen has no buttons but is still compared.
  if (!is) return holds ? 'same' : 'gone';
  const otherTitle = was.title !== '' && is.title !== '' && was.title !== is.title;
  // A body that grew at the top (scrolled into view) is the same dialog's; so is one that lost lines at the top
  // while the dialog's top went off screen (scrolled out of view, as a long answer typed into its row can push it).
  const otherBody = !endsWith(now.bodyLines, a.bodyLines) && !(!now.topOnScreen && endsWith(a.bodyLines, now.bodyLines));
  if (text !== undefined && is.kind === was.kind && !otherTitle && !otherBody && answerKey(is, option) === answerKey(was, option)) {
    // The same dialog but for the input row the text went into: never a new dialog.
    const waiting =
      is.title === was.title &&
      now.bodyLines.length === a.bodyLines.length &&
      is.current === option &&
      noWhitespace(now.rowText[option] ?? '') === noWhitespace(text);
    return waiting ? 'pending' : 'same';
  }
  if (now.answerKey !== a.answerKey || otherTitle || otherBody) return 'moved';
  return 'same';
}

async function readAfter(
  ctx: DaemonContext,
  deps: ControlsDeps,
  pane: Pane,
  text: string | undefined,
  gates: Readonly<DialogGates>,
): Promise<After | null> {
  const r = await deps.terminal.readScreen(pane, { lines: SCREEN_LINES });
  if (!r.ok) {
    ctx.log.warn('dialog after-read failed', { code: r.code });
    return null;
  }
  const screen = r.raw ?? r.text;
  return { read: readDialog(screen, gates), raw: r.raw ?? null, holds: text !== undefined && pointerRowHolds(screen, text) };
}

/**
 * The reads after the write, under the lock (see the file comment): `done`
 * or `unchanged`, and the dialog the screen shows last (null when none).
 */
async function afterWrite(
  ctx: DaemonContext,
  deps: ControlsDeps,
  pane: Pane,
  pressKey: PressKey,
  a: DialogDetail,
  option: number,
  text: string | undefined,
  gates: Readonly<DialogGates>,
): Promise<{ outcome: DialogAnswer['outcome']; dialog: TerminalDialog | null }> {
  let last: TerminalDialog | null = a.dialog;
  let prev: { verdict: Verdict; screenId: string | null } | null = null;
  let returned = false;
  let from = ctx.clock.now();
  while (ctx.clock.now() - from < AFTER_READ_MS) {
    await ctx.clock.sleep(AFTER_READ_STEP_MS);
    const seen = await readAfter(ctx, deps, pane, text, gates);
    if (!seen) {
      prev = null;
      continue;
    }
    const now = seen.read;
    last = now.dialog;
    let verdict = judge(a, now, option, text, seen.holds);
    if (verdict === 'pending' && returned) verdict = 'same';
    if (verdict === 'gone' && prev?.verdict === 'gone') return { outcome: 'done', dialog: null };
    if (verdict === 'moved' && prev?.verdict === 'moved' && prev.screenId === now.screenId) return { outcome: 'done', dialog: now.dialog };
    if (verdict === 'pending' && prev?.verdict === 'pending' && seen.raw !== null && now.block) {
      // Terminal's Return after the text was swallowed: one more, only while the row still holds exactly that text.
      returned = true;
      prev = null;
      const r = await pressKey(pane, 'enter', { expect: rawSlice(seen.raw, now.block.from, now.block.to) });
      if (!r.ok) ctx.log.warn('dialog text commit not typed', { code: r.code });
      from = ctx.clock.now();
      continue;
    }
    prev = { verdict, screenId: now.screenId };
  }
  return { outcome: 'unchanged', dialog: last };
}

/** Why the phone's choice can't be typed into dialog `d`, or null (spec 2.4 step 3.3). `gates` as `d` was read with. */
export function rowProblem(d: TerminalDialog, body: SessionDialogBody, gates: Readonly<DialogGates> = DIALOG_GATES): Refusal | null {
  const row = d.options[body.option];
  if (!row) return refuse('invalid_request', NO_SUCH_ROW);
  if (row.role === 'locked') return refuse('invalid_request', row.note ?? ROW_LOCKED);
  if (row.role === 'text' && body.text === undefined) return refuse('invalid_request', NEEDS_TEXT);
  if (row.role !== 'text' && body.text !== undefined) return refuse('invalid_request', TEXT_ELSEWHERE);
  if (row.hold && body.confirm !== true) return refuse('needs_confirm', HOLD_TO_CONFIRM);
  // A row above the pointer is locked while the gate is off; checked again before any byte is chosen.
  if (body.option < d.current && !gates.up) return refuse('invalid_request', ROW_LOCKED);
  return null;
}

/** The one write's key and options: arrows from the pointer just read (none for the highlighted row), then the text. */
export function answerPress(d: TerminalDialog, body: SessionDialogBody, expect: string): { key: 'up' | 'down' | 'enter'; opts: PressKeyOptions } {
  const move = body.option - d.current;
  const key = move > 0 ? 'down' : move < 0 ? 'up' : 'enter';
  return {
    key,
    opts: { expect, ...(move !== 0 ? { repeat: Math.abs(move) } : {}), ...(body.text !== undefined ? { text: body.text } : {}) },
  };
}

/** `gates`: the shipped DIALOG_GATES; a test passes others to try a gate's other side. */
export async function answerDialog(
  ctx: DaemonContext,
  deps: ControlsDeps,
  sid: string,
  body: SessionDialogBody,
  _actor: Actor,
  gates: Readonly<DialogGates> = DIALOG_GATES,
): Promise<ControlResult<DialogAnswer>> {
  const off = controlsOn(ctx);
  if (off) return off;
  const pressKey = deps.terminal.pressKey?.bind(deps.terminal);
  if (!pressKey) return refuse('unsupported', NO_KEYS);
  // Cheap checks first, then all of them again under the lock.
  const early = await dialogGate(ctx, deps, sid);
  if (early) return early;
  const found = await locate(ctx, deps, sid);
  if (!found.ok) return found;
  const { pane } = found;
  return withLock(ctx, deps, pane, async (): Promise<ControlResult<DialogAnswer>> => {
    const gate = await dialogGate(ctx, deps, sid);
    if (gate) return gate;
    const fg = await foregroundGate(deps, pane);
    if (fg) return fg;
    const r = await deps.terminal.readScreen(pane, { lines: SCREEN_LINES });
    if (!r.ok) return refuse(r.code === 'failed' ? 'unreadable' : r.code, `the terminal screen couldn't be read (${r.reason})`);
    if (r.raw === undefined) return refuse('unsupported', CANT_CHECK);
    const a = readDialog(r.raw, gates);
    if (!a.dialog || !a.block) return refuse('conflict', DIALOG_GONE);
    if (a.dialog.fingerprint !== body.fingerprint) return refuse('conflict', DIALOG_CHANGED);
    const problem = rowProblem(a.dialog, body, gates);
    if (problem) return problem;
    const row = a.dialog.options[body.option] as NonNullable<TerminalDialog['options'][number]>;
    const press = answerPress(a.dialog, body, rawSlice(r.raw, a.block.from, a.block.to));
    const typed = await pressKey(pane, press.key, press.opts);
    if (!typed.ok) return typed.code === 'changed' ? refuse('conflict', DIALOG_CHANGED) : typed;
    const after = await afterWrite(ctx, deps, pane, pressKey, a, body.option, body.text, gates);
    return { ok: true, outcome: after.outcome, dialog: after.dialog, kind: a.dialog.kind, role: row.role, options: a.dialog.options.length };
  });
}
