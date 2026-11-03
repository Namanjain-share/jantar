/**
 * v0.13 Work, P1: one project as a hub (TodosModule.hub, GET
 * /v1/projects/:id) and the owner's `q` on the todos list.
 *
 * - the hub: the project with its counts, its open todos by due, the
 *   newest done (at most 10), this week's done count, and its health
 *   (overdue by the same rule as the counts, the next due, eight weeks of
 *   done todos, quiet days for an active project untouched for over 14);
 * - in his space only: her project (and her to-dos) never show;
 * - `q`: title and notes, any case or accent, open by due or the
 *   newest done; quotes, % and _ are only text (never SQL);
 * - the routes: control scope, the todos switch, 404 with the sentence,
 *   a reply that parses as ProjectHub, a `q` over 80 characters is 400.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIFE_MARKER, projectBody, todoBody } from '@jantar/fixtures';
import { SettingsSchema, type Todo } from '@jantar/protocol';
import { ProjectHubSchema, type ProjectHub } from '@jantar/protocol/work';
import type { Actor, LifeService, TodosModule } from '../../src/contracts.js';
import { createTestContext, createTestLifeCore, type TestLifeCore } from '../../src/core/testing.js';
import { LIFE_MODULE_BUILDERS } from '../../src/life/index.js';
import { buildLifeService } from '../../src/life/service.js';
import { buildTodosModule } from '../../src/life/todos/module.js';
import { h, makeApi, makeFakes, pairCookie, type TestApi } from '../api/fakes.js';

const CLI: Actor = { kind: 'cli' };
const DAY = 86_400_000;
const HER = '01JZZZZZZZZZZZZZZZZZZZZZZZ';

let core: TestLifeCore;
let todos: TodosModule;

/** Tuesday 3 November 2026, 10:00 in Kolkata. */
function build(at = '2026-11-03T04:30:00.000Z'): void {
  core = createTestLifeCore({ tz: 'Asia/Kolkata', settings: { todos: true, work: true } });
  core.clock.set(at);
  const ctx = createTestContext({ clock: core.clock });
  const f = makeFakes(ctx);
  todos = buildTodosModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
}

