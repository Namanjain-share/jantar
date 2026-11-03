/**
 * v0.12 People: a second kind of person on the owner's Jantar, the partner.
 *
 * This is the subpath `@jantar/protocol/people`, never exported from the
 * package index: none of it belongs in the owner's main web bundle (his
 * People screens are lazy chunks, her app is its own bundle, `p.html`).
 *
 * - Principals: the owner is `''` everywhere and is not a row. A partner is
 *   a person row in life.db (`people`), with her own credential (a person
 *   device: cookie PERSON_COOKIE, read only on PERSON_PREFIX and only on the
 *   people host), her own routes (PERSON_ROUTES, scope `person`), her own
 *   event stream and push list.
 * - Spaces: `''` is the owner's, `<pid>` is hers, `s:<sid>` a shared one.
 *   Every Life row names its space in a column; a row's json never stores
 *   `space` or `by`, both are filled from the columns on read.
 * - The agreement is consent: what the owner may see, assign and edit in
 *   her space, field by field, versioned in jantar.db's ledger. Presets are
 *   offer templates and are never stored (the ledger holds the fields).
 * - The owner reads her space only through PEOPLE_ROUTES
 *   (`/v1/people/:pid/*`), each declaring the agreement area it reads.
 *
 * Copy and examples are synthetic (Sam, Asha, `@example.com`).
 */
import { z } from 'zod';
import type { RouteDef } from './api.js';
import {
  AREA_NAMES,
  BUILD_PHASES,
  MEDS_LEVELS,
  REVIEW_LEVELS,
  agreementProblem,
  type AgreementFields,
  type AgreementPatch,
  type Area,
} from './people-core.js';
import { IsoDateSchema, ScopeSchema } from './models.js';
import { CHAT_PHOTO_MAX_BYTES, ChatItemParamsSchema, ChatListQuerySchema, ChatListSchema, ChatPhotoParamsSchema, ChatSendBodySchema, ChatTurnParamsSchema, ChatTurnSchema } from './chat.js';
import {
  AlertSendBodySchema,
  AlertReplyBodySchema,
  AlertSendReplySchema,
  AlertsQuerySchema,
  AlertsResponseSchema,
  BetweenTickBodySchema,
  ChatKeepDaysSchema,
  JournalCommentBodySchema,
  JournalCommentSchema,
  JournalCreateBodySchema,
  JournalEntryFullSchema,
  JournalListSchema,
  JournalPatchBodySchema,
  JournalQuerySchema,
  LockedSchema,
  OwnerAlertSendBodySchema,
  OwnerPeoplePrefsPatchSchema,
  OwnerPeoplePrefsReplySchema,
  PersonP2PrefsPatchShape,
  PersonP2PrefsShape,
  PersonStatusBodySchema,
  PersonStatusSchema,
  PlanApplyBodySchema,
  PlanPutBodySchema,
  PlanTemplateSchema,
  PlanViewSchema,
  ReviewCarryBodySchema,
  ReviewSendBodySchema,
  ReviewViewSchema,
  RoughBodySchema,
  SharingCheckinBodySchema,
  SleepPutBodySchema,
  SleepQuerySchema,
  SleepStartBodySchema,
  SleepWakeBodySchema,
  SleepWeekSchema,
  SpaceSchema,
  StepAskBodySchema,
  StepBodySchema,
  StepCarryBodySchema,
  StepCheckinBodySchema,
  StepIdSchema,
  StepPatchSchema,
  StepStateBodySchema,
  TemplateBodySchema,
  TemplatePatchSchema,
  TemplatesResponseSchema,
} from './people-days.js';
import {
  DayKeySchema,
  DayQuerySchema,
  DoseBodySchema,
  DoseParamsSchema,
  FoodBodySchema,
  FoodDaySchema,
  FoodPatchSchema,
  FoodTargetsBodySchema,
  IdReplySchema,
  LifeIdParamsSchema,
  LifeIdSchema,
  MedicineBodySchema,
  MedicinePatchSchema,
  MedicineSchema,
  MedicineViewSchema,
  MedsDaySchema,
  OkReplySchema,
  PlaceBodySchema,
  PlaceDetailSchema,
  PlaceSchema,
  ProjectSchema,
  PlaceGetQuerySchema,
  PlacePatchSchema,
  PlaceVisitBodySchema,
  PlaceVisitParamsSchema,
  PlaceVisitPatchSchema,
  PlacesQuerySchema,
  PlacesResponseSchema,
  ProjectBodySchema,
  ProjectPatchSchema,
  ProjectViewSchema,
  SnoozeBodySchema,
  TodoBodySchema,
  TodoPatchSchema,
  TodoSchema,
  TodosQuerySchema,
  WeightBodySchema,
  WeightSchema,
  type MedsDay,
} from './life.js';

export * from './people-core.js';
export * from './people-days.js';
export const AreaSchema = z.enum(AREA_NAMES as [Area, ...Area[]]);

// ---------------------------------------------------------------------------
// Ids and spaces

export const PersonIdSchema = LifeIdSchema;
/** The owner's space and `by`. */
export const OWNER_SPACE = '';
/** A forgotten person's attribution on a shared row (P4). */
export const GONE = 'gone';

export function sharedSpaceId(sid: string): string {
  return `s:${sid}`;
}

export const PersonStateSchema = z.enum(['invited', 'active', 'paused', 'ending', 'left']);
export type PersonState = z.infer<typeof PersonStateSchema>;
export const PERSON_COLORS = ['teal', 'violet', 'amber', 'rose', 'sky', 'lime'] as const;
export const PersonColorSchema = z.enum(PERSON_COLORS);
export type PersonColor = z.infer<typeof PersonColorSchema>;
export const PersonNameSchema = z.string().trim().min(1).max(40);
/** C36: what her lock screen shows of a push. */
export const LockScreenSchema = z.enum(['all', 'hide_alerts', 'hide_all']);
export type LockScreen = z.infer<typeof LockScreenSchema>;

// ---------------------------------------------------------------------------
// The agreement (spec 1.3.3)

export const MedsLevelSchema = z.enum(MEDS_LEVELS);
export const ReviewLevelSchema = z.enum(REVIEW_LEVELS);

/**
 * Every field a later phase adds defaults to off, so an agreement stored
 * before it existed parses with it off (O7, D24): nothing widens until she
 * accepts a proposal.
 */
export const AgreementFieldsSchema = z.strictObject({
  see: z.strictObject({
    todos: z.boolean(),
    meds: MedsLevelSchema,
    weight: z.boolean(),
    food: z.boolean(),
    plan: z.boolean().default(false), // P2
    review: ReviewLevelSchema.default('off'), // P2
    sleep: z.boolean().default(false), // P2
    journal: z.boolean().default(false), // P2
    chat: z.boolean().default(false), // P3
  }),
  assign: z.strictObject({
    todos: z.boolean(),
    meds: z.boolean(),
    plan: z.boolean().default(false), // P2
  }),
  /** O4: he may edit or remove what she added herself. Never create her record (D22). */
  editHers: z.strictObject({
    todos: z.boolean(),
    meds: z.boolean().default(false),
    weight: z.boolean().default(false),
    plan: z.boolean().default(false), // P2
  }),
  comment: z.strictObject({ journal: z.boolean().default(false) }).prefault({}), // P2
  /** D17: his assistant reading her space; its own proposal, in no preset (P3). */
  assistant: z.boolean().default(false),
});
/** The schema parses exactly people-core's AgreementFields (a compile-time check, both ways). */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const AGREEMENT_SHAPE_MATCHES: Same<z.infer<typeof AgreementFieldsSchema>, AgreementFields> = true;
void AGREEMENT_SHAPE_MATCHES;

const refineAgreement = (a: AgreementFields, ctx: z.RefinementCtx) => {
  const problem = agreementProblem(a);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
};

export const AgreementSchema = AgreementFieldsSchema.extend({ version: z.number().int().min(1) }).superRefine(refineAgreement);
export type Agreement = z.infer<typeof AgreementSchema>;
export const CheckedAgreementFieldsSchema = AgreementFieldsSchema.superRefine(refineAgreement);

export const PresetSchema = z.enum(['light', 'standard', 'everything']);

/** A partial change to an agreement: each group's fields optional (offer flags, narrow, propose). */
export const AgreementPatchSchema = z.strictObject({
  see: z
    .strictObject({
      todos: z.boolean().optional(),
      plan: z.boolean().optional(),
      review: ReviewLevelSchema.optional(),
      meds: MedsLevelSchema.optional(),
      weight: z.boolean().optional(),
      sleep: z.boolean().optional(),
      journal: z.boolean().optional(),
      chat: z.boolean().optional(),
      food: z.boolean().optional(),
    })
    .optional(),
  assign: z.strictObject({ todos: z.boolean().optional(), plan: z.boolean().optional(), meds: z.boolean().optional() }).optional(),
  editHers: z
    .strictObject({ todos: z.boolean().optional(), plan: z.boolean().optional(), meds: z.boolean().optional(), weight: z.boolean().optional() })
    .optional(),
  comment: z.strictObject({ journal: z.boolean().optional() }).optional(),
  assistant: z.boolean().optional(),
});
const PATCH_SHAPE_MATCHES: Same<z.infer<typeof AgreementPatchSchema>, AgreementPatch> = true;
void PATCH_SHAPE_MATCHES;

// ---------------------------------------------------------------------------
// The person (life.db `people.json`)

export const DontAskSchema = z.enum(['todos', 'plan', 'review', 'meds', 'weight', 'sleep', 'journal', 'chat', 'food', 'assistant', 'editHers', 'comment']);
export type DontAsk = z.infer<typeof DontAskSchema>;

/** Her preferences. P1: the lock screen, mute and "don't ask again"; P2: quiet hours, times, holds, caps and rings (each with a default). */
export const PersonPrefsSchema = z.object({
  lockScreen: LockScreenSchema.default('hide_alerts'),
  muteUntil: IsoDateSchema.nullable().default(null),
  dontAsk: z.array(DontAskSchema).max(12).default([]),
  ...PersonP2PrefsShape,
});
export type PersonPrefs = z.infer<typeof PersonPrefsSchema>;

export const PersonModulesSchema = z.object({ food: z.boolean().default(true) });
export type PersonModules = z.infer<typeof PersonModulesSchema>;

