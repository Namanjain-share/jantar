/**
 * v0.5.3 folder todos (life/todos/module.ts forFolder and createInFolder,
 * api/routes/todos.ts folderTodos and folderTodoCreate), the routes `jantar
 * mcp`'s todos_here and todo_add call over ctl.sock (spec 4.2, S8, S9):
 *
 * - the project whose folder holds the folder, the deepest winning; none:
 *   project null and no todos; its open todos only, by due; a folder
 *   compared normalized and without a trailing slash;
 * - the broad-folder rule: a project linked to the home folder, `/Users`
 *   or `/` (in any case) counts only for exactly that folder, never for a
 *   folder below;
 * - a todo added there lands in that project (and rings when timed); with
 *   no project linked, not_found with the sentence;
 * - over ctl.sock: ids-only replies, a strict body (no projectId, no
 *   repeat), 20 an hour then 429 with its sentence (an hour later it adds
 *   again), the pipeline's Life write limit counted too, Life not open
 *   yet answering 503; the audit holds the id only, life.changed is {}, and
 *   no Life text or folder reaches the audit, the events or the log.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIFE_MARKER } from '@jantar/fixtures';
import { FolderTodosResponseSchema, SettingsSchema, type FolderTodosResponse } from '@jantar/protocol';
import type { Actor, LifeModule, LifeModuleBuilders, LifeService, TodosModule } from '../../src/contracts.js';
import { createTestContext, createTestLifeCore, type TestLifeCore } from '../../src/core/testing.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { FOLDER_TODOS_LIMITED } from '../../src/api/routes/todos.js';
import { LIFE_CLOSED, buildLifeService } from '../../src/life/service.js';
import { buildTodosModule, TODO_REASONS } from '../../src/life/todos/module.js';
import { makeApi, makeFakes, type TestApi } from '../api/fakes.js';

const CLI: Actor = { kind: 'cli' };
const HOME = '/synthetic/home';
const MIN = 60_000;

function ok<T>(r: { ok: true; value: T } | { ok: false; code: string; reason: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return r.value;
}

describe('the module', () => {
  let core: TestLifeCore;
  let todos: TodosModule;

  beforeEach(() => {
    core = createTestLifeCore({ settings: { todos: true } });
    core.clock.set('2026-10-30T09:00:00.000Z');
    const ctx = createTestContext({ clock: core.clock, userHome: HOME });
    const f = makeFakes(ctx);
    todos = buildTodosModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
  });
  afterEach(() => core.close());

  const project = (name: string, folder?: string, emoji?: string) =>
    ok(todos.createProject({ name, ...(folder !== undefined ? { folder } : {}), ...(emoji !== undefined ? { emoji } : {}) }, CLI)).id;
  const at = (folder: string) => todos.forFolder(folder);

  it('the deepest folder holding it wins; a folder in none answers project null and no todos', () => {
    const work = project('Example work', `${HOME}/work`);
    const app = project('Example app', `${HOME}/work/demo-app`, '🛠');
    expect(at(`${HOME}/work/demo-app/src/ui`).project).toEqual({ id: app, name: 'Example app', emoji: '🛠' });
    expect(at(`${HOME}/work/demo-app`).project?.id).toBe(app);
    expect(at(`${HOME}/work/other`).project).toEqual({ id: work, name: 'Example work' });
    // A sibling whose name starts the same is not inside it.
    expect(at(`${HOME}/work/demo-app-2`).project?.id).toBe(work);
    expect(at(`${HOME}/elsewhere`)).toEqual({ today: '2026-10-30', project: null, todos: [] });
    expect(at('/tmp/x')).toEqual({ today: '2026-10-30', project: null, todos: [] });
  });

  it('answers that project’s open todos by due, nothing done, nothing of another project', () => {
    const app = project('Example app', `${HOME}/work/demo-app`);
    const other = project('Example other', `${HOME}/work/other`);
    const later = ok(todos.createTodo({ title: 'Later', projectId: app, due: { day: '2026-11-02' } }, CLI)).id;
    const first = ok(todos.createTodo({ title: 'First', projectId: app, due: { day: '2026-10-30', time: '10:00' } }, CLI)).id;
    const undated = ok(todos.createTodo({ title: 'Undated', projectId: app }, CLI)).id;
    const done = ok(todos.createTodo({ title: 'Done', projectId: app }, CLI)).id;
    ok(todos.setDone(done, true, CLI));
    ok(todos.createTodo({ title: 'Theirs', projectId: other }, CLI));
    ok(todos.createTodo({ title: 'No project' }, CLI));
    const r = at(`${HOME}/work/demo-app/packages`);
    expect(FolderTodosResponseSchema.parse(r)).toEqual(r);
    expect(r.todos.map((t) => t.id)).toEqual([first, later, undated]);
  });

  it('compares folders normalized and without a trailing slash', () => {
    const app = project('Example app', `${HOME}/work/demo-app/`);
    expect(at(`${HOME}/work/demo-app`).project?.id).toBe(app);
    expect(at(`${HOME}/work/./demo-app//src/`).project?.id).toBe(app);
    expect(at(`${HOME}/work/demo-app/../other`).project).toBeNull();
  });

  it('a project linked to the home folder counts for exactly that folder, never for one below it', () => {
    const home = project('Example home', HOME);
    expect(at(HOME).project?.id).toBe(home);
    expect(at(`${HOME}/`).project?.id).toBe(home);
    expect(at(`${HOME}/work/demo-app`).project).toBeNull();
    // A deeper link still wins below home; home itself keeps its own.
    const app = project('Example app', `${HOME}/work/demo-app`);
    expect(at(`${HOME}/work/demo-app/src`).project?.id).toBe(app);
    expect(at(HOME).project?.id).toBe(home);
  });

  it('so do projects linked to / and /Users', () => {
    const root = project('Example root', '/');
    const users = project('Example users', '/Users/');
    expect(at('/').project?.id).toBe(root);
    expect(at('/Users').project?.id).toBe(users);
    expect(at('/Users/example').project).toBeNull();
    expect(at('/opt/tools').project).toBeNull();
    expect(at(`${HOME}/work`).project).toBeNull();
  });

  it('the broad folders in any case (APFS ignores it): home or /Users linked in lower case still holds nothing below', () => {
    const home = project('Example home', HOME.toUpperCase());
    const users = project('Example users', '/users');
    expect(at(`${HOME.toUpperCase()}/work/demo-app`).project).toBeNull();
    expect(at('/users/example').project).toBeNull();
    // Exactly that folder, as written, still counts.
    expect(at(HOME.toUpperCase()).project?.id).toBe(home);
    expect(at('/users').project?.id).toBe(users);
  });

  it('adds a todo to that project (a timed one rings); with none linked, not_found with the sentence and nothing added', () => {
    const app = project('Example app', `${HOME}/work/demo-app`);
    const id = ok(todos.createInFolder({ folder: `${HOME}/work/demo-app/src`, title: 'Write the release notes', notes: 'Synthetic notes', priority: 'high', due: { day: '2026-10-30', time: '17:00' } }, CLI)).id;
    expect(at(`${HOME}/work/demo-app`).todos).toEqual([
      expect.objectContaining({ id, title: 'Write the release notes', notes: 'Synthetic notes', priority: 'high', projectId: app, due: { day: '2026-10-30', time: '17:00' } }),
    ]);
    expect(core.scheduler.row('todo', id)?.nextAt).toBe('2026-10-30T17:00:00.000Z');
    const before = core.changedCount;
    expect(todos.createInFolder({ folder: `${HOME}/elsewhere`, title: 'x' }, CLI)).toEqual({ ok: false, code: 'not_found', reason: TODO_REASONS.noFolderProject });
    expect(todos.createInFolder({ folder: `${HOME}/work`, title: 'x' }, CLI)).toMatchObject({ ok: false, code: 'not_found' });
    expect(core.changedCount).toBe(before);
    expect(TODO_REASONS.noFolderProject).toBe('No project is linked to this folder. On the phone: Projects › a project › Folder.');
  });
});

// ---------------------------------------------------------------------------
// The routes, over ctl.sock, with a real Life service.

/** The other four modules as stand-ins: this file is about todos. */
function onlyTodos(): LifeModuleBuilders {
  const stub = <M extends LifeModule>(name: M['name']) => () => notBuilt<M>(name, { name, today: () => ({}), start: undefined, stop: undefined } as unknown as Partial<M>);
  return { todos: buildTodosModule, medicines: stub('medicines'), food: stub('food'), places: stub('places'), finance: stub('finance') } as LifeModuleBuilders;
}

