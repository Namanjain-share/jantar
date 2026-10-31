/**
 * Following one JSONL source (v0.4 spec 4.9): the whole file once, line by
 * line, then only what was appended since. A file that shrank or was
 * replaced (a new inode) is read again from the start, once; so is one
 * rewritten in place (same inode, a script opening it "w"): seen as the same
 * size with a new mtime, or a different byte just before the saved offset.
 * A last line with no newline waits in a buffer until the rest arrives. A
 * line over 256 KiB, a line that is not a JSON object and a record with no
 * title are skipped and counted, never logged.
 *
 * The follower only reads when polled; the service polls every source on a
 * watch event in its folder and every few seconds.
 */
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { INTEL_LINE_MAX_BYTES } from '@jantar/protocol';
import { fsx, readRange } from '../sources/lib/fsx.js';
import { mapRecord, type MappedRecord } from './map.js';
import { SOURCE_REFUSED, openSource, type SourceRefusal } from './sources.js';

const CHUNK = 1024 * 1024;
const NEWLINE = 0x0a;

export interface FollowerOptions {
  /** The source id (items are `<id>:<record id>`). */
  id: string;
  path: string;
  /** The daemon's own captures file: not checked against the denylist, and a missing file is just empty. */
  own?: boolean;
  isProtected(abs: string): boolean;
}

/** What one poll found. */
export interface FollowRead {
  /** Forget what this source had first (a first read, a truncation, a new file, or a refusal). */
  reset: boolean;
  /** Mapped records in file order (a later one with the same id replaces the earlier). */
  records: MappedRecord[];
}

type Opened = { ok: true; fh: FileHandle; st: BigIntStats } | { ok: false; error: SourceRefusal | null };

export class JsonlFollower {
  readonly id: string;
  readonly path: string;
  /** The fixed sentence while the source is refused or unreadable. */
  error: SourceRefusal | undefined;
  /** Lines skipped since the last whole read. */
  skipped = 0;
  /** The file's mtime at the last read (null before one, or for a captures file not written yet). */
  updatedAt: string | null = null;
  /** Whole reads so far (the first included). */
  reads = 0;
  private file: string | null = null;
  private offset = 0;
  /** The byte at offset - 1 and the file's mtime when it was read: an append changes neither. */
  private lastByte: number | undefined;
  private mtimeNs: bigint | undefined;
  private pending: Buffer[] = [];
  private pendingLen = 0;
  /** Inside a line already past the limit: drop bytes until its newline. */
  private overlong = false;

  constructor(private readonly opts: FollowerOptions) {
    this.id = opts.id;
    this.path = opts.path;
  }

  /** Read what changed since the last poll; null when nothing did. */
  async poll(): Promise<FollowRead | null> {
    const opened = await this.open();
    if (!opened.ok) return this.fail(opened.error);
    const { fh, st } = opened;
    try {
      const size = Number(st.size);
      const file = `${st.dev}:${st.ino}`;
      this.error = undefined;
      let reset = false;
      if (file !== this.file || size < this.offset || (await this.rewritten(fh, st, size))) {
        this.restart();
        this.file = file;
        this.reads += 1;
        reset = true;
      }
      if (!reset && size === this.offset) return null;
      const records = await this.readFrom(fh, size);
      this.mtimeNs = st.mtimeNs;
      this.updatedAt = new Date(Number(st.mtimeMs)).toISOString();
      return { reset, records };
    } finally {
      await fh.close().catch(() => undefined);
    }
  }

  private async open(): Promise<Opened> {
    if (!this.opts.own) {
      const o = await openSource(this.path, (p) => this.opts.isProtected(p));
      return o.ok ? { ok: true, fh: o.fh, st: o.st } : o;
    }
    let fh: FileHandle;
    try {
      fh = await fsx.openNoFollow(this.path);
    } catch (e) {
      return { ok: false, error: (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : SOURCE_REFUSED.unreadable };
    }
    try {
      const st = await fh.stat({ bigint: true });
      if (st.isFile()) return { ok: true, fh, st };
    } catch {
      // unreadable
    }
    await fh.close().catch(() => undefined);
    return { ok: false, error: SOURCE_REFUSED.unreadable };
  }

  /** Refused, unreadable or (captures only, `error` null) not there yet: the source holds nothing. */
  private fail(error: SourceRefusal | null): FollowRead | null {
    const changed = this.file !== null || (error ?? undefined) !== this.error;
    this.restart();
    this.file = null;
    this.error = error ?? undefined;
    if (error === null) this.updatedAt = null;
    return changed ? { reset: true, records: [] } : null;
  }

  /** The same file, no shorter, but not what was read: rewritten in place. */
  private async rewritten(fh: FileHandle, st: BigIntStats, size: number): Promise<boolean> {
    if (this.offset === 0) return false;
    if (size === this.offset) return st.mtimeNs !== this.mtimeNs;
    const [byte] = await readRange(fh, this.offset - 1, 1);
    return byte !== this.lastByte;
  }

  private restart(): void {
    this.offset = 0;
    this.lastByte = undefined;
    this.mtimeNs = undefined;
    this.skipped = 0;
    this.pending = [];
    this.pendingLen = 0;
    this.overlong = false;
  }

  /** Lines from the saved offset up to `size` (what is appended meanwhile waits for the next poll). */
  private async readFrom(fh: FileHandle, size: number): Promise<MappedRecord[]> {
    const out: MappedRecord[] = [];
    while (this.offset < size) {
      const chunk = await readRange(fh, this.offset, Math.min(CHUNK, size - this.offset));
      if (chunk.length === 0) break;
      this.offset += chunk.length;
      this.lastByte = chunk[chunk.length - 1];
      this.take(chunk, out);
    }
    return out;
  }

  private take(chunk: Buffer, out: MappedRecord[]): void {
    let start = 0;
    for (let nl = chunk.indexOf(NEWLINE, start); nl >= 0; nl = chunk.indexOf(NEWLINE, start)) {
      const piece = chunk.subarray(start, nl);
      start = nl + 1;
      if (this.overlong || this.pendingLen + piece.length > INTEL_LINE_MAX_BYTES) {
        this.skipped += 1;
      } else {
        const line = this.pendingLen ? Buffer.concat([...this.pending, piece]) : piece;
        this.line(line, out);
      }
      this.pending = [];
      this.pendingLen = 0;
      this.overlong = false;
    }
    if (start >= chunk.length || this.overlong) return;
    const rest = chunk.subarray(start);
    if (this.pendingLen + rest.length > INTEL_LINE_MAX_BYTES) {
      // Never hold more than one line's worth: the rest of this line is dropped as it comes.
      this.overlong = true;
      this.pending = [];
      this.pendingLen = 0;
      return;
    }
    // Copied, so the bytes held for the next poll do not keep the whole 1 MiB read alive.
    this.pending.push(Buffer.from(rest));
    this.pendingLen += rest.length;
  }

  private line(bytes: Buffer, out: MappedRecord[]): void {
    let text = bytes.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.skipped += 1;
      return;
    }
    const mapped = mapRecord(parsed, this.id);
    if (mapped) out.push(mapped);
    else this.skipped += 1;
  }
}
