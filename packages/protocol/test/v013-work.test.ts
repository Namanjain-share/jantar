/**
 * v0.13 Work, P1 (protocol): the switch, a seventh Life module that counts
 * as on only while Todos is on too; the project hub's shape; the owner's
 * `q` on the todos list, in an owner-only extension (her routes reuse
 * TodosQuerySchema as it is).
 */
import { describe, expect, it } from 'vitest';
import * as index from '../src/index.js';
import { LIFE_LIMITS, LIFE_MODULES, LifeSettingsSchema, OwnerTodosQuerySchema, ROUTES, SettingsSchema, TodosQuerySchema, lifeOn, settingsFeatures, workOn } from '../src/index.js';
import { ProjectHubSchema, SEARCH_KINDS, SearchQuerySchema, SearchResponseSchema, WORK_ROUTES, WorkSeedBodySchema } from '../src/work.js';

describe('v0.13 the work switch', () => {
  it('is a seventh Life module, last, off by default', () => {
    expect(LIFE_MODULES.at(-1)).toBe('work');
    expect(LifeSettingsSchema.parse({}).work).toBe(false);
  });

  it('counts as on only while Todos is on too', () => {
    expect(workOn(SettingsSchema.parse({ life: { work: true } }))).toBe(false);
    expect(workOn(SettingsSchema.parse({ life: { todos: true } }))).toBe(false);
    expect(workOn(SettingsSchema.parse({ life: { work: true, todos: true } }))).toBe(true);
    // Alone it still opens life.db (any module on), so the switch can be read and turned off again.
    expect(lifeOn(SettingsSchema.parse({ life: { work: true } }))).toBe(true);
  });

  it('is never one of the features every device sees (which Life modules are on is a control read)', () => {
    expect(Object.keys(settingsFeatures(SettingsSchema.parse({ life: { work: true, todos: true } })))).not.toContain('work');
  });

  it('a project cap of 500 (done client projects pile up)', () => {
    expect(LIFE_LIMITS.projects).toBe(500);
  });
});

const ID = '01JZZZZZZZZZZZZZZZZZZZZZZY';
const AT = '2026-11-03T09:00:00.000Z';

describe("v0.13 Work's own shapes and routes are a subpath", () => {
  it('the package index exports none of them, so the main bundle carries none', () => {
    for (const name of ['WORK_ROUTES', 'WORK_LIMITS', 'ProjectHubSchema', 'SearchQuerySchema', 'SearchResponseSchema', 'WorkSeedBodySchema', 'SEARCH_KINDS']) expect(index, name).not.toHaveProperty(name);
    for (const name of Object.keys(WORK_ROUTES)) expect(Object.hasOwn(ROUTES, name), name).toBe(false);
  });
});

describe('v0.13 the project hub', () => {
  const hub = () => ({
    project: { id: ID, name: 'Site rebuild', status: 'active', createdAt: AT, updatedAt: AT, open: 1, overdue: 0 },
    open: [{ id: ID, title: 'Send wireframes', priority: 'normal', due: { day: '2026-11-05', time: '15:00' }, createdAt: AT, updatedAt: AT }],
    doneThisWeek: 0,
    recentDone: [],
    health: { overdue: 0, nextDue: { todoId: ID, due: { day: '2026-11-05', time: '15:00' } }, doneByWeek: [0, 0, 0, 0, 0, 0, 0, 0] },
  });

  it('parses a hub, with eight weeks of done todos and at most ten recent ones', () => {
    expect(ProjectHubSchema.safeParse(hub()).success).toBe(true);
    expect(ProjectHubSchema.safeParse({ ...hub(), health: { ...hub().health, doneByWeek: [0, 0] } }).success).toBe(false);
    expect(ProjectHubSchema.safeParse({ ...hub(), recentDone: Array.from({ length: 11 }, () => hub().open[0]) }).success).toBe(false);
    expect(ProjectHubSchema.safeParse({ ...hub(), health: { ...hub().health, quietDays: 0 } }).success).toBe(false);
  });

  it('is GET /v1/projects/:id, an owner route behind the todos switch', () => {
    expect(WORK_ROUTES.projectGet).toMatchObject({ method: 'GET', path: '/v1/projects/:id', scope: 'control', phase: 'v0.13', ctl: false, feature: 'todos' });
  });
});

