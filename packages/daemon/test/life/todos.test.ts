/**
 * Projects and todos (life/todos), on createTestLifeCore (in-memory life.db,
 * FakeClock, recording scheduler), and their routes through the API with a
 * real Life service:
 *
 * - projects: defaults, counts (open, overdue), null clears, delete moves
 *   todos to no project, the cap;
 * - todos: sort order, overdue, the done list, the cap, project checks;
 * - repeat: Done moves the due day on (never `doneAt`), Undo of a
 *   repeating todo is a conflict, one left undone stays overdue and rings no
 *   more; a monthly repeat keeps its date (31 Jan, 28 Feb, 31 Mar) under the
 *   byMonthDay rules, through the phone's Undo in a short month too;
 * - snooze presets land where life-core says;
 * - pings: a timed todo has a row at its due instant, a past or untimed one
 *   none; LS3 (todo part): a done or deleted todo's ping is not sent;
 * - pings with the real scheduler: a reminder due and not yet sent (muted,
 *   or a catch-up whose send failed at start) keeps its row through edits
 *   and resync; a time a few seconds gone when written rings; Snooze 1h in
 *   the hour the clocks repeat rings an hour on;
 * - routes: ids-only replies, fixed sentences, audit rows with the target
 *   id only, life.changed {} after each write, no Life text in events or
 *   audit.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIFE_MARKER, projectBody, todoBody } from '@jantar/fixtures';
import { LIFE_LIMITS, SettingsSchema, type Todo } from '@jantar/protocol';
import type { Actor, LifeCore, LifeModule, LifeModuleBuilders, LifeService, TodosModule } from '../../src/contracts.js';
import { createTestContext, createTestLifeCore, type TestLifeCore } from '../../src/core/testing.js';
import { memoryLogger } from '../../src/core/log.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import type { LifeSendResult } from '../../src/life/push.js';
import { LifeScheduler } from '../../src/life/scheduler.js';
import { buildLifeService } from '../../src/life/service.js';
import { buildTodosModule, byDue, TODO_REASONS } from '../../src/life/todos/module.js';
import { h, makeApi, makeFakes, pairCookie, type TestApi } from '../api/fakes.js';

const CLI: Actor = { kind: 'cli' };
const MIN = 60_000;

let core: TestLifeCore;
let todos: TodosModule;

function build(tz = 'UTC', at = '2026-10-30T09:00:00.000Z'): void {
  core = createTestLifeCore({ tz, settings: { todos: true } });
  core.clock.set(at);
  const ctx = createTestContext({ clock: core.clock });
  const f = makeFakes(ctx);
  todos = buildTodosModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
}

function ok<T>(r: { ok: true; value: T } | { ok: false; code: string; reason: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return r.value;
}

const add = (over: Parameters<TodosModule['createTodo']>[0]) => ok(todos.createTodo(over, CLI)).id;
const get = (id: string): Todo => {
  const all = [...ok(todos.listTodos({ done: false })).todos, ...ok(todos.listTodos({ done: true })).todos];
  const t = all.find((x) => x.id === id);
  if (!t) throw new Error(`no todo ${id}`);
  return t;
};

/** The module's part of Today for `day`. */
function dueOn(day: string): { overdue: Todo[]; today: Todo[] } {
  const part = todos.today(day).todos;
  if (!part) throw new Error('no todos part');
  return part;
}

afterEach(() => core?.close());

