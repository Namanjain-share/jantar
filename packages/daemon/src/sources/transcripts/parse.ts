/**
 * Reading Claude Code transcript entries (one JSON object per JSONL line).
 *
 * Pure functions, ported from ccw's parse_tail with the stale-reply fix:
 * a reply is reported only when it comes after the newest user prompt, so an
 * interrupted turn (or one whose final entry has not been flushed yet) never
 * shows the previous turn's reply (ccw hazard 3.2).
 */
import type { SessionNow, TranscriptItem } from '@jantar/protocol';
import type { TranscriptTail } from '../../contracts.js';
import { toolDesc } from '../lib/text.js';
import { clip, firstLine, isObj, nonEmpty, str, toIso, type Obj } from '../lib/values.js';

export const NOW_TEXT_MAX = 500;
export const REPLY_TEXT_MAX = 8000;
export const AWAY_TEXT_MAX = 2000;
export const ERROR_TEXT_MAX = 500;
export const ITEM_TEXT_MAX = 20_000;

export function isSidechain(e: Obj): boolean {
  return e.isSidechain === true;
}

function content(e: Obj): unknown {
  return isObj(e.message) ? e.message.content : undefined;
}

function blocks(e: Obj): Obj[] {
  const c = content(e);
  return Array.isArray(c) ? c.filter(isObj) : [];
}

/** Text of a message: string content, or its text blocks joined. */
export function messageText(e: Obj): string | undefined {
  const c = content(e);
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return undefined;
  const parts = c.filter(isObj).flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []));
  return parts.length ? parts.join('\n') : undefined;
}

export type UserEntryClass =
  /** Typed by the user. */
  | 'typed'
  /** A slash command (`<command-name>/x</command-name>`). */
  | 'command'
  /** Another tagged input that starts a turn (task notification, bash input, ...). */
  | 'wrapped'
  /** Output of a local command: not a turn. */
  | 'output'
  /** "[Request interrupted by user]" */
  | 'interrupt';

const OUTPUT_TAGS = ['<local-command-stdout>', '<local-command-stderr>', '<local-command-caveat>', '<bash-stdout>', '<bash-stderr>'];

/** What a `user` entry is; null for tool results, meta and sidechain entries. */
export function classifyUser(e: Obj): { cls: UserEntryClass; text: string } | null {
  if (e.type !== 'user' || e.isMeta === true || isSidechain(e)) return null;
  const text = messageText(e);
  if (text === undefined || !text.trim()) return null;
  const t = text.trimStart();
  if (t.startsWith('[Request interrupted')) return { cls: 'interrupt', text };
  if (t.startsWith('<command-name>')) return { cls: 'command', text };
  if (OUTPUT_TAGS.some((tag) => t.startsWith(tag))) return { cls: 'output', text };
  if (t.startsWith('<')) return { cls: 'wrapped', text };
  return { cls: 'typed', text };
}

/** The prompt of a `queued_command` attachment (typed while Claude was busy). */
export function queuedPrompt(e: Obj): string | undefined {
  if (e.type !== 'attachment' || !isObj(e.attachment) || e.attachment.type !== 'queued_command') return undefined;
  const p = e.attachment.prompt;
  if (typeof p === 'string') return p;
  if (Array.isArray(p)) {
    const parts = p.filter(isObj).flatMap((b) => (typeof b.text === 'string' ? [b.text] : []));
    return parts.length ? parts.join('\n') : undefined;
  }
  return undefined;
}

/** True for an entry that starts a turn: a prompt, a slash command, a fed-in queued prompt. */
export function isTurnStart(e: Obj): boolean {
  if (isSidechain(e)) return false;
  if (queuedPrompt(e) !== undefined) return true;
  const u = classifyUser(e);
  return u !== null && (u.cls === 'typed' || u.cls === 'command' || u.cls === 'wrapped');
}

/** "/compact keep the tests" from Claude's `<command-name>` wrapper. */
export function commandText(text: string): string {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim() ?? '';
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
  return [name, args].filter(Boolean).join(' ') || text;
}

export function isApiError(e: Obj): boolean {
  return e.type === 'assistant' && e.isApiErrorMessage === true;
}

/** An API error entry's text (its first line), or its error code. */
export function apiErrorText(e: Obj): string {
  return firstLine(messageText(e)) || str(e.error) || 'API error';
}

// ---------------------------------------------------------------------------
// Tail summary

/** Entries by index, oldest first; parsed on demand (a tail window can hold thousands of lines). */
export interface EntrySource {
  readonly length: number;
  get(i: number): Obj | null;
}

export function arraySource(entries: readonly Obj[]): EntrySource {
  return { length: entries.length, get: (i) => entries[i] ?? null };
}

