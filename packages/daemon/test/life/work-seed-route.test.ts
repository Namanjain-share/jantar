/**
 * v0.13 Work, P1: POST /v1/work/seed ("Start from your client folders")
 * through the API with a real Life service and the real path policy.
 *
 * - folders as the browsers address them (a configured root and a path in
 *   it) become projects with their real folder linked; a folder already
 *   linked is skipped and counted; ctl.sock (the CLI) may seed too;
 * - refused, with nothing made: Work off, Files and New session both off,
 *   a path out of the root, the root itself, a folder in a live session's
 *   own root (not a configured one), a read-only device, a loose body;
 * - the audit row names no folder and no project name; no log line or
 *   event carries them.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsSchema, WorkSeedReplySchema, type ProjectView } from '@jantar/protocol';
import type { FilesService, LifeService } from '../../src/contracts.js';
import { SEED_NEEDS_BROWSER, SEED_NEEDS_ROOT } from '../../src/api/routes/work.js';
import { buildFilesService } from '../../src/files/service.js';
import { LIFE_MODULE_BUILDERS } from '../../src/life/index.js';
import { buildLifeService } from '../../src/life/service.js';
import { h, makeApi, makeSession, pairCookie, type TestApi } from '../api/fakes.js';

const MARK = 'qzxv';

let base: string;
let home: string;
let api: TestApi;
let life: LifeService;
let files: FilesService;
let cookie: string;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-seed-')));
  home = join(base, 'home');
  for (const name of ['acme', 'globex', `initech-${MARK}`]) mkdirSync(join(home, 'work', 'client', name), { recursive: true });
  // A live session's own folder (a session root, s.<sid>), with a folder inside it.
  mkdirSync(join(home, 'scratch', 'app'), { recursive: true });
  mkdirSync(join(home, '.jantar'), { recursive: true });
  const settings = SettingsSchema.parse({
    life: { todos: true, work: true },
    files: { enabled: true },
    folders: { roots: [{ id: 'work', path: join(home, 'work'), label: 'Work' }] },
  });
  api = await makeApi({
    ctx: { userHome: home, home: join(home, '.jantar'), settings },
    sessions: [makeSession({ sid: 'sess-seed-1', cwd: join(home, 'scratch'), folder: 'scratch' })],
    deps: (ctx, fakes) => {
      files = buildFilesService(ctx, { sessions: fakes.sessions, notifiers: [] });
      life = buildLifeService(ctx, { sessions: fakes.sessions, usage: fakes.usage, ccwLegacy: fakes.ccwLegacy, notifiers: fakes.notifiers }, LIFE_MODULE_BUILDERS, { macZone: 'UTC' });
      return { files, life };
    },
  });
  api.ctx.clock.set('2026-11-03T09:00:00.000Z');
  await files.start();
  await life.start();
  ({ cookie } = await pairCookie(api, ['read', 'control']));
});
afterEach(async () => {
  await life.stop();
  await files.stop();
  await api.close();
  rmSync(base, { recursive: true, force: true });
});

const seed = (items: unknown, c = cookie) => api.tcp.inject({ method: 'POST', url: '/v1/work/seed', headers: h(c), payload: { items } });
const projects = (): ProjectView[] => {
  const r = life.todos.listProjects();
  if (!r.ok) throw new Error(r.reason);
  return r.value.projects;
};

describe('POST /v1/work/seed', () => {
  it('makes one project per folder with its real folder; a folder already linked is skipped; the CLI may seed', async () => {
    const res = await seed([
      { root: 'r.work', path: 'client/acme', name: 'Acme' },
      { root: 'r.work', path: 'client/globex', name: 'Globex' },
    ]);
    expect(res.statusCode, res.body).toBe(200);
    const reply = WorkSeedReplySchema.parse(res.json());
    expect(reply).toEqual({ projects: [expect.any(String), expect.any(String)], skipped: 0 });
    expect(Object.keys(res.json()).sort()).toEqual(['projects', 'skipped']);
    expect(projects().map((p) => [p.name, p.folder])).toEqual([
      ['Acme', join(home, 'work', 'client', 'acme')],
      ['Globex', join(home, 'work', 'client', 'globex')],
    ]);
    const again = await api.ctl.inject({ method: 'POST', url: '/v1/work/seed', payload: { items: [{ root: 'r.work', path: 'client/acme', name: 'Acme' }, { root: 'r.work', path: `client/initech-${MARK}`, name: `Initech ${MARK}` }] } });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ skipped: 1 });
    expect(projects()).toHaveLength(3);
  });

  it('refuses with nothing made: a path out of the root, the root itself, a session root, a loose body', async () => {
    const out = await seed([
      { root: 'r.work', path: 'client/acme', name: 'Acme' },
      { root: 'r.work', path: '../../..', name: 'Outside' },
    ]);
    expect(out.statusCode).toBeGreaterThanOrEqual(400);
    expect(out.statusCode).toBeLessThan(500);
    expect((await seed([{ root: 'r.work', path: '.', name: 'Work' }])).statusCode).toBe(400);
    expect((await seed([{ root: 'r.nope', path: 'client/acme', name: 'Acme' }])).statusCode).toBe(404);
    const session = await seed([{ root: 's.sess-seed-1', path: 'app', name: 'App' }]);
    expect(session.statusCode).toBe(400);
    expect(session.json().error).toEqual({ code: 'invalid_request', message: SEED_NEEDS_ROOT });
    expect((await seed([{ root: 'r.work', path: 'client/acme', name: 'Acme', extra: 1 }])).statusCode).toBe(400);
    expect((await seed([])).statusCode).toBe(400);
    expect((await seed(Array.from({ length: 51 }, (_, i) => ({ root: 'r.work', path: `client/x${i}`, name: `X ${i}` })))).statusCode).toBe(400);
    expect(projects()).toEqual([]);
  });

  it('needs Work on, and Files or New session on; a read-only device is refused', async () => {
    const { cookie: readOnly } = await pairCookie(api, ['read']);
    expect((await seed([{ root: 'r.work', path: 'client/acme', name: 'Acme' }], readOnly)).statusCode).toBe(403);
    await api.ctx.settings.patch({ files: { enabled: false } });
    const browsers = await seed([{ root: 'r.work', path: 'client/acme', name: 'Acme' }]);
    expect(browsers.statusCode).toBe(403);
    expect(browsers.json().error.message).toBe(SEED_NEEDS_BROWSER);
    await api.ctx.settings.patch({ launch: { enabled: true } });
    expect((await seed([{ root: 'r.work', path: 'client/acme', name: 'Acme' }])).statusCode).toBe(200);
    await api.ctx.settings.patch({ life: { work: false } });
    const off = await seed([{ root: 'r.work', path: 'client/globex', name: 'Globex' }]);
    expect(off.statusCode).toBe(403);
    expect(off.json().error.message).toBe('Work is off. Turn it on at your Mac: jantar work on');
    expect(projects().map((p) => p.name)).toEqual(['Acme']);
  });

  it('the audit row names no folder and no project; no log line or event carries them', async () => {
    const seq = api.ctx.store.seq;
    expect((await seed([{ root: 'r.work', path: `client/initech-${MARK}`, name: `Initech ${MARK}` }])).statusCode).toBe(200);
    expect((await seed([{ root: 'r.work', path: `client/initech-${MARK}/../../..`, name: `Initech ${MARK}` }])).statusCode).toBeGreaterThanOrEqual(400);
    const rows = api.ctx.db.audit.list().filter((a) => a.action === 'foldersSeed');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const a of rows) {
      expect(a.target).toBeUndefined();
      expect(a.params ?? {}).toEqual({});
    }
    const events = api.ctx.store.replay(seq);
    expect(JSON.stringify({ audit: api.ctx.db.audit.list(), log: api.ctx.log.records, events })).not.toContain(MARK);
  });
});
