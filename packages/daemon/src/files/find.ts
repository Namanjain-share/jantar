/**
 * A name search under a folder (0.14.1, GET /v1/files/find): the names of
 * files and folders below `path` that contain `q`. Names only: no file is
 * opened for its content.
 *
 * Every folder is read through the policy's own `openDir`, the read behind
 * a listing, so the search sees exactly what Browse would: the same root
 * resolution and containment (a path outside the root, or a root that isn't
 * shared, is refused as the listing refuses it), protected entries left out,
 * and dot entries only for a `q` that starts with '.'. Entries are typed by
 * lstat: a symlink is never followed into, and is listed only when its own
 * name matches and it leads to a file or folder inside the root (one that
 * leads outside or nowhere can't be opened from the phone, so it is left
 * out). `node_modules` and `.git` are never walked into.
 *
 * Breadth-first, at most FILES_FIND_MAX_DEPTH levels below `path`,
 * FILES_FIND_MAX_VISITED entries and FILES_FIND_BUDGET_MS on the context's
 * clock; any of them reached, or more matches than `limit`, says
 * `truncated`. Matching is case-insensitive on NFC-normalised names. Best
 * first: names that start with `q`, then the shallower, then by name.
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

/** Folders the walk never goes into (a name of theirs can still match). */
export const FIND_SKIPPED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git']);

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
  opts: { clock: Pick<Clock, 'now'>; caps?: Partial<FindCaps> },
): Promise<FilesFindResponse | FileRefusal> {
  const caps = { ...CAPS, ...opts.caps };
  const limit = Math.max(1, Math.min(q.limit, caps.limit));
  const needle = findKey(q.q);
  const hidden = q.q.startsWith('.');
  const deadline = opts.clock.now() + caps.budgetMs;
  const scanCap = (visited: number) => Math.max(1, Math.min(DIR_MAX_SCAN, caps.maxVisited - visited));

  // The folder itself is refused as a listing of it would be.
  const start = await policy.openDir(q.root, q.path, { hidden, maxScan: scanCap(0) });
  if (isRefusal(start)) return start;

  const matches: Match[] = [];
  const queue: Array<{ rel: string; depth: number }> = [];
  let visited = 0;
  let truncated = false;
  const take = (dir: OpenedDir, rel: string, depth: number) => {
    visited += dir.entries.length + dir.hiddenProtected;
    if (dir.truncated) truncated = true;
    for (const entry of dir.entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      const key = findKey(entry.name);
      if (key.includes(needle)) matches.push({ entry, path, depth: depth + 1, starts: key.startsWith(needle) });
      // lstat says dir only for a real folder: a link to one is never walked into.
      if (entry.type !== 'dir' || FIND_SKIPPED_DIRS.has(entry.name)) continue;
      if (depth + 1 < caps.maxDepth) queue.push({ rel: path, depth: depth + 1 });
      else truncated = true;
    }
  };
  take(start, start.rel, 0);
  for (let i = 0; i < queue.length; i++) {
    if (visited >= caps.maxVisited || opts.clock.now() >= deadline) {
      truncated = true;
      break;
    }
    const next = queue[i] as { rel: string; depth: number };
    const dir = await policy.openDir(q.root, next.rel, { hidden, maxScan: scanCap(visited) });
    // A folder that went away meanwhile, or one macOS keeps from Jantar: its names are not there to find.
    if (isRefusal(dir)) continue;
    take(dir, next.rel, next.depth);
  }

  matches.sort(best);
  const entries: FileFindEntry[] = [];
  for (const m of matches) {
    if (entries.length >= limit) {
      truncated = true;
      break;
    }
    const found = await describeMatch(policy, q.root, m);
    if (found) entries.push(found);
  }
  return { entries, truncated };
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
