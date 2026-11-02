/**
 * v0.12 People: the parts of `@jantar/protocol/people` that need no zod
 * (subpath `@jantar/protocol/people-core`): names and numbers, the build
 * phases and areas, the agreement's fields, levels and rules, and the
 * presets. Her app (a separate bundle) imports these at runtime and only
 * types from the schemas, so zod and the protocol's schemas stay out of her
 * first load. `people.ts` re-exports every one of them.
 */

/** The levels of `see.meds`. */
export type MedsLevel = 'off' | 'adherence' | 'full';
export const MEDS_LEVELS = ['off', 'adherence', 'full'] as const satisfies readonly MedsLevel[];
/** The levels of `see.review` (P2). */
export type ReviewLevel = 'off' | 'counts' | 'full';
export const REVIEW_LEVELS = ['off', 'counts', 'full'] as const satisfies readonly ReviewLevel[];
export type Preset = 'light' | 'standard' | 'everything';

/** The agreement's fields (people.ts AgreementFieldsSchema parses exactly this shape; a type test pins it). */
export interface AgreementFields {
  see: { todos: boolean; meds: MedsLevel; weight: boolean; food: boolean; plan: boolean; review: ReviewLevel; sleep: boolean; journal: boolean; chat: boolean };
  assign: { todos: boolean; meds: boolean; plan: boolean };
  editHers: { todos: boolean; meds: boolean; weight: boolean; plan: boolean };
  comment: { journal: boolean };
  assistant: boolean;
}

/** A partial change to an agreement: each group's fields optional (offer flags, narrow, propose). */
export interface AgreementPatch {
  see?: Partial<AgreementFields['see']>;
  assign?: Partial<AgreementFields['assign']>;
  editHers?: Partial<AgreementFields['editHers']>;
  comment?: Partial<AgreementFields['comment']>;
  assistant?: boolean;
}

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
/** The areas built now. */
export function builtAreas(built: BuildPhase = BUILT_PHASE): Area[] {
  return AREA_NAMES.filter((a) => phaseBuilt(AREAS[a], built));
}


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
  { key: 'see.review', path: ['see', 'review'], phase: 'P2', levels: REVIEW_LEVELS, area: 'review' },
  { key: 'see.meds', path: ['see', 'meds'], phase: 'P1', levels: MEDS_LEVELS, area: 'meds' },
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
  return {
    see: { todos: false, meds: 'off', weight: false, food: false, plan: false, review: 'off', sleep: false, journal: false, chat: false },
    assign: { todos: false, meds: false, plan: false },
    editHers: { todos: false, meds: false, weight: false, plan: false },
    comment: { journal: false },
    assistant: false,
  };
}

/** `a` with the patch's fields applied (no dependency closing: the caller decides). */
export function applyAgreementPatch(a: AgreementFields, patch: AgreementPatch): AgreementFields {
  const out = structuredClone(a);
  for (const [group, value] of Object.entries(patch) as [keyof AgreementFields, unknown][]) {
    if (value === undefined) continue;
    if (typeof value === 'object' && value !== null) {
      Object.assign(out[group] as object, Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)));
    } else (out as unknown as Record<string, unknown>)[group] = value;
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

