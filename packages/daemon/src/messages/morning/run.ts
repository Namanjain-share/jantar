/**
 * The morning run's Claude step (0.15 Messages): one headless run on the
 * shared runner (rewrite/run.ts), the way Intel's reads run it
 * (intel/read/claude.ts): cswap or `claude -p` with one login, Rewrite's
 * isolation options and env scrub, an account that is never kept or held,
 * the refused-option loop, one turn, no tools and no MCP servers.
 *
 * - Stream-json, so stdin carries one user message: input.ts's text, then
 *   each picture after its Jantar-written label, by ids only ("Image,
 *   message m4 (chat c2)": a group's name is anyone's to set, so it stays
 *   inside its <chat>). A claude that refuses --input-format gets one
 *   text-only retry without the pictures.
 * - The run counts only when its `system`/`init` line shows no tools and no
 *   MCP servers; the answer only as one JSON object MorningAnswerSchema
 *   accepts (one ```json fence tolerated). Anything else is a ClaudeFail.
 * - Sonnet at medium effort, Haiku as fallback, MESSAGES_LIMITS
 *   .morningTimeoutMs; our prompt (assets/messages/morning-v1.md) as a file
 *   in <messagesDir>/run, an empty 0700 <messagesDir>/run/work as cwd.
 * - Pictures (pickImages, morningImages): up to morningImages images from
 *   the tier-1 chats' new lines, newest first, each copied by the reader to
 *   its spool and shrunk by jantar-media (media.ts, imageEdge, metadata
 *   gone); one that fails is left out.
 *
 * Nothing here logs but codes and counts: the input is other people's words.
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MESSAGES_LIMITS, type AccountId, type RewriteModel } from '@jantar/protocol';
import { MorningAnswerSchema, type MorningAnswer } from '@jantar/protocol/messages';
import type { CcwLegacySource, DaemonContext, Logger, UsageSource } from '../../contracts.js';
import { streamMessage, type ClaudeFail } from '../../intel/read/claude.js';
import { pickSharedRunAccount, runVia } from '../../rewrite/pick.js';
import { DROPPABLE_OPTIONS, execRewrite, prepareRunDir, runDroppingRefused, type RunOutcome } from '../../rewrite/run.js';
import { mediaAnswer, type ImageShrinker } from '../media.js';
import { ReaderFailure, type ReaderClient } from '../reader-client.js';
import type { Batch } from './collect.js';
import type { RefMap } from './input.js';

export const MORNING_MODEL: RewriteModel = 'sonnet';
export const MORNING_FALLBACK_MODEL: RewriteModel = 'haiku';
export const MORNING_EFFORT = 'medium';
/** Bump with the prompt's text; the run report can record it. */
export const MORNING_PROMPT_VERSION = 'v1';
export const MORNING_ASSET = `messages/morning-${MORNING_PROMPT_VERSION}.md`;
/** The run's folder inside <messagesDir>: the prompt copy and the empty work/ cwd. */
export const MORNING_RUN_DIR = 'run';

/** What a run needs (intel/read/claude.ts ClaudeDeps). */
export interface MorningRunDeps {
  ctx: DaemonContext;
  usage: UsageSource;
  ccwLegacy: CcwLegacySource;
  log: Logger;
  /** Options claude refused that the run can do without (the daemon's life). */
  learned: Set<string>;
}

/** A picture for the model, after its Jantar-written label. */
export interface MorningImage {
  label: string;
  jpeg: Buffer;
}

export interface MorningModelInput {
  /** input.ts morningInput's text. */
  text: string;
  images: readonly MorningImage[];
}

export type MorningRunResult =
  | { ok: true; answer: MorningAnswer; ms: number; account: AccountId | null; noPictures: boolean }
  | { ok: false; why: ClaudeFail; ms: number; account: AccountId | null };

/** A fence the model may wrap its JSON in, alone on the text: ```json … ``` or ``` … ```. */
const FENCE = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i;

