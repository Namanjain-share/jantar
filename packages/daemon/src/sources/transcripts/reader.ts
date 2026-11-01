/**
 * TranscriptReader: `<projects>/<encoded cwd>/<sid>.jsonl` files, read-only.
 *
 * - Path lookup: a cache per sid, then the two direct candidates from the
 *   session's cwd (its own profile's projects/ and the shared ~/.claude/projects),
 *   then, at most every 15 s per sid (miss backoff), one listing of every
 *   projects dir. Never a glob per call (ccw hazard 3.13).
 * - Byte offsets are exact (Buffers, not strings), so callers can resume.
 * - A transcript path handed in from outside (a hook payload) is used only if
 *   it is `<sid>.jsonl` inside a known projects dir.
 */
import type { FileHandle } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { localSession } from '@jantar/protocol';
import type { TranscriptItem } from '@jantar/protocol';
import type { DaemonContext, Factories, TranscriptEntry, TranscriptReader, TranscriptTail } from '../../contracts.js';
import { listConfigDirs } from '../claude-files/discover.js';
import { fileSig, fsx, isDirEntry, listDir, readRange } from '../lib/fsx.js';
import { nonEmpty, type Obj } from '../lib/values.js';
import { itemsFromEntry, parseLine, summarizeTail, type EntrySource } from './parse.js';

export interface TranscriptReaderOptions {
  /** After a failed full lookup, don't list projects dirs again for this sid for this long (default 15 s). */
  missBackoffMs?: number;
  /** How long the list of projects dirs is reused (default 15 s). */
  rootsTtlMs?: number;
  /** First tail window (default 256 KiB); grows ×8 up to tailMaxBytes while `now` or the prompt is missing. */
  tailWindowBytes?: number;
  tailMaxBytes?: number;
  /** Default readFrom() cap (default 8 MiB). */
  readMaxBytes?: number;
  /** Bytes one page() call scans at most (default 8 MiB). */
  pageScanBytes?: number;
}

/** Claude's project dir name for a cwd: every character other than ASCII letters and digits becomes "-". */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NL = 0x0a;
const TAIL_CACHE_MAX = 256;
const MISS_MAP_MAX = 2000;
const PATH_CACHE_MAX = 5000;
/** A line longer than this is skipped when paging backwards (giant tool results). */
const PAGE_MAX_LINE = 4 * 1024 * 1024;

export class FileTranscriptReader implements TranscriptReader {
  private readonly pathCache = new Map<string, string>();
  private readonly misses = new Map<string, number>();
  private roots: { at: number; lexical: string[]; lookup: string[] } | null = null;
  private readonly tails = new Map<string, { sig: string; tail: TranscriptTail }>();
  private readonly opts: Required<TranscriptReaderOptions>;

  constructor(
    private readonly ctx: DaemonContext,
    opts: TranscriptReaderOptions = {},
  ) {
    this.opts = {
      missBackoffMs: opts.missBackoffMs ?? 15_000,
      rootsTtlMs: opts.rootsTtlMs ?? 15_000,
      tailWindowBytes: opts.tailWindowBytes ?? 256 * 1024,
      tailMaxBytes: opts.tailMaxBytes ?? 4 * 1024 * 1024,
      readMaxBytes: opts.readMaxBytes ?? 8 * 1024 * 1024,
      pageScanBytes: opts.pageScanBytes ?? 8 * 1024 * 1024,
    };
  }

  // ---------------------------------------------------------------- paths

