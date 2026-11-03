/**
 * v0.11 People: the parts of `@jantar/protocol/people` that need no zod
 * (subpath `@jantar/protocol/people-core`): names and numbers, the build
 * phases and areas, the agreement's fields, levels and rules, and the
 * presets. Her app (a separate bundle) imports these at runtime and only
 * types from the schemas, so zod and the protocol's schemas stay out of her
 * first load. `people.ts` re-exports every one of them.
 */

/** The name a person reads (her app, his screens, pushes), from constants.ts: her bundle imports it here. */
export { OWNER_FALLBACK_NAME, PEOPLE_LABEL, PEOPLE_SHORT_LABEL } from './constants.js';

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
// P2: day plans, the evening review, alerts, status, sleep and the journal (spec 3, 4, 6)

export const PLAN_STEPS_MAX = 30;
export const PLAN_BETWEEN_MAX = 4;
export const PLAN_TEMPLATES_MAX = 20;
/** Her plan push time and evening review time, by default. */
export const PLAN_PUSH_AT_DEFAULT = '07:00';
export const REVIEW_AT_DEFAULT = '21:00';
/** The earliest and latest evening review time she can pick. */
export const REVIEW_AT_RANGE = ['17:00', '23:30'] as const;
/** An unsent review closes itself (no note, nothing pushed) at this time the next day. */
export const REVIEW_CLOSE_AT = '12:00';
/** Changes to a sent plan are pushed once per this window ("Sam changed today's plan: 2 steps moved"). */
export const PLAN_CHANGE_COALESCE_MS = 2 * 60_000;
/** The plan push is skipped when the first step rings within this many minutes of it. */
export const PLAN_PUSH_NEAR_STEP_MIN = 15;
/** A timed step still to do this many minutes after its time shows "late" (display only). */
export const STEP_LATE_MIN = 15;
/** Focus lasts the step's length plus this, or FOCUS_DEFAULT_MIN with no length (C32). */
export const FOCUS_PAD_MIN = 30;
export const FOCUS_DEFAULT_MIN = 90;
/** A rough day reaches him only after this, behind her Undo (C35). */
export const ROUGH_UNDO_MS = 10_000;
/** A status lasts this many hours unless she says otherwise. */
export const STATUS_HOURS_DEFAULT = 12;
/** The sharing check-in comes every this many days (C26), or a week after a snooze. */
export const SHARING_CHECKIN_DAYS = 14;
export const SHARING_CHECKIN_SNOOZE_DAYS = 7;
/** It shows on her first open after this time. */
export const SHARING_CHECKIN_FROM = '10:00';

/** Alerts: kept 90 days; reply buttons close after 24 hours. */
export const PERSON_ALERT_KEEP_DAYS = 90;
export const ALERT_REPLY_HOURS = 24;
export const ALERT_TEXT_MAX = 140;
/** Urgent alerts are held to this many an hour, whatever the caps say. */
export const URGENT_PER_HOUR_MAX = 2;

export interface AlertCaps {
  hour: number;
  day: number;
  urgentDay: number;
  nudgeGapMin: 30 | 60;
  nudgeDay: number;
}
/** The recipient's caps, by default (C29): lower than the first draft's on purpose. */
export const ALERT_CAPS_DEFAULT: AlertCaps = { hour: 6, day: 20, urgentDay: 4, nudgeGapMin: 60, nudgeDay: 8 };
/** What each cap may be set to (inclusive). */
export const ALERT_CAPS_RANGE = {
  hour: [1, 12],
  day: [3, 40],
  urgentDay: [1, 6],
  nudgeDay: [0, 15],
} as const;

export type AlertKind = 'check_in' | 'call_me' | 'urgent' | 'good_morning' | 'good_night' | 'thinking_of_you' | 'running_late' | 'nudge' | 'change_request' | 'custom';
export type AlertUrgency = 'gentle' | 'normal' | 'urgent';
export type AlertReplyKind = 'ok' | 'on_my_way' | 'cant_now' | 'cant_now_safe' | 'heart' | 'changed' | 'keep';
/** Who may send a kind: either person, only her (to him), or only him (to her). */
export type AlertDirection = 'either' | 'her' | 'him';

/** The kinds (spec 6.1): label, urgency (custom: the sender picks gentle or normal), direction and reply buttons. */
export const ALERT_KINDS: Readonly<Record<AlertKind, { label: string; urgency: AlertUrgency; dir: AlertDirection; replies: readonly AlertReplyKind[] }>> = {
  check_in: { label: 'Check in, please', urgency: 'normal', dir: 'either', replies: ['ok', 'cant_now_safe'] },
  call_me: { label: 'Call me', urgency: 'normal', dir: 'either', replies: ['on_my_way', 'cant_now'] },
  urgent: { label: 'Urgent: need you now', urgency: 'urgent', dir: 'either', replies: ['on_my_way', 'cant_now_safe'] },
  good_morning: { label: 'Good morning', urgency: 'gentle', dir: 'either', replies: ['heart'] },
  good_night: { label: 'Good night', urgency: 'gentle', dir: 'either', replies: ['heart'] },
  thinking_of_you: { label: 'Thinking of you', urgency: 'gentle', dir: 'either', replies: ['heart'] },
  running_late: { label: 'Running late', urgency: 'normal', dir: 'her', replies: ['ok'] },
  nudge: { label: 'Reminder', urgency: 'normal', dir: 'him', replies: ['ok', 'cant_now'] },
  change_request: { label: 'Asks to change', urgency: 'normal', dir: 'her', replies: ['changed', 'keep'] },
  custom: { label: 'Message', urgency: 'normal', dir: 'either', replies: ['ok', 'cant_now'] },
};
export const ALERT_KIND_NAMES = Object.keys(ALERT_KINDS) as AlertKind[];

