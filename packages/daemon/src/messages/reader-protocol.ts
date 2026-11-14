/**
 * The messages reader's socket protocol (0.15): what the daemon and
 * `jantar-messages-reader` (assets/messages/jantar-messages-reader.swift),
 * the one program that opens WhatsApp's files, say to each other.
 *
 * - Newline-delimited JSON over a 0600 Unix socket; the reader closes any
 *   connection whose peer uid isn't its own.
 * - A request is `{id, op, args}`; a reply `{id, ok: true, data}` or
 *   `{id, ok: false, error, detail?}` (`id` 0 when the request had none).
 * - WhatsApp's ids never cross it: chats are keys (HMAC under the reader's
 *   salt), messages their chat's key and stanza id; a mention in a line is
 *   "@" + the person's name ("@Me", "@[skipped]", "@Unknown"). A phone
 *   number (digits) is on a 1:1's chat only.
 * - A skipped chat is `not_found`, never `skipped`, so a reply never
 *   confirms it exists.
 * - Every reply is checked here before the daemon uses it.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { IsoDateSchema, MESSAGES_LIMITS } from '@jantar/protocol';
import {
  CallSchema,
  ChatKeySchema,
  ChatOwnerSchema,
  MessageKindSchema,
  MessageSchema,
  MessagesAmbiguousSchema,
  MessagesReadResponseSchema,
  MessagesSearchResponseSchema,
  MsgKeySchema,
} from '@jantar/protocol/messages';

/** The ops and answers the reader speaks; status says which a running reader has. */
export const READER_VERSION = 1;
/** The reader's source, under the daemon's assets dir. */
export const READER_SOURCE = 'messages/jantar-messages-reader.swift';
/** The most chats in one `chats` answer (GET /v1/messages/chats's limit). */
export const READER_CHATS_MAX = 200;
const NAME_MAX = 100;
/** A search's longest text (GET /v1/messages/search's `q`). */
const QUERY_MAX = 200;
/** newSince: the most lines kept before a chat's first new one. */
export const READER_EARLIER_MAX = 10;
/** newSince: the most lines in one answer. */
export const READER_NEW_ROWS_MAX = 20_000;
/** newSince: the longest window, in hours (guardHours, firstRunHours). */
const READER_HOURS_MAX = 720;
/** lastFromMe: the most chat keys in one request (the morning run and callsToReturn ask in chunks of it). */
export const READER_KEYS_MAX = 500;

const count = z.number().int().nonnegative();
const replyId = z.number().int().nonnegative();

export const ReaderErrorSchema = z.enum(['bad_request', 'no_access', 'not_found', 'unsupported', 'timeout', 'busy', 'skipped']);
export type ReaderError = z.infer<typeof ReaderErrorSchema>;

export const ReaderReplySchema = z.discriminatedUnion('ok', [
  z.object({ id: replyId, ok: z.literal(true), data: z.unknown() }),
  z.object({ id: replyId, ok: z.literal(false), error: ReaderErrorSchema, detail: z.string().optional() }),
]);
export type ReaderReply = z.infer<typeof ReaderReplySchema>;

/**
 * `found`: ChatStorage.sqlite is there; `running`: WhatsApp is open;
 * `schemaOk`: false when a column the reader reads is missing (reads are
 * then `unsupported`); `contactsOk`: false when ContactsV2 or LID.sqlite
 * (names, and which @lid is which number) is there but won't open, and
 * reads then answer that failure (`no_access`, `timeout`, `busy`) rather
 * than miss a skipped person's other id; `newestAt`: the newest message's
 * time; `walMtime`: when WhatsApp last wrote (its -wal file). Both times
 * are null while the database is closed: macOS's SQLite opens it read-only
 * only with its -wal there, so reads answer `busy` until WhatsApp is open.
 * `phone.readable`: macOS lets the reader open the iPhone call log (Full
 * Disk Access). `skipped`: entries in the skip list; `skipOk`: false while
 * the skip list won't parse (reads then answer `busy`, and `skipped` counts
 * the last good one); `skipUnmatched`: how many of its keys name no chat or
 * person on this Mac (a skipped 1:1 WhatsApp no longer has; the skip still
 * holds for that person's own ids), left out until a read has looked.
 *
 * Telling `busy` and `no_access` apart: `busy` is WhatsApp closed
 * (`found` and no `walMtime`), a broken skip list (`skipOk: false`), SQLite
 * busy or a read-only WAL connection meeting WhatsApp mid-recovery;
 * `no_access` with `found: false` is no WhatsApp for Mac here, not a
 * missing Full Disk Access (WhatsApp's files don't need it); with
 * `contactsOk: false`, macOS refused ContactsV2 or LID.sqlite.
 */
