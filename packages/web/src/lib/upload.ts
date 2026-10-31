/**
 * Sending one file to the Mac (v0.4.2, spec 6.8): the raw bytes in one
 * request, `application/octet-stream`, this browser's device secret, same-
 * origin credentials, and no Idempotency-Key (the daemon never replays an
 * upload: a retry makes a new file, and the one not kept is removed with
 * uploadDelete or swept). lib/api.ts `uploadCreate` builds the request
 * (`UploadRequest`) and hands it here.
 *
 * XMLHttpRequest, not fetch: its `upload.onprogress` is the one way Safari
 * reports how much of a body went out. Same-origin cookies ride along by
 * default (`withCredentials` stays off, so nothing goes cross-site), and the
 * browser sets the Content-Length from the Blob, which the daemon checks
 * before it reads a byte.
 *
 * Errors are ApiError like lib/api.ts call()'s: the daemon's code and
 * sentence (411, 413, 415, 422, 429, ...), or "network" with status 0 when
 * the request got no answer. An abort through `signal` rejects the same way
 * (call() turns an aborted fetch into "network" too); the caller knows it
 * asked for it. So does an upload that goes UPLOAD_IDLE_MS without a byte
 * sent or an answer (a stalled tunnel, a half-open connection): it is
 * aborted rather than left at its percent, holding one of the two slots.
 */
import type { ErrorCode, UploadResponse } from '@jantar/protocol';
import { ApiError } from './api.js';

/** One upload as lib/api.ts builds it. */
export interface UploadRequest {
  /** Absolute URL of POST /v1/sessions/:sid/uploads, with `?ext=` when given. */
  url: string;
  /** content-type application/octet-stream, accept, and the device secret when one is stored. Never an Idempotency-Key. */
  headers: Record<string, string>;
}

export interface UploadOptions {
  /** Bytes sent so far of `total`. */
  onProgress?: (sent: number, total: number) => void;
  /** Aborts the upload (the chip's ×). */
  signal?: AbortSignal;
}

export type UploadFn = (req: UploadRequest, blob: Blob, opts?: UploadOptions) => Promise<UploadResponse>;

/** An upload with no progress and no answer for this long is given up as "network" (an idle limit, not a total one: a big file on a slow link keeps going). */
export const UPLOAD_IDLE_MS = 60_000;

/** An error code from a bare status (a reply that is not the daemon's JSON), as lib/api.ts call() maps them; else "internal". */
const CODE_OF_STATUS: ReadonlyMap<number, ErrorCode> = new Map<number, ErrorCode>([
  [400, 'invalid_request'],
  [401, 'unauthorized'],
  [403, 'forbidden'],
  [404, 'not_found'],
  [409, 'conflict'],
  [411, 'length_required'],
  [413, 'payload_too_large'],
  [415, 'unsupported_media_type'],
  [422, 'refused'],
  [429, 'rate_limited'],
  [501, 'not_implemented'],
  [503, 'unavailable'],
]);

/** What the daemon answered, as call() reads it: its JSON when there is some, else undefined. */
function parse(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Send one file; the reply names the upload by id (never a path). */
export function uploadFile(req: UploadRequest, blob: Blob, opts: UploadOptions = {}): Promise<UploadResponse> {
  return new Promise<UploadResponse>((resolve, reject) => {
    const { signal, onProgress } = opts;
    if (signal?.aborted) {
      reject(new ApiError('network', 'The upload was stopped', 0));
      return;
    }
    const xhr = new XMLHttpRequest();
    const stop = () => xhr.abort();
    let idle: ReturnType<typeof setTimeout> | undefined;
    let stalled = false;
    // Restarted by every progress event, up or down.
    const alive = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        stalled = true;
        xhr.abort();
      }, UPLOAD_IDLE_MS);
    };
    const done = () => {
      clearTimeout(idle);
      signal?.removeEventListener('abort', stop);
    };
    xhr.open('POST', req.url);
    for (const [name, value] of Object.entries(req.headers)) xhr.setRequestHeader(name, value);
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => {
      alive();
      onProgress?.(e.loaded, e.lengthComputable ? e.total : blob.size);
    };
    xhr.onprogress = alive;
    xhr.onload = () => {
      done();
      const text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
      const json = parse(text);
      if (xhr.status < 200 || xhr.status >= 300) {
        const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
        const code = (err?.code as ErrorCode | undefined) ?? CODE_OF_STATUS.get(xhr.status) ?? 'internal';
        reject(new ApiError(code, err?.message ?? `${xhr.status} ${xhr.statusText}`.trim(), xhr.status));
        return;
      }
      const upload = (json as Partial<UploadResponse> | undefined)?.upload;
      if (!upload || typeof upload.id !== 'string') {
        reject(new ApiError('bad_response', 'The daemon sent an unreadable reply.', xhr.status));
        return;
      }
      resolve(json as UploadResponse);
    };
    xhr.onerror = () => {
      done();
      reject(new ApiError('network', 'network error', 0));
    };
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => {
      done();
      reject(new ApiError('network', stalled ? 'No answer from the Mac' : 'The upload was stopped', 0));
    };
    signal?.addEventListener('abort', stop, { once: true });
    xhr.send(blob);
    alive();
  });
}
