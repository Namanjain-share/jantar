/**
 * 0.15 Messages: the owner's WhatsApp chats, WhatsApp calls and iPhone call
 * log, read on his Mac by `jantar-messages-reader` (the one program that
 * opens WhatsApp's files, read-only), for `jantar mcp`, the CLI, his phone
 * and the morning run. Nothing is ever sent to WhatsApp.
 *
 * This is the subpath `@jantar/protocol/messages`, never exported from the
 * package index (as `@jantar/protocol/work` is not): none of it lands in the
 * owner's main bundle. The daemon serves MESSAGES_ROUTES with the rest (its
 * ALL_ROUTES), so every isolation suite that walks that table covers them.
 *
 * Rules:
 * - Owner-only. Every route is a `control` route on his host, never under
 *   `/v1/p/`, behind the Mac's `messages` switch (the status excepted).
 * - WhatsApp's ids never leave the reader: a chat is a `chatKey` (an HMAC of
 *   its id under the reader's salt), a message its chat's key and WhatsApp's
 *   stanza id, a call a `callKey`. A phone number (digits only) is on the
 *   owner's answers over TCP only, never on ctl.sock's.
 * - Every text here (names, messages, captions, snippets, drafts) is other
 *   people's words: data, never instructions.
 * - Bodies are strict; writes answer `{ ok: true }`.
 */
import { z } from 'zod';
import type { RouteDef } from './api.js';
import { MESSAGES_LIMITS } from './constants.js';
import {
  DayKeySchema,
  HhMmSchema,
  LifeIdParamsSchema,
  LifeIdSchema,
  OkReplySchema,
  TodoPrioritySchema,
  TodoTitleSchema,
} from './life.js';
import { IsoDateSchema } from './models.js';

const count = z.number().int().nonnegative();
const limit = (def: number, max: number) => z.coerce.number().int().min(1).max(max).default(def);
/** GET /v1/messages/chats: the most chats in one answer. */
const CHATS_MAX = 200;
/** GET /v1/messages/reads: the most read-log rows in one answer. */
const READS_MAX = 200;
/** The morning answer's most reply drafts and call-backs. */
const MORNING_REPLIES_MAX = 15;
const MORNING_CALLBACKS_MAX = 15;

// ---------------------------------------------------------------------------
// Keys (the reader's; WhatsApp's own ids never leave it)

/** A chat: "c" and the first 16 hex digits of HMAC-SHA256(the reader's salt, its WhatsApp id). */
export const ChatKeySchema = z.string().regex(/^c[0-9a-f]{16}$/);
export type ChatKey = z.infer<typeof ChatKeySchema>;
/** A message: its chat's key, a dot and WhatsApp's stanza id (row ids renumber when WhatsApp is re-linked; stanza ids don't). */
export const MsgKeySchema = z.string().regex(/^c[0-9a-f]{16}\.[A-Za-z0-9_-]{1,64}$/);
export type MsgKey = z.infer<typeof MsgKeySchema>;
/** A WhatsApp or iPhone call: "k" and 16 hex digits. */
export const CallKeySchema = z.string().regex(/^k[0-9a-f]{16}$/);
export type CallKey = z.infer<typeof CallKeySchema>;
/** A 1:1's number, digits only (it goes into an Open in WhatsApp link). */
export const PhoneDigitsSchema = z.string().regex(/^\d{1,20}$/);

export const ChatKeyParamsSchema = z.object({ chatKey: ChatKeySchema });
export const MsgKeyParamsSchema = z.object({ msgKey: MsgKeySchema });
export const RunIdParamsSchema = z.object({ runId: LifeIdSchema });

// ---------------------------------------------------------------------------
// Chats, messages and calls (as the reader answers them; skipped chats never appear)

export const ChatKindSchema = z.enum(['dm', 'group', 'community']);
export type ChatKind = z.infer<typeof ChatKindSchema>;
export const MessageKindSchema = z.enum([
  'text', 'image', 'video', 'voice', 'document', 'location', 'contact', 'link',
  'sticker', 'gif', 'call', 'system', 'deleted', 'reaction', 'poll', 'other',
]);
export type MessageKind = z.infer<typeof MessageKindSchema>;

