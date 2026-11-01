/**
 * The one message a Rewrite run gets on stdin (spec 4.3 "Context"; the
 * block format of refiner.md 4.3, with <dictated_text> for <transcript>):
 *
 *   <target> <destination> <open_card> <recent_conversation> <vocabulary> <dictated_text>
 *
 * Everything inside the tags is data, and some of it was written by the
 * session or by programs: any tag of ours inside it is escaped ("</target>"
 * becomes "<\/target>", "<target>" becomes "<\target>"), also with spaces or
 * invisible format characters (zero-width, bidi) inside it, so data can
 * never close a block or open a new one. The context is about 6k tokens at most:
 * the oldest conversation lines go first, then vocabulary from the end;
 * what the user said is never cut.
 *
 * Nothing here is logged or emitted: the context holds conversation text.
 */
import type { PendingRequest, Question, Session, TranscriptItem } from '@jantar/protocol';
import type { ChangesService, DaemonContext, FilesService, HooksBridge, TranscriptReader } from '../contracts.js';

export const CONTEXT_TAGS = ['target', 'destination', 'open_card', 'recent_conversation', 'vocabulary', 'dictated_text'] as const;

/** About 6k tokens. */
export const CONTEXT_BUDGET_CHARS = 24_000;
export const CONVERSATION_ITEMS = 10;
export const ITEM_CHARS = 600;
export const LAST_REPLY_CHARS = 2_000;
export const TOOL_LINE_CHARS = 120;
export const CARD_CHARS = 800;
export const VOCABULARY_ENTRIES = 200;
export const VOCABULARY_CHARS = 8_000;
/** A folder's top-level names are read again after this long. */
export const TOP_LEVEL_TTL_MS = 5 * 60_000;
/** Changed files listed in the vocabulary, at most. */
const CHANGED_MAX = 80;

// Tag names in any case, opening or closing, with stray spaces around the "/" and format characters
// (\p{Cf}: zero-width, bidi) anywhere up to the end of the name.
const GAP = '[\\s\\p{Cf}]*';
const tagName = (name: string) => [...name].join('\\p{Cf}*');
const FORMAT_CHARS = /\p{Cf}/gu;

/**
 * An escaper for `tags`: "</x>" becomes "<\/x>" and "<x>" becomes "<\x>",
 * however the tag is spelled (see above), so data can't open or close one.
 * v0.5.3: Ask's stdin (ask/input.ts) escapes its own tags with it.
 */
export function tagEscaper(tags: readonly string[]): (s: string) => string {
  const re = new RegExp(`<${GAP}(/)?${GAP}(${tags.map(tagName).join('|')})\\b`, 'giu');
  return (s) =>
    s.replace(re, (_m, slash: string | undefined, name: string) => {
      const clean = name.replace(FORMAT_CHARS, '');
      return slash ? `<\\/${clean}` : `<\\${clean}`;
    });
}

/** Data that can no longer open or close one of our blocks (and the spec's old <transcript>). */
export const escapeTags: (s: string) => string = tagEscaper([...CONTEXT_TAGS, 'transcript']);

/** At most `n` characters, the "…" of a cut included. */
export function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** "13:58" in the Mac's local time (what the phone shows), or "" when there is no time. */
function hhmm(at: string | undefined): string {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * The last CONVERSATION_ITEMS main-chain items, oldest first, as lines:
 * texts up to ITEM_CHARS (the last assistant reply up to LAST_REPLY_CHARS),
 * tool calls as one line, tool results and meta lines dropped.
 * `newestFirst` is TranscriptReader.page order.
 */
export function conversationLines(newestFirst: readonly TranscriptItem[], max = CONVERSATION_ITEMS): string[] {
  const picked = newestFirst
    .filter((i) => !i.isSidechain && (i.kind === 'tool_use' || i.kind === 'queued' || (i.kind === 'text' && i.role !== 'system')))
    .slice(0, max)
    .reverse();
  let lastReply = -1;
  picked.forEach((i, n) => {
    if (i.kind === 'text' && i.role === 'assistant') lastReply = n;
  });
  return picked.map((i, n) => {
    if (i.kind === 'tool_use') return clip(oneLine(`[tool] ${i.tool ?? 'tool'}: ${i.text}`), TOOL_LINE_CHARS);
    const when = hhmm(i.at);
    const who = i.kind === 'queued' ? 'user, queued' : i.role;
    return `[${who}${when ? ` ${when}` : ''}] ${clip(i.text.trim(), n === lastReply ? LAST_REPLY_CHARS : ITEM_CHARS)}`;
  });
}

function inputSummary(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of ['command', 'file_path', 'notebook_path', 'url', 'pattern', 'path']) {
      if (typeof o[k] === 'string') return o[k] as string;
    }
  }
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return '';
  }
}

