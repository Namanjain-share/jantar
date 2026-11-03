/**
 * v0.13 Work, P1: one search across Jantar (search/index.ts, GET /v1/search).
 *
 * - the groups in their order (clients, projects, deals, todos, meetings,
 *   sessions, Intel, cafés, posts), only those with a match, links with ids;
 * - each group only while its own part is on (Life's while life.db is open),
 *   sessions always; at most `limit` in a group;
 * - his space only: her projects and to-dos never show;
 * - any case or accent ("cafe" finds "Café"); quotes, % and _ are text;
 * - a group that throws is left out, logged by its kind and never the query;
 * - Work's own groups refuse anyone but the owner;
 * - the route: control scope, q of 2 to 80 characters, a reply that parses,
 *   and the query in no log line or audit row.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsSchema, type IntelListItem, type Session, type Settings } from '@jantar/protocol';
import { SearchResponseSchema, type SearchResponse } from '@jantar/protocol/work';
import type { Actor, IntelService, LifeService, MeetingsService } from '../../src/contracts.js';
import { createTestContext, type TestContext } from '../../src/core/testing.js';
import { LIFE_BROKEN_REASON } from '../../src/life/db.js';
import { LIFE_MODULE_BUILDERS } from '../../src/life/index.js';
import { buildLifeService } from '../../src/life/service.js';
import { WORK_NOT_FOUND } from '../../src/life/work/module.js';
import { searchAll, type SearchDeps } from '../../src/search/index.js';
import { h, makeApi, makeFakes, pairCookie, type TestApi } from '../api/fakes.js';

const OWNER: Actor = { kind: 'device', deviceId: '01JFZ8X8Y3T0V5G9WQK2M4N6PD', scopes: ['read', 'control'] };
const HER = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const HOME = '/synthetic/home';
const MEETING = '01JFZ8X8Y3T0V5G9WQK2M4N6MT';
const ALL_ON = { life: { todos: true, places: true, posts: true, work: true }, meetings: { enabled: true }, intel: { enabled: true } };

let dir: string;
let ctx: TestContext;
let life: LifeService;
let meetingsBroken: string | null;
let intelThrows: boolean;

const meetings = {
  broken: () => meetingsBroken,
  library: { search: (_q: string, limit: number) => ({ ok: true, value: [{ id: MEETING, name: 'Kickoff with Acme', day: '2026-11-02' }].slice(0, limit) }) },
} as unknown as MeetingsService;

const intelItem = (n: number): IntelListItem => ({ id: `captures:01JFZ8X8Y3T0V5G9WQK2M4N6I${n}`, source: 'captures', at: '2026-11-01T10:00:00.000Z', title: `Acme pricing ${n}`, type: 'article', tags: [] });
const intel = {
  list: (q: { limit: number }) => {
    if (intelThrows) throw new TypeError('synthetic shelf bug');
    return { items: [1, 2, 3, 4, 5, 6].map(intelItem).slice(0, q.limit), next: null, total: 6, types: [], tags: [] };
  },
} as unknown as IntelService;

const session = (sid: string, over: Partial<Session> = {}): Session =>
  ({ sid, cwd: `${HOME}/work/client/${sid}`, folder: sid, status: 'working', statusSince: '2026-11-03T08:00:00.000Z', ...over }) as Session;
const SESSIONS: Record<string, Session> = {
  'acme-web': session('acme-web', { statusSince: '2026-11-03T08:30:00.000Z' }),
  'sid with/slash': session('sid with/slash', { name: 'Acme admin', folder: 'admin' }),
  globex: session('globex'),
};

function deps(over: Partial<SearchDeps> = {}): SearchDeps {
  return { settings: () => ctx.settings.get(), life, meetings, intel, sessions: () => SESSIONS, home: HOME, log: ctx.log, ...over };
}

const kinds = (r: SearchResponse) => r.groups.map((g) => g.kind);
const group = (r: SearchResponse, kind: string) => r.groups.find((g) => g.kind === kind)?.items ?? [];
const CLI: Actor = { kind: 'cli' };

async function start(settings: Record<string, unknown> = ALL_ON): Promise<void> {
  ctx = createTestContext({ home: dir, settings: SettingsSchema.parse(settings) });
  ctx.clock.set('2026-11-03T09:00:00.000Z');
  const f = makeFakes(ctx);
  life = buildLifeService(ctx, { sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy, notifiers: f.notifiers }, LIFE_MODULE_BUILDERS, { macZone: 'UTC' });
  await life.start();
}

function seed(): { project: string; todo: string; place: string; post: string } {
  const project = life.todos.createProject({ name: 'Acme site rebuild', emoji: '🛠' }, CLI);
  if (!project.ok) throw new Error(project.reason);
  const todo = life.todos.createTodo({ title: 'Send Acme the quote', due: { day: '2026-11-05', time: '15:00' }, projectId: project.value.id }, CLI);
  const place = life.places.create({ name: 'Acme Café', area: 'Bandra' }, CLI);
  const post = life.posts.create({ platform: 'linkedin', text: 'What Acme taught me\nsecond line' }, CLI);
  if (!todo.ok || !place.ok || !post.ok) throw new Error(`seed: ${JSON.stringify([todo, place, post])}`);
  return { project: project.value.id, todo: todo.value.id, place: place.value.id, post: post.value.id };
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'jantar-search-')));
  meetingsBroken = null;
  intelThrows = false;
});
afterEach(async () => {
  await life?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('searchAll', () => {
  it('every group that has a match, in order, each item with its words and an id-only link', async () => {
    await start();
    const ids = seed();
    const r = searchAll('acme', 5, OWNER, deps());
    expect(SearchResponseSchema.parse(r)).toEqual(r);
    expect(kinds(r)).toEqual(['project', 'todo', 'meeting', 'session', 'intel', 'place', 'post']);
    expect(group(r, 'project')).toEqual([{ kind: 'project', id: ids.project, label: '🛠 Acme site rebuild', sub: '1 open', href: `/work?tab=projects&id=${ids.project}` }]);
    expect(group(r, 'todo')).toEqual([{ kind: 'todo', id: ids.todo, label: 'Send Acme the quote', sub: '2026-11-05 15:00', href: `/todos?id=${ids.todo}` }]);
    expect(group(r, 'meeting')).toEqual([{ kind: 'meeting', id: MEETING, label: 'Kickoff with Acme', sub: '2026-11-02', href: `/meetings?id=${MEETING}` }]);
    expect(group(r, 'session')).toEqual([
      { kind: 'session', id: 'acme-web', label: 'acme-web', sub: 'working', href: '/s/acme-web' },
      { kind: 'session', id: 'sid with/slash', label: 'Acme admin', sub: 'admin · working', href: '/s/sid%20with%2Fslash' },
    ]);
    expect(group(r, 'intel')).toHaveLength(5);
    expect(group(r, 'intel')[0]).toEqual({ kind: 'intel', id: 'captures:01JFZ8X8Y3T0V5G9WQK2M4N6I1', label: 'Acme pricing 1', sub: 'article', href: '/intel?item=captures%3A01JFZ8X8Y3T0V5G9WQK2M4N6I1' });
    expect(group(r, 'place')).toEqual([{ kind: 'place', id: ids.place, label: 'Acme Café', sub: 'Bandra', href: `/places?id=${ids.place}` }]);
    expect(group(r, 'post')).toEqual([{ kind: 'post', id: ids.post, label: 'What Acme taught me', sub: 'linkedin · idea', href: `/posts?id=${ids.post}` }]);
  });

  it('a project links to Todos while Work is off', async () => {
    await start({ ...ALL_ON, life: { todos: true } });
    const { project } = seed2();
    expect(group(searchAll('acme', 5, OWNER, deps()), 'project')[0]?.href).toBe(`/todos?project=${project}`);
  });

  it('each group only while its part is on; sessions always', async () => {
    await start();
    seed();
    await ctx.settings.patch({ life: { todos: false, places: false, posts: false }, intel: { enabled: false }, meetings: { enabled: false } });
    expect(kinds(searchAll('acme', 5, OWNER, deps()))).toEqual(['session']);
    await ctx.settings.patch({ life: { todos: true }, meetings: { enabled: true } });
    meetingsBroken = 'meetings.db could not be opened.';
    expect(kinds(searchAll('acme', 5, OWNER, deps()))).toEqual(['project', 'todo', 'session']);
  });

  it("while life.db is broken, Life's groups are left out and the rest answer", async () => {
    await start();
    seed();
    const broken = new Proxy(life, { get: (t, p) => (p === 'broken' ? () => LIFE_BROKEN_REASON : Reflect.get(t, p, t)) });
    expect(kinds(searchAll('acme', 5, OWNER, deps({ life: broken })))).toEqual(['meeting', 'session', 'intel']);
  });

  it('at most `limit` per group', async () => {
    await start();
    for (let i = 0; i < 7; i++) life.todos.createProject({ name: `Acme ${i}` }, CLI);
    expect(group(searchAll('acme', 5, OWNER, deps()), 'project')).toHaveLength(5);
    const two = searchAll('acme', 2, OWNER, deps());
    for (const g of two.groups) expect(g.items.length, g.kind).toBeLessThanOrEqual(2);
  });

  it('his space only: her projects and to-dos never show', async () => {
    await start();
    life.todos.inSpace(HER).createProject({ name: 'Her Acme list' }, CLI);
    life.todos.inSpace(HER).createTodo({ title: 'Her Acme to-do' }, CLI);
    const r = searchAll('acme', 5, OWNER, deps());
    expect(group(r, 'project')).toEqual([]);
    expect(group(r, 'todo')).toEqual([]);
  });

  it('any case or accent; quotes, % and _ are only text; "Users" does not find every session', async () => {
    await start();
    seed();
    life.todos.createProject({ name: 'Café rebuild' }, CLI);
    expect(group(searchAll('CAFE', 5, OWNER, deps()), 'project').map((p) => p.label)).toEqual(['Café rebuild']);
    for (const q of ["' OR 1=1 --", '%%', '__']) {
      const r = searchAll(q, 5, OWNER, deps({ intel: { list: () => ({ items: [], next: null, total: 0, types: [], tags: [] }) } as unknown as IntelService }));
      expect(kinds(r).filter((k) => k !== 'meeting'), q).toEqual([]);
    }
    expect(group(searchAll('synthetic', 5, OWNER, deps()), 'session')).toEqual([]);
    expect(group(searchAll('client/acme', 5, OWNER, deps()), 'session').map((s) => s.id)).toEqual(['acme-web']);
  });

  it('a group that throws is left out and logged by its kind, never the query', async () => {
    await start();
    seed();
    intelThrows = true;
    const r = searchAll('acme', 5, OWNER, deps());
    expect(kinds(r)).not.toContain('intel');
    expect(kinds(r)).toContain('project');
    const line = ctx.log.records.find((x) => x.msg === 'search group left out');
    expect(line?.fields).toMatchObject({ group: 'intel', error: 'TypeError' });
    expect(JSON.stringify(ctx.log.records)).not.toMatch(/acme/i);
  });

  it("Work's groups refuse anyone but the owner", async () => {
    await start();
    expect(life.work.search('acme', 5, { kind: 'person', personId: HER, deviceId: 'd' })).toEqual({ ok: false, code: 'not_found', reason: WORK_NOT_FOUND });
    expect(life.work.search('acme', 5, OWNER)).toEqual({ ok: true, value: { clients: [], deals: [] } });
  });
});

/** One project with an Acme name (the Work-off case). */
function seed2(): { project: string } {
  const p = life.todos.createProject({ name: 'Acme audit' }, CLI);
  if (!p.ok) throw new Error(p.reason);
  return { project: p.value.id };
}