/** One chat. `members`: a group's count. */
export const ChatSchema = z.object({
  chatKey: ChatKeySchema,
  name: z.string(),
  kind: ChatKindSchema,
  lastAt: IsoDateSchema,
  unread: count,
  lastFromMe: z.boolean(),
  archived: z.boolean(),
  members: count.optional(),
});
export type Chat = z.infer<typeof ChatSchema>;
/** A chat on the owner's answers over TCP (his phone): a 1:1 with a known number carries it. Never on ctl.sock. */
export const ChatOwnerSchema = ChatSchema.extend({ phone: PhoneDigitsSchema.optional() });
export type ChatOwner = z.infer<typeof ChatOwnerSchema>;

/** A message's file. `local`: WhatsApp has it on this Mac (only then can it be shown). */
export const MessageMediaSchema = z.object({
  kind: MessageKindSchema,
  fileName: z.string().optional(),
  bytes: count.optional(),
  durationS: z.number().nonnegative().optional(),
  local: z.boolean(),
});
export type MessageMedia = z.infer<typeof MessageMediaSchema>;

/**
 * One message. `sender` is the name the owner's contacts or WhatsApp give
 * ("Unknown" when none). `replyTo`: the line it answers, when shown;
 * `replyToMe`: that line is the owner's. A skipped person's line in a shared
 * group has `sender: "[skipped]"`, `skippedSender: true` and no text,
 * caption or media.
 */
export const MessageSchema = z.object({
  msgKey: MsgKeySchema,
  at: IsoDateSchema,
  fromMe: z.boolean(),
  sender: z.string(),
  kind: MessageKindSchema,
  text: z.string().optional(),
  caption: z.string().optional(),
  media: MessageMediaSchema.optional(),
  replyTo: MsgKeySchema.optional(),
  replyToMe: z.literal(true).optional(),
  mentionsMe: z.boolean().optional(),
  skippedSender: z.literal(true).optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const CallViaSchema = z.enum(['whatsapp', 'phone']);
export type CallVia = z.infer<typeof CallViaSchema>;
/** One call. `chatKey`: the 1:1 with that person, when there is one. */
export const CallSchema = z.object({
  callKey: CallKeySchema,
  at: IsoDateSchema,
  who: z.string(),
  chatKey: ChatKeySchema.optional(),
  via: CallViaSchema,
  incoming: z.boolean(),
  missed: z.boolean(),
  video: z.boolean(),
  durationS: z.number().nonnegative(),
});
export type Call = z.infer<typeof CallSchema>;

// ---------------------------------------------------------------------------
// Queries

/** `waiting=true`: only 1:1s whose last message is theirs, within MESSAGES_LIMITS.waitingDays. */
export const MessagesChatsQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  since: IsoDateSchema.optional(),
  waiting: z.enum(['true', 'false']).optional(),
  limit: limit(30, CHATS_MAX),
});
export type MessagesChatsQuery = z.infer<typeof MessagesChatsQuerySchema>;

export const MessagesReadQuerySchema = z.object({
  since: IsoDateSchema.optional(),
  before: IsoDateSchema.optional(),
  limit: limit(50, MESSAGES_LIMITS.readMax),
});
export type MessagesReadQuery = z.infer<typeof MessagesReadQuerySchema>;

export const MessagesReadByNameQuerySchema = MessagesReadQuerySchema.extend({ name: z.string().trim().min(1).max(100) });
export type MessagesReadByNameQuery = z.infer<typeof MessagesReadByNameQuerySchema>;

/** `since` left out: the last 90 days. `chat`: one chat only. */
export const MessagesSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  since: IsoDateSchema.optional(),
  chat: ChatKeySchema.optional(),
  limit: limit(20, MESSAGES_LIMITS.searchMax),
});
export type MessagesSearchQuery = z.infer<typeof MessagesSearchQuerySchema>;

export const MessagesReadsQuerySchema = z.object({ limit: limit(50, READS_MAX) });
export type MessagesReadsQuery = z.infer<typeof MessagesReadsQuerySchema>;

// ---------------------------------------------------------------------------
// Answers

/**
 * The reader: `down` (its socket doesn't answer), `no_access` (macOS refused
 * it WhatsApp's folder), `not_installed` (never set up), `update_needed`
 * (this release changed it: rebuild and re-grant), `unsupported` (this
 * WhatsApp stores chats differently).
 */
