/**
 * v0.10 Chat (replaces v0.5.3's Ask): one thread per Mac, shared by every
 * control device and the Siri door. A message runs one isolated headless
 * Claude with Jantar's own tools over one strict MCP server; adds and edits
 * happen at once and come back as changes with Undo; a delete, or anything
 * irreversible or quota-spending, comes back as a Confirm card the user
 * taps; after a turn reads third-party text its writes come back as "Do it"
 * cards. Sessions are read only: nothing here types into a terminal.
 *
 * The phone never trusts the reply for what happened: `changes` and `cards`
 * come from the daemon's journal. Every write reply is `{ id }` or
 * `{ ok: true }`. History lives in chat.db on the Mac (`ask.keepDays`).
 */
import { z } from 'zod';
import { IsoDateSchema } from './models.js';

/** What the phone may send, in characters. */
export const CHAT_TEXT_MAX = 2000;
/** What Siri may send (dictated). */
export const CHAT_VOICE_TEXT_MAX = 1000;
/** A reply's length at most. */
export const CHAT_REPLY_MAX = 2000;
/** A spoken reply at most, before the daemon's own count sentence. */
export const CHAT_VOICE_REPLY_MAX = 300;
/** Photos in one message at most. */
export const CHAT_PHOTOS_MAX = 4;
/** One photo upload at most. */
export const CHAT_PHOTO_MAX_BYTES = 6 * 1024 * 1024;
/** A photo's long edge on the phone and, re-encoded, on the Mac. */
export const CHAT_PHOTO_EDGE = 1568;
/** Direct writes per turn. */
export const CHAT_WRITES_MAX = 10;
/** Confirm and Do-it cards per turn. */
export const CHAT_CARDS_MAX = 10;
/** Every tool call per turn. */
export const CHAT_TOOL_CALLS_MAX = 24;
/** Characters per tool result. */
export const CHAT_TOOL_RESULT_MAX = 12_000;
/** Undo and cards work this long. */
export const CHAT_UNDO_WITHIN_MS = 24 * 60 * 60_000;
/** Turns per GET. */
export const CHAT_PAGE = 30;
/** The Siri door answers within this. */
export const CHAT_VOICE_WAIT_MS = 20_000;
/** Unfinished turns in the thread at most. */
export const CHAT_QUEUE_MAX = 3;
/** Turns kept at most, whatever `ask.keepDays` says. */
export const CHAT_TURNS_MAX = 5000;
/** The photo folder is kept under this (oldest photos go first). */
export const CHAT_PHOTOS_STORE_MAX_BYTES = 500 * 1024 * 1024;
/** A chat key (the Siri door's): this prefix and 32 random bytes, base64url. */
export const CHAT_KEY_PREFIX = 'jchat_';
/** v0.10: the Siri door's one route, under CAPTURE_PREFIX. */
export const CAPTURE_CHAT_PATH = '/v1/capture/chat';

/** What Chat can reach, by part (each only while it is on). v0.12 People: her day plan, sleep and alerts (her thread only). */
export const ChatModuleSchema = z.enum(['todos', 'medicines', 'food', 'places', 'finance', 'posts', 'intel', 'meetings', 'plan', 'sleep', 'alerts']);
export type ChatModule = z.infer<typeof ChatModuleSchema>;

export const ChatChangeOpSchema = z.enum(['add', 'edit', 'done', 'undone', 'snooze', 'log', 'set', 'paid', 'save', 'todo', 'skip', 'start', 'tick']);
export type ChatChangeOp = z.infer<typeof ChatChangeOpSchema>;

/** One direct write of a turn, from the journal (never from the reply). */
export const ChatChangeSchema = z.object({
  n: z.number().int(),
  module: ChatModuleSchema,
  op: ChatChangeOpSchema,
  /** The item's id (a Life id, an Intel id, a meeting id). */
  ref: z.string(),
  /** Daemon-written from the item after the write: "Todo · Buy milk · tomorrow 09:00". */
  label: z.string().max(160),
  state: z.enum(['done', 'undone', 'expired']),
  /** False for an Intel link already on the shelf. */
  undoable: z.boolean(),
});
export type ChatChange = z.infer<typeof ChatChangeSchema>;

/** confirm: a delete or an irreversible action; do: a write of a turn that read third-party text. */
export const ChatCardKindSchema = z.enum(['confirm', 'do']);
export type ChatCardKind = z.infer<typeof ChatCardKindSchema>;

export const ChatCardSchema = z.object({
  n: z.number().int(),
  kind: ChatCardKindSchema,
  module: ChatModuleSchema,
  op: z.string().max(24),
  ref: z.string().nullable(),
  /** "Delete café Example Café and its 3 visits?" */
  label: z.string().max(200),
  state: z.enum(['waiting', 'done', 'dismissed', 'expired', 'failed']),
  /** A fixed sentence when failed. */
  reason: z.string().optional(),
});
export type ChatCard = z.infer<typeof ChatCardSchema>;

export const ChatTurnStateSchema = z.enum(['queued', 'running', 'done', 'failed', 'cancelled']);
export type ChatTurnState = z.infer<typeof ChatTurnStateSchema>;

