/**
 * lib/upload.ts (v0.4.2, spec 6.8) against a fake XMLHttpRequest: one POST
 * with exactly the headers lib/api.ts built (octet-stream, accept, the
 * device secret; never an Idempotency-Key) and the blob as the body,
 * same-origin cookies only (no withCredentials), upload progress, the
 * daemon's refusals as ApiError with its code and sentence (or the status's
 * code when a proxy answered), "network" for no answer, for an abort and
 * for an upload that stalls (UPLOAD_IDLE_MS without progress), and fetch
 * never used for it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_SECRET_HEADER, type UploadResponse } from '@jantar/protocol';
import { createApi, isApiError } from '../src/lib/api.js';
import type { CredentialStore } from '../src/lib/credential.js';
import { UPLOAD_IDLE_MS, uploadFile, type UploadRequest } from '../src/lib/upload.js';
import { uploadId } from './attach-helpers.js';

const BASE = 'http://127.0.0.1:7420';
const SECRET = 'S'.repeat(43);
const REQ: UploadRequest = {
  url: `${BASE}/v1/sessions/sess-1/uploads?ext=md`,
  headers: { accept: 'application/json', 'content-type': 'application/octet-stream', [DEVICE_SECRET_HEADER]: SECRET },
};
const REPLY: UploadResponse = { upload: { id: uploadId(1), kind: 'text', bytes: 6 } };

/** A stand-in for XMLHttpRequest: records what was sent; the test answers with `reply`, `fail` or `progress`. */
class FakeXhr {
  static last: FakeXhr | null = null;
  static made = 0;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = undefined;
  withCredentials = false;
  responseType = '';
  status = 0;
  statusText = '';
  responseText = '';
  aborted = false;
  upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
    FakeXhr.made += 1;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  onprogress: (() => void) | null = null;
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  reply(status: number, text: string, statusText = '') {
    this.status = status;
    this.statusText = statusText;
    this.responseText = text;
    this.onload?.();
  }
  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.({ loaded, total, lengthComputable });
  }
}

