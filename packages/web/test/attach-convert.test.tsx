/**
 * Preparing a file on the phone (v0.4.2, spec 6.2: session/attach/convert.ts),
 * with jsdom's image decoding and canvas stubbed (attach-helpers.ts): photos
 * become JPEG with the long edge at most 2000 px (HEIC included, by type or
 * by extension), small PNG and WebP and every GIF go as they are, PDF, office
 * and text keep their extension (SVG goes as text, never drawn), and video,
 * audio, unknown kinds and files
 * over the limits are refused with the chip's sentence. Only canvas.toBlob:
 * never a data: URL.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_IMAGE_EDGE, UPLOAD_MAX_BYTES, UPLOAD_TEXT_MAX_BYTES } from '@jantar/protocol';
import { JPEG_QUALITY, KEEP_IMAGE_BYTES, REFUSED, isImage, ownName, prepareFile, type PreparedFile } from '../src/ui/screens/session/attach/convert.js';
import { imageEnv, pdf, photo } from './attach-helpers.js';

let env: ReturnType<typeof imageEnv> | null = null;
afterEach(() => {
  env?.restore();
  env = null;
  vi.restoreAllMocks();
});

/** A file of `bytes` bytes (the content does not matter to the phone). */
const sized = (name: string, type: string, bytes: number) => new File([new Uint8Array(bytes)], name, { type });

async function prepared(file: File): Promise<PreparedFile> {
  const p = await prepareFile(file);
  if ('refused' in p) throw new Error(`refused: ${p.refused}`);
  return p;
}