describe('GET /v1/search', () => {
  let api: TestApi;
  let cookie: string;

  beforeEach(async () => {
    api = await makeApi({
      ctx: { home: dir, settings: SettingsSchema.parse({ life: { todos: true, work: true } }) as Settings, clock: undefined },
      deps: (c, f) => {
        life = buildLifeService(c, { sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy, notifiers: f.notifiers }, LIFE_MODULE_BUILDERS, { macZone: 'UTC' });
        return { life };
      },
    });
    api.ctx.clock.set('2026-11-03T09:00:00.000Z');
    await life.start();
    ({ cookie } = await pairCookie(api, ['read', 'control']));
  });
  afterEach(async () => {
    await api.close();
  });

  const get = (url: string, c = cookie) => api.tcp.inject({ method: 'GET', url, headers: h(c) });

  it('answers the groups; q of 2 to 80 characters; a read-only device is refused; the query is in no log or audit row', async () => {
    life.todos.createProject({ name: 'Northwind QZXV rollout' }, CLI);
    life.todos.createTodo({ title: 'Call Northwind QZXV' }, CLI);
    const res = await get('/v1/search?q=qzxv');
    expect(res.statusCode).toBe(200);
    const body = SearchResponseSchema.parse(res.json());
    expect(kinds(body)).toEqual(['project', 'todo']);
    expect((await get('/v1/search?q=q')).statusCode).toBe(400);
    expect((await get('/v1/search?q=%20q%20')).statusCode).toBe(400);
    expect((await get(`/v1/search?q=${'x'.repeat(81)}`)).statusCode).toBe(400);
    expect((await get('/v1/search?q=qzxv&limit=6')).statusCode).toBe(400);
    expect(SearchResponseSchema.parse((await get('/v1/search?q=qzxv&limit=1')).json()).groups.every((g) => g.items.length === 1)).toBe(true);
    const { cookie: readOnly } = await pairCookie(api, ['read']);
    expect((await get('/v1/search?q=qzxv', readOnly)).statusCode).toBe(403);
    expect(JSON.stringify({ log: api.ctx.log.records, audit: api.ctx.db.audit.list() })).not.toMatch(/qzxv/i);
  });
});