describe('projects', () => {
  beforeEach(() => build());

  it('create defaults to active; the list carries open and overdue counts', () => {
    const p = ok(todos.createProject(projectBody({ emoji: '🛠', due: '2026-11-15', folder: '/synthetic/home/work/a' }), CLI)).id;
    const q = ok(todos.createProject({ name: 'Example paused', status: 'paused' }, CLI)).id;
    add({ title: 'Overdue', projectId: p, due: { day: '2026-10-29' } });
    add({ title: 'Earlier today', projectId: p, due: { day: '2026-10-30', time: '08:00' } }); // 09:00 now
    add({ title: 'Later today', projectId: p, due: { day: '2026-10-30', time: '11:00' } });
    add({ title: 'Undated', projectId: p });
    const done = add({ title: 'Done one', projectId: p, due: { day: '2026-10-01' } });
    ok(todos.setDone(done, true, CLI));
    const list = ok(todos.listProjects()).projects;
    expect(list.map((x) => x.id)).toEqual([p, q]);
    expect(list[0]).toMatchObject({ name: 'Example project', status: 'active', emoji: '🛠', due: '2026-11-15', folder: '/synthetic/home/work/a', open: 4, overdue: 2 });
    expect(list[1]).toMatchObject({ status: 'paused', open: 0, overdue: 0 });
  });

  it('update changes fields, and null clears emoji, notes, due and folder', () => {
    const p = ok(todos.createProject(projectBody({ emoji: '🛠', due: '2026-11-15', folder: '/synthetic/home/work/a' }), CLI)).id;
    core.clock.advance(MIN);
    ok(todos.updateProject(p, { name: 'Renamed', status: 'done', emoji: null, notes: null, due: null, folder: null }, CLI));
    const v = ok(todos.listProjects()).projects[0];
    expect(v).toMatchObject({ name: 'Renamed', status: 'done', updatedAt: '2026-10-30T09:01:00.000Z' });
    expect(v).not.toHaveProperty('emoji');
    expect(v).not.toHaveProperty('notes');
    expect(v).not.toHaveProperty('due');
    expect(v).not.toHaveProperty('folder');
  });

  it('delete moves its todos to no project', () => {
    const p = ok(todos.createProject(projectBody(), CLI)).id;
    const t = add({ title: 'In the project', projectId: p });
    ok(todos.removeProject(p, CLI));
    expect(ok(todos.listProjects()).projects).toEqual([]);
    expect(get(t)).not.toHaveProperty('projectId');
    expect(ok(todos.listTodos({ project: 'none', done: false })).todos.map((x) => x.id)).toEqual([t]);
    expect(core.db.prepare('SELECT project_id FROM todos WHERE id = ?').get(t)).toEqual({ project_id: null });
  });

  it('unknown ids answer not_found with a fixed sentence; the cap answers conflict', () => {
    expect(todos.updateProject('01JFZ8X8Y3T0V5G9WQK2M4N6PR', { name: 'x' }, CLI)).toEqual({ ok: false, code: 'not_found', reason: TODO_REASONS.noProject });
    expect(todos.removeProject('01JFZ8X8Y3T0V5G9WQK2M4N6PR', CLI)).toMatchObject({ code: 'not_found' });
    for (let i = 0; i < LIFE_LIMITS.projects; i++) ok(todos.createProject({ name: `Example ${i}` }, CLI));
    expect(todos.createProject({ name: 'One more' }, CLI)).toEqual({ ok: false, code: 'conflict', reason: 'You have 200 projects. Delete one to add another.' });
  });
});

