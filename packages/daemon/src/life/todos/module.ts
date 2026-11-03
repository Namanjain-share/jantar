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
 * - v0.10 `from: 'meeting'`: the daemon's mark on a todo made from a
 *   meeting's action item (createTodo's `opts`, which no route passes);
 *   every edit keeps it.
 * - v0.13 Work: one project as a hub (`hub`: its counts, open todos, the
 *   newest done, this week and life-core's health line), and the owner's
 *   `q` on the todos list (title and notes, any case; never in the SQL).
 *   P2: a follow-up is a todo with a client (`contactId`, and P3's
 *   `dealId`), a project has a client and a business; only the owner's own
 *   space ('') takes them (anywhere else is refused, O13), and Work, which
 *   never reads these tables, checks the ids it owns through the links it
 *   registers (`useWork`) and hears of a project's client changing inside
 *   the same transaction. It reads follow-ups and unlinks a deleted client
 *   through the methods below. A todo with a deal always has a client
 *   (W11): given a deal and no client, it takes the deal's; letting go of
 *   its client lets go of its deal too, unless the same change names one.
 * - Every write saves, re-arms its ping (pings.ts), then emits life.changed.
 *   Replies carry ids only; refusals are the fixed sentences below.
 */
import { posix } from 'node:path';
import {
  LIFE_LIMITS,
  projectFor,
  type Due,
  type FolderTodoBody,
  type OwnerProjectBody,
  type OwnerProjectPatch,
  type OwnerTodoBody,
  type OwnerTodoPatch,
  type FolderTodosResponse,
  type Project,
  type OwnerTodosQuery,
  type ProjectBody,
  type ProjectPatch,
  type ProjectView,
  type Repeat,
  type SnoozePreset,
  type Todo,
  type TodoBody,
  type TodoFrom,
  type TodoPatch,
  type TodosQuery,
} from '@jantar/protocol';
import { WORK_LIMITS, type ProjectHub, type WorkMilestone } from '@jantar/protocol/work';
import { hhmmOf, nextRepeat, projectHealth, projectWeeks, shiftMonths, snoozeTarget } from '@jantar/life-core';
import type { Actor, LifeCore, LifeModuleDeps, LifeResult, TodosModule, TodosWorkLinks } from '../../contracts.js';
import type { PersonTodo } from '@jantar/protocol/people';
import { armTodo, personOfSpace, todoPingHandler } from './pings.js';
import { DONE_LIST_MAX, TodosRepo } from './repo.js';
import { foldText, holdsFolded } from '../../core/fold.js';

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
  // v0.13 Work (O13): a client, a deal or a business only on his own todos and projects.
  ownTodosOnly: 'Only your own todos can have a client.',
  ownProjectsOnly: 'Only your own projects can have a client.',
  ownMilestonesOnly: 'Only your own projects can have milestones.',
  sharedList: "A shared list can't have a client.",
  clientGone: "That client doesn't exist any more.",
  dealGone: "That deal doesn't exist any more.",
  businessGone: "That business doesn't exist any more. Add it in Work's settings.",
} as const;

type Refusal = Extract<LifeResult, { ok: false }>;
const refuse = (code: Refusal['code'], reason: string): Refusal => ({ ok: false, code, reason });
const OK: LifeResult = { ok: true, value: true };

