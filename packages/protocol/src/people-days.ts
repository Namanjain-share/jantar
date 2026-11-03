/**
 * v0.11 People, P2: the shapes of her days (spec 3, 4, 6, 9.1.5): the day
 * plan and its steps, check-betweens and templates, the evening review,
 * alerts both ways, her status, the sleep log and the journal, her P2
 * preferences and his preferences for pushes about her.
 *
 * Part of the `@jantar/protocol/people` subpath (people.ts re-exports it);
 * never in the package index. As for every Life row, `space` and `by` come
 * from a row's columns and are never accepted in a body (strict schemas).
 */
import { z } from 'zod';
import { IsoDateSchema } from './models.js';
import { DayKeySchema, HhMmSchema, LifeIdSchema } from './life.js';
import {
  ALERT_CAPS_DEFAULT,
  ALERT_CAPS_RANGE,
  ALERT_KIND_NAMES,
  ALERT_TEXT_MAX,
  EMOTION_NAMES,
  JOURNAL_COMMENT_MAX,
  JOURNAL_LINE_MAX,
  JOURNAL_TEXT_MAX,
  PLAN_BETWEEN_MAX,
  PLAN_PUSH_AT_DEFAULT,
  PLAN_STEPS_MAX,
  REVIEW_AT_DEFAULT,
  REVIEW_AT_RANGE,
  STATUS_LINE_MAX,
  isCalendarDay,
  type AlertKind,
  type Emotion,
} from './people-core.js';

// ---------------------------------------------------------------------------
// Ids, spaces, locked tiles

export const SpaceSchema = z.string().regex(/^(|[0-9A-HJKMNP-TV-Z]{26}|s:[0-9A-HJKMNP-TV-Z]{26})$/);
export type Space = z.infer<typeof SpaceSchema>;
export const LockedSchema = z.object({ locked: z.literal(true) });
export type Locked = z.infer<typeof LockedSchema>;
/** A plan step's or check-between's id: short, unique within its plan. */
export const StepIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{10}$/);
/**
 * Every `:day` and `:night` path parameter of the People routes, hers and his (one schema; the arch test
 * pins each route to it): a day key that is also a date on the calendar, so 2026-02-30 is a 400 before any
 * handler runs, never a row.
 */
export const PeopleDaySchema = DayKeySchema.refine(isCalendarDay, { message: 'not a date on the calendar' });

// ---------------------------------------------------------------------------
// Preferences (hers, and his for pushes about her)

export const QuietSchema = z.strictObject({
  from: HhMmSchema,
  to: HhMmSchema,
  /** Weekdays (0 Sunday … 6 Saturday) a window starts on; absent: every day. */
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
});
export type Quiet = z.infer<typeof QuietSchema>;

const cap = (r: readonly [number, number]) => z.number().int().min(r[0]).max(r[1]);
/** The caps on alerts sent TO a person (C29, D18): hers on his, his on hers. */
export const AlertCapsSchema = z.strictObject({
  hour: cap(ALERT_CAPS_RANGE.hour),
  day: cap(ALERT_CAPS_RANGE.day),
  urgentDay: cap(ALERT_CAPS_RANGE.urgentDay),
  nudgeGapMin: z.union([z.literal(30), z.literal(60)]),
  nudgeDay: cap(ALERT_CAPS_RANGE.nudgeDay),
});
export type AlertCapsValue = z.infer<typeof AlertCapsSchema>;

/** Her per-kind ring switches (C33): she controls them; he sees them on Sharing. */
export const RingsSchema = z.object({
  steps: z.boolean().default(true),
  between: z.boolean().default(true),
  planChanges: z.boolean().default(true),
});

/** P3 (C17): her chat thread's keep, in days. */
export const ChatKeepDaysSchema = z.union([z.literal(1), z.literal(7), z.literal(30)]);

export const ReviewAtSchema = HhMmSchema.refine((v) => v >= REVIEW_AT_RANGE[0] && v <= REVIEW_AT_RANGE[1], { message: 'between 17:00 and 23:30' });