describe('todos', () => {
  beforeEach(() => build());

  it('create: priority normal by default, stamps, an unknown project refused, a repeat without a day refused', () => {
    const id = add(todoBody());
    expect(get(id)).toMatchObject({ title: 'Example todo', notes: 'Synthetic todo notes', priority: 'normal', createdAt: '2026-10-30T09:00:00.000Z' });
    expect(todos.createTodo({ title: 'x', projectId: '01JFZ8X8Y3T0V5G9WQK2M4N6PR' }, CLI)).toEqual({ ok: false, code: 'invalid_request', reason: TODO_REASONS.projectGone });
    expect(todos.createTodo({ title: 'x', repeat: { freq: 'daily' } }, CLI)).toMatchObject({ code: 'invalid_request', reason: 'A repeating todo needs a due day.' });
  });

  it('lists by due day, then time (a day without one after the timed ones), undated last, then created', () => {
    const ids: Record<string, string> = {};
    const mk = (name: string, due?: { day: string; time?: string }) => {
      core.clock.advance(1000);
      ids[name] = add({ title: name, ...(due ? { due } : {}) });
    };
    mk('undated-a');
    mk('31st-day-only', { day: '2026-10-31' });
    mk('31st-0900', { day: '2026-10-31', time: '09:00' });
    mk('30th-1100', { day: '2026-10-30', time: '11:00' });
    mk('31st-0800', { day: '2026-10-31', time: '08:00' });
    mk('undated-b');
    mk('29th', { day: '2026-10-29' });
    const order = ok(todos.listTodos({ done: false })).todos.map((t) => t.title);
    expect(order).toEqual(['29th', '30th-1100', '31st-0800', '31st-0900', '31st-day-only', 'undated-a', 'undated-b']);
    expect(ok(todos.listTodos({ done: false })).today).toBe('2026-10-30');
    expect([...ok(todos.listTodos({ done: false })).todos].sort(byDue).map((t) => t.title)).toEqual(order);
  });

  it('done=1 lists the newest 100 done; a project filter applies to both lists', () => {
    const p = ok(todos.createProject(projectBody(), CLI)).id;
    const inP = add({ title: 'in project', projectId: p });
    for (let i = 0; i < 105; i++) {
      core.clock.advance(1000);
      ok(todos.setDone(add({ title: `t${i}` }), true, CLI));
    }
    const done = ok(todos.listTodos({ done: true })).todos;
    expect(done).toHaveLength(100);
    expect(done[0]?.title).toBe('t104');
    expect(ok(todos.listTodos({ project: p, done: false })).todos.map((t) => t.id)).toEqual([inP]);
    expect(ok(todos.listTodos({ project: p, done: true })).todos).toEqual([]);
  });

  it('update: null clears notes, due, project and repeat; a repeat left without a day is refused', () => {
    const p = ok(todos.createProject(projectBody(), CLI)).id;
    const id = add({ title: 'x', notes: 'n', due: { day: '2026-10-31' }, projectId: p, repeat: { freq: 'weekly' } });
    expect(todos.updateTodo(id, { due: null }, CLI)).toMatchObject({ code: 'invalid_request', reason: TODO_REASONS.repeatNeedsDue });
    ok(todos.updateTodo(id, { title: 'y', priority: 'high', notes: null, projectId: null, repeat: null, due: null }, CLI));
    const t = get(id);
    expect(t).toMatchObject({ title: 'y', priority: 'high' });
    for (const k of ['notes', 'due', 'projectId', 'repeat']) expect(t).not.toHaveProperty(k);
    expect(todos.updateTodo(id, { projectId: '01JFZ8X8Y3T0V5G9WQK2M4N6PR' }, CLI)).toMatchObject({ code: 'invalid_request' });
    expect(todos.updateTodo('01JFZ8X8Y3T0V5G9WQK2M4N6PR', { title: 'z' }, CLI)).toEqual({ ok: false, code: 'not_found', reason: 'No such todo.' });
  });

  it('a one-off todo: Done stamps doneAt and leaves the open list; Undo puts it back; both twice are no-ops', () => {
    const id = add({ title: 'x' });
    ok(todos.setDone(id, true, CLI));
    const at = get(id).doneAt;
    expect(at).toBe('2026-10-30T09:00:00.000Z');
    core.clock.advance(MIN);
    ok(todos.setDone(id, true, CLI));
    expect(get(id).doneAt).toBe(at);
    expect(ok(todos.listTodos({ done: false })).todos).toEqual([]);
    ok(todos.setDone(id, false, CLI));
    ok(todos.setDone(id, false, CLI));
    expect(get(id)).not.toHaveProperty('doneAt');
  });

  it('the open-todo cap answers conflict', () => {
    core.db.tx(() => {
      for (let i = 0; i < LIFE_LIMITS.openTodos; i++) {
        const t: Todo = { id: core.newId(), title: `t${i}`, priority: 'normal', createdAt: 'a', updatedAt: 'a' };
        core.db.prepare('INSERT INTO todos (id, updated_at, json) VALUES (?, ?, ?)').run(t.id, 'a', JSON.stringify({ ...t, createdAt: '2026-10-30T09:00:00.000Z', updatedAt: '2026-10-30T09:00:00.000Z' }));
      }
    });
    expect(todos.createTodo({ title: 'one more' }, CLI)).toEqual({ ok: false, code: 'conflict', reason: 'You have 5,000 open todos. Finish or delete one to add another.' });
  });

  it('every write tells the screens (life.changed); reads do not', () => {
    const before = core.changedCount;
    const id = add({ title: 'x' });
    ok(todos.updateTodo(id, { title: 'y' }, CLI));
    ok(todos.setDone(id, true, CLI));
    ok(todos.removeTodo(id, CLI));
    todos.listTodos({ done: false });
    todos.listProjects();
    todos.today('2026-10-30');
    expect(core.changedCount - before).toBe(4);
  });
});