function useFakeXhr() {
  FakeXhr.last = null;
  FakeXhr.made = 0;
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
}
const xhr = () => {
  if (!FakeXhr.last) throw new Error('no request was made');
  return FakeXhr.last;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('uploadFile', () => {
  it('posts the blob with exactly the headers it was given, and resolves with the upload', async () => {
    useFakeXhr();
    const blob = new Blob(['# plan']);
    const done = uploadFile(REQ, blob);
    expect(xhr().method).toBe('POST');
    expect(xhr().url).toBe(REQ.url);
    expect(xhr().headers).toEqual(REQ.headers);
    expect(Object.keys(xhr().headers).map((k) => k.toLowerCase())).not.toContain('idempotency-key');
    expect(xhr().body).toBe(blob);
    expect(xhr().withCredentials).toBe(false);
    xhr().reply(201, JSON.stringify(REPLY));
    expect(await done).toEqual(REPLY);
  });

  it('reports progress as bytes sent of the total (the blob size when the browser cannot tell)', async () => {
    useFakeXhr();
    const onProgress = vi.fn();
    const blob = new Blob(['0123456789']);
    const done = uploadFile(REQ, blob, { onProgress });
    xhr().progress(4, 10);
    xhr().progress(7, 0, false);
    xhr().reply(201, JSON.stringify(REPLY));
    await done;
    expect(onProgress.mock.calls).toEqual([
      [4, 10],
      [7, 10],
    ]);
  });

  it("rejects with the daemon's code and sentence", async () => {
    useFakeXhr();
    const refusals: [number, string, string][] = [
      [413, 'payload_too_large', 'This file is larger than 20 MB'],
      [415, 'unsupported_media_type', "Claude can't read HEIC. The app sends photos as JPEG; this phone couldn't convert it."],
      [411, 'length_required', 'Uploads need a Content-Length'],
      [429, 'rate_limited', 'Two uploads at a time from one phone'],
      [422, 'refused', "The Mac's upload space is full; remove some files or wait a week"],
    ];
    for (const [status, code, message] of refusals) {
      const done = uploadFile(REQ, new Blob(['x']));
      xhr().reply(status, JSON.stringify({ error: { code, message } }));
      await expect(done).rejects.toMatchObject({ name: 'ApiError', code, message, status });
    }
  });

  it('takes the code from the status when the reply is not the daemon (a proxy page)', async () => {
    useFakeXhr();
    const done = uploadFile(REQ, new Blob(['x']));
    xhr().reply(413, '<html>Request Entity Too Large</html>', 'Payload Too Large');
    await expect(done).rejects.toMatchObject({ code: 'payload_too_large', status: 413, message: '413 Payload Too Large' });
    const odd = uploadFile(REQ, new Blob(['x']));
    xhr().reply(502, '');
    await expect(odd).rejects.toMatchObject({ code: 'internal', status: 502 });
  });

  it('an unreadable success is bad_response', async () => {
    useFakeXhr();
    const done = uploadFile(REQ, new Blob(['x']));
    xhr().reply(201, 'not json');
    await expect(done).rejects.toMatchObject({ code: 'bad_response' });
    const empty = uploadFile(REQ, new Blob(['x']));
    xhr().reply(201, JSON.stringify({ ok: true }));
    await expect(empty).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('no answer is "network" with status 0', async () => {
    useFakeXhr();
    const done = uploadFile(REQ, new Blob(['x']));
    xhr().onerror?.();
    const e = await done.catch((x: unknown) => x);
    expect(isApiError(e, 'network')).toBe(true);
    expect(e).toMatchObject({ status: 0 });
  });

  it('the signal aborts the request (the chip ×), and an aborted signal sends nothing', async () => {
    useFakeXhr();
    const ctrl = new AbortController();
    const done = uploadFile(REQ, new Blob(['x']), { signal: ctrl.signal });
    ctrl.abort();
    expect(xhr().aborted).toBe(true);
    await expect(done).rejects.toMatchObject({ code: 'network', status: 0 });

    FakeXhr.made = 0;
    await expect(uploadFile(REQ, new Blob(['x']), { signal: ctrl.signal })).rejects.toMatchObject({ code: 'network' });
    expect(FakeXhr.made).toBe(0);
  });
});

describe('an upload that stalls', () => {
  it(`is given up as "network" after ${UPLOAD_IDLE_MS / 1000} s with no byte sent and no answer; progress keeps it going`, async () => {
    vi.useFakeTimers();
    useFakeXhr();
    const done = uploadFile(REQ, new Blob(['x'.repeat(10)]), { onProgress: vi.fn() });
    const outcome = done.catch((e: unknown) => e);
    vi.advanceTimersByTime(UPLOAD_IDLE_MS - 1000);
    xhr().progress(5, 10);
    vi.advanceTimersByTime(UPLOAD_IDLE_MS - 1000);
    // The body is out; the answer is slow but comes.
    xhr().progress(10, 10);
    vi.advanceTimersByTime(UPLOAD_IDLE_MS - 1000);
    expect(xhr().aborted).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(xhr().aborted).toBe(true);
    const e = await outcome;
    expect(isApiError(e, 'network')).toBe(true);
    expect(e).toMatchObject({ status: 0 });
  });

  it('an answer stops the clock', async () => {
    vi.useFakeTimers();
    useFakeXhr();
    const done = uploadFile(REQ, new Blob(['x']));
    xhr().reply(201, JSON.stringify(REPLY));
    expect(await done).toEqual(REPLY);
    vi.advanceTimersByTime(UPLOAD_IDLE_MS * 2);
    expect(xhr().aborted).toBe(false);
  });
});

describe('the API client sends uploads through it', () => {
  it('uploadCreate uses XMLHttpRequest, never fetch', async () => {
    useFakeXhr();
    const f = vi.fn();
    const credentials = { get: async () => ({ secret: SECRET, deviceId: 'dev-1', savedAt: '2026-10-31T00:00:00.000Z' }), set: async () => undefined, clear: async () => undefined } as unknown as CredentialStore;
    const api = createApi({ fetch: f as unknown as typeof fetch, base: BASE, credentials });
    const done = api.uploadCreate('sess-1', new Blob(['# plan']), { ext: 'md' });
    await vi.waitFor(() => expect(FakeXhr.last).not.toBeNull());
    expect(xhr().url).toBe(REQ.url);
    expect(xhr().headers).toEqual(REQ.headers);
    xhr().reply(201, JSON.stringify(REPLY));
    expect(await done).toEqual(REPLY);
    expect(f).not.toHaveBeenCalled();
  });
});
