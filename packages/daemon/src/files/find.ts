/**
 * A name search under a folder (0.14.1, GET /v1/files/find): the names of
 * files and folders below `path` that contain `q`. Names only: no file is
 * opened for its content.
 *
 * Every folder is read through the policy's own `openDir`, the read behind
 * a listing, so the search sees exactly what Browse would: the same root
 * resolution and containment (a path outside the root, or a root that isn't
 * shared, is refused as the listing refuses it), protected entries left out,
 * and dot entries (and what is in dot folders) only with `hidden`, as the
 * listing's "Show hidden files". Entries are typed by lstat: a symlink is
 * never followed into, and is listed only when its own name matches and the
 * policy's openForRead / resolveDir find it leads to a file or folder inside
 * the root (one that leads outside or nowhere can't be opened from the
 * phone, so it is left out). `node_modules` and `.git` (in any letter case,
 * as APFS matches them) are never walked into.
 *
 * Breadth-first, at most FILES_FIND_MAX_DEPTH levels below `path`,
 * FILES_FIND_MAX_VISITED entries (every one read counts, dot entries
 * included) and FILES_FIND_BUDGET_MS on the context's clock, checked before
 * each folder and before each link is judged; reaching one says
 * `stopped: 'scan'`, and more matches than `limit` says `stopped: 'limit'`
 * (`truncated` either way). A folder at the depth cap is only peeked into,
 * so an empty one cuts nothing. `signal` (the request going away, or a newer
 * search from the same device) stops the walk at the next check.
 * Matching is case-insensitive on NFC-normalised names. Best first: names
 * that start with `q`, then the shallower, then by name.
 */
import {
  FILES_FIND_BUDGET_MS,
  FILES_FIND_LIMIT,
  FILES_FIND_MAX_DEPTH,
  FILES_FIND_MAX_VISITED,
  type FileFindEntry,
  type FilesFindQuery,
  type FilesFindResponse,
} from '@jantar/protocol';
import type { Clock, DirEntryInfo, FilePolicy, FileRefusal, OpenedDir } from '../contracts.js';
import { fsx } from '../sources/lib/fsx.js';
import { DIR_MAX_SCAN, isRefusal } from './policy.js';

/** Folders the walk never goes into, as findKey has them (a name of theirs can still match). */
export const FIND_SKIPPED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git']);

/** The search was called off (the request went away, or a newer one took its place). */
export interface FindAborted {
  aborted: true;
}

export function isFindAborted(v: unknown): v is FindAborted {
  return typeof v === 'object' && v !== null && (v as { aborted?: unknown }).aborted === true;
}

const ABORTED: FindAborted = { aborted: true };

export interface FindCaps {
  limit: number;
  maxDepth: number;
  maxVisited: number;
  budgetMs: number;
}

const CAPS: FindCaps = { limit: FILES_FIND_LIMIT, maxDepth: FILES_FIND_MAX_DEPTH, maxVisited: FILES_FIND_MAX_VISITED, budgetMs: FILES_FIND_BUDGET_MS };