describe('repeating todos', () => {
  it('Done moves the due day to the next one after its day and today, keeping the time; never doneAt', () => {
    build('UTC', '2026-10-30T09:00:00.000Z'); // a Friday
    const daily = add({ title: 'Daily', due: { day: '2026-10-27', time: '08:00' }, repeat: { freq: 'daily' } });
    ok(todos.setDone(daily, true, CLI));
    expect(get(daily).due).toEqual({ day: '2026-10-31', time: '08:00' });
    expect(get(daily)).not.toHaveProperty('doneAt');
    // Ahead of today: the next one after its own day.
    ok(todos.setDone(daily, true, CLI));
    expect(get(daily).due).toEqual({ day: '2026-11-01', time: '08:00' });
    const weekly = add({ title: 'Mon and Thu', due: { day: '2026-10-29' }, repeat: { freq: 'weekly', byWeekday: [1, 4] } });
    ok(todos.setDone(weekly, true, CLI));
    expect(get(weekly).due).toEqual({ day: '2026-11-02' });
    const sameWeekday = add({ title: 'Weekly', due: { day: '2026-10-28' }, repeat: { freq: 'weekly' } });
    ok(todos.setDone(sameWeekday, true, CLI));
    expect(get(sameWeekday).due).toEqual({ day: '2026-11-04' });
  });

  it('Undo of a repeating todo is a conflict with its sentence', () => {
    build();
    const id = add({ title: 'Daily', due: { day: '2026-10-30' }, repeat: { freq: 'daily' } });
    expect(todos.setDone(id, false, CLI)).toEqual({ ok: false, code: 'conflict', reason: 'Undo a repeating todo by setting its date back.' });
  });

  it('left undone, it stays overdue and rings no more after its time', () => {
    build('UTC', '2026-10-30T07:00:00.000Z');
    const id = add({ title: 'Daily', due: { day: '2026-10-30', time: '08:00' }, repeat: { freq: 'daily' } });
    const handler = core.scheduler.handlers.get('todo');
    const row = core.scheduler.row('todo', id);
    expect(row?.nextAt).toBe('2026-10-30T08:00:00.000Z');
    // After the ring, the scheduler asks for the next time: none until Done.
    expect(handler?.next(row!, new Date('2026-10-30T08:00:00.000Z'))).toBeNull();
    core.clock.set('2026-11-02T09:00:00.000Z');
    expect(dueOn('2026-11-02').overdue.map((t) => t.id)).toEqual([id]);
    ok(todos.setDone(id, true, CLI));
    expect(get(id).due).toEqual({ day: '2026-11-03', time: '08:00' });
    expect(core.scheduler.row('todo', id)?.nextAt).toBe('2026-11-03T08:00:00.000Z');
  });

  it('a monthly repeat on the 31st: 31 Jan, 28 Feb, 31 Mar', () => {
    build('UTC', '2027-01-31T09:00:00.000Z');
    const id = add({ title: 'Monthly', due: { day: '2027-01-31' }, repeat: { freq: 'monthly' } });
    expect(get(id).repeat).toEqual({ freq: 'monthly', byMonthDay: 31 });
    ok(todos.setDone(id, true, CLI));
    expect(get(id).due?.day).toBe('2027-02-28');
    core.clock.set('2027-02-28T09:00:00.000Z');
    ok(todos.setDone(id, true, CLI));
    expect(get(id).due?.day).toBe('2027-03-31');
    expect(get(id).repeat?.byMonthDay).toBe(31);
  });

  it('byMonthDay: a PATCH setting due takes its date; giving a monthly repeat takes the due date; repeating the stored one keeps it', () => {
    build('UTC', '2027-02-01T09:00:00.000Z');
    const id = add({ title: 'Monthly', due: { day: '2027-01-31' }, repeat: { freq: 'monthly' } });
    ok(todos.setDone(id, true, CLI)); // 28 Feb, still the 31st
    ok(todos.updateTodo(id, { repeat: { freq: 'monthly' } }, CLI));
    expect(get(id).repeat).toEqual({ freq: 'monthly', byMonthDay: 31 });
    ok(todos.updateTodo(id, { title: 'Renamed' }, CLI));
    expect(get(id).repeat?.byMonthDay).toBe(31);
    // Undo by PATCHing the old due back keeps the 31st.
    ok(todos.updateTodo(id, { due: { day: '2027-01-31' } }, CLI));
    expect(get(id).repeat?.byMonthDay).toBe(31);
    ok(todos.updateTodo(id, { due: { day: '2027-02-15' } }, CLI));
    expect(get(id).repeat?.byMonthDay).toBe(15);
    const weekly = add({ title: 'Weekly', due: { day: '2027-02-10' }, repeat: { freq: 'weekly' } });
    ok(todos.updateTodo(weekly, { repeat: { freq: 'monthly' } }, CLI));
    expect(get(weekly).repeat).toEqual({ freq: 'monthly', byMonthDay: 10 });
    ok(todos.updateTodo(weekly, { repeat: { freq: 'daily' } }, CLI));
    expect(get(weekly).repeat).toEqual({ freq: 'daily' });
    // A date the client names stays.
    const named = add({ title: 'Named', due: { day: '2027-02-28' }, repeat: { freq: 'monthly', byMonthDay: 30 } });
    expect(get(named).repeat?.byMonthDay).toBe(30);
  });

  it("byMonthDay: the phone's Undo in a short month (28 Feb PATCHed back) keeps the 31st", () => {
    build('UTC', '2027-02-01T09:00:00.000Z');
    const id = add({ title: 'Monthly', due: { day: '2027-01-31' }, repeat: { freq: 'monthly' } });
    ok(todos.setDone(id, true, CLI));
    const before = get(id).due;
    expect(before).toEqual({ day: '2027-02-28' });
    ok(todos.setDone(id, true, CLI));
    expect(get(id).due?.day).toBe('2027-03-31');
    ok(todos.updateTodo(id, { due: before ?? null }, CLI)); // Undo
    expect(get(id)).toMatchObject({ due: { day: '2027-02-28' }, repeat: { freq: 'monthly', byMonthDay: 31 } });
    ok(todos.setDone(id, true, CLI));
    expect(get(id).due?.day).toBe('2027-03-31');
    // 30 April is the 31st cut short too; 27 February is a new date.
    ok(todos.updateTodo(id, { due: { day: '2027-04-30' }, repeat: { freq: 'monthly' } }, CLI));
    expect(get(id).repeat?.byMonthDay).toBe(31);
    ok(todos.updateTodo(id, { due: { day: '2027-02-27' } }, CLI));
    expect(get(id).repeat?.byMonthDay).toBe(27);
  });

  it('making a done todo repeat opens it again', () => {
    build();
    const id = add({ title: 'x', due: { day: '2026-10-30' } });
    ok(todos.setDone(id, true, CLI));
    ok(todos.updateTodo(id, { repeat: { freq: 'daily' } }, CLI));
    expect(get(id)).not.toHaveProperty('doneAt');
  });
});

