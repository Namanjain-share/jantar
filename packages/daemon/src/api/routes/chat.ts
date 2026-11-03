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
import {
  CHAT_VOICE_WAIT_MS,
  type CaptureChatBody,
  type CaptureChatReply,
  type ChatItemParams,
  type ChatKeyAddBody,
  type ChatKeyAddReply,
  type ChatKeyList,
  type ChatKeyRevokeBody,
  type ChatKeyRevokeReply,
  type ChatListQuery,
  type ChatSendBody,
} from '@jantar/protocol';
import { CHAT_KEY_DEFAULT_NAME, chatDoor } from '../../auth/capture-keys.js';
import type { LifeResult } from '../../contracts.js';
import { auditResult } from '../audit.js';
import { ApiError, toErrorReply } from '../errors.js';
import { actorName } from '../request.js';
import { lifeAudit, lifeValue, needActor, type Call, type RawReply, type RouteTable } from '../route-kit.js';
import { CHAT_LIMITS } from '../services.js';

type Id = { id: string };

export const CHAT_SEND_LIMITED = 'Too many messages from this device; try again in a minute.';
export const CHAT_SEND_DAY_LIMITED = `This device has sent ${CHAT_LIMITS.sendDay.limit} messages today. Try again tomorrow.`;

/** A write that answers `{ ok: true }`: the part's refusal as the API error, else ok. */
function okOf(r: LifeResult): { ok: true } {
  lifeValue(r);
  return { ok: true };
}

export const CHAT_ROUTE_IMPLS: RouteTable = {
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
      const sent = lifeValue(
        s.deps.chat.send({ text: c.body.text, ...(c.body.photos ? { photos: c.body.photos } : {}), ...(c.body.context ? { context: c.body.context } : {}) }, actor, 'phone'),
      );
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

  // ---------------------------------------------------------------- the Siri door's keys (the Mac only)
  // A key is shown once, in the add reply, with the door's URL (null while it can't exist); only its
  // prefixed sha256 is stored. Never logged, audited, put in a URL, a cookie or an event: ids only.
  chatKeyAdd: {
    handle: (c: Call<Record<string, string>, unknown, ChatKeyAddBody>, s): ChatKeyAddReply => {
      const made = s.chatKeys.issue(c.body.name ?? CHAT_KEY_DEFAULT_NAME);
      c.scratch.keyId = made.id;
      return { ...made, chatUrl: chatDoor(s.ctx.settings.get()).url };
    },
    audit: (c) => ({ target: typeof c.scratch.keyId === 'string' ? c.scratch.keyId : undefined, params: {} }),
  },
  chatKeyList: {
    handle: (_c: Call, s): ChatKeyList => {
      const door = chatDoor(s.ctx.settings.get());
      return {
        keys: s.chatKeys.list().map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt, lastSeenAt: k.lastSeenAt })),
        chatUrl: door.url,
        ...(door.open ? {} : { why: door.why }),
      };
    },
  },
  chatKeyRevoke: {
    handle: (c: Call<Record<string, string>, unknown, ChatKeyRevokeBody>, s): ChatKeyRevokeReply => {
      const body = c.body;
      if ('all' in body) return { revoked: s.chatKeys.revokeAll() };
      return { revoked: s.chatKeys.revoke(body.id) ? 1 : 0 };
    },
    audit: (c: Call<Record<string, string>, unknown, ChatKeyRevokeBody>, out) => ({
      target: 'id' in c.body ? c.body.id : 'all',
      params: { revoked: (out.body as { revoked?: unknown } | null)?.revoked ?? 0 },
    }),
  },

  // ---------------------------------------------------------------- the Siri door (spec 0.10 B11)
  // The pipeline has run the door's gate (TLS mode with an https address, Chat on, an active chat key, no
  // Origin, the key before the body, the bad-key and per-key limits), --read-only and the strict body. The
  // turn is queued as the key's actor and waited for at most CHAT_VOICE_WAIT_MS from now; a request that
  // goes away does not cancel it. The audit row is capture.chat with the key's id and the turn's id.
  captureChat: {
    selfAudit: true,
    handle: async (c: Call<Record<string, string>, unknown, CaptureChatBody>, s): Promise<CaptureChatReply> => {
      const keyId = c.auth.capture?.id;
      if (!keyId) throw new ApiError('unauthorized', 'a Siri key is needed');
      const audit = (status: number, outcome: string, turnId?: string) =>
        s.auditor.write({ actor: actorName(c.auth), action: 'capture.chat', ...(turnId ? { target: turnId } : {}), params: { keyId, ...(turnId ? { turnId } : {}), outcome }, result: auditResult(status) });
      try {
        // Life or chat.db that will not open: 503 with its sentence (the door's errors keep their status).
        const broken = s.deps.chat.broken() ?? s.deps.life.broken();
        if (broken) throw new ApiError('life_unavailable', broken);
        const r = await s.deps.chat.voice(c.body.text, needActor(c.auth), CHAT_VOICE_WAIT_MS);
        audit(200, r.outcome, r.turnId);
        return { message: r.message.slice(0, 600) };
      } catch (e) {
        const r = toErrorReply(e);
        audit(r.status, 'refused');
        throw e;
      }
    },
  },
};