export const PersonSchema = z.object({
  id: PersonIdSchema,
  name: PersonNameSchema,
  color: PersonColorSchema,
  /** A reminder for the Access step; never used to authenticate (spec 8.9). */
  emailLabel: z.string().max(200).optional(),
  state: PersonStateSchema,
  /** `s:<sid>`: the one space she shares with the owner (P4's lists). */
  sharedSpace: z.string(),
  modules: PersonModulesSchema.prefault({}),
  joinedAt: IsoDateSchema.optional(),
  pausedAt: IsoDateSchema.optional(),
  endingUntil: IsoDateSchema.optional(),
  leftAt: IsoDateSchema.optional(),
  forgetAt: IsoDateSchema.optional(),
  prefs: PersonPrefsSchema.prefault({}),
  limits: z.object({ chatPerDay: z.number().int().min(0).max(200).default(30) }).prefault({}),
  /** A proposal waiting for her (its fields are the ledger row of that version). The note is kept here, never in the ledger. */
  pendingProposal: z.object({ version: z.number().int().min(1), note: z.string().max(200).optional() }).optional(),
  /** C23: field key → the day it may be proposed again. */
  declinedUntil: z.record(z.string(), IsoDateSchema).default({}),
  /** P2: her status (Okay, Low, Need space); it ends at `until`. Hers alone: he has no route that sets it. */
  status: PersonStatusSchema.optional(),
  /** P2 (C26): when the sharing check-in next shows. */
  sharingCheckinDueAt: IsoDateSchema.optional(),
  /** P2: comment and reminder pushes held for her (quiet hours, space, focus, sleep, pause), released as one summary. */
  held: z.object({ comments: z.number().int().min(0).default(0), reviews: z.number().int().min(0).default(0), reason: z.string().max(20).optional() }).optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type Person = z.infer<typeof PersonSchema>;

// ---------------------------------------------------------------------------
// Activity (life.db person_activity): her record, append-only (spec 8.3)

export const ActivityActorSchema = z.enum(['owner', 'her', 'system']);
export const ActivityChangeSchema = z.object({ field: z.string().max(40), from: z.string().max(200).optional(), to: z.string().max(200).optional() });
export const PersonActivitySchema = z.object({
  seq: z.number().int(),
  at: IsoDateSchema,
  actor: ActivityActorSchema,
  /** A fixed code: joined, view, todo.added, todo.edited, med.edited, weight.corrected, agreement.narrowed, … */
  action: z.string().max(40),
  ref: z.string().max(80).optional(),
  /** A title snapshot (todos, medicines), never journal, comment, chat, sleep or review text (O15). */
  title: z.string().max(200).optional(),
  area: AreaSchema.optional(),
  changes: z.array(ActivityChangeSchema).max(12).optional(),
  /** A device name (linked, revoked, his device that gained control). */
  device: z.string().max(64).optional(),
  fields: z.array(z.string().max(40)).max(24).optional(),
});
export type PersonActivity = z.infer<typeof PersonActivitySchema>;
export const PersonActivityResponseSchema = z.object({ activity: z.array(PersonActivitySchema), before: z.number().int().nullable() });
export type PersonActivityResponse = z.infer<typeof PersonActivityResponseSchema>;
export const ActivityQuerySchema = z.object({ before: z.coerce.number().int().min(1).optional() });

// ---------------------------------------------------------------------------
// Her Life rows: the owner's shapes plus the People fields (daemon-set ones never in a body)

export const TodoAskSchema = z.enum(['none', 'ack', 'report']);
export type TodoAsk = z.infer<typeof TodoAskSchema>;
/**
 * A todo as stored and as either side reads it in a person space (spec
 * 3.3). `by` and `space` come from the row's columns; `editedBy` and
 * `editedAt` are daemon-set on any edit by someone other than `by`.
 */
export const PersonTodoSchema = TodoSchema.extend({
  by: SpaceSchema.optional(),
  ask: TodoAskSchema.optional(),
  ackAt: IsoDateSchema.optional(),
  report: z.string().max(500).optional(),
  snoozable: z.boolean().optional(),
  skipped: z.object({ at: IsoDateSchema, reason: z.string().max(200).optional() }).optional(),
  lastSkip: z.object({ at: IsoDateSchema, reason: z.string().max(200).optional() }).optional(),
  editedBy: SpaceSchema.optional(),
  editedAt: IsoDateSchema.optional(),
  /** A change she asked for (`personTodoAsk`): shown on the item on his To-do tab, and on the Alerts page (P2). */
  askedChange: z.object({ at: IsoDateSchema, note: z.string().max(200) }).optional(),
  /** P2: "Tell me if not done by" (his, shown to her, never sent to her). */
  followUp: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  /** P4: a shared list item's tick: who ticked it (daemon-set from the caller). */
  doneBy: SpaceSchema.optional(),
  /** P4: a shared list item he handed on as a to-do of hers ("Assigned to Asha"); no link to it (C6). */
  handed: z.object({ to: SpaceSchema, at: IsoDateSchema }).optional(),
});
export type PersonTodo = z.infer<typeof PersonTodoSchema>;
export const PersonTodosResponseSchema = z.object({ today: DayKeySchema, todos: z.array(PersonTodoSchema) });
export type PersonTodosResponse = z.infer<typeof PersonTodosResponseSchema>;

/** His assign body: the owner's todo body plus `ask` and `snoozable` (no `by`, no `space`: daemon-set). */
export const AssignTodoBodySchema = z
  .strictObject({ ...TodoBodySchema.shape, ask: TodoAskSchema.optional(), snoozable: z.boolean().optional(), followUp: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional() })
  .refine((b) => b.repeat === undefined || b.due !== undefined, { message: 'a repeating todo needs a due day', path: ['repeat'] });
export type AssignTodoBody = z.infer<typeof AssignTodoBodySchema>;
export const AssignTodoPatchSchema = z
  .strictObject({ ...TodoPatchSchema.shape, ask: TodoAskSchema.optional(), snoozable: z.boolean().optional(), followUp: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional() })
  .refine((b) => !(b.repeat && b.due === null), { message: 'a repeating todo needs a due day', path: ['repeat'] });
export type AssignTodoPatch = z.infer<typeof AssignTodoPatchSchema>;
/** Her Done: the owner's plus an optional report. */
export const PersonTodoDoneBodySchema = z.strictObject({ done: z.boolean(), report: z.string().trim().max(500).optional() });
export type PersonTodoDoneBody = z.infer<typeof PersonTodoDoneBodySchema>;
export const PersonTodoSkipBodySchema = z.strictObject({ reason: z.string().trim().max(200).optional() });
export const PersonTodoAskBodySchema = z.strictObject({ note: z.string().trim().min(1).max(200) });

/** A medicine in a person space: `by` from the column, "Edited by" daemon-set. */
export const PersonMedicineSchema = MedicineSchema.extend({ by: SpaceSchema.optional(), editedBy: SpaceSchema.optional(), editedAt: IsoDateSchema.optional() });
export type PersonMedicine = z.infer<typeof PersonMedicineSchema>;
export const PersonMedicineViewSchema = MedicineViewSchema.extend({ by: SpaceSchema.optional(), editedBy: SpaceSchema.optional(), editedAt: IsoDateSchema.optional() });
export type PersonMedicineView = z.infer<typeof PersonMedicineViewSchema>;
export const PersonMedicinesResponseSchema = z.object({ day: MedsDaySchema, medicines: z.array(PersonMedicineViewSchema) });
export type PersonMedicinesResponse = z.infer<typeof PersonMedicinesResponseSchema>;

/** A weight in a person space, with "Corrected by" when he changed it. */
export const PersonWeightSchema = WeightSchema.extend({ correctedBy: SpaceSchema.optional(), was: z.number().optional() });
export type PersonWeight = z.infer<typeof PersonWeightSchema>;
export const PersonWeightsResponseSchema = z.object({ weights: z.array(PersonWeightSchema).max(400), latest: PersonWeightSchema.nullable() });
export type PersonWeightsResponse = z.infer<typeof PersonWeightsResponseSchema>;

// ---------------------------------------------------------------------------
// What the owner sees of her, and her mirror of it (one function, spec 8.4)

export const OwnerTodosViewSchema = z.object({ today: DayKeySchema, todos: z.array(PersonTodoSchema), projects: z.array(ProjectViewSchema) });
export type OwnerTodosView = z.infer<typeof OwnerTodosViewSchema>;
/** `full`: each medicine and its doses. `adherence`: a percentage and a count, no names and no doses. */
export const OwnerMedsViewSchema = z.discriminatedUnion('level', [
  z.object({ level: z.literal('full'), day: MedsDaySchema, medicines: z.array(PersonMedicineViewSchema), concern: z.string().nullable() }),
  z.object({ level: z.literal('adherence'), pct: z.number().min(0).max(100).nullable(), notLoggedToday: z.number().int().min(0), concern: z.string().nullable() }),
]);
export type OwnerMedsView = z.infer<typeof OwnerMedsViewSchema>;
export const OwnerWeightViewSchema = PersonWeightsResponseSchema;
export type OwnerWeightView = PersonWeightsResponse;
export const OwnerFoodViewSchema = FoodDaySchema;

export const PersonTodayTodosSchema = z.object({ open: z.number().int(), overdue: z.number().int(), due: z.array(PersonTodoSchema) });
export const PersonTodaySchema = z.object({
  day: DayKeySchema,
  name: PersonNameSchema,
  state: PersonStateSchema,
  todos: z.union([LockedSchema, PersonTodayTodosSchema]),
  /** null: not part of this build yet (her medicines join the space in a later commit of P1). */
  meds: z.union([LockedSchema, OwnerMedsViewSchema]).nullable(),
  weight: z.union([LockedSchema, z.object({ latest: PersonWeightSchema.nullable() })]),
  /** null: her food module is off, so there is no food area at all (O6). */
  food: z.union([LockedSchema, z.object({ kcal: z.number().int(), target: z.number().int() })]).nullable(),
  /** P2: her day plan with what is derived on read (see.plan). */
  plan: z.union([LockedSchema, PlanViewSchema]),
  /** P2: her status line (part of the plan area). */
  status: z.union([LockedSchema, PersonStatusSchema.nullable()]),
  /** P2: the day's evening review at his level, from her review time on (null before it, or with nothing to review). */
  review: z.union([LockedSchema, ReviewViewSchema]).nullable(),
  /** P2: "Asleep since 23:40" while a night is open (see.sleep). */
  sleep: z.union([LockedSchema, z.object({ open: z.object({ since: IsoDateSchema, night: DayKeySchema }).nullable() })]),
  /** Concern lines, derived when he looks, never stored (C22): she sees the same on her mirror. Never from sleep, journal, moods or review outcomes. */
  concerns: z.array(z.string()),
});
export type PersonToday = z.infer<typeof PersonTodaySchema>;

/** Her own Today: medicines due, reminders and to-dos due (P1); her plan, status, the review and sleep cards, the sharing check-in (P2). */
export const PersonOwnTodaySchema = z.object({
  day: DayKeySchema,
  today: DayKeySchema,
  meds: MedsDaySchema.nullable(),
  todos: z.array(PersonTodoSchema),
  overdue: z.number().int(),
  plan: PlanViewSchema,
  status: PersonStatusSchema.nullable(),
  /** From her review time until she sends it, or until 12:00 the next day ("Yesterday's review"). */
  review: z.object({ day: DayKeySchema, line: z.string(), done: z.number().int(), open: z.number().int(), yesterday: z.boolean() }).nullable(),
  sleep: z.object({
    open: z.object({ since: IsoDateSchema, night: DayKeySchema }).nullable(),
    /** "Going to sleep" shows (20:00–04:00, no night open). */
    showStart: z.boolean(),
    /** Last night closed with no wake time: the morning card asks "When did you wake up?". */
    askWake: DayKeySchema.nullable(),
  }),
  /** The 14-day "Is this setup still working for you?" card. */
  sharingCheckin: z.boolean(),
  /** Alerts from {owner} she hasn't opened. */
  alertsUnseen: z.number().int(),
  /** Today's journal prompt (optional to answer; no nudge, no count). */
  prompt: z.string(),
});
export type PersonOwnToday = z.infer<typeof PersonOwnTodaySchema>;

// ---------------------------------------------------------------------------
// Devices, invites, consent

export const PersonDevicePublicSchema = z.object({
  id: LifeIdSchema,
  name: z.string(),
  createdAt: IsoDateSchema,
  /** The Access email it joined with (C14), shown to both. */
  accessEmail: z.string().optional(),
  revokedAt: IsoDateSchema.optional(),
});
export type PersonDevicePublic = z.infer<typeof PersonDevicePublicSchema>;
/** Her own list also shows when each was last used (his never does: C20). */
export const PersonOwnDeviceSchema = PersonDevicePublicSchema.extend({ lastSeenAt: IsoDateSchema, current: z.boolean() });

export const ConsentActionSchema = z.enum([
  'offered',
  'joined',
  'proposed',
  'accepted',
  'declined',
  'narrowed',
  'paused',
  'resumed',
  'left',
  'removed',
  'ending',
  'forgotten',
  'module_changed',
  'sharing_checkin',
  'reconciled',
]);
export type ConsentAction = z.infer<typeof ConsentActionSchema>;

// ---------------------------------------------------------------------------
// Owner DTOs

export const PersonInviteInfoSchema = z.object({
  expiresAt: IsoDateSchema,
  /** The link can be shown again (an admin device; the code is held in memory until used or a restart). */
  linkAvailable: z.boolean(),
});
export const PersonViewSchema = z.object({
  id: PersonIdSchema,
  name: PersonNameSchema,
  color: PersonColorSchema,
  state: PersonStateSchema,
  emailLabel: z.string().optional(),
  joinedAt: IsoDateSchema.optional(),
  pausedAt: IsoDateSchema.optional(),
  endingUntil: IsoDateSchema.optional(),
  modules: PersonModulesSchema,
  invite: PersonInviteInfoSchema.nullable(),
  /** The live agreement (explicit fields), or null before she joins. */
  agreement: AgreementSchema.nullable(),
  /** The offer the next invite carries. */
  offer: AgreementSchema.nullable(),
  pendingProposal: z.object({ version: z.number().int(), fields: AgreementFieldsSchema }).nullable(),
  /** P3: her chat's messages a day. */
  chatPerDay: z.number().int().optional(),
  /** P4: the space they share (`s:<id>`): his cafés' "Shared with {her}" picker names it. */
  sharedSpace: z.string().optional(),
});
export type PersonView = z.infer<typeof PersonViewSchema>;
export const PeopleListSchema = z.object({ enabled: z.boolean(), people: z.array(PersonViewSchema) });
export type PeopleList = z.infer<typeof PeopleListSchema>;
export const PersonResponseSchema = z.object({ person: PersonViewSchema });
export const PidParamsSchema = z.object({ pid: PersonIdSchema });
export const PidIdParamsSchema = z.object({ pid: PersonIdSchema, id: LifeIdSchema });
export const PidDayParamsSchema = z.object({ pid: PersonIdSchema, day: DayKeySchema });
export const PidDidParamsSchema = z.object({ pid: PersonIdSchema, did: LifeIdSchema });

export const PersonAddBodySchema = z.strictObject({
  name: PersonNameSchema,
  email: z.email().max(200).optional(),
  color: PersonColorSchema.optional(),
  modules: z.strictObject({ food: z.boolean() }).optional(),
});
export type PersonAddBody = z.infer<typeof PersonAddBodySchema>;
export const PersonOfferBodySchema = AgreementPatchSchema.extend({ preset: PresetSchema.optional() });
export type PersonOfferBody = z.infer<typeof PersonOfferBodySchema>;
export const PersonOfferReplySchema = z.object({ version: z.number().int(), fields: AgreementFieldsSchema, on: z.array(z.string()) });
export const PersonInviteReplySchema = z.object({ url: z.string(), expiresAt: IsoDateSchema });
export type PersonInviteReply = z.infer<typeof PersonInviteReplySchema>;
export const PersonModulesBodySchema = z.strictObject({ food: z.boolean() });
/** Her colour on his screens, and (P3) her chat's daily cap (an Activity row). */
export const PersonColorBodySchema = z
  .strictObject({ color: PersonColorSchema.optional(), chatPerDay: z.number().int().min(0).max(200).optional() })
  .refine((b) => b.color !== undefined || b.chatPerDay !== undefined, { message: 'name a colour or a daily cap' });
export const PersonRemoveBodySchema = z.strictObject({ mode: z.enum(['window', 'now']), forget: z.boolean().default(false) });
export type PersonRemoveBody = z.infer<typeof PersonRemoveBodySchema>;
export const PeopleSwitchBodySchema = z.strictObject({ on: z.boolean() });
export const PersonProposeBodySchema = AgreementPatchSchema.extend({ note: z.string().trim().max(200).optional() });
export type PersonProposeBody = z.infer<typeof PersonProposeBodySchema>;
export const PeopleDoctorSchema = z.object({
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })),
});
export type PeopleDoctor = z.infer<typeof PeopleDoctorSchema>;
export const PersonDevicesResponseSchema = z.object({ devices: z.array(PersonDevicePublicSchema) });

