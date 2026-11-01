/**
 * The dock for a dialog Claude shows in the terminal with no hook card for
 * it (v0.4.2, spec 0 and 2.1): a session waiting with no card, a subagent
 * prompt, or any screen read that parsed a dialog.
 *
 *   ■ Claude asks · Ready to code?                       now
 *   Claude has written up a plan … Would you like to proceed?
 *   ▸ Read the plan                       the body, in a --term box
 *   [ Yes, and use auto mode          ]   hold 2 s, with what it switches
 *   [ Yes, manually approve edits     ]
 *   [ Tell Claude what to change…     ]   opens a text box (2 to 700)
 *   [ Show on Mac ]
 *
 * - With `screen.dialog`: the dialog in Claude's own wording and order, one
 *   48 px row per option (the keyboard hints `(shift+tab)` and `(esc)`
 *   dropped from the labels). Hold rows (they save something or switch
 *   mode) say what they do under them; text rows open a text box, focused;
 *   locked rows are greyed, with their note once under a run of rows that
 *   share it; the review's Cancel takes two taps; a No row offers "No, and
 *   tell Claude what to do instead…", whose note goes into the composer once
 *   the No is done (a No row that already says "tell Claude" opens that box
 *   itself, with a quiet "Just No"). No keys on a dock with buttons. Every
 *   row is off while a tap is in flight, offline, with Controls off or on a
 *   device without the control scope (with the reason).
 * - A permission's body shows open, whatever its length: what it would run
 *   or change is what Yes answers (a body over 40 lines comes with the
 *   daemon's line saying how many more the Mac shows). A plan's starts
 *   folded; a plan box that scrolls on the Mac (↓ or ↑ on its last line)
 *   says the Mac shows only part of it.
 * - A workflow's or a subagent's ask that Claude blocks by itself when
 *   nobody answers (v0.5.2, `dialog.blocksIn`) says so under its question
 *   ("Claude blocks this at the Mac in 1 min 33 s if nobody answers"), and
 *   the folded sheet's peek starts with the time left. The phone counts it
 *   down each second from the read that showed it, a second off for the
 *   read's own way here, and every read starts it again, so it never shows
 *   more time than is left, offline, after a failed read or back from the
 *   background included; at 0 it says Claude has blocked it by now. Under
 *   COUNTDOWN_MIN_S seconds (twice that for a text row) the rows are
 *   off and the line says to answer at the Mac (the daemon refuses such a
 *   tap anyway). The time is in no fingerprint and in none of what the dock
 *   compares (`whole`, `drawn`, the tap guard's key), so a tick never starts
 *   the view afresh nor drops a tap; it is not a live region, but the
 *   Choices name it. A countdown that goes up under the same fingerprint is
 *   another ask (an agent asking the same again after Claude blocked the
 *   first): the view starts afresh, as for a `renewed` one.
 * - With no dialog: why there are no buttons (`screen.dialogNote`, or
 *   "Jantar can't read this dialog's options"), the screen's lines (every
 *   line the keypad's check covers), and the keypad; with Claude's prompt
 *   box on screen instead, only that it is ready for a prompt.
 * - After a tap that brings the next dialog, focus goes to its question.
 * - After an answer closed the dialog: "Answered · <row>" until the next
 *   screen read; the dock never stays on it over a live dialog.
 * - A dialog whose title, body, tab bar or descriptions change under the
 *   same question and rows (the next queued Bash prompt with another
 *   command, the next question drawn alike) starts afresh with its body open
 *   and "The dialog on the Mac changed", so a folded body never hides what a
 *   tap would now answer. So does a new fingerprint under the very same
 *   drawing, pointer and ticks included (answer.ts `drawn`: something the
 *   phone doesn't show changed), and a next dialog an answer reports that
 *   is drawn just like the one answered (answer.ts `renewed`): it must not
 *   read as a tap that didn't take.
 * - Starting afresh empties a typed answer and a No's note, after a 409 as
 *   well (spec 2.7 keeps the note only on `unchanged` and a refusal): text
 *   typed for one prompt is never one tap from answering the next.
 * - A tap within TAP_GUARD_MS of the dialog appearing, of anything a tap
 *   carries changing (rows, title, body, tabs, a tick, the pointer, the
 *   fingerprint), of it starting afresh, or of a tap dropped before it is
 *   dropped (answer.ts `useTapGuard`), with a polite line saying so: the
 *   finger was on its way to what was there before.
 * - A subagent's prompt is titled "A subagent asks · <tool>" when the dialog
 *   is a permission for that tool; any other dialog is Claude's.
 * - Show on Mac stays, as a secondary button.
 * - v0.6: on a paired machine's session (one Jantar can type into: the
 *   session screen shows this dock for no other) the dialog is answered on
 *   that machine; Show on Mac shows only where there is a Terminal window
 *   to raise ("Show on mini-1"), not for a tmux pane. The dock is headed
 *   with the Mac's name for the machine, as its hook cards are ("build-1
 *   asks · Permission"), and its own lines name that machine where they
 *   say "the Mac" (`atMachine`): "Claude blocks this at build-1 in 1 min
 *   33 s if nobody answers". Only the dock's own fixed sentences are
 *   rewritten, never what the machine's terminal shows (the question) or
 *   an error the Mac sends. Answering there follows that machine's own
 *   Controls switch, not the Mac's.
 */
