/**
 * Alert detection in transcript entries (ccw's Alerts.poll, ported).
 *
 * - blocked:  an is_error tool_result saying auto mode, a safety check, a
 *             deny rule or a PreToolUse hook refused the tool call;
 * - rejected: the user said no in the terminal;
 * - limit:    an API error entry flagged `error: "rate_limit"`;
 * - error:    any other API error entry.
 *
 * v0.10.2, a stopped call is not a rejection. Claude Code writes the same
 * "The user doesn't want to proceed with this tool use" record (top-level
 * `toolUseResult: "User rejected tool use"`) for a "No" at the permission
 * dialog with nothing typed and for any call it stops: Esc on a running
 * call, TaskStop, a stop from the UI, a shutdown. Without proof of a dialog
 * that record is read as a stop and makes no alert:
 * - proof of a rejection: words typed for Claude ("the user said:"), a
 *   `toolUseResult` that starts "Error: ", or a `permissionDecision` of
 *   reject by the user;
 * - a stop: the record is in a subagent's or workflow agent's transcript
 *   (or is a sidechain entry), or the session's permission mode then was one
 *   that shows no permission dialog (bypassPermissions, auto, dontAsk),
 *   except for AskUserQuestion and ExitPlanMode, whose dialogs show in every
 *   mode;
 * - otherwise (default, plan, acceptEdits or no mode known) it stays a
 *   rejection, as before: a "No" and an Esc on a running call look alike.
 * A record Claude Code itself marks "stopped while running, not refused"
 * (a remote cancel of a running call) is a stop in every mode.
 *
 * The match strings are Claude Code's own messages; they are used only to
 * recognise them.
 */
import type { AlertKind } from '@jantar/protocol';
import { toolDesc } from '../lib/text.js';
import { clip, firstLine, isObj, str, toEpochMs, type Obj } from '../lib/values.js';
import { apiErrorText, isApiError, messageText } from './parse.js';

interface Denial {
  kind: Extract<AlertKind, 'blocked' | 'rejected'>;
  /** Short label ("auto mode blocked"). */
  label: string;
  re: RegExp;
  /** Claude Code writes these words for a call it stopped too (see the top of this file). */
  alsoStop?: true;
}

const DENIALS: readonly Denial[] = [
  {
    kind: 'blocked',
    label: 'auto mode blocked',
    re: /^Permission for this \w+ was denied by the Claude Code auto mode classifier\. Reason: ([\s\S]+?)(?:\. If you have|$)/,
  },
  {
    kind: 'blocked',
    label: 'safety check blocked',
    re: /^Permission for this \w+ was denied by a built-in Claude Code safety check[^.]*\.\s*([\s\S]*?)(?:\.|$)/,
  },
  { kind: 'blocked', label: 'deny rule blocked', re: /^Permission to use [\s\S]+? has been denied/ },
  // A PreToolUse hook, in Claude Code 2.1's words: "PreToolUse:<tool> hook error: " and then "[<command>]: <stderr>"
  // (exit code 2) or the hook's reason; "Hook PreToolUse:<tool> denied this tool" for a deny without a reason;
  // "Execution stopped by PreToolUse hook" when it also stopped the turn.
  { kind: 'blocked', label: 'hook blocked', re: /^PreToolUse:\S+ hook error: (?:\[(?:[^[\]]|\[[^[\]]*\])*\]: )?\s*([\s\S]*)/ },
  { kind: 'blocked', label: 'hook blocked', re: /^Hook PreToolUse:\S+ denied this tool/ },
  { kind: 'blocked', label: 'hook blocked', re: /^Execution stopped by PreToolUse hook(?:: ([\s\S]+))?/ },
  {
    kind: 'rejected',
    label: 'you rejected',
    re: /^The user doesn't want to proceed with this tool use[\s\S]*?(?:the user said:\s*([\s\S]+))?$/,
    alsoStop: true,
  },
  // A subagent's permission prompt, or a safety-check prompt, the user said no to. With words typed,
  // Claude Code 2.1.316 writes "… The user said:\n<words>" here (capital T), "… the user said:" in the main thread.
  {
    kind: 'rejected',
    label: 'you rejected',
    re: /^Permission for this tool use was denied\. The tool use was rejected[\s\S]*?(?:[Tt]he user said:\s*([\s\S]+))?$/,
  },
];

/**
 * What Claude Code adds after a rejection when its corrections note is on;
 * it is for the model, so it is left out of the alert.
 */
