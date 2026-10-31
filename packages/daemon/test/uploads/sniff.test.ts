/**
 * U4: an upload's type comes from its bytes only. Images Claude reads (png,
 * jpeg, gif, webp), PDF, office zips the phone named docx/xlsx/pptx, and
 * UTF-8 text; HEIC, video, a zip without an office extension and binary
 * sent as text are refused. The stored extension comes from the bytes, or
 * the allowlisted `ext` for text and office files.
 */
import { describe, expect, it } from 'vitest';
import { UPLOAD_MAX_BYTES, UPLOAD_TEXT_MAX_BYTES } from '@jantar/protocol';
import { UPLOAD_TOO_LARGE } from '../../src/api/errors.js';
import { kindOf } from '../../src/files/kinds.js';
import { EMPTY_UPLOAD, HEIC_REFUSED, OFFICE_UPLOAD_EXTS, TEXT_TOO_LARGE, TEXT_UPLOAD_EXTS, TYPE_REFUSED, sniffUpload } from '../../src/uploads/sniff.js';
import { GIF, JPEG, NOTES, PDF, PNG, WEBP, ZIP, ftyp } from './helpers.js';

const bytes = (...parts: (string | number[])[]) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));

describe('sniffUpload: what the bytes are', () => {
  it('images by their magic bytes, stored under the extension the bytes give, whatever the phone said', () => {
    expect(sniffUpload(PNG)).toEqual({ ok: true, kind: 'image', ext: 'png' });
    expect(sniffUpload(JPEG, 'png')).toEqual({ ok: true, kind: 'image', ext: 'jpg' });
    expect(sniffUpload(GIF, 'txt')).toEqual({ ok: true, kind: 'image', ext: 'gif' });
    expect(sniffUpload(WEBP, 'md')).toEqual({ ok: true, kind: 'image', ext: 'webp' });
  });

  it('a PDF by %PDF- at the start', () => {
    expect(sniffUpload(PDF, 'docx')).toEqual({ ok: true, kind: 'pdf', ext: 'pdf' });
    expect(sniffUpload(bytes(' %PDF-1.7'))).toEqual({ ok: true, kind: 'text', ext: 'txt' });
  });

  it('a zip is an office document only when the phone named it docx, xlsx or pptx', () => {
    for (const ext of ['docx', 'xlsx', 'pptx']) expect(sniffUpload(ZIP, ext)).toEqual({ ok: true, kind: 'office', ext });
    expect([...OFFICE_UPLOAD_EXTS].sort()).toEqual(['docx', 'pptx', 'xlsx']);
    for (const ext of [undefined, 'zip', 'jar', 'txt', 'doc']) {
      expect(sniffUpload(ZIP, ext), String(ext)).toEqual({ ok: false, code: 'unsupported_media_type', reason: TYPE_REFUSED });
    }
  });

  it('UTF-8 text keeps an allowlisted extension, else it is stored as txt', () => {
    expect(sniffUpload(NOTES, 'md')).toEqual({ ok: true, kind: 'text', ext: 'md' });
    expect(sniffUpload(NOTES, 'ts')).toEqual({ ok: true, kind: 'text', ext: 'ts' });
    expect(sniffUpload(NOTES)).toEqual({ ok: true, kind: 'text', ext: 'txt' });
    for (const ext of ['exe', 'svg', 'docx', 'pdf', 'png', 'heic', 'sqlite']) {
      expect(sniffUpload(NOTES, ext), ext).toEqual({ ok: true, kind: 'text', ext: 'txt' });
    }
    // A BOM, accents and emoji are text.
    expect(sniffUpload(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('café ☕ 🙂\n')]), 'csv')).toEqual({ ok: true, kind: 'text', ext: 'csv' });
  });

  it('every text extension kept is a text or Markdown kind of files/kinds.ts, and fits the upload query', () => {
    for (const ext of ['txt', 'md', 'csv', 'json', 'log']) expect(TEXT_UPLOAD_EXTS.has(ext), ext).toBe(true);
    for (const ext of TEXT_UPLOAD_EXTS) {
      expect(['text', 'markdown'], ext).toContain(kindOf(`x.${ext}`)?.kind);
      expect(ext, ext).toMatch(/^[a-z0-9]{1,8}$/);
    }
  });
});

describe('sniffUpload: refusals', () => {
  it('HEIC and HEIF are refused with their own sentence, whatever the phone named them', () => {
    for (const brand of ['heic', 'heix', 'hevc', 'mif1', 'msf1']) {
      expect(sniffUpload(ftyp(brand), 'jpg'), brand).toEqual({ ok: false, code: 'unsupported_media_type', reason: HEIC_REFUSED });
    }
  });

  it('video, AVIF and other binaries are refused', () => {
    for (const [name, b] of [
      ['mp4', ftyp('isom')],
      ['mov', ftyp('qt  ')],
      ['avif', ftyp('avif')],
      ['elf', bytes([0x7f], 'ELF', [0x02, 0x01, 0x01, 0x00])],
      ['sqlite', bytes('SQLite format 3', [0x00])],
      ['bmp', bytes('BM', [0x36, 0x00, 0x0c, 0x00, 0x00, 0x00])],
    ] as const) {
      expect(sniffUpload(b, 'txt'), name).toEqual({ ok: false, code: 'unsupported_media_type', reason: TYPE_REFUSED });
    }
  });

  it('binary sent as text is refused: a NUL anywhere, invalid UTF-8, UTF-16, or mostly control characters', () => {
    const late = Buffer.concat([Buffer.alloc(64 * 1024, 'a'), Buffer.from([0x00]), Buffer.from('tail')]);
    expect(sniffUpload(late, 'txt')).toMatchObject({ ok: false, reason: TYPE_REFUSED });
    expect(sniffUpload(bytes('caf', [0xe9], ' au lait'), 'txt')).toMatchObject({ ok: false, reason: TYPE_REFUSED });
    expect(sniffUpload(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('notes', 'utf16le')]), 'txt')).toMatchObject({ ok: false, reason: TYPE_REFUSED });
    expect(sniffUpload(Buffer.from('\u0001\u0002\u0003\u0004 ab'), 'txt')).toMatchObject({ ok: false, reason: TYPE_REFUSED });
  });

  it('an empty file is refused', () => {
    expect(sniffUpload(Buffer.alloc(0), 'txt')).toEqual({ ok: false, code: 'invalid_request', reason: EMPTY_UPLOAD });
  });

  it('sizes: text up to 2 MiB, anything up to 20 MiB', () => {
    expect(sniffUpload(Buffer.alloc(UPLOAD_TEXT_MAX_BYTES, 'a'), 'txt')).toMatchObject({ ok: true, kind: 'text' });
    expect(sniffUpload(Buffer.alloc(UPLOAD_TEXT_MAX_BYTES + 1, 'a'), 'txt')).toEqual({ ok: false, code: 'payload_too_large', reason: TEXT_TOO_LARGE });
    // Over the text cap and not text: the type sentence, not the size one.
    const blob = Buffer.alloc(UPLOAD_TEXT_MAX_BYTES + 1);
    expect(sniffUpload(blob)).toEqual({ ok: false, code: 'unsupported_media_type', reason: TYPE_REFUSED });
    const big = Buffer.concat([PDF, Buffer.alloc(UPLOAD_MAX_BYTES - PDF.length)]);
    expect(sniffUpload(big)).toMatchObject({ ok: true, kind: 'pdf' });
    expect(sniffUpload(Buffer.concat([big, Buffer.from('x')]))).toEqual({ ok: false, code: 'payload_too_large', reason: UPLOAD_TOO_LARGE });
  });
});