// ---------------------------------------------------------------------------
// Her DTOs and bodies

export const JoinPreviewBodySchema = z.strictObject({ code: z.string().min(16).max(128) });
export const JoinPreviewSchema = z.object({
  owner: z.string(),
  name: PersonNameSchema,
  version: z.number().int(),
  offer: AgreementFieldsSchema,
  /** The fields this build offers (O7). */
  fields: z.array(z.string()),
  built: z.enum(BUILD_PHASES),
  modules: PersonModulesSchema,
});
export type JoinPreview = z.infer<typeof JoinPreviewSchema>;
export const JoinBodySchema = z.strictObject({
  code: z.string().min(16).max(128),
  acceptedVersion: z.number().int().min(1),
  agreement: AgreementFieldsSchema,
  adult: z.literal(true),
  name: PersonNameSchema,
  deviceName: z.string().trim().min(1).max(64),
});
export type JoinBody = z.infer<typeof JoinBodySchema>;
export const JoinReplySchema = z.object({ personId: PersonIdSchema, deviceId: LifeIdSchema, deviceSecret: z.string() });
export type JoinReply = z.infer<typeof JoinReplySchema>;

export const PersonMeSchema = z.object({
  person: z.object({
    id: PersonIdSchema,
    name: PersonNameSchema,
    color: PersonColorSchema,
    state: PersonStateSchema,
    joinedAt: IsoDateSchema.optional(),
    pausedAt: IsoDateSchema.optional(),
    endingUntil: IsoDateSchema.optional(),
    modules: PersonModulesSchema,
    prefs: PersonPrefsSchema,
  }),
  owner: z.object({ name: z.string() }),
  /** False while the owner has People switched off: only her exits work (C12). */
  peopleOn: z.boolean(),
  agreement: AgreementSchema.nullable(),
  pending: z.object({ version: z.number().int(), fields: AgreementFieldsSchema, note: z.string().optional() }).nullable(),
  /** His devices that can open her space (control and above), and his Mac. */
  ownerDevices: z.array(z.object({ name: z.string(), createdAt: IsoDateSchema, scope: ScopeSchema })),
  built: z.enum(BUILD_PHASES),
  /** Life data can't be read right now (her exits still work). */
  lifeBroken: z.boolean(),
  /** P2: what {owner} is told without looking, beyond the fixed list (spec 3.8): his opt-in day summary and the "review sent" push. */
  ownerTells: z.object({ summaryAt: z.string().nullable(), reviewPush: z.boolean() }).optional(),
});
export type PersonMe = z.infer<typeof PersonMeSchema>;

export const MirrorParamsSchema = z.object({ area: AreaSchema });
export const AgreementVersionBodySchema = z.strictObject({ version: z.number().int().min(1) });
export const AgreementDeclineBodySchema = z.strictObject({ version: z.number().int().min(1), dontAsk: z.boolean().optional() });
export const PauseBodySchema = z.strictObject({ note: z.string().trim().max(200).optional() });
export const LeaveBodySchema = z.strictObject({ data: z.enum(['keep30', 'delete']), confirm: z.literal('LEAVE') });
export type LeaveBody = z.infer<typeof LeaveBodySchema>;
export const ExportQuerySchema = z.object({ format: z.enum(['html', 'json']).default('html') });
/** Her prefs (P1 and P2); a later phase's field is a 400 (strict). */
export const PersonPrefsPatchSchema = z.strictObject({
  lockScreen: LockScreenSchema.optional(),
  muteUntil: IsoDateSchema.nullable().optional(),
  dontAsk: z.array(DontAskSchema).max(12).optional(),
  ...PersonP2PrefsPatchShape,
});
export type PersonPrefsPatch = z.infer<typeof PersonPrefsPatchSchema>;
export const LinkCodeReplySchema = z.object({ code: z.string(), url: z.string(), expiresAt: IsoDateSchema });
export const LinkClaimBodySchema = z.strictObject({ code: z.string().min(16).max(128), deviceName: z.string().trim().min(1).max(64) });
export const PersonPushSubscribeBodySchema = z.strictObject({
  subscription: z.strictObject({
    endpoint: z.url().max(2048),
    expirationTime: z.number().nullable().optional(),
    keys: z.strictObject({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(512) }),
  }),
});
export type PersonPushSubscribeBody = z.infer<typeof PersonPushSubscribeBodySchema>;
export const PersonPushUnsubscribeBodySchema = z.strictObject({ endpoint: z.url().max(2048) });

/** `WS /v1/p/events`: her counters only, never State, replay or an id of his (spec 9.3.6). */
export const PersonTickSchema = z.object({
  kind: z.literal('tick'),
  seq: z.number().int(),
  life: z.number().int(),
  /** P2: her plan, review, status, sleep and journal. */
  plan: z.number().int(),
  /** P2: alerts with the owner. */
  alerts: z.number().int(),
  /** P3: her chat thread. */
  chat: z.number().int(),
  me: z.number().int(),
});
export type PersonTick = z.infer<typeof PersonTickSchema>;
export const PersonWsMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hello'), protocol: z.number().int(), daemonVersion: z.string(), webHash: z.string().nullable(), personEpoch: z.string() }),
  PersonTickSchema,
  z.object({ kind: z.literal('heartbeat'), ts: IsoDateSchema }),
]);
export type PersonWsMessage = z.infer<typeof PersonWsMessageSchema>;

/** A medicine day's slots, logged and missed, counted (her Today and his adherence tile). */
export function medsDayTotals(day: MedsDay): { slots: number; logged: number; missed: number } {
  let slots = 0;
  let logged = 0;
  let missed = 0;
  for (const g of day.groups) {
    for (const it of g.items) {
      slots += 1;
      if (it.status === 'taken' || it.status === 'skipped') logged += 1;
      if (it.status === 'missed' || it.overdue) missed += 1;
    }
  }
  return { slots, logged, missed };
}

// ---------------------------------------------------------------------------
// P3: her Chat (spec 7)

/** Her thread as she sees it: the owner's chat list plus her daily cap and what {owner} can read. */
export const PersonChatListSchema = ChatListSchema.extend({
  /** Messages left today, and her daily cap. */
  left: z.number().int().min(0),
  perDay: z.number().int().min(0),
  /** {owner} can read this chat now (see.chat): the header line shows on every visit. */
  ownerCanRead: z.boolean(),
  /** The disclosure, built from the live agreement (spec 7.6). */
  disclosure: z.string(),
});
export type PersonChatList = z.infer<typeof PersonChatListSchema>;
/** Her chat's size (no text), messages left today and whether it can run now. */
export const PersonChatStatusSchema = z.object({
  turns: z.number().int().min(0),
  left: z.number().int().min(0),
  perDay: z.number().int().min(0),
  ready: z.object({ ok: z.boolean(), reason: z.string().optional() }),
});
export type PersonChatStatus = z.infer<typeof PersonChatStatusSchema>;
/** His read-only view of her chat (spec 7.8): the turns as she sees them; her mirror returns the same. */
export const OwnerChatViewSchema = z.object({
  turns: z.array(ChatTurnSchema),
  older: z.string().nullable(),
  keepDays: ChatKeepDaysSchema,
});
export type OwnerChatView = z.infer<typeof OwnerChatViewSchema>;

// ---------------------------------------------------------------------------
// P4: shared lists (spec 5.3): a list is a project in a shared space with a kind; its items are to-dos there.