/** One open card as the writer sees it (permission, question or plan), at most CARD_CHARS. */
export function cardSummary(p: PendingRequest): string {
  if (p.kind === 'question') {
    const fromInput = (p.input as { questions?: unknown } | null)?.questions;
    const q = p.questions?.[0] ?? (Array.isArray(fromInput) ? (fromInput[0] as Question | undefined) : undefined);
    if (q && typeof q.question === 'string') {
      const labels = Array.isArray(q.options) ? q.options.map((o) => o?.label).filter((l): l is string => typeof l === 'string') : [];
      const options = labels.join(' | ');
      return clip(oneLine(`kind: question · "${q.question}"${options ? ` options: ${options}` : ''}`), CARD_CHARS);
    }
  }
  if (p.kind === 'plan') {
    const plan = (p.input as { plan?: unknown } | null)?.plan;
    return clip(`kind: plan · ${clip(typeof plan === 'string' ? plan.trim() : '', 600)}`, CARD_CHARS);
  }
  return clip(`kind: ${p.kind} · tool: ${p.tool} · input: ${clip(oneLine(inputSummary(p.input)), 300)}`, CARD_CHARS);
}

export interface ContextParts {
  target: { folder: string; path: string; name?: string; status: string; mode?: string };
  /** v0.3 rewrites only write prompts (card fields are out of scope). */
  destination: 'prompt';
  /** cardSummary() of the open card, or null. */
  openCard: string | null;
  /** Oldest first. */
  conversation: string[];
  vocabulary: string[];
  /** What the user said (trimmed). */
  text: string;
}

export interface BuiltContext {
  /** The message for stdin. */
  message: string;
  /**
   * Everything the run was given besides what the user said (the new-token
   * guard checks against it): the target lines, the open card, and the
   * conversation lines and vocabulary entries that made it in.
   */
  known: string[];
}

function targetLines(t: ContextParts['target']): string[] {
  return [`folder: ${t.folder}`, `path: ${t.path}`, ...(t.name ? [`name: ${t.name}`] : []), `status: ${t.status}`, `mode: ${t.mode ?? 'default'}`];
}

function render(p: ContextParts, conversation: readonly string[], vocabulary: readonly string[]): string {
  const block = (tag: string, body: string) => `<${tag}>\n${body}\n</${tag}>`;
  return [
    block('target', escapeTags(targetLines(p.target).join('\n'))),
    `<destination>${p.destination}</destination>`,
    block('open_card', escapeTags(p.openCard ?? 'none')),
    block('recent_conversation', escapeTags(conversation.length ? conversation.join('\n') : 'none')),
    block('vocabulary', escapeTags(vocabulary.length ? vocabulary.join('\n') : 'none')),
    block('dictated_text', escapeTags(p.text)),
  ].join('\n');
}

/** The message, within `budget`: oldest conversation lines dropped first, then vocabulary from the end. */
export function buildContext(p: ContextParts, budget = CONTEXT_BUDGET_CHARS): BuiltContext {
  const conversation = [...p.conversation];
  const vocabulary = [...p.vocabulary];
  let message = render(p, conversation, vocabulary);
  while (message.length > budget && conversation.length > 0) {
    conversation.shift();
    message = render(p, conversation, vocabulary);
  }
  while (message.length > budget && vocabulary.length > 0) {
    vocabulary.pop();
    message = render(p, conversation, vocabulary);
  }
  return { message, known: [...targetLines(p.target), ...(p.openCard ? [p.openCard] : []), ...conversation, ...vocabulary] };
}

