/**
 * The one writer of <intelDir>/captures.jsonl (spec 2.1, 5.3).
 *
 * - Every write (0.7's capture, a read's lines, tombstones, compaction) goes
 *   through one in-process lock here. Nothing else writes the file: the CLI
 *   and `jantar mcp` save through the daemon.
 * - The index comes from a streaming pass over the file (1 MiB reads, lines
 *   of at most 256 KiB, never the whole file in one array): for each record
 *   id the number of its last line, whether that line is a tombstone, and
 *   its read state; and the total line count. A file changed behind the
 *   store's back (a hand edit: another inode or size) is read again before
 *   the next write.
 * - Compaction (on every Delete, and when dead lines are more than half the
 *   file and the file is over 1 MB): `captures.jsonl.tmp` (0600,
 *   O_EXCL|O_NOFOLLOW) gets the last line of each live id in file order,
 *   then fsync and rename. A deleted item's text is then gone from disk; the
 *   shelf's follower reads the new inode from the start.
 * - The 50 MB cap (the follower skips it for the daemon's own file): past
 *   it, after a compaction, a new item is refused (`full`); a line for an
 *   item already there is still written.
 * - `failQueued`: at start, every item whose last line is still `queued` is
 *   written failed with the stopped sentence (nothing resumes by itself).
 *
 * Nothing here logs a line's text: only counts and error codes.
 */
