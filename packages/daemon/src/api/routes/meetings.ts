/**
 * The phone's and the CLI's meeting routes (scope control, reads included):
 * meetingsStatus (no switch: it says whether Meetings are on), meetingsList,
 * meetingGet, meetingShot (a RawReply of image/jpeg), meetingUpdate,
 * meetingDelete. Each calls `s.deps.meetings` (the part's status, or its
 * library: meetings/library.ts).
 *
 * The pipeline has already checked the device and control (or ctl.sock for
 * status, list, get and shot), Origin and the device secret on writes, the
 * switch, a broken meetings.db (503) and Life's per-device write limit on
 * phone writes, and validated the params, query and strict body. Here:
 * - meetingShot answers the JPEG with its own headers (nosniff, a sandbox
 *   CSP, private no-store, the shot id as its etag) and, for a device,
 *   takes its bytes from s.rawBytesBudget (200 MB per 10 minutes, shared
 *   with Files). The Mac's own export over ctl.sock is not counted;
 * - writes reply `{ ok: true }` and audit with lifeAudit (the target id
 *   only); GETs are not audited.
 */
import type { MeetingPatch, MeetingsQuery } from '@jantar/protocol';
import { ApiError } from '../errors.js';
import { actorName } from '../request.js';
import { lifeAudit, lifeValue, needActor, type Call, type RawReply, type RouteTable } from '../route-kit.js';

type Id = { id: string };
type ShotParams = { id: string; shotId: string };

const OK = { ok: true as const };

/** meetingShot's 429 once a device has read its bytes for the window (V03_LIMITS.rawBytes). */
export const SHOT_READS_LIMITED = 'too many screenshot bytes in the last 10 minutes; wait a little and try again';

export const MEETINGS_ROUTE_IMPLS: RouteTable = {
  meetingsStatus: {
    handle: (_c: Call, s) => s.deps.meetings.status(),
  },

  meetingsList: {
    handle: (c: Call<Record<string, string>, MeetingsQuery>, s) => lifeValue(s.deps.meetings.library.list(c.query)),
  },

  meetingGet: {
    handle: (c: Call<Id>, s) => lifeValue(s.deps.meetings.library.get(c.params.id)),
  },

  meetingShot: {
    handle: async (c: Call<ShotParams>, s): Promise<RawReply> => {
      const library = s.deps.meetings.library;
      // A device's bytes are taken from the row's size before the file is read, as filesRaw takes them after its stat.
      if (c.auth.transport === 'tcp') {
        const { bytes } = lifeValue(library.shotSize(c.params.id, c.params.shotId));
        const budget = s.rawBytesBudget.take(actorName(c.auth), bytes);
        if (!budget.ok) throw new ApiError('rate_limited', SHOT_READS_LIMITED, { 'retry-after': String(Math.max(1, Math.ceil(budget.retryAfterMs / 1000))) });
      }
      const { body } = lifeValue(await library.shotFile(c.params.id, c.params.shotId));
      return {
        kind: 'raw',
        type: 'image/jpeg',
        body,
        headers: {
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'cache-control': 'private, no-store',
          'cross-origin-resource-policy': 'same-origin',
          // A screenshot never changes: its id names its bytes.
          etag: `"${c.params.shotId}"`,
        },
      };
    },
  },

  meetingUpdate: {
    handle: (c: Call<Id, unknown, MeetingPatch>, s) => {
      lifeValue(s.deps.meetings.library.update(c.params.id, c.body, needActor(c.auth)));
      return OK;
    },
    audit: lifeAudit,
  },

  meetingDelete: {
    handle: async (c: Call<Id>, s) => {
      lifeValue(await s.deps.meetings.library.remove(c.params.id, needActor(c.auth)));
      return OK;
    },
    audit: lifeAudit,
  },
};
