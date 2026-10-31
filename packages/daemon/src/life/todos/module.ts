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
 *   due back (done=false is a conflict). A monthly repeat keeps its date in
 *   `byMonthDay`, set from the due day on create, when a PATCH sets `due`
 *   and when a PATCH gives a monthly repeat the todo did not have; Done and
 *   Snooze never change it (31 Jan, 28 Feb, 31 Mar). A PATCHed due day that
 *   is the stored date cut short by its month keeps it: Undo of Done on a
 *   todo on the 31st sends 28 Feb back, and the 31st stays.
 * - Snooze moves `due` to life-core's `snoozeTarget` (1h, 20:00 tonight or
 *   tomorrow once 20:00 has passed, 09:00 tomorrow, Monday 09:00); 1h rings
 *   an hour on even inside the hour the clocks repeat (pings.ts).
 * - Every write saves, re-arms its ping (pings.ts), then emits life.changed.
 *   Replies carry ids only; refusals are the fixed sentences below.
 */
import { LIFE_LIMITS, type Project, type ProjectBody, type ProjectPatch, type ProjectView, type Repeat, type SnoozePreset, type Todo, type TodoBody, type TodoPatch, type TodosQuery } from '@jantar/protocol';
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

/** A monthly repeat's date from `day`; the other repeats keep none. */
function withMonthDay(repeat: Repeat, day: string): Repeat {
  return repeat.freq === 'monthly' ? { ...repeat, byMonthDay: Number(day.slice(8, 10)) } : repeat;
}

class Todos implements TodosModule {
  readonly name = 'todos' as const;

  constructor(
    private readonly core: LifeCore,
    private readonly repo: TodosRepo,
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
      // A monthly date the client named stays; otherwise the due day's.
      t.repeat = body.repeat.byMonthDay !== undefined ? body.repeat : withMonthDay(body.repeat, body.due.day);
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

    if (next.repeat?.freq === 'monthly' && next.due) {
      const given = patch.repeat?.byMonthDay;
      const stored = t.repeat?.freq === 'monthly' ? t.repeat.byMonthDay : undefined;
      if (given !== undefined) next.repeat = { ...next.repeat, byMonthDay: given };
      // The stored date stays without a new due day, and with one that is that date in its month (28 Feb for the 31st).
      else if (stored !== undefined && (patch.due === undefined || shiftMonths(next.due.day, 0, stored) === next.due.day)) next.repeat = { ...next.repeat, byMonthDay: stored };
      else if (patch.due !== undefined || t.repeat?.freq !== 'monthly') next.repeat = withMonthDay(next.repeat, next.due.day);
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
      next.due = { ...t.due, day: nextRepeat(t.repeat, t.due.day, after) };
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
  return new Todos(core, repo);
}
