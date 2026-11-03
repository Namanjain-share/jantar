/**
 * Chat's photos on the Mac (spec 0.10 B4).
 *
 * - Only JPEG, PNG, WebP or GIF, by the magic bytes (uploads/sniff.ts);
 *   HEIC, SVG, text and the rest are refused with a fixed sentence.
 * - The size comes from `<bins.sips> -g pixelWidth -g pixelHeight <file>`
 *   (argv only), else, with no sips on this Mac, from the image's own header.
 * - Over CHAT_PHOTO_EDGE on its long edge, or over 1.5 MB, it is re-encoded:
 *   `<bins.sips> -s format jpeg -s formatOptions 80 -Z 1568 <in> --out <out>`
 *   (15 s). Without sips such a photo is refused ("too big").
 * - Written with O_EXCL and O_NOFOLLOW, 0600, as <chatDir>/photos/<id>.<ext>
 *   (0700): never through a link, never over a file. Read back the same way.
 * - The folder stays under CHAT_PHOTOS_STORE_MAX_BYTES (oldest first; their
 *   turn then shows "Photo removed").
 *
 * Nothing here logs a path or a byte; errors are logged by code.
 */
import { constants } from 'node:fs';
import { chmod, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CHAT_PHOTO_EDGE, CHAT_PHOTO_MAX_BYTES, CHAT_PHOTOS_STORE_MAX_BYTES } from '@jantar/protocol';
import type { DaemonContext, LifeResult } from '../contracts.js';
import { newId } from '../core/ids.js';
import { sniffUpload } from '../uploads/sniff.js';
import type { ChatStore, PhotoRow } from './store.js';
import { stripImageMetadata } from './strip.js';

/** A photo past this is re-encoded even when its edge is small enough. */
export const CHAT_PHOTO_REENCODE_BYTES = 1.5 * 1024 * 1024;
const SIPS_TIMEOUT_MS = 15_000;

export const CHAT_PHOTO_SENTENCES = {
  empty: 'This photo is empty.',
  tooLarge: 'Photos up to 6 MB.',
  heic: 'Send the photo again from the app.',
  notPhoto: 'Chat takes photos only (JPEG, PNG, WebP or GIF).',
  unreadable: 'That photo could not be read.',
  tooBig: 'That photo is too big; send a smaller one.',
  gone: 'No such photo.',
  sent: 'That photo was already sent.',
} as const;

/** The media type of each stored extension. */
export const PHOTO_TYPES: Readonly<Record<string, string>> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const EXT_OF: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(PHOTO_TYPES).map(([e, t]) => [t, e]));

type Refusal = Extract<LifeResult, { ok: false }>;
const refuse = (code: Refusal['code'], reason: string): Refusal => ({ ok: false, code, reason });

/** An error's code or class name for a log line: never its message. */
function errorKind(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown';
}

/** Width and height from a PNG, GIF, JPEG or WebP header; null when it can't be read. */
export function headerSize(b: Buffer): { w: number; h: number } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString('latin1', 0, 4) === 'GIF8') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1] ?? 0;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      // SOF0..SOF15 but DHT (c4), JPG (c8) and DAC (cc).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return null;
  }
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/** `sips -g` output: "  pixelWidth: 640". */
export function sipsSize(stdout: string): { w: number; h: number } | null {
  const w = /pixelWidth:\s*(\d+)/.exec(stdout)?.[1];
  const h = /pixelHeight:\s*(\d+)/.exec(stdout)?.[1];
  return w && h ? { w: Number(w), h: Number(h) } : null;
}

/** Write `bytes` to a new file: never over one, never through a link, 0600. */
async function writeNew(path: string, bytes: Buffer): Promise<void> {
  const fh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await fh.writeFile(bytes);
  } finally {
    await fh.close();
  }
}

/** Read a regular file of at most `max` bytes, never through a link. */
export async function readNoFollow(path: string, max: number): Promise<Buffer | null> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > max) return null;
    return await fh.readFile();
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

export type PhotoCtx = Pick<DaemonContext, 'exec' | 'bins' | 'paths' | 'clock' | 'log'>;

export class ChatPhotos {
  constructor(private readonly ctx: PhotoCtx) {}

  get dir(): string {
    return join(this.ctx.paths.chatDir, 'photos');
  }

  fileOf(p: Pick<PhotoRow, 'id' | 'type'>): string {
    return join(this.dir, `${p.id}.${EXT_OF[p.type] ?? 'jpg'}`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.ctx.paths.chatDir, { recursive: true, mode: 0o700 });
    await chmod(this.ctx.paths.chatDir, 0o700);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
  }

  private async size(file: string, bytes: Buffer): Promise<{ w: number; h: number } | null> {
    const sips = this.ctx.bins.sips;
    if (!sips) return headerSize(bytes);
    const r = await this.ctx.exec(sips, ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { timeoutMs: SIPS_TIMEOUT_MS });
    return r.code === 0 ? sipsSize(r.stdout) : null;
  }