import clsx from 'clsx';
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import {
  CLI_NAME,
  DIALOG_GATES,
  DIALOG_HOLD_COPY,
  DIALOG_NOTES,
  DIALOG_TEXT_MAX,
  DIALOG_TEXT_MIN,
  DialogTextSchema,
  machineName,
  sessionFeatures,
  type DialogOption,
  type PendingRequest,
  type Session,
  type TerminalDialog,
} from '@jantar/protocol';
import { cleanScreen } from '../../../lib/format.js';
import { useApp } from '../../context.js';
import { BUTTON_VARIANT, Button } from '../../kit/Button.js';
import { HOLD_MS, useHold } from '../../kit/hold.js';
import { Spinner } from '../../kit/Spinner.js';
import {
  CANT_TELL,
  CHANGED,
  COUNTDOWN_LATE,
  COUNTDOWN_MIN_S,
  countdownSecondsOf,
  drawn,
  identity,
  NO_CHANGE,
  NO_CONTROL_SCOPE,
  shownLabel,
  TAP_DROPPED,
  useAnswerBlock,
  useDialogAnswer,
  useTapGuard,
  whole,
  type AnswerLine,
  type DialogTap,
} from './answer.js';
import { DockFrame } from './DockFrame.js';
import { Actions, InlineError, OfflineLine } from './Fields.js';
import { SubagentAsk, subagentTitle } from './Info.js';
import { Keypad } from './Keypad.js';
import type { SessionScreenRead } from './screen.js';
import { TermBox } from './ScreenView.js';
import { promptProblem, type Sends } from './sends.js';
import { TwoTap } from './TwoTap.js';

export interface TermDialogDockProps {
  sid: string;
  session: Session;
  /** The open `subagent-info` card, when the waiting prompt is a subagent's. */
  subagent: PendingRequest | undefined;
  /** The session screen's one read (session/screen.ts). */
  screen: SessionScreenRead;
  phone: boolean;
  /** "now", "2m": how long Claude has waited. */
  age: string;
  late: boolean;
  /** The composer's sends: "No, and tell Claude …" puts its note in the draft (`sends.setDraft`). */
  sends: Sends;
  /** Absent where there is no window to raise (a server's tmux pane). */
  onShowOnMac?: () => void;
  /** v0.6: the paired machine the session runs on (absent: the Mac). */
  machine?: string;
}

export const CANT_READ = "Jantar can't read this dialog's options. Use the keys, or answer it at the Mac.";
/** Under a multi-select only while DIALOG_GATES.up is off (it ships on since SP14): rows above the pointer wait for the Mac. */
export const TICK_DOWN = 'Tick from top to bottom.';
/** Under a plan whose box scrolls on the Mac: the phone has only what the box shows. */
export const PLAN_PARTIAL = 'The Mac shows only part of this plan. Read the rest at the Mac before you approve.';
/** Under an answer that can't go yet for being too short. */
export const TEXT_SHORT = `At least ${DIALOG_TEXT_MIN} characters here.`;

/** v0.6: a dock line for a paired machine's session, its name where the line says "the Mac" (the Mac's own: unchanged). */
export function atMachine(text: string, machine: string | null | undefined): string {
  return machine ? text.replace(/\b[Tt]he Mac\b/gu, machine) : text;
}

/** v0.6: the tap lines atMachine may rewrite, the dock's own sentences; never an error the Mac sends (errorText). */
const MACHINE_LINES: ReadonlySet<string> = new Set([CHANGED, NO_CHANGE, CANT_TELL, COUNTDOWN_LATE]);

/** v0.6: a server's dialog with Controls off there (its own switch: the Mac's says nothing about it). */
export function controlsOffOn(machine: string): string {
  return `Controls are off on ${machine}. Turn them on there: ${CLI_NAME} controls on`;
}

/** Under the question of an ask Claude blocks by itself (`blocksIn`): the time left ("1 min 33 s", "about 2 minutes"). */
export function blocksLine(left: string): string {
  return `Claude blocks this at the Mac in ${left} if nobody answers`;
}
/** Under that question once its countdown has run out on the phone's count. */
export const BLOCKED = 'Claude has blocked this at the Mac by now, unless someone answered there.';
/** "1 min 33 s", "2 min", "33 s": the seconds left, never read as a clock time. */
export function leftWords(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m ? (s ? `${m} min ${s} s` : `${m} min`) : `${s} s`;
}
/** Taken off a read's time for its way to the phone: the countdown never shows more time than is left. */
const READ_LATENCY_MS = 1_000;

