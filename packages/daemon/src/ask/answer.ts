/**
 * Claude's answer, read (spec 2, 3.4). The model's output is data: it can
 * only propose actions from a fixed list, and each one is checked on its
 * own here before it becomes a card.
 *
 * - The answer: one JSON object (one code fence around it tolerated) with
 *   `reply` (a string) and `actions` (an array; left out or null means
 *   none). Other top-level keys are ignored. Anything else makes the turn
 *   unreadable.
 * - The model form of an action (what Claude writes) is a strict object of
 *   one of five types: todo, food, money, post, show. Any other type, an
 *   unknown field, a value of the wrong kind or out of range, or a type
 *   whose Life part is off drops that action alone (counted in `dropped`).
 *   Only the first ASK_CARDS_MAX are read; every one after counts as
 *   dropped.
 * - Every string: control and bidi characters stripped (rewrite/guards.ts
 *   CONTROL), line ends made spaces (notes keep them), trimmed, then too
 *   long or empty drops the action (it is never cut). Nothing visible
 *   (only spaces and zero-width or other format characters) is empty.
 * - Days are real days from a week back to 400 days on; food and money are
 *   never after today. A todo's day and time are placed in this order:
 *   (1) a time and no day, no repeat: today if the time is still ahead,
 *   else tomorrow; (2) a repeat and no day: today; then settleDue: (3) a
 *   repeat whose start is not after now steps on, as Done does
 *   (life-core nextRepeat), until it is (Life never rings a repeating todo
 *   whose time passed); (4) a one-off whose time is not after now (today
 *   at a time gone, or any earlier day) keeps its day and is flagged
 *   past_time.
 * - no_time: the message asked for a reminder (remind, yaad, याद) and no
 *   todo in the answer has a time; then each todo without one says so.
 *   One todo with a time answers the ask: the others are plain todos.
 * - A project is matched by name (trimmed, any case; active, then paused,
 *   then done projects; the first hit), never by an id the model wrote.
 * - Money: the amount in the currency's units becomes hundredths
 *   (₹250 is 25000), the category one of DEFAULT_CATEGORIES[kind] (any
 *   case) or 'Other' (any other name, however long).
 * - Post (v0.7): a plan, never the post itself, so it has no text, notes or
 *   link key (one drops it). The platform is its name in any case or an
 *   alias (insta and ig, twitter, yt, hacker news, fb), else 'other'; the
 *   kind its name or plural in any case, else 'post'. `where` and `title`
 *   are taken as written and must pass Posts' one-line schemas (a newline
 *   or a bidi character drops the action). Day and time as a todo's (1)
 *   and (4), never a repeat.
 * - The reply: controls stripped, trimmed and cut to ASK_REPLY_MAX with
 *   its "…" counted (as rewrite/context.ts clip); nothing visible is no
 *   reply. Plain text: the phone never renders it as Markdown or links.
 *
 * `checkWrite` runs the same rules on a card's action (or the phone's edit
 * of it) again at Add, against the time then. Nothing here logs.
 */
import { nextRepeat, shiftDay } from '@jantar/life-core';
import {
  ASK_CARDS_MAX,
  ASK_REPLY_MAX,
  ASK_TEXT_MAX,
  AskActionSchema,
  AskWriteActionSchema,
  DEFAULT_CATEGORIES,
  DayKeySchema,
  HhMmSchema,
  POST_KINDS,
  POST_KIND_LABEL,
  POST_PLATFORMS,
  PostTitleSchema,
  PostWhereSchema,
  type AskAction,
  type AskCard,
  type AskFlag,
  type AskPostAction,
  type AskTodoAction,
  type AskWriteAction,
  type Due,
  type MoneyKind,
  type PostKind,
  type PostPlatform,
  type ProjectStatus,
} from '@jantar/protocol';
import { isRealDay } from '../life/food/module.js';
import { clip } from '../rewrite/context.js';
import { CONTROL, LINE_END } from '../rewrite/guards.js';