export const ReaderStatusSchema = z.object({
  whatsapp: z.object({
    found: z.boolean(),
    running: z.boolean(),
    schemaOk: z.boolean(),
    contactsOk: z.boolean(),
    newestAt: IsoDateSchema.nullable(),
    walMtime: IsoDateSchema.nullable(),
  }),
  phone: z.object({ readable: z.boolean() }),
  skipped: count,
  skipOk: z.boolean(),
  skipUnmatched: count.optional(),
  version: z.number().int().positive(),
});
export type ReaderStatus = z.infer<typeof ReaderStatusSchema>;

export const ReaderChatsSchema = z.object({ chats: z.array(ChatOwnerSchema), total: count });
export type ReaderChats = z.infer<typeof ReaderChatsSchema>;
/**
 * Oldest first; `more`: older messages exist (ask again with `before` = the
 * first message's `at`). A page never ends inside a millisecond: it stops
 * short of the lines sharing the first left-out one's, or, when all its
 * lines share it, holds them all past `limit` (up to MESSAGES_LIMITS.readMax).
 * Exact while WhatsApp's order and its times agree; a line with a skewed
 * time can come on two pages or, rarely, be missed.
 */
export const ReaderReadSchema = MessagesReadResponseSchema;
export type ReaderRead = z.infer<typeof ReaderReadSchema>;
/** A name two or more chats share answers the candidates (the newest 20, with `total`), never one picked. */
export const ReaderReadByNameSchema = z.union([ReaderReadSchema, MessagesAmbiguousSchema]);
export type ReaderReadByName = z.infer<typeof ReaderReadByNameSchema>;

/**
 * Lines that hold `q` in their text, caption or file name, newest first,
 * from `since` (90 days back without it). A snippet is the line as a read
 * shows it, cut around the match; the digits inside a mention never match.
 */
export const ReaderSearchSchema = MessagesSearchResponseSchema;
export type ReaderSearch = z.infer<typeof ReaderSearchSchema>;

/**
 * Where the morning feed got to: `pk` is WhatsApp's row id (lines come in
 * row order), `at` the newest line's time up to it (for the report; the
 * reader goes by `pk`).
 */
export const ReaderCursorSchema = z.object({ pk: z.number().int().nonnegative(), at: IsoDateSchema });
export type ReaderCursor = z.infer<typeof ReaderCursorSchema>;
/** One chat's new lines (oldest first) and up to READER_EARLIER_MAX lines before the first of them. */
export const ReaderNewChatSchema = z.object({
  chat: ChatOwnerSchema,
  messages: z.array(MessageSchema).min(1),
  earlier: z.array(MessageSchema).max(READER_EARLIER_MAX),
});
export type ReaderNewChat = z.infer<typeof ReaderNewChatSchema>;
/**
 * The morning feed: lines after `cursor.pk` from the last `guardHours`; with
 * no cursor, or one above WhatsApp's newest row id (it renumbered them when
 * re-linked: `reset`), the last `firstRunHours`. Chats newest first.
 * `truncated`: `maxRows` lines came and more are there; `nextCursor` goes on
 * from the last one.
 */
export const ReaderNewSinceSchema = z.object({
  chats: z.array(ReaderNewChatSchema),
  nextCursor: ReaderCursorSchema,
  truncated: z.boolean(),
  reset: z.boolean(),
});
export type ReaderNewSince = z.infer<typeof ReaderNewSinceSchema>;
/**
 * Each chat key asked for: when the owner last wrote there (a 1:1's key
 * counts every chat with that person, under either id), null when never,
 * or for a chat that is unknown, left out or skipped. System and deleted
 * lines don't count.
 */
