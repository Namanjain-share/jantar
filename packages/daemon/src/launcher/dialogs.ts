/**
 * The dialogs a new session can open with, and what the launcher does about
 * each (spec 4.5.5, U8). Ported from the legacy ccw tool's `startup_answer`
 * (the maintainer's own code), widened so anything it does not answer
 * becomes a "needs you" card instead of a stuck launch.
 *
 *   Dialog                                   Action
 *   Trust this folder                        card, always (U8: no auto-trust)
 *   Claude in Chrome intro (nothing to pick) auto: Return
 *   "Claude Code can't start this session    auto: "Retry now" once, then a card
 *    yet"
 *   Newer-model offer ("Keep ...")           auto: keep
 *   Bypass-permissions warning               card, never auto
 *   Login screen                             fail: "07 needs a re-login on the Mac (cswap)"
 *   Anything else                            card with Claude's own options
 *
 * Answering is ccw's cursor check: re-read the screen, check the title and
 * the option, wait 1 s after the dialog first showed (keys typed within
 * ~250 ms of its first frame are dropped), then move the pointer. The keys
 * are the arrows to the option, or the `enter` key when it is already
 * highlighted, sent in one write through the backend's pressKey.
 *
 * The trailing byte: Terminal's `do script` ends every write with its own
 * line feed, and in Claude's menus that line feed is the Return. ccw's
 * startup_answer relies on it (an arrow alone, or `do script ""` for the
 * highlighted option), so KEY_BYTES.enter is "" and an `enter` press is that
 * line feed alone. With "\r" it would be two Returns, the second landing on
 * the next startup screen (the bypass warning's "No, exit", or a trust
 * dialog's "Yes", which U8 forbids). Spike S1 still confirms it on this Mac;
 * if Claude ever ignored the line feed, the arrows would only move the
 * pointer and the dialog would stay up (the launcher shows it again after
 * sameTitleMs), which fails safe.
 *
 * Titles, options and screen tails leave this module masked (e-mail
 * addresses, tokens) and clipped; the title and options travel in
 * launch.progress events because the card needs them.
 */
import { maskEmail } from '@jantar/protocol';
import { acct } from '../notify/format.js';
import { lastLines, readScreenState, screenLines, unframe, type ScreenState } from '../terminal/screen.js';

export type StartupDialogKind = 'trust' | 'chrome' | 'retry' | 'keep-model' | 'bypass' | 'login' | 'unknown';

export interface StartupDialog {
  kind: StartupDialogKind;
  /** Masked, at most 120 characters. */
  title: string;
  /** Claude's own labels in Claude's order (numbering stripped); ["Continue"] when there is nothing to pick. */
  options: string[];
  /** The highlighted option. */
  current: number;
  /** Nothing to pick: answering is a bare Return. */
  bare: boolean;
}

export type DialogAction = { act: 'auto'; option: number } | { act: 'card' } | { act: 'fail'; reason: string };

export type AnswerKeys = { key: 'enter' } | { key: 'up' | 'down'; repeat: number };

const LOGIN_RE = /\b(?:select login method|please run \/login|log ?in to (?:your )?(?:anthropic|claude)|oauth token (?:has )?expired|invalid api key)\b/iu;
const TRUST_RE = /\b(?:trust this folder|do you trust the files|is this a project you created or one you trust|accessing workspace)\b/iu;
const BYPASS_RE = /\bbypass permissions mode\b/iu;
const CHROME_RE = /^(?:Claude in Chrome works with|For more info, use \/chrome)/mu;
const RETRY_TITLE_RE = /\bcan['’]t start this session yet\b/iu;
const KEEP_CONTEXT_RE = /\b(?:model|resuming)\b/iu;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu;
/** API keys and tokens: known prefixes, or a long run of base64 / hex characters with letters and digits. */
const TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[abpr]-[A-Za-z0-9-]{8,}|(?=[A-Za-z0-9_+=-]*\d)(?=[A-Za-z0-9_+=-]*[A-Za-z])[A-Za-z0-9_+=-]{32,})/gu;