/** Every fixed sentence Ask says (failures, refusals, the empty answer): never model, stderr or user text. */
export const ASK_SENTENCES = {
  noRunner: 'Ask needs Claude Code on this Mac.',
  noAccount: 'No account has room right now. Try again in a while.',
  timeout: 'Claude took too long to answer. Try again.',
  unreadable: "Claude's answer couldn't be read. Try again.",
  failed: "Claude couldn't answer. Try again.",
  cancelled: 'Cancelled.',
  readOnly: "Ask can't run while Jantar is read-only.",
  off: 'Ask is off. Turn it on at your Mac: jantar ask on',
  noModules: 'Turn a Life part on first: jantar life on todos',
  busy: 'Wait for the answer, or cancel it.',
  empty: "I couldn't find anything to add. Try saying it another way.",
  noText: 'Type a message first.',
  tooLong: `Keep a message to ${ASK_TEXT_MAX} characters.`,
  noTurn: 'No such message.',
  noCard: 'No such suggestion.',
  notDone: 'Wait for the answer.',
  notWrite: 'Nothing to add.',
  added: 'Already added.',
  skipped: 'Skipped.',
  old: 'Over a day old. Ask again.',
  nothingToUndo: 'Nothing to undo.',
  oldUndo: 'Over a day old. Delete it in Todos, Food, Finance or Posts instead.',
  editType: "An edit can't change what kind of item it is.",
  editProject: 'An edit can keep the suggested project or leave it out, nothing else.',
  badDay: 'Pick a day from a week ago to a year ahead.',
  futureDay: 'Food and money go on today or an earlier day.',
  badItem: "That can't be added as it is. Edit it and try again.",
} as const;

/** A project as the name match sees it. */
export interface AskProject {
  id: string;
  name: string;
  status: ProjectStatus;
}

/** What the rules are checked against: the Life zone's today and now, the parts that are on, the projects, the message's words. */
export interface AskScope {
  /** Today's day key in the Life zone. */
  today: string;
  /** Now as HH:MM in the Life zone. */
  now: string;
  modules: { todos: boolean; food: boolean; finance: boolean; medicines: boolean; posts: boolean };
  projects: readonly AskProject[];
  /** The message asked for a reminder (remind, reminder, yaad, याद): see no_time. */
  remind: boolean;
}

/** What one answer gives a turn. */
export interface ParsedAnswer {
  reply?: string;
  cards: AskCard[];
  dropped: number;
}

/** Days back and ahead a day may be. */
export const DAYS_BACK = 7;
export const DAYS_AHEAD = 400;
const TITLE_MAX = 200;
const NOTES_MAX = 2000;
/** A project's name at most (Life's own cap). */
const PROJECT_MAX = 60;
const FOOD_NAME_MAX = 80;
const KCAL_MAX = 10_000;
const MONEY_NOTE_MAX = 200;
const AMOUNT_MAX = 1e12;
/** A runaway guard for settleDue's steps (a week back takes 8 daily steps). */
const SETTLE_STEPS_MAX = 1000;

const FENCE = /^```[A-Za-z]*\s*\n([\s\S]*?)\n?```$/;
// \b is ASCII-only, so याद is matched as it is.
const REMIND = /\b(?:remind\w*|yaad)\b|याद/i;
/** Nothing a person can see: spaces, zero-width and other format characters (U+200B, U+FEFF, joiners), the Hangul fillers and the blank Braille cell. */
const BLANK = /^[\s\p{Cf}\u115f\u1160\u2800\u3164\uffa0]*$/u;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether the message asks for a reminder. */
export function asksReminder(text: string): boolean {
  return REMIND.test(text);
}

/** Line ends normalised, controls stripped; other line ends made spaces unless `lines`; nothing visible is empty. */
function cleanString(s: string, lines: boolean): string {
  const t = s.replace(LINE_END, '\n').replace(CONTROL, '');
  const out = (lines ? t : t.replace(/\n/g, ' ')).trim();
  return BLANK.test(out) ? '' : out;
}

/** Left out, a bad value, or the value. */
const BAD = Symbol('bad');
type Field<T> = T | undefined | typeof BAD;