  async pathFor(
    sid: string,
    hint?: { cwd?: string; configDir?: string; transcriptPath?: string },
  ): Promise<string | null> {
    if (!SID_RE.test(sid)) return null;
    if (hint?.transcriptPath) {
      const p = await this.allowedPath(hint.transcriptPath, sid);
      if (p && (await fileSig(p))) return this.remember(sid, p);
    }
    const cached = this.pathCache.get(sid);
    if (cached) {
      if (await fileSig(cached)) return cached;
      this.pathCache.delete(sid);
    }
    const name = `${sid}.jsonl`;
    const direct: string[] = [];
    if (hint?.cwd) {
      const enc = encodeProjectDir(hint.cwd);
      if (hint.configDir) direct.push(join(hint.configDir, 'projects', enc, name));
      direct.push(join(this.ctx.paths.claudeProjects, enc, name));
    }
    const hit = await newest(direct);
    if (hit) return this.remember(sid, hit);

    const now = this.ctx.clock.now();
    const missAt = this.misses.get(sid);
    if (missAt !== undefined && now - missAt < this.opts.missBackoffMs) return null;
    const found: string[] = [];
    for (const root of (await this.projectRoots()).lookup) {
      for (const d of await listDir(root)) {
        if (await isDirEntry(root, d)) found.push(join(root, d.name, name));
      }
    }
    const scanned = await newest(found);
    if (scanned) return this.remember(sid, scanned);
    this.misses.set(sid, now);
    if (this.misses.size > MISS_MAP_MAX) {
      const oldest = this.misses.keys().next().value;
      if (oldest !== undefined) this.misses.delete(oldest);
    }
    return null;
  }

  /** Forget a cached path (e.g. the session moved). */
  forget(sid: string): void {
    this.pathCache.delete(sid);
    this.misses.delete(sid);
  }

  private remember(sid: string, path: string): string {
    this.pathCache.delete(sid);
    this.pathCache.set(sid, path);
    this.misses.delete(sid);
    if (this.pathCache.size > PATH_CACHE_MAX) {
      const oldest = this.pathCache.keys().next().value;
      if (oldest !== undefined) this.pathCache.delete(oldest);
    }
    return path;
  }

  /** `path` if it is `<sid>.jsonl` inside a known projects dir (checked lexically), else null. */
  async allowedPath(path: string, sid: string): Promise<string | null> {
    const p = resolve(path);
    if (basename(p) !== `${sid}.jsonl`) return null;
    const { lexical } = await this.projectRoots();
    return lexical.some((r) => p.startsWith(r + sep)) ? p : null;
  }

  /** Every projects dir: lexical paths (for the allow check) and realpath-deduped ones (for lookups). */
  private async projectRoots(): Promise<{ lexical: string[]; lookup: string[] }> {
    const now = this.ctx.clock.now();
    if (this.roots && now - this.roots.at < this.opts.rootsTtlMs) return this.roots;
    const dirs = await listConfigDirs(this.ctx.paths);
    const lexical = [...new Set([resolve(this.ctx.paths.claudeProjects), ...dirs.configDirs.map((d) => join(d, 'projects'))])];
    const seen = new Set<string>();
    const lookup: string[] = [];
    for (const r of lexical) {
      let real: string;
      try {
        real = await fsx.realpath(r);
      } catch {
        continue; // no projects/ there
      }
      if (seen.has(real)) continue;
      seen.add(real);
      lookup.push(r);
    }
    this.roots = { at: now, lexical, lookup };
    return this.roots;
  }

  // ---------------------------------------------------------------- reading

  async size(path: string): Promise<number> {
    return (await fileSig(path))?.size ?? 0;
  }