export const MessagesReaderStateSchema = z.enum(['ok', 'down', 'no_access', 'not_installed', 'update_needed', 'unsupported']);
export type MessagesReaderState = z.infer<typeof MessagesReaderStateSchema>;

/** Behind no switch, so the phone and the CLI can say what is missing. Counts and times only, never a name. */
export const MessagesStatusSchema = z.object({
  enabled: z.boolean(),
  reader: z.object({ state: MessagesReaderStateSchema, detail: z.string().optional() }),
  whatsapp: z.object({ found: z.boolean(), running: z.boolean(), newestAt: IsoDateSchema.nullable(), schemaOk: z.boolean() }),
  /** The iPhone call log (it needs Full Disk Access on the reader; WhatsApp's files don't). */
  phone: z.object({ readable: z.boolean() }),
  skipped: count,
  /** Skipped chats that name no chat or person on this Mac now (the skip still holds for that person's own ids); left out until the reader has looked. */
  skipUnmatched: count.optional(),
  morning: z.object({ at: HhMmSchema.nullable(), lastRunAt: IsoDateSchema.nullable() }),
});
export type MessagesStatus = z.infer<typeof MessagesStatusSchema>;

export const MessagesChatsResponseSchema = z.object({ chats: z.array(ChatOwnerSchema), total: count });
export type MessagesChatsResponse = z.infer<typeof MessagesChatsResponseSchema>;

/** `more`: older messages exist (ask again with `before`). */
export const MessagesReadResponseSchema = z.object({ chat: ChatOwnerSchema, messages: z.array(MessageSchema), more: z.boolean() });
export type MessagesReadResponse = z.infer<typeof MessagesReadResponseSchema>;

/** A name two or more chats share ("Mom"): the candidates (the newest 20), never one picked; `total`: how many matched. */
export const MessagesAmbiguousSchema = z.object({ ambiguous: z.array(ChatSchema), total: count });
export type MessagesAmbiguous = z.infer<typeof MessagesAmbiguousSchema>;

export const MessagesReadByNameResponseSchema = z.union([MessagesReadResponseSchema, MessagesAmbiguousSchema]);
export type MessagesReadByNameResponse = z.infer<typeof MessagesReadByNameResponseSchema>;

export const MessagesSearchHitSchema = z.object({
  chatKey: ChatKeySchema,
  chatName: z.string(),
  msgKey: MsgKeySchema,
  at: IsoDateSchema,
  fromMe: z.boolean(),
  sender: z.string(),
  snippet: z.string(),
});
export type MessagesSearchHit = z.infer<typeof MessagesSearchHitSchema>;
export const MessagesSearchResponseSchema = z.object({ hits: z.array(MessagesSearchHitSchema) });
export type MessagesSearchResponse = z.infer<typeof MessagesSearchResponseSchema>;

/** A missed call the owner hasn't returned: no later call to that person and no message to them since. */
export const CallToReturnSchema = CallSchema.extend({ returned: z.literal(false) });
export type CallToReturn = z.infer<typeof CallToReturnSchema>;
export const CallsToReturnResponseSchema = z.object({ calls: z.array(CallToReturnSchema) });
export type CallsToReturnResponse = z.infer<typeof CallsToReturnResponseSchema>;

// ---------------------------------------------------------------------------
// The skip list (enforced inside the reader; a phone may add, only the Mac removes)

export const SkipEntrySchema = z.object({ chatKey: ChatKeySchema, name: z.string(), kind: ChatKindSchema, addedAt: IsoDateSchema });
export type SkipEntry = z.infer<typeof SkipEntrySchema>;
export const SkipAddBodySchema = z.strictObject({ chatKey: ChatKeySchema });
export type SkipAddBody = z.infer<typeof SkipAddBodySchema>;
export const MessagesSkipListSchema = z.object({ skip: z.array(SkipEntrySchema) });
export type MessagesSkipList = z.infer<typeof MessagesSkipListSchema>;
/** `forget`: stop looking for the chats not found again (reads start again; skip them by hand at once). */
export const SkipResetBodySchema = z.strictObject({ forget: z.boolean().optional() });
export type SkipResetBody = z.infer<typeof SkipResetBodySchema>;
/**
 * After the reader's salt was lost: `skipped`, the chats found again by the
 * old entries' names and kinds (every chat with that exact name, so a shared
 * name skips each); `left`, the entries not found yet (reads stay refused
 * while any is left); `waiting`, the reader hasn't come back with its new
 * salt yet (ask again).
 */
