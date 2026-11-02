/**
 * v0.10 Chat (spec 0.10 B5; replaces v0.5.3's Ask routes): each route calls
 * `s.deps.chat` (chat/service.ts) with the caller as actor. The phone's
 * routes are device routes at control scope (reads too); chatClear and
 * chatStatus also serve the Mac's CLI over ctl.sock.
 *
 * The pipeline has already checked the scope, the `ask` switch (the page is
 * Chat; the switch keeps its name), --read-only (chatSend and chatPhotoAdd
 * spend quota or exist only to be sent), the params and strict bodies, the
 * raw upload's pre-body checks (Content-Length, two in flight, the byte
 * budget shared with session uploads), and counted every device write
 * against s.lifeWriteLimiter. chatSend also counts against s.chatLimiter
 * (10 a minute) and s.chatDayBudget (100 a day) per device: both are
 * checked first and counted only once the part takes the message.
 *
 * Write replies carry ids only (`{ id }` for a turn or a photo, else
 * `{ ok }`), so the idempotency cache never keeps text. chatList is the
 * one reply with text: the thread itself.
 */
import type { ChatItemParams, ChatListQuery, ChatSendBody } from '@jantar/protocol';
import type { LifeResult } from '../../contracts.js';
import { ApiError } from '../errors.js';
import { actorName } from '../request.js';
import { lifeAudit, lifeValue, needActor, notImplementedRoute, type Call, type RawReply, type RouteTable } from '../route-kit.js';
import { CHAT_LIMITS } from '../services.js';

type Id = { id: string };

export const CHAT_SEND_LIMITED = 'Too many messages from this device; try again in a minute.';
export const CHAT_SEND_DAY_LIMITED = `This device has sent ${CHAT_LIMITS.sendDay.limit} messages today. Try again tomorrow.`;

/** A write that answers `{ ok: true }`: the part's refusal as the API error, else ok. */
function okOf(r: LifeResult): { ok: true } {
  lifeValue(r);
  return { ok: true };
}

/** Ask's routes until the phone moves to Chat: 501 (Ask is now Chat). */
const askGone = notImplementedRoute('Ask (now Chat)');

export const CHAT_ROUTE_IMPLS: RouteTable = {
  askList: askGone,
  askSend: askGone,
  askClear: askGone,
  askCancel: askGone,
  askAdd: askGone,
  askSkip: askGone,
  askUndo: askGone,

  chatList: {
    handle: (c: Call<unknown, ChatListQuery>, s) => lifeValue(s.deps.chat.list(needActor(c.auth), c.query?.before)),
  },
  chatSend: {
    handle: (c: Call<unknown, unknown, ChatSendBody>, s) => {
      const actor = needActor(c.auth);
      const who = actorName(c.auth);
      const limits = [
        [s.chatLimiter, CHAT_SEND_LIMITED],
        [s.chatDayBudget, CHAT_SEND_DAY_LIMITED],
      ] as const;
      for (const [limiter, message] of limits) {
        const limited = limiter.check(who);
        if (!limited.ok) throw new ApiError('rate_limited', message, { 'retry-after': String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))) });
      }
      const sent = lifeValue(s.deps.chat.send({ text: c.body.text, ...(c.body.photos ? { photos: c.body.photos } : {}) }, actor, 'phone'));
      for (const [limiter] of limits) limiter.hit(who);
      return sent;
    },
    audit: lifeAudit,
  },
  chatClear: {
    handle: async (c: Call<unknown, { broken?: '1' }>, s) => {
      // Moving a broken chat.db aside is the Mac's alone (jantar chat clear --broken).
      const broken = c.query?.broken === '1';
      if (broken && c.auth.transport !== 'ctl') throw new ApiError('forbidden', 'Move chat.db aside at the Mac: jantar chat clear --broken');
      return okOf(await s.deps.chat.clear(needActor(c.auth), { broken }));
    },
    audit: () => ({ target: 'chat', params: {} }),
  },
  chatStatus: {
    handle: (_c: Call, s) => s.deps.chat.status(),
  },
  chatCancel: {
    handle: (c: Call<Id>, s) => okOf(s.deps.chat.cancel(c.params.id, needActor(c.auth))),
    audit: lifeAudit,
  },
  chatUndo: {
    handle: async (c: Call<ChatItemParams>, s) => okOf(await s.deps.chat.undo(c.params.id, c.params.n, needActor(c.auth))),
    audit: lifeAudit,
  },
  chatCard: {
    handle: async (c: Call<ChatItemParams>, s) => okOf(await s.deps.chat.card(c.params.id, c.params.n, needActor(c.auth))),
    audit: lifeAudit,
  },
  chatCardDismiss: {
    handle: (c: Call<ChatItemParams>, s) => okOf(s.deps.chat.dismiss(c.params.id, c.params.n, needActor(c.auth))),
    audit: lifeAudit,
  },
  chatPhotoAdd: {
    handle: async (c: Call, s) => lifeValue(await s.deps.chat.photoAdd(c.raw ?? Buffer.alloc(0), needActor(c.auth))),
    audit: (_c, out) => ({ target: (out.body as { id?: string } | null)?.id ?? 'photo', params: {} }),
  },
  chatPhoto: {
    handle: async (c: Call<Id>, s): Promise<RawReply> => {
      const r = lifeValue(await s.deps.chat.photo(c.params.id));
      return { kind: 'raw', type: r.type, body: r.body, headers: { 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' } };
    },
  },
  chatPhotoDelete: {
    handle: async (c: Call<Id>, s) => okOf(await s.deps.chat.photoDelete(c.params.id, needActor(c.auth))),
    audit: lifeAudit,
  },

  // v0.10: the chat keys and the Siri door are wired with their own commit.
  chatKeyAdd: notImplementedRoute('Chat keys'),
  chatKeyList: notImplementedRoute('Chat keys'),
  chatKeyRevoke: notImplementedRoute('Chat keys'),
  captureChat: notImplementedRoute('The Siri door'),
};
