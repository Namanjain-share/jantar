/**
 * v0.5.3 Ask: a chat page that suggests Life items. The phone sends plain
 * words; the Mac makes one isolated headless Claude run and turns its strict
 * JSON into cards; nothing is added until the user taps Add.
 *
 * Two forms of an action:
 * - The model form is what Claude writes; only the daemon reads it
 *   (daemon ask/answer.ts), and every field is checked there.
 * - The card form (AskAction, here) is what a turn keeps, the phone shows
 *   and an Edit sends back. It reuses Life's field schemas, so an Add never
 *   sends what Life would refuse on shape. A `show` card is read-only: the
 *   phone fills it from `GET /v1/life/today`, and the turn holds only what.
 *
 * Turns live in the daemon's memory, per device (ASK_TURNS_KEPT, ASK_KEEP_DAYS),
 * and leave it only through the owner's `GET /v1/ask`. Every write reply is
 * `{ id }` or `{ ok: true }`: no model or user text.
 */
import { z } from 'zod';
import {
  AmountSchema,
  CategorySchema,
  DayKeySchema,
  DueSchema,
  FoodNameSchema,
  KcalSchema,
  LifeIdSchema,
  LongNotesSchema,
  MoneyKindSchema,
  MoneyNoteSchema,
  PostKindSchema,
  PostPlatformSchema,
  PostTitleSchema,
  PostWhereSchema,
  TodoPrioritySchema,
  TodoTitleSchema,
} from './life.js';
import { IntelDepthSchema, IntelIdSchema } from './intel.js';
import { IsoDateSchema } from './models.js';

/** What the phone may send, in characters. */
export const ASK_TEXT_MAX = 1000;
/** A reply's length at most, the "…" of a cut reply included. */
export const ASK_REPLY_MAX = 500;
/** Cards in one answer at most (every action after the 10th is dropped). */
export const ASK_CARDS_MAX = 10;
/** Turns kept per device, in the daemon's memory only (an older one too while an item it added can still be undone). */
export const ASK_TURNS_KEPT = 30;
/** No turn is kept longer than this. */
export const ASK_KEEP_DAYS = 7;
/** Add and Undo work on a turn at most this old. */
export const ASK_APPLY_WITHIN_MS = 24 * 60 * 60_000;

/** What a show card shows, filled on the phone: due todos, calories against the target, today's medicines. */
export const AskShowWhatSchema = z.enum(['due', 'calories', 'meds']);
export type AskShowWhat = z.infer<typeof AskShowWhatSchema>;

/** A todo; with a time it is a reminder. `repeat` needs `due` (the daemon checks it). */
export const AskTodoActionSchema = z.strictObject({
  type: z.literal('todo'),
  title: TodoTitleSchema,
  notes: LongNotesSchema.optional(),
  due: DueSchema.optional(),
  priority: TodoPrioritySchema.optional(),
  projectId: LifeIdSchema.optional(),
  repeat: z.enum(['daily', 'weekly', 'monthly']).optional(),
});
export type AskTodoAction = z.infer<typeof AskTodoActionSchema>;

export const AskFoodActionSchema = z.strictObject({ type: z.literal('food'), day: DayKeySchema, name: FoodNameSchema, kcal: KcalSchema });
export type AskFoodAction = z.infer<typeof AskFoodActionSchema>;

/** `amount` in hundredths of the currency unit, as Life keeps money (₹250 is 25000). */
export const AskMoneyActionSchema = z.strictObject({
  type: z.literal('money'),
  kind: MoneyKindSchema,
  amount: AmountSchema,
  category: CategorySchema,
  note: MoneyNoteSchema.optional(),
  day: DayKeySchema,
});
export type AskMoneyAction = z.infer<typeof AskMoneyActionSchema>;

/**
 * v0.7: a post to plan (Posts). Ask plans, the user writes: no text, notes
 * or link, and it is always added as an idea. `where` and `title` are one
 * line, as Posts keeps them. With a time it rings like a todo.
 */
export const AskPostActionSchema = z.strictObject({
  type: z.literal('post'),
  platform: PostPlatformSchema,
  kind: PostKindSchema,
  where: PostWhereSchema.optional(),
  title: PostTitleSchema.optional(),
  due: DueSchema.optional(),
});
export type AskPostAction = z.infer<typeof AskPostActionSchema>;

export const AskShowActionSchema = z.strictObject({ type: z.literal('show'), what: AskShowWhatSchema });
export type AskShowAction = z.infer<typeof AskShowActionSchema>;

