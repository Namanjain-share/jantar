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
import { ChatKeySchema, ChatOwnerSchema, MessagesAmbiguousSchema, MessagesReadResponseSchema } from '@jantar/protocol/messages';

/** The ops and answers the reader speaks; status says which a running reader has. */
export const READER_VERSION = 1;
/** The reader's source, under the daemon's assets dir. */
export const READER_SOURCE = 'messages/jantar-messages-reader.swift';
/** The most chats in one `chats` answer (GET /v1/messages/chats's limit). */
const READER_CHATS_MAX = 200;
const NAME_MAX = 100;

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
 * the last good one).
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

const readLimit = z.number().int().min(1).max(MESSAGES_LIMITS.readMax);
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
} as const;

/** Each op's answer. */
export const READER_DATA = {
  status: ReaderStatusSchema,
  chats: ReaderChatsSchema,
  read: ReaderReadSchema,
  readByName: ReaderReadByNameSchema,
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
