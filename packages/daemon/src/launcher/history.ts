/**
 * A folder's past conversations, for Resume (v0.4 spec 4.10): what the start
 * sheet's Resume row and the CLI's `new --resume` offer, and the list a start
 * or preview with `resume` is checked against again.
 *
 *   folder  = the policy-resolved realpath (FilePolicy.resolveDir, as the preview)
 *   enc     = encodeProjectDir(folder)
 *   dirs    = ~/.claude/projects, plus <profile>/projects of each cswap profile
 *             whose realpath is not that one (cswap mode only: single mode
 *             starts claude on ~/.claude, whose --resume sees nothing else)
 *   files   = <dir>/<enc>/<uuid>.jsonl, regular files only (lstat: a symlink
 *             is skipped), named by a UUID the schemas take (RFC variant),
 *             the newest LAUNCH_HISTORY_LIMIT by mtime
 *   first   = the first line of the first user message in a file's first
 *             64 KiB whose text does not start with "<" (command and system
 *             wrappers), masked as a launch screen tail is, at most 80
 *   account = the profile's account (a resume is pinned to it), null for the shared dir
 *   live    = a running session has this id (it cannot be resumed)
 *   cwd     = the `cwd` of the first entry in those 64 KiB that has one: a
 *             transcript recorded in another folder, or with none, is left
 *             out. Claude's dir names fold every character but letters and
 *             digits into "-", so ~/work/private, ~/work-private and
 *             ~/work.private share one dir; without this a folder the path
 *             policy allows would show (and resume) one it refuses.
 *
 * The phone never names a path or an argv word: a resume id comes from this
 * list and nowhere else. A start checks its id with pastFile: the same file
 * rules and the same recorded cwd, looked up by name in each dir, so an
 * entry picked from the list still starts after newer conversations push it
 * past the newest 20.
 * Nothing here writes, follows a symlink to a transcript, blocks on a FIFO or
 * reads past 64 KiB of one. A profile whose account is unknown is left out:
 * its conversations could not be pinned, and `--resume` on another account
 * would not find them.
 */
import { join } from 'node:path';
import { LAUNCH_HISTORY_LIMIT, PastSessionSchema, type AccountId, type LaunchHistoryQuery, type PastSession } from '@jantar/protocol';
import type { Actor, DaemonContext, FilesService, LaunchResult, SessionSource } from '../contracts.js';
import { fsx, isDirEntry, listDir, readRange } from '../sources/lib/fsx.js';
import { encodeProjectDir } from '../sources/transcripts/reader.js';
import { maskScreen } from './dialogs.js';
import { isRefusal, refusalResult } from './folders.js';

/** How much of a transcript is read for its first line. */
export const HISTORY_READ_BYTES = 64 * 1024;
/** The first line as the start sheet shows it. */
export const FIRST_LINE_MAX = 80;

export const NOT_IN_HISTORY = "That conversation isn't in this folder's history.";
export const RESUME_RUNNING = 'That conversation is running. Open it on the Board.';
export const RESUME_STARTING = 'That conversation is already starting. Wait for it on the Board.';

const TRANSCRIPT_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u;
/** C0 controls, DEL and C1 controls: never shown, never sent. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]+/gu;

export interface HistoryDeps {
  ctx: DaemonContext;
  /** The profile a projects dir belongs to: SessionSource.accountForConfigDir. */
  sessions: Pick<SessionSource, 'accountForConfigDir'>;
}

/** One transcript in a folder's history, before its first line is read. */
export interface PastFile {
  id: string;
  account: AccountId | null;
  path: string;
  mtimeMs: number;
}

/**
 * The id of a transcript file name: a lowercase UUID that PastSessionSchema
 * and the start body take (RFC variant), else null. A name the schemas
 * refuse is never listed: it could not be started.
 */