describe('snooze', () => {
  it('1h, tonight, tomorrow and next week land where life-core says, with a time, in the Life zone', () => {
    build('Asia/Kolkata', '2026-10-30T09:00:00.000Z'); // 14:30 IST, a Friday
    const id = add({ title: 'x', due: { day: '2026-10-29' } });
    ok(todos.snooze(id, '1h', CLI));
    expect(get(id).due).toEqual({ day: '2026-10-30', time: '15:30' });
    expect(core.scheduler.row('todo', id)?.nextAt).toBe('2026-10-30T10:00:00.000Z');
    ok(todos.snooze(id, 'tonight', CLI));
    expect(get(id).due).toEqual({ day: '2026-10-30', time: '20:00' });
    ok(todos.snooze(id, 'tomorrow', CLI));
    expect(get(id).due).toEqual({ day: '2026-10-31', time: '09:00' });
    ok(todos.snooze(id, 'nextWeek', CLI));
    expect(get(id).due).toEqual({ day: '2026-11-02', time: '09:00' });
    core.clock.set('2026-10-30T15:00:00.000Z'); // 20:30 IST
    ok(todos.snooze(id, 'tonight', CLI));
    expect(get(id).due).toEqual({ day: '2026-10-31', time: '20:00' });
  });

  it('a monthly repeat keeps its date through a snooze; a done todo is refused', () => {
    build('UTC', '2027-01-31T09:00:00.000Z');
    const id = add({ title: 'Monthly', due: { day: '2027-01-31' }, repeat: { freq: 'monthly' } });
    ok(todos.snooze(id, 'tomorrow', CLI));
    expect(get(id).due).toEqual({ day: '2027-02-01', time: '09:00' });
    expect(get(id).repeat?.byMonthDay).toBe(31);
    const done = add({ title: 'x' });
    ok(todos.setDone(done, true, CLI));
    expect(todos.snooze(done, '1h', CLI)).toEqual({ ok: false, code: 'conflict', reason: TODO_REASONS.snoozeDone });
  });
});

describe('pings', () => {
  beforeEach(() => build('UTC', '2026-10-30T09:00:00.000Z'));

  it('a timed todo has a row at its due instant; past, untimed, done and deleted ones have none', () => {
    const timed = add(todoBody({}, { timed: { day: '2026-10-30', time: '11:00' } }));
    expect(core.scheduler.row('todo', timed)?.nextAt).toBe('2026-10-30T11:00:00.000Z');
    const past = add(todoBody({}, { timed: { day: '2026-10-30', time: '08:00' } }));
    expect(core.scheduler.row('todo', past)).toBeUndefined();
    const untimed = add({ title: 'x', due: { day: '2026-10-31' } });
    expect(core.scheduler.row('todo', untimed)).toBeUndefined();
    ok(todos.updateTodo(untimed, { due: { day: '2026-10-31', time: '07:00' } }, CLI));
    expect(core.scheduler.row('todo', untimed)?.nextAt).toBe('2026-10-31T07:00:00.000Z');
    ok(todos.setDone(untimed, true, CLI));
    expect(core.scheduler.row('todo', untimed)).toBeUndefined();
    ok(todos.setDone(untimed, false, CLI));
    expect(core.scheduler.row('todo', untimed)?.nextAt).toBe('2026-10-31T07:00:00.000Z');
    ok(todos.removeTodo(timed, CLI));
    expect(core.scheduler.row('todo', timed)).toBeUndefined();
    expect(core.scheduler.pokes).toBeGreaterThan(0);
  });

  it('LS3 (todo part): a done todo, a deleted one and one moved since are not sent', () => {
    const id = add(todoBody({}, { timed: { day: '2026-10-30', time: '11:00' } }));
    const handler = core.scheduler.handlers.get('todo')!;
    const row = { ...core.scheduler.row('todo', id)! };
    const due = new Date('2026-10-30T11:00:00.000Z');
    expect(handler.check(row, due, false)).toBe('send');
    ok(todos.snooze(id, 'tomorrow', CLI));
    expect(handler.check(row, due, false)).toBe('skip');
    // After a skip the row follows the todo to its new time; one already past rings no more.
    expect(handler.next(row, due)?.toISOString()).toBe('2026-10-31T09:00:00.000Z');
    ok(todos.updateTodo(id, { due: { day: '2026-10-30', time: '10:00' } }, CLI));
    expect(handler.next(row, due)).toBeNull();
    ok(todos.setDone(id, true, CLI));
    expect(handler.check(row, due, false)).toBe('cancel');
    ok(todos.setDone(id, false, CLI));
    ok(todos.removeTodo(id, CLI));
    expect(handler.check(row, due, false)).toBe('cancel');
  });

  it('resync rebuilds the rows: open timed future todos ring, the rest are cleared', () => {
    const a = add(todoBody({}, { timed: { day: '2026-10-30', time: '11:00' } }));
    const b = add(todoBody({}, { timed: { day: '2026-10-30', time: '12:00' } }));
    ok(todos.setDone(b, true, CLI));
    // Rows in the table for a todo that is gone and for the done one (the real scheduler writes them there).
    const row = core.db.prepare("INSERT INTO pings (id, kind, ref, sub, next_at) VALUES (?, 'todo', ?, '', '2026-10-30T10:00:00.000Z')");
    row.run('x1', 'gone');
    row.run('x2', b);
    core.scheduler.clear('todo', a);
    const from = core.scheduler.calls.length;
    core.scheduler.handlers.get('todo')!.resync();
    expect(core.scheduler.row('todo', a)?.nextAt).toBe('2026-10-30T11:00:00.000Z');
    const calls = core.scheduler.calls.slice(from);
    expect(calls[0]).toEqual({ op: 'set', kind: 'todo', ref: a, sub: '', nextAt: '2026-10-30T11:00:00.000Z' });
    expect(calls.slice(1)).toEqual(
      expect.arrayContaining([
        { op: 'clear', kind: 'todo', ref: 'gone' },
        { op: 'clear', kind: 'todo', ref: b },
      ]),
    );
    expect(calls).toHaveLength(3);
  });
});