const CORRECTION_NOTE = /\n\nNote: The user['\u2019]s next message may contain a correction[\s\S]*$/;

/**
 * What Claude Code (2.1.31x) adds to that record for a running call stopped
 * by a remote cancel: it says no permission prompt was involved, so the
 * record is a stop in every mode.
 */
const STOPPED_NOT_REFUSED = 'Correction to the text above: this call was stopped while running, not refused';

/** Tools whose dialog shows in every permission mode: a stopped one was a dialog the user dismissed. */
const ALWAYS_ASKS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** Permission modes that show no permission dialog for an ordinary tool call. */
const NO_PROMPT_MODES: ReadonlySet<string> = new Set(['bypassPermissions', 'auto', 'dontAsk']);

/** The entry proves that a person said no at a dialog (Claude Code 2.1.29x and later record it). */
function provenRejection(e: Obj, said: boolean): boolean {
  if (said) return true;
  const r = e.toolUseResult;
  if (typeof r === 'string' && r.startsWith('Error: ')) return true;
  const d = e.permissionDecision;
  return isObj(d) && d.decision === 'reject' && (d.source === 'user_reject' || d.source === 'user_abort');
}

function findDenial(text: string): { denial: Denial; m: RegExpExecArray } | null {
  for (const denial of DENIALS) {
    const m = denial.re.exec(text);
    if (m) return { denial, m };
  }
  return null;
}

/**
 * What an `is_error` tool_result's text says happened to the call: blocked
 * (auto mode, a safety check or a deny rule), rejected (the user said no in
 * the terminal), or null for any other error. The changed-files scanner uses
 * it for an op's status, with the text from `toolResultText`. Text alone
 * cannot tell a "No" from a stopped call, so a stopped call reads rejected
 * here; the alert scanner tells them apart.
 */
export function denialKind(text: string): Extract<AlertKind, 'blocked' | 'rejected'> | null {
  return findDenial(text.trimStart())?.denial.kind ?? null;
}

export interface FoundAlert {
  kind: AlertKind;
  /** Epoch ms of the entry. */
  at: number;
  /** One line: what happened ("auto mode: Bash · rm -rf build", "hit a limit"). */
  what: string;
  why?: string;
  full?: string;
  /** Stable within a transcript: entry uuid (or byte offset) plus the block index. */
  key: string;
}

export const FULL_TEXT_MAX = 2000;

/** A tool_result block's text: its string content, or its text parts joined with spaces. */
export function toolResultText(block: Obj): string {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(isObj).map((b) => (typeof b.text === 'string' ? b.text : '')).join(' ');
  return '';
}

/** ccw: `next(iter(why.strip("[]. ").splitlines()), "")` */
function tidyWhy(s: string): string {
  return firstLine(s.replace(/^[[\]. ]+|[[\]. ]+$/g, ''));
}

export interface AlertScannerOptions {
  /** A subagent's or workflow agent's own transcript: a stopped call there is never "you rejected". */
  agent?: boolean;
  /** The session's permission mode now, for a stopped call read before the transcript names a mode. */
  mode?: () => string | undefined;
}

/**
 * Tracks tool_use ids -> names and descriptions across reads of one
 * transcript, so a denial can say which call it refused, and the permission
 * mode the transcript last named.
 */
export class AlertScanner {
  private readonly tools = new Map<string, { name: string; desc: string }>();
  private mode: string | undefined;

  constructor(readonly options: AlertScannerOptions = {}) {}

  /** Alerts in one entry. `offset` identifies entries without a uuid. `fallbackMs` stands in for a missing timestamp. */
  scan(e: Obj, offset: number, fallbackMs: number): FoundAlert[] {
    this.noteMode(e);
    const content = isObj(e.message) ? e.message.content : undefined;
    if (!Array.isArray(content)) return [];
    const at = toEpochMs(e.timestamp) ?? fallbackMs;
    const id = str(e.uuid) ?? `@${offset}`;
    const out: FoundAlert[] = [];

    if (e.type === 'assistant') {
      content.forEach((b) => {
        if (isObj(b) && b.type === 'tool_use' && typeof b.id === 'string') {
          const name = str(b.name) ?? '';
          this.tools.set(b.id, { name, desc: toolDesc(name, b.input) });
        }
      });
      if (isApiError(e)) {
        const limit = e.error === 'rate_limit';
        const text = messageText(e)?.trim() ?? '';
        const found: FoundAlert = {
          kind: limit ? 'limit' : 'error',
          at,
          what: limit ? 'hit a limit' : 'API error',
          why: clip(apiErrorText(e), 300),
          key: `${id}#err`,
        };
        if (text) found.full = clip(text, FULL_TEXT_MAX);
        out.push(found);
      }
      this.trim();
      return out;
    }

    if (e.type === 'user') {
      content.forEach((b, i) => {
        if (!isObj(b) || b.type !== 'tool_result' || b.is_error !== true) return;
        const text = toolResultText(b).trimStart().replace(CORRECTION_NOTE, '');
        const hit = findDenial(text);
        if (!hit) return;
        const { denial: d, m } = hit;
        const call = typeof b.tool_use_id === 'string' ? this.tools.get(b.tool_use_id) : undefined;
        if (d.alsoStop && text.includes(STOPPED_NOT_REFUSED)) return;
        if (d.alsoStop && !provenRejection(e, !!m[1]?.trim()) && this.stopped(e, call?.name ?? '')) return;
        const tool = call?.desc ?? '';
        const what =
          d.kind === 'blocked'
            ? tool
              ? `${d.label.replace(' blocked', '')}: ${tool}`
              : d.label
            : tool
              ? `${d.label}: ${tool}`
              : d.label;
        const found: FoundAlert = { kind: d.kind, at, what: clip(what, 300), key: `${id}#${i}` };
        const why = tidyWhy(m[1] ?? '');
        if (why) found.why = clip(why, 300);
        found.full = clip(text, FULL_TEXT_MAX);
        out.push(found);
      });
    }
    return out;
  }

  /** Main-conversation entries name the permission mode: a `permission-mode` row, and `permissionMode` on a prompt. */
  private noteMode(e: Obj): void {
    if (this.options.agent || e.isSidechain === true) return;
    if (e.type !== 'permission-mode' && e.type !== 'user') return;
    const mode = str(e.permissionMode)?.trim();
    if (mode) this.mode = mode;
  }

  /** A "you rejected" record without proof of a dialog: was the call stopped instead? */
  private stopped(e: Obj, tool: string): boolean {
    if (this.options.agent || e.isSidechain === true) return true;
    if (ALWAYS_ASKS.has(tool)) return false;
    const mode = this.mode ?? this.options.mode?.();
    return mode !== undefined && NO_PROMPT_MODES.has(mode);
  }

  private trim(): void {
    if (this.tools.size <= 400) return;
    const keep = [...this.tools].slice(-200);
    this.tools.clear();
    for (const [k, v] of keep) this.tools.set(k, v);
  }
}