function textField(v: unknown, max: number, lines = false): Field<string> {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') return BAD;
  const s = cleanString(v, lines);
  return s.length === 0 || s.length > max ? BAD : s;
}

function enumField<T extends string>(v: unknown, values: readonly T[]): Field<T> {
  if (v === undefined) return undefined;
  return typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : BAD;
}

function numberField(v: unknown): Field<number> {
  if (v === undefined) return undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : BAD;
}

/** A real day key from DAYS_BACK before today to DAYS_AHEAD after it. */
export function dayInRange(day: string, today: string): boolean {
  return DayKeySchema.safeParse(day).success && isRealDay(day) && day >= shiftDay(today, -DAYS_BACK) && day <= shiftDay(today, DAYS_AHEAD);
}

function dayField(v: unknown, scope: Pick<AskScope, 'today'>): Field<string> {
  const s = textField(v, 10);
  if (s === undefined || s === BAD) return s;
  return dayInRange(s, scope.today) ? s : BAD;
}

function timeField(v: unknown): Field<string> {
  const s = textField(v, 5);
  if (s === undefined || s === BAD) return s;
  return HhMmSchema.safeParse(s).success ? s : BAD;
}

/** Only these keys (an unknown one drops the action). */
function onlyKeys(o: Obj, keys: readonly string[]): boolean {
  return Object.keys(o).every((k) => keys.includes(k));
}

/** A due day and time that ring after now (a day after today, or today with no time or a later time). */
function startsAfterNow(due: Due, scope: Pick<AskScope, 'today' | 'now'>): boolean {
  return due.day > scope.today || (due.day === scope.today && (due.time === undefined || due.time > scope.now));
}

/**
 * Rules (3) and (4): a repeating todo that would start at or before now
 * steps on to its next day, as Done moves it (daily +1 day, weekly +7,
 * monthly the same date next month, clamped to the month's end), until it
 * starts after now; a one-off whose time is not after now (today at a time
 * gone, or a day before today: the model wrote one, or a card for today
 * was tapped after midnight) keeps its day and is flagged past_time (it
 * won't ring). Run by the parse and again by Add.
 */
export function settleDue(a: AskTodoAction, scope: Pick<AskScope, 'today' | 'now'>): { action: AskTodoAction; flag?: 'past_time' } {
  const due = a.due;
  if (!due) return { action: a };
  if (a.repeat) {
    const freq = a.repeat;
    let day = due.day;
    for (let i = 0; i < SETTLE_STEPS_MAX && !startsAfterNow({ ...due, day }, scope); i++) day = nextRepeat({ freq }, day, day);
    return { action: day === due.day ? a : { ...a, due: { ...due, day } } };
  }
  if (due.time !== undefined && !startsAfterNow(due, scope)) return { action: a, flag: 'past_time' };
  return { action: a };
}

/** One flag a card shows: past_time, else no_time (`noTime`, and still no time), else no_project. */
function todoFlag(a: AskTodoAction, past: boolean, noTime: boolean, noProject: boolean): AskFlag | undefined {
  if (past) return 'past_time';
  if (noTime && a.due?.time === undefined) return 'no_time';
  return noProject ? 'no_project' : undefined;
}

const untimedTodo = (a: AskAction): boolean => a.type === 'todo' && a.due?.time === undefined;

/** The project named `name`: trimmed, any case; active, then paused, then done; the first hit. */
export function matchProject(name: string, projects: readonly AskProject[]): string | undefined {
  const want = name.trim().toLowerCase();
  for (const status of ['active', 'paused', 'done'] as const) {
    const hit = projects.find((p) => p.status === status && p.name.trim().toLowerCase() === want);
    if (hit) return hit.id;
  }
  return undefined;
}

/** The fixed category of `kind` named `name` (any case), else 'Other'. */
export function matchCategory(kind: MoneyKind, name: string): string {
  const want = name.trim().toLowerCase();
  return DEFAULT_CATEGORIES[kind].find((c) => c.toLowerCase() === want) ?? 'Other';
}

interface Read {
  action: AskAction;
  flag?: AskFlag;
}

