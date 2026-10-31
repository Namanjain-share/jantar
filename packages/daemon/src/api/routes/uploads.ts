/**
 * Upload routes (v0.4.2, spec 6.3): uploadCreate and uploadDelete, thin over
 * `s.uploads` (UploadStore, uploads/store.ts). Neither is served on ctl.sock.
 *
 * uploadCreate is a `rawBody` route: before a byte of its body is read, the
 * pipeline (api/app.ts) has checked the device, the scope, Origin and the
 * device secret, --read-only and --no-terminal, the session, the content
 * type (exactly application/octet-stream), the Content-Length (411, 413),
 * the device's uploads in flight (2) and its byte budget (both 429). It
 * never replays an Idempotency-Key: two posts make two files, and a phone
 * removes the one it doesn't keep. The bytes arrive in `call.raw`.
 *
 * Replies carry the id, the kind and the size, never a path or a name. The
 * audit rows hold { sid, kind, bytes } and { sid }: no file name, label or
 * byte.
 */
import type { UploadParams, UploadQuery, UploadResponse } from '@jantar/protocol';
import type { UploadResult } from '../../contracts.js';
import { ApiError } from '../errors.js';
import { needActor, sessionOr404, type Call, type RouteTable } from '../route-kit.js';

type Sid = { sid: string };

/** An upload refusal as an API error (the store's fixed sentence, same code). */
function uploadError(r: Extract<UploadResult, { ok: false }>): ApiError {
  return new ApiError(r.code, r.reason);
}

export const UPLOADS_ROUTE_IMPLS: RouteTable = {
  uploadCreate: {
    handle: async (c: Call<Sid, UploadQuery>, s): Promise<UploadResponse> => {
      needActor(c.auth);
      sessionOr404(s, c.params.sid);
      const r = await s.uploads.save(c.params.sid, c.raw ?? Buffer.alloc(0), c.query.ext !== undefined ? { ext: c.query.ext } : {});
      if (!r.ok) throw uploadError(r);
      return { upload: r.upload };
    },
    audit: (c: Call<Sid, UploadQuery>, out) => {
      const upload = (out.body as Partial<UploadResponse> | null)?.upload;
      return { target: c.params.sid, params: { sid: c.params.sid, ...(upload ? { kind: upload.kind, bytes: upload.bytes } : {}) } };
    },
  },

  uploadDelete: {
    handle: async (c: Call<UploadParams>, s) => {
      needActor(c.auth);
      sessionOr404(s, c.params.sid);
      const r = await s.uploads.remove(c.params.sid, c.params.id);
      if (!r.ok) throw uploadError(r);
      return { ok: true };
    },
    audit: (c: Call<UploadParams>) => ({ target: c.params.sid, params: { sid: c.params.sid } }),
  },
};