export const MessagesSkipResetSchema = z.object({
  skipped: z.array(SkipEntrySchema),
  left: z.array(z.object({ name: z.string(), kind: ChatKindSchema })),
  waiting: z.boolean(),
});
export type MessagesSkipReset = z.infer<typeof MessagesSkipResetSchema>;

// ---------------------------------------------------------------------------
// The morning run: its times, reply drafts, run reports and the read log

/** `morningAt` null: the morning run is off. `callbackAt` null: call-backs get a day, no ring. */
export const MessagesPrefsSchema = z.object({
  morningAt: HhMmSchema.nullable().default(null),
  callbackAt: HhMmSchema.nullable().default('11:00'),
});
export type MessagesPrefs = z.infer<typeof MessagesPrefsSchema>;
export const DEFAULT_MESSAGES_PREFS: Readonly<MessagesPrefs> = Object.freeze(MessagesPrefsSchema.parse({}));
/** PATCH /v1/messages/prefs: only the keys sent change (no defaults are filled in). */
export const MessagesPrefsPatchSchema = z.strictObject({
  morningAt: HhMmSchema.nullable().optional(),
  callbackAt: HhMmSchema.nullable().optional(),
});
export type MessagesPrefsPatch = z.infer<typeof MessagesPrefsPatchSchema>;

export const DraftStateSchema = z.enum(['open', 'done', 'dismissed']);
export type DraftState = z.infer<typeof DraftStateSchema>;
/** A suggested reply (never sent by Jantar). `phone`: a 1:1's known number, for Open in WhatsApp; a group has none. */
export const DraftSchema = z.object({
  id: LifeIdSchema,
  runId: LifeIdSchema,
  chatKey: ChatKeySchema,
  chatName: z.string(),
  phone: PhoneDigitsSchema.optional(),
  theyAsked: z.string(),
  draft: z.string(),
  at: IsoDateSchema,
  state: DraftStateSchema,
});
export type Draft = z.infer<typeof DraftSchema>;
export const DraftPatchSchema = z.strictObject({ state: DraftStateSchema });
export type DraftPatch = z.infer<typeof DraftPatchSchema>;

export const MorningTriggerSchema = z.enum(['timer', 'now', 'dry']);
export type MorningTrigger = z.infer<typeof MorningTriggerSchema>;
export const MorningRunStateSchema = z.enum(['ok', 'failed', 'running']);
export type MorningRunState = z.infer<typeof MorningRunStateSchema>;
/**
 * What a dry run would have made (nothing was written): todo titles, who
 * each call-back is for and when it rings, the reply drafts (no number: the
 * CLI reads it over ctl.sock), and each item of the answer left out, by kind,
 * its ref and why (`limit`: Life's open-todo limit or todosPerRun;
 * `life_refused`: Life refused it otherwise, closed or its project gone;
 * `time_not_stated`: its time went, the line states none; `time_passed`: its
 * time had passed when the run applied, so a todo keeps its day only and a
 * call-back rings at the next quarter hour).
 */
export const MorningPreviewSchema = z.object({
  todos: z.array(z.object({ title: z.string() })),
  callbacks: z.array(z.object({ who: z.string(), at: IsoDateSchema.optional() })),
  replies: z.array(z.object({ chatName: z.string(), theyAsked: z.string(), draft: z.string() })),
  dropped: z.array(z.object({
    kind: z.enum(['todo', 'reply', 'callback']),
    ref: z.string(),
    why: z.enum(['unknown_ref', 'duplicate', 'limit', 'life_refused', 'time_not_stated', 'time_passed']),
  })),
});
export type MorningPreview = z.infer<typeof MorningPreviewSchema>;