import { constants } from 'node:fs';
import { chmod, mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { INTEL_LINE_MAX_BYTES, INTEL_READ_LIMITS, INTEL_SOURCE_MAX_BYTES } from '@jantar/protocol';
import type { Logger } from '../../contracts.js';
import { readRange } from '../../sources/lib/fsx.js';
import { recordKey } from '../map.js';
import { CAPTURES_FILE, CAPTURES_SOURCE } from '../sources.js';

/** Append only (read only for the last byte), created 0600, never through a symlink. */
export const CAPTURE_OPEN_FLAGS = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
/** The compaction's temp file: a new file only, never through a symlink. */
const TMP_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const CHUNK = 1024 * 1024;
const NEWLINE = 0x0a;
const NEWLINE_BUF = Buffer.from('\n');

/** A record as written: one JSON object with its `id`. */
export type CaptureLine = Record<string, unknown> & { id: string };

interface Entry {
  /** The number of the id's last line (0-based). */
  line: number;
  tombstone: boolean;
  /** That line's `read.state`, when it has one. */
  state?: string;
}

/** Make <dir> 0700 and append `record` to its captures.jsonl (0600), ending a torn last line first. */
export async function appendCapture(dir: string, record: Record<string, unknown>): Promise<void> {
  await appendLines(dir, [record]);
}

async function appendLines(dir: string, records: readonly Record<string, unknown>[]): Promise<{ size: number; dev: number; ino: number; torn: boolean }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const fh = await open(join(dir, CAPTURES_FILE), CAPTURE_OPEN_FLAGS, 0o600);
  try {
    await fh.chmod(0o600);
    const { size } = await fh.stat();
    const torn = size > 0 && (await readRange(fh, size - 1, 1))[0] !== NEWLINE;
    await fh.write(`${torn ? '\n' : ''}${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const st = await fh.stat();
    return { size: st.size, dev: st.dev, ino: st.ino, torn };
  } finally {
    await fh.close();
  }
}

/** Each complete line of a file, streamed (a line over the cap is passed as null). */
async function eachLine(fh: FileHandle, size: number, fn: (line: Buffer | null, n: number) => void | Promise<void>): Promise<number> {
  let offset = 0;
  let pending: Buffer[] = [];
  let pendingLen = 0;
  let overlong = false;
  let n = 0;
  while (offset < size) {
    const chunk = await readRange(fh, offset, Math.min(CHUNK, size - offset));
    if (chunk.length === 0) break;
    offset += chunk.length;
    let start = 0;
    for (let nl = chunk.indexOf(NEWLINE, start); nl >= 0; nl = chunk.indexOf(NEWLINE, start)) {
      const piece = chunk.subarray(start, nl);
      start = nl + 1;
      if (overlong || pendingLen + piece.length > INTEL_LINE_MAX_BYTES) await fn(null, n);
      else await fn(pendingLen ? Buffer.concat([...pending, piece]) : piece, n);
      n += 1;
      pending = [];
      pendingLen = 0;
      overlong = false;
    }
    if (start < chunk.length && !overlong) {
      const rest = chunk.subarray(start);
      if (pendingLen + rest.length > INTEL_LINE_MAX_BYTES) {
        overlong = true;
        pending = [];
        pendingLen = 0;
      } else {
        pending.push(Buffer.from(rest));
        pendingLen += rest.length;
      }
    }
  }
  // A last line with no newline (a torn write) counts as a line; it is never a record.
  if (pendingLen > 0 || overlong) {
    await fn(null, n);
    n += 1;
  }
  return n;
}

function parse(line: Buffer | null): unknown {
  if (line === null) return null;
  let text = line.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stateOf(raw: unknown): string | undefined {
  const read = (raw as { read?: { state?: unknown } } | null)?.read;
  return typeof read?.state === 'string' ? read.state : undefined;
}

export type AppendResult = 'ok' | 'full';

export class CapturesStore {
  private lock: Promise<unknown> = Promise.resolve();
  private index = new Map<string, Entry>();
  private lines = 0;
  private size = 0;
  /** dev:ino:size the index was built from (or last written): anything else is read again. */
  private sig: string | null = null;
  /** The last full pass succeeded (the media sweep runs only then). */
  passed = false;
  /** Compactions so far (tests). */
  compactions = 0;

  constructor(
    private readonly dir: string,
    private readonly log: Logger,
  ) {}

  get file(): string {
    return join(this.dir, CAPTURES_FILE);
  }

  /** `fn` alone: no other write starts until it settles. */
  locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.catch(() => undefined).then(fn);
    this.lock = run;
    return run;
  }

  /** Ids whose last line is not a tombstone. */
  liveIds(): Set<string> {
    const out = new Set<string>();
    for (const [rid, e] of this.index) if (!e.tombstone) out.add(rid);
    return out;
  }

  has(rid: string): boolean {
    const e = this.index.get(rid);
    return !!e && !e.tombstone;
  }

  stateOf(rid: string): string | undefined {
    const e = this.index.get(rid);
    return e && !e.tombstone ? e.state : undefined;
  }

  /** Lines that are not some live id's last line. */
  deadLines(): number {
    return this.lines - this.liveIds().size;
  }

  bytes(): number {
    return this.size;
  }

  /** The full pass now (under the lock). */
  load(): Promise<void> {
    return this.locked(async () => {
      await this.pass();
    });
  }

  /**
   * The start's pass: the index, then a failed line ("Stopped before it
   * finished.") for every item still `queued`, keeping what its last line
   * had. Answers how many.
   */
  failQueued(reason: string, at: string): Promise<number> {
    return this.locked(async () => {
      const queued = await this.pass(true);
      if (queued.length === 0) return 0;
      const lines = queued.map((r) => ({ ...r, read: { ...(r.read as object), state: 'failed', reason, at } }) as CaptureLine);
      await this.write(lines);
      return lines.length;
    });
  }

  /**
   * Append records (each an object with its `id`). `fresh`: a new item, refused
   * past the 50 MB cap after a compaction. Compacts afterwards when the dead
   * lines are more than half of a file over 1 MB.
   */
  append(records: readonly CaptureLine[], opts: { fresh?: boolean } = {}): Promise<AppendResult> {
    return this.locked(async () => {
      await this.sync();
      if (opts.fresh && this.size > INTEL_SOURCE_MAX_BYTES) {
        if (this.deadLines() > 0) await this.compactNow();
        if (this.size > INTEL_SOURCE_MAX_BYTES) return 'full';
      }
      await this.write(records);
      if (this.size > INTEL_READ_LIMITS.compactMinBytes && this.deadLines() > this.lines * INTEL_READ_LIMITS.compactDeadShare) await this.compactNow();
      return 'ok';
    });
  }

  /** A tombstone for `rid`, then a compaction (its text leaves the disk). False when it was not there. */
  remove(rid: string): Promise<boolean> {
    return this.locked(async () => {
      await this.sync();
      if (!this.has(rid)) return false;
      await this.write([{ id: rid, deleted: true }]);
      await this.compactNow();
      return true;
    });
  }

  /** Compact now (tests, and a Retry when the file is over its cap). */
  compact(): Promise<void> {
    return this.locked(async () => {
      await this.sync();
      await this.compactNow();
    });
  }

  // -------------------------------------------------------------------------

  /** Read the file again when it is not the one the index came from. */
  private async sync(): Promise<void> {
    const st = await this.stat();
    if (st === null) {
      if (this.sig !== null || this.lines > 0) this.reset();
      this.sig = null;
      return;
    }
    if (st !== this.sig) await this.pass();
  }

  private async stat(): Promise<string | null> {
    let fh: FileHandle;
    try {
      fh = await open(this.file, READ_FLAGS);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    try {
      const st = await fh.stat();
      return `${st.dev}:${st.ino}:${st.size}`;
    } finally {
      await fh.close().catch(() => undefined);
    }
  }

  private reset(): void {
    this.index = new Map();
    this.lines = 0;
    this.size = 0;
  }

  /** The streaming pass; with `wantQueued`, the last lines still queued (their records). */
  private async pass(wantQueued = false): Promise<CaptureLine[]> {
    this.passed = false;
    let fh: FileHandle;
    try {
      fh = await open(this.file, READ_FLAGS);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.reset();
      this.sig = null;
      this.passed = true;
      return [];
    }
    const index = new Map<string, Entry>();
    const queued = new Map<string, { line: number; rec: CaptureLine }>();
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'EINVAL' });
      const lines = await eachLine(fh, st.size, (buf, n) => {
        const raw = parse(buf);
        const key = recordKey(raw, CAPTURES_SOURCE);
        if (!key) return;
        const state = key.deleted ? undefined : stateOf(raw);
        index.set(key.rid, { line: n, tombstone: key.deleted, ...(state !== undefined ? { state } : {}) });
        if (wantQueued) {
          if (state === 'queued') queued.set(key.rid, { line: n, rec: { ...(raw as object), id: key.rid } as CaptureLine });
          else queued.delete(key.rid);
        }
      });
      this.index = index;
      this.lines = lines;
      this.size = st.size;
      this.sig = `${st.dev}:${st.ino}:${st.size}`;
      this.passed = true;
    } finally {
      await fh.close().catch(() => undefined);
    }
    return [...queued.values()].filter((q) => index.get(q.rec.id)?.line === q.line).map((q) => q.rec);
  }

  /** Append and index (the lock is held). */
  private async write(records: readonly CaptureLine[]): Promise<void> {
    if (records.length === 0) return;
    const st = await appendLines(this.dir, records);
    // A torn last line we ended was already counted as a line.
    let n = this.lines;
    for (const r of records) {
      const key = recordKey(r, CAPTURES_SOURCE);
      if (key) {
        const state = key.deleted ? undefined : stateOf(r);
        this.index.set(key.rid, { line: n, tombstone: key.deleted, ...(state !== undefined ? { state } : {}) });
      }
      n += 1;
    }
    this.lines = n;
    this.size = st.size;
    this.sig = `${st.dev}:${st.ino}:${st.size}`;
  }

  /** The compaction (the lock is held and the index is current). */
  private async compactNow(): Promise<void> {
    const keep = new Set<number>();
    for (const e of this.index.values()) if (!e.tombstone) keep.add(e.line);
    const tmp = `${this.file}.tmp`;
    await rm(tmp, { force: true });
    let src: FileHandle;
    try {
      src = await open(this.file, READ_FLAGS);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    const out = await open(tmp, TMP_FLAGS, 0o600);
    try {
      const st = await src.stat();
      const batch: Buffer[] = [];
      let batchLen = 0;
      const flush = async () => {
        if (batch.length === 0) return;
        await out.write(Buffer.concat(batch));
        batch.length = 0;
        batchLen = 0;
      };
      await eachLine(src, st.size, async (buf, n) => {
        if (buf === null || !keep.has(n)) return;
        batch.push(Buffer.from(buf), NEWLINE_BUF);
        batchLen += buf.length + 1;
        if (batchLen >= CHUNK) await flush();
      });
      await flush();
      await out.sync();
    } catch (e) {
      await out.close().catch(() => undefined);
      await rm(tmp, { force: true });
      throw e;
    } finally {
      await src.close().catch(() => undefined);
    }
    await out.close();
    await rename(tmp, this.file);
    this.compactions += 1;
    await this.pass();
    this.log.info('intel captures compacted', { lines: this.lines });
  }
}
