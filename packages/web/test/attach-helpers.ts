/**
 * Helpers for the v0.4.2 attachment tests (attachments, attach-convert,
 * send and rewrite): synthetic files, a fake upload route whose replies the
 * test hands out one by one, and a jsdom stand-in for image decoding and
 * the canvas (jsdom has neither). Every name and byte here is made up.
 */
import { vi } from 'vitest';
import type { UploadKind, UploadResponse } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';

/** An upload id as the daemon makes them (a lowercase ULID), the n-th one. */
export const uploadId = (n: number) => `01jfz8x8y3t0v5g9wqk2m4n6${String(n).padStart(2, '0')}`;

export const pdf = (name = 'notes.pdf') => new File(['%PDF-1.4 synthetic'], name, { type: 'application/pdf' });
export const textFile = (name = 'plan.md', body = '# A synthetic plan\n') => new File([body], name, { type: 'text/markdown' });
export const photo = (name = 'IMG_0001.HEIC', type = 'image/heic') => new File(['synthetic photo bytes'], name, { type });

interface UploadCall {
  sid: string;
  blob: Blob;
  opts: { ext?: string; onProgress?: (sent: number, total: number) => void; signal?: AbortSignal };
  resolve: (r: UploadResponse) => void;
  reject: (e: unknown) => void;
}

/**
 * api.uploadCreate and api.uploadDelete as fakes: each upload waits until
 * the test calls `finish(i)` or `fail(i, error)`, and an abort through the
 * signal rejects it as lib/upload.ts does.
 */
export function fakeUploads() {
  const calls: UploadCall[] = [];
  let n = 0;
  const uploadCreate = vi.fn(
    (sid: string, blob: Blob, opts: UploadCall['opts'] = {}) =>
      new Promise<UploadResponse>((resolve, reject) => {
        calls.push({ sid, blob, opts, resolve, reject });
        opts.signal?.addEventListener('abort', () => reject(new ApiError('network', 'The upload was stopped', 0)));
      }),
  );
  const uploadDelete = vi.fn(async (_sid: string, _id: string) => undefined);
  /** Answer upload `i` (in call order) with the next id. Returns that id. */
  const finish = (i: number, kind: UploadKind = 'pdf') => {
    const call = calls[i];
    if (!call) throw new Error(`no upload ${i}`);
    n += 1;
    const id = uploadId(n);
    call.resolve({ upload: { id, kind, bytes: call.blob.size } });
    return id;
  };
  const fail = (i: number, e: unknown) => calls[i]?.reject(e);
  return { calls, uploadCreate, uploadDelete, finish, fail };
}

/**
 * Image decoding and the canvas for jsdom: every `<img>` decodes to
 * `state.width` x `state.height` (or fails with `state.fail`), the 2D
 * context records what is drawn, and `toBlob` returns a synthetic JPEG of
 * the canvas's size, with object URLs counted. Call `restore()` after the
 * test (with vi.restoreAllMocks): jsdom has no img.decode and no object URLs.
 */
export function imageEnv(size: { width: number; height: number } = { width: 4000, height: 3000 }) {
  const state = { ...size, fail: false };
  let made = 0;
  const created: string[] = [];
  const createObjectURL = vi.fn((_b: Blob) => {
    made += 1;
    const url = `blob:http://127.0.0.1:7420/attach-${made}`;
    created.push(url);
    return url;
  });
  const revokeObjectURL = vi.fn((_u: string) => undefined);
  const had = { createObjectURL: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'), revokeObjectURL: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL') };
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  const decode = vi.fn(async () => {
    if (state.fail) throw new Error('synthetic: cannot decode');
  });
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, writable: true, value: decode });
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockImplementation(() => state.width);
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockImplementation(() => state.height);
  const drawn: { width: number; height: number }[] = [];
  const ctx = {
    fillStyle: '',
    fillRect: vi.fn(),
    drawImage: vi.fn((_img: unknown, _x: number, _y: number, width: number, height: number) => {
      drawn.push({ width, height });
    }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctx) as unknown as HTMLCanvasElement['getContext']);
  const toBlob = vi
    .spyOn(HTMLCanvasElement.prototype, 'toBlob')
    .mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback, type?: string) {
      cb(new Blob([`synthetic jpeg ${this.width}x${this.height}`], { type: type ?? 'image/png' }));
    });
  const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL');
  return {
    state,
    created,
    createObjectURL,
    revokeObjectURL,
    decode,
    ctx,
    drawn,
    toBlob,
    toDataURL,
    restore() {
      delete (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode;
      for (const [name, d] of Object.entries(had)) {
        if (d) Object.defineProperty(URL, name, d);
        else delete (URL as unknown as Record<string, unknown>)[name];
      }
    },
  };
}