/**
 * One run's report. `stale`: WhatsApp wasn't running or synced in time, so
 * it read what the Mac had (`newestAt`: WhatsApp's newest message). `why`: a
 * failed run's fixed sentence. `counts`: the chats, new messages and missed
 * calls the model read, what it made (a dry run: would make), and `dropped`
 * the messages left out for the budget; `dropped` (the list): first the
 * missed calls left out, per person (`call`: calls kept and left out), then
 * per chat the messages kept and left out (a 1:1 still waiting with nothing
 * new: of the lines it waits on), most left out first (`chatKey`: whose,
 * so a skip can take its line out); at most 50, `droppedMore`: how many
 * more the list would hold. `summary`: the
 * model's (other people's words: the phone shows it, a push never does).
 * `todoIds`: the todos made (not the call-backs). `preview`: a dry run's
 * answer only, never stored. `waCalls`, `phoneCalls`: false when the run
 * couldn't read WhatsApp's calls or the iPhone call log (refused, or changed
 * by an update), so missed calls from there aren't in it; absent otherwise.
 * `lifeRefused`: Life stopped taking the run's todos and call-backs, at its
 * open-todo limit (`limit`) or for any other refusal (`life_refused`: Life
 * off, the WhatsApp project gone), so the rest weren't made; absent otherwise.
 */
export const MorningRunSchema = z.object({
  id: LifeIdSchema,
  at: IsoDateSchema,
  trigger: MorningTriggerSchema,
  state: MorningRunStateSchema,
  why: z.string().optional(),
  stale: z.boolean(),
  newestAt: IsoDateSchema.nullable(),
  counts: z.object({ chats: count, messages: count, calls: count, todos: count, replies: count, callbacks: count, dropped: count }),
  dropped: z.array(z.object({ chatKey: ChatKeySchema.optional(), chatName: z.string(), kept: count, left: count, call: z.literal(true).optional() })),
  droppedMore: count.optional(),
  todoIds: z.array(LifeIdSchema),
  summary: z.string().max(600).optional(),
  preview: MorningPreviewSchema.optional(),
  waCalls: z.literal(false).optional(),
  phoneCalls: z.literal(false).optional(),
  lifeRefused: z.enum(['limit', 'life_refused']).optional(),
});
export type MorningRun = z.infer<typeof MorningRunSchema>;
/** POST /v1/messages/morning/run. `dryRun`: show what it would make, write nothing, keep the cursor. */
export const MorningRunBodySchema = z.strictObject({ dryRun: z.boolean().optional() });
export type MorningRunBody = z.infer<typeof MorningRunBodySchema>;

/**
 * The Today screen: the newest run (for its line: when, running, failed),
 * open reply drafts and the call-back todos (`at`: when it rings). `made`:
 * the run whose summary, todos and Undo Today shows, the newest that went
 * well and made anything since the newest timer run started (any, before the
 * first), so a later Run now that made nothing, or one that failed, never
 * hides the morning's; null when there is none.
 */
export const MessagesTodayResponseSchema = z.object({
  run: MorningRunSchema.nullable(),
  made: MorningRunSchema.nullable(),
  drafts: z.array(DraftSchema),
  callbacks: z.array(z.object({ todoId: LifeIdSchema, who: z.string(), at: IsoDateSchema.optional() })),
});
export type MessagesTodayResponse = z.infer<typeof MessagesTodayResponseSchema>;

export const ReadViaSchema = z.enum(['mcp', 'cli', 'phone', 'morning']);
export type ReadVia = z.infer<typeof ReadViaSchema>;
/** One read: who read what and how much, ids and counts only. `pid`, `folder` (a basename): the MCP caller's, advisory. */
export const ReadLogEntrySchema = z.object({
  at: IsoDateSchema,
  via: ReadViaSchema,
  pid: z.number().int().positive().optional(),
  folder: z.string().max(255).optional(),
  op: z.string().max(32),
  chatKey: ChatKeySchema.optional(),
  count,
});
export type ReadLogEntry = z.infer<typeof ReadLogEntrySchema>;
export const MessagesReadsResponseSchema = z.object({ reads: z.array(ReadLogEntrySchema) });
export type MessagesReadsResponse = z.infer<typeof MessagesReadsResponseSchema>;

