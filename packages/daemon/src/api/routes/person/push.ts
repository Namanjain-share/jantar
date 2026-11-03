/**
 * v0.11 People: her push list (jantar.db `person_push_subs`), apart from his
 * (`push_subs`). A subscription is hers by her device; she can drop only her
 * own. Her pushes are sent to this list only (notify/webpush.ts), through
 * sendLifePush (Web Push only, never the Mac banner or Telegram, C7).
 */
import type { PersonPushSubscribeBody } from '@jantar/protocol/people';
import { sendLifePush } from '../../../life/push.js';
import { findWebPush } from '../../../notify/index.js';
import { pushEndpointProblem } from '../../../notify/push-hosts.js';
import { ApiError } from '../../errors.js';
import type { Call, RouteTable } from '../../route-kit.js';
import { her } from './account.js';

const OK = { ok: true as const };

export const PERSON_PUSH_ROUTE_IMPLS: RouteTable = {
  personPushKey: {
    handle: (_c: Call, s) => {
      const key = findWebPush(s.deps.notifiers)?.publicKey() ?? null;
      if (!key) throw new ApiError('unavailable', 'Notifications are not available on this Mac right now.');
      return { publicKey: key };
    },
  },
  personPushSubscribe: {
    handle: (c: Call<Record<string, string>, unknown, PersonPushSubscribeBody>, s) => {
      const me = her(c.auth);
      const sub = c.body.subscription;
      const problem = pushEndpointProblem(sub.endpoint);
      if (problem) throw new ApiError('invalid_request', 'That is not a push service this app can use.');
      s.ctx.db.people.pushSubs.upsert({ endpoint: sub.endpoint, personId: me.personId, deviceId: me.deviceId, subscription: sub, createdAt: s.ctx.clock.iso() });
      return OK;
    },
  },
  personPushUnsubscribe: {
    handle: (c: Call<Record<string, string>, unknown, { endpoint: string }>, s) => {
      const me = her(c.auth);
      const mine = s.ctx.db.people.pushSubs.listFor(me.personId).some((r) => r.endpoint === c.body.endpoint);
      if (mine) s.ctx.db.people.pushSubs.remove(c.body.endpoint);
      return OK;
    },
  },
  personPushTest: {
    handle: async (c: Call, s) => {
      const me = her(c.auth);
      const r = await sendLifePush(
        s.ctx,
        s.deps.notifiers,
        { person: me.personId, kind: 'life', title: 'Jantar', body: 'Notifications work.', url: '/p', tag: 'people:test' },
        (pid) => s.deps.life.people.person(pid)?.prefs ?? null,
      );
      return { delivered: r.delivered };
    },
  },
};