/** How many screen lines a launch keeps for its receipt and card. */
export const SCREEN_TAIL_LINES = 6;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** E-mail addresses and tokens masked. */
export function maskScreen(text: string): string {
  return text.replace(EMAIL_RE, (m) => maskEmail(m)).replace(TOKEN_RE, '[token]');
}

/** The last few screen lines, masked: launchGet's screenTail (never in events, audit rows or logs). */
export function screenTail(text: string, n = SCREEN_TAIL_LINES): string {
  return lastLines(text, n)
    .map((l) => clip(maskScreen(l), 200))
    .join('\n');
}

function label(option: string): string {
  return clip(maskScreen(option.replace(/^\d+[.)]\s+/u, '').trim()), 120);
}

/** The region a startup dialog sits in: below the input box, or the bottom of the screen when there is none. */
function region(state: ScreenState): string {
  const lines = state.inputBox ? state.lines.slice(state.inputBox.end + 1) : state.lines.slice(-25);
  return lines.map(unframe).join('\n');
}

/** Read a new session's screen: the screen state and the startup dialog on it, if any. */
export function readStartupScreen(text: string): { state: ScreenState; dialog: StartupDialog | null } {
  const state = readScreenState(text);
  const body = region(state);
  if (LOGIN_RE.test(body)) {
    const title = state.dialog?.title ?? screenLines(body).find((l) => LOGIN_RE.test(l)) ?? 'Log in';
    return { state, dialog: { kind: 'login', title: clip(maskScreen(title.trim()), 120), options: [], current: 0, bare: true } };
  }
  const found = state.dialog;
  if (!found) return { state, dialog: null };
  const raw = found.options ?? [];
  const options = raw.map(label);
  const title = clip(maskScreen(found.title), 120);
  const bare = options.length === 0;
  const dialog: StartupDialog = {
    kind: 'unknown',
    title,
    options: bare ? ['Continue'] : options,
    current: bare ? 0 : Math.max(0, Math.min(options.length - 1, found.current ?? 0)),
    bare,
  };
  const has = (re: RegExp) => options.some((o) => re.test(o));
  if (BYPASS_RE.test(body) || has(/^yes, i accept$/iu)) dialog.kind = 'bypass';
  else if (has(/^yes, i trust this folder$/iu) || TRUST_RE.test(body)) dialog.kind = 'trust';
  else if (bare && (found.title === 'Claude in Chrome' || CHROME_RE.test(body))) dialog.kind = 'chrome';
  else if (RETRY_TITLE_RE.test(body) && has(/^retry now$/iu)) dialog.kind = 'retry';
  else if (has(/^keep\b/iu) && KEEP_CONTEXT_RE.test(body)) dialog.kind = 'keep-model';
  return { state, dialog };
}

/** What to do about a dialog. `retried`: how often "Retry now" was already chosen for this launch. */
export function dialogAction(d: StartupDialog, opts: { retried: number; account: number }): DialogAction {
  switch (d.kind) {
    case 'login':
      return { act: 'fail', reason: `${acct(opts.account)} needs a re-login on the Mac (cswap)` };
    case 'chrome':
      return { act: 'auto', option: 0 };
    case 'retry':
      return opts.retried < 1 ? { act: 'auto', option: d.options.findIndex((o) => /^retry now$/iu.test(o)) } : { act: 'card' };
    case 'keep-model':
      return { act: 'auto', option: d.options.findIndex((o) => /^keep\b/iu.test(o)) };
    case 'trust':
    case 'bypass':
    case 'unknown':
      return { act: 'card' };
  }
}

/** The keys that choose `option` from the highlighted one (see spike S1 above for what `enter` types). */
export function answerKeys(d: Pick<StartupDialog, 'current' | 'bare'>, option: number): AnswerKeys {
  const steps = d.bare ? 0 : option - d.current;
  if (steps === 0) return { key: 'enter' };
  return { key: steps > 0 ? 'down' : 'up', repeat: Math.abs(steps) };
}

/** The phone's short question for a dialog push ("trust this folder?"). */
export function dialogQuestion(d: Pick<StartupDialog, 'kind' | 'title'>): string {
  if (d.kind === 'trust') return 'trust this folder?';
  if (d.kind === 'bypass') return 'run without permission checks?';
  return d.title;
}
