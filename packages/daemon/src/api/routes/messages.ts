/**
 * The phone's, the CLI's and `jantar mcp`'s Messages routes (0.15), the
 * owner's only (scope control, his host): messagesStatus (no switch: it says
 * whether Messages is on and what the reader needs), chats, a chat by key or
 * by name, search, a message's image, calls to return, the skip list, the
 * morning run's Today, drafts, Run now, Undo and times, and the read log.
 * Each calls `s.deps.messages` (messages/service.ts).
 *
 * The pipeline has already checked the device and control (or ctl.sock for
 * the routes marked ctl), Origin and the device secret on writes, the
 * switch, a broken messages.db (503), a phone's write limit, and validated
 * the params, query and strict body. Here:
 * - who reads, for the read log (ReadBy): the phone over TCP; on ctl.sock
 *   `jantar mcp` when MESSAGES_CALLER_HEADERS say so (its caller's pid and
 *   folder, advisory), else the CLI;
 * - a reader failure the owner can fix is 503 messages_unavailable with its
 *   MESSAGES_SAYS sentence (never the reader's own detail); a chat or file
 *   the reader doesn't show is 404, the same for one that is skipped;
 * - a 1:1's number is on the owner's answers over TCP only: ctl.sock's (the
 *   CLI and every Claude session) never carry it;
 * - a name two chats share answers the candidates and `total`, never one;
 * - removing a skip widens what Jantar reads: refused over TCP (the part
 *   refuses anyone but the CLI too);
 * - messagesMedia answers the shrunk JPEG with meetingShot's headers and,
 *   for a device, takes its bytes from s.rawBytesBudget (shared with Files
 *   and Meetings); anything else is 415 not_an_image, by name and size;
 * - writes reply `{ ok: true }` (Run now: the run's report) and audit their
 *   target id only (a chat key, a draft or run id), never a name or text;
 *   GETs are not audited.
 */
import {
  MESSAGES_CALLER_HEADERS,
  type DraftPatch,
  type MessageKind,
  type MessagesChatsQuery,
  type MessagesPrefsPatch,
  type MessagesReadByNameQuery,
  type MessagesReadQuery,
  type MessagesReadsQuery,
  type MessagesSearchQuery,
  type MorningRunBody,
  type SkipAddBody,
} from '@jantar/protocol/messages';
import type { ReadBy } from '../../contracts.js';
import { MESSAGES_SAYS, ReaderFailure, readerSays } from '../../messages/index.js';
import { ApiError } from '../errors.js';
import { actorName } from '../request.js';
import { lifeAudit, lifeValue, needActor, type Call, type RawReply, type RouteTable } from '../route-kit.js';

type ChatParams = { chatKey: string };
type MsgParams = { msgKey: string };
type RunParams = { runId: string };
type Id = { id: string };
type NoParams = Record<string, string>;

const OK = { ok: true as const };
const KB = 1024;

/** messagesMedia's 429 once a device has read its bytes for the window (V03_LIMITS.rawBytes). */
export const MESSAGE_FILE_READS_LIMITED = 'too many image bytes in the last 10 minutes; wait a little and try again';

/** What a file with no name is called in the 415. */
const FILE_LABEL: Partial<Record<MessageKind, string>> = { video: 'This video', voice: 'This voice note', gif: 'This GIF', document: 'This document' };

/** The 415's sentence for a file Messages won't show: its name (or what it is) and its size. */
export function notAnImage(d: { fileName?: string; bytes: number; kind: MessageKind }): string {
  const label = d.fileName ?? FILE_LABEL[d.kind] ?? 'This file';
  return `${label}, ${Math.max(1, Math.ceil(d.bytes / KB))} KB: only images can be shown`;
}

/** The daemon's own failures (media.ts) carry a MESSAGES_SAYS sentence as their detail; the reader's details are never shown. */
const OWN_SENTENCES: ReadonlySet<string> = new Set(Object.values(MESSAGES_SAYS));

/** A reader failure as the API error: the owner's fix (503), else the caller's 404 or 400. */
function readerFailure(e: ReaderFailure, notFound: string, badRequest: string): ApiError {
  const fix = readerSays(e.code);
  if (fix !== null) return new ApiError('messages_unavailable', e.detail !== undefined && OWN_SENTENCES.has(e.detail) ? e.detail : fix);
  return e.code === 'bad_request' ? new ApiError('invalid_request', badRequest) : new ApiError('not_found', notFound);
}

/** `fn`'s answer, or its ReaderFailure as an API error. */
async function reading<T>(fn: () => Promise<T>, notFound: string = MESSAGES_SAYS.noChat, badRequest: string = MESSAGES_SAYS.badAsk): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw e instanceof ReaderFailure ? readerFailure(e, notFound, badRequest) : e;
  }
}

function header(c: Call, name: string): string | undefined {
  const v = c.req.headers[name];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function decoded(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Who reads (the read log): the phone over TCP; on ctl.sock `jantar mcp` when its headers say so, else the CLI. */
export function readByOf(c: Call): ReadBy {
  if (c.auth.transport !== 'ctl') return { via: 'phone' };
  if (header(c, MESSAGES_CALLER_HEADERS.via) !== 'mcp') return { via: 'cli' };
  const pid = Number(header(c, MESSAGES_CALLER_HEADERS.pid));
  const folder = header(c, MESSAGES_CALLER_HEADERS.folder);
  return { via: 'mcp', ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}), ...(folder ? { folder: decoded(folder) } : {}) };
}

