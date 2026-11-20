/**
 * The morning run's answer, applied (0.15 Messages): Claude's todos,
 * call-backs and reply drafts into Life and messages.db. Nothing is sent.
 *
 * - Every item cites the input's ids (input.ts RefMap): a todo a new line
 *   (`m`), a call-back a missed call (`k`) or a new line, a reply its chat
 *   (`c`) and a new line of that chat (or, in a 1:1 still waiting with
 *   nothing new, a line it waits on). Anything else is dropped
 *   `unknown_ref`. That, and a run with no tools, is the daemon's whole
 *   guard against a chat's injected instruction: an item citing a real line
 *   is made as the model wrote it, marked as WhatsApp's words, and Chat
 *   frames it as data.
 * - `made` (messages.db) holds kind + ':' + the line's or call's key for
 *   each item made, the chat it came from (a call's: its 1:1) and whether a
 *   call-back is one person's (`person`), so no run
 *   (after a re-link, a retry, an undo) makes the same one twice
 *   (`duplicate`), and a skip finds what came from that chat. A 1:1 still
 *   waiting with nothing new gets no second draft: any line it waits on
 *   drafted before is a duplicate, even one budget() left out this time
 *   (its `waitsOn`).
 * - One of each per person: a call-back for someone who has one open in
 *   Life, made by this run or an earlier one, is a `duplicate`; so is a
 *   second draft for a chat in one answer. A new draft for a chat dismisses
 *   its older open ones (it replaces them). A person (Caller) is their 1:1,
 *   their number (shown, or their 1:1's as the batch or a draft has it) and
 *   the name shown, as callerKey reads them (an earlier call-back's from its
 *   title): two with a 1:1 are one by it alone; otherwise two with a number
 *   by it (two people can share a name), else by the name. So a caller with
 *   no 1:1 who starts one since, or a person whose call no longer finds
 *   their 1:1, gets one call-back; a number shown alone finds a 1:1 only
 *   by the number this run knows for it. A caller the reader names Unknown
 *   (alone or among others on a call) has neither (only that call is
 *   theirs), and a call-back from a line in a group is the group's
 *   (`made.person` 0): neither is ever taken for anyone's.
 * - Todos go to the "WhatsApp" project (made once as the system, its id in
 *   meta `project_id`, made again when deleted), `from: 'messages'`, with
 *   the chat, the line's time and a quote in their notes. A time stays only
 *   when the cited line states one (TIME_STATED), else the todo keeps its
 *   day (`time_not_stated`). At most todosPerRun.
 * - Call-backs are todos "Call back {who}" (who: the call's or the line's
 *   sender, never the model's words but for the owner's own line in a
 *   group), due today or the day the line states, at the time it states,
 *   else at the call-back time (none: a day only).
 * - A stated time with no day is on the cited line's own day (the prompt's
 *   rule too).
 * - A time already past when the answer is applied (`applyAt`: Claude can
 *   take minutes) would never ring (Life rings a new due time only when it
 *   is ahead): a call-back rings at the next quarter hour instead, a todo
 *   keeps its day only; both `time_passed`.
 * - Life's first refusal stops every todo and call-back after it: `limit`
 *   for its open-todo limit, `life_refused` for any other (Life closed, the
 *   project gone), also the result's `lifeRefused` for the run's report.
 *   With Life's Todos off (`todosOn` false) none is made: `life_refused`.
 *   Drafts aren't Life's: they go on.
 * - Replies are drafts (state open; a 1:1's number for Open in WhatsApp, a
 *   group none; `at`: when the cited line was written). A draft whose chat
 *   the owner has written to since is dismissed before a run applies
 *   (dismissAnswered), and a reply citing a line he wrote after in that
 *   chat (the batch's `wroteAt`, at or after the line) is never made
 *   (`answered`).
 * - A dry run writes nothing (no project, todo, draft or `made` row) and
 *   answers the same, without ids.
 *
 * What the model wrote is cut to its field and cleaned (no control or bidi
 * character; a title, a name or what they asked on one line). Nothing here
 * logs: titles, notes and drafts are other people's words.
 */