  async readFrom(
    path: string,
    offset: number,
    opts?: { maxBytes?: number },
  ): Promise<{ entries: TranscriptEntry[]; next: number }> {
    const maxBytes = Math.max(1, opts?.maxBytes ?? this.opts.readMaxBytes);
    let fh: FileHandle;
    try {
      fh = await fsx.open(path);
    } catch {
      return { entries: [], next: Math.max(0, offset) };
    }
    try {
      const size = Number((await fh.stat()).size);
      // the file shrank (replaced or truncated): start over from the beginning
      let start = Number.isInteger(offset) && offset >= 0 && offset <= size ? offset : 0;
      if (offset > size) start = 0;
      if (start >= size) return { entries: [], next: start };
      const len = Math.min(size - start, maxBytes);
      const buf = await readRange(fh, start, len);
      const lastNl = buf.lastIndexOf(NL);
      if (lastNl < 0) {
        if (buf.length < maxBytes) return { entries: [], next: start }; // one unfinished line
        // a single line longer than maxBytes: skip it whole, or wait if it isn't finished
        const end = await findNewline(fh, start + buf.length, size);
        return { entries: [], next: end === null ? start : end + 1 };
      }
      const entries: TranscriptEntry[] = [];
      let lineStart = 0;
      while (lineStart <= lastNl) {
        const nl = buf.indexOf(NL, lineStart);
        const line = buf.subarray(lineStart, nl);
        const raw = parseLine(line);
        if (raw) entries.push(toEntry(raw, start + lineStart, line.length));
        lineStart = nl + 1;
      }
      return { entries, next: start + lastNl + 1 };
    } finally {
      await fh.close().catch(() => undefined);
    }
  }

  async tail(path: string): Promise<TranscriptTail> {
    const sig = await fileSig(path);
    if (!sig) return {};
    const hit = this.tails.get(path);
    if (hit && hit.sig === sig.sig) return hit.tail;
    let fh: FileHandle;
    try {
      fh = await fsx.open(path);
    } catch {
      return {};
    }
    let tail: TranscriptTail = {};
    try {
      const fallbackAt = new Date(sig.mtimeMs).toISOString();
      let window = this.opts.tailWindowBytes;
      for (;;) {
        const start = Math.max(0, sig.size - window);
        const buf = await readRange(fh, start, sig.size - start);
        const scan = summarizeTail(lineSource(buf, start > 0), fallbackAt);
        tail = scan.tail;
        if (!scan.wantMore || start === 0 || window >= this.opts.tailMaxBytes) break;
        window = Math.min(window * 8, this.opts.tailMaxBytes);
      }
    } finally {
      await fh.close().catch(() => undefined);
    }
    this.tails.delete(path);
    this.tails.set(path, { sig: sig.sig, tail });
    if (this.tails.size > TAIL_CACHE_MAX) {
      const oldest = this.tails.keys().next().value;
      if (oldest !== undefined) this.tails.delete(oldest);
    }
    return tail;
  }