/** A chat as this caller sees it: a 1:1's number on the owner's answers over TCP only. */
function shown<T extends object>(c: Call, chat: T): T {
  if (c.auth.transport === 'tcp' || !Object.hasOwn(chat, 'phone')) return chat;
  const out = { ...chat } as T & { phone?: unknown };
  delete out.phone;
  return out;
}

export const MESSAGES_ROUTE_IMPLS: RouteTable = {
  messagesStatus: {
    handle: (_c: Call, s) => s.deps.messages.status(),
  },

  messagesChats: {
    handle: async (c: Call<NoParams, MessagesChatsQuery>, s) => {
      const r = await reading(() => s.deps.messages.chats(c.query, readByOf(c)));
      return { ...r, chats: r.chats.map((chat) => shown(c, chat)) };
    },
  },

  messagesRead: {
    handle: async (c: Call<ChatParams, MessagesReadQuery>, s) => {
      const r = await reading(() => s.deps.messages.read(c.params.chatKey, c.query, readByOf(c)));
      return { ...r, chat: shown(c, r.chat) };
    },
  },

  messagesReadByName: {
    handle: async (c: Call<NoParams, MessagesReadByNameQuery>, s) => {
      const { name, ...q } = c.query;
      const r = await reading(() => s.deps.messages.readByName(name, q, readByOf(c)));
      // Never one picked: the candidates (the newest 20) and how many matched.
      if ('ambiguous' in r) return { ambiguous: r.ambiguous.map((chat) => shown(c, chat)), total: r.total };
      return { ...r, chat: shown(c, r.chat) };
    },
  },

  messagesSearch: {
    handle: (c: Call<NoParams, MessagesSearchQuery>, s) => reading(() => s.deps.messages.search(c.query, readByOf(c))),
  },

  messagesMedia: {
    handle: async (c: Call<MsgParams>, s): Promise<RawReply> => {
      const got = await reading(() => s.deps.messages.media(c.params.msgKey, readByOf(c)), MESSAGES_SAYS.noFile, MESSAGES_SAYS.tooBig);
      if (!('jpeg' in got)) throw new ApiError('not_an_image', notAnImage(got.document));
      if (c.auth.transport === 'tcp') {
        const budget = s.rawBytesBudget.take(actorName(c.auth), got.jpeg.length);
        if (!budget.ok) throw new ApiError('rate_limited', MESSAGE_FILE_READS_LIMITED, { 'retry-after': String(Math.max(1, Math.ceil(budget.retryAfterMs / 1000))) });
      }
      return {
        kind: 'raw',
        type: 'image/jpeg',
        body: got.jpeg,
        // meetingShot's, but no etag: jantar-media makes the JPEG anew on each read.
        headers: {
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'cache-control': 'private, no-store',
          'cross-origin-resource-policy': 'same-origin',
        },
      };
    },
  },

  messagesCalls: {
    handle: (c: Call, s) => reading(() => s.deps.messages.callsToReturn(readByOf(c))),
  },

  messagesSkipList: {
    handle: (_c: Call, s) => ({ skip: s.deps.messages.skip.list() }),
  },

  messagesSkipAdd: {
    handle: async (c: Call<NoParams, unknown, SkipAddBody>, s) => {
      // The reader names the chat for the list; a chat it doesn't show is the part's not_found.
      lifeValue(await reading(() => s.deps.messages.skip.add(c.body.chatKey, needActor(c.auth))));
      return OK;
    },
    audit: (c: Call<NoParams, unknown, SkipAddBody | undefined>) => (c.body?.chatKey ? { target: c.body.chatKey } : {}),
  },

  messagesSkipRemove: {
    handle: (c: Call<ChatParams>, s) => {
      // A phone never widens what Jantar reads: the Mac's CLI only.
      if (c.auth.transport !== 'ctl') throw new ApiError('forbidden', MESSAGES_SAYS.skipRemoveMacOnly);
      lifeValue(s.deps.messages.skip.remove(c.params.chatKey, needActor(c.auth)));
      return OK;
    },
    audit: (c: Call<ChatParams>) => ({ target: c.params.chatKey }),
  },

  messagesToday: {
    handle: (_c: Call, s) => s.deps.messages.morning.today(),
  },

  messagesDraftUpdate: {
    handle: (c: Call<Id, unknown, DraftPatch>, s) => {
      lifeValue(s.deps.messages.morning.setDraft(c.params.id, c.body.state, needActor(c.auth)));
      return OK;
    },
    audit: lifeAudit,
  },

  messagesMorningRun: {
    // The run reads through the reader: its failures answer as a read's do. Audited by the run's id.
    handle: (c: Call<NoParams, unknown, MorningRunBody>, s) => reading(() => s.deps.messages.morning.run({ trigger: c.body.dryRun ? 'dry' : 'now' })),
    audit: lifeAudit,
  },

  messagesMorningUndo: {
    handle: (c: Call<RunParams>, s) => {
      lifeValue(s.deps.messages.morning.undo(c.params.runId, needActor(c.auth)));
      return OK;
    },
    audit: (c: Call<RunParams>) => ({ target: c.params.runId }),
  },

  messagesPrefsGet: {
    handle: (_c: Call, s) => s.deps.messages.morning.prefs(),
  },

  messagesPrefsPatch: {
    handle: (c: Call<NoParams, unknown, MessagesPrefsPatch>, s) => {
      lifeValue(s.deps.messages.morning.setPrefs(c.body, needActor(c.auth)));
      return OK;
    },
  },

  messagesReads: {
    handle: (c: Call<NoParams, MessagesReadsQuery>, s) => ({ reads: s.deps.messages.reads(c.query.limit) }),
  },
};
