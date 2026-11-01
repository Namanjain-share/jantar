/**
 * Projects and todos (WP-LS, spec 4.4). A reminder is a todo with a time.
 *
 * - Projects: name, status, emoji, notes, due day, folder (matched against
 *   Session.cwd by prefix on the phone, never opened). Delete moves its
 *   todos to no project. `open` and `overdue` come from one grouped SELECT.
 * - Todos: sorted by due (day, then time, a day without a time after the
 *   timed ones, undated last), then createdAt. Overdue = not done and due
 *   before today, or due today at a time before now.
 * - Repeat needs a due day. Done on a repeating todo moves `due.day` to
 *   `nextRepeat(repeat, due.day, max(due.day, today))`, keeping the time;
 *   it never gets `doneAt`, and Undo is the phone's toast PATCHing the old
 *   due back (done=false is a conflict). A monthly or (v0.5.3) yearly
 *   repeat keeps its date in `byMonthDay`, set from the due day on create,
 *   by a PATCH carrying `repeat` and a due on another date (the sheet), and
 *   by a PATCH giving it a repeat of that freq the todo did not have. Done,
 *   Snooze and a PATCH of `due` alone (Undo of Done, an older phone) never
 *   change it (31 Jan, 28 Feb, 31 Mar; a yearly 29 Feb, 28 Feb, 29 Feb), so
 *   Snooze, Done, Undo keeps the date as it keeps the time. A due day that
 *   is the stored date cut short by its month (30 Apr for the 31st) keeps
 *   it. A yearly todo snoozed past its date into the next month still
 *   repeats in its own month; the month lives in the due day only, so one
 *   snoozed later than that (over a month late) moves to the snooze's month.
 * - v0.5.3 `repeat.at`, the series' time: set from the due time on create,
 *   by a PATCH carrying `repeat` and `due` (removed with no time), and by a
 *   PATCH carrying `repeat` alone while the series has no time yet. Nothing
 *   else: a PATCH of `due` alone (Undo of Done, an older phone), one of
 *   `repeat` alone (new weekdays for a snoozed reminder) and Snooze keep
 *   it. Done puts the due time back to it, so a daily 11:00 snoozed an hour
 *   still rings at 11:00 the next day. A todo from before 0.5.3, and a
 *   repeating todo with no time, have none and keep their due time on Done
 *   (one with no time, snoozed and then done, keeps the snoozed time).
 * - Snooze moves `due` to life-core's `snoozeTarget` (1h, 20:00 tonight or
 *   tomorrow once 20:00 has passed, 09:00 tomorrow, Monday 09:00); 1h rings
 *   an hour on even inside the hour the clocks repeat (pings.ts).
 * - v0.5.3 folder todos (`jantar mcp` over ctl.sock): the project whose
 *   folder holds the given folder, the deepest winning (protocol
 *   projectFor, the Board's rule), among the projects left once a project
 *   linked to `/`, `/Users` or the home folder is dropped unless the folder
 *   is exactly that one: such a project holds every repo below it. Its open
 *   todos, or a todo added to it (no repeat, no other project).
 * - Every write saves, re-arms its ping (pings.ts), then emits life.changed.
 *   Replies carry ids only; refusals are the fixed sentences below.
 */
import { posix } from 'node:path';
import {
  LIFE_LIMITS,
  projectFor,
  type Due,
  type FolderTodoBody,
  type FolderTodosResponse,
  type Project,
  type ProjectBody,
  type ProjectPatch,
  type ProjectView,
  type Repeat,
  type SnoozePreset,
  type Todo,
  type TodoBody,
  type TodoPatch,
  type TodosQuery,
} from '@jantar/protocol';
import { hhmmOf, nextRepeat, shiftMonths, snoozeTarget } from '@jantar/life-core';
import type { Actor, LifeCore, LifeModuleDeps, LifeResult, TodosModule } from '../../contracts.js';
import { armTodo, todoPingHandler } from './pings.js';
import { TodosRepo } from './repo.js';