  async page(
    sid: string,
    opts: { before?: string; limit: number },
  ): Promise<{ items: TranscriptItem[]; nextBefore: string | null }> {
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit) || 1));
    // v0.6: a paired server's transcript is read there, never here.
    const s = localSession(this.ctx.store.getState(), sid);
    const hint: { cwd?: string; configDir?: string; transcriptPath?: string } = {};
    if (s?.cwd) hint.cwd = s.cwd;
    if (s?.configDir) hint.configDir = s.configDir;
    if (s?.transcriptPath) hint.transcriptPath = s.transcriptPath;
    const path = await this.pathFor(sid, hint);
    if (!path) return { items: [], nextBefore: null };
    let fh: FileHandle;
    try {
      fh = await fsx.open(path);
    } catch {
      return { items: [], nextBefore: null };
    }
    try {
      const size = Number((await fh.stat()).size);
      let end = size;
      if (opts.before !== undefined) {
        if (!/^\d{1,15}$/.test(opts.before)) return { items: [], nextBefore: null };
        end = Math.min(Number(opts.before), size);
      }
      const items: TranscriptItem[] = [];
      let cursor: number | null = null;
      for await (const { start, line } of linesBackward(fh, end, PAGE_MAX_LINE)) {
        cursor = start;
        if (line) {
          const raw = parseLine(line);
          if (raw) items.push(...itemsFromEntry(raw, start).reverse());
        }
        if (items.length >= limit || end - start >= this.opts.pageScanBytes) break;
      }
      return { items, nextBefore: cursor !== null && cursor > 0 ? String(cursor) : null };
    } finally {
      await fh.close().catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------

function toEntry(raw: Obj, offset: number, length: number): TranscriptEntry {
  const e: TranscriptEntry = { offset, length, type: typeof raw.type === 'string' ? raw.type : '', raw };
  const uuid = nonEmpty(raw.uuid);
  if (uuid) e.uuid = uuid;
  const ts = nonEmpty(raw.timestamp);
  if (ts) e.timestamp = ts;
  if (typeof raw.isSidechain === 'boolean') e.isSidechain = raw.isSidechain;
  return e;
}

/** The newest existing file of `paths` (by mtime), or null. */
async function newest(paths: readonly string[]): Promise<string | null> {
  let best: { path: string; mtime: number } | null = null;
  for (const p of new Set(paths)) {
    const sig = await fileSig(p);
    if (sig && (!best || sig.mtimeMs > best.mtime)) best = { path: p, mtime: sig.mtimeMs };
  }
  return best?.path ?? null;
}

/** Position of the first newline at or after `from`, or null. */
async function findNewline(fh: FileHandle, from: number, size: number): Promise<number | null> {
  const chunk = 1024 * 1024;
  for (let pos = from; pos < size; pos += chunk) {
    const buf = await readRange(fh, pos, Math.min(chunk, size - pos));
    const i = buf.indexOf(NL);
    if (i >= 0) return pos + i;
  }
  return null;
}

/** Lines of `buf` as a lazily parsed entry source (oldest first). */
function lineSource(buf: Buffer, dropFirst: boolean): EntrySource {
  const bounds: Array<[number, number]> = [];
  let s = 0;
  for (;;) {
    const nl = buf.indexOf(NL, s);
    if (nl < 0) {
      if (s < buf.length) bounds.push([s, buf.length]);
      break;
    }
    bounds.push([s, nl]);
    s = nl + 1;
  }
  if (dropFirst) bounds.shift(); // cut mid-record
  const cache = new Map<number, Obj | null>();
  return {
    length: bounds.length,
    get(i) {
      if (cache.has(i)) return cache.get(i) ?? null;
      const b = bounds[i];
      const v = b ? parseLine(buf.subarray(b[0], b[1])) : null;
      cache.set(i, v);
      return v;
    },
  };
}

/**
 * Complete lines that end before `end`, newest first. `line` is null for a
 * line longer than `maxLine` (skipped, but still reported so cursors move).
 * Bytes after the last newline before `end` (an unfinished line) are ignored.
 */
export async function* linesBackward(
  fh: FileHandle,
  end: number,
  maxLine: number,
  chunkSize = 64 * 1024,
): AsyncGenerator<{ start: number; line: Buffer | null }> {
  let pos = end;
  let lineEnd: number | null = null;
  let pieces: Buffer[] = [];
  let piecesLen = 0;
  let oversized = false;
  while (pos > 0) {
    const n = Math.min(chunkSize, pos);
    const buf = await readRange(fh, pos - n, n);
    pos -= n;
    let i = buf.length;
    while (i > 0) {
      const nl = buf.lastIndexOf(NL, i - 1);
      if (nl < 0) break;
      if (lineEnd !== null) {
        const part = buf.subarray(nl + 1, i);
        const start = pos + nl + 1;
        if (start < lineEnd) yield { start, line: oversized ? null : Buffer.concat([part, ...pieces]) };
      }
      lineEnd = pos + nl;
      pieces = [];
      piecesLen = 0;
      oversized = false;
      i = nl;
    }
    if (lineEnd !== null && i > 0 && !oversized) {
      pieces.unshift(buf.subarray(0, i));
      piecesLen += i;
      if (piecesLen > maxLine) {
        oversized = true;
        pieces = [];
      }
    }
  }
  if (lineEnd !== null && lineEnd > 0) yield { start: 0, line: oversized ? null : Buffer.concat(pieces) };
}

/** Factories['transcripts']. */
export const createTranscriptReader: Factories['transcripts'] = (ctx) => new FileTranscriptReader(ctx);

export function createFileTranscriptReader(ctx: DaemonContext, opts: TranscriptReaderOptions = {}): FileTranscriptReader {
  return new FileTranscriptReader(ctx, opts);
}