const TODO_KEYS = ['type', 'title', 'day', 'time', 'repeat', 'priority', 'project', 'notes'] as const;
const FOOD_KEYS = ['type', 'name', 'kcal', 'day'] as const;
const MONEY_KEYS = ['type', 'kind', 'amount', 'category', 'note', 'day'] as const;
const SHOW_KEYS = ['type', 'what'] as const;
const POST_KEYS = ['type', 'platform', 'kind', 'where', 'title', 'day', 'time'] as const;

function readTodo(o: Obj, scope: AskScope): Read | null {
  if (!onlyKeys(o, TODO_KEYS)) return null;
  const title = textField(o.title, TITLE_MAX);
  const day = dayField(o.day, scope);
  const time = timeField(o.time);
  const repeat = enumField(o.repeat, ['daily', 'weekly', 'monthly'] as const);
  const priority = enumField(o.priority, ['normal', 'high'] as const);
  const project = textField(o.project, PROJECT_MAX);
  const notes = textField(o.notes, NOTES_MAX, true);
  if (title === undefined || [title, day, time, repeat, priority, project, notes].includes(BAD)) return null;
  const t = title as string;
  const d = day as string | undefined;
  const hm = time as string | undefined;
  const r = repeat as AskTodoAction['repeat'];

  // (1) a time with no day and no repeat: the next time it comes; (2) a repeat with no day: today.
  let due: Due | undefined;
  if (d !== undefined) due = hm !== undefined ? { day: d, time: hm } : { day: d };
  else if (hm !== undefined) due = { day: r !== undefined || hm > scope.now ? scope.today : shiftDay(scope.today, 1), time: hm };
  else if (r !== undefined) due = { day: scope.today };

  const projectId = project === undefined ? undefined : matchProject(project as string, scope.projects);
  const action: AskTodoAction = {
    type: 'todo',
    title: t,
    ...(notes !== undefined ? { notes: notes as string } : {}),
    ...(due ? { due } : {}),
    ...(priority !== undefined ? { priority: priority as 'normal' | 'high' } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(r !== undefined ? { repeat: r } : {}),
  };
  const settled = settleDue(action, scope);
  // no_time is the whole answer's (parseAnswer).
  const flag = todoFlag(settled.action, settled.flag !== undefined, false, project !== undefined && projectId === undefined);
  return { action: settled.action, ...(flag ? { flag } : {}) };
}

/** A food or money day: today when left out, never after today. */
function pastDay(v: unknown, scope: AskScope): Field<string> {
  const day = dayField(v, scope);
  if (day === undefined) return scope.today;
  return day === BAD || day > scope.today ? BAD : day;
}

function readFood(o: Obj, scope: AskScope): Read | null {
  if (!onlyKeys(o, FOOD_KEYS)) return null;
  const name = textField(o.name, FOOD_NAME_MAX);
  const kcal = numberField(o.kcal);
  const day = pastDay(o.day, scope);
  if (name === undefined || name === BAD || kcal === undefined || kcal === BAD || day === undefined || day === BAD) return null;
  const k = Math.round(kcal);
  if (k < 0 || k > KCAL_MAX) return null;
  return { action: { type: 'food', day, name, kcal: k } };
}

function readMoney(o: Obj, scope: AskScope): Read | null {
  if (!onlyKeys(o, MONEY_KEYS)) return null;
  const kind = enumField(o.kind, ['expense', 'income'] as const);
  const amount = numberField(o.amount);
  // Any length: it is mapped to a fixed name (else 'Other') anyway.
  const category = textField(o.category, Number.POSITIVE_INFINITY);
  const note = textField(o.note, MONEY_NOTE_MAX);
  const day = pastDay(o.day, scope);
  if (kind === undefined || kind === BAD || amount === undefined || amount === BAD || category === undefined || category === BAD) return null;
  if (note === BAD || day === undefined || day === BAD || amount <= 0) return null;
  const hundredths = Math.round(amount * 100);
  if (hundredths < 1 || hundredths > AMOUNT_MAX) return null;
  return {
    action: { type: 'money', kind, amount: hundredths, category: matchCategory(kind, category), ...(note !== undefined ? { note } : {}), day },
  };
}

/** What people call a platform besides its own name (lower case). */
const PLATFORM_ALIAS: Readonly<Record<string, PostPlatform>> = {
  insta: 'instagram',
  ig: 'instagram',
  twitter: 'x',
  yt: 'youtube',
  'hacker news': 'hn',
  fb: 'facebook',
};

/** The platform named `name`: its own name or an alias, any case; else 'other'. */
export function matchPlatform(name: string): PostPlatform {
  const want = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return (POST_PLATFORMS as readonly string[]).includes(want) ? (want as PostPlatform) : (PLATFORM_ALIAS[want] ?? 'other');
}

/** The kind named `name`: its own name or its plural ("reels"), any case; else 'post'. */
export function matchKind(name: string): PostKind {
  const want = name.trim().toLowerCase();
  return POST_KINDS.find((k) => k === want || POST_KIND_LABEL[k][1].toLowerCase() === want) ?? 'post';
}

/** A post's where or title: as written, one line by Posts' own schema, something visible. */
function lineField(v: unknown, schema: typeof PostWhereSchema | typeof PostTitleSchema): Field<string> {
  if (v === undefined) return undefined;
  const parsed = schema.safeParse(v);
  return parsed.success && !BLANK.test(parsed.data) ? parsed.data : BAD;
}

function readPost(o: Obj, scope: AskScope): Read | null {
  if (!onlyKeys(o, POST_KEYS)) return null;
  // Any length: each is mapped to a fixed name anyway.
  const platform = textField(o.platform, Number.POSITIVE_INFINITY);
  const kind = textField(o.kind, Number.POSITIVE_INFINITY);
  const where = lineField(o.where, PostWhereSchema);
  const title = lineField(o.title, PostTitleSchema);
  const day = dayField(o.day, scope);
  const time = timeField(o.time);
  if (platform === undefined || [platform, kind, where, title, day, time].includes(BAD)) return null;
  const d = day as string | undefined;
  const hm = time as string | undefined;
  // (1) a time with no day: the next time it comes.
  let due: Due | undefined;
  if (d !== undefined) due = hm !== undefined ? { day: d, time: hm } : { day: d };
  else if (hm !== undefined) due = { day: hm > scope.now ? scope.today : shiftDay(scope.today, 1), time: hm };
  const action: AskPostAction = {
    type: 'post',
    platform: matchPlatform(platform as string),
    kind: kind === undefined ? 'post' : matchKind(kind as string),
    ...(where !== undefined ? { where: where as string } : {}),
    ...(title !== undefined ? { title: title as string } : {}),
    ...(due ? { due } : {}),
  };
  return postPast(action, scope) ? { action, flag: 'past_time' } : { action };
}

/** (4) for a post: a time not after now (today at a time gone, or an earlier day) won't ring. */
function postPast(a: AskPostAction, scope: Pick<AskScope, 'today' | 'now'>): boolean {
  return a.due?.time !== undefined && !startsAfterNow(a.due, scope);
}

/** Which Life part a show card reads. */
const SHOW_MODULE = { due: 'todos', calories: 'food', meds: 'medicines' } as const;

function readShow(o: Obj, scope: AskScope): Read | null {
  if (!onlyKeys(o, SHOW_KEYS)) return null;
  const what = enumField(o.what, ['due', 'calories', 'meds'] as const);
  if (what === undefined || what === BAD || !scope.modules[SHOW_MODULE[what]]) return null;
  return { action: { type: 'show', what } };
}

/** One model-form action as a card's action (and flag), or null when it is dropped. */
export function readAction(raw: unknown, scope: AskScope): Read | null {
  if (!isObj(raw)) return null;
  let read: Read | null;
  switch (raw.type) {
    case 'todo':
      read = scope.modules.todos ? readTodo(raw, scope) : null;
      break;
    case 'food':
      read = scope.modules.food ? readFood(raw, scope) : null;
      break;
    case 'money':
      read = scope.modules.finance ? readMoney(raw, scope) : null;
      break;
    case 'post':
      read = scope.modules.posts ? readPost(raw, scope) : null;
      break;
    case 'show':
      read = readShow(raw, scope);
      break;
    default:
      read = null;
  }
  // The card form's own schema, last: what it keeps is always what the phone and Add accept.
  return read && AskActionSchema.safeParse(read.action).success ? read : null;
}

/** The reply as a turn keeps it: controls stripped, trimmed, at most ASK_REPLY_MAX with its "…"; nothing visible is ''. */
export function replyOf(text: string): string {
  const cut = clip(cleanString(text, true), ASK_REPLY_MAX);
  // Never half of a surrogate pair before the "…".
  return cut.length === ASK_REPLY_MAX && /[\uD800-\uDBFF]…$/.test(cut) ? `${cut.slice(0, -2)}…` : cut;
}

/** Claude's result text as a turn's reply and cards; null when it is unreadable. */
export function parseAnswer(result: string, scope: AskScope): ParsedAnswer | null {
  let text = result.trim();
  const fenced = FENCE.exec(text);
  if (fenced) text = (fenced[1] ?? '').trim();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(value) || typeof value.reply !== 'string') return null;
  const actions = value.actions ?? [];
  if (!Array.isArray(actions)) return null;
  const cards: AskCard[] = [];
  let dropped = Math.max(0, actions.length - ASK_CARDS_MAX);
  for (const raw of actions.slice(0, ASK_CARDS_MAX)) {
    const read = readAction(raw, scope);
    if (!read) {
      dropped += 1;
      continue;
    }
    cards.push({ action: read.action, state: 'proposed', ...(read.flag ? { flag: read.flag } : {}) });
  }
  // A reminder asked for and no todo given a time: each todo without one says so (over no_project).
  if (scope.remind && cards.every((c) => c.action.type !== 'todo' || untimedTodo(c.action))) {
    for (const c of cards) if (untimedTodo(c.action)) c.flag = 'no_time';
  }
  const reply = replyOf(value.reply);
  if (reply) return { reply, cards, dropped };
  return cards.length > 0 ? { cards, dropped } : { reply: ASK_SENTENCES.empty, cards, dropped };
}