/** Her P2 preferences (spec 3.8). Each has a default, so a P1 person row parses with them. */
export const PersonP2PrefsShape = {
  quiet: QuietSchema.optional(),
  urgentBreaksQuiet: z.boolean().default(true),
  planPushAt: HhMmSchema.default(PLAN_PUSH_AT_DEFAULT),
  reviewAt: ReviewAtSchema.default(REVIEW_AT_DEFAULT),
  /** O10: an open night holds his alerts like quiet hours. */
  sleepHolds: z.boolean().default(true),
  /** O3: hides the journal streak on both sides (one DTO). */
  hideStreaks: z.boolean().default(false),
  alertCaps: AlertCapsSchema.default({ ...ALERT_CAPS_DEFAULT }),
  rings: RingsSchema.prefault({}),
  /** P3 (C17): how long her chat thread is kept; his `ask.keepDays` never applies to it. */
  chatKeepDays: ChatKeepDaysSchema.default(30),
};
export const PersonP2PrefsPatchShape = {
  quiet: QuietSchema.nullable().optional(),
  urgentBreaksQuiet: z.boolean().optional(),
  planPushAt: HhMmSchema.optional(),
  reviewAt: ReviewAtSchema.optional(),
  sleepHolds: z.boolean().optional(),
  hideStreaks: z.boolean().optional(),
  alertCaps: AlertCapsSchema.optional(),
  rings: z.strictObject({ steps: z.boolean().optional(), between: z.boolean().optional(), planChanges: z.boolean().optional() }).optional(),
  chatKeepDays: ChatKeepDaysSchema.optional(),
};

/** His preferences for pushes about her (spec 6.3 "To him", Q16), kept in life.db. */
export const OwnerPeoplePrefsSchema = z.object({
  quiet: QuietSchema.optional(),
  urgentBreaksQuiet: z.boolean().default(true),
  /** The caps on alerts she sends to him. */
  alertCaps: AlertCapsSchema.default({ ...ALERT_CAPS_DEFAULT }),
  muteUntil: IsoDateSchema.nullable().default(null),
  /** The opt-in day summary (absent: off). She sees it exists, under Sharing. */
  summaryAt: HhMmSchema.optional(),
  /** "Asha sent her evening review" (on by default). */
  reviewPush: z.boolean().default(true),
});
export type OwnerPeoplePrefs = z.infer<typeof OwnerPeoplePrefsSchema>;
export const OwnerPeoplePrefsPatchSchema = z.strictObject({
  quiet: QuietSchema.nullable().optional(),
  urgentBreaksQuiet: z.boolean().optional(),
  alertCaps: AlertCapsSchema.optional(),
  muteUntil: IsoDateSchema.nullable().optional(),
  summaryAt: HhMmSchema.nullable().optional(),
  reviewPush: z.boolean().optional(),
});
export type OwnerPeoplePrefsPatch = z.infer<typeof OwnerPeoplePrefsPatchSchema>;
export const OwnerPeoplePrefsReplySchema = z.object({ prefs: OwnerPeoplePrefsSchema });

// ---------------------------------------------------------------------------
// Status (spec 3.7)

export const StatusLevelSchema = z.enum(['ok', 'low', 'need_space']);
export const PersonStatusSchema = z.object({
  level: StatusLevelSchema,
  line: z.string().max(STATUS_LINE_MAX).optional(),
  at: IsoDateSchema,
  until: IsoDateSchema,
});
export type PersonStatus = z.infer<typeof PersonStatusSchema>;
export const PersonStatusBodySchema = z.strictObject({
  level: StatusLevelSchema,
  line: z.string().trim().max(STATUS_LINE_MAX).optional(),
  hours: z.number().int().min(1).max(24).optional(),
});
export type PersonStatusBody = z.infer<typeof PersonStatusBodySchema>;

// ---------------------------------------------------------------------------
// The day plan (spec 3.1, 3.2, 3.6, 4.3)