/** The `M:SS` of a ticking countdown in seconds; null for "about N minutes" (not counted down) or none. */
function tickingSeconds(blocksIn: string | undefined): number | null {
  return blocksIn && /^\d{1,2}:\d{2}$/u.test(blocksIn) ? countdownSecondsOf(blocksIn) : null;
}

/**
 * Seconds left on Claude's ticking countdown: `blocksIn` as the read named `read` showed it, counted down each
 * second from when that read landed (less READ_LATENCY_MS), and started again by every read that shows one.
 * The larger of the page's monotonic clock and the wall clock counts, so a phone that slept never shows the old
 * time. Null without a ticking one.
 */
function useCountdown(read: number, blocksIn: string | undefined): number | null {
  const secs = tickingSeconds(blocksIn);
  const key = secs === null ? null : `${read}|${blocksIn}`;
  const [from, setFrom] = useState<{ key: string; secs: number; mono: number; wall: number } | null>(null);
  if (key !== null && secs !== null && from?.key !== key) {
    setFrom({ key, secs, mono: performance.now() - READ_LATENCY_MS, wall: Date.now() - READ_LATENCY_MS });
  }
  const [, tick] = useState(0);
  const at = key !== null && from?.key === key ? from : null;
  const left = at ? Math.max(0, at.secs - Math.floor(Math.max(performance.now() - at.mono, Date.now() - at.wall) / 1_000)) : secs;
  const counting = left !== null && left > 0;
  useEffect(() => {
    if (!counting) return;
    const id = setInterval(() => tick((n) => n + 1), 1_000);
    // Back from the background: count at once, before the next read lands.
    const onVisible = () => tick((n) => n + 1);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [counting]);
  return left;
}
/** The composer's limit (PromptBodySchema): a "No, and tell Claude …" note is sent from there. */
const NOTE_MAX = 16_000;
/** A plan this short shows open; a longer one starts folded. A permission's body always shows open. */
const OPEN_BODY_LINES = 6;
/** A box that scrolls marks the end of its last line (`↓` more below, `↑`). */
const SCROLL_MARK = /(?:^|\s)[↓↑]$/u;
/** Claude's full-width rules, shortened so they don't wrap in the phone's terminal box. */
const RULE_LINE = /^[─━]{41,}$/gmu;

/** The screen's text for the dock's box: control characters out, full-width rules cut to 40. */
function boxText(text: string): string {
  return cleanScreen(text).replace(RULE_LINE, (m) => m.slice(0, 40));
}

/** What the tool on a subagent's card titles its permission dialog. */
const TOOL_TITLE: Record<string, RegExp> = {
  Bash: /^Bash command$/u,
  Write: /^(?:Create|Overwrite|Write) file$/u,
  Edit: /^Edit file$/u,
  MultiEdit: /^Edit file$/u,
  Read: /^Read file$/u,
  WebFetch: /^Fetch$/u,
};

/** The subagent on the card asks this dialog: a permission titled for its tool. Else it is Claude's (the main agent's, or another's). */
function askedBy(d: TerminalDialog, subagent: PendingRequest | undefined): PendingRequest | undefined {
  if (!subagent?.tool || d.kind !== 'permission' || !d.title) return undefined;
  const title = TOOL_TITLE[subagent.tool];
  return (title ? title.test(d.title) : d.title.toLowerCase().startsWith(subagent.tool.toLowerCase())) ? subagent : undefined;
}

const KIND_WORD: Record<TerminalDialog['kind'], string> = {
  permission: 'permission',
  plan: 'plan',
  question: 'question',
  multi: 'question',
  review: 'your answers',
};

/** The header's word after "Claude asks": the dialog's title, or its kind when it has none (a tab bar is never one). */
function headWord(d: TerminalDialog): string {
  const t = d.title.trim() || KIND_WORD[d.kind];
  return t.length > 48 ? `${t.slice(0, 47).trimEnd()}…` : t;
}

/** Why a typed answer can't go yet (null: it can, or nothing is typed yet). */
function textProblem(raw: string): string | null {
  const t = raw.trim();
  if (!t || DialogTextSchema.safeParse(raw).success) return null;
  if (t.length < DIALOG_TEXT_MIN) return TEXT_SHORT;
  if (t.length > DIALOG_TEXT_MAX) return `At most ${DIALOG_TEXT_MAX} characters here.`;
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(t)) return 'Keep it on one line: the Mac takes this answer as one line of text.';
  return 'Leave out a leading /, !, # or @, and any @ after a space: Claude could read them as a command or a file.';
}

const ROW =
  'relative flex w-full min-h-48 items-center gap-12 rounded-btn px-16 py-8 text-left font-medium select-none ' +
  'transition duration-120 ease-hover active:not-disabled:scale-97 motion-reduce:active:not-disabled:scale-100 disabled:cursor-default';