export type Checked = { ok: true; action: AskWriteAction; flag?: AskFlag } | { ok: false; reason: string };

/**
 * A card's action (or the phone's edit of it) against the rules again, at
 * Add: the card form's schema, real days in range, food and money not
 * after today, and settleDue for a todo (a repeating one whose time passed
 * since the answer moves to its next day; past_time is worked out again).
 * A post's day is in range, and past_time is worked out again.
 * `noTime`: the card said no_time (it stays while there is still no time);
 * `noProject`: the card had a project name that matched none.
 */
export function checkWrite(a: AskWriteAction, scope: Pick<AskScope, 'today' | 'now'>, opts: { noTime?: boolean; noProject?: boolean } = {}): Checked {
  const parsed = AskWriteActionSchema.safeParse(a);
  if (!parsed.success) return { ok: false, reason: ASK_SENTENCES.badItem };
  const action = parsed.data;
  if (action.type === 'todo') {
    if (action.repeat && !action.due) return { ok: false, reason: ASK_SENTENCES.badItem };
    if (action.due && !dayInRange(action.due.day, scope.today)) return { ok: false, reason: ASK_SENTENCES.badDay };
    const settled = settleDue(action, scope);
    const flag = todoFlag(settled.action, settled.flag !== undefined, opts.noTime === true, opts.noProject === true && settled.action.projectId === undefined);
    return { ok: true, action: settled.action, ...(flag ? { flag } : {}) };
  }
  if (action.type === 'post') {
    if (action.due && !dayInRange(action.due.day, scope.today)) return { ok: false, reason: ASK_SENTENCES.badDay };
    return postPast(action, scope) ? { ok: true, action, flag: 'past_time' } : { ok: true, action };
  }
  if (!dayInRange(action.day, scope.today)) return { ok: false, reason: ASK_SENTENCES.badDay };
  if (action.day > scope.today) return { ok: false, reason: ASK_SENTENCES.futureDay };
  return { ok: true, action };
}
