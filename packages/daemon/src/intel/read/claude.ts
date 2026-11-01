/**
 * The Claude step of a read (spec 6): the shared runner (rewrite/run.ts)
 * exactly as Ask and Meetings use it (cswap or `claude -p`, the isolation
 * options, the env scrub, an empty 0700 work/ cwd, an account that is
 * never kept or held, the refused-option loop, $1.00, one turn, no tools),
 * in stream-json so stdin carries one user message with the pictures.
 *
 * The message: one text block of tagged data, then each picture as a
 * daemon-written label and an image block. `<item>` holds only daemon facts
 * (the platform, the type, the link's host, the depth, the probed
 * duration); everything else is untrusted page text, each piece in its own
 * tag, every tag name escaped in all data (`tagEscaper`: case, spaces,
 * format characters), control and bidi characters stripped, line ends made
 * "\n". Stdin stays under 4 MB (pictures are dropped from the end first).
 *
 * The run counts only when its `system`/`init` line shows no tools and no
 * MCP servers. A claude that refuses `--input-format` gets one text-only
 * retry (no pictures, a note). Nothing here is logged but codes and counts.
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { INTEL_READ_LIMITS, type AccountId, type IntelDepth, type IntelPlatform, type RewriteModel } from '@jantar/protocol';
import type { CcwLegacySource, DaemonContext, Logger, UsageSource } from '../../contracts.js';
import { tagEscaper } from '../../rewrite/context.js';
import { CONTROL, LINE_END } from '../../rewrite/guards.js';
import { pickSharedRunAccount, runVia } from '../../rewrite/pick.js';
import { DROPPABLE_OPTIONS, execRewrite, prepareRunDir, runDroppingRefused, type RunOutcome } from '../../rewrite/run.js';
import { parseAnswer, type ReadAnswer } from './answer.js';
import { intelDirs } from './files.js';

export const READ_MODEL: RewriteModel = 'sonnet';
export const READ_FALLBACK_MODEL: RewriteModel = 'haiku';
export const READ_PROMPT_VERSION = 'v1';
export const READ_ASSET = `intel/read-${READ_PROMPT_VERSION}.md`;

export const READ_TAGS = ['item', 'byline', 'user_note', 'caption', 'page_text', 'page_meta', 'comments', 'on_screen', 'transcript', 'related_page'] as const;
const escapeReadTags = tagEscaper(READ_TAGS);

/** Page text as data inside one of our tags: no control or bidi character, "\n" line ends, no tag of ours. */
export function inert(s: string): string {
  return escapeReadTags(s.replace(LINE_END, '\n').replace(CONTROL, ''));
}

function cutTo(s: string, max: number): string {
  if (max <= 0) return '';
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

/** The daemon's own facts: fixed words and numbers only. */
export interface ItemFacts {
  platform: IntelPlatform;
  type: string;
  /** The link's host, already through the URL rules. */
  host?: string;
  depth: IntelDepth;
  /** Seconds, from the helper's probe. */
  duration?: number;
}

export interface ReadInput {
  item: ItemFacts;
  /** As the page gave them: page text. */
  byline?: { creator?: string; postedAt?: string };
  note?: string;
  caption?: string;
  title?: string;
  pageText?: string;
  meta: { k: string; v: string }[];
  comments?: { author: string; text: string }[];
  /** OCR lines per frame, labelled ("Frame 2 at 0:17"). */
  onScreen: { label: string; lines: string[] }[];
  transcript?: string;
  related: { title?: string; text: string }[];
  /** The pictures shown, each with its daemon-written label ("Cover", "Frame 2 of 4, at 0:17"). */
  images: { label: string; jpeg: Buffer }[];
}

/** The tagged text block (budgeted: Light and Standard 30,000 chars, Full 60,000; transcript ≤ 20,000). */
export function readText(i: ReadInput): string {
  const full = i.item.depth === 'full';
  let left = full ? INTEL_READ_LIMITS.claudeTextFullMax : INTEL_READ_LIMITS.claudeTextMax;
  const parts: string[] = [];
  const facts = [`Platform: ${i.item.platform}`, `Type: ${i.item.type}`];
  if (i.item.host) facts.push(`Link host: ${i.item.host}`);
  facts.push(`Depth: ${i.item.depth}`);
  if (i.item.duration !== undefined && Number.isFinite(i.item.duration)) facts.push(`Video length: ${Math.round(i.item.duration)} s`);
  parts.push(`<item>\n${facts.join('\n')}\n</item>`);
  const add = (tag: string, body: string | undefined, cap: number, attrs = '') => {
    if (!body) return;
    const text = cutTo(inert(body).trim(), Math.min(cap, left));
    if (!text) return;
    left -= text.length;
    parts.push(`<${tag}${attrs}>\n${text}\n</${tag}>`);
  };
  const by: string[] = [];
  if (i.byline?.creator) by.push(`Creator: ${i.byline.creator}`);
  if (i.byline?.postedAt) by.push(`Posted: ${i.byline.postedAt}`);
  add('byline', by.join('\n'), 400);
  add('user_note', i.note, INTEL_READ_LIMITS.noteMax);
  add('caption', i.caption, 8_000);
  const meta = [...(i.title ? [{ k: 'title', v: i.title }] : []), ...i.meta].map((m) => `${m.k}: ${m.v}`).join('\n');
  add('page_meta', meta, 3_000);
  add('on_screen', i.onScreen.filter((f) => f.lines.length).map((f) => `${f.label}: ${f.lines.join(' / ')}`).join('\n'), 3_000);
  add('transcript', i.transcript, INTEL_READ_LIMITS.transcriptToClaude);
  add('page_text', i.pageText, full ? 25_000 : 20_000);
  add('comments', (i.comments ?? []).map((c) => `${c.author || 'someone'}: ${c.text}`).join('\n'), 4_000);
  i.related.forEach((r, n) => add('related_page', [r.title ? `Title: ${r.title}` : '', r.text].filter(Boolean).join('\n'), INTEL_READ_LIMITS.relatedChars, ` n="${n + 1}"`));
  parts.push('Answer with the one JSON object only.');
  return parts.join('\n\n');
}

type Block = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg'; data: string } };

/** The one stream-json line on stdin (with its newline), the pictures dropped from the end until it fits. */
export function streamMessage(text: string, images: readonly { label: string; jpeg: Buffer }[]): { line: string; shown: number } {
  for (let n = images.length; n >= 0; n--) {
    const content: Block[] = [{ type: 'text', text }];
    for (const img of images.slice(0, n)) {
      content.push({ type: 'text', text: img.label });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.jpeg.toString('base64') } });
    }
    const line = `${JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null })}\n`;
    if (Buffer.byteLength(line) <= INTEL_READ_LIMITS.claudeStdinBytes || n === 0) return { line, shown: n };
  }
  return { line: '', shown: 0 };
}

