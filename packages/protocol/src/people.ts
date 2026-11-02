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
import { IsoDateSchema, ScopeSchema } from './models.js';
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

// ---------------------------------------------------------------------------
// Names and numbers

/** Her routes' prefix: her cookie is read here only, and only on the people host. */
export const PERSON_PREFIX = '/v1/p/';
/** The owner's People routes. */
export const PEOPLE_PREFIX = '/v1/people';
/** Her device cookie. `__Host-`: Secure, Path=/, no Domain, so no sibling host can plant or overwrite it (C3). */
export const PERSON_COOKIE = '__Host-jantar_person';
/** IndexedDB database her app keeps its device secret in (the owner's is `jantar`). */
export const PERSON_CREDENTIAL_DB = 'jantar-person';
/** Partners one owner may have. The model, tables and routes take N; the cap is a constant (spec 1.1). */
export const PEOPLE_MAX = 1;
export const PERSON_INVITE_TTL_MS = 24 * 60 * 60_000;
export const PERSON_LINK_CODE_TTL_MS = 5 * 60_000;
/** Active devices one person may have (link codes stop there). */
export const PERSON_DEVICES_MAX = 5;
/** The default window `jantar people remove` leaves her to download her data. */
export const PERSON_ENDING_DAYS = 7;
/** How long her space is kept after she leaves (unless she chose delete). */
export const PERSON_FORGET_DAYS = 30;
/** After she declines an area it can't be proposed again for this long (C23). */
export const PROPOSAL_COOLING_DAYS = 7;
/** Her Activity is pruned to this per person. */
export const PERSON_ACTIVITY_KEEP = { days: 365, rows: 5000 } as const;
/** Her app's install scope. */
export const PERSON_APP_PATH = '/p';

// ---------------------------------------------------------------------------
// Build phases (spec 9.8): only the built phase's areas, fields, routes and join lines exist.

export const BUILD_PHASES = ['P1', 'P2', 'P3', 'P4'] as const;
export type BuildPhase = (typeof BUILD_PHASES)[number];
/** The phase this build ships. A later phase's field is never offered, filled by a preset or granted by an upgrade (O7, D24). */
export const BUILT_PHASE: BuildPhase = 'P1';

export function phaseBuilt(phase: BuildPhase, built: BuildPhase = BUILT_PHASE): boolean {
  return BUILD_PHASES.indexOf(phase) <= BUILD_PHASES.indexOf(built);
}

/**
 * The agreement areas and the mirror's areas, each with the phase that
 * builds it. `today` is the mirror's composite (each tile gated by its own
 * area).
 */
export const AREAS = {
  today: 'P1',
  todos: 'P1',
  plan: 'P2',
  review: 'P2',
  meds: 'P1',
  weight: 'P1',
  sleep: 'P2',
  journal: 'P2',
  chat: 'P3',
  food: 'P1',
} as const satisfies Record<string, BuildPhase>;
export type Area = keyof typeof AREAS;
export const AREA_NAMES = Object.keys(AREAS) as Area[];
export const AreaSchema = z.enum(AREA_NAMES as [Area, ...Area[]]);
/** The areas built now. */
export function builtAreas(built: BuildPhase = BUILT_PHASE): Area[] {
  return AREA_NAMES.filter((a) => phaseBuilt(AREAS[a], built));
}

// ---------------------------------------------------------------------------
// Ids and spaces

export const PersonIdSchema = LifeIdSchema;
export const SpaceSchema = z.string().regex(/^(|[0-9A-HJKMNP-TV-Z]{26}|s:[0-9A-HJKMNP-TV-Z]{26})$/);
export type Space = z.infer<typeof SpaceSchema>;
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

export const MedsLevelSchema = z.enum(['off', 'adherence', 'full']);
export type MedsLevel = z.infer<typeof MedsLevelSchema>;
export const ReviewLevelSchema = z.enum(['off', 'counts', 'full']);
export type ReviewLevel = z.infer<typeof ReviewLevelSchema>;

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
export type AgreementFields = z.infer<typeof AgreementFieldsSchema>;

/** What an agreement must hold together (spec 1.3.3 rules). Returns the first problem, or null. */
export function agreementProblem(a: AgreementFields): string | null {
  if (a.assign.todos && !a.see.todos) return 'assign.todos needs see.todos';
  if (a.editHers.todos && !a.see.todos) return 'editHers.todos needs see.todos';
  if (a.assign.meds && a.see.meds !== 'full') return 'assign.meds needs see.meds full';
  if (a.editHers.meds && a.see.meds !== 'full') return 'editHers.meds needs see.meds full';
  if (a.editHers.weight && !a.see.weight) return 'editHers.weight needs see.weight';
  if (a.assign.plan && !a.see.plan) return 'assign.plan needs see.plan';
  if (a.editHers.plan && !a.see.plan) return 'editHers.plan needs see.plan';
  if (a.see.review !== 'off' && !a.see.plan) return 'see.review needs see.plan';
  if (a.comment.journal && !a.see.journal) return 'comment.journal needs see.journal';
  if (a.assistant && !(a.see.todos || a.see.plan || a.see.meds !== 'off' || a.see.weight || a.see.sleep || a.see.food)) {
    return 'assistant needs at least one area other than journal and chat';
  }
  return null;
}

