/**
 * 0.15 Messages: the owner's client for the Messages routes his phone uses,
 * in Messages' lazy chunk, so the main load carries none of it. The calls go
 * through the app's own `api.request` (the device secret and an
 * Idempotency-Key on a write, as every call). Every path is one of
 * `@jantar/protocol/messages`'s MESSAGES_ROUTES, taken here as words so the
 * chunk carries no schema (test/messages/client.test.ts compares them).
 *
 * Owner-only: every route here is a control route on his host. Removing a
 * chat from the skip list is not here at all: a phone never widens what
 * Jantar reads (the Mac's `jantar messages skip remove`), and the daemon
 * refuses it over the network anyway. A blank search is left out of the
 * query (the daemon refuses an empty `q`).
 */
import type { OkReply } from '@jantar/protocol';
import type {
  DraftState,
  MessagesChatsResponse,
  MessagesPrefs,
  MessagesPrefsPatch,
  MessagesReadsResponse,
  MessagesSkipList,
  MessagesStatus,
  MessagesTodayResponse,
  MorningRun,
} from '@jantar/protocol/messages';
import type { Api, ApiRoute } from '../../../lib/api.js';

export const MESSAGES_PATHS = {
  messagesStatus: { method: 'GET', path: '/v1/messages/status' },
  messagesChats: { method: 'GET', path: '/v1/messages/chats' },
  messagesSkipList: { method: 'GET', path: '/v1/messages/skip' },
  messagesSkipAdd: { method: 'POST', path: '/v1/messages/skip' },
  messagesToday: { method: 'GET', path: '/v1/messages/today' },
  messagesDraftUpdate: { method: 'PATCH', path: '/v1/messages/drafts/:id' },
  messagesMorningRun: { method: 'POST', path: '/v1/messages/morning/run' },
  messagesMorningUndo: { method: 'POST', path: '/v1/messages/morning/:runId/undo' },
  messagesPrefsGet: { method: 'GET', path: '/v1/messages/prefs' },
  messagesPrefsPatch: { method: 'PATCH', path: '/v1/messages/prefs' },
  messagesReads: { method: 'GET', path: '/v1/messages/reads' },
} as const satisfies Record<string, ApiRoute>;

export interface MessagesClient {
  /** On or off, the reader's state, WhatsApp's newest message and the morning time (no switch: it answers while off). */
  status(): Promise<MessagesStatus>;
  /** The newest morning run (not a dry one), the open reply drafts and the open call-backs. */
  today(): Promise<MessagesTodayResponse>;
  /** Done, Dismiss, or open again (Undo). */
  setDraft(id: string, state: DraftState, idempotencyKey?: string): Promise<OkReply>;
  /** Run now: the run's report once it is done (one at a time: 409 while another goes). */
  run(idempotencyKey?: string): Promise<MorningRun>;
  /** Undo this morning: the run's open todos go and its drafts are dismissed. */
  undo(runId: string, idempotencyKey?: string): Promise<OkReply>;
  prefs(): Promise<MessagesPrefs>;
  /** Only the keys sent change; null turns that time off. */
  setPrefs(patch: MessagesPrefsPatch, idempotencyKey?: string): Promise<OkReply>;
  /** Chats by name, newest first (a read: the Mac logs it). A blank `q` is left out. */
  chats(q: string, limit: number): Promise<MessagesChatsResponse>;
  skipList(): Promise<MessagesSkipList>;
  /** Skip a chat (a 1:1 skips that person everywhere). */
  skip(chatKey: string, idempotencyKey?: string): Promise<OkReply>;
  /** The read log, newest first. */
  reads(limit: number): Promise<MessagesReadsResponse>;
}

export function messagesClient(api: Api): MessagesClient {
  const P = MESSAGES_PATHS;
  const key = (k: string | undefined) => (k ? { idempotencyKey: k } : {});
  return {
    status: () => api.request(P.messagesStatus),
    today: () => api.request(P.messagesToday),
    setDraft: (id, state, k) => api.request(P.messagesDraftUpdate, { params: { id }, body: { state }, ...key(k) }),
    // The body is a strict object: Run now sends {} (a dry run is the Mac's CLI).
    run: (k) => api.request(P.messagesMorningRun, { body: {}, ...key(k) }),
    undo: (runId, k) => api.request(P.messagesMorningUndo, { params: { runId }, ...key(k) }),
    prefs: () => api.request(P.messagesPrefsGet),
    setPrefs: (patch, k) => api.request(P.messagesPrefsPatch, { body: patch, ...key(k) }),
    chats: (q, limit) => {
      const t = q.trim();
      return api.request(P.messagesChats, { query: { ...(t ? { q: t } : {}), limit } });
    },
    skipList: () => api.request(P.messagesSkipList),
    skip: (chatKey, k) => api.request(P.messagesSkipAdd, { body: { chatKey }, ...key(k) }),
    reads: (limit) => api.request(P.messagesReads, { query: { limit } }),
  };
}
