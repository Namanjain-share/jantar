/**
 * v0.11 People (P3, spec 7): her assistant's thread (scope `person`), thin
 * handlers over chat/service.ts with her as the caller. Every call works in
 * her thread (`p:<pid>`): a turn, change, card or photo of the owner's
 * thread is 404. Her refusals are her fixed sentences (C17): never the
 * owner's switch, his CLI, an account or a reset time.
 *
 * Her writes are audited by the pipeline as `person.write` with no detail;
 * a run leaves one `chat.run` row under her person, with no text (C8).
 */
import { PERSON_CHAT_SENTENCES } from '@jantar/protocol/people';
import type { ChatItemParams, ChatListQuery, ChatSendBody } from '@jantar/protocol';
import type { LifeResult } from '../../../contracts.js';
import { ApiError } from '../../errors.js';
import { actorName } from '../../request.js';
import { lifeValue, needActor, type Call, type RawReply, type RouteTable } from '../../route-kit.js';

type Id = { id: string };
const OK = { ok: true as const };

export const PERSON_CHAT_SEND_LIMITED = 'Too many messages at once. Try again in a minute.';

/** Her answer: chat.db that won't open, or anything Chat can't do now, is one fixed sentence for her. */
function herValue<T>(r: LifeResult<T>): T {
  if (!r.ok && (r.code === 'life_unavailable' || r.code === 'unavailable')) throw new ApiError('life_unavailable', PERSON_CHAT_SENTENCES.off);
  return lifeValue(r);
}

export const PERSON_CHAT_ROUTE_IMPLS: RouteTable = {
  personChatList: {
    handle: (c: Call<unknown, ChatListQuery>, s) => herValue(s.deps.chat.personList(needActor(c.auth), c.query?.before)),
  },
  personChatStatus: {
    handle: (c: Call, s) => herValue(s.deps.chat.personStatus(needActor(c.auth))),
  },
  personChatSend: {
    handle: (c: Call<unknown, unknown, ChatSendBody>, s) => {
      const actor = needActor(c.auth);
      const who = actorName(c.auth);
      // Her device's burst limit (the owner's per-device numbers); her daily cap is the Chat part's (spec 7.5).
      const limited = s.chatLimiter.check(who);
      if (!limited.ok) throw new ApiError('rate_limited', PERSON_CHAT_SEND_LIMITED, { 'retry-after': String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))) });
      const sent = herValue(s.deps.chat.send({ text: c.body.text, ...(c.body.photos ? { photos: c.body.photos } : {}) }, actor, 'phone'));
      s.chatLimiter.hit(who);
      return sent;
    },
  },
  personChatClear: {
    handle: async (c: Call, s) => (herValue(await s.deps.chat.clear(needActor(c.auth))), OK),
  },
  personChatCancel: {
    handle: (c: Call<Id>, s) => (herValue(s.deps.chat.cancel(c.params.id, needActor(c.auth))), OK),
  },
  personChatTurnDelete: {
    handle: async (c: Call<Id>, s) => (herValue(await s.deps.chat.deleteTurn(c.params.id, needActor(c.auth))), OK),
  },
  personChatUndo: {
    handle: async (c: Call<ChatItemParams>, s) => (herValue(await s.deps.chat.undo(c.params.id, c.params.n, needActor(c.auth))), OK),
  },
  personChatCard: {
    handle: async (c: Call<ChatItemParams>, s) => (herValue(await s.deps.chat.card(c.params.id, c.params.n, needActor(c.auth))), OK),
  },
  personChatDismiss: {
    handle: (c: Call<ChatItemParams>, s) => (herValue(s.deps.chat.dismiss(c.params.id, c.params.n, needActor(c.auth))), OK),
  },
  personChatPhotoCreate: {
    handle: async (c: Call, s) => herValue(await s.deps.chat.photoAdd(c.raw ?? Buffer.alloc(0), needActor(c.auth))),
  },
  personChatPhotoGet: {
    handle: async (c: Call<Id>, s): Promise<RawReply> => {
      const r = herValue(await s.deps.chat.photo(c.params.id, needActor(c.auth)));
      return { kind: 'raw', type: r.type, body: r.body, headers: { 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' } };
    },
  },
  personChatPhotoDelete: {
    handle: async (c: Call<Id>, s) => (herValue(await s.deps.chat.photoDelete(c.params.id, needActor(c.auth))), OK),
  },
};
