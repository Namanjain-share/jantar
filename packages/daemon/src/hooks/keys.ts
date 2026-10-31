/**
 * Small pure helpers for the hooks bridge: correlation keys, card kinds,
 * display copies of tool input and the one-line "now" summary.
 */
import { z } from 'zod';
import { QuestionSchema, type PendingKind, type Question } from '@jantar/protocol';
import { canonicalJson, sha256Hex } from '../core/hash.js';

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Card correlation key: `sid|tool_name|sha256(canonical JSON of tool_input)`.
 *
 * Same identity as `correlationKey()` in core/hash.ts (object keys sorted at
 * every level), with the input part hashed so a card for a large Write or
 * Edit does not carry its whole input twice on the event stream.
 */
export function cardKey(sid: string, tool: string, input: unknown): string {
  return `${sid}|${tool}|${sha256Hex(canonicalJson(input ?? {}))}`;
}

/** AskUserQuestion -> question, ExitPlanMode -> plan, anything else -> permission. */
export function kindForTool(tool: string): Exclude<PendingKind, 'subagent-info'> {
  if (tool === 'AskUserQuestion') return 'question';
  if (tool === 'ExitPlanMode') return 'plan';
  return 'permission';
}

/** A payload raised by a subagent (its hook runs before the terminal dialog). */
export function isSubagentPayload(p: { agent_id?: unknown }): boolean {
  return typeof p.agent_id === 'string' && p.agent_id.length > 0;
}

const QuestionsSchema = z.array(QuestionSchema).min(1);

/** `tool_input.questions` of an AskUserQuestion, or undefined when it has an unexpected shape. */
export function parseQuestions(input: unknown): Question[] | undefined {
  if (!isPlainObject(input)) return undefined;
  const r = QuestionsSchema.safeParse(input.questions);
  return r.success ? r.data : undefined;
}

export const DISPLAY_MAX_STRING = 16 * 1024;
const DISPLAY_MAX_ITEMS = 500;
const DISPLAY_MAX_DEPTH = 24;

/**
 * A copy of tool input that is safe to put on the event stream: long strings
 * are cut (a Write of a big file stays readable without carrying all of it),
 * long arrays shortened, deep nesting collapsed. The original input is kept
 * inside the bridge for decisions that must echo it.
 */
export function displayCopy(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') {
    return v.length > DISPLAY_MAX_STRING
      ? `${v.slice(0, DISPLAY_MAX_STRING)}… [${v.length - DISPLAY_MAX_STRING} more characters]`
      : v;
  }
  if (v === null || typeof v !== 'object') return v;
  if (depth >= DISPLAY_MAX_DEPTH) return '[…]';
  if (Array.isArray(v)) {
    const out = v.slice(0, DISPLAY_MAX_ITEMS).map((x) => displayCopy(x, depth + 1));
    if (v.length > DISPLAY_MAX_ITEMS) out.push(`[${v.length - DISPLAY_MAX_ITEMS} more items]`);
    return out;
  }
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => [k, displayCopy(x, depth + 1)]),
  );
}

/** Collapse whitespace and cut to `max` characters. */
export function oneLine(text: string, max = 200): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** What a PreToolUse is doing, for `session.now` ("Running Bash: <this>"). */
export function toolSummary(tool: string, input: unknown): string {
  const i = isPlainObject(input) ? input : {};
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = i[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return '';
  };
  let text: string;
  switch (tool) {
    case 'Bash':
      text = pick('command', 'description');
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      text = pick('file_path', 'notebook_path', 'path');
      break;
    case 'Glob':
    case 'Grep':
      text = pick('pattern', 'path');
      break;
    case 'WebFetch':
      text = pick('url');
      break;
    case 'WebSearch':
      text = pick('query');
      break;
    case 'Task':
    case 'Agent':
      text = pick('description', 'subagent_type');
      break;
    default:
      text = pick('description', 'command', 'file_path', 'path', 'url', 'query', 'pattern');
  }
  return oneLine(text);
}

/** Error detail of a StopFailure / PostToolUseFailure as one short line. */
export function errorText(err: unknown): string | undefined {
  if (err === undefined || err === null) return undefined;
  if (typeof err === 'string') return err.trim() ? oneLine(err, 300) : undefined;
  if (isPlainObject(err)) {
    for (const k of ['message', 'error', 'type']) {
      const v = err[k];
      if (typeof v === 'string' && v.trim()) return oneLine(v, 300);
    }
  }
  try {
    return oneLine(JSON.stringify(err), 300);
  } catch {
    return undefined;
  }
}
