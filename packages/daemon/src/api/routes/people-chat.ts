/**
 * v0.11 People (P3, spec 7.8): his read-only view of her chat. GET only:
 * no owner route writes to, clears or undoes in her thread (T14). Each
 * read goes through `ownerViewOf(pid, 'chat')`, which checks `see.chat`
 * and writes the view mark ("Sam read your chat", one an hour). With
 * `see.chat` off, or a person he can't reach, both answer the one
 * not_found.
 */
import { ApiError } from '../errors.js';
import { lifeValue, type Call, type RawReply, type RouteTable } from '../route-kit.js';
import { NO_PERSON } from './people.js';

type Pid = { pid: string };

export const PEOPLE_CHAT_ROUTE_IMPLS: RouteTable = {
  personOwnerChat: {
    handle: (c: Call<Pid, { before?: string }>, s) => {
      const views = s.deps.life.people.views;
      if (!views) throw new ApiError('unavailable', 'Life is not open right now. Try again in a moment.');
      const v = views.ownerViewOf(c.params.pid, 'chat', { before: c.query?.before });
      if (v === null || 'locked' in v) throw new ApiError('not_found', NO_PERSON);
      return v;
    },
  },
  personOwnerChatPhoto: {
    handle: async (c: Call<{ pid: string; id: string }>, s): Promise<RawReply> => {
      const people = s.deps.life.people;
      const reach = people.ownerReach(c.params.pid);
      if ((reach !== 'active' && reach !== 'paused') || people.agreement(c.params.pid)?.see.chat !== true) throw new ApiError('not_found', NO_PERSON);
      const r = lifeValue(await s.deps.chat.threadPhoto(c.params.pid, c.params.id));
      // Her photo's bytes are a read of her chat like the list: the same view mark (spec 8.5).
      people.viewMark(c.params.pid, 'chat');
      return { kind: 'raw', type: r.type, body: r.body, headers: { 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' } };
    },
  },
};