/** The answer, or null when it is not one JSON object MorningAnswerSchema accepts. */
export function parseMorningAnswer(raw: string): MorningAnswer | null {
  const text = raw.trim();
  const body = FENCE.exec(text)?.[1] ?? text;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const r = MorningAnswerSchema.safeParse(value);
  return r.success ? r.data : null;
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

/** The morning's one Claude run. `signal` stops it (the daemon stopping). */
export async function runMorning(d: MorningRunDeps, input: MorningModelInput, signal: AbortSignal): Promise<MorningRunResult> {
  const { ctx } = d;
  const via = runVia(ctx);
  if (!via) return { ok: false, why: 'noClaude', ms: 0, account: null };
  const account = await pickSharedRunAccount(ctx, { usage: d.usage, ccwLegacy: d.ccwLegacy, log: d.log });
  if (account === null) return { ok: false, why: 'noAccount', ms: 0, account: null };
  const { line } = streamMessage(input.text, input.images);
  const dir = await prepareRunDir(ctx.paths, { dir: join(ctx.paths.messagesDir, MORNING_RUN_DIR), asset: MORNING_ASSET });
  if (dir.workEntries > 0) for (const name of await readdir(dir.cwd)) await rm(join(dir.cwd, name), { recursive: true, force: true });
  const single = 'claude' in via;
  const run = (io: 'stream' | 'text', stdin: string) => (dropped: ReadonlySet<string>) =>
    execRewrite(ctx, {
      via,
      flags: {
        account: single ? null : account,
        model: MORNING_MODEL,
        fallbackModel: MORNING_FALLBACK_MODEL,
        effort: MORNING_EFFORT,
        systemPromptFile: dir.systemPromptFile,
        dropped,
        io,
      },
      input: stdin,
      cwd: dir.cwd,
      timeoutMs: MESSAGES_LIMITS.morningTimeoutMs,
      signal,
    });
  const refused = (option: string | null) => d.log.warn('messages: claude refused an option of the morning run', { option, dropped: option !== null && DROPPABLE_OPTIONS.includes(option) });
  let r = await runDroppingRefused(run('stream', line), d.learned, refused, signal);
  let noPictures = false;
  if (r.outcome.kind === 'flags' && (r.outcome.option === '--input-format' || r.outcome.option === '--verbose') && !signal.aborted) {
    // An older claude without stream-json input: the text alone.
    noPictures = true;
    r = await runDroppingRefused(run('text', input.text), d.learned, refused, signal);
  }
  const o = r.outcome;
  if (o.kind !== 'ok') return { ok: false, why: failOf(o), ms: r.ms, account };
  if (!noPictures) {
    const init = r.init;
    if (!init || init.tools.length !== 0 || init.mcpServers.length !== 0) return { ok: false, why: 'notIsolated', ms: r.ms, account };
  }
  const answer = parseMorningAnswer(o.result);
  if (!answer) return { ok: false, why: 'unreadable', ms: r.ms, account };
  return { ok: true, answer, ms: r.ms, account, noPictures };
}

/** A picture to show: its message and its label. */
export interface ImagePick {
  msgKey: string;
  label: string;
}

/**
 * The pictures for the run: the images (on this Mac) among the tier-1
 * chats' new lines in `kept`, newest first, at most `max`, each labelled
 * with its message's and its chat's ids in the input, never a name.
 */
export function pickImages(kept: Batch, refs: RefMap, max: number = MESSAGES_LIMITS.morningImages): ImagePick[] {
  const idOf = new Map([...refs.m].map(([id, key]) => [key, id]));
  const chatIdOf = new Map([...refs.c].map(([id, key]) => [key, id]));
  const found: { at: number; pick: ImagePick }[] = [];
  for (const bc of kept.chats) {
    const chatId = chatIdOf.get(bc.chat.chatKey);
    if (bc.tier !== 1 || !chatId) continue;
    for (const m of bc.messages) {
      const id = idOf.get(m.msgKey);
      if (m.kind !== 'image' || m.media?.local === false || !id) continue;
      found.push({ at: Date.parse(m.at), pick: { msgKey: m.msgKey, label: `Image, message ${id} (chat ${chatId})` } });
    }
  }
  found.sort((a, b) => b.at - a.at);
  return found.slice(0, max).map((f) => f.pick);
}

/** Each pick's image, shrunk; one the reader or jantar-media can't give is left out (logged by code). */
export async function morningImages(
  picks: readonly ImagePick[],
  o: { reader: ReaderClient; messagesDir: string; shrinker: ImageShrinker; log?: Logger },
): Promise<MorningImage[]> {
  const out: MorningImage[] = [];
  for (const p of picks) {
    try {
      const got = await o.reader.call('media', { msgKey: p.msgKey, maxBytes: MESSAGES_LIMITS.mediaMaxBytes });
      const answer = await mediaAnswer(got, { messagesDir: o.messagesDir, shrinker: o.shrinker });
      if ('jpeg' in answer) out.push({ label: p.label, jpeg: answer.jpeg });
    } catch (e) {
      o.log?.warn('messages: a morning picture was left out', { code: e instanceof ReaderFailure ? e.code : 'failed' });
    }
  }
  return out;
}
