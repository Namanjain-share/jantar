/**
 * v0.13 Work, P1 (life/work): the switch, projects from client folders,
 * and a deleted project's links.
 *
 * - `work` routes answer only while life.work and life.todos are both on
 *   (featureOn), with the sentence that names `jantar work on`, and 503
 *   while life.db is broken, as every Life route does;
 * - Life status says Work is on only while it works (Todos on too);
 * - the service builds Work after Todos, with every real module;
 * - seed: one project per folder, a folder already linked (or given twice)
 *   skipped and counted, nothing made past the cap or for anyone but him;
 * - deleting his project clears its links in work_log and work_deals in the
 *   same transaction; a project of hers never runs Work's hook.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIFE_LIMITS, SettingsSchema, type Settings } from '@jantar/protocol';
import type { Actor, LifeService, TodosModule, WorkModule } from '../../src/contracts.js';
import { FEATURE_OFF, LIFE_FEATURES, featureOn } from '../../src/api/app.js';
import { createTestContext, createTestLifeCore, type TestLifeCore } from '../../src/core/testing.js';
import { LIFE_MODULE_BUILDERS } from '../../src/life/index.js';
import { buildLifeService } from '../../src/life/service.js';
import { WORK_NOT_FOUND } from '../../src/life/work/module.js';
import { makeFakes } from '../api/fakes.js';

const settings = (life: Partial<Settings['life']>): Settings => SettingsSchema.parse({ life });

describe('v0.13 the work switch', () => {
  it('a work route is on only while Work and Todos are both on', () => {
    const def = { feature: 'work' as const };
    expect(featureOn(def, settings({}))).toBe(false);
    expect(featureOn(def, settings({ work: true }))).toBe(false);
    expect(featureOn(def, settings({ todos: true }))).toBe(false);
    expect(featureOn(def, settings({ work: true, todos: true }))).toBe(true);
    expect(FEATURE_OFF.work).toEqual({ code: 'forbidden', message: 'Work is off. Turn it on at your Mac: jantar work on' });
    // Its routes answer 503 while life.db is broken, and count against the Life write limit.
    expect(LIFE_FEATURES.has('work')).toBe(true);
  });

  describe('the service', () => {
    let dir: string;
    let life: LifeService | undefined;
    beforeEach(async () => {
      dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'jantar-work-')));
    });
    afterEach(async () => {
      await life?.stop();
      life = undefined;
      await rm(dir, { recursive: true, force: true });
    });

    const start = async (s: Settings) => {
      const ctx = createTestContext({ home: dir, settings: s });
      ctx.clock.set('2026-11-03T09:00:00.000Z');
      const f = makeFakes(ctx);
      life = buildLifeService(ctx, { sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy, notifiers: f.notifiers }, LIFE_MODULE_BUILDERS, { macZone: 'UTC' });
      await life.start();
      return { ctx, life };
    };

    it('builds Work with every real module; status says it is on only with Todos on too', async () => {
      const { ctx, life } = await start(settings({ todos: true, work: true }));
      expect(life.broken()).toBeNull();
      expect(life.work.name).toBe('work');
      expect(life.status().modules).toMatchObject({ todos: true, work: true });
      await ctx.settings.patch({ life: { todos: false } });
      expect(life.status().modules).toMatchObject({ todos: false, work: false });
      const today = life.today();
      expect(today.ok).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// The module: projects from client folders, and a deleted project's links.

describe('v0.13 Work: projects from client folders (seed)', () => {
  let core: TestLifeCore;
  let todos: TodosModule;
  let work: WorkModule;
  const CLI: Actor = { kind: 'cli' };
  const HER: Actor = { kind: 'person', personId: '01JZZZZZZZZZZZZZZZZZZZZZZZ', deviceId: 'd' };

  beforeEach(() => {
    core = createTestLifeCore({ tz: 'UTC', settings: { todos: true, work: true } });
    core.clock.set('2026-11-03T09:00:00.000Z');
    const ctx = createTestContext({ clock: core.clock });
    const f = makeFakes(ctx);
    const d = { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy };
    todos = LIFE_MODULE_BUILDERS.todos(core, d);
    work = LIFE_MODULE_BUILDERS.work(core, d, todos);
  });
  afterEach(() => core.close());

  const projects = () => {
    const r = todos.listProjects();
    if (!r.ok) throw new Error(r.reason);
    return r.value.projects;
  };

  it('one project per folder, its folder linked, ids in the order given', () => {
    const r = work.seed(
      [
        { folder: '/synthetic/home/work/client/acme', name: 'Acme' },
        { folder: '/synthetic/home/work/client/globex', name: 'Globex' },
      ],
      CLI,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.skipped).toBe(0);
    expect(r.value.projects).toHaveLength(2);
    expect(projects().map((p) => [p.id, p.name, p.folder, p.status])).toEqual([
      [r.value.projects[0], 'Acme', '/synthetic/home/work/client/acme', 'active'],
      [r.value.projects[1], 'Globex', '/synthetic/home/work/client/globex', 'active'],
    ]);
  });

  it('a folder a project links already, or one given twice, is skipped and counted (any case, a trailing slash)', () => {
    todos.createProject({ name: 'Existing', folder: '/synthetic/home/work/client/acme' }, CLI);
    const r = work.seed(
      [
        { folder: '/synthetic/home/work/client/ACME/', name: 'Acme again' },
        { folder: '/synthetic/home/work/client/initech', name: 'Initech' },
        { folder: '/synthetic/home/work/client/initech/', name: 'Initech twice' },
      ],
      CLI,
    );
    expect(r.ok && r.value.skipped).toBe(2);
    expect(projects().map((p) => p.name)).toEqual(['Existing', 'Initech']);
  });

  it('past the project cap nothing is made, with the fixed sentence', () => {
    for (let i = 0; i < LIFE_LIMITS.projects - 1; i++) todos.createProject({ name: `Example ${i}` }, CLI);
    const r = work.seed(
      [
        { folder: '/synthetic/a', name: 'A' },
        { folder: '/synthetic/b', name: 'B' },
      ],
      CLI,
    );
    expect(r).toEqual({ ok: false, code: 'conflict', reason: 'You have 500 projects. Delete one to add another.' });
    expect(projects()).toHaveLength(LIFE_LIMITS.projects - 1);
  });

  it('anyone but the owner is answered not found, and nothing is made', () => {
    expect(work.seed([{ folder: '/synthetic/a', name: 'A' }], HER)).toEqual({ ok: false, code: 'not_found', reason: WORK_NOT_FOUND });
    expect(projects()).toEqual([]);
  });

  it("deleting his project lets go of it in Work's tables, in the same transaction; hers never runs Work's hook", () => {
    const keep = todos.createProject({ name: 'Keep' }, CLI);
    const gone = todos.createProject({ name: 'Gone' }, CLI);
    if (!keep.ok || !gone.ok) throw new Error('projects');
    const theirs = todos.inSpace('01JZZZZZZZZZZZZZZZZZZZZZZZ').createProject({ name: 'Hers' }, CLI);
    if (!theirs.ok) throw new Error('hers');
    const db = core.db;
    const log = db.prepare("INSERT INTO work_log (id, contact_id, project_id, at, kind, json) VALUES (?, 'c1', ?, '2026-11-01T10:00:00.000Z', 'note', '{}')");
    log.run('l1', gone.value.id);
    log.run('l2', keep.value.id);
    log.run('l3', theirs.value.id);
    const deal = db.prepare("INSERT INTO work_deals (id, contact_id, stage, updated_at, json) VALUES (?, 'c1', 'new', '2026-11-01T10:00:00.000Z', ?)");
    deal.run('d1', JSON.stringify({ title: 'Synthetic deal', projectId: gone.value.id }));
    deal.run('d2', JSON.stringify({ title: 'Synthetic deal', projectId: keep.value.id }));
    expect(todos.removeProject(gone.value.id, CLI).ok).toBe(true);
    expect(todos.inSpace('01JZZZZZZZZZZZZZZZZZZZZZZZ').removeProject(theirs.value.id, CLI).ok).toBe(true);
    expect(db.prepare('SELECT id, project_id FROM work_log ORDER BY id').all()).toEqual([
      { id: 'l1', project_id: null },
      { id: 'l2', project_id: keep.value.id },
      { id: 'l3', project_id: theirs.value.id },
    ]);
    const deals = db.prepare('SELECT id, json, updated_at FROM work_deals ORDER BY id').all() as { id: string; json: string; updated_at: string }[];
    expect(JSON.parse(deals[0]?.json ?? '{}')).toEqual({ title: 'Synthetic deal' });
    expect(deals[0]?.updated_at).toBe('2026-11-03T09:00:00.000Z');
    expect(JSON.parse(deals[1]?.json ?? '{}')).toEqual({ title: 'Synthetic deal', projectId: keep.value.id });
  });
});
