/**
 * The Chrome extension's capture routes (feature `meetings`, scope
 * `extension`): extInfo, extMeetingOpen, extMeetingLines, extMeetingShot,
 * extMeetingEnd. Each calls `s.deps.meetings.capture` (meetings/capture.ts).
 *
 * The pipeline has already checked the loopback peer and Host, that no
 * device cookie came, the extension's key and its bound Origin, the
 * per-extension request limit (s.extRequestLimiter), the switch and a broken
 * meetings.db, and validated the client id and the strict body. `c.auth.extension.id`
 * is the extension; `actorName(c.auth)` its limiter and audit key. Here:
 * - a 404 on lines, a screenshot or end is "no open meeting with this
 *   client id";
 * - the screenshot route takes the decoded size (from the base64's length)
 *   from s.extShotBytes before anything is written: 1 GB a day per
 *   extension, else 429 with retry-after;
 * - lines and screenshots audit nothing (`selfAudit`: one row per caption
 *   batch would flood the log; the counts land on the end's row); open
 *   audits its target, end its target and counts. Never a name or a line.
 */
import type { ExtEndBody, ExtLinesBody, ExtOpenBody, ExtShotBody } from '@jantar/protocol';
import { JPEG_DATA_URL_PREFIX } from '../../meetings/capture.js';
import { ApiError } from '../errors.js';
import { actorName, type RequestAuth } from '../request.js';
import { lifeAudit, lifeValue, type Call, type RouteTable } from '../route-kit.js';

type Client = { clientId: string };
type Ended = { id: string; lines: number; shots: number };

const OK = { ok: true as const };

/** The screenshot route's 429 once an extension has sent its day's bytes (V05_LIMITS.extShotBytes). */
export const SHOT_BYTES_LIMITED = 'This extension sent 1 GB of screenshots today. Try again tomorrow.';

/** The paired extension's id (the gate let no request here without one). */
function extensionOf(auth: RequestAuth): string {
  if (!auth.extension) throw new ApiError('unauthorized', 'pair the Jantar extension first');
  return auth.extension.id;
}

export const EXT_ROUTE_IMPLS: RouteTable = {
  extInfo: {
    handle: (_c: Call, s) => lifeValue(s.deps.meetings.capture.info()),
  },

  extMeetingOpen: {
    handle: (c: Call<Client, unknown, ExtOpenBody>, s) => lifeValue(s.deps.meetings.capture.open(extensionOf(c.auth), c.params.clientId, c.body)),
    // The meeting's id from the reply: the client id is the extension's own.
    audit: lifeAudit,
  },

  extMeetingLines: {
    selfAudit: true,
    handle: (c: Call<Client, unknown, ExtLinesBody>, s) => {
      lifeValue(s.deps.meetings.capture.lines(extensionOf(c.auth), c.params.clientId, c.body));
      return OK;
    },
  },

  extMeetingShot: {
    selfAudit: true,
    handle: async (c: Call<Client, unknown, ExtShotBody>, s) => {
      const extId = extensionOf(c.auth);
      const size = Math.ceil(((c.body.image.length - JPEG_DATA_URL_PREFIX.length) * 3) / 4);
      const budget = s.extShotBytes.take(actorName(c.auth), size);
      if (!budget.ok) {
        throw new ApiError('rate_limited', SHOT_BYTES_LIMITED, { 'retry-after': String(Math.max(1, Math.ceil(budget.retryAfterMs / 1000))) });
      }
      return lifeValue(await s.deps.meetings.capture.shot(extId, c.params.clientId, c.body));
    },
  },

  extMeetingEnd: {
    handle: (c: Call<Client, unknown, ExtEndBody>, s) => {
      c.scratch.ended = lifeValue(s.deps.meetings.capture.end(extensionOf(c.auth), c.params.clientId, c.body));
      return OK;
    },
    // Counts only.
    audit: (c: Call<Client>) => {
      const r = c.scratch.ended as Ended | undefined;
      return r ? { target: r.id, params: { lines: r.lines, shots: r.shots } } : {};
    },
  },
};