/** Reply buttons' words. "Can't right now, I'm safe" is a normal answer and feeds nothing. */
export const ALERT_REPLY_LABELS: Readonly<Record<AlertReplyKind, string>> = {
  ok: 'OK',
  on_my_way: 'On my way',
  cant_now: "Can't right now",
  cant_now_safe: "Can't right now, I'm safe",
  heart: '♥',
  changed: 'Changed',
  keep: 'Keep it',
};

/** Her status (spec 3.7): Okay, Low or Need space, plus a short line. */
export type StatusLevel = 'ok' | 'low' | 'need_space';
export const STATUS_LABELS: Readonly<Record<StatusLevel, string>> = { ok: 'Okay', low: 'Low', need_space: 'Need space' };
export const STATUS_LINE_MAX = 60;

/** Journal (spec 3.11). A closed set of emotions: free text would split "anxious" three ways within a week. */
export type Emotion = 'joy' | 'strength' | 'connection' | 'fear' | 'sadness' | 'anger' | 'flat';
export const EMOTIONS: Readonly<Record<Emotion, string>> = {
  joy: 'Joyful',
  strength: 'Strong',
  connection: 'Close',
  fear: 'Anxious',
  sadness: 'Sad',
  anger: 'Angry',
  flat: 'Flat',
};
export const EMOTION_NAMES = Object.keys(EMOTIONS) as Emotion[];
export const JOURNAL_TEXT_MAX = 8000;
export const JOURNAL_LINE_MAX = 200;
export const JOURNAL_COMMENT_MAX = 500;
export const JOURNAL_MILESTONES = [7, 30, 100, 365] as const;

/** Sleep (spec 3.12). */
export const SLEEP_SHORT_MIN = 360;
export const SLEEP_OPEN_MAX_H = 20;
export const SLEEP_HOLD_MAX_H = 14;
export const SLEEP_BACK_MAX_H = 12;
export const SLEEP_TREND_MIN_NIGHTS = 4;
export const SLEEP_RANGE_MAX_NIGHTS = 92;
/** "Going to sleep" shows on Today from 20:00 to 04:00. */
export const SLEEP_CARD_FROM = '20:00';
export const SLEEP_CARD_TO = '04:00';

/** One-tap reasons (typing is optional). */
export const SKIP_REASONS = ['Ran out of time', 'Not feeling well', 'Plans changed'] as const;
export const ASK_REASONS = ['Move it later', 'Too much today', 'Need help'] as const;

// ---------------------------------------------------------------------------
// P3: her Chat (spec 7)

/** How long her chat thread is kept, in days (her choice, C17): his `ask.keepDays` never applies to it. */
export const CHAT_KEEP_DAYS = [1, 7, 30] as const;
export type ChatKeepDays = (typeof CHAT_KEEP_DAYS)[number];
export const CHAT_KEEP_DAYS_DEFAULT: ChatKeepDays = 30;
/** Her messages a day, by default ({owner} changes it on Sharing; an Activity row). */
export const PERSON_CHAT_PER_DAY_DEFAULT = 30;
/** Unfinished turns in her thread at most. */
export const PERSON_CHAT_UNFINISHED_MAX = 2;
/** Her thread's id in chat.db (`''` is the owner's). */
export function chatThreadOf(personId: string | null): string {
  return personId ? `p:${personId}` : '';
}

/**
 * Her turns' failure words (C17): a fixed set that never names an account,
 * an email, a model limit or a reset time of his.
 */
export const PERSON_CHAT_SENTENCES = {
  busy: 'The assistant is busy. Try again in a few minutes.',
  usedUp: "Today's messages are used up.",
  off: "The assistant isn't available right now.",
  failed: "The assistant couldn't answer. Try again.",
  slow: 'The assistant took too long to answer. Try again.',
  cancelled: 'Stopped.',
  restarted: 'The assistant stopped when Jantar restarted. Try again.',
  wait: 'Wait for an answer, or stop one.',
} as const;

/** "12 messages left today". */
export function chatLeftLine(left: number): string {
  return `${left} message${left === 1 ? '' : 's'} left today`;
}