export const ChatPhotoRefSchema = z.object({ id: z.string(), w: z.number().int(), h: z.number().int(), gone: z.boolean() });
export type ChatPhotoRef = z.infer<typeof ChatPhotoRefSchema>;

export const ChatTurnSchema = z.object({
  id: z.string(),
  at: IsoDateSchema,
  /** voice: the Siri door. */
  via: z.enum(['phone', 'voice']),
  text: z.string(),
  photos: z.array(ChatPhotoRefSchema),
  state: ChatTurnStateSchema,
  reply: z.string().optional(),
  /** A fixed daemon sentence (failed, cancelled), never model or user text. */
  reason: z.string().optional(),
  changes: z.array(ChatChangeSchema),
  cards: z.array(ChatCardSchema),
  /** The turn read third-party text: its later writes became Do-it cards. */
  tainted: z.boolean(),
  /** Tool calls the daemon refused (caps, a part that is off, a link not in the message). */
  refused: z.number().int(),
});
export type ChatTurn = z.infer<typeof ChatTurnSchema>;

export const ChatListSchema = z.object({
  /** The newest CHAT_PAGE (before `before`), oldest first. */
  turns: z.array(ChatTurnSchema),
  /** The cursor for the page before, or null. */
  older: z.string().nullable(),
  ready: z.object({ ok: z.boolean(), reason: z.string().optional() }),
  keepDays: z.number().int(),
});
export type ChatList = z.infer<typeof ChatListSchema>;

export const ChatListQuerySchema = z.strictObject({ before: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional() });
export type ChatListQuery = z.infer<typeof ChatListQuerySchema>;

export const ChatPhotoIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

export const ChatSendBodySchema = z
  .strictObject({ text: z.string().max(CHAT_TEXT_MAX), photos: z.array(ChatPhotoIdSchema).max(CHAT_PHOTOS_MAX).optional() })
  .refine((b) => b.text.trim() !== '' || (b.photos?.length ?? 0) > 0, { message: 'type a message or add a photo' });
export type ChatSendBody = z.infer<typeof ChatSendBodySchema>;

export const ChatTurnParamsSchema = z.strictObject({ id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) });
export type ChatTurnParams = z.infer<typeof ChatTurnParamsSchema>;
export const ChatItemParamsSchema = z.strictObject({ id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/), n: z.coerce.number().int().min(0).max(99) });
export type ChatItemParams = z.infer<typeof ChatItemParamsSchema>;
export const ChatPhotoParamsSchema = z.strictObject({ id: ChatPhotoIdSchema });
export type ChatPhotoParams = z.infer<typeof ChatPhotoParamsSchema>;

/** The Siri door's body: the dictated text. */
export const CaptureChatBodySchema = z.strictObject({ text: z.string().trim().min(1).max(CHAT_VOICE_TEXT_MAX) });
export type CaptureChatBody = z.infer<typeof CaptureChatBodySchema>;
/** What Siri speaks. */
export const CaptureChatReplySchema = z.strictObject({ message: z.string().max(600) });
export type CaptureChatReply = z.infer<typeof CaptureChatReplySchema>;

export const ChatKeySchema = z.string().regex(new RegExp(`^${CHAT_KEY_PREFIX}[A-Za-z0-9_-]{43}$`));
export const ChatKeyIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export const ChatKeyNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((s) => !/[\u0000-\u001f\u007f-\u009f]/.test(s), { message: 'one line, no control characters' });
export const ChatKeyAddBodySchema = z.strictObject({ name: ChatKeyNameSchema.optional() });
export type ChatKeyAddBody = z.infer<typeof ChatKeyAddBodySchema>;
/** The key is shown once; `chatUrl` is null while the door can't exist (loopback, lan, no https address). */
export const ChatKeyAddReplySchema = z.object({ id: ChatKeyIdSchema, key: ChatKeySchema, name: z.string(), chatUrl: z.string().nullable() });
export type ChatKeyAddReply = z.infer<typeof ChatKeyAddReplySchema>;
export const ChatKeyRowSchema = z.object({ id: ChatKeyIdSchema, name: z.string(), createdAt: IsoDateSchema, lastSeenAt: IsoDateSchema.nullable() });
export type ChatKeyRow = z.infer<typeof ChatKeyRowSchema>;
export const ChatKeyListSchema = z.object({ keys: z.array(ChatKeyRowSchema), chatUrl: z.string().nullable(), why: z.string().optional() });
export type ChatKeyList = z.infer<typeof ChatKeyListSchema>;
export const ChatKeyRevokeBodySchema = z.union([z.strictObject({ id: ChatKeyIdSchema }), z.strictObject({ all: z.literal(true) })]);
export type ChatKeyRevokeBody = z.infer<typeof ChatKeyRevokeBodySchema>;
export const ChatKeyRevokeReplySchema = z.object({ revoked: z.number().int().nonnegative() });
export type ChatKeyRevokeReply = z.infer<typeof ChatKeyRevokeReplySchema>;

/** `jantar chat status`: the history's size on disk (no text). */
export const ChatStatusSchema = z.object({
  turns: z.number().int().nonnegative(),
  photos: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  broken: z.string().nullable(),
});
export type ChatStatus = z.infer<typeof ChatStatusSchema>;