const MSG_REF = /^m\d{1,5}$/;
/**
 * The morning run's answer from Claude, checked before anything is made. Refs
 * are the input's short ids (`m17` a message, `c3` a chat, `k2` a call); an
 * item citing one that wasn't in the batch is dropped by the daemon.
 */
export const MorningAnswerSchema = z.strictObject({
  summary: z.string().max(600),
  todos: z.array(z.strictObject({
    title: TodoTitleSchema,
    notes: z.string().max(1000).optional(),
    due_day: DayKeySchema.optional(),
    due_time: HhMmSchema.optional(),
    priority: TodoPrioritySchema.optional(),
    ref: z.string().regex(MSG_REF),
  })).max(MESSAGES_LIMITS.todosPerRun),
  replies: z.array(z.strictObject({
    chat: z.string().regex(/^c\d{1,4}$/),
    ref: z.string().regex(MSG_REF),
    they_asked: z.string().max(300),
    draft: z.string().min(1).max(1000),
  })).max(MORNING_REPLIES_MAX),
  callbacks: z.array(z.strictObject({
    ref: z.string().regex(/^(k|m)\d{1,5}$/),
    who: z.string().max(80),
    why: z.string().max(200),
    day_stated: DayKeySchema.optional(),
    time_stated: HhMmSchema.optional(),
  })).max(MORNING_CALLBACKS_MAX),
});
export type MorningAnswer = z.infer<typeof MorningAnswerSchema>;

// ---------------------------------------------------------------------------
// Route table (owner-only: control scope, his host, never under /v1/p/)

/**
 * On ctl.sock, `jantar mcp` names its caller for the read log (advisory):
 * `via: mcp`, the Claude session's pid, and its folder percent-encoded
 * (encodeURIComponent; the log keeps the basename). Over TCP they are never
 * read: a phone is the phone.
 */
export const MESSAGES_CALLER_HEADERS = { via: 'x-jantar-via', pid: 'x-jantar-pid', folder: 'x-jantar-folder' } as const;

function route<T extends RouteDef>(r: T): T {
  return r;
}

/**
 * On ctl.sock only what the CLI and `jantar mcp` need: the status, reads,
 * search, media, calls, the skip list and Run now. Every read is logged
 * (ids and counts only). Removing a skip widens what Jantar reads, so its
 * handler refuses it over TCP: the Mac's CLI only; so is the reset after a
 * lost salt.
 */