export const SharedListKindSchema = z.enum(['shopping', 'watch', 'read', 'plain']);
/** A project as stored, with a shared list's kind (the owner's ProjectSchema leaves it out of his bundle). */
export const StoredProjectSchema = ProjectSchema.extend({ list: z.object({ kind: SharedListKindSchema }).optional() });
/** A café as stored, with "Edited by" on a shared one (daemon-set; `by` and `space` are columns, never json). */
export const StoredPlaceSchema = PlaceSchema.extend({ editedBy: z.string().optional(), editedAt: IsoDateSchema.optional() });
export const SharedListSchema = z.object({
  id: LifeIdSchema,
  name: z.string(),
  kind: SharedListKindSchema,
  open: z.number().int(),
  done: z.number().int(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type SharedList = z.infer<typeof SharedListSchema>;
export const SharedItemSchema = z.object({
  id: LifeIdSchema,
  title: z.string(),
  notes: z.string().optional(),
  by: z.string(),
  doneAt: IsoDateSchema.optional(),
  doneBy: z.string().optional(),
  editedBy: z.string().optional(),
  handed: z.object({ to: z.string(), at: IsoDateSchema }).optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type SharedItem = z.infer<typeof SharedItemSchema>;
export const SharedListsResponseSchema = z.object({ space: z.string(), lists: z.array(SharedListSchema) });
export type SharedListsResponse = z.infer<typeof SharedListsResponseSchema>;
export const SharedItemsResponseSchema = z.object({ list: SharedListSchema, items: z.array(SharedItemSchema) });
export type SharedItemsResponse = z.infer<typeof SharedItemsResponseSchema>;
export const SharedListBodySchema = z.strictObject({ name: z.string().trim().min(1).max(60), kind: SharedListKindSchema.default('plain') });
export type SharedListBody = z.input<typeof SharedListBodySchema>;
export const SharedListPatchSchema = z.strictObject({ name: z.string().trim().min(1).max(60) });
export const SharedItemBodySchema = z.strictObject({ title: z.string().trim().min(1).max(200), note: z.string().trim().max(500).optional() });
export type SharedItemBody = z.infer<typeof SharedItemBodySchema>;
export const SharedItemPatchSchema = z.strictObject({ title: z.string().trim().min(1).max(200).optional(), note: z.string().trim().max(500).nullable().optional() });
export type SharedItemPatch = z.infer<typeof SharedItemPatchSchema>;
export const SharedTickBodySchema = z.strictObject({ done: z.boolean() });
const listParams = z.object({ id: LifeIdSchema });
const itemParams = z.object({ id: LifeIdSchema, itemId: LifeIdSchema });

// ---------------------------------------------------------------------------
// Route tables (each route lands in the commit of its handler; the arch test pins both lists)

function route<T extends RouteDef>(r: T): T {
  return r;
}

/** Her account, consent and device routes: scope `person`, never on ctl.sock, every one under PERSON_PREFIX (spec 1.3.2). */
const PERSON_ACCOUNT_ROUTES = {
  personJoinPreview: route({
    method: 'POST', path: '/v1/p/join/preview', scope: 'person', phase: 'v0.12', ctl: false, join: true,
    body: JoinPreviewBodySchema, response: JoinPreviewSchema, summary: 'What an invite offers, without spending it.',
  }),
  personJoin: route({
    method: 'POST', path: '/v1/p/join', scope: 'person', phase: 'v0.12', ctl: false, join: true,
    body: JoinBodySchema, response: JoinReplySchema, summary: 'Accept an invite: sets her cookie and returns her device secret once.',
  }),
  personMe: route({
    method: 'GET', path: '/v1/p/me', scope: 'person', phase: 'v0.12', ctl: false, exit: true,
    response: PersonMeSchema, summary: 'Her profile, state, the live agreement and any pending proposal.',
  }),
  personAgreementAccept: route({
    method: 'POST', path: '/v1/p/agreement/accept', scope: 'person', phase: 'v0.12', ctl: false,
    body: AgreementVersionBodySchema, response: OkReplySchema, summary: 'Accept the pending proposal.',
  }),
  personAgreementDecline: route({
    method: 'POST', path: '/v1/p/agreement/decline', scope: 'person', phase: 'v0.12', ctl: false,
    body: AgreementDeclineBodySchema, response: OkReplySchema, summary: 'Decline the pending proposal.',
  }),
  personAgreementNarrow: route({
    method: 'POST', path: '/v1/p/agreement/narrow', scope: 'person', phase: 'v0.12', ctl: false,
    body: AgreementPatchSchema, response: OkReplySchema, summary: 'Lower what the owner sees or does; applies before the next read.',
  }),
  personPause: route({
    method: 'POST', path: '/v1/p/pause', scope: 'person', phase: 'v0.12', ctl: false, exit: true,
    body: PauseBodySchema, response: OkReplySchema, summary: 'Hold his writes and alerts until she resumes.',
  }),
  personResume: route({
    method: 'POST', path: '/v1/p/resume', scope: 'person', phase: 'v0.12', ctl: false, exit: true,
    body: PauseBodySchema, response: OkReplySchema, summary: 'End her pause.',
  }),
  personLeave: route({
    method: 'POST', path: '/v1/p/leave', scope: 'person', phase: 'v0.12', ctl: false, exit: true,
    body: LeaveBodySchema, response: OkReplySchema, summary: 'Leave: revokes her devices; her data is kept 30 days or deleted now.',
  }),
  personExport: route({
    method: 'GET', path: '/v1/p/export', scope: 'person', phase: 'v0.12', ctl: false, exit: true, rawResponse: true,
    query: ExportQuerySchema, summary: 'Everything in her space, as a readable page or a data file.',
  }),
  personActivity: route({
    method: 'GET', path: '/v1/p/activity', scope: 'person', phase: 'v0.12', ctl: false, exit: true,
    query: ActivityQuerySchema, response: PersonActivityResponseSchema, summary: 'Her Activity, newest first.',
  }),
  personPrefs: route({
    method: 'PATCH', path: '/v1/p/prefs', scope: 'person', phase: 'v0.12', ctl: false,
    body: PersonPrefsPatchSchema, response: OkReplySchema, summary: 'Her notification preferences.',
  }),
  personDevices: route({
    method: 'GET', path: '/v1/p/devices', scope: 'person', phase: 'v0.12', ctl: false,
    response: z.object({ devices: z.array(PersonOwnDeviceSchema) }), summary: 'Her own devices.',
  }),
  personDeviceRevoke: route({
    method: 'DELETE', path: '/v1/p/devices/:id', scope: 'person', phase: 'v0.12', ctl: false,
    params: LifeIdParamsSchema, response: OkReplySchema, summary: 'Revoke one of her own devices (this one included).',
  }),
  personDeviceLinkCode: route({
    method: 'POST', path: '/v1/p/devices/link', scope: 'person', phase: 'v0.12', ctl: false,
    response: LinkCodeReplySchema, summary: 'A 5-minute, single-use code for another device of hers (C37).',
  }),
  personDeviceLinkClaim: route({
    method: 'POST', path: '/v1/p/devices/link/claim', scope: 'person', phase: 'v0.12', ctl: false, join: true,
    body: LinkClaimBodySchema, response: JoinReplySchema, summary: 'Link this device with a code from another device of hers.',
  }),
  personPushKey: route({
    method: 'GET', path: '/v1/p/push/vapid-public-key', scope: 'person', phase: 'v0.12', ctl: false,
    response: z.object({ publicKey: z.string() }), summary: 'The Web Push key.',
  }),
  personPushSubscribe: route({
    method: 'POST', path: '/v1/p/push/subscribe', scope: 'person', phase: 'v0.12', ctl: false,
    body: PersonPushSubscribeBodySchema, response: OkReplySchema, summary: 'Add this device to her push list.',
  }),
  personPushUnsubscribe: route({
    method: 'POST', path: '/v1/p/push/unsubscribe', scope: 'person', phase: 'v0.12', ctl: false,
    body: PersonPushUnsubscribeBodySchema, response: OkReplySchema, summary: 'Drop one subscription of hers.',
  }),
  personPushTest: route({
    method: 'POST', path: '/v1/p/push/test', scope: 'person', phase: 'v0.12', ctl: false,
    response: z.object({ delivered: z.number().int() }), summary: 'A test push to her devices.',
  }),
  personEvents: route({
    method: 'WS', path: '/v1/p/events', scope: 'person', phase: 'v0.12', ctl: false,
    summary: 'Her counters as ticks (spec 9.3.6).',
  }),
} as const satisfies Record<string, RouteDef>;

/** Her Life routes (spec 1.3.2): each declares its area. */
export const PERSON_LIFE_ROUTES = {
  personWeights: route({
    method: 'GET', path: '/v1/p/weights', scope: 'person', phase: 'v0.12', ctl: false, area: 'weight',
    response: PersonWeightsResponseSchema, summary: 'Her weights.',
  }),
  personWeightSet: route({
    method: 'PUT', path: '/v1/p/weights/:day', scope: 'person', phase: 'v0.12', ctl: false, area: 'weight',
    params: z.object({ day: DayKeySchema }), body: WeightBodySchema, response: OkReplySchema, summary: "Set a day's weight.",
  }),
  personWeightDelete: route({
    method: 'DELETE', path: '/v1/p/weights/:day', scope: 'person', phase: 'v0.12', ctl: false, area: 'weight',
    params: z.object({ day: DayKeySchema }), response: OkReplySchema, summary: "Remove a day's weight.",
  }),
  personMirror: route({
    method: 'GET', path: '/v1/p/mirror/:area', scope: 'person', phase: 'v0.12', ctl: false,
    params: MirrorParamsSchema, query: DayQuerySchema, summary: 'Exactly what the owner sees of one area ({locked: true} when off).',
  }),
  // --- Today, to-dos and reminders (area todos)
  personToday: route({
    method: 'GET', path: '/v1/p/today', scope: 'person', phase: 'v0.12', ctl: false, area: 'today',
    query: DayQuerySchema, response: PersonOwnTodaySchema, summary: 'Her Today: medicines, reminders and to-dos due.',
  }),
  personTodos: route({
    method: 'GET', path: '/v1/p/todos', scope: 'person', phase: 'v0.12', ctl: false, area: 'todos',
    query: TodosQuerySchema, response: PersonTodosResponseSchema, summary: 'Her to-dos.',
  }),
  personTodoCreate: route({
    method: 'POST', path: '/v1/p/todos', scope: 'person', phase: 'v0.12', ctl: false, area: 'todos', status: 201,
    body: TodoBodySchema, response: IdReplySchema, summary: 'Add a to-do of hers.',
  }),
  personTodoUpdate: route({
    method: 'PATCH', path: '/v1/p/todos/:id', scope: 'person', phase: 'v0.12', ctl: false, area: 'todos',
    params: LifeIdParamsSchema, body: TodoPatchSchema, response: OkReplySchema, summary: 'Edit a to-do of hers (409 assigned on his).',
  }),
  personTodoDelete: route({
    method: 'DELETE', path: '/v1/p/todos/:id', scope: 'person', phase: 'v0.12', ctl: false, area: 'todos',
    params: LifeIdParamsSchema, response: OkReplySchema, summary: 'Delete a to-do of hers (409 assigned on his).',
  }),
  personTodoDone: route({
    method: 'POST', path: '/v1/p/todos/:id/done', scope: 'person', phase: 'v0.12', ctl: false, area: 'todos',
    params: LifeIdParamsSchema, body: PersonTodoDoneBodySchema, response: OkReplySchema, summary: 'Done or Undo, with an optional report.',
  }),
  personTodoSnooze: route({
    method: 'POST', path: '/v1/p/todos/:id/snooze', scope: 'person', phase: 'v0.12', ctl: false, area: 'todos',
    params: LifeIdParamsSchema, body: SnoozeBodySchema, response: OkReplySchema, summary: 'Snooze (409 when he marked it no snooze).',
  }),
  personTodoSkip: route({
    method: 'POST', path: '/v1/p/todos/:id/skip', scope: 'person', phase: 'v0.12', ctl: false, area: 'todos',
    params: LifeIdParamsSchema, body: PersonTodoSkipBodySchema, response: OkReplySchema, summary: 'Skip with an optional reason (never scored).',
  }),
  personTodoAck: route({
    method: 'POST', path: '/v1/p/todos/:id/ack', scope: 'person', phase: 'v0.12', ctl: false, area: 'todos',
    params: LifeIdParamsSchema, response: OkReplySchema, summary: '"Got it" on an item he assigned.',
  }),
  personTodoAsk: route({
    method: 'POST', path: '/v1/p/todos/:id/ask', scope: 'person', phase: 'v0.12', ctl: false, area: 'todos',
    params: LifeIdParamsSchema, body: PersonTodoAskBodySchema, response: OkReplySchema, summary: 'Ask to change an item he assigned.',
  }),
  personProjects: route({
    method: 'GET', path: '/v1/p/projects', scope: 'person', phase: 'v0.12', ctl: false, area: 'todos',
    response: z.object({ projects: z.array(ProjectViewSchema) }), summary: 'Her projects.',
  }),
  personProjectCreate: route({
    method: 'POST', path: '/v1/p/projects', scope: 'person', phase: 'v0.12', ctl: false, area: 'todos', status: 201,
    body: ProjectBodySchema.omit({ folder: true }).strict(), response: IdReplySchema, summary: 'Add a project of hers (no folder).',
  }),
  personProjectUpdate: route({
    method: 'PATCH', path: '/v1/p/projects/:id', scope: 'person', phase: 'v0.12', ctl: false, area: 'todos',
    params: LifeIdParamsSchema, body: ProjectPatchSchema.omit({ folder: true }).strict(), response: OkReplySchema, summary: 'Edit a project of hers.',
  }),
  personProjectDelete: route({
    method: 'DELETE', path: '/v1/p/projects/:id', scope: 'person', phase: 'v0.12', ctl: false, area: 'todos',
    params: LifeIdParamsSchema, response: OkReplySchema, summary: 'Delete a project of hers; its to-dos move to none.',
  }),

} as const satisfies Record<string, RouteDef>;

/** Her medicines and food (spec 1.3.2): defined here, served when their handlers land (a later commit of P1). */
export const PERSON_HEALTH_ROUTES = {
  personMeds: route({
    method: 'GET', path: '/v1/p/medicines', scope: 'person', phase: 'v0.12', ctl: false, area: 'meds',
    query: DayQuerySchema, response: PersonMedicinesResponseSchema, summary: 'Her medicines and a day of doses.',
  }),
  personMedCreate: route({
    method: 'POST', path: '/v1/p/medicines', scope: 'person', phase: 'v0.12', ctl: false, area: 'meds', status: 201,
    body: MedicineBodySchema, response: IdReplySchema, summary: 'Add a medicine of hers.',
  }),
  personMedUpdate: route({
    method: 'PATCH', path: '/v1/p/medicines/:id', scope: 'person', phase: 'v0.12', ctl: false, area: 'meds',
    params: LifeIdParamsSchema, body: MedicinePatchSchema, response: OkReplySchema, summary: 'Edit any of her medicines, his additions included.',
  }),
  personMedStop: route({
    method: 'POST', path: '/v1/p/medicines/:id/stop', scope: 'person', phase: 'v0.12', ctl: false, area: 'meds',
    params: LifeIdParamsSchema, response: OkReplySchema, summary: 'Stop one of her medicines from today.',
  }),
  personDoseLog: route({
    method: 'POST', path: '/v1/p/medicines/:id/doses', scope: 'person', phase: 'v0.12', ctl: false, area: 'meds', status: 201,
    params: LifeIdParamsSchema, body: DoseBodySchema, response: IdReplySchema, summary: 'Log a dose (only she does).',
  }),
  personDoseDelete: route({
    method: 'DELETE', path: '/v1/p/medicines/:id/doses/:doseId', scope: 'person', phase: 'v0.12', ctl: false, area: 'meds',
    params: DoseParamsSchema, response: OkReplySchema, summary: 'Undo a dose.',
  }),
  personFoodDay: route({
    method: 'GET', path: '/v1/p/food', scope: 'person', phase: 'v0.12', ctl: false, area: 'food',
    query: DayQuerySchema, response: FoodDaySchema, summary: 'Her food log (404 module_off while her food module is off).',
  }),
  personFoodAdd: route({
    method: 'POST', path: '/v1/p/food', scope: 'person', phase: 'v0.12', ctl: false, area: 'food', status: 201,
    body: FoodBodySchema, response: IdReplySchema, summary: 'Add a meal.',
  }),
  personFoodUpdate: route({
    method: 'PATCH', path: '/v1/p/food/:id', scope: 'person', phase: 'v0.12', ctl: false, area: 'food',
    params: LifeIdParamsSchema, body: FoodPatchSchema, response: OkReplySchema, summary: 'Edit a meal.',
  }),
  personFoodDelete: route({
    method: 'DELETE', path: '/v1/p/food/:id', scope: 'person', phase: 'v0.12', ctl: false, area: 'food',
    params: LifeIdParamsSchema, response: OkReplySchema, summary: 'Delete a meal.',
  }),
  personFoodTargets: route({
    method: 'PUT', path: '/v1/p/food/targets', scope: 'person', phase: 'v0.12', ctl: false, area: 'food',
    body: FoodTargetsBodySchema, response: OkReplySchema, summary: 'Her calorie target and goal weight.',
  }),
} as const satisfies Record<string, RouteDef>;

/** Her P2 routes (spec 1.3.2): status and the sharing check-in, the day plan and evening review, sleep, the journal and alerts. */
const dayParams = z.object({ day: DayKeySchema });
const stepParams = z.object({ day: DayKeySchema, stepId: StepIdSchema });
const nightParams = z.object({ night: DayKeySchema });
const commentParams = z.object({ id: LifeIdSchema, cid: LifeIdSchema });
export const PERSON_DAYS_ROUTES = {
  personStatus: route({
    method: 'PUT', path: '/v1/p/status', scope: 'person', phase: 'v0.12', ctl: false, area: 'plan',
    body: PersonStatusBodySchema, response: z.object({ status: PersonStatusSchema.nullable() }), summary: 'Her status: Okay, Low or Need space, with a short line (hers alone).',
  }),
  personSharingCheckin: route({
    method: 'POST', path: '/v1/p/sharing/checkin', scope: 'person', phase: 'v0.12', ctl: false,
    body: SharingCheckinBodySchema, response: OkReplySchema, summary: 'Her answer to the 14-day sharing check-in (private unless she tells him).',
  }),
  // --- the day plan (area plan) and the evening review (area review)
  personPlanGet: route({
    method: 'GET', path: '/v1/p/plans/:day', scope: 'person', phase: 'v0.12', ctl: false, area: 'plan',
    params: dayParams, response: PlanViewSchema, summary: 'Her plan for a day.',
  }),
  personPlanAck: route({
    method: 'POST', path: '/v1/p/plans/:day/ack', scope: 'person', phase: 'v0.12', ctl: false, area: 'plan',
    params: dayParams, response: OkReplySchema, summary: '"Got it" on the plan.',
  }),
  personStepAdd: route({
    method: 'POST', path: '/v1/p/plans/:day/steps', scope: 'person', phase: 'v0.12', ctl: false, area: 'plan', status: 201,
    params: dayParams, body: StepBodySchema, response: z.object({ id: StepIdSchema }), summary: 'Add a step of her own.',
  }),
  personStepUpdate: route({
    method: 'PATCH', path: '/v1/p/plans/:day/steps/:stepId', scope: 'person', phase: 'v0.12', ctl: false, area: 'plan',
    params: stepParams, body: StepPatchSchema, response: OkReplySchema, summary: 'Edit her step; on his, only ring and focus for herself.',
  }),
  personStepDelete: route({
    method: 'DELETE', path: '/v1/p/plans/:day/steps/:stepId', scope: 'person', phase: 'v0.12', ctl: false, area: 'plan',
    params: stepParams, response: OkReplySchema, summary: 'Delete a step of her own (409 assigned on his).',
  }),
  personStepState: route({
    method: 'POST', path: '/v1/p/plans/:day/steps/:stepId/state', scope: 'person', phase: 'v0.12', ctl: false, area: 'plan',
    params: stepParams, body: StepStateBodySchema, response: OkReplySchema, summary: 'Start, done (with an optional report), skip (with an optional reason) or undo.',
  }),
  personStepAck: route({
    method: 'POST', path: '/v1/p/plans/:day/steps/:stepId/ack', scope: 'person', phase: 'v0.12', ctl: false, area: 'plan',
    params: stepParams, response: OkReplySchema, summary: '"Got it" on one step.',
  }),
  personStepCheckin: route({
    method: 'POST', path: '/v1/p/plans/:day/steps/:stepId/checkin', scope: 'person', phase: 'v0.12', ctl: false, area: 'plan',
    params: stepParams, body: StepCheckinBodySchema, response: OkReplySchema, summary: 'Answer a check-in step: mood, energy, a line, anything needed.',
  }),
  personStepAsk: route({
    method: 'POST', path: '/v1/p/plans/:day/steps/:stepId/ask', scope: 'person', phase: 'v0.12', ctl: false, area: 'plan',
    params: stepParams, body: StepAskBodySchema, response: OkReplySchema, summary: 'Ask to change a step he planned (a change request alert).',
  }),
  personStepCarry: route({
    method: 'POST', path: '/v1/p/plans/:day/steps/:stepId/carry', scope: 'person', phase: 'v0.12', ctl: false, area: 'plan',
    params: stepParams, body: StepCarryBodySchema, response: OkReplySchema, summary: 'Carry an open step of hers to a later day.',
  }),
  personBetweenTick: route({
    method: 'POST', path: '/v1/p/plans/:day/between/:bid/tick', scope: 'person', phase: 'v0.12', ctl: false, area: 'plan',
    params: z.object({ day: DayKeySchema, bid: StepIdSchema }), body: BetweenTickBodySchema, response: OkReplySchema, summary: 'Tick or untick a check-between slot.',
  }),
  personRoughDay: route({
    method: 'POST', path: '/v1/p/plans/:day/rough', scope: 'person', phase: 'v0.12', ctl: false, area: 'plan',
    params: dayParams, body: RoughBodySchema, response: OkReplySchema, summary: 'A rough day: the rest of today is excused.',
  }),
  personRoughDayUndo: route({
    method: 'DELETE', path: '/v1/p/plans/:day/rough', scope: 'person', phase: 'v0.12', ctl: false, area: 'plan',
    params: dayParams, response: OkReplySchema, summary: 'Undo a rough day (the same day).',
  }),
  personReviewGet: route({
    method: 'GET', path: '/v1/p/plans/:day/review', scope: 'person', phase: 'v0.12', ctl: false, area: 'review',
    params: dayParams, response: ReviewViewSchema, summary: 'Her evening review: live until sent, stored after.',
  }),
  personReviewSend: route({
    method: 'POST', path: '/v1/p/plans/:day/review', scope: 'person', phase: 'v0.12', ctl: false, area: 'review',
    params: dayParams, body: ReviewSendBodySchema, response: OkReplySchema, summary: 'Send the evening review (once a day).',
  }),
  // --- sleep (area sleep)
  personSleep: route({
    method: 'GET', path: '/v1/p/sleep', scope: 'person', phase: 'v0.12', ctl: false, area: 'sleep',
    query: SleepQuerySchema, response: SleepWeekSchema, summary: 'Her nights and the week.',
  }),
  personSleepStart: route({
    method: 'POST', path: '/v1/p/sleep/start', scope: 'person', phase: 'v0.12', ctl: false, area: 'sleep',
    body: SleepStartBodySchema, response: z.object({ id: LifeIdSchema, night: DayKeySchema }), summary: '"Going to sleep" (409 open when a night is already open).',
  }),
  personSleepWake: route({
    method: 'POST', path: '/v1/p/sleep/wake', scope: 'person', phase: 'v0.12', ctl: false, area: 'sleep',
    body: SleepWakeBodySchema, response: OkReplySchema, summary: '"Woke up" (409 none_open with no night open).',
  }),
  personSleepPut: route({
    method: 'PUT', path: '/v1/p/sleep/:night', scope: 'person', phase: 'v0.12', ctl: false, area: 'sleep',
    params: nightParams, body: SleepPutBodySchema, response: OkReplySchema, summary: 'Add or correct a night.',
  }),
  personSleepDelete: route({
    method: 'DELETE', path: '/v1/p/sleep/:night', scope: 'person', phase: 'v0.12', ctl: false, area: 'sleep',
    params: nightParams, response: OkReplySchema, summary: 'Delete a night.',
  }),
  // --- journal (area journal)
  personJournal: route({
    method: 'GET', path: '/v1/p/journal', scope: 'person', phase: 'v0.12', ctl: false, area: 'journal',
    query: JournalQuerySchema, response: JournalListSchema, summary: 'Her journal, newest first, with comment counts and the streak.',
  }),
  personJournalGet: route({
    method: 'GET', path: '/v1/p/journal/:id', scope: 'person', phase: 'v0.12', ctl: false, area: 'journal',
    params: LifeIdParamsSchema, response: JournalEntryFullSchema, summary: 'One entry and its comments.',
  }),
  personJournalCreate: route({
    method: 'POST', path: '/v1/p/journal', scope: 'person', phase: 'v0.12', ctl: false, area: 'journal', status: 201,
    body: JournalCreateBodySchema, response: IdReplySchema, summary: 'Write an entry or a check-in (idempotent on clientId).',
  }),
  personJournalUpdate: route({
    method: 'PATCH', path: '/v1/p/journal/:id', scope: 'person', phase: 'v0.12', ctl: false, area: 'journal',
    params: LifeIdParamsSchema, body: JournalPatchBodySchema, response: OkReplySchema, summary: 'Edit an entry of hers.',
  }),
  personJournalDelete: route({
    method: 'DELETE', path: '/v1/p/journal/:id', scope: 'person', phase: 'v0.12', ctl: false, area: 'journal',
    params: LifeIdParamsSchema, response: OkReplySchema, summary: 'Delete an entry of hers (and its comments).',
  }),
  personJournalComment: route({
    method: 'POST', path: '/v1/p/journal/:id/comments', scope: 'person', phase: 'v0.12', ctl: false, area: 'journal', status: 201,
    params: LifeIdParamsSchema, body: JournalCommentBodySchema, response: IdReplySchema, summary: 'Her comment or reply under an entry.',
  }),
  personJournalCommentDelete: route({
    method: 'DELETE', path: '/v1/p/journal/:id/comments/:cid', scope: 'person', phase: 'v0.12', ctl: false, area: 'journal',
    params: commentParams, response: OkReplySchema, summary: 'Delete a comment of hers (his: 404).',
  }),
  // --- alerts with the owner (always on)
  personAlerts: route({
    method: 'GET', path: '/v1/p/alerts', scope: 'person', phase: 'v0.12', ctl: false,
    response: AlertsResponseSchema, summary: 'Alerts with the owner, both ways, newest first (90 days).',
  }),
  personAlertSend: route({
    method: 'POST', path: '/v1/p/alerts', scope: 'person', phase: 'v0.12', ctl: false, status: 201,
    body: AlertSendBodySchema, response: AlertSendReplySchema, summary: 'Send the owner an alert.',
  }),
  personAlertSeen: route({
    method: 'POST', path: '/v1/p/alerts/:id/seen', scope: 'person', phase: 'v0.12', ctl: false,
    params: LifeIdParamsSchema, response: OkReplySchema, summary: 'She opened an alert from him.',
  }),
  personAlertReply: route({
    method: 'POST', path: '/v1/p/alerts/:id/reply', scope: 'person', phase: 'v0.12', ctl: false,
    params: LifeIdParamsSchema, body: AlertReplyBodySchema, response: OkReplySchema, summary: 'One-tap reply to an alert from him.',
  }),
} as const satisfies Record<string, RouteDef>;

/** The owner's People routes about the person (spec 9.3.4). */
const PEOPLE_ROUTES_BASE = {
  peopleList: route({
    method: 'GET', path: '/v1/people', scope: 'control', phase: 'v0.12', ctl: true,
    response: PeopleListSchema, summary: 'The people on this Mac: name, state and the agreement (no last-seen, C20).',
  }),
  personGet: route({
    method: 'GET', path: '/v1/people/:pid', scope: 'control', phase: 'v0.12', ctl: false,
    params: PidParamsSchema, response: PersonResponseSchema, summary: 'One person.',
  }),
} as const satisfies Record<string, RouteDef>;

/** The owner's reads and writes in her space (spec 9.3.4), each declaring its area (M9). */
export const PEOPLE_LIFE_ROUTES = {
  personOwnerWeights: route({
    method: 'GET', path: '/v1/people/:pid/weights', scope: 'control', phase: 'v0.12', ctl: false, area: 'weight',
    params: PidParamsSchema, response: OwnerWeightViewSchema, summary: 'Her weights (see.weight).',
  }),
  personOwnerWeightUpdate: route({
    method: 'PATCH', path: '/v1/people/:pid/weights/:day', scope: 'control', phase: 'v0.12', ctl: false, area: 'weight',
    params: PidDayParamsSchema, body: WeightBodySchema, response: OkReplySchema, summary: 'Correct a weight she logged (editHers.weight); never a new one.',
  }),
  personOwnerWeightDelete: route({
    method: 'DELETE', path: '/v1/people/:pid/weights/:day', scope: 'control', phase: 'v0.12', ctl: false, area: 'weight',
    params: PidDayParamsSchema, response: OkReplySchema, summary: 'Remove a weight she logged (editHers.weight).',
  }),
  personOwnerToday: route({
    method: 'GET', path: '/v1/people/:pid/today', scope: 'control', phase: 'v0.12', ctl: false, area: 'today',
    params: PidParamsSchema, query: DayQuerySchema, response: PersonTodaySchema, summary: 'Her Today as the agreement allows (locked tiles for off areas).',
  }),
  personOwnerTodos: route({
    method: 'GET', path: '/v1/people/:pid/todos', scope: 'control', phase: 'v0.12', ctl: true, area: 'todos',
    params: PidParamsSchema, query: TodosQuerySchema, response: OwnerTodosViewSchema, summary: 'Her to-dos (see.todos).',
  }),
  personAssign: route({
    method: 'POST', path: '/v1/people/:pid/todos', scope: 'control', phase: 'v0.12', ctl: false, area: 'todos', status: 201,
    params: PidParamsSchema, body: AssignTodoBodySchema, response: IdReplySchema, summary: 'Assign a to-do or reminder to her (assign.todos).',
  }),
  personOwnerTodoUpdate: route({
    method: 'PATCH', path: '/v1/people/:pid/todos/:id', scope: 'control', phase: 'v0.12', ctl: false, area: 'todos',
    params: PidIdParamsSchema, body: AssignTodoPatchSchema, response: OkReplySchema, summary: 'Edit his item (assign.todos) or hers (editHers.todos).',
  }),
  personOwnerTodoDelete: route({
    method: 'DELETE', path: '/v1/people/:pid/todos/:id', scope: 'control', phase: 'v0.12', ctl: false, area: 'todos',
    params: PidIdParamsSchema, response: OkReplySchema, summary: 'Delete his item (assign.todos) or hers (editHers.todos).',
  }),
} as const satisfies Record<string, RouteDef>;

/** His reads and writes of her medicines and food: defined here, served when their handlers land. */
export const PEOPLE_HEALTH_ROUTES = {
  personOwnerMeds: route({
    method: 'GET', path: '/v1/people/:pid/medicines', scope: 'control', phase: 'v0.12', ctl: false, area: 'meds',
    params: PidParamsSchema, query: DayQuerySchema, response: OwnerMedsViewSchema, summary: 'Her medicines at the agreed level.',
  }),
  personMedAssign: route({
    method: 'POST', path: '/v1/people/:pid/medicines', scope: 'control', phase: 'v0.12', ctl: false, area: 'meds', status: 201,
    params: PidParamsSchema, body: MedicineBodySchema, response: IdReplySchema, summary: 'Add a medicine for her (assign.meds).',
  }),
  personOwnerMedUpdate: route({
    method: 'PATCH', path: '/v1/people/:pid/medicines/:id', scope: 'control', phase: 'v0.12', ctl: false, area: 'meds',
    params: PidIdParamsSchema, body: MedicinePatchSchema, response: OkReplySchema, summary: 'Edit his addition (assign.meds) or hers (editHers.meds).',
  }),
  personOwnerMedStop: route({
    method: 'POST', path: '/v1/people/:pid/medicines/:id/stop', scope: 'control', phase: 'v0.12', ctl: false, area: 'meds',
    params: PidIdParamsSchema, response: OkReplySchema, summary: 'Stop his addition (assign.meds) or hers (editHers.meds).',
  }),
  personOwnerFood: route({
    method: 'GET', path: '/v1/people/:pid/food', scope: 'control', phase: 'v0.12', ctl: false, area: 'food',
    params: PidParamsSchema, query: DayQuerySchema, response: OwnerFoodViewSchema, summary: 'Her food log (see.food; 404 while her module is off).',
  }),
} as const satisfies Record<string, RouteDef>;

/** His P2 routes in her space (spec 9.3.4): plans and templates, her review, sleep and journal; alerts and his prefs. */
const pidDay = z.object({ pid: LifeIdSchema, day: DayKeySchema });
export const PEOPLE_DAYS_ROUTES = {
  personPlanOwnerGet: route({
    method: 'GET', path: '/v1/people/:pid/plans/:day', scope: 'control', phase: 'v0.12', ctl: false, area: 'plan',
    params: pidDay, response: PlanViewSchema, summary: 'Her plan for a day (see.plan).',
  }),
  personPlanPut: route({
    method: 'PUT', path: '/v1/people/:pid/plans/:day', scope: 'control', phase: 'v0.12', ctl: false, area: 'plan',
    params: pidDay, body: PlanPutBodySchema, response: PlanViewSchema, summary: 'Set her plan for a day (assign.plan; her steps only with editHers.plan; 409 on a stale srev).',
  }),
  personPlanDelete: route({
    method: 'DELETE', path: '/v1/people/:pid/plans/:day', scope: 'control', phase: 'v0.12', ctl: false, area: 'plan',
    params: pidDay, response: OkReplySchema, summary: 'Remove his steps from a day (hers too with editHers.plan).',
  }),
  personPlanApply: route({
    method: 'POST', path: '/v1/people/:pid/plans/:day/apply', scope: 'control', phase: 'v0.12', ctl: false, area: 'plan',
    params: pidDay, body: PlanApplyBodySchema, response: PlanViewSchema, summary: 'Apply a template to a day (replace or append).',
  }),
  personOwnerReview: route({
    method: 'GET', path: '/v1/people/:pid/plans/:day/review', scope: 'control', phase: 'v0.12', ctl: false, area: 'review',
    params: pidDay, response: ReviewViewSchema, summary: 'Her evening review at his level (see.review: counts or full).',
  }),
  personReviewCarry: route({
    method: 'POST', path: '/v1/people/:pid/plans/:day/review/carry', scope: 'control', phase: 'v0.12', ctl: false, area: 'plan',
    params: pidDay, body: ReviewCarryBodySchema, response: OkReplySchema, summary: 'Carry open steps to a later day (his; hers with editHers.plan).',
  }),
  personTemplates: route({
    method: 'GET', path: '/v1/people/:pid/templates', scope: 'control', phase: 'v0.12', ctl: false, area: 'plan',
    params: PidParamsSchema, response: TemplatesResponseSchema, summary: 'Her plan templates (assign.plan).',
  }),
  personTemplateCreate: route({
    method: 'POST', path: '/v1/people/:pid/templates', scope: 'control', phase: 'v0.12', ctl: false, area: 'plan', status: 201,
    params: PidParamsSchema, body: TemplateBodySchema, response: IdReplySchema, summary: 'Save a plan template (up to 20).',
  }),
  personTemplateUpdate: route({
    method: 'PATCH', path: '/v1/people/:pid/templates/:tid', scope: 'control', phase: 'v0.12', ctl: false, area: 'plan',
    params: z.object({ pid: LifeIdSchema, tid: LifeIdSchema }), body: TemplatePatchSchema, response: OkReplySchema, summary: 'Rename or edit a template.',
  }),
  personTemplateDelete: route({
    method: 'DELETE', path: '/v1/people/:pid/templates/:tid', scope: 'control', phase: 'v0.12', ctl: false, area: 'plan',
    params: z.object({ pid: LifeIdSchema, tid: LifeIdSchema }), response: OkReplySchema, summary: 'Delete a template.',
  }),
  personOwnerSleep: route({
    method: 'GET', path: '/v1/people/:pid/sleep', scope: 'control', phase: 'v0.12', ctl: false, area: 'sleep',
    params: PidParamsSchema, query: SleepQuerySchema, response: SleepWeekSchema, summary: 'Her sleep week (see.sleep). He never adds, edits or deletes a night.',
  }),
  personOwnerJournal: route({
    method: 'GET', path: '/v1/people/:pid/journal', scope: 'control', phase: 'v0.12', ctl: false, area: 'journal',
    params: PidParamsSchema, query: JournalQuerySchema, response: JournalListSchema, summary: 'Her journal (see.journal), read only.',
  }),
  personOwnerJournalGet: route({
    method: 'GET', path: '/v1/people/:pid/journal/:id', scope: 'control', phase: 'v0.12', ctl: false, area: 'journal',
    params: PidIdParamsSchema, response: JournalEntryFullSchema, summary: 'One entry of hers and its comments.',
  }),
  personOwnerJournalComment: route({
    method: 'POST', path: '/v1/people/:pid/journal/:id/comments', scope: 'control', phase: 'v0.12', ctl: false, area: 'journal', status: 201,
    params: PidIdParamsSchema, body: JournalCommentBodySchema, response: IdReplySchema, summary: 'Comment under an entry of hers (comment.journal).',
  }),
  personOwnerJournalCommentDelete: route({
    method: 'DELETE', path: '/v1/people/:pid/journal/:id/comments/:cid', scope: 'control', phase: 'v0.12', ctl: false, area: 'journal',
    params: z.object({ pid: LifeIdSchema, id: LifeIdSchema, cid: LifeIdSchema }), response: OkReplySchema, summary: 'Delete a comment of his.',
  }),
  peopleAlerts: route({
    method: 'GET', path: '/v1/people/alerts', scope: 'control', phase: 'v0.12', ctl: false,
    query: AlertsQuerySchema, response: AlertsResponseSchema, summary: 'Alerts with her, both ways, newest first (90 days).',
  }),
  peopleAlertSend: route({
    method: 'POST', path: '/v1/people/alerts', scope: 'control', phase: 'v0.12', ctl: false, status: 201,
    body: OwnerAlertSendBodySchema, response: AlertSendReplySchema, summary: 'Send her an alert or a nudge, within her caps.',
  }),
  peopleAlertSeen: route({
    method: 'POST', path: '/v1/people/alerts/:id/seen', scope: 'control', phase: 'v0.12', ctl: false,
    params: LifeIdParamsSchema, response: OkReplySchema, summary: 'He opened an alert from her.',
  }),
  peopleAlertReply: route({
    method: 'POST', path: '/v1/people/alerts/:id/reply', scope: 'control', phase: 'v0.12', ctl: false,
    params: LifeIdParamsSchema, body: AlertReplyBodySchema, response: OkReplySchema, summary: 'One-tap reply to an alert from her.',
  }),
  peopleOwnerPrefs: route({
    method: 'PATCH', path: '/v1/people/prefs', scope: 'control', phase: 'v0.12', ctl: false,
    body: OwnerPeoplePrefsPatchSchema, response: OwnerPeoplePrefsReplySchema, summary: 'His quiet hours, caps and mute for pushes about her, the day summary and the review push.',
  }),
} as const satisfies Record<string, RouteDef>;

/** Her chat (P3, spec 1.3.2): her thread only; area `chat` decides only whether {owner} can read it. */
const chatN = ChatItemParamsSchema;
export const PERSON_CHAT_ROUTES = {
  personChatList: route({
    method: 'GET', path: '/v1/p/chat', scope: 'person', phase: 'v0.12', ctl: false, area: 'chat',
    query: ChatListQuerySchema, response: PersonChatListSchema, summary: 'Her thread: the newest turns, messages left today and the disclosure.',
  }),
  personChatSend: route({
    method: 'POST', path: '/v1/p/chat', scope: 'person', phase: 'v0.12', ctl: false, area: 'chat', status: 202,
    body: ChatSendBodySchema, response: IdReplySchema, summary: 'Send a message to her assistant (her daily cap applies).',
  }),
  personChatClear: route({
    method: 'DELETE', path: '/v1/p/chat', scope: 'person', phase: 'v0.12', ctl: false, area: 'chat',
    response: OkReplySchema, summary: 'Clear her thread (his is untouched): gone for both, with no trace.',
  }),
  personChatStatus: route({
    method: 'GET', path: '/v1/p/chat/status', scope: 'person', phase: 'v0.12', ctl: false, area: 'chat',
    response: PersonChatStatusSchema, summary: 'Her thread\'s size, messages left today and whether it can run.',
  }),
  personChatCancel: route({
    method: 'POST', path: '/v1/p/chat/turns/:id/cancel', scope: 'person', phase: 'v0.12', ctl: false, area: 'chat',
    params: ChatTurnParamsSchema, response: OkReplySchema, summary: 'Stop a waiting or running turn of hers.',
  }),
  personChatTurnDelete: route({
    method: 'DELETE', path: '/v1/p/chat/turns/:id', scope: 'person', phase: 'v0.12', ctl: false, area: 'chat',
    params: ChatTurnParamsSchema, response: OkReplySchema, summary: 'Delete one turn of hers: gone for both, with no trace.',
  }),
  personChatUndo: route({
    method: 'POST', path: '/v1/p/chat/turns/:id/changes/:n/undo', scope: 'person', phase: 'v0.12', ctl: false, area: 'chat',
    params: chatN, response: OkReplySchema, summary: 'Undo one change her assistant made.',
  }),
  personChatCard: route({
    method: 'POST', path: '/v1/p/chat/turns/:id/cards/:n', scope: 'person', phase: 'v0.12', ctl: false, area: 'chat',
    params: chatN, response: OkReplySchema, summary: 'Run a card of hers (Confirm or Do it).',
  }),
  personChatDismiss: route({
    method: 'POST', path: '/v1/p/chat/turns/:id/cards/:n/dismiss', scope: 'person', phase: 'v0.12', ctl: false, area: 'chat',
    params: chatN, response: OkReplySchema, summary: 'Dismiss a card of hers.',
  }),
  personChatPhotoCreate: route({
    method: 'POST', path: '/v1/p/chat/photos', scope: 'person', phase: 'v0.12', ctl: false, area: 'chat', rawBody: { maxBytes: CHAT_PHOTO_MAX_BYTES },
    response: IdReplySchema, summary: 'Store one photo for her next message (location and camera details stripped first).',
  }),
  personChatPhotoGet: route({
    method: 'GET', path: '/v1/p/chat/photos/:id', scope: 'person', phase: 'v0.12', ctl: false, area: 'chat', rawResponse: true,
    params: ChatPhotoParamsSchema, summary: 'A photo of her thread (another thread\'s: 404).',
  }),
  personChatPhotoDelete: route({
    method: 'DELETE', path: '/v1/p/chat/photos/:id', scope: 'person', phase: 'v0.12', ctl: false, area: 'chat',
    params: ChatPhotoParamsSchema, response: OkReplySchema, summary: 'Drop a photo of hers not yet sent.',
  }),
} as const satisfies Record<string, RouteDef>;

/** Shared lists, her side (P4, spec 1.3.2): her shared space only; always both people's, so no area. */
export const PERSON_LIST_ROUTES = {
  personPlaces: route({
    method: 'GET', path: '/v1/p/places', scope: 'person', phase: 'v0.12', ctl: false,
    query: PlacesQuerySchema, response: PlacesResponseSchema, summary: 'The cafés she shares with the owner.',
  }),
  personPlaceGet: route({
    method: 'GET', path: '/v1/p/places/:id', scope: 'person', phase: 'v0.12', ctl: false,
    params: LifeIdParamsSchema, query: PlaceGetQuerySchema, response: PlaceDetailSchema, summary: 'One shared café and a page of its visits.',
  }),
  personPlaceCreate: route({
    method: 'POST', path: '/v1/p/places', scope: 'person', phase: 'v0.12', ctl: false, status: 201,
    body: PlaceBodySchema, response: IdReplySchema, summary: 'Add a café to the shared list (always shared).',
  }),
  personPlaceUpdate: route({
    method: 'PATCH', path: '/v1/p/places/:id', scope: 'person', phase: 'v0.12', ctl: false,
    params: LifeIdParamsSchema, body: PlacePatchSchema, response: OkReplySchema, summary: 'Edit, rate or change dishes of a shared café ("Edited by").',
  }),
  personPlaceDelete: route({
    method: 'DELETE', path: '/v1/p/places/:id', scope: 'person', phase: 'v0.12', ctl: false,
    params: LifeIdParamsSchema, response: OkReplySchema, summary: 'Delete a shared café for both (the owner is told).',
  }),
  personVisitCreate: route({
    method: 'POST', path: '/v1/p/places/:id/visits', scope: 'person', phase: 'v0.12', ctl: false, status: 201,
    params: LifeIdParamsSchema, body: PlaceVisitBodySchema, response: IdReplySchema, summary: 'Log her visit to a shared café.',
  }),
  personVisitUpdate: route({
    method: 'PATCH', path: '/v1/p/places/:id/visits/:visitId', scope: 'person', phase: 'v0.12', ctl: false,
    params: PlaceVisitParamsSchema, body: PlaceVisitPatchSchema, response: OkReplySchema, summary: 'Edit one of her own visits (C39).',
  }),
  personVisitDelete: route({
    method: 'DELETE', path: '/v1/p/places/:id/visits/:visitId', scope: 'person', phase: 'v0.12', ctl: false,
    params: PlaceVisitParamsSchema, response: OkReplySchema, summary: 'Delete one of her own visits (C39).',
  }),
  personLists: route({
    method: 'GET', path: '/v1/p/lists', scope: 'person', phase: 'v0.12', ctl: false,
    response: SharedListsResponseSchema, summary: 'The lists she shares with the owner.',
  }),
  personListCreate: route({
    method: 'POST', path: '/v1/p/lists', scope: 'person', phase: 'v0.12', ctl: false, status: 201,
    body: SharedListBodySchema, response: IdReplySchema, summary: 'Start a shared list (shopping, to watch, to read, plain).',
  }),
  personListUpdate: route({
    method: 'PATCH', path: '/v1/p/lists/:id', scope: 'person', phase: 'v0.12', ctl: false,
    params: listParams, body: SharedListPatchSchema, response: OkReplySchema, summary: 'Rename a shared list.',
  }),
  personListDelete: route({
    method: 'DELETE', path: '/v1/p/lists/:id', scope: 'person', phase: 'v0.12', ctl: false,
    params: listParams, response: OkReplySchema, summary: 'Delete a shared list for both (the owner is told).',
  }),
  personListItems: route({
    method: 'GET', path: '/v1/p/lists/:id/items', scope: 'person', phase: 'v0.12', ctl: false,
    params: listParams, response: SharedItemsResponseSchema, summary: "A shared list's items.",
  }),
  personListItemAdd: route({
    method: 'POST', path: '/v1/p/lists/:id/items', scope: 'person', phase: 'v0.12', ctl: false, status: 201,
    params: listParams, body: SharedItemBodySchema, response: IdReplySchema, summary: 'Add an item to a shared list.',
  }),
  personListItemUpdate: route({
    method: 'PATCH', path: '/v1/p/lists/:id/items/:itemId', scope: 'person', phase: 'v0.12', ctl: false,
    params: itemParams, body: SharedItemPatchSchema, response: OkReplySchema, summary: 'Edit an item (either person).',
  }),
  personListItemDelete: route({
    method: 'DELETE', path: '/v1/p/lists/:id/items/:itemId', scope: 'person', phase: 'v0.12', ctl: false,
    params: itemParams, response: OkReplySchema, summary: 'Delete an item (either person).',
  }),
  personListItemTick: route({
    method: 'POST', path: '/v1/p/lists/:id/items/:itemId/tick', scope: 'person', phase: 'v0.12', ctl: false,
    params: itemParams, body: SharedTickBodySchema, response: OkReplySchema, summary: 'Tick or untick an item (who ticked is recorded).',
  }),
} as const satisfies Record<string, RouteDef>;

/** Shared lists, his side (P4): the same lists through his People routes, plus "Assign to {her}". No area: always both people's. */
const pidList = z.object({ pid: LifeIdSchema, id: LifeIdSchema });
const pidItem = z.object({ pid: LifeIdSchema, id: LifeIdSchema, itemId: LifeIdSchema });
export const PEOPLE_LIST_ROUTES = {
  personOwnerLists: route({
    method: 'GET', path: '/v1/people/:pid/lists', scope: 'control', phase: 'v0.12', ctl: false,
    params: PidParamsSchema, response: SharedListsResponseSchema, summary: 'The lists you share with her.',
  }),
  personOwnerListCreate: route({
    method: 'POST', path: '/v1/people/:pid/lists', scope: 'control', phase: 'v0.12', ctl: false, status: 201,
    params: PidParamsSchema, body: SharedListBodySchema, response: IdReplySchema, summary: 'Start a list shared with her.',
  }),
  personOwnerListUpdate: route({
    method: 'PATCH', path: '/v1/people/:pid/lists/:id', scope: 'control', phase: 'v0.12', ctl: false,
    params: pidList, body: SharedListPatchSchema, response: OkReplySchema, summary: 'Rename a shared list.',
  }),
  personOwnerListDelete: route({
    method: 'DELETE', path: '/v1/people/:pid/lists/:id', scope: 'control', phase: 'v0.12', ctl: false,
    params: pidList, response: OkReplySchema, summary: 'Delete a shared list for both (she is told).',
  }),
  personOwnerListItems: route({
    method: 'GET', path: '/v1/people/:pid/lists/:id/items', scope: 'control', phase: 'v0.12', ctl: false,
    params: pidList, response: SharedItemsResponseSchema, summary: "A shared list's items.",
  }),
  personOwnerListItemAdd: route({
    method: 'POST', path: '/v1/people/:pid/lists/:id/items', scope: 'control', phase: 'v0.12', ctl: false, status: 201,
    params: pidList, body: SharedItemBodySchema, response: IdReplySchema, summary: 'Add an item to a shared list.',
  }),
  personOwnerListItemUpdate: route({
    method: 'PATCH', path: '/v1/people/:pid/lists/:id/items/:itemId', scope: 'control', phase: 'v0.12', ctl: false,
    params: pidItem, body: SharedItemPatchSchema, response: OkReplySchema, summary: 'Edit an item (either person).',
  }),
  personOwnerListItemDelete: route({
    method: 'DELETE', path: '/v1/people/:pid/lists/:id/items/:itemId', scope: 'control', phase: 'v0.12', ctl: false,
    params: pidItem, response: OkReplySchema, summary: 'Delete an item (either person).',
  }),
  personOwnerListItemTick: route({
    method: 'POST', path: '/v1/people/:pid/lists/:id/items/:itemId/tick', scope: 'control', phase: 'v0.12', ctl: false,
    params: pidItem, body: SharedTickBodySchema, response: OkReplySchema, summary: 'Tick or untick an item (who ticked is recorded).',
  }),
  personOwnerListItemAssign: route({
    method: 'POST', path: '/v1/people/:pid/lists/:id/items/:itemId/assign', scope: 'control', phase: 'v0.12', ctl: false, area: 'todos', status: 201,
    params: pidItem, response: IdReplySchema, summary: 'Assign to her: an unlinked to-do in her space with the item\'s title (assign.todos).',
  }),
} as const satisfies Record<string, RouteDef>;

/** His read-only view of her chat (P3, spec 7.8): GET only, area `chat`. No owner route writes to her thread (T14). */
export const PEOPLE_CHAT_ROUTES = {
  personOwnerChat: route({
    method: 'GET', path: '/v1/people/:pid/chat', scope: 'control', phase: 'v0.12', ctl: false, area: 'chat',
    params: PidParamsSchema, query: ChatListQuerySchema, response: OwnerChatViewSchema, summary: 'Her chat, read only (see.chat): her messages, the answers, photos and changes.',
  }),
  personOwnerChatPhoto: route({
    method: 'GET', path: '/v1/people/:pid/chat/photos/:id', scope: 'control', phase: 'v0.12', ctl: false, area: 'chat', rawResponse: true,
    params: z.object({ pid: LifeIdSchema, id: ChatPhotoParamsSchema.shape.id }), summary: 'A photo of her chat (see.chat).',
  }),
} as const satisfies Record<string, RouteDef>;

const PEOPLE_ACCOUNT_ROUTES = {
  personOwnerActivity: route({
    method: 'GET', path: '/v1/people/:pid/activity', scope: 'control', phase: 'v0.12', ctl: false,
    params: PidParamsSchema, query: ActivityQuerySchema, response: PersonActivityResponseSchema, summary: 'Her Activity: the same rows she sees.',
  }),
  personPropose: route({
    method: 'POST', path: '/v1/people/:pid/agreement', scope: 'admin', phase: 'v0.12', ctl: false,
    params: PidParamsSchema, body: PersonProposeBodySchema, response: OkReplySchema, summary: 'Ask her for more; waits for her Accept.',
  }),
  personOwnerDevices: route({
    method: 'GET', path: '/v1/people/:pid/devices', scope: 'control', phase: 'v0.12', ctl: true,
    params: PidParamsSchema, response: PersonDevicesResponseSchema, summary: 'Her devices: name, Access email, added (no last-seen).',
  }),
  personOwnerDeviceRevoke: route({
    method: 'DELETE', path: '/v1/people/:pid/devices/:did', scope: 'admin', phase: 'v0.12', ctl: true,
    params: PidDidParamsSchema, response: OkReplySchema, summary: 'Revoke one of her devices (409 last_device for her last one).',
  }),
  personInviteLink: route({
    method: 'GET', path: '/v1/people/:pid/invite', scope: 'admin', phase: 'v0.12', ctl: false,
    params: PidParamsSchema, response: PersonInviteReplySchema, summary: 'Show an unspent invite link again (an admin device, C14).',
  }),
  personColor: route({
    method: 'PATCH', path: '/v1/people/:pid', scope: 'control', phase: 'v0.12', ctl: false,
    params: PidParamsSchema, body: PersonColorBodySchema, response: OkReplySchema, summary: "Her colour on his screens, and her chat's daily cap.",
  }),
  personAdd: route({
    method: 'POST', path: '/v1/people', scope: 'admin', phase: 'v0.12', ctl: true, localOnly: true, status: 201,
    body: PersonAddBodySchema, response: IdReplySchema, summary: 'Add a person (the Mac only: jantar people add).',
  }),
  personOffer: route({
    method: 'POST', path: '/v1/people/:pid/offer', scope: 'admin', phase: 'v0.12', ctl: true, localOnly: true,
    params: PidParamsSchema, body: PersonOfferBodySchema, response: PersonOfferReplySchema, summary: 'Record the offer her invite carries.',
  }),
  personModules: route({
    method: 'PATCH', path: '/v1/people/:pid/modules', scope: 'admin', phase: 'v0.12', ctl: true, localOnly: true,
    params: PidParamsSchema, body: PersonModulesBodySchema, response: OkReplySchema, summary: 'Her food module (409 has_rows to turn off with rows).',
  }),
  personInvite: route({
    method: 'POST', path: '/v1/people/:pid/invite', scope: 'admin', phase: 'v0.12', ctl: true, localOnly: true,
    params: PidParamsSchema, response: PersonInviteReplySchema, summary: 'A 24-hour, single-use join link.',
  }),
  personInviteRevoke: route({
    method: 'DELETE', path: '/v1/people/:pid/invite', scope: 'admin', phase: 'v0.12', ctl: true, localOnly: true,
    params: PidParamsSchema, response: OkReplySchema, summary: 'Void an unspent join link.',
  }),
  personRemove: route({
    method: 'POST', path: '/v1/people/:pid/remove', scope: 'admin', phase: 'v0.12', ctl: true, localOnly: true,
    params: PidParamsSchema, body: PersonRemoveBodySchema, response: OkReplySchema, summary: 'End sharing: a 7-day window, or at once.',
  }),
  peopleSwitch: route({
    method: 'POST', path: '/v1/people/switch', scope: 'admin', phase: 'v0.12', ctl: true, localOnly: true,
    body: PeopleSwitchBodySchema, response: OkReplySchema, summary: 'Turn People on or off (her exits keep working).',
  }),
  peopleDoctor: route({
    method: 'GET', path: '/v1/people/doctor', scope: 'admin', phase: 'v0.12', ctl: true, localOnly: true,
    response: PeopleDoctorSchema, summary: 'What People needs on this Mac, checked.',
  }),
} as const satisfies Record<string, RouteDef>;

/** Every route of hers this build serves (scope `person`; the arch test pins the list, T1). */
export const PERSON_ROUTES = { ...PERSON_ACCOUNT_ROUTES, ...PERSON_LIFE_ROUTES, ...PERSON_DAYS_ROUTES, ...PERSON_CHAT_ROUTES, ...PERSON_LIST_ROUTES } as const;
export type PersonRouteName = keyof typeof PERSON_ROUTES;
/** Every owner People route this build serves (the arch test pins each one's scope, ctl, localOnly and area). */
export const PEOPLE_ROUTES = { ...PEOPLE_ROUTES_BASE, ...PEOPLE_LIFE_ROUTES, ...PEOPLE_DAYS_ROUTES, ...PEOPLE_CHAT_ROUTES, ...PEOPLE_LIST_ROUTES, ...PEOPLE_ACCOUNT_ROUTES } as const;
export type PeopleRouteName = keyof typeof PEOPLE_ROUTES;