describe('v0.13 ?q= on the todos list (owner-only)', () => {
  it('the owner route takes q, 1 to 80 characters once trimmed', () => {
    expect(ROUTES.todosList.query).toBe(OwnerTodosQuerySchema);
    expect(OwnerTodosQuerySchema.parse({ q: '  acme ' })).toMatchObject({ q: 'acme', done: false });
    expect(OwnerTodosQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
    expect(OwnerTodosQuerySchema.safeParse({ q: 'x'.repeat(81) }).success).toBe(false);
  });

  it('TodosQuerySchema, which her routes reuse, is as it was: no q', () => {
    expect(Object.keys(TodosQuerySchema.shape).sort()).toEqual(['done', 'project']);
    expect(TodosQuerySchema.parse({ q: 'acme' })).not.toHaveProperty('q');
  });
});

describe('v0.13 one search across Jantar', () => {
  it('is GET /v1/search, an owner route with no switch of its own', () => {
    expect(WORK_ROUTES.search).toMatchObject({ method: 'GET', path: '/v1/search', scope: 'control', phase: 'v0.13', ctl: false });
    expect(WORK_ROUTES.search).not.toHaveProperty('feature');
  });

  it('takes q of 2 to 80 characters once trimmed, and at most 5 a group', () => {
    expect(SearchQuerySchema.parse({ q: ' acme ' })).toEqual({ q: 'acme', limit: 5 });
    expect(SearchQuerySchema.parse({ q: 'acme', limit: '2' })).toEqual({ q: 'acme', limit: 2 });
    for (const bad of [{ q: 'a' }, { q: ' a ' }, { q: 'x'.repeat(81) }, { q: 'acme', limit: '6' }, { q: 'acme', limit: '0' }, {}]) {
      expect(SearchQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('answers groups in SEARCH_KINDS order, never an empty one', () => {
    expect(SEARCH_KINDS).toEqual(['client', 'project', 'deal', 'todo', 'meeting', 'session', 'intel', 'place', 'post']);
    const item = { kind: 'todo', id: ID, label: 'Send wireframes', href: `/todos?id=${ID}` };
    expect(SearchResponseSchema.safeParse({ groups: [{ kind: 'todo', items: [item] }] }).success).toBe(true);
    expect(SearchResponseSchema.safeParse({ groups: [{ kind: 'todo', items: [] }] }).success).toBe(false);
    expect(SearchResponseSchema.safeParse({ groups: [{ kind: 'todo', items: Array.from({ length: 6 }, () => item) }] }).success).toBe(false);
  });
});

describe('v0.13 projects from client folders', () => {
  it('is POST /v1/work/seed: an owner route behind the work switch, on ctl.sock for the CLI', () => {
    expect(WORK_ROUTES.foldersSeed).toMatchObject({ method: 'POST', path: '/v1/work/seed', scope: 'control', phase: 'v0.13', ctl: true, feature: 'work' });
  });

  it('takes 1 to 50 folders as the browsers address them (a root and a path in it), each with a name; strict', () => {
    const item = { root: 'r.work', path: 'client/acme', name: 'Acme' };
    expect(WorkSeedBodySchema.parse({ items: [item] })).toEqual({ items: [item] });
    expect(WorkSeedBodySchema.parse({ items: [{ ...item, name: '  Acme  ' }] }).items[0]?.name).toBe('Acme');
    for (const bad of [
      { items: [] },
      { items: Array.from({ length: 51 }, () => item) },
      { items: [{ ...item, path: '' }] },
      { items: [{ ...item, name: '' }] },
      { items: [{ ...item, name: 'x'.repeat(61) }] },
      { items: [{ ...item, folder: '/abs' }] },
      { items: [item], clients: 'yes' },
    ]) {
      expect(WorkSeedBodySchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });
});