export const MESSAGES_ROUTES = {
  messagesStatus: route({
    method: 'GET', path: '/v1/messages/status', scope: 'control', phase: 'v0.15', ctl: true,
    response: MessagesStatusSchema,
    summary: "Messages on or off, the reader's state, WhatsApp found, running and readable, the call log's access, skipped chats and the morning run.",
  }),
  messagesChats: route({
    method: 'GET', path: '/v1/messages/chats', scope: 'control', phase: 'v0.15', ctl: true, feature: 'messages',
    query: MessagesChatsQuerySchema, response: MessagesChatsResponseSchema,
    summary: 'Chats, newest first: by name, since a time, or only those waiting on the owner.',
  }),
  messagesRead: route({
    method: 'GET', path: '/v1/messages/chats/:chatKey', scope: 'control', phase: 'v0.15', ctl: true, feature: 'messages',
    params: ChatKeyParamsSchema, query: MessagesReadQuerySchema, response: MessagesReadResponseSchema,
    summary: "One chat's messages, since or before a time.",
  }),
  messagesReadByName: route({
    method: 'GET', path: '/v1/messages/by-name', scope: 'control', phase: 'v0.15', ctl: true, feature: 'messages',
    query: MessagesReadByNameQuerySchema, response: MessagesReadByNameResponseSchema,
    summary: 'One chat by its name; a name two chats share answers the candidates, never one picked.',
  }),
  messagesSearch: route({
    method: 'GET', path: '/v1/messages/search', scope: 'control', phase: 'v0.15', ctl: true, feature: 'messages',
    query: MessagesSearchQuerySchema, response: MessagesSearchResponseSchema,
    summary: 'Messages with these words (the last 90 days unless since says otherwise), in one chat or all.',
  }),
  messagesMedia: route({
    method: 'GET', path: '/v1/messages/media/:msgKey', scope: 'control', phase: 'v0.15', ctl: true, feature: 'messages', rawResponse: true,
    params: MsgKeyParamsSchema,
    summary: "A message's image, shrunk and stripped of metadata (image/jpeg); a document or a video is 415 not_an_image.",
  }),
  messagesCalls: route({
    method: 'GET', path: '/v1/messages/calls', scope: 'control', phase: 'v0.15', ctl: true, feature: 'messages',
    response: CallsToReturnResponseSchema,
    summary: "Missed WhatsApp and phone calls the owner hasn't returned by a call or a message.",
  }),
  messagesSkipList: route({
    method: 'GET', path: '/v1/messages/skip', scope: 'control', phase: 'v0.15', ctl: true, feature: 'messages',
    response: MessagesSkipListSchema,
    summary: 'The chats Messages never reads.',
  }),
  messagesSkipAdd: route({
    method: 'POST', path: '/v1/messages/skip', scope: 'control', phase: 'v0.15', ctl: true, feature: 'messages',
    body: SkipAddBodySchema, response: OkReplySchema,
    summary: 'Skip a chat: a 1:1 skips that person everywhere (their chats, calls and lines in groups), a group the group.',
  }),
  messagesSkipRemove: route({
    method: 'DELETE', path: '/v1/messages/skip/:chatKey', scope: 'control', phase: 'v0.15', ctl: true, feature: 'messages',
    params: ChatKeyParamsSchema, response: OkReplySchema,
    summary: 'Read a skipped chat again (the Mac only: refused over TCP).',
  }),
  messagesSkipReset: route({
    method: 'POST', path: '/v1/messages/skip/reset', scope: 'control', phase: 'v0.15', ctl: true, feature: 'messages',
    body: SkipResetBodySchema, response: MessagesSkipResetSchema,
    summary: "After the reader's salt was lost: drop the old keys and skip the same chats again by name (the Mac only: refused over TCP).",
  }),
  messagesToday: route({
    method: 'GET', path: '/v1/messages/today', scope: 'control', phase: 'v0.15', ctl: false, feature: 'messages',
    response: MessagesTodayResponseSchema,
    summary: 'The newest morning run, its reply drafts and the call-backs.',
  }),
  messagesDraftUpdate: route({
    method: 'PATCH', path: '/v1/messages/drafts/:id', scope: 'control', phase: 'v0.15', ctl: false, feature: 'messages',
    params: LifeIdParamsSchema, body: DraftPatchSchema, response: OkReplySchema,
    summary: 'Mark a reply draft done or dismissed, or open it again.',
  }),
  messagesMorningRun: route({
    method: 'POST', path: '/v1/messages/morning/run', scope: 'control', phase: 'v0.15', ctl: true, feature: 'messages',
    body: MorningRunBodySchema, response: MorningRunSchema,
    summary: 'Run the morning pass now (one at a time; a dry run writes nothing).',
  }),
  messagesMorningUndo: route({
    method: 'POST', path: '/v1/messages/morning/:runId/undo', scope: 'control', phase: 'v0.15', ctl: false, feature: 'messages',
    params: RunIdParamsSchema, response: OkReplySchema,
    summary: "Undo a morning run: its open todos go and its drafts are dismissed.",
  }),
  messagesPrefsGet: route({
    method: 'GET', path: '/v1/messages/prefs', scope: 'control', phase: 'v0.15', ctl: false, feature: 'messages',
    response: MessagesPrefsSchema,
    summary: 'The morning time and the call-back time.',
  }),
  messagesPrefsPatch: route({
    method: 'PATCH', path: '/v1/messages/prefs', scope: 'control', phase: 'v0.15', ctl: false, feature: 'messages',
    body: MessagesPrefsPatchSchema, response: OkReplySchema,
    summary: 'Change the morning time or the call-back time (null turns it off).',
  }),
  messagesReads: route({
    method: 'GET', path: '/v1/messages/reads', scope: 'control', phase: 'v0.15', ctl: false, feature: 'messages',
    query: MessagesReadsQuerySchema, response: MessagesReadsResponseSchema,
    summary: 'The read log, newest first: which caller read which chat, when and how many messages.',
  }),
} as const satisfies Record<string, RouteDef>;
export type MessagesRouteName = keyof typeof MESSAGES_ROUTES;