function transcriptId(name: string): string | null {
  const id = TRANSCRIPT_RE.exec(name)?.[1];
  return id !== undefined && PastSessionSchema.shape.id.safeParse(id).success ? id : null;
}

async function realOr(path: string): Promise<string> {
  try {
    return await fsx.realpath(path);
  } catch {
    return path;
  }
}

/** The projects dirs whose transcripts `--resume` could open, with the account each pins (null: the shared one). */
async function projectDirs(d: HistoryDeps): Promise<{ dir: string; account: AccountId | null }[]> {
  const shared = d.ctx.paths.claudeProjects;
  const out: { dir: string; account: AccountId | null }[] = [{ dir: shared, account: null }];
  if (d.ctx.accountsMode() === 'single') return out;
  const sharedReal = await realOr(shared);
  const profilesDir = d.ctx.paths.cswapProfiles;
  for (const e of await listDir(profilesDir)) {
    if (e.name.startsWith('.') || !(await isDirEntry(profilesDir, e))) continue;
    const profile = join(profilesDir, e.name);
    const dir = join(profile, 'projects');
    // A profile that shares history keeps its projects in the shared dir (a symlink): listed once, as shared.
    if ((await realOr(dir)) === sharedReal) continue;
    const account = d.sessions.accountForConfigDir(profile);
    if (account === null) continue;
    out.push({ dir, account });
  }
  return out;
}

/**
 * The newest LAUNCH_HISTORY_LIMIT transcripts of `folder` (a realpath), newest
 * first, each id once. Unreadable dirs and files are left out, never thrown.
 */
export async function pastFiles(d: HistoryDeps, folder: string): Promise<PastFile[]> {
  const enc = encodeProjectDir(folder);
  const found = new Map<string, PastFile>();
  for (const { dir, account } of await projectDirs(d)) {
    const at = join(dir, enc);
    try {
      // The folder's own dir, never a symlink to somewhere else.
      if (!(await fsx.lstat(at)).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const e of await listDir(at)) {
      const id = transcriptId(e.name);
      if (id === null || !e.isFile()) continue;
      const path = join(at, e.name);
      let mtimeMs: number;
      try {
        const st = await fsx.lstat(path);
        if (!st.isFile()) continue;
        mtimeMs = Number(st.mtimeMs);
      } catch {
        continue;
      }
      const prev = found.get(id);
      if (!prev || prev.mtimeMs < mtimeMs) found.set(id, { id, account, path, mtimeMs });
    }
  }
  return [...found.values()].sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1)).slice(0, LAUNCH_HISTORY_LIMIT);
}

/**
 * One conversation of `folder` (a realpath) by its id, as a start or preview
 * with `resume` checks it: `<dir>/<enc>/<id>.jsonl` in each projects dir, by
 * the list's rules (the folder's own dir, never a symlink; a regular file;
 * the newest copy when two dirs keep it; recorded in this folder), with no
 * dir listed and only that copy opened. Not cut at the newest
 * LAUNCH_HISTORY_LIMIT. Null: not this folder's.
 */
export async function pastFile(d: HistoryDeps, folder: string, id: string): Promise<PastFile | null> {
  if (transcriptId(`${id}.jsonl`) !== id) return null;
  const enc = encodeProjectDir(folder);
  let best: PastFile | null = null;
  for (const { dir, account } of await projectDirs(d)) {
    const at = join(dir, enc);
    const path = join(at, `${id}.jsonl`);
    try {
      if (!(await fsx.lstat(at)).isDirectory()) continue;
      const st = await fsx.lstat(path);
      if (!st.isFile()) continue;
      const mtimeMs = Number(st.mtimeMs);
      if (!best || best.mtimeMs < mtimeMs) best = { id, account, path, mtimeMs };
    } catch {
      continue;
    }
  }
  if (!best) return null;
  const head = await readHead(best.path);
  return head !== null && (await recordedIn(head, folder)) ? best : null;
}