const refineAgreement = (a: AgreementFields, ctx: z.RefinementCtx) => {
  const problem = agreementProblem(a);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
};

export const AgreementSchema = AgreementFieldsSchema.extend({ version: z.number().int().min(1) }).superRefine(refineAgreement);
export type Agreement = z.infer<typeof AgreementSchema>;
export const CheckedAgreementFieldsSchema = AgreementFieldsSchema.superRefine(refineAgreement);

/** One agreement field: its path, the phase that builds it and its levels, lowest first. */
export interface AgreementField {
  key: string;
  path: readonly [keyof AgreementFields] | readonly [keyof AgreementFields, string];
  phase: BuildPhase;
  levels: readonly (boolean | string)[];
  /** The area whose `see` it hangs on (the join page groups by it). */
  area: Area | null;
}

const ONOFF = [false, true] as const;

/** Every field, in the join page's order. */
export const AGREEMENT_FIELDS: readonly AgreementField[] = [
  { key: 'see.todos', path: ['see', 'todos'], phase: 'P1', levels: ONOFF, area: 'todos' },
  { key: 'see.plan', path: ['see', 'plan'], phase: 'P2', levels: ONOFF, area: 'plan' },
  { key: 'see.review', path: ['see', 'review'], phase: 'P2', levels: ReviewLevelSchema.options, area: 'review' },
  { key: 'see.meds', path: ['see', 'meds'], phase: 'P1', levels: MedsLevelSchema.options, area: 'meds' },
  { key: 'see.weight', path: ['see', 'weight'], phase: 'P1', levels: ONOFF, area: 'weight' },
  { key: 'see.sleep', path: ['see', 'sleep'], phase: 'P2', levels: ONOFF, area: 'sleep' },
  { key: 'see.journal', path: ['see', 'journal'], phase: 'P2', levels: ONOFF, area: 'journal' },
  { key: 'see.chat', path: ['see', 'chat'], phase: 'P3', levels: ONOFF, area: 'chat' },
  { key: 'see.food', path: ['see', 'food'], phase: 'P1', levels: ONOFF, area: 'food' },
  { key: 'assign.todos', path: ['assign', 'todos'], phase: 'P1', levels: ONOFF, area: 'todos' },
  { key: 'assign.plan', path: ['assign', 'plan'], phase: 'P2', levels: ONOFF, area: 'plan' },
  { key: 'assign.meds', path: ['assign', 'meds'], phase: 'P1', levels: ONOFF, area: 'meds' },
  { key: 'editHers.todos', path: ['editHers', 'todos'], phase: 'P1', levels: ONOFF, area: 'todos' },
  { key: 'editHers.plan', path: ['editHers', 'plan'], phase: 'P2', levels: ONOFF, area: 'plan' },
  { key: 'editHers.meds', path: ['editHers', 'meds'], phase: 'P1', levels: ONOFF, area: 'meds' },
  { key: 'editHers.weight', path: ['editHers', 'weight'], phase: 'P1', levels: ONOFF, area: 'weight' },
  { key: 'comment.journal', path: ['comment', 'journal'], phase: 'P2', levels: ONOFF, area: 'journal' },
  { key: 'assistant', path: ['assistant'], phase: 'P3', levels: ONOFF, area: null },
];

export function fieldValue(a: AgreementFields, f: AgreementField): boolean | string {
  const [group, name] = f.path;
  const g = a[group] as unknown;
  return (name === undefined ? g : (g as Record<string, unknown>)[name]) as boolean | string;
}

/** A copy of `a` with field `f` set to `v`. */
export function withField(a: AgreementFields, f: AgreementField, v: boolean | string): AgreementFields {
  const out = structuredClone(a) as unknown as Record<string, Record<string, unknown> | boolean>;
  const [group, name] = f.path;
  if (name === undefined) out[group] = v as boolean;
  else (out[group] as Record<string, unknown>)[name] = v;
  return out as unknown as AgreementFields;
}

/** The level index of `f` in `a` (0 is off). */
export function levelOf(a: AgreementFields, f: AgreementField): number {
  return f.levels.indexOf(fieldValue(a, f));
}

/** Every field of `inner` is at or below the same field of `outer`. */
export function agreementWithin(inner: AgreementFields, outer: AgreementFields): boolean {
  return AGREEMENT_FIELDS.every((f) => levelOf(inner, f) <= levelOf(outer, f));
}