/** A multi-select box as the Mac draws it: ticked or not. */
function Box({ on }: { on: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true" className="glyph flex-none">
      <rect className="fill-line-strong" x="2" y="2" width="12" height="1" />
      <rect className="fill-line-strong" x="2" y="13" width="12" height="1" />
      <rect className="fill-line-strong" x="2" y="3" width="1" height="10" />
      <rect className="fill-line-strong" x="13" y="3" width="1" height="10" />
      {on ? <rect className="fill-ink" x="5" y="5" width="6" height="6" /> : null}
    </svg>
  );
}

/** A row's label and Claude's description under it (`detailId`: for a button whose aria-label hides it). */
function RowText({ label, detail, busy, detailId }: { label: string; detail?: string | undefined; busy?: boolean; detailId?: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex items-center gap-8 type-row wrap-break-word">
        {busy ? <Spinner label="Answering" /> : null}
        {label}
      </span>
      {detail ? (
        <span id={detailId} className="mt-2 type-small font-regular text-ink-2 wrap-break-word">
          {detail}
        </span>
      ) : null}
    </span>
  );
}

interface RowProps {
  d: TerminalDialog;
  o: DialogOption;
  i: number;
  phone: boolean;
  /** Every row is off (a tap in flight, offline, no Controls). */
  off: boolean;
  /** The row whose answer is in flight. */
  busy: number | null;
  onTap: (tap: DialogTap) => void;
}

/**
 * A greyed row. Rows in a run that share one note show it once, under the run's last row (`showNote`),
 * and each names it (`noteId`), so a screen reader hears it on every row.
 */
function LockedRow({ o, noteId, showNote }: Pick<RowProps, 'o'> & { noteId: string; showNote: boolean }) {
  return (
    <div>
      <button type="button" disabled className={clsx(ROW, BUTTON_VARIANT.outline)} aria-describedby={o.note ? noteId : undefined}>
        {o.checked !== undefined ? <Box on={o.checked} /> : null}
        <RowText label={shownLabel(o.label)} detail={o.detail} />
      </button>
      {o.note && showNote ? (
        <p id={noteId} className="mt-4 type-small text-ink-3">
          {o.note}
        </p>
      ) : null}
    </div>
  );
}