export type ClaudeFail = 'noClaude' | 'noAccount' | 'unreadable' | 'notIsolated' | 'stopped' | 'tooLong';

export type ClaudeResult =
  | { ok: true; answer: ReadAnswer; account: AccountId | null; ms: number; noPictures: boolean }
  | { ok: false; why: ClaudeFail; account: AccountId | null; ms: number; outcome: string };

export interface ClaudeDeps {
  ctx: DaemonContext;
  usage: UsageSource;
  ccwLegacy: CcwLegacySource;
  log: Logger;
  /** Options claude refused that a read can do without (the daemon's life). */
  learned: Set<string>;
}

function failOf(o: RunOutcome): ClaudeFail {
  switch (o.kind) {
    case 'unavailable':
      return 'noClaude';
    case 'account':
      return 'noAccount';
    case 'cancelled':
      return 'stopped';
    case 'timeout':
      return 'tooLong';
    case 'flags':
      return 'notIsolated';
    default:
      return 'unreadable';
  }
}

/** One read's Claude run. `signal` is the job's. */
export async function runClaude(d: ClaudeDeps, input: ReadInput, signal: AbortSignal): Promise<ClaudeResult> {
  const { ctx } = d;
  const via = runVia(ctx);
  if (!via) return { ok: false, why: 'noClaude', account: null, ms: 0, outcome: 'unavailable' };
  const account = await pickSharedRunAccount(ctx, { usage: d.usage, ccwLegacy: d.ccwLegacy, log: d.log });
  if (account === null) return { ok: false, why: 'noAccount', account: null, ms: 0, outcome: 'no_account' };
  const full = input.item.depth === 'full';
  const text = readText(input);
  const { line } = streamMessage(text, input.images);
  const dir = await prepareRunDir(ctx.paths, { dir: intelDirs(ctx.paths.intelDir).run, asset: READ_ASSET });
  if (dir.workEntries > 0) for (const name of await readdir(dir.cwd)) await rm(join(dir.cwd, name), { recursive: true, force: true });
  const single = 'claude' in via;
  const run = (io: 'stream' | 'text', stdin: string) => (dropped: ReadonlySet<string>) =>
    execRewrite(ctx, {
      via,
      flags: {
        account: single ? null : account,
        model: READ_MODEL,
        fallbackModel: READ_FALLBACK_MODEL,
        effort: full ? 'medium' : 'low',
        systemPromptFile: dir.systemPromptFile,
        dropped,
        io,
      },
      input: stdin,
      cwd: dir.cwd,
      timeoutMs: full ? INTEL_READ_LIMITS.claudeFullMs : INTEL_READ_LIMITS.claudeMs,
      signal,
    });
  const refused = (option: string | null) => d.log.warn('intel: claude refused an option of a read', { option, dropped: option !== null && DROPPABLE_OPTIONS.includes(option) });
  let r = await runDroppingRefused(run('stream', line), d.learned, refused, signal);
  let noPictures = false;
  if (r.outcome.kind === 'flags' && (r.outcome.option === '--input-format' || r.outcome.option === '--verbose') && !signal.aborted) {
    // An older claude without stream-json input: the text alone.
    noPictures = true;
    r = await runDroppingRefused(run('text', text), d.learned, refused, signal);
  }
  const o = r.outcome;
  if (o.kind !== 'ok') return { ok: false, why: failOf(o), account, ms: r.ms, outcome: o.kind };
  if (!noPictures) {
    const init = r.init;
    if (!init || init.tools.length !== 0 || init.mcpServers.length !== 0) return { ok: false, why: 'notIsolated', account, ms: r.ms, outcome: 'not_isolated' };
  }
  const answer = parseAnswer(o.result, { full, input: text.toLowerCase(), pageCreator: !!input.byline?.creator });
  if (!answer) return { ok: false, why: 'unreadable', account, ms: r.ms, outcome: 'unreadable' };
  return { ok: true, answer, account, ms: r.ms, noPictures };
}