  /** Check, size, maybe re-encode and keep one photo; its row is in `store` once this answers ok. */
  async add(bytes: Buffer, store: ChatStore): Promise<LifeResult<{ id: string }>> {
    if (bytes.length === 0) return refuse('invalid_request', CHAT_PHOTO_SENTENCES.empty);
    if (bytes.length > CHAT_PHOTO_MAX_BYTES) return refuse('invalid_request', CHAT_PHOTO_SENTENCES.tooLarge);
    const sniff = sniffUpload(bytes);
    if (!sniff.ok) return refuse('invalid_request', sniff.code === 'unsupported_media_type' && /HEIC/.test(sniff.reason) ? CHAT_PHOTO_SENTENCES.heic : CHAT_PHOTO_SENTENCES.notPhoto);
    if (sniff.kind !== 'image' || !PHOTO_TYPES[sniff.ext]) return refuse('invalid_request', CHAT_PHOTO_SENTENCES.notPhoto);
    await this.ensureDir();
    const id = newId();
    const incoming = join(this.dir, `${id}.in.${sniff.ext}`);
    let keep = incoming;
    let type = PHOTO_TYPES[sniff.ext] ?? 'image/jpeg';
    try {
      await writeNew(incoming, bytes);
      let size = await this.size(incoming, bytes);
      if (!size || size.w < 1 || size.h < 1) return refuse('invalid_request', CHAT_PHOTO_SENTENCES.unreadable);
      if (Math.max(size.w, size.h) > CHAT_PHOTO_EDGE || bytes.length > CHAT_PHOTO_REENCODE_BYTES) {
        const sips = this.ctx.bins.sips;
        if (!sips) return refuse('invalid_request', CHAT_PHOTO_SENTENCES.tooBig);
        const out = join(this.dir, `${id}.jpg`);
        const r = await this.ctx.exec(sips, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', String(CHAT_PHOTO_EDGE), incoming, '--out', out], { timeoutMs: SIPS_TIMEOUT_MS });
        const made = r.code === 0 ? await readNoFollow(out, CHAT_PHOTO_MAX_BYTES) : null;
        if (!made) {
          await rm(out, { force: true });
          return refuse('invalid_request', CHAT_PHOTO_SENTENCES.unreadable);
        }
        size = headerSize(made) ?? (await this.size(out, made));
        if (!size) {
          await rm(out, { force: true });
          return refuse('invalid_request', CHAT_PHOTO_SENTENCES.unreadable);
        }
        keep = out;
        type = 'image/jpeg';
      } else {
        const final = join(this.dir, `${id}.${sniff.ext}`);
        await rename(incoming, final);
        keep = final;
      }
      await chmod(keep, 0o600);
      const st = await stat(keep);
      store.addPhoto({ id, turnId: null, at: this.ctx.clock.iso(), bytes: st.size, w: size.w, h: size.h, type });
      keep = '';
      return { ok: true, value: { id } };
    } catch (e) {
      this.ctx.log.warn('chat: a photo could not be kept', { code: errorKind(e) });
      return refuse('invalid_request', CHAT_PHOTO_SENTENCES.unreadable);
    } finally {
      await rm(incoming, { force: true }).catch(() => {});
      if (keep && keep !== incoming) await rm(keep, { force: true }).catch(() => {});
    }
  }

  /** A stored photo's bytes (never through a link), or null. */
  async read(p: PhotoRow): Promise<Buffer | null> {
    return readNoFollow(this.fileOf(p), CHAT_PHOTO_MAX_BYTES);
  }

  /** The base64 the run gets, or null when the file is gone. */
  async base64(p: PhotoRow): Promise<string | null> {
    const b = await this.read(p);
    return b ? b.toString('base64') : null;
  }

  async removeFiles(rows: readonly PhotoRow[]): Promise<void> {
    for (const p of rows) await rm(this.fileOf(p), { force: true }).catch(() => {});
  }

  /** Every photo file (Clear). */
  async removeAll(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }

  /** The folder under the cap (every thread's photos): the oldest go first; returns them with their thread (their turns mark them gone). */
  async cap(store: ChatStore, max = CHAT_PHOTOS_STORE_MAX_BYTES): Promise<(PhotoRow & { thread: string })[]> {
    let total = store.photoBytes();
    if (total <= max) return [];
    const gone: (PhotoRow & { thread: string })[] = [];
    for (const p of store.photosOldestFirst()) {
      if (total <= max) break;
      store.inThread(p.thread).removePhoto(p.id);
      total -= p.bytes;
      gone.push(p);
    }
    await this.removeFiles(gone);
    return gone;
  }

  /**
   * v0.11 People (O19): her photo with its location, camera details and embedded thumbnails stripped, before
   * it is stored (strip.ts). A photo that can't be read whole is refused rather than kept with them.
   */
  async addStripped(bytes: Buffer, store: ChatStore): Promise<LifeResult<{ id: string }>> {
    const clean = stripImageMetadata(bytes);
    if (!clean) return refuse('invalid_request', CHAT_PHOTO_SENTENCES.unreadable);
    return this.add(clean, store);
  }

  /** Bytes of the photo folder on disk (status). */
  async diskBytes(): Promise<number> {
    try {
      let n = 0;
      for (const f of await readdir(this.dir)) n += (await stat(join(this.dir, f)).catch(() => ({ size: 0 }))).size;
      return n;
    } catch {
      return 0;
    }
  }
}
