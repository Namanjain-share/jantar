/**
 * Files routes (WP-FP owns this file): filesRoots, filesList, filesStat,
 * filesText, filesRaw. Each calls `s.deps.files` (FilesService).
 *
 * The pipeline has already checked the device, the control scope and
 * `files.enabled`, and parsed the query. Here:
 * - every files request counts against `s.filesLimiter` (300 per 5 min per
 *   device), and raw bytes against `s.rawBytesBudget` (200 MB per 10 min);
 * - a FileRefusal becomes an ApiError (fileRefusalError);
 * - filesRaw returns a RawReply streaming the policy's FileHandle (closed
 *   when the stream ends, fails or is dropped; closed here when the bytes
 *   budget refuses), with the spec 4.4.5 headers;
 * - the service writes the audit rows (GETs are not audited by the pipeline);
 *   the files.raw row only once the bytes budget has taken the size.
 * Files routes are never served on ctl.sock (`ctl: false`).
 */
import type { FilesListQuery, FilesPathQuery, FilesTextQuery } from '@jantar/protocol';
import type { FileRefusal } from '../../contracts.js';
import { isRefusal } from '../../files/policy.js';
import { rawHeaders, settleRawRow } from '../../files/raw.js';
import { ApiError } from '../errors.js';
import { actorName } from '../request.js';
import { needActor, type Call, type RawReply, type RouteTable } from '../route-kit.js';
import type { ApiServices } from '../services.js';

/** The API error for a policy refusal. */
export function fileRefusalError(r: FileRefusal): ApiError {
  switch (r.refused) {
    case 'protected':
    case 'outside':
      return new ApiError('forbidden', r.message);
    case 'missing':
    case 'no_root':
      return new ApiError('not_found', r.message);
    case 'bad_path':
      return new ApiError('invalid_request', r.message);
    case 'too_large':
      return new ApiError('payload_too_large', r.message);
    case 'unsupported_type':
      return new ApiError('unsupported_media_type', r.message);
    case 'not_file':
    case 'not_dir':
      return new ApiError('refused', r.message);
    case 'os_permission':
      return new ApiError('unavailable', r.message);
  }
}

function retryAfter(ms: number): Record<string, string> {
  return { 'retry-after': String(Math.ceil(ms / 1000)) };
}

/** One file request for this device (300 per 5 min). */
function countRequest(c: Call, s: ApiServices): void {
  const r = s.filesLimiter.hit(actorName(c.auth));
  if (!r.ok) throw new ApiError('rate_limited', 'too many file requests; wait a little and try again', retryAfter(r.retryAfterMs));
}

function valueOr<T>(v: T | FileRefusal): T {
  if (isRefusal(v)) throw fileRefusalError(v);
  return v;
}

export const FILES_ROUTE_IMPLS: RouteTable = {
  filesRoots: {
    selfAudit: true,
    handle: async (c: Call, s) => {
      const actor = needActor(c.auth);
      countRequest(c, s);
      return { roots: await s.deps.files.roots(actor) };
    },
  },

  filesList: {
    selfAudit: true,
    handle: async (c: Call<Record<string, string>, FilesListQuery>, s) => {
      const actor = needActor(c.auth);
      countRequest(c, s);
      return valueOr(await s.deps.files.list(c.query, actor));
    },
  },

  filesStat: {
    selfAudit: true,
    handle: async (c: Call<Record<string, string>, FilesPathQuery>, s) => {
      const actor = needActor(c.auth);
      countRequest(c, s);
      return valueOr(await s.deps.files.stat({ root: c.query.root, path: c.query.path }, actor));
    },
  },

  filesText: {
    selfAudit: true,
    handle: async (c: Call<Record<string, string>, FilesTextQuery>, s) => {
      const actor = needActor(c.auth);
      countRequest(c, s);
      return valueOr(await s.deps.files.text(c.query, actor));
    },
  },

  filesRaw: {
    selfAudit: true,
    handle: async (c: Call<Record<string, string>, FilesPathQuery>, s): Promise<RawReply> => {
      const actor = needActor(c.auth);
      countRequest(c, s);
      const raw = valueOr(await s.deps.files.raw({ root: c.query.root, path: c.query.path }, actor));
      const budget = s.rawBytesBudget.take(actorName(c.auth), raw.size);
      settleRawRow(raw.fh, budget.ok);
      if (!budget.ok) {
        await raw.fh.close().catch(() => undefined);
        throw new ApiError('rate_limited', 'too many file bytes in the last 10 minutes; wait a little and try again', retryAfter(budget.retryAfterMs));
      }
      // Never more than the size that was checked and charged, even if the file grew.
      const body = raw.fh.createReadStream({ start: 0, end: Math.max(0, raw.size - 1), autoClose: true });
      return { kind: 'raw', type: raw.mime, body, headers: rawHeaders(raw.name) };
    },
  },
};