const count = (n: number) => n.toLocaleString('en-US');
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** What a refused call says: fixed daemon text, never user text. */
export const TODO_REASONS = {
  noTodo: 'No such todo.',
  noProject: 'No such project.',
  projectGone: "That project doesn't exist any more.",
  projectsFull: `You have ${count(LIFE_LIMITS.projects)} projects. Delete one to add another.`,
  todosFull: `You have ${count(LIFE_LIMITS.openTodos)} open todos. Finish or delete one to add another.`,
  repeatNeedsDue: 'A repeating todo needs a due day.',
  undoRepeating: 'Undo a repeating todo by setting its date back.',
  snoozeDone: 'This todo is done. Undo it first.',
  noFolderProject: 'No project is linked to this folder. On the phone: Projects › a project › Folder.',
} as const;

type Refusal = Extract<LifeResult, { ok: false }>;
const refuse = (code: Refusal['code'], reason: string): Refusal => ({ ok: false, code, reason });
const OK: LifeResult = { ok: true, value: true };

/** By due day, then time (a day without a time after the timed ones), undated last; then createdAt. */
export function byDue(a: Todo, b: Todo): number {
  const ad = a.due?.day;
  const bd = b.due?.day;
  if (ad !== bd) {
    if (ad === undefined) return 1;
    if (bd === undefined) return -1;
    return ad < bd ? -1 : 1;
  }
  const at = a.due?.time;
  const bt = b.due?.time;
  if (at !== bt) {
    if (at === undefined) return 1;
    if (bt === undefined) return -1;
    return at < bt ? -1 : 1;
  }
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/** Not done and due before `today`, or due today at a time before `nowHhmm`. */
export function isOverdue(t: Todo, today: string, nowHhmm: string): boolean {
  if (t.doneAt || !t.due) return false;
  if (t.due.day < today) return true;
  return t.due.day === today && t.due.time !== undefined && t.due.time < nowHhmm;
}

const STATUS_ORDER: Record<Project['status'], number> = { active: 0, paused: 1, done: 2 };

/** A repeat that keeps its date in byMonthDay. */
const datedFreq = (r: Repeat | undefined): boolean => r?.freq === 'monthly' || r?.freq === 'yearly';

/** A monthly or yearly repeat's date from `day`; the other repeats keep none. */
function withMonthDay(repeat: Repeat, day: string): Repeat {
  return datedFreq(repeat) ? { ...repeat, byMonthDay: Number(day.slice(8, 10)) } : repeat;
}

/** v0.5.3: the repeat with the series' time from `due` (none without a time). Only create and a PATCH carrying repeat call it. */
function withAt(repeat: Repeat, due: Due | undefined): Repeat {
  const { at: _given, ...rest } = repeat;
  return due?.time !== undefined ? { ...rest, at: due.time } : rest;
}

/**
 * The day a yearly series is counted from: its due day, or, when a Snooze
 * carried the due day past its date into the next month (31 Dec to 2 Jan),
 * that date in the month before, so Done still lands in its own month.
 */
function yearlyAnchor(day: string, byMonthDay: number | undefined): string {
  if (byMonthDay === undefined || shiftMonths(day, 0, byMonthDay) <= day) return day;
  return shiftMonths(day, -1, byMonthDay);
}

/** A folder as compared: normalized, without a trailing slash. */
function folderKey(path: string): string {
  const n = posix.normalize(path);
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}

/** Folders that hold every repo below them: a project linked to one counts only for exactly that folder. Compared lower-cased (APFS ignores case: `/users/<name>` is home too). */
const BROAD_FOLDERS = ['/', '/users'];

class Todos implements TodosModule {
  readonly name = 'todos' as const;

  constructor(
    private readonly core: LifeCore,
    private readonly repo: TodosRepo,
    /** The user's home folder (ctx.paths.userHome): a broad folder. */
    private readonly home: string,
  ) {}

  private nowHhmm(): string {
    return hhmmOf(this.core.now(), this.core.tz());
  }

  private stamp(): string {
    return this.core.now().toISOString();
  }

  /** Save, re-arm the ping, and tell the screens. `before`: the todo as stored (null on create); `at`: see ArmOptions. */
  private saved(t: Todo, before: Todo | null, at?: Date): void {
    this.repo.saveTodo(t);
    const fresh = !before || before.due?.day !== t.due?.day || before.due?.time !== t.due?.time;
    armTodo(this.core, t, this.repo.pingAt(t.id), { fresh, at });
    this.core.scheduler.poke();
    this.core.changed();
  }

  // --- projects --------------------------------------------------------------

  listProjects(): LifeResult<{ projects: ProjectView[] }> {
    const counts = this.repo.counts(this.core.today(), this.nowHhmm());
    const projects = this.repo
      .projects()
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id))
      .map((p) => ({ ...p, open: counts.get(p.id)?.open ?? 0, overdue: counts.get(p.id)?.overdue ?? 0 }));
    return { ok: true, value: { projects } };
  }

  createProject(body: ProjectBody, _actor: Actor): LifeResult<{ id: string }> {
    if (this.repo.projectCount() >= LIFE_LIMITS.projects) return refuse('conflict', TODO_REASONS.projectsFull);
    const at = this.stamp();
    const p: Project = { id: this.core.newId(), name: body.name, status: body.status ?? 'active', createdAt: at, updatedAt: at };
    if (body.emoji !== undefined) p.emoji = body.emoji;
    if (body.notes !== undefined) p.notes = body.notes;
    if (body.due !== undefined) p.due = body.due;
    if (body.folder !== undefined) p.folder = body.folder;
    this.repo.saveProject(p);
    this.core.changed();
    return { ok: true, value: { id: p.id } };
  }

  updateProject(id: string, patch: ProjectPatch, _actor: Actor): LifeResult {
    const p = this.repo.project(id);
    if (!p) return refuse('not_found', TODO_REASONS.noProject);
    const next: Project = { ...p, updatedAt: this.stamp() };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.status !== undefined) next.status = patch.status;
    for (const key of ['emoji', 'notes', 'due', 'folder'] as const) {
      const v = patch[key];
      if (v === null) delete next[key];
      else if (v !== undefined) next[key] = v;
    }
    this.repo.saveProject(next);
    this.core.changed();
    return OK;
  }

  removeProject(id: string, _actor: Actor): LifeResult {
    if (!this.repo.deleteProject(id, this.stamp())) return refuse('not_found', TODO_REASONS.noProject);
    this.core.changed();
    return OK;
  }

  // --- todos -----------------------------------------------------------------

  listTodos(q: TodosQuery): LifeResult<{ today: string; todos: Todo[] }> {
    const today = this.core.today();
    const todos = q.done ? this.repo.done(q.project) : this.repo.open(q.project).sort(byDue);
    return { ok: true, value: { today, todos } };
  }

  createTodo(body: TodoBody, _actor: Actor): LifeResult<{ id: string }> {
    if (body.repeat && !body.due) return refuse('invalid_request', TODO_REASONS.repeatNeedsDue);
    if (body.projectId !== undefined && !this.repo.project(body.projectId)) return refuse('invalid_request', TODO_REASONS.projectGone);
    if (this.repo.openCount() >= LIFE_LIMITS.openTodos) return refuse('conflict', TODO_REASONS.todosFull);
    const at = this.stamp();
    const t: Todo = { id: this.core.newId(), title: body.title, priority: body.priority ?? 'normal', createdAt: at, updatedAt: at };
    if (body.notes !== undefined) t.notes = body.notes;
    if (body.due !== undefined) t.due = body.due;
    if (body.projectId !== undefined) t.projectId = body.projectId;
    if (body.repeat !== undefined && body.due !== undefined) {
      // A monthly or yearly date the client named stays; otherwise the due day's. The series' time is the due time.
      t.repeat = withAt(body.repeat.byMonthDay !== undefined ? body.repeat : withMonthDay(body.repeat, body.due.day), body.due);
    }
    this.saved(t, null);
    return { ok: true, value: { id: t.id } };
  }

  updateTodo(id: string, patch: TodoPatch, _actor: Actor): LifeResult {
    const t = this.repo.todo(id);
    if (!t) return refuse('not_found', TODO_REASONS.noTodo);
    const next: Todo = { ...t, updatedAt: this.stamp() };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.priority !== undefined) next.priority = patch.priority;
    if (patch.notes === null) delete next.notes;
    else if (patch.notes !== undefined) next.notes = patch.notes;
    if (patch.due === null) delete next.due;
    else if (patch.due !== undefined) next.due = patch.due;
    if (patch.projectId === null) delete next.projectId;
    else if (patch.projectId !== undefined) {
      if (patch.projectId !== t.projectId && !this.repo.project(patch.projectId)) return refuse('invalid_request', TODO_REASONS.projectGone);
      next.projectId = patch.projectId;
    }
    if (patch.repeat === null) delete next.repeat;
    else if (patch.repeat !== undefined) next.repeat = patch.repeat;
    if (next.repeat && !next.due) return refuse('invalid_request', TODO_REASONS.repeatNeedsDue);

    if (next.repeat && datedFreq(next.repeat) && next.due) {
      const given = patch.repeat?.byMonthDay;
      const sameFreq = t.repeat?.freq === next.repeat.freq;
      const stored = sameFreq ? t.repeat?.byMonthDay : undefined;
      if (given !== undefined) next.repeat = { ...next.repeat, byMonthDay: given };
      // The stored date stays unless a PATCH carrying repeat moves the due to another date (28 Feb is the 31st in its month):
      // one carrying due alone (Undo of Done after a snooze across the date, an older phone) keeps it, as it keeps the time.
      else if (stored !== undefined && (patch.repeat === undefined || patch.due === undefined || shiftMonths(next.due.day, 0, stored) === next.due.day)) next.repeat = { ...next.repeat, byMonthDay: stored };
      else if (patch.due !== undefined || !sameFreq) next.repeat = withMonthDay(next.repeat, next.due.day);
    }
    // Only a PATCH carrying repeat sets the series' time: from the due it carries (the sheet's edit), or, carrying no due,
    // only while the series has none (a snoozed reminder's new weekdays keep 11:00). One carrying due alone keeps it.
    if (patch.repeat && next.repeat) {
      const kept = patch.due === undefined ? t.repeat?.at : undefined;
      next.repeat = kept !== undefined ? { ...next.repeat, at: kept } : withAt(next.repeat, next.due);
    }
    if (next.repeat && next.doneAt) {
      // A repeating todo is never done: making a done one repeat opens it again.
      if (this.repo.openCount() >= LIFE_LIMITS.openTodos) return refuse('conflict', TODO_REASONS.todosFull);
      delete next.doneAt;
    }
    this.saved(next, t);
    return OK;
  }

  setDone(id: string, done: boolean, _actor: Actor): LifeResult {
    const t = this.repo.todo(id);
    if (!t) return refuse('not_found', TODO_REASONS.noTodo);
    const next: Todo = { ...t, updatedAt: this.stamp() };
    if (t.repeat && t.due) {
      if (!done) return refuse('conflict', TODO_REASONS.undoRepeating);
      const today = this.core.today();
      const after = t.due.day > today ? t.due.day : today;
      const anchor = t.repeat.freq === 'yearly' ? yearlyAnchor(t.due.day, t.repeat.byMonthDay) : t.due.day;
      const day = nextRepeat(t.repeat, anchor, after);
      // Back to the series' time (a snooze moved it); a todo from before v0.5.3 keeps its due time.
      next.due = t.repeat.at !== undefined ? { day, time: t.repeat.at } : { ...t.due, day };
    } else if (done) {
      if (t.doneAt) return OK;
      next.doneAt = next.updatedAt;
    } else {
      if (!t.doneAt) return OK;
      if (this.repo.openCount() >= LIFE_LIMITS.openTodos) return refuse('conflict', TODO_REASONS.todosFull);
      delete next.doneAt;
    }
    this.saved(next, t);
    return OK;
  }

  snooze(id: string, preset: SnoozePreset, _actor: Actor): LifeResult {
    const t = this.repo.todo(id);
    if (!t) return refuse('not_found', TODO_REASONS.noTodo);
    if (t.doneAt) return refuse('conflict', TODO_REASONS.snoozeDone);
    const now = this.core.now();
    const target = snoozeTarget(preset, now, this.core.tz());
    // 1h is the instant an hour on (to the minute): inside the hour the clocks repeat, its wall time's first pass is now.
    const at = preset === '1h' ? new Date(Math.floor((now.getTime() + HOUR_MS) / MINUTE_MS) * MINUTE_MS) : undefined;
    this.saved({ ...t, due: { day: target.day, time: target.time }, updatedAt: this.stamp() }, t, at);
    return OK;
  }

  removeTodo(id: string, _actor: Actor): LifeResult {
    if (!this.repo.deleteTodo(id)) return refuse('not_found', TODO_REASONS.noTodo);
    this.core.scheduler.clear('todo', id);
    this.core.scheduler.poke();
    this.core.changed();
    return OK;
  }

  // --- v0.5.3 folder todos (jantar mcp) ----------------------------------------

  /** The project linked to `folder`: the deepest folder holding it, a broad folder only when it is exactly that one. */
  private projectAt(folder: string): Project | null {
    const at = folderKey(folder);
    const broad = new Set([...BROAD_FOLDERS, folderKey(this.home).toLowerCase()]);
    const linked: { p: Project; folder: string }[] = [];
    for (const p of this.repo.projects()) {
      if (!p.folder) continue;
      const key = folderKey(p.folder);
      if (!broad.has(key.toLowerCase()) || key === at) linked.push({ p, folder: key });
    }
    return projectFor(at, linked)?.p ?? null;
  }

  forFolder(folder: string): FolderTodosResponse {
    const today = this.core.today();
    const p = this.projectAt(folder);
    if (!p) return { today, project: null, todos: [] };
    return { today, project: { id: p.id, name: p.name, ...(p.emoji !== undefined ? { emoji: p.emoji } : {}) }, todos: this.repo.open(p.id).sort(byDue) };
  }

  createInFolder(body: FolderTodoBody, actor: Actor): LifeResult<{ id: string }> {
    const p = this.projectAt(body.folder);
    if (!p) return refuse('not_found', TODO_REASONS.noFolderProject);
    const { folder: _folder, ...todo } = body;
    return this.createTodo({ ...todo, projectId: p.id }, actor);
  }

  /** Today's part: open todos overdue on `day`, and due that day (repeating ones included). */
  today(day: string): { todos: { overdue: Todo[]; today: Todo[] } } {
    const isToday = day === this.core.today();
    // Before `day` began nothing was late yet that day; on today, a time before now is.
    const nowHhmm = isToday ? this.nowHhmm() : '00:00';
    const overdue: Todo[] = [];
    const due: Todo[] = [];
    for (const t of this.repo.openDueBy(day).sort(byDue)) {
      if (isOverdue(t, day, nowHhmm)) overdue.push(t);
      else if (t.due?.day === day) due.push(t);
    }
    return { todos: { overdue, today: due } };
  }
}

/**
 * Builds the module on `core` and registers its `todo` ping handler.
 * Every call reads core.db afresh (a restore swaps it).
 */
export function buildTodosModule(core: LifeCore, deps: LifeModuleDeps): TodosModule {
  const repo = new TodosRepo(core, deps.ctx.log.child({ part: 'life', module: 'todos' }));
  core.scheduler.register(todoPingHandler(core, deps, repo));
  return new Todos(core, repo, deps.ctx.paths.userHome);
}
