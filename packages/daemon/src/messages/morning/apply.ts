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
 *   each item made, so no run (after a re-link, a retry, an undo) makes the
 *   same one twice: `duplicate`. A 1:1 still waiting with nothing new gets
 *   no second draft: any line it waits on drafted before is a duplicate.
 * - Todos go to the "WhatsApp" project (made once as the system, its id in
 *   meta `project_id`, made again when deleted), `from: 'messages'`, with
 *   the chat, the line's time and a quote in their notes. A time stays only
 *   when the cited line states one (TIME_STATED), else the todo keeps its
 *   day (`time_not_stated`). At most todosPerRun.
 * - Call-backs are todos "Call back {who}" (who: the call's or the line's
 *   sender, never the model's words but for the owner's own line in a
 *   group), due today or the day the line states, at the time it states,
 *   else at the call-back time (none: a day only).
 * - Life's first refusal stops every todo and call-back after it: `limit`
 *   for its open-todo limit, `life_refused` for any other (Life closed, the
 *   project gone). Drafts aren't Life's: they go on.
 * - Replies are drafts (state open; a 1:1's number for Open in WhatsApp, a
 *   group none; `at`: when the cited line was written).
 * - A dry run writes nothing (no project, todo, draft or `made` row) and
 *   answers the same, without ids.
 *
 * What the model wrote is cut to its field and cleaned (no control or bidi
 * character; a title, a name or what they asked on one line). Nothing here
 * logs: titles, notes and drafts are other people's words.
 */
import { dayKeyOf, hhmmOf, instantAt, weekdayOf } from '@jantar/life-core';
import { MESSAGES_LIMITS, type Due, type TodoPriority } from '@jantar/protocol';
import type { ChatOwner, Draft, Message, MessagesPrefs, MorningAnswer } from '@jantar/protocol/messages';
import { cut } from '../../chat/text.js';
import type { Actor, LifeResult, LifeService } from '../../contracts.js';
import { SYSTEM_ACTOR } from '../../core/actor.js';
import { newId } from '../../core/ids.js';
import { CONTROL, LINE_END } from '../../rewrite/guards.js';
import type { MessagesDb } from '../db.js';
import { MESSAGES_SAYS } from '../says.js';
import { openFrom, stillWaiting, type Batch, type BatchCall, type BatchChat } from './collect.js';
import { lineBody, type RefMap } from './input.js';

/** The Life project the morning's todos go to. */
export const WHATSAPP_PROJECT = { name: 'WhatsApp', emoji: '💬' } as const;
/** messages.db meta: the WhatsApp project's id. */
export const PROJECT_KEY = 'project_id';
/** A call-back todo's title before its person (Today finds who it is for by it). */
export const CALLBACK_TITLE = 'Call back ';
/** A line that states a time: "5pm", "5 pm", "17:30", "5 baje". */
export const TIME_STATED = /\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b\d{1,2}:\d{2}\b|\bbaje\b/i;
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
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export type MadeKind = 'todo' | 'reply' | 'callback';
export type DropWhy = 'unknown_ref' | 'duplicate' | 'limit' | 'life_refused' | 'time_not_stated';

export interface ApplyDeps {
  life: Pick<LifeService, 'todos'>;
  db: MessagesDb;
  now: Date;
  /** The Life zone. */
  tz: string;
  prefs: MessagesPrefs;
  runId: string;
  dryRun: boolean;
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

  // This run's sources, and the ones made before.
  const taken = new Set<string>();
  const madeQ = d.db.prepare('SELECT 1 FROM made WHERE src_key = ?');
  const isMade = (src: string) => taken.has(src) || madeQ.get(src) !== undefined;
  const record = (src: string, kind: MadeKind, target: string) =>
    d.db.prepare('INSERT INTO made (src_key, run_id, kind, target_id) VALUES (?, ?, ?, ?)').run(src, d.runId, kind, target);