describe('pings with the real scheduler', () => {
  interface Sent {
    body: string;
    at: string;
    delivered: boolean;
  }

  /** createTestLifeCore with the real scheduler in place of the recording one; `answer.result` is what each send answers. */
  function realRig(tz: string, start: string) {
    const test = createTestLifeCore({ tz, settings: { todos: true, timezone: tz } });
    test.clock.set(start);
    const sent: Sent[] = [];
    const answer: { result: LifeSendResult } = { result: { delivered: 1, failed: 0 } };
    const sched = new LifeScheduler(test.clock, memoryLogger(), () => test.db, {
      send: async (p) => {
        sent.push({ body: p.body, at: test.clock.iso(), delivered: answer.result.delivered > 0 });
        return { ...answer.result };
      },
    });
    const core: LifeCore = { ...test, scheduler: sched };
    const ctx = createTestContext({ clock: test.clock });
    const f = makeFakes(ctx);
    const todos = buildTodosModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
    sched.start();
    rigs.push({ stop: () => sched.stop(), close: () => test.close() });
    return {
      answer,
      sent,
      sched,
      todos,
      clock: test.clock,
      /** The pushes that reached a device. */
      delivered: () => sent.filter((x) => x.delivered).map((x) => x.body),
      row: (id: string) => sched.rows('todo').find((r) => r.ref === id),
      settle: async (ms: number) => {
        await test.clock.tick(ms);
        await sched.settled();
        await test.clock.tick(0);
      },
    };
  }
  const rigs: { stop(): void; close(): void }[] = [];
  afterEach(() => {
    for (const r of rigs.splice(0)) {
      r.stop();
      r.close();
    }
  });
  const reminder = (r: ReturnType<typeof realRig>, time: string, day = '2026-10-30') => ok(r.todos.createTodo({ title: 'Example reminder', due: { day, time } }, CLI)).id;

  it('a muted reminder keeps its row through an edit and a resync, goes once the mute ends, and its rung row then clears', async () => {
    const r = realRig('UTC', '2026-10-30T10:58:00.000Z');
    r.answer.result = { delivered: 0, failed: 0, muted: true };
    const id = reminder(r, '11:00');
    await r.settle(2 * MIN);
    expect(r.sent.length).toBeGreaterThan(0);
    expect(r.row(id)).toMatchObject({ nextAt: '2026-10-30T11:00:00.000Z', claimedAt: null });
    ok(r.todos.updateTodo(id, { title: 'Renamed reminder', due: { day: '2026-10-30', time: '11:00' } }, CLI));
    r.sched.resyncAll(); // as a restart, a zone change or a module turned on again does
    expect(r.row(id)?.nextAt).toBe('2026-10-30T11:00:00.000Z');
    r.answer.result = { delivered: 1, failed: 0 };
    await r.settle(30_000);
    expect(r.delivered()).toEqual(['Renamed reminder · 11:00']);
    // Rung: parked, so the next edit or resync clears it and nothing rings twice.
    ok(r.todos.updateTodo(id, { title: 'Again' }, CLI));
    r.sched.resyncAll();
    expect(r.row(id)).toBeUndefined();
    await r.settle(5 * MIN);
    expect(r.delivered()).toHaveLength(1);
  });

  it('LS6 at start: a catch-up whose send fails is retried on the next sweep, not cleared by the resync', async () => {
    const r = realRig('UTC', '2026-10-30T10:58:00.000Z');
    const id = reminder(r, '11:00');
    // The daemon stops before 11:00 and starts again at 11:30, before the network is up.
    r.sched.stop();
    r.clock.set('2026-10-30T11:30:00.000Z');
    r.answer.result = { delivered: 0, failed: 1 };
    r.sched.start();
    await r.settle(0);
    expect(r.sent).toHaveLength(1);
    expect(r.row(id)).toMatchObject({ nextAt: '2026-10-30T11:00:00.000Z', failures: 1, claimedAt: null });
    r.answer.result = { delivered: 1, failed: 0 };
    await r.settle(30_000);
    expect(r.delivered()).toEqual(['Missed at 11:00 · Example reminder · 11:00']);
    expect(r.row(id)?.nextAt).toBeNull();
  });

  it('a time a few seconds gone when written rings, on time; minutes gone does not; Undo after the ring sends nothing again', async () => {
    const r = realRig('UTC', '2026-10-30T10:00:20.000Z');
    const id = reminder(r, '10:00');
    expect(r.row(id)?.nextAt).toBe('2026-10-30T10:00:00.000Z');
    await r.settle(30_000);
    expect(r.delivered()).toEqual(['Example reminder · 10:00']);
    ok(r.todos.setDone(id, true, CLI));
    ok(r.todos.setDone(id, false, CLI));
    expect(r.row(id)).toBeUndefined();
    const gone = reminder(r, '09:57');
    expect(r.row(gone)).toBeUndefined();
    // A new time a few seconds gone, by an edit, rings too.
    const moved = reminder(r, '12:00');
    ok(r.todos.updateTodo(moved, { due: { day: '2026-10-30', time: '10:00' } }, CLI));
    await r.settle(2 * MIN);
    expect(r.delivered()).toEqual(['Example reminder · 10:00', 'Example reminder · 10:00']);
  });

  it('Snooze 1h in the hour the clocks repeat (America/New_York, 2026-11-01) rings an hour on, once', async () => {
    const r = realRig('America/New_York', '2026-11-01T05:40:00.000Z'); // 01:40 EDT, the first pass
    const id = ok(r.todos.createTodo({ title: 'Example reminder' }, CLI)).id;
    ok(r.todos.snooze(id, '1h', CLI));
    const t = ok(r.todos.listTodos({ done: false })).todos[0];
    expect(t?.due).toEqual({ day: '2026-11-01', time: '01:40' });
    expect(r.row(id)?.nextAt).toBe('2026-11-01T06:40:00.000Z'); // 01:40 EST
    await r.settle(30 * MIN);
    r.sched.resyncAll();
    expect(r.row(id)?.nextAt).toBe('2026-11-01T06:40:00.000Z');
    for (let i = 0; i < 90; i++) await r.settle(MIN);
    expect(r.sent.map((x) => [x.at, x.body])).toEqual([['2026-11-01T06:40:00.000Z', 'Example reminder · 01:40']]);
  });
});