export const StepAskSchema = z.enum(['none', 'ack', 'report', 'checkin']);
export type StepAsk = z.infer<typeof StepAskSchema>;
export const StepStatusSchema = z.enum(['todo', 'doing', 'done', 'skipped', 'excused']);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const StepCheckinSchema = z.object({
  mood: z.number().int().min(1).max(5),
  energy: z.number().int().min(1).max(5),
  line: z.string().max(200).optional(),
  need: z.string().max(200).optional(),
  at: IsoDateSchema,
});

export const PlanStepSchema = z.object({
  id: StepIdSchema,
  title: z.string().trim().min(1).max(120),
  at: HhMmSchema.optional(),
  minutes: z.number().int().min(5).max(600).optional(),
  notes: z.string().max(500).optional(),
  ask: StepAskSchema.default('none'),
  ring: z.boolean().default(true),
  /** She switched ringing off on this step for herself (it doesn't change the plan). */
  mutedByHer: z.boolean().optional(),
  focus: z.boolean().default(false),
  /** She marked it focus on her side (C32). */
  focusByHer: z.boolean().optional(),
  /** '' the owner or her person id: daemon-set. */
  by: SpaceSchema,
  /** "Tell me if not done by": his, shown to her, never sent to her. */
  followUp: HhMmSchema.optional(),
  status: StepStatusSchema.default('todo'),
  startedAt: IsoDateSchema.optional(),
  doneAt: IsoDateSchema.optional(),
  ackAt: IsoDateSchema.optional(),
  report: z.string().max(500).optional(),
  skip: z.object({ at: IsoDateSchema, reason: z.string().max(200).optional() }).optional(),
  checkin: StepCheckinSchema.optional(),
  /** Carried here from another day (spec 3.10). */
  carriedFrom: z.object({ day: DayKeySchema, stepId: z.string() }).optional(),
  /** Carried from here to a later day: the step reads "moved". */
  carriedTo: DayKeySchema.optional(),
  editedBy: SpaceSchema.optional(),
  editedAt: IsoDateSchema.optional(),
  /** The status a rough day excused it from (its Undo puts it back). */
  wasStatus: StepStatusSchema.optional(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const BetweenSchema = z.object({
  id: StepIdSchema,
  title: z.string().trim().min(1).max(80),
  every: z.number().int().min(30).max(480),
  from: HhMmSchema,
  to: HhMmSchema,
  ticks: z.array(z.object({ slot: HhMmSchema, doneAt: IsoDateSchema.optional() })).max(16),
  by: SpaceSchema,
});
export type Between = z.infer<typeof BetweenSchema>;

export const ReviewOutcomeSchema = z.enum(['done', 'skipped', 'excused', 'moved', 'missed', 'gone']);
export const ReviewItemSchema = z.object({
  kind: z.enum(['step', 'todo', 'between']),
  ref: z.string(),
  title: z.string().max(120),
  by: SpaceSchema,
  outcome: ReviewOutcomeSchema.optional(),
  doneAt: IsoDateSchema.optional(),
  movedTo: DayKeySchema.optional(),
  reason: z.string().max(200).optional(),
  report: z.string().max(500).optional(),
  ticks: z.object({ done: z.number().int(), of: z.number().int() }).optional(),
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;
export const ReviewCountsSchema = z.object({
  done: z.number().int(),
  skipped: z.number().int(),
  excused: z.number().int(),
  moved: z.number().int(),
  missed: z.number().int(),
  gone: z.number().int(),
});
export const ReviewSchema = z.object({
  at: IsoDateSchema,
  /** Closed at 12:00 the next day with no note (nothing pushed, nothing counted). */
  auto: z.boolean().default(false),
  outcomes: z.array(ReviewItemSchema).max(120),
  note: z.string().max(1000).optional(),
  mood: z.number().int().min(1).max(5).optional(),
});
export type Review = z.infer<typeof ReviewSchema>;

/** A todo of hers that left the day it was due (moved on, or deleted): kept for that day's review. */
export const DayTodoNoteSchema = z.object({
  id: z.string(),
  title: z.string().max(120),
  by: SpaceSchema,
  outcome: z.enum(['moved', 'gone']),
  to: DayKeySchema.optional(),
});

export const DayPlanSchema = z.object({
  id: LifeIdSchema,
  day: DayKeySchema,
  /** The structure revision: his and her structural edits bump it; ticks and reports don't. */
  srev: z.number().int().min(0),
  note: z.string().max(200).optional(),
  steps: z.array(PlanStepSchema).max(PLAN_STEPS_MAX * 2),
  between: z.array(BetweenSchema).max(PLAN_BETWEEN_MAX),
  templateId: LifeIdSchema.optional(),
  templateName: z.string().max(40).optional(),
  sentAt: IsoDateSchema.optional(),
  /** His last change she hasn't been pushed yet, and when he last changed it. */
  changedAt: IsoDateSchema.optional(),
  /** "Seen": her first open after it was sent or changed. */
  seenAt: IsoDateSchema.optional(),
  ackAt: IsoDateSchema.optional(),
  /** A rough day (hers): the status it replaced comes back with its Undo. */
  rough: z.object({ at: IsoDateSchema, note: z.string().max(200).optional(), prevStatus: PersonStatusSchema.nullable().optional() }).optional(),
  /** His changes since the last push to her, coalesced into one ("Sam changed today's plan: 2 steps moved, 1 added"). */
  pending: z.object({ added: z.number().int(), removed: z.number().int(), moved: z.number().int(), edited: z.number().int() }).optional(),
  /** The plan push was skipped for a first step ringing within 15 minutes: that ring says "Today's plan: N steps". */
  firstRingNote: z.boolean().optional(),
  sentSteps: z.array(z.object({ id: z.string(), title: z.string().max(120), by: SpaceSchema })).max(60).optional(),
  todoNotes: z.array(DayTodoNoteSchema).max(60).optional(),
  review: ReviewSchema.optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type DayPlan = z.infer<typeof DayPlanSchema>;

/** A check-between's slot as Today shows it: done, open (tickable now), past (its window went by), later (not yet due). */
export const SlotSchema = z.object({ slot: HhMmSchema, state: z.enum(['done', 'open', 'past', 'later']) });
/** The plan as either side reads it, with what is derived on read: Now, Next, late steps, focus and the slots. */
export const PlanViewSchema = z.object({
  day: DayKeySchema,
  plan: DayPlanSchema.nullable(),
  now: StepIdSchema.nullable(),
  next: StepIdSchema.nullable(),
  late: z.array(StepIdSchema),
  focus: z.object({ stepId: StepIdSchema, title: z.string(), until: IsoDateSchema }).nullable(),
  slots: z.record(z.string(), z.array(SlotSchema)),
  counts: z.object({ done: z.number().int(), total: z.number().int() }),
  /**
   * His save's answer only (put, apply): when the plan push to her is lined up, so his editor can say
   * "Saved. Asha gets it Wed 4 Nov at 07:00" instead of "Sent" for a plan that hasn't gone yet.
   */
  sendsAt: IsoDateSchema.optional(),
});
export type PlanView = z.infer<typeof PlanViewSchema>;

// --- bodies (hers)

export const StepBodySchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  at: HhMmSchema.optional(),
  minutes: z.number().int().min(5).max(600).optional(),
  notes: z.string().trim().max(500).optional(),
  ask: StepAskSchema.optional(),
  ring: z.boolean().optional(),
  focus: z.boolean().optional(),
});
export type StepBody = z.infer<typeof StepBodySchema>;
/** Her edit of a step. On his steps only `ring` and `focus` (C32), for herself. */
export const StepPatchSchema = z.strictObject({
  title: z.string().trim().min(1).max(120).optional(),
  at: HhMmSchema.nullable().optional(),
  minutes: z.number().int().min(5).max(600).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  ask: StepAskSchema.optional(),
  ring: z.boolean().optional(),
  focus: z.boolean().optional(),
});
export type StepPatch = z.infer<typeof StepPatchSchema>;
export const StepStateBodySchema = z.strictObject({
  to: z.enum(['todo', 'doing', 'done', 'skipped']),
  report: z.string().trim().max(500).optional(),
  reason: z.string().trim().max(200).optional(),
});
export type StepStateBody = z.infer<typeof StepStateBodySchema>;
export const StepCheckinBodySchema = z.strictObject({
  mood: z.number().int().min(1).max(5),
  energy: z.number().int().min(1).max(5),
  line: z.string().trim().max(200).optional(),
  need: z.string().trim().max(200).optional(),
});
export type StepCheckinBody = z.infer<typeof StepCheckinBodySchema>;
export const StepAskBodySchema = z.strictObject({ note: z.string().trim().min(1).max(200) });
export const StepCarryBodySchema = z.strictObject({ to: DayKeySchema });
export const BetweenTickBodySchema = z.strictObject({ slot: HhMmSchema, done: z.boolean() });
export const RoughBodySchema = z.strictObject({ note: z.string().trim().max(200).optional() });
export const ReviewSendBodySchema = z.strictObject({
  carry: z.array(z.string()).max(30).optional(),
  askCarry: z.array(z.string()).max(30).optional(),
  note: z.string().trim().max(1000).optional(),
  mood: z.number().int().min(1).max(5).optional(),
  toJournal: z.boolean().optional(),
});
export type ReviewSendBody = z.infer<typeof ReviewSendBodySchema>;

// --- bodies (his)

export const PlanPutStepSchema = z.strictObject({
  id: z.string().max(26).optional(),
  title: z.string().trim().min(1).max(120),
  at: HhMmSchema.optional(),
  minutes: z.number().int().min(5).max(600).optional(),
  notes: z.string().trim().max(500).optional(),
  ask: StepAskSchema.optional(),
  ring: z.boolean().optional(),
  focus: z.boolean().optional(),
  followUp: HhMmSchema.optional(),
});
export type PlanPutStep = z.infer<typeof PlanPutStepSchema>;
export const PlanPutBetweenSchema = z.strictObject({
  id: z.string().max(26).optional(),
  title: z.string().trim().min(1).max(80),
  every: z.number().int().min(30).max(480),
  from: HhMmSchema,
  to: HhMmSchema,
});
export const PlanPutBodySchema = z.strictObject({
  /** The revision his editor started from (0: a new plan). A stale one is 409. */
  srev: z.number().int().min(0),
  note: z.string().trim().max(200).nullable().optional(),
  steps: z.array(PlanPutStepSchema).max(PLAN_STEPS_MAX),
  between: z.array(PlanPutBetweenSchema).max(PLAN_BETWEEN_MAX),
  /** now: push at once; atPushTime: at her plan push time; quiet: save without a push. Default: at once for today after her push time, else at it. */
  send: z.enum(['now', 'atPushTime', 'quiet']).optional(),
});
export type PlanPutBody = z.infer<typeof PlanPutBodySchema>;
export const PlanApplyBodySchema = z.strictObject({
  templateId: LifeIdSchema,
  mode: z.enum(['replace', 'append']),
  srev: z.number().int().min(0),
});
export type PlanApplyBody = z.infer<typeof PlanApplyBodySchema>;
export const ReviewCarryBodySchema = z.strictObject({ steps: z.array(z.string()).min(1).max(30), to: DayKeySchema.optional() });

export const TemplateStepSchema = z.object({
  title: z.string().trim().min(1).max(120),
  at: HhMmSchema.optional(),
  minutes: z.number().int().min(5).max(600).optional(),
  notes: z.string().max(500).optional(),
  ask: StepAskSchema.default('none'),
  ring: z.boolean().default(true),
  focus: z.boolean().default(false),
});
export const TemplateBetweenSchema = z.object({ title: z.string().trim().min(1).max(80), every: z.number().int().min(30).max(480), from: HhMmSchema, to: HhMmSchema });
export const PlanTemplateSchema = z.object({
  id: LifeIdSchema,
  name: z.string().trim().min(1).max(40),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7),
  note: z.string().max(200).optional(),
  steps: z.array(TemplateStepSchema).max(PLAN_STEPS_MAX),
  between: z.array(TemplateBetweenSchema).max(PLAN_BETWEEN_MAX),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type PlanTemplate = z.infer<typeof PlanTemplateSchema>;
export const TemplateBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(40),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  note: z.string().trim().max(200).optional(),
  steps: z.array(PlanPutStepSchema.omit({ id: true, followUp: true })).max(PLAN_STEPS_MAX),
  between: z.array(PlanPutBetweenSchema.omit({ id: true })).max(PLAN_BETWEEN_MAX).optional(),
});
export type TemplateBody = z.infer<typeof TemplateBodySchema>;
export const TemplatePatchSchema = TemplateBodySchema.partial().strict();
export type TemplatePatch = z.infer<typeof TemplatePatchSchema>;
export const TemplatesResponseSchema = z.object({ templates: z.array(PlanTemplateSchema) });

// ---------------------------------------------------------------------------
// The evening review as either side reads it (spec 3.10)

export const ReviewViewSchema = z.discriminatedUnion('level', [
  z.object({
    level: z.literal('full'),
    day: DayKeySchema,
    sent: z.boolean(),
    at: IsoDateSchema.optional(),
    auto: z.boolean().optional(),
    items: z.array(ReviewItemSchema),
    counts: ReviewCountsSchema,
    line: z.string(),
    note: z.string().optional(),
    mood: z.number().int().optional(),
  }),
  z.object({
    level: z.literal('counts'),
    day: DayKeySchema,
    sent: z.boolean(),
    at: IsoDateSchema.optional(),
    auto: z.boolean().optional(),
    counts: ReviewCountsSchema,
    line: z.string(),
  }),
]);
export type ReviewView = z.infer<typeof ReviewViewSchema>;

// ---------------------------------------------------------------------------
// Alerts (spec 6)

export const PersonAlertKindSchema = z.enum(ALERT_KIND_NAMES as [AlertKind, ...AlertKind[]]);
export const AlertUrgencySchema = z.enum(['gentle', 'normal', 'urgent']);
export const AlertReplyKindSchema = z.enum(['ok', 'on_my_way', 'cant_now', 'cant_now_safe', 'heart', 'changed', 'keep']);
export const AlertDeliverySchema = z.enum(['sent', 'held_quiet', 'held_space', 'held_focus', 'held_sleep', 'held_pause', 'held_mute', 'capped', 'released']);
export type AlertDelivery = z.infer<typeof AlertDeliverySchema>;
export const AlertRefSchema = z.object({
  type: z.enum(['step', 'todo']),
  id: z.string(),
  day: DayKeySchema.optional(),
  title: z.string().max(120),
});
export const PersonAlertSchema = z.object({
  id: LifeIdSchema,
  /** '' the owner, or her person id: from the row's columns. */
  from: SpaceSchema,
  to: SpaceSchema,
  kind: PersonAlertKindSchema,
  urgency: AlertUrgencySchema,
  text: z.string().max(ALERT_TEXT_MAX).optional(),
  ref: AlertRefSchema.optional(),
  /** Carry asks: the steps she asks him to carry (change_request from her review). */
  carry: z.object({ day: DayKeySchema, to: DayKeySchema, steps: z.array(z.string()).max(30) }).optional(),
  at: IsoDateSchema,
  delivery: AlertDeliverySchema,
  seenAt: IsoDateSchema.optional(),
  reply: z.object({ kind: AlertReplyKindSchema, note: z.string().max(ALERT_TEXT_MAX).optional(), at: IsoDateSchema }).optional(),
  /** at + 24 h: reply buttons close (it then reads "Expired", with no blame). */
  expiresAt: IsoDateSchema,
});
export type PersonAlert = z.infer<typeof PersonAlertSchema>;
export const AlertSendBodySchema = z.strictObject({
  kind: PersonAlertKindSchema,
  /** custom only: the sender picks gentle or normal. */
  urgency: z.enum(['gentle', 'normal']).optional(),
  /** A note (Urgent's note, a custom text). */
  text: z.string().trim().max(ALERT_TEXT_MAX).optional(),
  /** nudge and change_request: the item. */
  ref: z.strictObject({ type: z.enum(['step', 'todo']), id: z.string().max(26), day: DayKeySchema.optional() }).optional(),
});
export type AlertSendBody = z.infer<typeof AlertSendBodySchema>;
export const OwnerAlertSendBodySchema = AlertSendBodySchema.extend({ to: LifeIdSchema }).strict();
export type OwnerAlertSendBody = z.infer<typeof OwnerAlertSendBodySchema>;
export const AlertReplyBodySchema = z.strictObject({ kind: AlertReplyKindSchema, note: z.string().trim().max(ALERT_TEXT_MAX).optional() });
export type AlertReplyBody = z.infer<typeof AlertReplyBodySchema>;
/** What the send sheet says before a send (spec 6.2): the hold, and the caller's count against the recipient's caps. */
export const AlertSheetSchema = z.object({
  caps: AlertCapsSchema,
  sent: z.object({ hour: z.number().int(), day: z.number().int(), urgentDay: z.number().int() }),
  /** The line under the sheet when the push would be held, or null. */
  hold: z.string().nullable(),
});
export const AlertsResponseSchema = z.object({ alerts: z.array(PersonAlertSchema), unseen: z.number().int(), sheet: AlertSheetSchema });
export type AlertsResponse = z.infer<typeof AlertsResponseSchema>;
export const AlertsQuerySchema = z.object({ with: LifeIdSchema.optional() });
export const AlertSendReplySchema = z.object({ id: LifeIdSchema, delivery: AlertDeliverySchema });

// ---------------------------------------------------------------------------
// Journal (spec 3.11)

export const EmotionSchema = z.enum(EMOTION_NAMES as [Emotion, ...Emotion[]]);
export const JournalKindSchema = z.enum(['entry', 'checkin', 'review']);
export const JournalEntrySchema = z.object({
  id: LifeIdSchema,
  day: DayKeySchema,
  at: IsoDateSchema,
  kind: JournalKindSchema,
  text: z.string().max(JOURNAL_TEXT_MAX).optional(),
  mood: z.number().int().min(1).max(5).optional(),
  emotions: z.array(EmotionSchema).max(3).optional(),
  editedAt: IsoDateSchema.optional(),
  /** Comment count, in list views only. */
  comments: z.number().int().min(0).optional(),
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;
export const JournalCommentSchema = z.object({
  id: LifeIdSchema,
  entryId: LifeIdSchema,
  by: SpaceSchema,
  at: IsoDateSchema,
  text: z.string().max(JOURNAL_COMMENT_MAX),
});
export type JournalComment = z.infer<typeof JournalCommentSchema>;
export const JournalStreakSchema = z.object({ current: z.number().int(), best: z.number().int(), milestoneToday: z.number().int().optional() }).nullable();
export const JournalListSchema = z.object({
  entries: z.array(JournalEntrySchema),
  /** null when she hides streaks: on her screens and his (one DTO, O3). */
  streak: JournalStreakSchema,
  /** The next page's cursor (an `at`), or null. */
  before: IsoDateSchema.nullable(),
  prompt: z.string(),
});
export type JournalList = z.infer<typeof JournalListSchema>;
export const JournalEntryFullSchema = z.object({ entry: JournalEntrySchema, comments: z.array(JournalCommentSchema) });
export type JournalEntryFull = z.infer<typeof JournalEntryFullSchema>;
export const JournalQuerySchema = z.object({ before: IsoDateSchema.optional(), day: DayKeySchema.optional() });
export const JournalCreateBodySchema = z
  .strictObject({
    kind: z.enum(['entry', 'checkin']),
    day: DayKeySchema.optional(),
    text: z.string().trim().max(JOURNAL_TEXT_MAX).optional(),
    mood: z.number().int().min(1).max(5).optional(),
    emotions: z.array(EmotionSchema).max(3).optional(),
    /** A double tap is harmless: the same client id makes one entry. */
    clientId: z.string().min(8).max(64),
  })
  .refine((b) => (b.kind === 'checkin' ? b.mood !== undefined && (b.text ?? '').length <= JOURNAL_LINE_MAX : (b.text ?? '').length > 0 || b.mood !== undefined), {
    message: 'a check-in needs a mood (and a line of at most 200 characters); an entry needs text or a mood',
  });
export type JournalCreateBody = z.infer<typeof JournalCreateBodySchema>;
export const JournalPatchBodySchema = z.strictObject({
  text: z.string().trim().max(JOURNAL_TEXT_MAX).nullable().optional(),
  mood: z.number().int().min(1).max(5).nullable().optional(),
  emotions: z.array(EmotionSchema).max(3).optional(),
  day: DayKeySchema.optional(),
});
export type JournalPatchBody = z.infer<typeof JournalPatchBodySchema>;
export const JournalCommentBodySchema = z.strictObject({ text: z.string().trim().min(1).max(JOURNAL_COMMENT_MAX) });

// ---------------------------------------------------------------------------
// Sleep (spec 3.12)

export const SleepNightSchema = z.object({
  id: LifeIdSchema,
  night: DayKeySchema,
  bedAt: IsoDateSchema,
  wakeAt: IsoDateSchema.optional(),
  /** Closed after 20 h with no wake time logged: nothing is guessed. */
  noWake: z.boolean().optional(),
  quality: z.number().int().min(1).max(5).optional(),
  notes: z.string().max(500).optional(),
  source: z.enum(['buttons', 'manual']),
  editedAt: IsoDateSchema.optional(),
  // Derived on read, never stored:
  minutes: z.number().int().optional(),
  short: z.boolean().optional(),
  bedHm: HhMmSchema.optional(),
  wakeHm: HhMmSchema.optional(),
  /** Bar ends on the 18:00–14:00 axis, in minutes. */
  axis: z.object({ from: z.number().int(), to: z.number().int() }).optional(),
});
export type SleepNight = z.infer<typeof SleepNightSchema>;
export const SleepWeekSchema = z.object({
  from: DayKeySchema,
  to: DayKeySchema,
  nights: z.array(SleepNightSchema).max(92),
  avgMinutes: z.number().int().nullable(),
  avgBed: HhMmSchema.nullable(),
  avgWake: HhMmSchema.nullable(),
  bedSpreadMin: z.number().int().nullable(),
  /** Against the week before, only when both have four logged nights. */
  trend: z.enum(['up', 'down']).nullable(),
  avgQuality: z.number().nullable(),
  open: z.object({ since: IsoDateSchema, night: DayKeySchema }).nullable(),
});
export type SleepWeek = z.infer<typeof SleepWeekSchema>;
export const SleepQuerySchema = z.object({ week: DayKeySchema.optional(), from: DayKeySchema.optional(), to: DayKeySchema.optional() });
export const SleepStartBodySchema = z.strictObject({ at: IsoDateSchema.optional(), clientId: z.string().min(8).max(64) });
export const SleepWakeBodySchema = z.strictObject({
  at: IsoDateSchema.optional(),
  quality: z.number().int().min(1).max(5).optional(),
  notes: z.string().trim().max(500).optional(),
  clientId: z.string().min(8).max(64),
});
export type SleepWakeBody = z.infer<typeof SleepWakeBodySchema>;
export const SleepPutBodySchema = z.strictObject({
  bedAt: IsoDateSchema,
  wakeAt: IsoDateSchema.nullable().optional(),
  quality: z.number().int().min(1).max(5).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});
export type SleepPutBody = z.infer<typeof SleepPutBodySchema>;

// ---------------------------------------------------------------------------
// The 14-day sharing check-in (C26)

export const SharingCheckinBodySchema = z.strictObject({
  answer: z.enum(['keep', 'ease', 'pause', 'talk', 'snooze']),
  /** "Tell {owner} my answer": otherwise the answer is hers alone. */
  tell: z.boolean().optional(),
});
export type SharingCheckinBody = z.infer<typeof SharingCheckinBodySchema>;