/** At most VOCABULARY_ENTRIES entries and VOCABULARY_CHARS chars, first ones kept, no repeats. */
export function capVocabulary(entries: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let chars = 0;
  for (const raw of entries) {
    const e = oneLine(raw).slice(0, 300);
    if (!e || seen.has(e)) continue;
    if (out.length >= VOCABULARY_ENTRIES || chars + e.length + 1 > VOCABULARY_CHARS) break;
    seen.add(e);
    out.push(e);
    chars += e.length + 1;
  }
  return out;
}

export interface ContextDeps {
  transcripts: TranscriptReader;
  hooks: HooksBridge;
  files: FilesService;
  changes: ChangesService;
}

/**
 * Gathers the parts from what the daemon already holds: the session, its
 * transcript page, its open card, and the vocabulary (the files it changed
 * while Files is on, its folder's top-level names through the file policy,
 * rewrite.glossary). Every source is optional: a part that fails or is not
 * built leaves its block shorter, never the run out.
 */
export class ContextBuilder {
  private readonly topLevel = new Map<string, { at: number; names: string[] }>();

  constructor(
    private readonly ctx: DaemonContext,
    private readonly deps: ContextDeps,
  ) {}

  async build(sid: string, session: Session, text: string): Promise<BuiltContext> {
    const [conversation, vocabulary] = await Promise.all([this.conversation(sid), this.vocabulary(sid, session)]);
    const target: ContextParts['target'] = { folder: session.folder, path: session.cwd, status: session.status };
    if (session.name?.trim()) target.name = session.name.trim();
    if (session.mode) target.mode = session.mode;
    return buildContext({ target, destination: 'prompt', openCard: this.openCard(sid), conversation, vocabulary, text });
  }

  private async conversation(sid: string): Promise<string[]> {
    try {
      const page = await this.deps.transcripts.page(sid, { limit: 4 * CONVERSATION_ITEMS });
      return conversationLines(page.items);
    } catch (e) {
      this.ctx.log.debug('rewrite: no conversation for the context', { sid, error: String(e) });
      return [];
    }
  }

  private openCard(sid: string): string | null {
    try {
      const card = this.deps.hooks
        .open()
        .filter((p) => p.sid === sid && p.state === 'open' && p.kind !== 'subagent-info')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      return card ? cardSummary(card) : null;
    } catch {
      return null;
    }
  }

  private async vocabulary(sid: string, session: Session): Promise<string[]> {
    const changed = this.ctx.settings.get().files.enabled ? this.changedFiles(sid, session.cwd) : [];
    const glossary = this.ctx.settings.get().rewrite.glossary;
    return capVocabulary([...changed, ...glossary, ...(await this.topLevelNames(sid, session.cwd))]);
  }

  /** Files the session changed, relative to its folder where they lie inside it; protected ones left out. */
  private changedFiles(sid: string, cwd: string): string[] {
    try {
      const policy = this.deps.files.policy;
      const prefix = `${cwd.replace(/\/+$/, '')}/`;
      return this.deps.changes
        .changedPathsFor(sid)
        .filter((p) => !policy.isProtected(p))
        .slice(0, CHANGED_MAX)
        .map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p));
    } catch (e) {
      this.ctx.log.debug('rewrite: no changed files for the vocabulary', { sid, error: String(e) });
      return [];
    }
  }

  /** The session folder's top-level names (dirs end in "/"), cached per folder. */
  private async topLevelNames(sid: string, cwd: string): Promise<string[]> {
    const now = this.ctx.clock.now();
    const hit = this.topLevel.get(cwd);
    if (hit && now - hit.at < TOP_LEVEL_TTL_MS) return hit.names;
    let names: string[] = [];
    try {
      const dir = await this.deps.files.policy.openDir(`s.${sid}`, '', { maxScan: 2_000 });
      if (!('refused' in dir)) names = dir.entries.map((e) => (e.type === 'dir' ? `${e.name}/` : e.name));
    } catch (e) {
      this.ctx.log.debug('rewrite: no folder names for the vocabulary', { sid, error: String(e) });
    }
    this.topLevel.set(cwd, { at: now, names });
    if (this.topLevel.size > 100) {
      const oldest = this.topLevel.keys().next().value;
      if (oldest !== undefined) this.topLevel.delete(oldest);
    }
    return names;
  }
}