export const ReaderLastFromMeSchema = z.record(ChatKeySchema, IsoDateSchema.nullable());
export type ReaderLastFromMe = z.infer<typeof ReaderLastFromMeSchema>;
/**
 * A message's file, copied (0600) into `<state>/spool/` for the daemon,
 * which deletes it after use; the reader deletes any copy older than 10
 * minutes. `fileName`: a document's. `not_found` when WhatsApp hasn't the
 * file on this Mac; `bad_request` when it is over `maxBytes`.
 */
export const ReaderMediaSchema = z.object({
  file: z.string().startsWith('/'),
  bytes: count,
  kind: MessageKindSchema,
  mime: z.string().min(1),
  fileName: z.string().optional(),
});
export type ReaderMedia = z.infer<typeof ReaderMediaSchema>;
/**
 * Calls from `since`, oldest first (the newest 500 at most). `who`: the
 * address book's name, else the chat's or push name, else the number
 * ("+91 99900 00002"); a call with several people and no group names them
 * all, joined with ", " (sorted by id) and has no `chatKey`. `missed`: an
 * incoming call nobody picked up. A skipped person's calls never come (the
 * owner's own ids aside: skipping "Message yourself" hides none of theirs).
 * phoneCalls is `no_access` until the reader has Full Disk Access.
 */
export const ReaderCallsSchema = z.object({ calls: z.array(CallSchema) });
export type ReaderCalls = z.infer<typeof ReaderCallsSchema>;

const readLimit = z.number().int().min(1).max(MESSAGES_LIMITS.readMax);
const hours = z.number().int().min(1).max(READER_HOURS_MAX);
const readWindow = { since: IsoDateSchema.optional(), before: IsoDateSchema.optional(), limit: readLimit };

/** Each op's args, as the daemon sends them. `waiting`: only 1:1s whose last message is theirs, within MESSAGES_LIMITS.waitingDays. */
export const READER_ARGS = {
  status: z.strictObject({}),
  chats: z.strictObject({
    q: z.string().min(1).max(NAME_MAX).optional(),
    since: IsoDateSchema.optional(),
    limit: z.number().int().min(1).max(READER_CHATS_MAX),
    waiting: z.boolean().optional(),
  }),
  read: z.strictObject({ chatKey: ChatKeySchema, ...readWindow }),
  readByName: z.strictObject({ name: z.string().min(1).max(NAME_MAX), ...readWindow }),
  search: z.strictObject({
    q: z.string().min(1).max(QUERY_MAX),
    since: IsoDateSchema.optional(),
    chatKey: ChatKeySchema.optional(),
    limit: z.number().int().min(1).max(MESSAGES_LIMITS.searchMax),
  }),
  newSince: z.strictObject({
    cursor: ReaderCursorSchema.nullable(),
    guardHours: hours,
    firstRunHours: hours,
    maxRows: z.number().int().min(1).max(READER_NEW_ROWS_MAX),
  }),
  lastFromMe: z.strictObject({ chatKeys: z.array(ChatKeySchema).max(READER_KEYS_MAX) }),
  media: z.strictObject({ msgKey: MsgKeySchema, maxBytes: z.number().int().min(1).max(MESSAGES_LIMITS.mediaMaxBytes) }),
  waCalls: z.strictObject({ since: IsoDateSchema }),
  phoneCalls: z.strictObject({ since: IsoDateSchema }),
} as const;

/** Each op's answer. */
export const READER_DATA = {
  status: ReaderStatusSchema,
  chats: ReaderChatsSchema,
  read: ReaderReadSchema,
  readByName: ReaderReadByNameSchema,
  search: ReaderSearchSchema,
  newSince: ReaderNewSinceSchema,
  lastFromMe: ReaderLastFromMeSchema,
  media: ReaderMediaSchema,
  waCalls: ReaderCallsSchema,
  phoneCalls: ReaderCallsSchema,
} as const;

export type ReaderOp = keyof typeof READER_DATA;
export type ReaderArgs = { [O in ReaderOp]: z.input<(typeof READER_ARGS)[O]> };
export type ReaderData = { [O in ReaderOp]: z.infer<(typeof READER_DATA)[O]> };

/** One op's answer, checked (throws a ZodError when it isn't that shape). */
export function parseReaderData<O extends ReaderOp>(op: O, data: unknown): ReaderData[O] {
  return READER_DATA[op].parse(data) as ReaderData[O];
}

/** The reader's build key: sha256 of its Swift source (an installed reader with another key needs a rebuild). */
export function readerSourceKey(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}
