// Portions adapted from Shed (c) 2026 Sukhad Anand, MIT. See THIRD_PARTY_NOTICES.md
/**
 * Proof that Claude took a typed prompt, read from its transcript
 * (send-with-proof, step 5 in send.ts).
 *
 * Accepted, and only when read forward from the byte offset recorded before
 * typing and timestamped no earlier than typing-start minus 5 s:
 * - a `user` entry whose text is the prompt,
 * - an `attachment` of type `queued_command` (typed while Claude was busy),
 * - a `queue-operation` with operation `enqueue` (waiting in Claude's queue),
 *   but only once Claude takes it out of the queue (W9): a later `remove` or
 *   `dequeue` (of this text, or without text), or the `queued_command` /
 *   `user` entry it turns into. A later `popAll` (Esc or Up at the Mac puts
 *   the queue back into the input box) before that means it was not sent:
 *   `popped`. Until either, the enqueue is `queued`, which callers carry from
 *   one read to the next.
 * - for a slash command, the `<command-name>/x</command-name>` form with the
 *   same arguments.
 * Texts are compared whitespace-squashed and must be equal. A recorded text
 * that *ends* with the prompt but has extra text before it means the user's
 * unsent draft went out with it: that is still proof, flagged as merged.
 * When that extra text is itself our prompt, an earlier copy was still in the
 * box and the prompt went out twice: flagged as doubled.
 *
 * Not proof: a prefix match (the legacy tool matched 40 characters, so a
 * draft plus our text could pass), an identical prompt from before the
 * offset or older than the slack, and anything on screen.
 *
 * `contentText` and the forward-scan rules (tool_result blocks are not
 * typed text; sidechain rows are skipped; a 5 s slack) follow Shed's
 * `contentText` and `claudeTerminalProgress` in server/sessions.js.
 */
import type { SendProof } from '@jantar/protocol';
import type { TranscriptEntry } from '../contracts.js';
import { squash, type ExpectedPrompt } from './text.js';

export type ProofKind = SendProof['kind'];

/** How long before typing started an entry may be timestamped and still count. */
export const PROOF_SLACK_MS = 5000;

