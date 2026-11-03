/**
 * v0.11 People (O19, spec 7.8): a photo's metadata stripped before it is
 * stored, so {owner}'s read-only view of her chat never shows where she was
 * or which camera took it. Written fresh for Jantar (pure byte walking, no
 * dependency), by format:
 *
 * - JPEG: every APPn segment goes (EXIF with GPS and the embedded
 *   thumbnail, XMP, maker notes) but the colour ones the picture needs
 *   (APP2 `ICC_PROFILE`, APP14 `Adobe`); APP0 JFIF is rewritten with no
 *   thumbnail; comments (COM) go. Everything from the first scan on is kept
 *   as it is.
 * - PNG: `eXIf`, `tEXt`, `zTXt`, `iTXt` and `tIME` chunks go.
 * - WebP: the `EXIF` and `XMP ` chunks go, the VP8X flags and the RIFF
 *   size follow.
 * - GIF: comment extensions and application extensions other than the
 *   looping ones (NETSCAPE2.0, ANIMEXTS1.0) go.
 *
 * Anything that doesn't walk cleanly answers null: the photo is refused,
 * never kept with its metadata.
 */

const JPEG_KEEP_APP = (marker: number, body: Buffer): boolean =>
  (marker === 0xe2 && body.toString('latin1', 0, 12) === 'ICC_PROFILE\0') || (marker === 0xee && body.toString('latin1', 0, 5) === 'Adobe');

/** A JFIF APP0 with its thumbnail dropped (16-byte header, 0×0 thumbnail). */
function jfifWithoutThumbnail(body: Buffer): Buffer {
  if (body.length < 14 || body.toString('latin1', 0, 5) !== 'JFIF\0') return Buffer.alloc(0);
  const head = Buffer.from(body.subarray(0, 14));
  head[12] = 0;
  head[13] = 0;
  return head;
}

function stripJpeg(b: Buffer): Buffer | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] ?? 0;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd9) {
      out.push(b.subarray(i, i + 2));
      return Buffer.concat(out);
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      out.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    const body = b.subarray(i + 4, i + 2 + len);
    if (marker === 0xda) {
      // Start of scan: the rest is image data (and, in a progressive file, its own tables); kept as it is.
      out.push(b.subarray(i));
      return Buffer.concat(out);
    }
    if (marker === 0xe0) {
      const jfif = jfifWithoutThumbnail(body);
      if (jfif.length) {
        const seg = Buffer.alloc(4);
        seg[0] = 0xff;
        seg[1] = 0xe0;
        seg.writeUInt16BE(jfif.length + 2, 2);
        out.push(seg, jfif);
      }
    } else if (marker === 0xfe || (marker >= 0xe1 && marker <= 0xef && !JPEG_KEEP_APP(marker, body))) {
      // a comment, EXIF (GPS, camera serial, thumbnail), XMP or another app's block: dropped
    } else out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}

const PNG_SIG = Buffer.from('89504e470d0a1a0a', 'hex');
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripPng(b: Buffer): Buffer | null {
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIG)) return null;
  const out: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > b.length) return null;
    if (!PNG_DROP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(out);
  }
  return null;
}

function stripWebp(b: Buffer): Buffer | null {
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunks: Buffer[] = [];
  let i = 12;
  let vp8x: Buffer | null = null;
  while (i + 8 <= b.length) {
    const type = b.toString('latin1', i, i + 4);
    const size = b.readUInt32LE(i + 4);
    const end = i + 8 + size + (size % 2);
    if (i + 8 + size > b.length) return null;
    const chunk = Buffer.from(b.subarray(i, Math.min(end, b.length)));
    if (type === 'EXIF' || type === 'XMP ') {
      // dropped
    } else {
      if (type === 'VP8X') vp8x = chunk;
      chunks.push(chunk);
    }
    i = end;
  }
  if (i < b.length - 1) return null;
  // VP8X flags: bit 3 EXIF, bit 2 XMP; neither is there now.
  if (vp8x && vp8x.length > 8) vp8x[8] = (vp8x[8] ?? 0) & ~(0x08 | 0x04);
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

/** Sub-blocks from `i` (each a length byte and its bytes, ending with 0): the index after them, or -1. */
function subBlocksEnd(b: Buffer, i: number): number {
  let at = i;
  while (at < b.length) {
    const n = b[at] ?? 0;
    at += 1;
    if (n === 0) return at;
    at += n;
  }
  return -1;
}

function stripGif(b: Buffer): Buffer | null {
  if (b.length < 13 || b.toString('latin1', 0, 4) !== 'GIF8') return null;
  const flags = b[10] ?? 0;
  let i = 13 + (flags & 0x80 ? 3 * (1 << ((flags & 0x07) + 1)) : 0);
  if (i > b.length) return null;
  const out: Buffer[] = [b.subarray(0, i)];
  while (i < b.length) {
    const kind = b[i];
    if (kind === 0x3b) {
      out.push(b.subarray(i, i + 1));
      return Buffer.concat(out);
    }
    if (kind === 0x2c) {
      if (i + 10 > b.length) return null;
      const lf = b[i + 9] ?? 0;
      let at = i + 10 + (lf & 0x80 ? 3 * (1 << ((lf & 0x07) + 1)) : 0);
      at += 1; // LZW minimum code size
      const end = subBlocksEnd(b, at);
      if (end < 0) return null;
      out.push(b.subarray(i, end));
      i = end;
      continue;
    }
    if (kind === 0x21) {
      const label = b[i + 1];
      const end = subBlocksEnd(b, i + 2);
      if (end < 0) return null;
      const id = label === 0xff && (b[i + 2] ?? 0) >= 11 ? b.toString('latin1', i + 3, i + 14) : '';
      const drop = label === 0xfe || (label === 0xff && id !== 'NETSCAPE2.0' && id !== 'ANIMEXTS1.0');
      if (!drop) out.push(b.subarray(i, end));
      i = end;
      continue;
    }
    return null;
  }
  return null;
}

/** The photo without its metadata, or null when it doesn't read as JPEG, PNG, WebP or GIF all the way through. */
export function stripImageMetadata(b: Buffer): Buffer | null {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) return stripJpeg(b);
  if (b.length >= 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return stripPng(b);
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF') return stripWebp(b);
  if (b.length >= 4 && b.toString('latin1', 0, 4) === 'GIF8') return stripGif(b);
  return null;
}