describe("today's part", () => {
  it('overdue (before today, or earlier today with a time) and due today, repeating ones included', () => {
    build('UTC', '2026-10-30T09:00:00.000Z');
    const old = add({ title: 'old', due: { day: '2026-10-28' } });
    const earlier = add({ title: 'earlier', due: { day: '2026-10-30', time: '08:30' } });
    const later = add({ title: 'later', due: { day: '2026-10-30', time: '11:00' } });
    const allDay = add({ title: 'all day', due: { day: '2026-10-30' } });
    const rep = add({ title: 'daily', due: { day: '2026-10-30', time: '10:00' }, repeat: { freq: 'daily' } });
    add({ title: 'tomorrow', due: { day: '2026-10-31' } });
    add({ title: 'undated' });
    const done = add({ title: 'done', due: { day: '2026-10-29' } });
    ok(todos.setDone(done, true, CLI));
    const part = dueOn('2026-10-30');
    expect(part.overdue.map((t) => t.id)).toEqual([old, earlier]);
    expect(part.today.map((t) => t.id)).toEqual([rep, later, allDay]);
    // A past day: what was due before it is overdue, its own todos are due.
    const past = dueOn('2026-10-28');
    expect(past.overdue).toEqual([]);
    expect(past.today.map((t) => t.id)).toEqual([old]);
  });
});

// ---------------------------------------------------------------------------
// The routes, through the API pipeline with a real Life service.

/** The other four modules as stand-ins: this file is about todos. */
function onlyTodos(): LifeModuleBuilders {
  const stub = <M extends LifeModule>(name: M['name']) => () => notBuilt<M>(name, { name, today: () => ({}), start: undefined, stop: undefined } as unknown as Partial<M>);
  return {
    todos: buildTodosModule,
    medicines: stub('medicines'),
    food: stub('food'),
    places: stub('places'),
    finance: stub('finance'),
  } as LifeModuleBuilders;
}

