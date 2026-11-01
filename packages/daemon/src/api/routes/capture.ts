/**
 * v0.8: the capture door (`capture` scope, CAPTURE_PREFIX): the iOS
 * Shortcut's one route, `POST /v1/capture/save` with a capture key. It only
 * saves and queues (`s.deps.intel.read(body, { via: 'shortcut', keyId })`),
 * and its reply is always CAPTURE_SAVED_SENTENCE: for a new link, a link
 * already saved, reading off (Intel keeps the link, its read failed with the
 * off sentence) and a read over today's cap alike. It carries no id, no
 * "duplicate" and no shelf data, so a leaked key can't test what the user
 * saved. A link Intel refuses outright (not public https) answers Intel's
 * fixed sentence: nothing was saved, and nothing about the shelf is said.
 *
 * The pipeline has already run the door's gate (api/app.ts captureCaller:
 * the mode, Intel on, an active key, no Origin, the key before the body,
 * the bad-key and per-key limits) and the strict body. The audit row is
 * `capture.save` with the key's id (never the key) and the item's id; never
 * the link or the text.
 */
import { CAPTURE_SAVED_SENTENCE, INTEL_READ_LIMITS, type CaptureSaveBody, type CaptureSaveReply, type IntelReadBody } from '@jantar/protocol';
import { auditResult } from '../audit.js';
import { ApiError, toErrorReply } from '../errors.js';
import { actorName } from '../request.js';
import { lifeValue, type Call, type RouteTable } from '../route-kit.js';

/** The door's body as Intel reads it: the url first (the item's link), then the shared text (its note); the same link once. */
export function captureText(body: Pick<CaptureSaveBody, 'text' | 'url'>): string {
  const url = body.url?.trim() ?? '';
  const text = body.text?.trim() ?? '';
  const joined = url && text && text !== url ? `${url}\n${text}` : url || text;
  // Never half a surrogate pair at the cut.
  const cut = joined.slice(0, INTEL_READ_LIMITS.textMax);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export const CAPTURE_ROUTE_IMPLS: RouteTable = {
  captureSave: {
    selfAudit: true,
    handle: async (c: Call<Record<string, string>, unknown, CaptureSaveBody>, s): Promise<CaptureSaveReply> => {
      const keyId = c.auth.capture?.id;
      // The gate let nobody else through; this is a second look, never a grant.
      if (!keyId) throw new ApiError('unauthorized', 'a Shortcut key is needed');
      const body: IntelReadBody = { text: captureText(c.body), ...(c.body.depth ? { depth: c.body.depth } : {}) };
      const audit = (status: number, target?: string, code?: string) =>
        s.auditor.write({
          actor: actorName(c.auth),
          action: 'capture.save',
          ...(target ? { target } : {}),
          params: { keyId, via: 'shortcut' },
          result: auditResult(status),
          ...(code ? { detail: code } : {}),
        });
      try {
        const out = lifeValue(await s.deps.intel.read(body, { via: 'shortcut', keyId }));
        audit(202, out.id);
      } catch (e) {
        const r = toErrorReply(e);
        audit(r.status, undefined, r.body.error.code);
        throw e;
      }
      return { message: CAPTURE_SAVED_SENTENCE };
    },
  },
};