/** The fields of `a` that are above off. */
export function fieldsOn(a: AgreementFields): string[] {
  return AGREEMENT_FIELDS.filter((f) => levelOf(a, f) > 0).map((f) => f.key);
}

/** The fields that differ between two agreements. */
export function fieldsChanged(a: AgreementFields, b: AgreementFields): string[] {
  return AGREEMENT_FIELDS.filter((f) => fieldValue(a, f) !== fieldValue(b, f)).map((f) => f.key);
}

/** Turning a `see` field off (or a level down) turns off everything that needs it (spec 1.3.3 rules). */
export function closeDependents(a: AgreementFields): AgreementFields {
  const out = structuredClone(a);
  if (!out.see.todos) {
    out.assign.todos = false;
    out.editHers.todos = false;
  }
  if (out.see.meds !== 'full') {
    out.assign.meds = false;
    out.editHers.meds = false;
  }
  if (!out.see.weight) out.editHers.weight = false;
  if (!out.see.plan) {
    out.assign.plan = false;
    out.editHers.plan = false;
    out.see.review = 'off';
  }
  if (!out.see.journal) out.comment.journal = false;
  if (out.assistant && agreementProblem(out) !== null) out.assistant = false;
  return out;
}

/** Every field whose phase isn't built, at its lowest level. */
export function clampToBuilt(a: AgreementFields, built: BuildPhase = BUILT_PHASE): AgreementFields {
  let out = a;
  for (const f of AGREEMENT_FIELDS) if (!phaseBuilt(f.phase, built) && levelOf(out, f) > 0) out = withField(out, f, f.levels[0] as boolean | string);
  return closeDependents(out);
}

export const PresetSchema = z.enum(['light', 'standard', 'everything']);
export type Preset = z.infer<typeof PresetSchema>;

/** The full presets (spec 1.3.3), before the build's clamp. `assistant` is in none (D17). */
const PRESETS: Readonly<Record<Preset, AgreementFields>> = {
  light: {
    see: { todos: true, plan: true, review: 'counts', meds: 'off', weight: false, sleep: false, journal: false, chat: false, food: false },
    assign: { todos: true, plan: true, meds: false },
    editHers: { todos: false, plan: false, meds: false, weight: false },
    comment: { journal: false },
    assistant: false,
  },
  standard: {
    see: { todos: true, plan: true, review: 'counts', meds: 'full', weight: true, sleep: false, journal: false, chat: false, food: false },
    assign: { todos: true, plan: true, meds: true },
    editHers: { todos: false, plan: false, meds: false, weight: false },
    comment: { journal: false },
    assistant: false,
  },
  everything: {
    see: { todos: true, plan: true, review: 'full', meds: 'full', weight: true, sleep: true, journal: true, chat: true, food: true },
    assign: { todos: true, plan: true, meds: true },
    editHers: { todos: true, plan: true, meds: true, weight: true },
    comment: { journal: true },
    assistant: false,
  },
};

/** An offer template (D20): the preset's fields whose phase is built; every other field off (O7). */
export function presetAgreement(preset: Preset, built: BuildPhase = BUILT_PHASE): AgreementFields {
  return clampToBuilt(structuredClone(PRESETS[preset]), built);
}

/** The lowest agreement: nothing seen, assigned or edited. */
export function noAgreement(): AgreementFields {
  return AgreementFieldsSchema.parse({
    see: { todos: false, meds: 'off', weight: false, food: false },
    assign: { todos: false, meds: false },
    editHers: { todos: false },
  });
}

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
export type AgreementPatch = z.infer<typeof AgreementPatchSchema>;

/** `a` with the patch's fields applied (no dependency closing: the caller decides). */
export function applyAgreementPatch(a: AgreementFields, patch: AgreementPatch): AgreementFields {
  const out = structuredClone(a);
  for (const [group, value] of Object.entries(patch) as [keyof AgreementFields, unknown][]) {
    if (value === undefined) continue;
    if (typeof value === 'object' && value !== null) {
      Object.assign(out[group] as object, Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)));
    } else (out as Record<string, unknown>)[group] = value;
  }
  return out;
}