describe('the todo routes', () => {
  let dir: string;
  let api: TestApi;
  let life: LifeService;
  let cookie: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'jantar-todos-api-')));
    api = await makeApi({
      ctx: { home: dir, settings: SettingsSchema.parse({ life: { todos: true } }), clock: undefined },
      deps: (ctx, f) => {
        life = buildLifeService(ctx, { sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy, notifiers: f.notifiers }, onlyTodos(), { macZone: 'UTC' });
        return { life };
      },
    });
    api.ctx.clock.set('2026-10-30T09:00:00.000Z');
    await life.start();
    ({ cookie } = await pairCookie(api, ['read', 'control']));
  });
  afterEach(async () => {
    await life.stop();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  });

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    api.tcp.inject({ method, url, headers: h(cookie), ...(payload ? { payload } : {}) });

  it('a whole round: ids-only replies, the lists, fixed sentences, audit with the target only, life.changed {}', async () => {
    const seq = api.ctx.store.seq;
    const p = await call('POST', '/v1/projects', projectBody({ folder: '/synthetic/home/work/a' }, { marked: true }));
    expect(p.statusCode).toBe(200);
    const pid = (p.json() as { id: string }).id;
    expect(Object.keys(p.json())).toEqual(['id']);
    const t = await call('POST', '/v1/todos', todoBody({ projectId: pid, priority: 'high' }, { marked: true, timed: { day: '2026-10-30', time: '11:00' } }));
    const tid = (t.json() as { id: string }).id;
    expect(Object.keys(t.json())).toEqual(['id']);

    const list = (await call('GET', '/v1/todos')).json() as { today: string; todos: Todo[] };
    expect(list.today).toBe('2026-10-30');
    expect(list.todos.map((x) => x.id)).toEqual([tid]);
    expect((await call('GET', `/v1/todos?project=${pid}&done=0`)).json().todos).toHaveLength(1);
    expect((await call('GET', '/v1/todos?project=none')).json().todos).toHaveLength(0);
    expect((await call('GET', '/v1/projects')).json().projects[0]).toMatchObject({ id: pid, open: 1, overdue: 0 });

    for (const [method, url, body] of [
      ['PATCH', `/v1/projects/${pid}`, { status: 'paused' }],
      ['PATCH', `/v1/todos/${tid}`, { notes: null }],
      ['POST', `/v1/todos/${tid}/snooze`, { preset: '1h' }],
      ['POST', `/v1/todos/${tid}/done`, { done: true }],
      ['POST', `/v1/todos/${tid}/done`, { done: false }],
      ['DELETE', `/v1/todos/${tid}`, undefined],
      ['DELETE', `/v1/projects/${pid}`, undefined],
    ] as const) {
      const res = await call(method, url, body);
      expect(res.statusCode, `${method} ${url} ${res.body}`).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    }
    const missing = await call('DELETE', `/v1/todos/${tid}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toEqual({ code: 'not_found', message: 'No such todo.' });

    const audit = api.ctx.db.audit.list().filter((a) => a.action.startsWith('todo') || a.action.startsWith('project'));
    expect(audit.length).toBeGreaterThanOrEqual(9);
    for (const a of audit) {
      expect([pid, tid]).toContain(a.target);
      expect(a.params ?? {}).toEqual({});
    }
    const events = api.ctx.store.replay(seq);
    const life = events.kind === 'events' ? events.events.filter((e) => e.type === 'life.changed') : [];
    expect(life.length).toBeGreaterThanOrEqual(9);
    for (const e of life) expect(e.data).toEqual({});
    const everything = JSON.stringify({ audit: api.ctx.db.audit.list(), events, log: api.ctx.log.records });
    expect(everything).not.toContain(LIFE_MARKER);
  });

  it('a repeating todo: Done moves it, Undo is 409 with the sentence', async () => {
    const tid = (await call('POST', '/v1/todos', { title: 'Daily', due: { day: '2026-10-30', time: '08:00' }, repeat: { freq: 'daily' } })).json().id as string;
    expect((await call('POST', `/v1/todos/${tid}/done`, { done: true })).statusCode).toBe(200);
    expect(((await call('GET', '/v1/todos')).json().todos as Todo[])[0]?.due).toEqual({ day: '2026-10-31', time: '08:00' });
    const undo = await call('POST', `/v1/todos/${tid}/done`, { done: false });
    expect(undo.statusCode).toBe(409);
    expect(undo.json().error).toEqual({ code: 'conflict', message: 'Undo a repeating todo by setting its date back.' });
  });

  it('a repeat with no due day is 400 before the module; a bad id is 400', async () => {
    expect((await call('POST', '/v1/todos', { title: 'x', repeat: { freq: 'daily' } })).statusCode).toBe(400);
    expect((await call('PATCH', '/v1/todos/not-an-id', { title: 'x' })).statusCode).toBe(400);
  });

  it('the routes are device routes only: ctl.sock answers 404', async () => {
    expect((await api.ctl.inject({ method: 'GET', url: '/v1/todos' })).statusCode).toBe(404);
    expect((await api.ctl.inject({ method: 'GET', url: '/v1/projects' })).statusCode).toBe(404);
  });
});