import { dayKeyOf, hhmmOf, instantAt, weekdayOf } from '@jantar/life-core';
import { MESSAGES_LIMITS, type Due, type Todo, type TodoPriority } from '@jantar/protocol';
import type { ChatOwner, Draft, Message, MessagesPrefs, MorningAnswer } from '@jantar/protocol/messages';
import { cut } from '../../chat/text.js';
import type { Actor, LifeResult, LifeService } from '../../contracts.js';
import { SYSTEM_ACTOR } from '../../core/actor.js';
import { newId } from '../../core/ids.js';
import { CONTROL, LINE_END } from '../../rewrite/guards.js';
import type { MessagesDb } from '../db.js';
import { MESSAGES_SAYS } from '../says.js';
import { NAMED, TEL, callerKey, openFrom, stillWaiting, type Batch, type BatchCall, type BatchChat } from './collect.js';
import { lineBody, type RefMap } from './input.js';

/** The Life project the morning's todos go to. */
export const WHATSAPP_PROJECT = { name: 'WhatsApp', emoji: '💬' } as const;
/** messages.db meta: the WhatsApp project's id. */
export const PROJECT_KEY = 'project_id';
/** A call-back todo's title before its person (Today finds who it is for by it). */
export const CALLBACK_TITLE = 'Call back ';
/**
 * A line that states a time: "5pm", "5 pm", "17:30", "at 5", "5 baje", "5 बजे"; never "at 50%". ("At 3 options"
 * still counts: accepted, since only a time the model also invents gets through.)
 */
export const TIME_STATED = /\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b\d{1,2}:\d{2}\b|\bat\s+\d{1,2}\b(?!\s*%)|\bbaje\b|बजे/i;
/** A todo's notes quote its line up to this many characters. */
export const QUOTE_MAX = 200;
/** Life's caps (protocol TodoTitleSchema, LongNotesSchema). */
const TITLE_MAX = 200;
const NOTES_MAX = 2000;
/** The answer's caps (MorningAnswerSchema), kept after cleaning. */
const WHO_MAX = 80;
const ASKED_MAX = 300;
const DRAFT_MAX = 1000;
/** A title that cleaning left empty. */
const NO_TITLE = 'From WhatsApp';
/** A call-back whose time has passed rings at the next quarter hour (every zone is whole quarter hours from UTC). */
const QUARTER_HOUR_MS = 900_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export type MadeKind = 'todo' | 'reply' | 'callback';
export type DropWhy = 'unknown_ref' | 'duplicate' | 'limit' | 'life_refused' | 'time_not_stated' | 'time_passed' | 'answered';

export interface ApplyDeps {
  life: Pick<LifeService, 'todos'>;
  db: MessagesDb;
  /** When the run started: its day is `today`. */
  now: Date;
  /** When the answer is applied (read just before): what a due time must be ahead of to ring. */
  applyAt: Date;
  /** The Life zone. */
  tz: string;
  prefs: MessagesPrefs;
  runId: string;
  dryRun: boolean;
  /** Life's Todos is on (settings.life.todos); off: no todo or call-back is made. */
  todosOn: boolean;
}

/** A reply draft as made (a dry run's has no id). */
export type MorningDraft = Omit<Draft, 'id'> & { id?: string };

/** What a run made (ids only when it wrote them), and each item left out or changed, by kind and the answer's ref. */
export interface ApplyResult {
  /** `src`: the line's key. */
  todos: { id?: string; title: string; src: string }[];
  replies: MorningDraft[];
  /** `at`: when it rings. */
  callbacks: { id?: string; who: string; at?: string }[];
  dropped: { kind: MadeKind; ref: string; why: DropWhy }[];
  /** Why Life stopped taking todos and call-backs (its first refusal); absent while it took them all. */
  lifeRefused?: 'limit' | 'life_refused';
}

/** One line: line ends and runs of space as one space, no control or bidi character, cut to `max`. */
function oneLine(s: string, max: number): string {
  return cut(s.replace(LINE_END, ' ').replace(CONTROL, '').replace(/\s+/g, ' ').trim(), max);
}

/** Text that keeps its lines: line ends as \n, no control or bidi character, cut to `max`. */
function multiLine(s: string, max: number): string {
  return cut(s.replace(LINE_END, '\n').replace(CONTROL, '').trim(), max);
}

/** "Fri 13 Nov 23:30" in the Life zone. */
function stamp(iso: string, tz: string): string {
  const at = new Date(iso);
  const day = dayKeyOf(at, tz);
  const [, month, date] = day.split('-');
  return `${WEEKDAYS[weekdayOf(day)]} ${Number(date)} ${MONTHS[Number(month) - 1]} ${hhmmOf(at, tz)}`;
}