/** Parse a JSONL line; null for blank lines, bad JSON or non-objects. */
export function parseLine(line: Buffer | string): Obj | null {
  const text = typeof line === 'string' ? line : line.toString('utf8');
  if (!text.trim()) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

export interface TailScan {
  tail: TranscriptTail;
  /** Looking further back could still fill `now` or `lastUserPromptAt`. */
  wantMore: boolean;
}

/**
 * Summarise a transcript tail. `entries` are oldest first (as in the file).
 * `fallbackAt` stands in for a missing entry timestamp.
 */
export function summarizeTail(entries: readonly Obj[] | EntrySource, fallbackAt: string): TailScan {
  const src: EntrySource = Array.isArray(entries) ? arraySource(entries as readonly Obj[]) : (entries as EntrySource);
  let now: SessionNow | undefined;
  let lastReply: { text: string; at: string } | undefined;
  let lastUserPromptAt: string | undefined;
  let mode: string | undefined;
  let away: string | undefined;
  let errorLast: string | undefined;
  let errorChecked = false;
  let promptSeen = false;

  for (let i = src.length - 1; i >= 0; i--) {
    const e = src.get(i);
    if (!e || isSidechain(e)) continue;
    const at = toIso(e.timestamp) ?? fallbackAt;

    if (isApiError(e)) {
      // only the newest one matters, and only if nothing was said or done after it
      if (!errorChecked) {
        errorChecked = true;
        if (!now && !lastReply && !promptSeen) errorLast = clip(apiErrorText(e), ERROR_TEXT_MAX);
      }
      continue;
    }
    if (e.type === 'permission-mode') {
      mode ??= nonEmpty(e.permissionMode);
    } else if (e.type === 'system' && e.subtype === 'away_summary') {
      const c = nonEmpty(e.content);
      if (c) away ??= clip(c, AWAY_TEXT_MAX);
    } else if (e.type === 'assistant') {
      const bs = blocks(e);
      for (let j = bs.length - 1; j >= 0; j--) {
        const b = bs[j] as Obj;
        if (b.type === 'tool_use') {
          const name = str(b.name) ?? '';
          now ??= { kind: 'tool', tool: name, text: clip(toolDesc(name, b.input), NOW_TEXT_MAX) };
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          now ??= { kind: 'said', text: clip(b.text.trim(), NOW_TEXT_MAX) };
          // a reply counts only if it is newer than the newest prompt
          if (!promptSeen) lastReply ??= { text: clip(b.text.trim(), REPLY_TEXT_MAX), at };
        }
      }
    } else if (!promptSeen && isTurnStart(e)) {
      promptSeen = true;
      lastUserPromptAt = at;
      const u = classifyUser(e);
      if (u?.cls === 'typed') now ??= { kind: 'prompt', text: clip(u.text.trim(), NOW_TEXT_MAX) };
      if (u?.cls === 'command') now ??= { kind: 'prompt', text: clip(commandText(u.text), NOW_TEXT_MAX) };
    }
    if (now && mode && promptSeen) break;
  }

  const tail: TranscriptTail = {};
  if (now) tail.now = now;
  if (lastReply) tail.lastReply = lastReply;
  if (lastUserPromptAt) tail.lastUserPromptAt = lastUserPromptAt;
  if (mode) tail.mode = mode;
  if (away) tail.away = away;
  if (errorLast) tail.errorLast = errorLast;
  return { tail, wantMore: !now || !promptSeen };
}

// ---------------------------------------------------------------------------
// Transcript page items (v0.1: text only)

/** Display items for one entry, oldest first. `offset` is the line's byte offset. */
export function itemsFromEntry(e: Obj, offset: number): TranscriptItem[] {
  if (isSidechain(e)) return [];
  const base = nonEmpty(e.uuid) ?? `@${offset}`;
  const at = toIso(e.timestamp);
  const out: Omit<TranscriptItem, 'id'>[] = [];
  const push = (it: Omit<TranscriptItem, 'id' | 'at'>) => out.push(at ? { ...it, at } : it);

  if (isApiError(e)) {
    push({ role: 'system', kind: 'meta', text: clip(messageText(e) ?? apiErrorText(e), ITEM_TEXT_MAX) });
  } else if (e.type === 'assistant') {
    for (const b of blocks(e)) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        push({ role: 'assistant', kind: 'text', text: clip(b.text, ITEM_TEXT_MAX) });
      } else if (b.type === 'tool_use') {
        const name = str(b.name) ?? 'tool';
        push({ role: 'assistant', kind: 'tool_use', tool: name, text: clip(toolDesc(name, b.input), ITEM_TEXT_MAX) });
        // v0.4.2: the plan itself, so the Transcript holds what a plan approval asks about.
        const plan = name === 'ExitPlanMode' && isObj(b.input) ? b.input.plan : undefined;
        if (typeof plan === 'string' && plan.trim()) push({ role: 'assistant', kind: 'text', text: clip(plan, ITEM_TEXT_MAX) });
      }
    }
  } else if (e.type === 'user') {
    const u = classifyUser(e);
    if (u) {
      if (u.cls === 'typed') push({ role: 'user', kind: 'text', text: clip(u.text, ITEM_TEXT_MAX) });
      else if (u.cls === 'command') push({ role: 'user', kind: 'text', text: clip(commandText(u.text), ITEM_TEXT_MAX) });
      else push({ role: 'system', kind: 'meta', text: clip(u.text, ITEM_TEXT_MAX) });
    }
  } else if (queuedPrompt(e) !== undefined) {
    push({ role: 'user', kind: 'queued', text: clip(queuedPrompt(e) ?? '', ITEM_TEXT_MAX) });
  } else if (e.type === 'system' && e.subtype === 'away_summary' && nonEmpty(e.content)) {
    push({ role: 'system', kind: 'meta', text: clip(String(e.content), ITEM_TEXT_MAX) });
  }
  return out.map((it, i) => ({ ...it, id: out.length > 1 ? `${base}:${i}` : base }));
}