/** What her assistant can see, in the disclosure's words (only what this build has). */
export function chatReach(built: BuildPhase = BUILT_PHASE): string {
  return phaseBuilt('P4', built) ? 'your plan, to-dos, weight, sleep and the lists you share' : 'your plan, to-dos, weight and sleep';
}

/**
 * The chat disclosure (spec 7.6), built from the live agreement: on the
 * join page, in her chat header (ⓘ) and as the first message of a new
 * thread. It changes the moment she switches `see.chat`.
 */
export function chatDisclosure(owner: string, keepDays: number, ownerCanRead: boolean, built: BuildPhase = BUILT_PHASE): string {
  const kept = `${keepDays} day${keepDays === 1 ? '' : 's'}`;
  const read = ownerCanRead
    ? `${owner} can read this chat in Jantar: what you write, its answers, photos you send and what it changes for you. ${owner} can't write in it. You can switch this off in Sharing.`
    : `${owner} can't open this chat in Jantar, and sees only how many messages you send each day. As the Mac's owner, ${owner} could read the file it's stored in.`;
  return [
    `Your assistant runs on ${owner}'s Claude account, on ${owner}'s Mac.`,
    `What you write is sent to Anthropic to answer you and kept on ${owner}'s Mac for ${kept}.`,
    read,
    `It can see ${chatReach(built)}, and nothing of ${owner}'s. It never reads your journal.`,
  ].join(' ');
}

/** The permanent line above her composer while `see.chat` is on (not a dismissible banner). */
export function chatHeaderLine(owner: string): string {
  return `${owner} can read this chat`;
}

// ---------------------------------------------------------------------------
// P4: shared lists (spec 5)

/** A shared list's kind (spec 5.3). */
export type SharedListKind = 'shopping' | 'watch' | 'read' | 'plain';
export const SHARED_LIST_KINDS: Readonly<Record<SharedListKind, string>> = { shopping: 'Shopping', watch: 'To watch', read: 'To read', plain: 'List' };
/** Lists in one shared space, and items in one list, at most. */
export const SHARED_LISTS_MAX = 50;
export const SHARED_LIST_ITEMS_MAX = 500;
/** A forgotten person's attribution on a shared row: the row stays, theirs no more. */
export const GONE_BY = 'gone';

// ---------------------------------------------------------------------------
// Build phases (spec 9.8): only the built phase's areas, fields, routes and join lines exist.

/**
 * `later`: a field this release doesn't build at all. P3's `assistant` (his assistant reading her space,
 * spec 7.7) is one: it stays unofferable (never in a preset, a proposal or the join page) until it is built.
 */
export const BUILD_PHASES = ['P1', 'P2', 'P3', 'P4', 'later'] as const;
export type BuildPhase = (typeof BUILD_PHASES)[number];
/** The phase this build ships. A later phase's field is never offered, filled by a preset or granted by an upgrade (O7, D24). */
export const BUILT_PHASE: BuildPhase = 'P4';

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
  // Her food log (spec 3.5) isn't served in this release: no agreement, join line, screen or route offers it.
  food: 'later',
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
  { key: 'see.food', path: ['see', 'food'], phase: 'later', levels: ONOFF, area: 'food' },
  { key: 'assign.todos', path: ['assign', 'todos'], phase: 'P1', levels: ONOFF, area: 'todos' },
  { key: 'assign.plan', path: ['assign', 'plan'], phase: 'P2', levels: ONOFF, area: 'plan' },
  { key: 'assign.meds', path: ['assign', 'meds'], phase: 'P1', levels: ONOFF, area: 'meds' },
  { key: 'editHers.todos', path: ['editHers', 'todos'], phase: 'P1', levels: ONOFF, area: 'todos' },
  { key: 'editHers.plan', path: ['editHers', 'plan'], phase: 'P2', levels: ONOFF, area: 'plan' },
  { key: 'editHers.meds', path: ['editHers', 'meds'], phase: 'P1', levels: ONOFF, area: 'meds' },
  { key: 'editHers.weight', path: ['editHers', 'weight'], phase: 'P1', levels: ONOFF, area: 'weight' },
  { key: 'comment.journal', path: ['comment', 'journal'], phase: 'P2', levels: ONOFF, area: 'journal' },
  { key: 'assistant', path: ['assistant'], phase: 'later', levels: ONOFF, area: null },
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

/**
 * The fields a patch asks for whose phase isn't built (an unbuilt field is a 400, O7). Naming one at its
 * lowest level asks for nothing (`--see food=off` while food is a later phase) and passes.
 */
export function unbuiltFieldsIn(patch: AgreementPatch, built: BuildPhase = BUILT_PHASE): string[] {
  const named = new Map<string, unknown>();
  for (const [group, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (typeof value === 'object' && value !== null) for (const [k, v] of Object.entries(value)) named.set(`${group}.${k}`, v);
    else named.set(group, value);
  }
  return AGREEMENT_FIELDS.filter((f) => named.has(f.key) && !phaseBuilt(f.phase, built) && named.get(f.key) !== f.levels[0]).map((f) => f.key);
}