/** The next quarter hour after `now`, as a Life day and time. */
function nextQuarter(now: Date, tz: string): { day: string; time: string } {
  const at = new Date((Math.floor(now.getTime() / QUARTER_HOUR_MS) + 1) * QUARTER_HOUR_MS);
  return { day: dayKeyOf(at, tz), time: hhmmOf(at, tz) };
}

/** The line states a time (its text or caption). */
function statesTime(m: Message): boolean {
  return TIME_STATED.test(m.text ?? '') || TIME_STATED.test(m.caption ?? '');
}

interface Line {
  m: Message;
  chat: ChatOwner;
}

/** A todo's notes: where it came from, a quote of its line, then the model's notes. */
function todoNotes(hit: Line, extra: string | undefined, tz: string): string {
  const head = `WhatsApp · ${oneLine(hit.chat.name, WHO_MAX)} · ${stamp(hit.m.at, tz)}\n"${oneLine(lineBody(hit.m), QUOTE_MAX)}"`;
  const more = extra ? multiLine(extra, NOTES_MAX) : '';
  return cut(more ? `${head}\n\n${more}` : head, NOTES_MAX);
}

/** Who a call-back is for: the call's name; a line's sender; the owner's own line, its 1:1 (or in a group the model's name). */
function whoOf(call: BatchCall | undefined, hit: Line | null, said: string): string {
  if (call) return oneLine(call.who, WHO_MAX);
  if (!hit) return oneLine(said, WHO_MAX);
  if (!hit.m.fromMe) return oneLine(hit.m.sender, WHO_MAX);
  if (hit.chat.kind === 'dm') return oneLine(hit.chat.name, WHO_MAX);
  return oneLine(said, WHO_MAX) || oneLine(hit.chat.name, WHO_MAX);
}

/** Who a call-back is for, to tell one person's from another's: their 1:1, their number and the name shown (callerKey's). */
interface Caller {
  chat?: string;
  tel?: string;
  name?: string;
}

/** A person by their 1:1 (if any), the name or number shown (`who`) and their 1:1's number when known; the reader's Unknown names no one. */
function callerOf(chat: string | undefined, who: string, phone: string | undefined): Caller {
  const k = callerKey(who);
  const fromPhone = phone ? callerKey(phone) : null;
  const tel = k?.startsWith(TEL) ? k : fromPhone?.startsWith(TEL) ? fromPhone : undefined;
  return { ...(chat ? { chat } : {}), ...(tel ? { tel } : {}), ...(k?.startsWith(NAMED) ? { name: k } : {}) };
}

/** Anything to tell them by (a caller the reader names Unknown, with no 1:1, has nothing: only that call is theirs). */
function knowsSomeone(p: Caller): boolean {
  return p.chat !== undefined || p.tel !== undefined || p.name !== undefined;
}

/**
 * `a` and `b` are one person: the same 1:1 when both have one; else the same
 * number when both have one (two people can share a name); else the same
 * name. So a saved contact shown by name with no 1:1 is the one their new
 * 1:1 names, whether or not that 1:1's number is known.
 */
function samePerson(a: Caller, b: Caller): boolean {
  if (a.chat !== undefined && b.chat !== undefined) return a.chat === b.chat;
  if (a.tel !== undefined && b.tel !== undefined) return a.tel === b.tel;
  return a.name !== undefined && a.name === b.name;
}

/** The WhatsApp project's id: the one in meta while Life still has it, else a new one; undefined when Life refuses. */
function ensureProject(d: ApplyDeps): string | undefined {
  const todos = d.life.todos;
  const have = d.db.meta(PROJECT_KEY);
  if (have) {
    const r = todos.listProjects();
    if (!r.ok) return undefined;
    if (r.value.projects.some((p) => p.id === have)) return have;
  }
  const made = todos.createProject({ name: WHATSAPP_PROJECT.name, emoji: WHATSAPP_PROJECT.emoji }, SYSTEM_ACTOR);
  if (!made.ok) return undefined;
  d.db.setMeta(PROJECT_KEY, made.value.id);
  return made.value.id;
}

