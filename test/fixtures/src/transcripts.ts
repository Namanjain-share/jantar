/**
 * Builders for synthetic Claude Code transcript entries (one JSON object per
 * JSONL line). Shapes follow what the daemon reads: user / assistant entries
 * with `message.content`, `attachment` entries of type queued_command,
 * `queue-operation` enqueue entries, permission-mode, system away_summary and
 * API error entries. Every value is made up.
 */

export type Entry = Record<string, unknown>;

export interface EntryContext {
  sessionId: string;
  cwd: string;
  /** Entry timestamp (ISO). */
  at: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
}

const VERSION = '2.1.300';

let counter = 0;
/** Deterministic uuid-shaped ids (reset with resetEntryIds()). */
export function entryId(): string {
  counter += 1;
  const hex = counter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}
export function resetEntryIds(): void {
  counter = 0;
}

/** Claude's project dir name for a cwd: every non-alphanumeric character becomes "-". */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function base(type: string, ctx: EntryContext): Entry {
  return {
    type,
    uuid: ctx.uuid ?? entryId(),
    parentUuid: ctx.parentUuid ?? null,
    timestamp: ctx.at,
    sessionId: ctx.sessionId,
    cwd: ctx.cwd,
    isSidechain: ctx.isSidechain ?? false,
    userType: 'external',
    version: VERSION,
  };
}

/** A typed prompt as Claude records it (string content). */
export function userPrompt(ctx: EntryContext, text: string): Entry {
  return { ...base('user', ctx), message: { role: 'user', content: text } };
}

/** A prompt in content-block form. */
export function userBlocks(ctx: EntryContext, text: string): Entry {
  return { ...base('user', ctx), message: { role: 'user', content: [{ type: 'text', text }] } };
}

/** A slash command as it lands in the transcript. */
export function slashCommand(ctx: EntryContext, command: string, args = ''): Entry {
  const name = command.startsWith('/') ? command : `/${command}`;
  return userPrompt(
    ctx,
    `<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>\n<command-args>${args}</command-args>`,
  );
}

/** A meta user entry (not a real prompt). */
export function metaUser(ctx: EntryContext, text: string): Entry {
  return { ...userPrompt(ctx, text), isMeta: true };
}

export function assistantText(ctx: EntryContext, text: string): Entry {
  return {
    ...base('assistant', ctx),
    message: { role: 'assistant', model: 'claude-synthetic', content: [{ type: 'text', text }] },
  };
}

export function assistantToolUse(ctx: EntryContext, name: string, input: unknown, id = `toolu_${entryId().slice(-12)}`): Entry {
  return {
    ...base('assistant', ctx),
    message: { role: 'assistant', model: 'claude-synthetic', content: [{ type: 'tool_use', id, name, input }] },
  };
}

export function toolResult(ctx: EntryContext, toolUseId: string, content: string, isError = false): Entry {
  return {
    ...base('user', ctx),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
  };
}

/** A prompt typed while Claude was busy, fed into the running turn. */
export function queuedCommand(ctx: EntryContext, prompt: string): Entry {
  return { ...base('attachment', ctx), attachment: { type: 'queued_command', prompt } };
}

/** A prompt waiting in Claude's queue. */
export function queueOperation(ctx: EntryContext, operation: 'enqueue' | 'dequeue' | 'remove', content?: string): Entry {
  const e: Entry = { type: 'queue-operation', operation, timestamp: ctx.at, sessionId: ctx.sessionId };
  if (content !== undefined) e.content = content;
  return e;
}

export function permissionMode(ctx: EntryContext, mode: string): Entry {
  return { type: 'permission-mode', permissionMode: mode, sessionId: ctx.sessionId, timestamp: ctx.at };
}

export function awaySummary(ctx: EntryContext, text: string): Entry {
  return { ...base('system', ctx), subtype: 'away_summary', content: text };
}

/** An API error turn; `rateLimit` marks it as a usage-limit hit. */
export function apiError(ctx: EntryContext, text: string, rateLimit = false): Entry {
  const e: Entry = {
    ...assistantText(ctx, text),
    isApiErrorMessage: true,
  };
  if (rateLimit) e.error = 'rate_limit';
  return e;
}

/** Serialize entries as JSONL (with a trailing newline). */
export function toJsonl(entries: readonly Entry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
}

/**
 * A small conversation: `turns` timestamps advance one second per entry
 * from `start`. Returns entries plus the time after the last one.
 */
export function timeline(start: string | number, sessionId: string, cwd: string) {
  let t = typeof start === 'string' ? Date.parse(start) : start;
  const next = (): EntryContext => {
    const at = new Date(t).toISOString();
    t += 1000;
    return { sessionId, cwd, at };
  };
  return { next, now: () => new Date(t).toISOString() };
}