/**
 * v0.8: save a link to Intel and read it (Add post). Only the daemon's
 * typed fast path makes one ("save this: <link>", or a message that is just
 * a link, while reading links is on); Claude never proposes a save (a `save`
 * in its answer is dropped). Add saves and queues the read; the card's ref
 * is then the Intel item's id, and Undo deletes that item.
 */
export const AskSaveActionSchema = z.strictObject({
  type: z.literal('save'),
  url: z.url({ protocol: /^https?$/ }).max(2000),
  depth: IntelDepthSchema.optional(),
});
export type AskSaveAction = z.infer<typeof AskSaveActionSchema>;

/** What Add may apply (an Edit sends one of these, of the card's own type). */
export const AskWriteActionSchema = z.discriminatedUnion('type', [AskTodoActionSchema, AskFoodActionSchema, AskMoneyActionSchema, AskPostActionSchema, AskSaveActionSchema]);
export type AskWriteAction = z.infer<typeof AskWriteActionSchema>;
export const AskActionSchema = z.discriminatedUnion('type', [AskTodoActionSchema, AskFoodActionSchema, AskMoneyActionSchema, AskPostActionSchema, AskSaveActionSchema, AskShowActionSchema]);
export type AskAction = z.infer<typeof AskActionSchema>;

/**
 * Why a card says more (the phone words it): a one-off reminder or a timed
 * post whose time has passed (today, or a day before today: it won't ring),
 * a reminder asked for and no time given, a project name with no project.
 */
export const AskFlagSchema = z.enum(['past_time', 'no_time', 'no_project']);
export type AskFlag = z.infer<typeof AskFlagSchema>;
/** Show cards stay 'proposed'. */
export const AskCardStateSchema = z.enum(['proposed', 'added', 'skipped']);
export type AskCardState = z.infer<typeof AskCardStateSchema>;

export const AskCardSchema = z.object({
  action: AskActionSchema,
  state: AskCardStateSchema,
  /** The item Add made (Undo deletes it); v0.8: an Intel item's id for a save card. */
  ref: LifeIdSchema.or(IntelIdSchema).optional(),
  flag: AskFlagSchema.optional(),
});
export type AskCard = z.infer<typeof AskCardSchema>;

export const AskTurnStateSchema = z.enum(['queued', 'running', 'done', 'failed', 'cancelled']);
export type AskTurnState = z.infer<typeof AskTurnStateSchema>;

export const AskTurnSchema = z.object({
  id: LifeIdSchema,
  at: IsoDateSchema,
  text: z.string().max(ASK_TEXT_MAX),
  state: AskTurnStateSchema,
  reply: z.string().max(ASK_REPLY_MAX).optional(),
  /** A fixed daemon sentence (failed, cancelled), never model or user text. */
  reason: z.string().optional(),
  cards: z.array(AskCardSchema).max(ASK_CARDS_MAX),
  /** Suggestions left out (an unknown type, a bad value, a part that is off, past the 10th). */
  dropped: z.number().int().nonnegative(),
});
export type AskTurn = z.infer<typeof AskTurnSchema>;

/** GET /v1/ask: this device's turns, oldest first; `reason` (a fixed sentence) when Ask can't run. The only reply with text. */
export const AskListSchema = z.object({ ready: z.boolean(), reason: z.string().optional(), turns: z.array(AskTurnSchema) });
export type AskList = z.infer<typeof AskListSchema>;

/** POST /v1/ask (202 `{ id }`). */
export const AskSendBodySchema = z.strictObject({ text: z.string().trim().min(1).max(ASK_TEXT_MAX) });
export type AskSendBody = z.infer<typeof AskSendBodySchema>;
/** POST /v1/ask/turns/:id/actions/:n: `edit` is the card's action as changed on the phone (same type). */
export const AskAddBodySchema = z.strictObject({ edit: AskWriteActionSchema.optional() });
export type AskAddBody = z.infer<typeof AskAddBodySchema>;
export const AskTurnParamsSchema = z.object({ id: LifeIdSchema });
export type AskTurnParams = z.infer<typeof AskTurnParamsSchema>;
export const AskCardParamsSchema = z.object({ id: LifeIdSchema, n: z.coerce.number().int().min(0).max(ASK_CARDS_MAX - 1) });
export type AskCardParams = z.infer<typeof AskCardParamsSchema>;