/** Apply `answer` (its refs from `refs`, the lines and calls from `batch`, the kept batch the model read). */
export function applyMorning(answer: MorningAnswer, refs: RefMap, batch: Batch, d: ApplyDeps): ApplyResult {
  const out: ApplyResult = { todos: [], replies: [], callbacks: [], dropped: [] };
  const drop = (kind: MadeKind, ref: string, why: DropWhy) => out.dropped.push({ kind, ref, why });
  // New lines, for any item; a still-waiting 1:1's lines it waits on, for a reply only.
  const byKey = new Map<string, Line>();
  const waitedOn = new Map<string, Line>();
  const chatOf = new Map<string, BatchChat>();
  for (const bc of batch.chats) {
    chatOf.set(bc.chat.chatKey, bc);
    for (const m of bc.messages) byKey.set(m.msgKey, { m, chat: bc.chat });
    if (stillWaiting(bc)) for (const m of bc.earlier.slice(openFrom(bc.earlier))) waitedOn.set(m.msgKey, { m, chat: bc.chat });
  }
  const calls = new Map(batch.calls.map((c) => [c.callKey, c]));
  const lineOf = (ref: string, forReply = false): Line | null => {
    const key = refs.m.get(ref);
    if (key === undefined) return null;
    return byKey.get(key) ?? (forReply ? (waitedOn.get(key) ?? null) : null);
  };
  const today = dayKeyOf(d.now, d.tz);
  /** A due time Life would never ring: at or before the answer is applied. */
  const passed = (day: string, time: string) => instantAt(day, time, d.tz).getTime() <= d.applyAt.getTime();
  /** The day a line was written (a stated time with no day is on it). */
  const dayOf = (m: Message) => dayKeyOf(new Date(m.at), d.tz);

  // This run's sources, and the ones made before.
  const taken = new Set<string>();
  const madeQ = d.db.prepare('SELECT 1 FROM made WHERE src_key = ?');
  const isMade = (src: string) => taken.has(src) || madeQ.get(src) !== undefined;
  const record = (src: string, kind: MadeKind, target: string, chatKey: string | undefined, person?: boolean) =>
    d.db
      .prepare('INSERT INTO made (src_key, run_id, kind, target_id, chat_key, person) VALUES (?, ?, ?, ?, ?, ?)')
      .run(src, d.runId, kind, target, chatKey ?? null, person === undefined ? null : person ? 1 : 0);

  /** Why Life stopped taking todos (its first refusal, or Todos off), or null while it takes them. */
  let refused: 'limit' | 'life_refused' | null = d.todosOn ? null : 'life_refused';
  let project: string | undefined | null = null;
  /**
   * A Life todo for `src` (from `chatKey`'s chat; a call-back's `person`: one person's): its id (none in a dry run),
   * or null once Life refused (`refused` says why).
   */
  const todo = (
    src: string,
    kind: MadeKind,
    chatKey: string | undefined,
    body: { title: string; notes?: string; due?: Due; priority: TodoPriority },
    person?: boolean,
  ): { id?: string } | null => {
    if (refused) return null;
    if (d.dryRun) {
      taken.add(src);
      return {};
    }
    if (project === null) project = ensureProject(d);
    const r = d.life.todos.createTodo({ ...body, ...(project ? { projectId: project } : {}) }, SYSTEM_ACTOR, { from: 'messages' });
    if (!r.ok) {
      // Life's open-todo limit is its one conflict on a new todo.
      refused = r.code === 'conflict' ? 'limit' : 'life_refused';
      return null;
    }
    record(src, kind, r.value.id, chatKey, person);
    taken.add(src);
    return { id: r.value.id };
  };

  let todos = 0;
  for (const t of answer.todos) {
    const hit = lineOf(t.ref);
    if (!hit) {
      drop('todo', t.ref, 'unknown_ref');
      continue;
    }
    const src = `todo:${hit.m.msgKey}`;
    if (isMade(src)) {
      drop('todo', t.ref, 'duplicate');
      continue;
    }
    if (todos >= MESSAGES_LIMITS.todosPerRun) {
      drop('todo', t.ref, 'limit');
      continue;
    }
    const lostTime = t.due_time !== undefined && !statesTime(hit.m);
    let time = lostTime ? undefined : t.due_time;
    const day = t.due_day ?? (time ? dayOf(hit.m) : undefined);
    const late = day !== undefined && time !== undefined && passed(day, time);
    if (late) time = undefined;
    const due = day ? (time ? { day, time } : { day }) : undefined;
    const title = oneLine(t.title, TITLE_MAX) || NO_TITLE;
    const made = todo(src, 'todo', hit.chat.chatKey, { title, notes: todoNotes(hit, t.notes, d.tz), ...(due ? { due } : {}), priority: t.priority ?? 'normal' });
    if (!made) {
      drop('todo', t.ref, refused ?? 'limit');
      continue;
    }
    todos += 1;
    out.todos.push({ ...made, title, src: hit.m.msgKey });
    if (lostTime) drop('todo', t.ref, 'time_not_stated');
    if (late) drop('todo', t.ref, 'time_passed');
  }

  // A 1:1's number: the batch's chat, else the newest draft for it (an earlier call-back's chat may not be in this batch).
  const phones = new Map<string, string | undefined>();
  const phoneOf = (chatKey: string): string | undefined => {
    if (!phones.has(chatKey)) {
      const row = d.db.prepare('SELECT phone FROM drafts WHERE chat_key = ? AND phone IS NOT NULL ORDER BY at DESC LIMIT 1').get(chatKey) as { phone: string } | undefined;
      phones.set(chatKey, chatOf.get(chatKey)?.chat.phone ?? row?.phone);
    }
    return phones.get(chatKey);
  };
  // The call-backs still open in Life, each as its person: this run's, and (read once) those earlier runs made. One
  // from a group's line (or from before `made.person`, a line's) is its chat alone.
  const calledBack: Caller[] = [];
  let earlier: Caller[] | null = null;
  const openCallbacks = (): Caller[] => {
    if (earlier !== null) return earlier;
    const rows = d.db.prepare("SELECT target_id, chat_key, person FROM made WHERE kind = 'callback' AND target_id IS NOT NULL").all() as {
      target_id: string;
      chat_key: string | null;
      person: number | null;
    }[];
    earlier = [];
    if (rows.length === 0) return earlier;
    const open = d.life.todos.listTodos({ done: false });
    const titles = new Map(open.ok ? open.value.todos.map((t) => [t.id, t.title]) : []);
    for (const r of rows) {
      const title = titles.get(r.target_id);
      if (title === undefined) continue;
      const chat = r.chat_key ?? undefined;
      const theirs = chat === undefined || r.person === 1;
      earlier.push(theirs && title.startsWith(CALLBACK_TITLE) ? callerOf(chat, title.slice(CALLBACK_TITLE.length), chat === undefined ? undefined : phoneOf(chat)) : chat ? { chat } : {});
    }
    return earlier;
  };
  const callbackOpen = (p: Caller): boolean => calledBack.some((o) => samePerson(p, o)) || openCallbacks().some((o) => samePerson(p, o));

  for (const c of answer.callbacks) {
    const callKey = c.ref.startsWith('k') ? refs.k.get(c.ref) : undefined;
    const call = callKey === undefined ? undefined : calls.get(callKey);
    const hit = c.ref.startsWith('m') ? lineOf(c.ref) : null;
    if (!call && !hit) {
      drop('callback', c.ref, 'unknown_ref');
      continue;
    }
    const src = `callback:${call ? call.callKey : hit!.m.msgKey}`;
    const chatKey = call ? call.chatKey : hit!.chat.chatKey;
    const who = whoOf(call, hit, c.who);
    // One person's (a call; a line in a 1:1), or a group line's: a group's chat is many people.
    const one = call !== undefined || hit!.chat.kind === 'dm';
    const phone = chatKey === undefined ? undefined : call ? phoneOf(chatKey) : (hit!.chat.phone ?? phoneOf(chatKey));
    const person = one ? callerOf(chatKey, who, phone) : undefined;
    if (isMade(src) || (!refused && person !== undefined && knowsSomeone(person) && callbackOpen(person))) {
      drop('callback', c.ref, 'duplicate');
      continue;
    }
    // A call states no time or day; a line only what it says (a time with no day: the line's own day).
    const stated = hit !== null && statesTime(hit.m);
    const lostTime = c.time_stated !== undefined && !stated;
    const statedTime = stated && c.time_stated ? c.time_stated : undefined;
    let time = statedTime ?? d.prefs.callbackAt ?? undefined;
    let day = hit && c.day_stated ? c.day_stated : statedTime ? dayOf(hit!.m) : today;
    // A day gone with no time it states: today's call-back time.
    if (day < today && !statedTime) day = today;
    // Still owed once its time is gone (a late run, a morning time after the call-back time): it rings soon.
    const late = time !== undefined && passed(day, time);
    if (late) ({ day, time } = nextQuarter(d.applyAt, d.tz));
    const why = multiLine(c.why, NOTES_MAX);
    const made = todo(src, 'callback', chatKey, { title: oneLine(`${CALLBACK_TITLE}${who}`, TITLE_MAX), ...(why ? { notes: why } : {}), due: time ? { day, time } : { day }, priority: 'normal' }, one);
    if (!made) {
      drop('callback', c.ref, refused ?? 'limit');
      continue;
    }
    // A group line's is its chat's alone, as an earlier run's is.
    calledBack.push(person ?? { chat: chatKey! });
    out.callbacks.push({ ...made, who, ...(time ? { at: instantAt(day, time, d.tz).toISOString() } : {}) });
    if (lostTime) drop('callback', c.ref, 'time_not_stated');
    if (late) drop('callback', c.ref, 'time_passed');
  }

  // The chats this run drafted a reply for: one each.
  const drafted = new Set<string>();
  for (const r of answer.replies) {
    const chatKey = refs.c.get(r.chat);
    const hit = lineOf(r.ref, true);
    if (chatKey === undefined || !hit || hit.chat.chatKey !== chatKey) {
      drop('reply', r.ref, 'unknown_ref');
      continue;
    }
    // He wrote in that chat at or after the line (in WhatsApp, in this batch): answered, as dismissAnswered has it.
    const wrote = batch.wroteAt[chatKey];
    if (wrote !== undefined && Date.parse(wrote) >= Date.parse(hit.m.at)) {
      drop('reply', r.ref, 'answered');
      continue;
    }
    const src = `reply:${hit.m.msgKey}`;
    // Still waiting with nothing new: a draft for any line it waits on (budget's waitsOn: all of them, kept or not) is this one.
    const bc = chatOf.get(chatKey);
    const waits = bc && stillWaiting(bc) ? (bc.waitsOn ?? bc.earlier.slice(openFrom(bc.earlier)).map((m) => m.msgKey)) : [];
    if (drafted.has(chatKey) || [src, ...waits.map((k) => `reply:${k}`)].some(isMade)) {
      drop('reply', r.ref, 'duplicate');
      continue;
    }
    drafted.add(chatKey);
    const draft: MorningDraft = {
      runId: d.runId,
      chatKey,
      chatName: hit.chat.name,
      ...(hit.chat.kind === 'dm' && hit.chat.phone ? { phone: hit.chat.phone } : {}),
      theyAsked: oneLine(r.they_asked, ASKED_MAX),
      draft: multiLine(r.draft, DRAFT_MAX),
      at: hit.m.at,
      state: 'open',
    };
    taken.add(src);
    if (d.dryRun) {
      out.replies.push(draft);
      continue;
    }
    const id = newId();
    d.db.tx(() => {
      // It replaces the chat's open draft: Waiting on you has one row per chat.
      d.db.prepare("UPDATE drafts SET state = 'dismissed' WHERE chat_key = ? AND state = 'open'").run(chatKey);
      d.db
        .prepare('INSERT INTO drafts (id, run_id, chat_key, chat_name, phone, they_asked, draft, at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, d.runId, chatKey, draft.chatName, draft.phone ?? null, draft.theyAsked, draft.draft, draft.at, draft.state);
      record(src, 'reply', id, chatKey);
    });
    out.replies.push({ id, ...draft });
  }
  // Said only when Life (or Todos off) did leave something out.
  if (refused && out.dropped.some((x) => x.why === refused)) out.lifeRefused = refused;
  return out;
}

/**
 * Before a run applies: the open drafts of each chat in `wroteAt` (when the
 * owner last wrote to it, collect.ts Batch) whose line came before that are
 * dismissed, since he answered in WhatsApp itself. How many.
 */
export function dismissAnswered(db: MessagesDb, wroteAt: Readonly<Record<string, string>>): number {
  const open = db.prepare("SELECT id, chat_key, at FROM drafts WHERE state = 'open'").all() as { id: string; chat_key: string; at: string }[];
  const dismiss = db.prepare("UPDATE drafts SET state = 'dismissed' WHERE id = ? AND state = 'open'");
  let n = 0;
  db.tx(() => {
    for (const r of open) {
      const wrote = wroteAt[r.chat_key];
      if (wrote !== undefined && Date.parse(wrote) >= Date.parse(r.at)) n += Number(dismiss.run(r.id).changes);
    }
  });
  return n;
}

/**
 * Undo a run: each todo and call-back it made that is still open goes
 * (Life's removeTodo, as `actor`); its open drafts are dismissed. `made` is
 * kept, so a later run never makes them again. not_found for a run
 * messages.db never heard of.
 */
export function undoMorning(d: Pick<ApplyDeps, 'life' | 'db'>, runId: string, actor: Actor): LifeResult<{ removed: number; dismissed: number }> {
  const db = d.db;
  const targets = (db.prepare("SELECT target_id FROM made WHERE run_id = ? AND kind IN ('todo', 'callback') AND target_id IS NOT NULL").all(runId) as { target_id: string }[]).map((r) => r.target_id);
  const known =
    targets.length > 0 ||
    db.prepare('SELECT 1 FROM runs WHERE id = ?').get(runId) !== undefined ||
    db.prepare('SELECT 1 FROM made WHERE run_id = ?').get(runId) !== undefined ||
    db.prepare('SELECT 1 FROM drafts WHERE run_id = ?').get(runId) !== undefined;
  if (!known) return { ok: false, code: 'not_found', reason: MESSAGES_SAYS.noRun };
  const removed = removeOpen(d.life, targets, actor);
  if (!removed.ok) return removed;
  const dismissed = Number(db.prepare("UPDATE drafts SET state = 'dismissed' WHERE run_id = ? AND state = 'open'").run(runId).changes);
  return { ok: true, value: { removed: removed.value, dismissed } };
}

/**
 * A chat just skipped (after db.ts forgetChat, in the skip's transaction):
 * each todo and call-back the morning made from it that is still open goes,
 * as Undo removes them; a done one stays the owner's. `made` keeps their
 * sources. How many went.
 */
export function removeChatTodos(d: Pick<ApplyDeps, 'life' | 'db'>, chatKey: string, actor: Actor): LifeResult<number> {
  const targets = (d.db.prepare("SELECT target_id FROM made WHERE chat_key = ? AND kind IN ('todo', 'callback') AND target_id IS NOT NULL").all(chatKey) as { target_id: string }[]).map((r) => r.target_id);
  return removeOpen(d.life, targets, actor);
}

/**
 * Every chat on the skip list: each todo and call-back the morning made from
 * it that is open in Life and unchanged since its chat's skip goes, as
 * removeChatTodos takes them (a restored Life backup made before a skip
 * brings them back, stamped before it). One changed since is the owner's
 * and stays: done at the skip and reopened, snoozed, edited. Asks Life only
 * when such a chat has any made. How many went.
 */
export function removeSkippedTodos(d: Pick<ApplyDeps, 'life' | 'db'>, actor: Actor): LifeResult<number> {
  const rows = d.db
    .prepare("SELECT m.target_id, s.added_at FROM made m JOIN skip s ON s.chat_key = m.chat_key WHERE m.kind IN ('todo', 'callback') AND m.target_id IS NOT NULL")
    .all() as { target_id: string; added_at: string }[];
  const skippedAt = new Map(rows.map((r) => [r.target_id, Date.parse(r.added_at)]));
  // A stamp that won't read counts as from before the skip.
  return removeOpen(d.life, [...skippedAt.keys()], actor, (t) => !(Date.parse(t.updatedAt) > (skippedAt.get(t.id) ?? Number.NaN)));
}

/** Each of `targets` still open in Life (and `fits`, when given) goes (removeTodo as `actor`); how many went. */
function removeOpen(life: ApplyDeps['life'], targets: readonly string[], actor: Actor, fits?: (t: Todo) => boolean): LifeResult<number> {
  if (targets.length === 0) return { ok: true, value: 0 };
  const open = life.todos.listTodos({ done: false });
  if (!open.ok) return open;
  const still = new Set(open.value.todos.filter((t) => !fits || fits(t)).map((t) => t.id));
  let removed = 0;
  for (const id of targets) {
    if (!still.has(id)) continue;
    const r = life.todos.removeTodo(id, actor);
    if (r.ok) removed += 1;
    else if (r.code !== 'not_found') return r;
  }
  return { ok: true, value: removed };
}