/** The fields a patch names whose phase isn't built (an unbuilt field is a 400, O7). */
export function unbuiltFieldsIn(patch: AgreementPatch, built: BuildPhase = BUILT_PHASE): string[] {
  const named = new Set<string>();
  for (const [group, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (typeof value === 'object' && value !== null) for (const k of Object.keys(value)) named.add(`${group}.${k}`);
    else named.add(group);
  }
  return AGREEMENT_FIELDS.filter((f) => named.has(f.key) && !phaseBuilt(f.phase, built)).map((f) => f.key);
}

// ---------------------------------------------------------------------------
// The person (life.db `people.json`)

export const DontAskSchema = z.enum(['todos', 'plan', 'review', 'meds', 'weight', 'sleep', 'journal', 'chat', 'food', 'assistant', 'editHers', 'comment']);
export type DontAsk = z.infer<typeof DontAskSchema>;

/** Her preferences. P1 holds the lock screen, mute and "don't ask again"; later phases add theirs with defaults. */
export const PersonPrefsSchema = z.object({
  lockScreen: LockScreenSchema.default('hide_alerts'),
  muteUntil: IsoDateSchema.nullable().default(null),
  dontAsk: z.array(DontAskSchema).max(12).default([]),
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
  /** A change she asked for (`personTodoAsk`): shown on the item on his To-do tab in P1. */
  askedChange: z.object({ at: IsoDateSchema, note: z.string().max(200) }).optional(),
});
export type PersonTodo = z.infer<typeof PersonTodoSchema>;
export const PersonTodosResponseSchema = z.object({ today: DayKeySchema, todos: z.array(PersonTodoSchema) });
export type PersonTodosResponse = z.infer<typeof PersonTodosResponseSchema>;

/** His assign body: the owner's todo body plus `ask` and `snoozable` (no `by`, no `space`: daemon-set). */
export const AssignTodoBodySchema = z
  .strictObject({ ...TodoBodySchema.shape, ask: TodoAskSchema.optional(), snoozable: z.boolean().optional() })
  .refine((b) => b.repeat === undefined || b.due !== undefined, { message: 'a repeating todo needs a due day', path: ['repeat'] });
export type AssignTodoBody = z.infer<typeof AssignTodoBodySchema>;
export const AssignTodoPatchSchema = z
  .strictObject({ ...TodoPatchSchema.shape, ask: TodoAskSchema.optional(), snoozable: z.boolean().optional() })
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

export const LockedSchema = z.object({ locked: z.literal(true) });
export type Locked = z.infer<typeof LockedSchema>;

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
  meds: z.union([LockedSchema, OwnerMedsViewSchema]),
  weight: z.union([LockedSchema, z.object({ latest: PersonWeightSchema.nullable() })]),
  /** null: her food module is off, so there is no food area at all (O6). */
  food: z.union([LockedSchema, z.object({ kcal: z.number().int(), target: z.number().int() })]).nullable(),
});
export type PersonToday = z.infer<typeof PersonTodaySchema>;

/** Her own Today (P1): medicines due, reminders and to-dos due. */
export const PersonOwnTodaySchema = z.object({
  day: DayKeySchema,
  today: DayKeySchema,
  meds: MedsDaySchema.nullable(),
  todos: z.array(PersonTodoSchema),
  overdue: z.number().int(),
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
export const PersonColorBodySchema = z.strictObject({ color: PersonColorSchema });
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
});
export type PersonMe = z.infer<typeof PersonMeSchema>;

export const MirrorParamsSchema = z.object({ area: AreaSchema });
export const AgreementVersionBodySchema = z.strictObject({ version: z.number().int().min(1) });
export const AgreementDeclineBodySchema = z.strictObject({ version: z.number().int().min(1), dontAsk: z.boolean().optional() });
export const PauseBodySchema = z.strictObject({ note: z.string().trim().max(200).optional() });
export const LeaveBodySchema = z.strictObject({ data: z.enum(['keep30', 'delete']), confirm: z.literal('LEAVE') });
export type LeaveBody = z.infer<typeof LeaveBodySchema>;
export const ExportQuerySchema = z.object({ format: z.enum(['html', 'json']).default('html') });
/** P1 prefs; a later phase's field is a 400 (strict). */
export const PersonPrefsPatchSchema = z.strictObject({
  lockScreen: LockScreenSchema.optional(),
  muteUntil: IsoDateSchema.nullable().optional(),
  dontAsk: z.array(DontAskSchema).max(12).optional(),
});
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

  // --- Health (areas meds, weight, food)
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
  personOwnerFood: route({
    method: 'GET', path: '/v1/people/:pid/food', scope: 'control', phase: 'v0.12', ctl: false, area: 'food',
    params: PidParamsSchema, query: DayQuerySchema, response: OwnerFoodViewSchema, summary: 'Her food log (see.food; 404 while her module is off).',
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
    params: PidParamsSchema, body: PersonColorBodySchema, response: OkReplySchema, summary: 'Her colour on his screens.',
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
export const PERSON_ROUTES = { ...PERSON_ACCOUNT_ROUTES } as const;
export type PersonRouteName = keyof typeof PERSON_ROUTES;
/** Every owner People route this build serves (the arch test pins each one's scope, ctl, localOnly and area). */
export const PEOPLE_ROUTES = { ...PEOPLE_ROUTES_BASE, ...PEOPLE_ACCOUNT_ROUTES } as const;
export type PeopleRouteName = keyof typeof PEOPLE_ROUTES;