function ok<T>(r: { ok: true; value: T } | { ok: false; code: string; reason: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return r.value;
}

const project = (name = 'Site rebuild') => ok(todos.createProject({ name, folder: '/synthetic/home/work/client/acme' }, CLI)).id;
const add = (body: Parameters<TodosModule['createTodo']>[0]) => ok(todos.createTodo(body, CLI)).id;
const done = (id: string) => ok(todos.setDone(id, true, CLI));
const ids = (list: readonly Todo[]) => list.map((t) => t.id);

afterEach(() => core?.close());

describe('TodosModule.hub', () => {
  beforeEach(() => build());

  it('the project with its counts, open todos by due, and a health line that agrees with the counts', () => {
    const pid = project();
    const late = add({ title: 'Fix staging login', projectId: pid, due: { day: '2026-11-02' } });
    const soon = add({ title: 'Send wireframes', projectId: pid, due: { day: '2026-11-05', time: '15:00' } });
    const minute = add({ title: 'Call at nine', projectId: pid, due: { day: '2026-11-03', time: '09:00' } });
    const undated = add({ title: 'Read the brief', projectId: pid });
    add({ title: 'Somewhere else' });
    const hub = ok(todos.hub(pid));
    expect(ProjectHubSchema.safeParse(hub).success).toBe(true);
    expect(hub.project).toMatchObject({ id: pid, name: 'Site rebuild', status: 'active', open: 4, overdue: 2, folder: '/synthetic/home/work/client/acme' });
    expect(ids(hub.open)).toEqual([late, minute, soon, undated]);
    expect(hub.health.overdue).toBe(hub.project.overdue);
    expect(hub.health.nextDue).toEqual({ todoId: late, due: { day: '2026-11-02' } });
    expect(hub.health.quietDays).toBeUndefined();
    expect(hub.doneThisWeek).toBe(0);
    expect(hub.recentDone).toEqual([]);
  });

  it('done this week, the newest ten done, and eight weeks of done todos (Monday to Monday in the Life zone)', () => {
    // Three weeks ago (Tuesday 13 October), then this week (Monday 2 November and today). The clock only moves on.
    core.close();
    build('2026-10-13T04:30:00.000Z');
    const pid = project();
    for (let i = 0; i < 9; i++) done(add({ title: `Old ${i}`, projectId: pid }));
    core.clock.set('2026-11-02T00:30:00.000Z');
    done(add({ title: 'Monday', projectId: pid }));
    core.clock.set('2026-11-03T04:30:00.000Z');
    const newest = add({ title: 'Today', projectId: pid });
    done(newest);
    const hub = ok(todos.hub(pid));
    expect(hub.doneThisWeek).toBe(2);
    expect(hub.health.doneByWeek).toEqual([0, 0, 0, 0, 9, 0, 0, 2]);
    expect(hub.recentDone).toHaveLength(10);
    expect(hub.recentDone[0]?.id).toBe(newest);
    expect(hub.recentDone[1]?.title).toBe('Monday');
  });

  it('quiet: an active project and its todos untouched for over 14 days; a change to a todo wakes it', () => {
    const pid = project();
    const t = add({ title: 'Waiting on the client', projectId: pid });
    core.clock.set(new Date(Date.parse('2026-11-03T04:30:00.000Z') + 16 * DAY).toISOString());
    expect(ok(todos.hub(pid)).health.quietDays).toBe(16);
    ok(todos.updateProject(pid, { status: 'paused' }, CLI));
    expect(ok(todos.hub(pid)).health.quietDays).toBeUndefined();
    ok(todos.updateProject(pid, { status: 'active' }, CLI));
    expect(ok(todos.hub(pid)).health.quietDays).toBeUndefined();
    core.clock.set(new Date(Date.parse('2026-11-03T04:30:00.000Z') + 40 * DAY).toISOString());
    expect(ok(todos.hub(pid)).health.quietDays).toBe(24);
    ok(todos.updateTodo(t, { notes: 'Nudged' }, CLI));
    expect(ok(todos.hub(pid)).health.quietDays).toBeUndefined();
  });

  it('an unknown project, and hers, are not found with the fixed sentence', () => {
    expect(todos.hub('01JZZZZZZZZZZZZZZZZZZZZZZY')).toEqual({ ok: false, code: 'not_found', reason: 'No such project.' });
    const hers = ok(todos.inSpace(HER).createProject({ name: 'Her project' }, CLI)).id;
    expect(todos.hub(hers)).toEqual({ ok: false, code: 'not_found', reason: 'No such project.' });
    expect(todos.inSpace(HER).hub(hers).ok).toBe(true);
  });
});

describe('the todos list: ?q=', () => {
  beforeEach(() => build());

  it('matches title and notes, any case (Unicode too), open ones by due', () => {
    const pid = project();
    const a = add({ title: 'Send the quote to Acme', due: { day: '2026-11-06' } });
    const b = add({ title: 'Call', notes: 'Ask ACME about the café menu', due: { day: '2026-11-04' }, projectId: pid });
    add({ title: 'Something else' });
    expect(ids(ok(todos.listTodos({ done: false, q: 'acme' })).todos)).toEqual([b, a]);
    expect(ids(ok(todos.listTodos({ done: false, q: 'CAFÉ' })).todos)).toEqual([b]);
    expect(ids(ok(todos.listTodos({ done: false, q: 'cafe' })).todos)).toEqual([b]);
    expect(ids(ok(todos.listTodos({ done: false, q: 'acme', project: pid })).todos)).toEqual([b]);
    expect(ids(ok(todos.listTodos({ done: false, q: 'acme', project: 'none' })).todos)).toEqual([a]);
  });

  it('with done=1, the newest done that match (at most 100)', () => {
    const first = add({ title: 'Invoice Acme' });
    done(first);
    core.clock.advance(60_000);
    const second = add({ title: 'Invoice Acme again' });
    done(second);
    for (let i = 0; i < 101; i++) {
      core.clock.advance(1000);
      done(add({ title: `Unrelated ${i}` }));
    }
    expect(ids(ok(todos.listTodos({ done: true, q: 'invoice' })).todos)).toEqual([second, first]);
    for (let i = 0; i < 101; i++) {
      core.clock.advance(1000);
      done(add({ title: `Invoice batch ${i}` }));
    }
    expect(ok(todos.listTodos({ done: true, q: 'invoice' })).todos).toHaveLength(100);
  });

  it("quotes, % and _ are only text; her to-dos never match his q", () => {
    const pct = add({ title: '100% done_ish' });
    add({ title: 'Nothing' });
    ok(todos.inSpace(HER).createTodo({ title: 'Her acme note' }, CLI));
    expect(ids(ok(todos.listTodos({ done: false, q: "' OR 1=1 --" })).todos)).toEqual([]);
    expect(ids(ok(todos.listTodos({ done: false, q: '%' })).todos)).toEqual([pct]);
    expect(ids(ok(todos.listTodos({ done: false, q: '_' })).todos)).toEqual([pct]);
    expect(ok(todos.listTodos({ done: false, q: 'acme' })).todos).toEqual([]);
    expect(ok(todos.listTodos({ done: true, q: 'acme' })).todos).toEqual([]);
  });
});

describe('the routes', () => {
  let dir: string;
  let api: TestApi;
  let life: LifeService;
  let cookie: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'jantar-hub-api-')));
    api = await makeApi({
      ctx: { home: dir, settings: SettingsSchema.parse({ life: { todos: true } }), clock: undefined },
      deps: (ctx, f) => {
        life = buildLifeService(ctx, { sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy, notifiers: f.notifiers }, LIFE_MODULE_BUILDERS, { macZone: 'UTC' });
        return { life };
      },
    });
    api.ctx.clock.set('2026-11-03T09:00:00.000Z');
    await life.start();
    ({ cookie } = await pairCookie(api, ['read', 'control']));
  });
  afterEach(async () => {
    await life.stop();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  });

  const call = (method: 'GET' | 'POST', url: string, payload?: object, c = cookie) => api.tcp.inject({ method, url, headers: h(c), ...(payload ? { payload } : {}) });

  it('GET /v1/projects/:id answers the hub; an unknown id is 404 with the sentence; a read-only device is refused', async () => {
    const pid = (await call('POST', '/v1/projects', projectBody({}, { marked: true }))).json().id as string;
    await call('POST', '/v1/todos', todoBody({ projectId: pid }, { marked: true, timed: { day: '2026-11-04', time: '11:00' } }));
    const res = await call('GET', `/v1/projects/${pid}`);
    expect(res.statusCode).toBe(200);
    const hub = ProjectHubSchema.parse(res.json()) as ProjectHub;
    expect(hub.project.id).toBe(pid);
    expect(hub.open).toHaveLength(1);
    const missing = await call('GET', '/v1/projects/01JZZZZZZZZZZZZZZZZZZZZZZY');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toEqual({ code: 'not_found', message: 'No such project.' });
    expect((await call('GET', '/v1/projects/not-an-id')).statusCode).toBe(400);
    const { cookie: readOnly } = await pairCookie(api, ['read']);
    expect((await call('GET', `/v1/projects/${pid}`, undefined, readOnly)).statusCode).toBe(403);
    // A read writes no audit row and no Life text anywhere.
    expect(JSON.stringify({ audit: api.ctx.db.audit.list().filter((a) => a.action === 'projectGet'), log: api.ctx.log.records })).not.toContain(LIFE_MARKER);
  });

  it('GET /v1/todos?q= finds by words; over 80 characters is 400; with Todos off the hub is 403', async () => {
    await call('POST', '/v1/todos', { title: 'Send the Northwind quote' });
    await call('POST', '/v1/todos', { title: 'Other' });
    const found = (await call('GET', '/v1/todos?q=northwind')).json() as { todos: Todo[] };
    expect(found.todos.map((t) => t.title)).toEqual(['Send the Northwind quote']);
    expect((await call('GET', `/v1/todos?q=${'x'.repeat(81)}`)).statusCode).toBe(400);
    const pid = (await call('POST', '/v1/projects', { name: 'Globex audit' })).json().id as string;
    await api.ctx.settings.patch({ life: { todos: false, places: true } });
    const off = await call('GET', `/v1/projects/${pid}`);
    expect(off.statusCode).toBe(403);
    expect(off.json().error.message).toBe('Todos are off. Turn them on at your Mac: jantar life on todos');
  });
});