/** At most `max` UTF-16 units (the schema's count), ending in "…" when cut, never inside a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/** The text of a user entry that is a typed prompt (string content, or its first text block). */
function promptText(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as { type?: unknown; isMeta?: unknown; isSidechain?: unknown; message?: { content?: unknown } };
  if (e.type !== 'user' || e.isMeta === true || e.isSidechain === true) return null;
  const content = e.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (const b of content as unknown[]) {
    if (typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
      return (b as { text: string }).text;
    }
  }
  return null;
}

/** The first line the user typed, from a transcript's first 64 KiB: masked and cut, or undefined. */
export function firstLineOf(head: string): string | undefined {
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // A line cut at 64 KiB, or not JSON: skipped.
      continue;
    }
    const text = promptText(entry)?.trim();
    if (!text || text.startsWith('<')) continue;
    const first = text.split(/\r?\n/u).find((l) => l.trim())?.replace(CONTROL_RE, ' ').trim();
    if (!first) continue;
    return cut(maskScreen(first), FIRST_LINE_MAX);
  }
  return undefined;
}

/** The folder a transcript was recorded in: the `cwd` of the first entry in its first 64 KiB that has one. */
export function recordedCwdOf(head: string): string | undefined {
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    try {
      const cwd = (JSON.parse(line) as { cwd?: unknown } | null)?.cwd;
      if (typeof cwd === 'string' && cwd !== '') return cwd;
    } catch {
      // A line cut at 64 KiB, or not JSON: skipped.
    }
  }
  return undefined;
}

/** Whether a transcript's head says it was recorded in `folder` (a realpath); with no cwd it was not. */
async function recordedIn(head: string, folder: string): Promise<boolean> {
  const cwd = recordedCwdOf(head);
  if (cwd === undefined) return false;
  return cwd === folder || (await realOr(cwd)) === folder;
}

/** A transcript's first 64 KiB as text; null when it cannot be read (never through a symlink, never a FIFO). */
async function readHead(path: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof fsx.openNoFollow>> | null = null;
  try {
    fh = await fsx.openNoFollow(path);
    if (!(await fh.stat()).isFile()) return null;
    return (await readRange(fh, 0, HISTORY_READ_BYTES)).toString('utf8');
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** A running session has this id. */
export function isLive(ctx: DaemonContext, id: string): boolean {
  const sessions = ctx.store.getState().sessions;
  return Object.hasOwn(sessions, id) && sessions[id]?.status !== 'ended';
}

/** `folder`'s past conversations (a realpath), newest first, with their first lines; only those recorded in it. */
export async function pastSessions(d: HistoryDeps, folder: string): Promise<PastSession[]> {
  const files = await pastFiles(d, folder);
  const listed = await Promise.all(
    files.map(async (f): Promise<PastSession | null> => {
      const head = await readHead(f.path);
      if (head === null || !(await recordedIn(head, folder))) return null;
      const out: PastSession = { id: f.id, account: f.account, lastAt: new Date(f.mtimeMs).toISOString(), live: isLive(d.ctx, f.id) };
      const first = firstLineOf(head);
      if (first) out.first = first;
      return out;
    }),
  );
  return listed.filter((s): s is PastSession => s !== null);
}

/**
 * GET /v1/launch/history: the folder through the one path policy (a refusal
 * is audited by Files, as the preview's), then its past conversations.
 */
export async function launchHistory(
  d: HistoryDeps & { files: Pick<FilesService, 'policy' | 'denied'> },
  q: LaunchHistoryQuery,
  actor: Actor,
): Promise<LaunchResult<{ sessions: PastSession[] }>> {
  const dir = await d.files.policy.resolveDir(q.root, q.path);
  if (isRefusal(dir)) {
    d.files.denied(actor, q.root, q.path, dir.refused);
    return refusalResult(dir);
  }
  return { ok: true, sessions: await pastSessions(d, dir.real) };
}