function HoldRow({ o, i, off, busy, onTap }: RowProps) {
  const copyId = useId();
  const detailId = useId();
  const label = shownLabel(o.label);
  const { holding, handlers } = useHold({ onCommit: () => onTap({ option: i, confirm: true }), durationMs: HOLD_MS, disabled: off });
  return (
    <div>
      <button
        type="button"
        className={clsx(ROW, BUTTON_VARIANT.outline, 'hold isolate overflow-hidden')}
        disabled={off}
        aria-label={`${label}. Hold for ${HOLD_MS / 1000} seconds`}
        aria-describedby={o.detail ? `${detailId} ${copyId}` : copyId}
        data-holding={holding ? 'true' : 'false'}
        // Custom properties through the style prop are set with CSSOM, which the CSP allows.
        style={{ '--hold-ms': `${HOLD_MS}ms` } as CSSProperties}
        {...handlers}
      >
        <span className="hold-fill" aria-hidden="true" />
        <span className="hold-label flex min-w-0 flex-1 items-center gap-12">
          <RowText label={label} detail={o.detail} busy={busy === i} detailId={detailId} />
        </span>
        <span className="hold-label-2" aria-hidden="true">
          Keep holding
        </span>
      </button>
      {o.hold ? (
        <p id={copyId} className="mt-4 type-small text-ink-3">
          Hold for {HOLD_MS / 1000} seconds. {DIALOG_HOLD_COPY[o.hold]}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A text box under a row: the dialog's answer (2 to 700, one line) or a No's note (for the composer).
 * Focused as it opens: the tap that opened it raises the phone's keyboard (React commits within it).
 */
function TextBox({
  id: boxId,
  label,
  placeholder,
  value,
  onChange,
  counter,
  problem,
  send,
  phone,
  oneLine,
}: {
  /** The box's own id, for the row button's aria-controls. */
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  counter?: ReactNode;
  problem: string | null;
  send: ReactNode;
  phone: boolean;
  /** Enter sends instead of starting a new line. */
  oneLine?: (() => void) | undefined;
}) {
  const id = useId();
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (oneLine && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      oneLine();
    }
  };
  return (
    <div id={boxId} className="mt-8">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        id={id}
        rows={phone ? 3 : 2}
        // Opened by the user's own tap on its row: the keyboard comes up with it.
        autoFocus
        enterKeyHint={oneLine ? 'send' : 'enter'}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        className="block w-full resize-none rounded-btn border border-line-strong bg-surface px-10 py-8 type-input text-ink focus-visible:outline-offset-0"
      />
      <div className="mt-8 flex flex-wrap items-center gap-8">
        {counter}
        <span className="min-w-0 flex-1" />
        {send}
      </div>
      {problem ? <p className="mt-4 type-small text-ink-2">{problem}</p> : null}
    </div>
  );
}

function TextRow({ d, o, i, phone, off, busy, onTap }: RowProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const boxId = useId();
  const parsed = DialogTextSchema.safeParse(text);
  const go = () => {
    if (!off && parsed.success) onTap({ option: i, text: parsed.data });
  };
  const size = phone ? 'xl' : 'lg';
  const plan = d.kind === 'plan';
  return (
    <div>
      <button
        type="button"
        className={clsx(ROW, BUTTON_VARIANT.outline)}
        disabled={off}
        aria-expanded={open}
        aria-controls={open ? boxId : undefined}
        onClick={() => setOpen(!open)}
      >
        <RowText label={`${shownLabel(o.label).replace(/\.$/u, '')}…`} detail={o.detail} />
      </button>
      {open ? (
        <TextBox
          id={boxId}
          label={plan ? 'What should change' : 'Your answer'}
          placeholder={plan ? 'Tell Claude what to change' : 'Type your answer'}
          value={text}
          onChange={setText}
          phone={phone}
          oneLine={go}
          counter={
            <span className="type-mono text-ink-3">
              {text.trim().length} / {DIALOG_TEXT_MAX}
            </span>
          }
          problem={textProblem(text)}
          send={
            <Button variant="primary" size={size} disabled={off || !parsed.success} onClick={go}>
              {busy === i ? <Spinner label="Answering" /> : null}
              {plan ? 'Send to Claude' : 'Send answer'}
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

/**
 * "No, and tell Claude what to do instead…": answers No, then the note waits in the composer. `row`: the
 * No row itself already says "tell Claude", so it is the toggle (no second link), and "Just No" sends the
 * plain No from inside the box.
 */
function NoNote({ i, phone, off, busy, onTap, row }: Pick<RowProps, 'i' | 'phone' | 'off' | 'busy' | 'onTap'> & { row?: { label: string; detail?: string | undefined } }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const boxId = useId();
  const t = note.trim();
  const problem = t ? (promptProblem(t) ?? (t.length > NOTE_MAX ? `At most ${NOTE_MAX.toLocaleString('en-US')} characters.` : t.length < DIALOG_TEXT_MIN ? TEXT_SHORT : null)) : null;
  const ready = t.length >= DIALOG_TEXT_MIN && !problem;
  const toggle = { disabled: off, 'aria-expanded': open, 'aria-controls': open ? boxId : undefined, onClick: () => setOpen(!open) };
  return (
    <div className={row ? undefined : 'mt-4'}>
      {row ? (
        <button type="button" className={clsx(ROW, BUTTON_VARIANT.outline)} {...toggle}>
          <RowText label={`${row.label}…`} detail={row.detail} busy={busy === i} />
        </button>
      ) : (
        <Button variant="text" size="sm" className="-ml-8" {...toggle}>
          No, and tell Claude what to do instead…
        </Button>
      )}
      {open ? (
        <TextBox
          id={boxId}
          label="What Claude should do instead"
          placeholder="Tell Claude what to do instead"
          value={note}
          onChange={setNote}
          phone={phone}
          problem={problem}
          counter={
            row ? (
              <Button variant="text" size="sm" className="-ml-8" disabled={off} onClick={() => onTap({ option: i })}>
                Just No
              </Button>
            ) : undefined
          }
          send={
            <Button size={phone ? 'xl' : 'lg'} className={phone ? 'w-full' : undefined} disabled={off || !ready} onClick={() => onTap({ option: i, note: t })}>
              {busy === i ? <Spinner label="Answering" /> : null}
              No, and put my note in the box
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

function OptionRow(props: RowProps & { noteId: string; showNote: boolean }) {
  const { d, o, i, phone, off, busy, onTap, noteId, showNote } = props;
  const size = phone ? 'xl' : 'lg';
  const label = shownLabel(o.label);
  switch (o.role) {
    case 'locked':
      return <LockedRow o={o} noteId={noteId} showNote={showNote} />;
    case 'text':
      return <TextRow {...props} />;
    case 'chat':
      return (
        <Button variant="text" size={size} className="-ml-8 self-start" disabled={off} onClick={() => onTap({ option: i })}>
          {busy === i ? <Spinner label="Answering" /> : null}
          {label}
        </Button>
      );
    case 'toggle':
      return (
        <button type="button" className={clsx(ROW, BUTTON_VARIANT.outline)} disabled={off} aria-pressed={Boolean(o.checked)} onClick={() => onTap({ option: i })}>
          <Box on={Boolean(o.checked)} />
          <RowText label={label} detail={o.detail} busy={busy === i} />
        </button>
      );
    case 'submit':
    case 'pick':
      break;
  }
  if (d.kind === 'review' && /^cancel\b/iu.test(label)) {
    // Cancel throws every answer away ("User declined to answer questions"): a second tap.
    return (
      <TwoTap size={size} className="w-full" disabled={off} onConfirm={() => onTap({ option: i })} confirmLabel="Tap again to decline all">
        {busy === i ? <Spinner label="Answering" /> : null}
        Cancel, decline all
      </TwoTap>
    );
  }
  if (o.hold) return <HoldRow {...props} />;
  const primary = d.kind === 'review' && /^submit\b/iu.test(label);
  const button = (
    <button type="button" className={clsx(ROW, BUTTON_VARIANT[primary ? 'primary' : 'outline'])} disabled={off} onClick={() => onTap({ option: i })}>
      <RowText label={label} detail={o.detail} busy={busy === i} />
    </button>
  );
  if ((d.kind === 'permission' || d.kind === 'plan') && /^No\b/u.test(label) && /\btell Claude\b/iu.test(label)) {
    // The row already offers to tell Claude: it opens the note box itself.
    return <NoNote i={i} phone={phone} off={off} busy={busy} onTap={onTap} row={{ label, detail: o.detail }} />;
  }
  if ((d.kind === 'permission' || d.kind === 'plan') && /^No\b/u.test(label)) {
    return (
      <div>
        {button}
        <NoNote i={i} phone={phone} off={off} busy={busy} onTap={onTap} />
      </div>
    );
  }
  return button;
}

/** The dialog's question, tabs, body and rows. */
function DialogView({
  d,
  phone,
  off,
  busy,
  onTap,
  showBody,
  focusQuestion,
  left,
  at,
}: {
  d: TerminalDialog;
  phone: boolean;
  off: boolean;
  busy: number | null;
  onTap: (tap: DialogTap) => void;
  /** Start with the body open (it changed under the same rows). */
  showBody: boolean;
  /** Take focus on the question as it shows (a tap brought this dialog; focus would fall to the page). */
  focusQuestion: boolean;
  /** Seconds left on Claude's countdown (counted down, or "about N" as drawn); null without one. */
  left: number | null;
  /** The session's machine where a line says "the Mac" (atMachine). */
  at: (text: string) => string;
}) {
  const [bodyOpen, setBodyOpen] = useState(showBody || d.kind === 'permission' || d.body.length <= OPEN_BODY_LINES);
  const bodyText = d.body.join('\n');
  const question = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (focusQuestion) question.current?.focus();
  }, [focusQuestion]);
  const notes = useId();
  const deadline = useId();
  // Too late for a write and its after-reads (a text row's lone Return takes about as long again).
  const late = (o: DialogOption) => left !== null && left < COUNTDOWN_MIN_S * (o.role === 'text' ? 2 : 1);
  const blocks =
    d.blocksIn === undefined
      ? null
      : left === 0
        ? BLOCKED
        : left !== null && left < COUNTDOWN_MIN_S
          ? COUNTDOWN_LATE
          : blocksLine(tickingSeconds(d.blocksIn) === null || left === null ? d.blocksIn : leftWords(left));
  const blocksText = blocks === null ? null : at(blocks);
  // A run of locked rows with one note shows it once, under the run's last row.
  const runEnd = d.options.map((o, i) => {
    let j = i;
    while (o.role === 'locked' && o.note && d.options[j + 1]?.role === 'locked' && d.options[j + 1]?.note === o.note) j++;
    return j;
  });
  const partial = d.kind === 'plan' && SCROLL_MARK.test(d.body[d.body.length - 1] ?? '');
  return (
    <>
      {d.tabs?.length ? (
        <ol aria-label="Questions" className="mt-8 flex flex-wrap gap-x-12 gap-y-4 type-mono">
          {d.tabs.map((t, i) => (
            <li key={i} className={t.answered ? 'text-ink-2' : 'text-ink-3'}>
              <span aria-hidden="true">{t.answered ? '☒ ' : '☐ '}</span>
              {t.label}
              <span className="sr-only">{t.answered ? ', answered' : ', not answered yet'}</span>
            </li>
          ))}
        </ol>
      ) : null}
      <p ref={question} tabIndex={-1} className="mt-8 type-title text-ink wrap-break-word focus-visible:outline-offset-2">
        {d.question}
      </p>
      {blocksText ? (
        <p id={deadline} className="mt-4 type-small font-medium text-ink">
          {blocksText}
        </p>
      ) : null}
      {d.body.length && d.kind === 'review' ? (
        <TermBox text={bodyText} label="Your answers" top className="mt-12 max-h-240" />
      ) : d.body.length ? (
        <div className="mt-8">
          <Button variant="text" size="sm" className="-ml-8" aria-expanded={bodyOpen} onClick={() => setBodyOpen(!bodyOpen)}>
            {bodyOpen ? '▾' : '▸'} {d.kind === 'plan' ? 'Read the plan' : at('What the Mac shows')}
          </Button>
          {bodyOpen ? <TermBox text={bodyText} label={d.kind === 'plan' ? 'The plan' : 'What the dialog shows'} top className="mt-4 max-h-240" /> : null}
          {partial ? <p className="mt-4 type-small text-ink-2">{at(PLAN_PARTIAL)}</p> : null}
        </div>
      ) : null}
      {d.kind === 'multi' && !DIALOG_GATES.up ? <p className="mt-8 type-small text-ink-2">{TICK_DOWN}</p> : null}
      <div role="group" aria-label="Choices" aria-describedby={blocksText ? deadline : undefined} className="mt-12 flex flex-col gap-8">
        {d.options.map((o, i) => (
          <OptionRow
            key={i}
            d={d}
            o={o}
            i={i}
            phone={phone}
            off={off || late(o)}
            busy={busy}
            onTap={onTap}
            noteId={`${notes}-${runEnd[i] ?? i}`}
            showNote={runEnd[i] === i}
          />
        ))}
      </div>
    </>
  );
}

/**
 * The folded sheet's one line: the question, after the time left on Claude's countdown when there is
 * one. The question is the terminal's own text: only the fixed words before it name the machine (`at`).
 */
export function peekOf(d: TerminalDialog, ticking: number | null, at: (text: string) => string = (t) => t): string {
  if (d.blocksIn === undefined) return d.question;
  const left = ticking === null ? (tickingSeconds(d.blocksIn) === null ? d.blocksIn : null) : ticking > 0 ? leftWords(ticking) : null;
  return left === null ? `${at('Blocked at the Mac by now')} · ${d.question}` : `${left} left · ${d.question}`;
}

/** A line about the last tap: what the Mac showed after it (ink), or an error (InlineError, as the Mac said it). */
function TapLine({ line, at }: { line: AnswerLine | null; at: (text: string) => string }) {
  if (!line) return null;
  if (line.error) return <InlineError error={line.text} />;
  return (
    <p role="status" className="mt-12 type-small text-ink-2">
      {MACHINE_LINES.has(line.text) ? at(line.text) : line.text}
    </p>
  );
}

export function TermDialogDock({ sid, session, subagent, screen: read, phone, age, late, sends, onShowOnMac, machine }: TermDialogDockProps) {
  const offline = useApp((s) => s.conn.status === 'offline');
  const hubBlock = useAnswerBlock();
  // v0.6: a server's dialog is answered there, under its own Controls switch; this device's scope still counts.
  const nodeBlock = useApp((s) =>
    session.node === undefined || sessionFeatures(s.state, session).controls ? null : controlsOffOn(machineName(s.state, session.node)),
  );
  const block = session.node === undefined || hubBlock === NO_CONTROL_SCOPE ? hubBlock : nodeBlock;
  const { busy, line, renewed, answer } = useDialogAnswer(sid, read, sends);
  const dialog = read.screen?.dialog ?? null;
  const ticking = useCountdown(read.seq, dialog?.blocksIn);
  const left = ticking ?? (dialog?.blocksIn ? countdownSecondsOf(dialog.blocksIn) : null);
  /** The countdown as the read showed it, when it ticks: one that goes up is another ask. */
  const clock = tickingSeconds(dialog?.blocksIn);
  const lineFor = (fingerprint: string | null) => (line && line.for === fingerprint ? line : null);
  const at = (text: string) => atMachine(text, machine);
  // The last dialog shown. Another title, body, tab bar or description under the same rows (`twin`),
  // a new fingerprint under the very same drawing (something off the phone changed), or a next
  // dialog an answer reported that looks just like the one answered (`renewed`) starts the view
  // afresh (`n`), body open, with a line saying so until the next tap; so does Claude's countdown
  // going up under the same fingerprint (only another ask counts up). Ticks and the pointer moving
  // keep the view. Set while rendering, so no frame shows the new dialog in the old view.
  const full = dialog ? whole(dialog) : null;
  const [seen, setSeen] = useState<{
    id: string;
    full: string;
    fp: string;
    drawn: string;
    n: number;
    twin: boolean;
    note: boolean;
    renewed: string | null;
    clock: number | null;
  } | null>(null);
  if (dialog && full !== null && seen?.full !== full) {
    const id = identity(dialog);
    const twin = seen !== null && seen.id === id;
    setSeen({ id, full, fp: dialog.fingerprint, drawn: drawn(dialog), n: (seen?.n ?? 0) + (twin ? 1 : 0), twin, note: twin, renewed: null, clock });
  } else if (dialog && seen !== null && renewed === dialog.fingerprint && seen.renewed !== renewed) {
    setSeen({ ...seen, fp: dialog.fingerprint, drawn: drawn(dialog), n: seen.n + 1, twin: true, note: true, renewed, clock });
  } else if (dialog && seen !== null && seen.fp !== dialog.fingerprint) {
    const now = drawn(dialog);
    const hidden = now === seen.drawn;
    setSeen(hidden ? { ...seen, fp: dialog.fingerprint, n: seen.n + 1, twin: true, note: true, clock } : { ...seen, fp: dialog.fingerprint, drawn: now, clock });
  } else if (dialog && seen !== null && seen.clock !== clock) {
    const up = seen.clock !== null && clock !== null && clock > seen.clock;
    setSeen(up ? { ...seen, n: seen.n + 1, twin: true, note: true, clock } : { ...seen, clock });
  }
  const changed = seen !== null && seen.full === full;
  // A row that appeared (or changed, a tick or the fingerprint included) under the finger a moment
  // ago was not the one the user chose.
  const guard = useTapGuard(dialog && full !== null ? `${seen?.n ?? 0}\n${full}\n${dialog.fingerprint}` : null);
  /** The fingerprint of the dialog a tap was just dropped on. */
  const [dropped, setDropped] = useState<string | null>(null);
  /** The fingerprint of the dialog last tapped: any other dialog shown after it takes focus on its question. */
  const [tappedOn, setTappedOn] = useState<string | null>(null);
  const actions = onShowOnMac ? (
    <Actions phone={phone}>
      <Button size={phone ? 'xl' : 'lg'} className={phone ? 'flex-1' : undefined} onClick={onShowOnMac}>
        Show on {machine ?? 'Mac'}
      </Button>
    </Actions>
  ) : null;
  // A tall dialog scrolls inside the phone sheet, so the transcript above keeps some room.
  const scroll = phone ? 'max-h-480 overflow-y-auto overscroll-contain' : undefined;

  if (dialog) {
    const asker = askedBy(dialog, subagent);
    return (
      <DockFrame
        phone={phone}
        title={asker ? subagentTitle(asker) : `${machine ?? 'Claude'} asks · ${headWord(dialog)}`}
        age={age}
        late={late}
        peek={peekOf(dialog, ticking, at)}
      >
        <div className={scroll}>
          <DialogView
            key={`${identity(dialog)}\n${seen?.n ?? 0}`}
            d={dialog}
            phone={phone}
            off={offline || block !== null || busy !== null}
            busy={busy}
            showBody={changed && Boolean(seen?.twin)}
            focusQuestion={tappedOn !== null && tappedOn !== dialog.fingerprint}
            left={left}
            at={at}
            onTap={(tap) => {
              if (guard.check()) {
                setDropped(dialog.fingerprint);
                return;
              }
              setDropped(null);
              setTappedOn(dialog.fingerprint);
              setSeen((x) => (x ? { ...x, note: false } : x));
              void answer(dialog, tap);
            }}
          />
          <TapLine
            at={at}
            line={
              lineFor(dialog.fingerprint) ??
              (changed && seen?.note ? { text: CHANGED, error: false, for: dialog.fingerprint } : null) ??
              (dropped === dialog.fingerprint ? { text: TAP_DROPPED, error: false, for: dialog.fingerprint } : null)
            }
          />
          {read.error ? <p className="mt-12 type-small text-ink-2">{read.error}</p> : null}
          {block ? <p className="mt-12 type-small text-ink-2">{block}</p> : null}
          <OfflineLine offline={offline} />
          {actions}
        </div>
      </DockFrame>
    );
  }

  if (read.answered !== null) {
    return (
      <DockFrame phone={phone} title={subagent ? subagentTitle(subagent) : 'Claude asks'} glyph="working" age={age} late={false} peek={`Answered · ${read.answered}`}>
        <p role="status" className="mt-8 type-body text-ink wrap-break-word">
          Answered · {read.answered}
        </p>
        {actions}
      </DockFrame>
    );
  }

  const screen = read.screen;
  // Claude's prompt box and no dialog (its session file still says waiting): nothing for the keys to answer.
  const ready = screen?.dialogNote === DIALOG_NOTES.promptBox;
  return (
    <DockFrame
      phone={phone}
      title={subagent ? subagentTitle(subagent) : 'Claude is waiting in the terminal'}
      age={age}
      late={late}
      peek={ready ? DIALOG_NOTES.promptBox : at('Use the keys, or answer it at the Mac')}
    >
      <div className={scroll}>
        {subagent ? <SubagentAsk p={subagent} /> : null}
        {screen ? <p className="mt-8 type-small text-ink-2">{screen.dialogNote ?? at(CANT_READ)}</p> : null}
        {screen ? (
          <TermBox text={boxText(screen.text)} label="Last lines of the terminal" className="mt-12 max-h-240" />
        ) : (
          <div className="mt-12 flex h-40 items-center">
            <Spinner active={read.busy} label="Reading the screen" />
          </div>
        )}
        {read.error ? <p className="mt-8 type-small text-ink-2">{read.error}</p> : null}
        <TapLine at={at} line={lineFor(null)} />
        {screen && !ready ? <Keypad sid={sid} screen={read} phone={phone} offline={offline} onSent={() => void read.load()} /> : null}
        {actions}
      </div>
    </DockFrame>
  );
}