describe('photos', () => {
  it('a HEIC photo becomes a JPEG of at most 2000 px on its long edge, named without its old extension', async () => {
    env = imageEnv({ width: 4032, height: 3024 });
    const p = await prepared(photo('IMG_0412.HEIC'));
    expect(p).toMatchObject({ ext: 'jpg', kind: 'image', name: 'IMG_0412' });
    expect(p.blob.type).toBe('image/jpeg');
    expect(env.drawn).toEqual([{ width: UPLOAD_IMAGE_EDGE, height: 1500 }]);
    expect(env.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', JPEG_QUALITY);
    // A white page under the picture (JPEG has no transparency), from an object URL that is revoked after.
    expect(env.ctx.fillStyle).toBe('white');
    expect(env.createObjectURL).toHaveBeenCalledTimes(1);
    expect(env.revokeObjectURL).toHaveBeenCalledWith(env.created[0]);
    expect(env.created[0]?.startsWith('blob:')).toBe(true);
    expect(env.toDataURL).not.toHaveBeenCalled();
  });

  it('knows a HEIC by its extension when iOS gives it no type', async () => {
    env = imageEnv({ width: 3000, height: 4000 });
    const p = await prepared(photo('IMG_0413.heic', ''));
    expect(p).toMatchObject({ ext: 'jpg', kind: 'image', name: 'IMG_0413' });
    expect(env.drawn).toEqual([{ width: 1500, height: UPLOAD_IMAGE_EDGE }]);
  });

  it('re-encodes even a small JPEG (its EXIF, GPS included, does not survive the canvas)', async () => {
    env = imageEnv({ width: 800, height: 600 });
    const p = await prepared(photo('IMG_0414.jpg', 'image/jpeg'));
    expect(p).toMatchObject({ ext: 'jpg', name: 'IMG_0414' });
    expect(env.drawn).toEqual([{ width: 800, height: 600 }]);
  });

  it('keeps a small PNG or WebP as it is, and converts one that is too big in pixels or bytes', async () => {
    env = imageEnv({ width: 1200, height: 900 });
    const small = sized('diagram.png', 'image/png', 4096);
    expect(await prepared(small)).toEqual({ blob: small, ext: 'png', kind: 'image', name: 'diagram.png' });
    const webp = sized('chart.webp', 'image/webp', 4096);
    expect(await prepared(webp)).toEqual({ blob: webp, ext: 'webp', kind: 'image', name: 'chart.webp' });
    expect(env.drawn).toEqual([]);

    const heavy = sized('heavy.png', 'image/png', KEEP_IMAGE_BYTES + 1);
    expect(await prepared(heavy)).toMatchObject({ ext: 'jpg', name: 'heavy' });
    env.state.width = 2400;
    expect(await prepared(sized('wide.png', 'image/png', 4096))).toMatchObject({ ext: 'jpg', name: 'wide' });
    expect(env.drawn).toEqual([
      { width: 1200, height: 900 },
      { width: UPLOAD_IMAGE_EDGE, height: 750 },
    ]);
  });

  it('sends a GIF as it is, without decoding it', async () => {
    env = imageEnv();
    const gif = sized('loop.gif', 'image/gif', 2048);
    expect(await prepared(gif)).toEqual({ blob: gif, ext: 'gif', kind: 'image', name: 'loop.gif' });
    expect(env.decode).not.toHaveBeenCalled();
  });

  it('sends the original when the phone cannot decode it (the Mac then says why it cannot take it)', async () => {
    env = imageEnv();
    env.state.fail = true;
    const heic = photo('IMG_0415.HEIC');
    expect(await prepared(heic)).toEqual({ blob: heic, ext: 'heic', kind: 'image', name: 'IMG_0415.HEIC' });
    expect(env.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('where there is no image decoding at all: a JPEG is refused (its EXIF would go with it), another image goes as it is', async () => {
    // jsdom as it is: no object URLs and no img.decode.
    expect(await prepareFile(photo('IMG_0416.jpg', 'image/jpeg'))).toEqual({ refused: REFUSED.photo });
    const png = sized('diagram.png', 'image/png', 64);
    expect(await prepared(png)).toEqual({ blob: png, ext: 'png', kind: 'image', name: 'diagram.png' });
  });

  it('a JPEG the phone cannot decode is refused, not sent with its EXIF', async () => {
    env = imageEnv();
    env.state.fail = true;
    expect(await prepareFile(photo('IMG_0417.jpg', 'image/jpeg'))).toEqual({ refused: REFUSED.photo });
  });

  it('a small PNG or WebP with metadata chunks (EXIF, XMP, text) is drawn again as PNG: its pixels go, its metadata does not', async () => {
    env = imageEnv({ width: 1200, height: 900 });
    const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
    const ascii = (t: string) => [...t].map((c) => c.charCodeAt(0));
    const pngChunk = (type: string, data: number[]) => [...be(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
    const png = (...chunks: number[][]) => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunks.flat()])], 'shot.png', { type: 'image/png' });
    const IHDR = pngChunk('IHDR', Array.from({ length: 13 }, () => 0));
    const IEND = pngChunk('IEND', []);
    for (const meta of ['eXIf', 'tEXt', 'iTXt', 'zTXt']) {
      const p = await prepared(png(IHDR, pngChunk(meta, ascii('GPS 12.97 77.59')), IEND));
      expect(p, meta).toMatchObject({ ext: 'png', kind: 'image', name: 'shot' });
      expect(p.blob.type, meta).toBe('image/png');
    }
    expect(env.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png', undefined);
    // Anything after the image's end is drawn away too; no metadata at all: kept as it is.
    expect(await prepared(png(IHDR, pngChunk('IDAT', [1, 2, 3]), IEND, ascii('trailing words')))).toMatchObject({ ext: 'png', name: 'shot' });
    const plain = png(IHDR, pngChunk('IDAT', [1, 2, 3]), IEND);
    expect(await prepared(plain)).toEqual({ blob: plain, ext: 'png', kind: 'image', name: 'shot.png' });

    const webpChunk = (id: string, data: number[]) => [...ascii(id), ...le(data.length), ...data, ...(data.length % 2 ? [0] : [])];
    const webp = (...chunks: number[][]) => {
      const body = [...ascii('WEBP'), ...chunks.flat()];
      return new File([new Uint8Array([...ascii('RIFF'), ...le(body.length), ...body])], 'chart.webp', { type: 'image/webp' });
    };
    const VP8X = webpChunk('VP8X', Array.from({ length: 10 }, () => 0));
    for (const meta of ['EXIF', 'XMP ']) expect(await prepared(webp(VP8X, webpChunk('VP8 ', [1, 2, 3]), webpChunk(meta, ascii('GPS'))))).toMatchObject({ ext: 'png', name: 'chart' });
    const clean = webp(VP8X, webpChunk('VP8 ', [1, 2, 3]));
    expect(await prepared(clean)).toEqual({ blob: clean, ext: 'webp', kind: 'image', name: 'chart.webp' });
  });

  it('names a pasted image by nothing of its own, so the composer can number it', async () => {
    env = imageEnv({ width: 640, height: 480 });
    const pasted = new File(['x'], 'image.png', { type: 'image/png' });
    expect(ownName(pasted)).toBe('');
    expect((await prepared(pasted)).name).toBe('');
    expect(ownName(new File(['x'], '', { type: 'image/png' }))).toBe('');
    expect(ownName(new File(['x'], 'folder/sub/IMG_1.jpg'))).toBe('IMG_1.jpg');
    expect(isImage(pasted)).toBe(true);
    expect(isImage(photo('a.HEIC', ''))).toBe(true);
    expect(isImage(pdf())).toBe(false);
  });
});

describe('documents and text', () => {
  it('PDF and office documents go as they are, with their extension', async () => {
    const doc = pdf('budget.pdf');
    expect(await prepared(doc)).toEqual({ blob: doc, ext: 'pdf', kind: 'pdf', name: 'budget.pdf' });
    const untyped = sized('scan.PDF', '', 100);
    expect(await prepared(untyped)).toMatchObject({ ext: 'pdf', kind: 'pdf' });
    for (const ext of ['docx', 'xlsx', 'pptx']) {
      const f = sized(`report.${ext}`, '', 100);
      expect(await prepared(f)).toEqual({ blob: f, ext, kind: 'office', name: `report.${ext}` });
    }
  });

  it('text and code keep an extension the Mac knows, else go as txt', async () => {
    const cases: [File, string][] = [
      [new File(['# notes'], 'notes.md', { type: 'text/markdown' }), 'md'],
      [new File(['let a = 1'], 'main.ts', { type: '' }), 'ts'],
      [new File(['a,b'], 'table.csv', { type: 'text/csv' }), 'csv'],
      [new File(['{}'], 'data.json', { type: 'application/json' }), 'json'],
      [new File(['WEBVTT'], 'talk.vtt', { type: 'text/vtt' }), 'txt'],
      [new File(['a=1'], 'app.properties', { type: 'text/plain' }), 'txt'],
      [new File(['all:'], 'Makefile', { type: '' }), 'txt'],
    ];
    for (const [file, ext] of cases) expect(await prepared(file), file.name).toMatchObject({ blob: file, ext, kind: 'text', name: file.name });
  });

  it('SVG goes as its text, with its name, never drawn as a picture', async () => {
    env = imageEnv();
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'drawing.svg', { type: 'image/svg+xml' });
    expect(await prepared(svg)).toEqual({ blob: svg, ext: 'txt', kind: 'text', name: 'drawing.svg' });
    const untyped = new File(['<svg/>'], 'icon.svg', { type: '' });
    expect(await prepared(untyped)).toEqual({ blob: untyped, ext: 'txt', kind: 'text', name: 'icon.svg' });
    expect(isImage(svg)).toBe(false);
    expect(env.decode).not.toHaveBeenCalled();
    expect(env.toBlob).not.toHaveBeenCalled();
  });
});

describe('refusals', () => {
  it('video and audio, by type or by extension', async () => {
    for (const f of [sized('clip.mov', 'video/quicktime', 10), sized('memo.m4a', 'audio/mp4', 10), sized('clip.mp4', '', 10)]) {
      expect(await prepareFile(f), f.name).toEqual({ refused: REFUSED.media });
    }
    expect(REFUSED.media).toBe("Claude can't watch video or listen to audio");
  });

  it('kinds Claude cannot read', async () => {
    for (const f of [sized('archive.zip', 'application/zip', 10), sized('old.doc', 'application/msword', 10), sized('blob', '', 10)]) {
      expect(await prepareFile(f), f.name).toEqual({ refused: REFUSED.kind });
    }
  });

  it('files over the limits: 20 MB, and 2 MB for text', async () => {
    expect(await prepareFile(sized('huge.pdf', 'application/pdf', UPLOAD_MAX_BYTES + 1))).toEqual({ refused: 'Larger than 20 MB' });
    expect(await prepareFile(sized('edge.pdf', 'application/pdf', UPLOAD_MAX_BYTES))).toMatchObject({ kind: 'pdf' });
    expect(await prepareFile(sized('big.log', 'text/plain', UPLOAD_TEXT_MAX_BYTES + 1))).toEqual({ refused: 'Text files up to 2 MB' });
    expect(await prepareFile(sized('ok.log', 'text/plain', UPLOAD_TEXT_MAX_BYTES))).toMatchObject({ kind: 'text', ext: 'log' });
  });
});