interface Match {
  entry: DirEntryInfo;
  /** Relative to the root. */
  path: string;
  /** 1 for a name directly in the searched folder. */
  depth: number;
  starts: boolean;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** What a name is matched as: NFC, lower case. */
export function findKey(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

function codeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Names that start with the text first, then the shallower, then by name (natural, case-insensitive), then by path. */
function best(a: Match, b: Match): number {
  if (a.starts !== b.starts) return a.starts ? -1 : 1;
  return a.depth - b.depth || collator.compare(a.entry.name, b.entry.name) || codeUnits(a.entry.name, b.entry.name) || codeUnits(a.path, b.path);
}

function iso(ms: number): string {
  return new Date(Math.floor(ms)).toISOString();
}

export async function findNames(
  policy: Pick<FilePolicy, 'openDir' | 'openForRead' | 'resolveDir'>,
  q: FilesFindQuery,
  opts: { clock: Pick<Clock, 'now'>; caps?: Partial<FindCaps>; signal?: AbortSignal },
): Promise<FilesFindResponse | FileRefusal | FindAborted> {
  const caps = { ...CAPS, ...opts.caps };
  const limit = Math.max(1, Math.min(q.limit, caps.limit));
  const needle = findKey(q.q);
  const deadline = opts.clock.now() + caps.budgetMs;
  const off = () => opts.signal?.aborted === true;
  const late = () => opts.clock.now() >= deadline;
  const scanCap = (visited: number) => Math.max(1, Math.min(DIR_MAX_SCAN, caps.maxVisited - visited));
  // Dot entries are read (and counted) either way; without `hidden` they are left out here, as scanDir leaves them out of a listing.
  const shows = (name: string) => q.hidden || !name.startsWith('.');

  if (off()) return ABORTED;
  // The folder itself is refused as a listing of it would be.
  const firstCap = scanCap(0);
  const start = await policy.openDir(q.root, q.path, { hidden: true, maxScan: firstCap });
  if (off()) return ABORTED;
  if (isRefusal(start)) return start;

  const matches: Match[] = [];
  const queue: Array<{ rel: string; depth: number }> = [];
  let visited = 0;
  // A cap on the walk (depth, entries, time) cut it short.
  let scanCut = false;
  const take = (dir: OpenedDir, rel: string, depth: number, asked: number) => {
    // A cut read stopped at exactly `asked` entries; otherwise every entry read is in it or counted as protected.
    visited += dir.truncated ? asked : dir.entries.length + dir.hiddenProtected;
    if (dir.truncated) scanCut = true;
    for (const entry of dir.entries) {
      if (!shows(entry.name)) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      const key = findKey(entry.name);
      if (key.includes(needle)) matches.push({ entry, path, depth: depth + 1, starts: key.startsWith(needle) });
      // lstat says dir only for a real folder: a link to one is never walked into.
      if (entry.type !== 'dir' || FIND_SKIPPED_DIRS.has(key)) continue;
      queue.push({ rel: path, depth: depth + 1 });
    }
  };
  take(start, start.rel, 0, firstCap);
  for (let i = 0; i < queue.length; i++) {
    if (off()) return ABORTED;
    if (visited >= caps.maxVisited || late()) {
      scanCut = true;
      break;
    }
    const next = queue[i] as { rel: string; depth: number };
    const atCap = next.depth >= caps.maxDepth;
    // A folder at the depth cap: what is in it is past the cap, so one entry is enough to know whether anything was cut.
    if (atCap && scanCut) continue;
    const asked = atCap ? 1 : scanCap(visited);
    const dir = await policy.openDir(q.root, next.rel, { hidden: true, maxScan: asked });
    if (off()) return ABORTED;
    // A folder that went away meanwhile, or one macOS keeps from Jantar: its names are not there to find.
    if (isRefusal(dir)) continue;
    if (atCap) {
      visited += dir.truncated ? asked : dir.entries.length + dir.hiddenProtected;
      if (dir.truncated || dir.entries.some((e) => shows(e.name))) scanCut = true;
      continue;
    }
    take(dir, next.rel, next.depth, asked);
  }

  matches.sort(best);
  const entries: FileFindEntry[] = [];
  let overLimit = false;
  for (const m of matches) {
    if (off()) return ABORTED;
    if (entries.length >= limit) {
      overLimit = true;
      break;
    }
    // Judging a link reads the disk: it waits for the same clock as the walk.
    if (m.entry.type === 'link' && late()) {
      scanCut = true;
      break;
    }
    const found = await describeMatch(policy, q.root, m);
    if (found) entries.push(found);
  }
  if (off()) return ABORTED;
  return { entries, truncated: scanCut || overLimit, stopped: scanCut ? 'scan' : overLimit ? 'limit' : null };
}

/** A match as the reply has it; null for one that can't be opened from the phone (a link out or to nothing, a socket). */
async function describeMatch(policy: Pick<FilePolicy, 'openForRead' | 'resolveDir'>, root: string, m: Match): Promise<FileFindEntry | null> {
  const { entry, path } = m;
  if (entry.type === 'file' && entry.mtimeMs !== undefined) {
    return { path, name: entry.name, kind: 'file', ...(entry.size !== undefined ? { size: entry.size } : {}), mtime: iso(entry.mtimeMs) };
  }
  if (entry.type === 'dir' && entry.mtimeMs !== undefined) return { path, name: entry.name, kind: 'dir', mtime: iso(entry.mtimeMs) };
  if (entry.type !== 'link' || entry.link !== 'inside') return null;
  // A link inside the root shows as what it leads to, judged by the policy as opening it would be.
  const file = await policy.openForRead(root, path);
  if (!isRefusal(file)) {
    await file.fh.close().catch(() => undefined);
    return { path, name: entry.name, kind: 'file', size: file.stat.size, mtime: iso(file.stat.mtimeMs) };
  }
  if (file.refused !== 'not_file') return null;
  const dir = await policy.resolveDir(root, path);
  if (isRefusal(dir)) return null;
  try {
    // The folder it leads to, by the realpath the policy checked (no link left to follow).
    const st = await fsx.lstat(dir.real);
    return { path, name: entry.name, kind: 'dir', mtime: iso(Number(st.mtimeMs)) };
  } catch {
    return null;
  }
}