  /** Why Life stopped taking todos (its first refusal), or null while it takes them. */
  let refused: 'limit' | 'life_refused' | null = null;
  let project: string | undefined | null = null;
  /** A Life todo for `src`: its id (none in a dry run), or null once Life refused (`refused` says why). */
  const todo = (src: string, kind: MadeKind, body: { title: string; notes?: string; due?: Due; priority: TodoPriority }): { id?: string } | null => {
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
    record(src, kind, r.value.id);
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
    const time = lostTime ? undefined : t.due_time;
    const due = t.due_day ? (time ? { day: t.due_day, time } : { day: t.due_day }) : undefined;
    const title = oneLine(t.title, TITLE_MAX) || NO_TITLE;
    const made = todo(src, 'todo', { title, notes: todoNotes(hit, t.notes, d.tz), ...(due ? { due } : {}), priority: t.priority ?? 'normal' });
    if (!made) {
      drop('todo', t.ref, refused ?? 'limit');
      continue;
    }
    todos += 1;
    out.todos.push({ ...made, title, src: hit.m.msgKey });
    if (lostTime) drop('todo', t.ref, 'time_not_stated');
  }

  for (const c of answer.callbacks) {
    const callKey = c.ref.startsWith('k') ? refs.k.get(c.ref) : undefined;
    const call = callKey === undefined ? undefined : calls.get(callKey);
    const hit = c.ref.startsWith('m') ? lineOf(c.ref) : null;
    if (!call && !hit) {
      drop('callback', c.ref, 'unknown_ref');
      continue;
    }
    const src = `callback:${call ? call.callKey : hit!.m.msgKey}`;
    if (isMade(src)) {
      drop('callback', c.ref, 'duplicate');
      continue;
    }
    // A call states no time or day; a line only what it says.
    const stated = hit !== null && statesTime(hit.m);
    const lostTime = c.time_stated !== undefined && !stated;
    const time = stated && c.time_stated ? c.time_stated : (d.prefs.callbackAt ?? undefined);
    const day = hit && c.day_stated && c.day_stated >= today ? c.day_stated : today;
    const who = whoOf(call, hit, c.who);
    const why = multiLine(c.why, NOTES_MAX);
    const made = todo(src, 'callback', { title: oneLine(`${CALLBACK_TITLE}${who}`, TITLE_MAX), ...(why ? { notes: why } : {}), due: time ? { day, time } : { day }, priority: 'normal' });
    if (!made) {
      drop('callback', c.ref, refused ?? 'limit');
      continue;
    }
    out.callbacks.push({ ...made, who, ...(time ? { at: instantAt(day, time, d.tz).toISOString() } : {}) });
    if (lostTime) drop('callback', c.ref, 'time_not_stated');
  }

  for (const r of answer.replies) {
    const chatKey = refs.c.get(r.chat);
    const hit = lineOf(r.ref, true);
    if (chatKey === undefined || !hit || hit.chat.chatKey !== chatKey) {
      drop('reply', r.ref, 'unknown_ref');
      continue;
    }
    const src = `reply:${hit.m.msgKey}`;
    // Still waiting with nothing new: a draft for any line it waits on is this one.
    const bc = chatOf.get(chatKey);
    const asked = bc && stillWaiting(bc) ? bc.earlier.slice(openFrom(bc.earlier)).map((m) => `reply:${m.msgKey}`) : [src];
    if (asked.some(isMade)) {
      drop('reply', r.ref, 'duplicate');
      continue;
    }
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
      d.db
        .prepare('INSERT INTO drafts (id, run_id, chat_key, chat_name, phone, they_asked, draft, at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, d.runId, chatKey, draft.chatName, draft.phone ?? null, draft.theyAsked, draft.draft, draft.at, draft.state);
      record(src, 'reply', id);
    });
    out.replies.push({ id, ...draft });
  }
  return out;
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
  let removed = 0;
  if (targets.length > 0) {
    const open = d.life.todos.listTodos({ done: false });
    if (!open.ok) return open;
    const still = new Set(open.value.todos.map((t) => t.id));
    for (const id of targets) {
      if (!still.has(id)) continue;
      const r = d.life.todos.removeTodo(id, actor);
      if (r.ok) removed += 1;
      else if (r.code !== 'not_found') return r;
    }
  }
  const dismissed = Number(db.prepare("UPDATE drafts SET state = 'dismissed' WHERE run_id = ? AND state = 'open'").run(runId).changes);
  return { ok: true, value: { removed, dismissed } };
}