export interface PromptCandidate {
  kind: ProofKind;
  text: string;
  uuid?: string;
  timestamp?: string;
  offset: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The typed text of a message's content: a string, or its text blocks joined.
 * Claude records tool output as user-role `tool_result` blocks; those are not
 * something anyone typed, so content made only of them gives null.
 */
export function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (isObj(block) && block.type !== 'tool_result' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/** The prompt an entry records, if it is one of the three accepted kinds. */
export function promptCandidate(entry: TranscriptEntry): PromptCandidate | null {
  const raw = entry.raw;
  if (entry.isSidechain === true || raw.isSidechain === true) return null;
  const type = entry.type || (typeof raw.type === 'string' ? raw.type : '');
  let kind: ProofKind;
  let text: string | null;
  if (type === 'user') {
    if (raw.isMeta === true || raw.isCompactSummary === true) return null;
    if (!isObj(raw.message)) return null;
    kind = 'user';
    text = contentText(raw.message.content);
  } else if (type === 'attachment') {
    const a = raw.attachment;
    if (!isObj(a) || a.type !== 'queued_command') return null;
    kind = 'queued_command';
    text = contentText(a.prompt);
  } else if (type === 'queue-operation') {
    if (raw.operation !== 'enqueue') return null;
    kind = 'queue-operation';
    text = contentText(raw.content);
  } else {
    return null;
  }
  if (text === null) return null;
  const out: PromptCandidate = { kind, text, offset: entry.offset };
  const uuid = entry.uuid ?? (typeof raw.uuid === 'string' ? raw.uuid : undefined);
  if (uuid) out.uuid = uuid;
  const ts = entry.timestamp ?? (typeof raw.timestamp === 'string' ? raw.timestamp : undefined);
  if (ts) out.timestamp = ts;
  return out;
}

function commandForm(text: string): { name: string; args: string } | null {
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/u.exec(text)?.[1];
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/u.exec(text)?.[1] ?? '';
  return { name: name.startsWith('/') ? name : `/${name}`, args: squash(args) };
}

/**
 * Claude Code (2.1.31x) records a pasted prompt wrapped in
 * `<pasted_content id="…">` … `</pasted_content id="…">`. Jantar types long
 * prompts as a paste, so the recorded text is the prompt inside those tags:
 * the tags themselves are never part of what was typed.
 */
const PASTED_TAG_RE = /<\/?pasted_content(?:\s+id="[^"]*")?\s*>/gu;
export function unwrapPasted(text: string): string {
  return text.includes('pasted_content') ? text.replace(PASTED_TAG_RE, ' ') : text;
}

export type Comparison = 'exact' | 'merged' | 'doubled' | 'partial' | null;

/** Below this many characters a shorter recorded text isn't reported as "part of the prompt". */
const PARTIAL_MIN_CHARS = 8;

/**
 * How a recorded text relates to the prompt.
 * exact: equal (or the same slash command and arguments); merged: ends with
 * the prompt after extra leading text; doubled: merged, and that leading text
 * is (or ends with) the prompt again; partial: only a beginning of it.
 */
export function compareCandidate(text: string, expected: ExpectedPrompt): Comparison {
  const norm = squash(unwrapPasted(text));
  if (!norm || !expected.norm) return null;
  if (norm === expected.norm) return 'exact';
  const cmd = commandForm(text);
  if (cmd) {
    return expected.slash && cmd.name === expected.slash.name && cmd.args === expected.slash.args ? 'exact' : null;
  }
  if (norm.length > expected.norm.length && norm.endsWith(expected.norm)) {
    const lead = squash(norm.slice(0, norm.length - expected.norm.length));
    const again = lead === expected.norm || (expected.norm.length >= PARTIAL_MIN_CHARS * 2 && lead.endsWith(expected.norm));
    return again ? 'doubled' : 'merged';
  }
  if (norm.length >= PARTIAL_MIN_CHARS && norm.length < expected.norm.length && expected.norm.startsWith(norm)) {
    return 'partial';
  }
  return null;
}

export interface ProofOptions {
  /** Earliest acceptable entry time, epoch ms (typing start minus PROOF_SLACK_MS). */
  notBeforeMs: number;
  /** Refuse entries without a usable timestamp (when the read did not start at a recorded offset). */
  requireTimestamp: boolean;
  /** Used for `proof.at` when an entry has no timestamp. */
  nowIso: string;
}

export interface ProofHit {
  proof: SendProof;
  merged: boolean;
  /** The recorded text held the prompt twice (see compareCandidate). */
  doubled: boolean;
}

export interface ProofScan {
  /** Final proof. */
  hit: ProofHit | null;
  /** Our prompt is waiting in Claude's queue (an enqueue not yet taken out or popped): not proof yet. */
  queued: ProofHit | null;
  /** Our queued prompt was put back into the input box (popAll) and has not been sent since. */
  popped: boolean;
  /** A recorded prompt held only the beginning of ours. */
  partial: boolean;
  /** An identical prompt was found but is older than the slack (not proof). */
  stale: boolean;
}

/** A queue-operation other than enqueue: its operation and (if recorded) the text it concerns. */
function queueOp(entry: TranscriptEntry): { operation: string; text: string | null } | null {
  const raw = entry.raw;
  if (entry.isSidechain === true || raw.isSidechain === true) return null;
  const type = entry.type || (typeof raw.type === 'string' ? raw.type : '');
  if (type !== 'queue-operation' || typeof raw.operation !== 'string' || raw.operation === 'enqueue') return null;
  return { operation: raw.operation, text: raw.content === undefined ? null : contentText(raw.content) };
}

/** Whether a queue-operation's text (null: none recorded) is about our prompt. */
function concernsUs(text: string | null, expected: ExpectedPrompt): boolean {
  if (text === null) return true;
  const cmp = compareCandidate(text, expected);
  return cmp === 'exact' || cmp === 'merged' || cmp === 'doubled' || squash(text).includes(expected.norm);
}

/**
 * Look through entries (oldest first) for the first one that proves the
 * prompt. `queued` is a waiting enqueue found by an earlier read.
 */
export function scanForProof(
  entries: readonly TranscriptEntry[],
  expected: ExpectedPrompt,
  opts: ProofOptions,
  queued: ProofHit | null = null,
): ProofScan {
  let partial = false;
  let stale = false;
  let waiting = queued;
  let popped = false;
  for (const entry of entries) {
    const op = queueOp(entry);
    if (op) {
      if (!waiting || !concernsUs(op.text, expected)) continue;
      if (op.operation === 'popAll') {
        // Esc or Up at the Mac: the queue went back into the input box, unsent.
        waiting = null;
        popped = true;
      } else if (op.operation === 'remove' || op.operation === 'dequeue') {
        // Claude took it out of the queue: the enqueue now counts.
        return { hit: waiting, queued: null, popped: false, partial, stale };
      }
      continue;
    }
    const c = promptCandidate(entry);
    if (!c) continue;
    const cmp = compareCandidate(c.text, expected);
    if (!cmp) continue;
    if (cmp === 'partial') {
      partial = true;
      continue;
    }
    const ms = c.timestamp ? Date.parse(c.timestamp) : Number.NaN;
    if (Number.isNaN(ms)) {
      if (opts.requireTimestamp) continue;
    } else if (ms < opts.notBeforeMs) {
      stale = true;
      continue;
    }
    const proof: SendProof = { kind: c.kind, at: Number.isNaN(ms) ? opts.nowIso : new Date(ms).toISOString() };
    if (c.uuid) proof.uuid = c.uuid;
    const hit: ProofHit = { proof, merged: cmp === 'merged' || cmp === 'doubled', doubled: cmp === 'doubled' };
    if (c.kind === 'queue-operation') {
      // Waiting in Claude's queue: provisional until it is taken out (or popped back).
      waiting = hit;
      popped = false;
      continue;
    }
    return { hit, queued: null, popped: false, partial, stale };
  }
  return { hit: null, queued: waiting, popped, partial, stale };
}
