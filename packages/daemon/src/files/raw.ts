/**
 * Raw bytes (v0.3 spec 4.4.5): raster images and PDF only, and only when
 * the extension and the magic bytes agree. The content type comes from the
 * table below, never from the file; nothing is ever served as `text/html`
 * or `image/svg+xml` (an SVG preview is built in the browser from the
 * `filesText` reply). Every reply carries the sandbox CSP and `nosniff`.
 */
import type { FileHandle } from 'node:fs/promises';
import { FILES_RAW_IMAGE_MAX, FILES_RAW_PDF_MAX } from '@jantar/protocol';
import type { FileRefusal, OpenedFile, RawFile } from '../contracts.js';
import { readRange } from '../sources/lib/fsx.js';
import { baseName, extOf } from './kinds.js';
import { refuse } from './policy.js';

/** The CSP on every raw reply (the per-reply header wins over the app's). */
export const RAW_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";

interface RawType {
  mime: RawFile['mime'];
  max: number;
  magic(head: Buffer): boolean;
}

const bytesAt = (head: Buffer, at: number, bytes: readonly number[]) => bytes.every((b, i) => head[at + i] === b);
const asciiAt = (head: Buffer, at: number, s: string) => head.length >= at + s.length && head.toString('latin1', at, at + s.length) === s;
/** ISO-BMFF (`....ftyp<brand>`) with one of `brands` as the major brand. */
const ftyp = (brands: readonly string[]) => (h: Buffer) => asciiAt(h, 4, 'ftyp') && h.length >= 12 && brands.includes(h.toString('latin1', 8, 12));

const PNG: RawType = { mime: 'image/png', max: FILES_RAW_IMAGE_MAX, magic: (h) => bytesAt(h, 0, [0x89, 0x50, 0x4e, 0x47]) };
const JPEG: RawType = { mime: 'image/jpeg', max: FILES_RAW_IMAGE_MAX, magic: (h) => bytesAt(h, 0, [0xff, 0xd8, 0xff]) };

/** By lower-cased extension. A `Map`, so `constructor` is not an extension. */
export const RAW_TYPES: ReadonlyMap<string, RawType> = new Map<string, RawType>([
  ['png', PNG],
  ['jpg', JPEG],
  ['jpeg', JPEG],
  ['gif', { mime: 'image/gif', max: FILES_RAW_IMAGE_MAX, magic: (h) => asciiAt(h, 0, 'GIF8') }],
  ['webp', { mime: 'image/webp', max: FILES_RAW_IMAGE_MAX, magic: (h) => asciiAt(h, 0, 'RIFF') && asciiAt(h, 8, 'WEBP') }],
  ['avif', { mime: 'image/avif', max: FILES_RAW_IMAGE_MAX, magic: ftyp(['avif', 'avis', 'mif1']) }],
  ['heic', { mime: 'image/heic', max: FILES_RAW_IMAGE_MAX, magic: ftyp(['heic', 'heix', 'mif1']) }],
  ['pdf', { mime: 'application/pdf', max: FILES_RAW_PDF_MAX, magic: (h) => asciiAt(h, 0, '%PDF-') }],
]);

/**
 * The opened file as raw bytes, or why not. On a refusal the handle is
 * closed here; on success the route streams it and closes it.
 */
export async function rawFile(file: OpenedFile): Promise<RawFile | FileRefusal> {
  const fail = async (r: FileRefusal): Promise<FileRefusal> => {
    await file.fh.close().catch(() => undefined);
    return r;
  };
  const name = baseName(file.rel);
  const type = RAW_TYPES.get(extOf(name));
  if (!type) return fail(refuse('unsupported_type'));
  const size = file.stat.size;
  if (size > type.max) {
    return fail(refuse('too_large', `This file is over ${Math.round(type.max / (1024 * 1024))} MB: Jantar does not show it.`));
  }
  let head: Buffer;
  try {
    head = await readRange(file.fh, 0, 16);
  } catch {
    return fail(refuse('missing', 'Jantar could not read that file.'));
  }
  if (!type.magic(head)) return fail(refuse('unsupported_type'));
  return { fh: file.fh, size, mime: type.mime, name };
}

/**
 * The `files.raw` audit row of a reply not sent yet, by its handle. The
 * service holds it; the route writes it once the bytes budget has taken the
 * size, or drops it on a 429, so a refused reply leaves no `ok` row.
 */
const heldRows = new WeakMap<FileHandle, () => void>();

export function holdRawRow(fh: FileHandle, write: () => void): void {
  heldRows.set(fh, write);
}

/** Writes the held row when the reply is served, drops it when it is not. */
export function settleRawRow(fh: FileHandle, served: boolean): void {
  const write = heldRows.get(fh);
  heldRows.delete(fh);
  if (served) write?.();
}

/** RFC 5987 value for `filename*` (encodeURIComponent leaves ' ( ) * alone). */
function rfc5987(s: string): string {
  return encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The headers of a raw reply (spec 4.4.5). */
export function rawHeaders(name: string): Record<string, string> {
  return {
    'content-disposition': `inline; filename*=UTF-8''${rfc5987(name)}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': RAW_CSP,
  };
}