describe('the folder routes over ctl.sock', () => {
  let dir: string;
  let api: TestApi;
  let life: LifeService;
  const APP = `${HOME}/work/demo-app`;

  async function boot(start = true) {
    dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'jantar-folder-todos-')));
    api = await makeApi({
      ctx: { home: dir, userHome: HOME, settings: SettingsSchema.parse({ life: { todos: true } }), clock: undefined },
      deps: (ctx, f) => {
        life = buildLifeService(ctx, { sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy, notifiers: f.notifiers }, onlyTodos(), { macZone: 'UTC' });
        return { life };
      },
    });
    api.ctx.clock.set('2026-10-30T09:00:00.000Z');
    if (start) await life.start();
  }
  afterEach(async () => {
    await life?.stop();
    await api?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const list = (folder: string) => api.ctl.inject({ method: 'GET', url: `/v1/folder/todos?folder=${encodeURIComponent(folder)}` });
  const add = (body: object) => api.ctl.inject({ method: 'POST', url: '/v1/folder/todos', payload: body });
  const linkApp = () => ok(life.todos.createProject({ name: 'Example app', folder: APP }, CLI)).id;

  it('answers the project and its todos; an add replies with the id only, audits the id only, and says life.changed {}', async () => {
    await boot();
    const pid = linkApp();
    const seq = api.ctx.store.seq;
    const res = await add({ folder: `${APP}/src`, title: `Example ${LIFE_MARKER}`, notes: `Notes ${LIFE_MARKER}`, due: { day: '2026-10-31', time: '09:30' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(Object.keys(res.json())).toEqual(['id']);
    const id = (res.json() as { id: string }).id;

    const got = await list(APP);
    expect(got.statusCode).toBe(200);
    const body = FolderTodosResponseSchema.parse(got.json()) as FolderTodosResponse;
    expect(body.project).toEqual({ id: pid, name: 'Example app' });
    expect(body.todos.map((t) => [t.id, t.projectId])).toEqual([[id, pid]]);
    expect((await list(`${HOME}/elsewhere`)).json()).toEqual({ today: '2026-10-30', project: null, todos: [] });

    const audit = api.ctx.db.audit.list().filter((a) => a.action === 'folderTodoCreate');
    expect(audit).toEqual([expect.objectContaining({ target: id, result: 'ok' })]);
    for (const a of audit) expect(a.params ?? {}).toEqual({});
    const events = api.ctx.store.replay(seq);
    const changed = events.kind === 'events' ? events.events.filter((e) => e.type === 'life.changed') : [];
    expect(changed.length).toBeGreaterThan(0);
    for (const e of changed) expect(e.data).toEqual({});
    const everything = JSON.stringify({ audit: api.ctx.db.audit.list(), events, log: api.ctx.log.records });
    expect(everything).not.toContain(LIFE_MARKER);
    expect(everything).not.toContain(APP);
  });

  it('no project linked: 404 with the sentence', async () => {
    await boot();
    const res = await add({ folder: `${HOME}/elsewhere`, title: 'Example todo' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toEqual({ code: 'not_found', message: TODO_REASONS.noFolderProject });
  });

  it('the body is strict: no projectId, no repeat, an absolute folder', async () => {
    await boot();
    const pid = linkApp();
    for (const body of [
      { folder: APP, title: 'x', projectId: pid },
      { folder: APP, title: 'x', due: { day: '2026-10-31' }, repeat: { freq: 'daily' } },
      { folder: 'work/demo-app', title: 'x' },
      { title: 'x' },
    ]) {
      const res = await add(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await api.ctl.inject({ method: 'GET', url: '/v1/folder/todos?folder=relative' })).statusCode).toBe(400);
    expect((await list(APP)).json().todos).toEqual([]);
  });

  it('S9: 20 an hour from ctl.sock, then 429 with the sentence; an hour later it adds again', async () => {
    await boot();
    linkApp();
    for (let i = 0; i < 20; i++) expect((await add({ folder: APP, title: `Example ${i}` })).statusCode).toBe(200);
    const over = await add({ folder: APP, title: 'Example 21' });
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toEqual({ code: 'rate_limited', message: FOLDER_TODOS_LIMITED });
    expect(FOLDER_TODOS_LIMITED).toBe('Claude sessions added 20 todos this hour. Add more on the phone, or try again later.');
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(3500);
    expect((await list(APP)).json().todos).toHaveLength(20);
    // Reading is not capped.
    expect((await list(APP)).statusCode).toBe(200);
    api.ctx.clock.set(new Date(Date.parse('2026-10-30T09:00:00.000Z') + 60 * MIN + 1000).toISOString());
    expect((await add({ folder: APP, title: 'Example 21' })).statusCode).toBe(200);
  });

  it("each add counts against the pipeline's Life write limit too", async () => {
    await boot();
    linkApp();
    const hit = vi.spyOn(api.services.lifeWriteLimiter, 'hit');
    expect((await add({ folder: APP, title: 'Example todo' })).statusCode).toBe(200);
    expect(hit).toHaveBeenCalledWith('cli');
  });

  it('Life not open yet: 503 with the sentence, for the list and the add', async () => {
    await boot(false);
    for (const res of [await list(APP), await add({ folder: APP, title: 'Example todo' })]) {
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toEqual({ code: 'unavailable', message: LIFE_CLOSED });
    }
  });
});