/** By due day, then time (a day without a time after the timed ones), undated last; then createdAt. Posts (v0.7) sort the same. */
export function byDue(a: Pick<Todo, 'due' | 'createdAt' | 'id'>, b: Pick<Todo, 'due' | 'createdAt' | 'id'>): number {
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

/** A folder as compared: normalized, without a trailing slash. v0.13: Work's seed compares folders the same way. */
export function folderKey(path: string): string {
  const n = posix.normalize(path);
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}

/** Folders that hold every repo below them: a project linked to one counts only for exactly that folder. Compared lower-cased (APFS ignores case: `/users/<name>` is home too). */
const BROAD_FOLDERS = ['/', '/users'];

class Todos implements TodosModule {
  readonly name = 'todos' as const;
  /** v0.11: this module in other spaces (her space's, built once). */
  private readonly spaces = new Map<string, Todos>();
  /** v0.13: what runs inside a project's delete (Work's). Only this instance's: her space's module has none. */
  private readonly deleteHooks: ((projectId: string) => void)[] = [];
  /** v0.13 Work P2: how the ids Work owns are checked, and its hook on a project's client (his space's module only). */
  private work: TodosWorkLinks | null = null;

  constructor(
    private readonly core: LifeCore,
    private readonly repo: TodosRepo,
    /** The user's home folder (ctx.paths.userHome): a broad folder. */
    private readonly home: string,
  ) {}

  /** v0.11 People: the same module over one space (the People module's person todos use it; no route reaches it otherwise). */
  inSpace(space: string): Todos {
    if (space === this.repo.space) return this;
    let m = this.spaces.get(space);
    if (!m) this.spaces.set(space, (m = new Todos(this.core, this.repo.inSpace(space), this.home)));
    return m;
  }

  /** v0.11: the space this module works in. */
  get space(): string {
    return this.repo.space;
  }

  /**
   * v0.11: his screens re-fetch on a write to his own space only. A write in
   * her space ticks her stream and, for areas his agreement covers, his
   * (life/people/space.ts), so his stream can't tell him she is active in
   * an area she keeps private (M11).
   */
  private changed(): void {
    if (this.repo.space === '') this.core.changed();
  }

  private nowHhmm(): string {
    return hhmmOf(this.core.now(), this.core.tz());
  }

  private stamp(): string {
    return this.core.now().toISOString();
  }

  /** Save, re-arm the ping, and tell the screens. `before`: the todo as stored (null on create); `at`: see ArmOptions. v0.11: `by` the author on create. */
  private saved(t: Todo, before: Todo | null, at?: Date, by = ''): void {
    this.repo.saveTodo(t, by);
    const fresh = !before || before.due?.day !== t.due?.day || before.due?.time !== t.due?.time;
    armTodo(this.core, t, this.repo.pingAt(t.id), { fresh, at, person: personOfSpace(this.repo.space) });
    this.core.scheduler.poke();
    this.changed();
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

  /** v0.13 Work: a project's client and business, checked (his space only; ids Work knows). null when they may be set. */
  private projectLinksRefused(p: { clientId?: string | null | undefined; business?: string | null | undefined }, list: boolean): Refusal | null {
    const client = p.clientId !== undefined && p.clientId !== null;
    const business = p.business !== undefined && p.business !== null;
    if (!client && !business) return null;
    if (this.repo.space !== '') return refuse('invalid_request', list || this.repo.space.startsWith('s:') ? TODO_REASONS.sharedList : TODO_REASONS.ownProjectsOnly);
    if (client && !this.work?.contact(p.clientId as string)) return refuse('invalid_request', TODO_REASONS.clientGone);
    if (business && !this.work?.business(p.business as string)) return refuse('invalid_request', TODO_REASONS.businessGone);
    return null;
  }

  createProject(body: ProjectBody | OwnerProjectBody, _actor: Actor): LifeResult<{ id: string }> {
    if (this.repo.projectCount() >= LIFE_LIMITS.projects) return refuse('conflict', TODO_REASONS.projectsFull);
    const links: OwnerProjectBody = body;
    const no = this.projectLinksRefused(links, false);
    if (no) return no;
    const at = this.stamp();
    const p: Project = { id: this.core.newId(), name: body.name, status: body.status ?? 'active', createdAt: at, updatedAt: at };
    if (body.emoji !== undefined) p.emoji = body.emoji;
    if (body.notes !== undefined) p.notes = body.notes;
    if (body.due !== undefined) p.due = body.due;
    if (body.folder !== undefined) p.folder = body.folder;
    if (links.clientId !== undefined) p.clientId = links.clientId;
    if (links.business !== undefined) p.business = links.business;
    // v0.13: Work links the project's meetings to its client in the same save.
    this.core.db.tx(() => {
      this.repo.saveProject(p);
      if (p.clientId !== undefined) this.work?.projectClient(p.id, undefined, p.clientId);
    });
    this.changed();
    return { ok: true, value: { id: p.id } };
  }

  updateProject(id: string, patch: ProjectPatch | OwnerProjectPatch, _actor: Actor): LifeResult {
    const p = this.repo.project(id);
    if (!p) return refuse('not_found', TODO_REASONS.noProject);
    const links: OwnerProjectPatch = patch;
    const no = this.projectLinksRefused(links, p.list !== undefined);
    if (no) return no;
    const next: Project = { ...p, updatedAt: this.stamp() };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.status !== undefined) next.status = patch.status;
    for (const key of ['emoji', 'notes', 'due', 'folder', 'clientId', 'business'] as const) {
      const v = links[key];
      if (v === null) delete next[key];
      else if (v !== undefined) next[key] = v;
    }
    // v0.13: a client changed moves the project's automatic meeting links with it, in the same save (Work's hook).
    this.core.db.tx(() => {
      this.repo.saveProject(next);
      if (p.clientId !== next.clientId) this.work?.projectClient(id, p.clientId, next.clientId);
    });
    this.changed();
    return OK;
  }

  removeProject(id: string, _actor: Actor): LifeResult {
    // v0.13: Work lets go of the project in the same transaction (its hook joins it).
    const gone = this.core.db.tx(() => {
      if (!this.repo.deleteProject(id, this.stamp())) return false;
      for (const hook of this.deleteHooks) hook(id);
      return true;
    });
    if (!gone) return refuse('not_found', TODO_REASONS.noProject);
    this.changed();
    return OK;
  }

  onProjectDeleted(fn: (projectId: string) => void): void {
    this.deleteHooks.push(fn);
  }

  useWork(links: TodosWorkLinks): void {
    this.work = links;
  }

  // --- v0.13 Work: follow-ups (todos with a client), his space only ----------------

  followUps(contactId: string | null, done: boolean): Todo[] {
    if (this.repo.space !== '') return [];
    const todos = this.repo.followUps(contactId, done);
    return done ? todos : todos.sort(byDue);
  }

  followUpCount(contactId: string): number {
    return this.repo.space === '' ? this.repo.followUpCount(contactId) : 0;
  }

  /**
   * A client deleted (Work's transaction, which this joins): its todos keep going with no client or deal,
   * and its projects with no client. How many of each were let go.
   */
  unlinkClient(contactId: string): { todos: number; projects: number } {
    if (this.repo.space !== '') return { todos: 0, projects: 0 };
    return this.core.db.tx(() => {
      const at = this.stamp();
      const todos = this.repo.allOfContact(contactId);
      for (const t of todos) {
        const { contactId: _c, dealId: _d, ...rest } = t;
        this.repo.saveTodo({ ...rest, updatedAt: at });
      }
      this.repo.clearContactColumn(contactId);
      const projects = this.repo.projects().filter((p) => p.clientId === contactId);
      for (const p of projects) {
        const { clientId: _c, ...rest } = p;
        this.repo.saveProject({ ...rest, updatedAt: at });
      }
      if (todos.length > 0 || projects.length > 0) this.changed();
      return { todos: todos.length, projects: projects.length };
    });
  }

  /**
   * v0.13 Work P3b: a merged client's todos and projects move to the client it was merged into (Work's
   * transaction, which this joins). How many of each moved.
   */
  relinkClient(from: string, to: string): { todos: number; projects: number } {
    if (this.repo.space !== '') return { todos: 0, projects: 0 };
    return this.core.db.tx(() => {
      const at = this.stamp();
      const todos = this.repo.allOfContact(from);
      for (const t of todos) this.repo.saveTodo({ ...t, contactId: to, updatedAt: at });
      const projects = this.repo.projects().filter((p) => p.clientId === from);
      for (const p of projects) this.repo.saveProject({ ...p, clientId: to, updatedAt: at });
      if (todos.length > 0 || projects.length > 0) this.changed();
      return { todos: todos.length, projects: projects.length };
    });
  }

  /** v0.13 Work P3: one of his projects' milestones (none: []), or null when he has no such project. */
  milestones(projectId: string): WorkMilestone[] | null {
    if (this.repo.space !== '') return null;
    const p = this.repo.project(projectId) as (Project & { milestones?: WorkMilestone[] }) | null;
    return p ? (p.milestones ?? []) : null;
  }

  /** v0.13 Work P3: one of his projects' milestones replaced (Work's route; never a project of hers or a shared list). */
  setMilestones(projectId: string, list: readonly WorkMilestone[], _actor: Actor): LifeResult {
    if (this.repo.space !== '') return refuse('invalid_request', TODO_REASONS.ownMilestonesOnly);
    const p = this.repo.project(projectId) as (Project & { milestones?: WorkMilestone[] }) | null;
    if (!p) return refuse('not_found', TODO_REASONS.noProject);
    if (p.list !== undefined) return refuse('invalid_request', TODO_REASONS.ownMilestonesOnly);
    const next: Project & { milestones?: WorkMilestone[] } = { ...p, updatedAt: this.stamp() };
    if (list.length === 0) delete next.milestones;
    else next.milestones = [...list];
    this.repo.saveProject(next);
    this.changed();
    return OK;
  }

  /** v0.13 Work P3: todos with a deal in his space: open ones by due (of every deal, or one), or one deal's done ones, newest first. */
  dealFollowUps(dealId: string | null, done: boolean): Todo[] {
    if (this.repo.space !== '') return [];
    const todos = this.repo.dealTodos(dealId, done);
    return done ? todos : todos.sort(byDue);
  }

  /** v0.13 Work P3: a deleted deal's todos keep going with no deal (inside Work's transaction). How many. */
  unlinkDeal(dealId: string): number {
    if (this.repo.space !== '') return 0;
    return this.core.db.tx(() => {
      const at = this.stamp();
      const todos = this.repo.allOfDeal(dealId);
      for (const t of todos) {
        const { dealId: _d, ...rest } = t;
        this.repo.saveTodo({ ...rest, updatedAt: at });
      }
      if (todos.length > 0) this.changed();
      return todos.length;
    });
  }

  /** A todo's client and deal, checked: his space only, ids Work knows. null when they may be set. */
  private todoLinksRefused(contactId: string | null | undefined, dealId: string | null | undefined): Refusal | null {
    const client = contactId !== undefined && contactId !== null;
    const deal = dealId !== undefined && dealId !== null;
    if (!client && !deal) return null;
    if (this.repo.space !== '') return refuse('invalid_request', TODO_REASONS.ownTodosOnly);
    if (client && !this.work?.contact(contactId)) return refuse('invalid_request', TODO_REASONS.clientGone);
    if (deal && !this.work?.dealClient(dealId)) return refuse('invalid_request', TODO_REASONS.dealGone);
    return null;
  }

  /** v0.13 (W11): a todo with a deal and no client takes the deal's client, so it rings, lists and shows as that client's follow-up. */
  private withDealClient(t: Todo): void {
    if (t.dealId === undefined || t.contactId !== undefined) return;
    const client = this.work?.dealClient(t.dealId);
    if (client) t.contactId = client;
  }

  // --- todos -----------------------------------------------------------------

  listTodos(q: TodosQuery | OwnerTodosQuery): LifeResult<{ today: string; todos: Todo[] }> {
    const today = this.core.today();
    // v0.13: the owner's ?q= (title and notes, any case); her routes never pass one.
    const text = 'q' in q && q.q !== undefined ? q.q : undefined;
    // v0.13 Work P2: the owner's ?contact= (one client's follow-ups, his space only).
    const contact = 'contact' in q && q.contact !== undefined ? q.contact : undefined;
    if (contact !== undefined) {
      const needle = text !== undefined ? foldText(text) : null;
      const todos = this.followUps(contact, q.done).filter(
        (t) => (q.project === undefined || (q.project === 'none' ? t.projectId === undefined : t.projectId === q.project)) && (needle === null || holdsFolded(needle, t.title, t.notes)),
      );
      return { ok: true, value: { today, todos: q.done ? todos.slice(0, DONE_LIST_MAX) : todos } };
    }
    if (text !== undefined) {
      const todos = this.repo.matching(text, q.done, q.project);
      return { ok: true, value: { today, todos: q.done ? todos : todos.sort(byDue) } };
    }
    const todos = q.done ? this.repo.done(q.project) : this.repo.open(q.project).sort(byDue);
    return { ok: true, value: { today, todos } };
  }

  /** v0.13 Work: one project as a hub (GET /v1/projects/:id). Its counts and its health use the same overdue rule. */
  hub(id: string): LifeResult<ProjectHub> {
    const p = this.repo.project(id);
    if (!p) return refuse('not_found', TODO_REASONS.noProject);
    const today = this.core.today();
    const nowHhmm = this.nowHhmm();
    const tz = this.core.tz();
    const now = this.core.now();
    const counts = this.repo.counts(today, nowHhmm).get(id) ?? { open: 0, overdue: 0 };
    const open = this.repo.open(id).sort(byDue);
    const weeks = projectWeeks(today, tz, WORK_LIMITS.hubWeeks);
    const since = weeks[0]?.start.toISOString() ?? now.toISOString();
    const lastTodo = this.repo.lastTodoChange(id);
    const health = projectHealth({
      open,
      doneAt: this.repo.doneAtSince(id, since),
      lastChange: lastTodo !== null && lastTodo > p.updatedAt ? lastTodo : p.updatedAt,
      status: p.status,
      now,
      today,
      nowHhmm,
      tz,
      weeks: WORK_LIMITS.hubWeeks,
      quietAfterDays: WORK_LIMITS.projectQuietDays,
    });
    const { list: _list, ...project } = p;
    return {
      ok: true,
      value: {
        project: { ...project, open: counts.open, overdue: counts.overdue },
        open,
        doneThisWeek: health.doneByWeek.at(-1) ?? 0,
        recentDone: this.repo.done(id, WORK_LIMITS.hubRecentDone),
        health: {
          overdue: health.overdue,
          ...(health.nextDue ? { nextDue: health.nextDue } : {}),
          ...(health.quietDays !== null ? { quietDays: health.quietDays } : {}),
          doneByWeek: health.doneByWeek,
        },
      },
    };
  }

  createTodo(body: TodoBody | OwnerTodoBody, _actor: Actor, opts: { from?: TodoFrom; by?: string; extra?: Partial<PersonTodo> } = {}): LifeResult<{ id: string }> {
    if (body.repeat && !body.due) return refuse('invalid_request', TODO_REASONS.repeatNeedsDue);
    if (body.projectId !== undefined && !this.repo.project(body.projectId)) return refuse('invalid_request', TODO_REASONS.projectGone);
    const links: OwnerTodoBody = body;
    const no = this.todoLinksRefused(links.contactId, links.dealId);
    if (no) return no;
    if (this.repo.openCount() >= LIFE_LIMITS.openTodos) return refuse('conflict', TODO_REASONS.todosFull);
    const at = this.stamp();
    const t: Todo = { ...(opts.extra ?? {}), id: this.core.newId(), title: body.title, priority: body.priority ?? 'normal', createdAt: at, updatedAt: at };
    if (body.notes !== undefined) t.notes = body.notes;
    if (opts.from !== undefined) t.from = opts.from;
    if (body.due !== undefined) t.due = body.due;
    if (body.projectId !== undefined) t.projectId = body.projectId;
    if (links.contactId !== undefined) t.contactId = links.contactId;
    if (links.dealId !== undefined) t.dealId = links.dealId;
    this.withDealClient(t);
    if (body.repeat !== undefined && body.due !== undefined) {
      // A monthly or yearly date the client named stays; otherwise the due day's. The series' time is the due time.
      t.repeat = withAt(body.repeat.byMonthDay !== undefined ? body.repeat : withMonthDay(body.repeat, body.due.day), body.due);
    }
    this.saved(t, null, undefined, opts.by ?? '');
    return { ok: true, value: { id: t.id } };
  }

  updateTodo(id: string, patch: TodoPatch | OwnerTodoPatch, _actor: Actor): LifeResult {
    const t = this.repo.todo(id);
    if (!t) return refuse('not_found', TODO_REASONS.noTodo);
    const links: OwnerTodoPatch = patch;
    // A link kept as it is needs no check (a client deleted since is unlinked by the delete itself).
    const no = this.todoLinksRefused(links.contactId === t.contactId ? undefined : links.contactId, links.dealId === t.dealId ? undefined : links.dealId);
    if (no) return no;
    const next: Todo = { ...t, updatedAt: this.stamp() };
    for (const key of ['contactId', 'dealId'] as const) {
      const v = links[key];
      if (v === null) delete next[key];
      else if (v !== undefined) next[key] = v;
    }
    // v0.13 (W11): no follow-up keeps a deal without a client, as a client's delete lets go of both.
    if (links.contactId === null && links.dealId === undefined) delete next.dealId;
    this.withDealClient(next);
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
    this.changed();
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
