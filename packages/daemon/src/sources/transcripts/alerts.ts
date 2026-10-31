/**
 * Alert detection in transcript entries (ccw's Alerts.poll, ported).
 *
 * - blocked:  an is_error tool_result saying auto mode, a safety check, a
 *             deny rule or a PreToolUse hook refused the tool call;
 * - rejected: the user said no in the terminal;
 * - limit:    an API error entry flagged `error: "rate_limit"`;
 * - error:    any other API error entry.
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
  },
];

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
 * it for an op's status, with the text from `toolResultText`.
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

/**
 * Tracks tool_use ids -> descriptions across reads of one transcript, so a
 * denial can say which call it refused.
 */
export class AlertScanner {
  private readonly tools = new Map<string, string>();

  /** Alerts in one entry. `offset` identifies entries without a uuid. `fallbackMs` stands in for a missing timestamp. */
  scan(e: Obj, offset: number, fallbackMs: number): FoundAlert[] {
    const content = isObj(e.message) ? e.message.content : undefined;
    if (!Array.isArray(content)) return [];
    const at = toEpochMs(e.timestamp) ?? fallbackMs;
    const id = str(e.uuid) ?? `@${offset}`;
    const out: FoundAlert[] = [];

    if (e.type === 'assistant') {
      content.forEach((b) => {
        if (isObj(b) && b.type === 'tool_use' && typeof b.id === 'string') {
          this.tools.set(b.id, toolDesc(str(b.name) ?? '', b.input));
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
        const text = toolResultText(b).trimStart();
        const hit = findDenial(text);
        if (!hit) return;
        const { denial: d, m } = hit;
        const tool = (typeof b.tool_use_id === 'string' && this.tools.get(b.tool_use_id)) || '';
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

  private trim(): void {
    if (this.tools.size <= 400) return;
    const keep = [...this.tools].slice(-200);
    this.tools.clear();
    for (const [k, v] of keep) this.tools.set(k, v);
  }
}
