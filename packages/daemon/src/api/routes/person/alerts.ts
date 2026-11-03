/**
 * v0.12 People (P2): alerts with the owner (scope `person`), thin handlers
 * over life/alerts with her as the caller: her list (both ways), her sends
 * to him, and seen and reply on his to her.
 */
import type { AlertReplyBody, AlertSendBody } from '@jantar/protocol/people';
import { ApiError } from '../../errors.js';
import { lifeValue, type Call, type RouteTable } from '../../route-kit.js';
import type { ApiServices } from '../../services.js';
import { her } from './account.js';

type Id = { id: string };
const OK = { ok: true as const };

function alerts(s: ApiServices) {
  const m = s.deps.life.people.alerts;
  if (!m) throw new ApiError('unavailable', 'Life is not open right now. Try again in a moment.');
  return m;
}

export const PERSON_ALERT_ROUTE_IMPLS: RouteTable = {
  personAlerts: {
    handle: (c: Call, s) => lifeValue(alerts(s).list(her(c.auth).personId, null)),
  },
  personAlertSend: {
    handle: (c: Call<Record<string, string>, unknown, AlertSendBody>, s) => lifeValue(alerts(s).send(her(c.auth).personId, '', c.body)),
  },
  personAlertSeen: {
    handle: (c: Call<Id>, s) => (lifeValue(alerts(s).seen(her(c.auth).personId, c.params.id)), OK),
  },
  personAlertReply: {
    handle: (c: Call<Id, unknown, AlertReplyBody>, s) => (lifeValue(alerts(s).reply(her(c.auth).personId, c.params.id, c.body)), OK),
  },
};
