/**
 * v0.13 Work is owner-only, by reading the route tables and the source.
 * The partner (0.11's People) can never reach a client, a deal, the log, a
 * client project or a follow-up, and nothing here needs a test of hers to
 * say so:
 *
 * - W-T1: every v0.13 route is a `control` route on his host: none under
 *   her prefix, none of scope `person`, and no person route is v0.13. They
 *   are WORK_ROUTES (the `@jantar/protocol/work` subpath, served with the
 *   rest through ALL_ROUTES), never in the index's ROUTES.
 * - W-T2: only life/work/** (and the migration in life/db.ts) names a
 *   `work_` table; no SQL under life/work/** touches `todos` or `projects`
 *   (Work calls the Todos module); there is no SQL in search/ at all.
 * - W-T3: nothing of hers (her route files, her event stream, her Chat's
 *   files, the People modules) imports Work, the search or Work's routes.
 * - W-T4 (O5, O13, O14): a client, a deal or a business only on his own
 *   todos and projects (refused in her space and in a shared one); no
 *   statement ever moves a project or a todo out of his space into
 *   another; every Work module method answers not found for a person; no
 *   Work code ticks her counters.
 * - W-T5: `work` is not an agreement area.
 * - W-T6 (P1's part): no Work tool in her Chat's list; her bundle (the
 *   partner app's source) imports nothing of Work. The full W-T6 sweep (no
 *   client words in logs, audit, events or errors) is v013-work-canary.
 * - W-T7: no person route, and none of his `/v1/people/*` routes, takes a
 *   Work field (contactId, dealId, clientId, business, milestones) in its
 *   body or query, at any depth; the base todo and project schemas her
 *   routes reuse carry none either.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { ProjectBodySchema, ProjectPatchSchema, ROUTES, TodoBodySchema, TodoPatchSchema, TodosQuerySchema, type RouteDef } from '@jantar/protocol';
import { WORK_ROUTES } from '@jantar/protocol/work';
import { AREA_NAMES, PEOPLE_ROUTES, PERSON_PREFIX, PERSON_ROUTES } from '@jantar/protocol/people';
import { ALL_ROUTES } from '../../src/api/all-routes.js';
import { PERSON_CHAT_TOOLS } from '../../src/chat/person-tools.js';
import type { Actor } from '../../src/contracts.js';
import { createTestContext, createTestLifeCore } from '../../src/core/testing.js';
import { LIFE_MODULE_BUILDERS } from '../../src/life/index.js';
import { makeFakes } from '../api/fakes.js';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(SRC, p).split(sep).join('/');
const code = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const src = files(SRC).map((p) => ({ rel: rel(p), text: code(p) }));
const imports = (text: string) => [...text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((m) => m[1] as string);
/** SQL statements in string literals (as the People arch test reads them), plus `CREATE`, `ALTER` and `INSERT`. */
const statements = (text: string) => [...text.matchAll(/(['"`])((?:SELECT|UPDATE|DELETE|INSERT|CREATE|ALTER)\b[\s\S]*?)\1/g)].map((m) => m[2] as string);

const WORK_FIELDS = ['contactId', 'dealId', 'clientId', 'business', 'milestones'];
/**
 * 0.11's own `clientId` on her journal and sleep writes: the id her app makes so a retried write stores
 * nothing new (8 to 64 characters, never a Life id), not a Work client. Reviewed; nothing else may add one.
 */
const HER_IDEMPOTENCY_CLIENT_ID = ['personJournalCreate.body.clientId', 'personSleepStart.body.clientId', 'personSleepWake.body.clientId'];
const v013 = (Object.entries(ALL_ROUTES) as [string, RouteDef][]).filter(([, d]) => d.phase === 'v0.13');

describe('W-T1: every Work route is his', () => {
  it('finds the P1, P2 and P3 routes', () => {
    expect(v013.map(([n]) => n).sort()).toEqual(
      [
        'foldersSeed',
        'projectGet',
        'search',
        'workClientCreate',
        'workClientDelete',
        'workClientGet',
        'workClientHere',
        'workClientLog',
        'workClientNames',
        'workClientSimilar',
        'workClientUpdate',
        'workClients',
        'workDealCreate',
        'workDealDelete',
        'workDealGet',
        'workDealMove',
        'workDealUpdate',
        'workDeals',
        'workExport',
        'workImport',
        'workImportPreview',
        'workImportUndo',
        'workImports',
        'workInsights',
        'workLogAdd',
        'workLogDelete',
        'workLogUpdate',
        'workMeetingClientNew',
        'workMeetingClients',
        'workMeetingSuggest',
        'workSettings',
        'workSettingsUpdate',
        'workStages',
        'workStagesUpdate',
      ].sort(),
    );
  });

  it('every v0.13 route is a control route, never under her prefix', () => {
    for (const [name, def] of v013) {
      expect(def.scope, name).toBe('control');
      expect(def.path.startsWith(PERSON_PREFIX), name).toBe(false);
      expect(def.path.startsWith('/v1/people'), name).toBe(false);
      expect(Object.hasOwn(WORK_ROUTES, name), `${name} is in Work's table`).toBe(true);
    }
  });

  it("Work's routes are not in the package index's table (they stay out of the main bundle), and no path collides", () => {
    for (const name of Object.keys(WORK_ROUTES)) expect(Object.hasOwn(ROUTES, name), name).toBe(false);
    const owner = new Set((Object.values(ROUTES) as RouteDef[]).map((d) => `${d.method} ${d.path}`));
    for (const [name, def] of Object.entries(WORK_ROUTES) as [string, RouteDef][]) expect(owner.has(`${def.method} ${def.path}`), name).toBe(false);
  });

  it('no person route and no People route is v0.13', () => {
    for (const [name, def] of Object.entries({ ...PERSON_ROUTES, ...PEOPLE_ROUTES }) as [string, RouteDef][]) expect(def.phase, name).not.toBe('v0.13');
  });
});

describe("W-T2: only Work names its tables, and Work names nobody else's", () => {
  it("names a work_ table only under life/work/ and in life.db's migration", () => {
    const bad = src.filter((f) => /\bwork_(?:contacts|deals|log)\b/.test(f.text) && !f.rel.startsWith('life/work/') && f.rel !== 'life/db.ts').map((f) => f.rel);
    expect(bad).toEqual([]);
  });

  it('runs no SQL on todos or projects under life/work/', () => {
    const bad: string[] = [];
    for (const f of src.filter((x) => x.rel.startsWith('life/work/'))) {
      for (const sql of statements(f.text)) {
        if (/\b(?:FROM|UPDATE|JOIN|INTO|TABLE)\s+(?:todos|projects)\b/i.test(sql)) bad.push(`${f.rel}: ${sql.slice(0, 80)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('has no SQL in search/ (each group asks its own part)', () => {
    const search = src.filter((f) => f.rel.startsWith('search/'));
    expect(search.length).toBeGreaterThan(0);
    for (const f of search) {
      expect(statements(f.text), f.rel).toEqual([]);
      expect(/\.prepare\(|\.exec\(|\.db\b/.test(f.text), f.rel).toBe(false);
    }
  });

  it('the pattern catches what it is for', () => {
    expect(statements("db.prepare('UPDATE todos SET contact_id = NULL WHERE space = ?')")).toHaveLength(1);
    expect(/\b(?:FROM|UPDATE|JOIN|INTO|TABLE)\s+(?:todos|projects)\b/i.test('SELECT json FROM todos WHERE x')).toBe(true);
  });
});

describe('W-T3: nothing of hers imports Work', () => {
  const hers = (r: string) =>
    r.startsWith('api/routes/person/') || r === 'api/person-events.ts' || r === 'api/people-fence.ts' || r.startsWith('chat/person-') || r.startsWith('life/people/');
  it('her route files, her stream, her Chat and the People modules import no Work, search or Work route file', () => {
    const bad: string[] = [];
    for (const f of src.filter((x) => hers(x.rel))) {
      for (const m of imports(f.text)) if (/(?:^|\/)(?:work|search)(?:\/|\.js$)|routes\/work\.js$|routes\/search\.js$/.test(m)) bad.push(`${f.rel} -> ${m}`);
    }
    expect(src.some((x) => hers(x.rel))).toBe(true);
    expect(bad).toEqual([]);
  });
});

describe('W-T4: Work is his space only, and answers no one else', () => {
  const HER_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
  const HER: Actor = { kind: 'person', personId: HER_ID, deviceId: 'd' };
  const PHONE: Actor = { kind: 'device', deviceId: 'd1', scopes: ['read', 'control'] };

  function build() {
    const core = createTestLifeCore({ tz: 'UTC', settings: { todos: true, work: true } });
    core.clock.set('2026-11-03T09:00:00.000Z');
    const ctx = createTestContext({ clock: core.clock });
    const f = makeFakes(ctx);
    const d = { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy };
    const todos = LIFE_MODULE_BUILDERS.todos(core, d);
    const work = LIFE_MODULE_BUILDERS.work(core, d, todos);
    return { core, todos, work };
  }

  it('a client, a deal or a business is refused on her todos and projects, and on a shared list', () => {
    const { core, todos, work } = build();
    try {
      const c = work.createClient({ name: 'Acme Studio', kind: 'company' }, PHONE);
      if (!c.ok) throw new Error(c.reason);
      for (const space of [HER_ID, 's:01JZZZZZZZZZZZZZZZZZZZZZZY']) {
        const m = todos.inSpace(space);
        expect(m.createTodo({ title: 'x', contactId: c.value.id }, HER).ok, space).toBe(false);
        expect(m.createTodo({ title: 'x', dealId: c.value.id }, HER).ok, space).toBe(false);
        expect(m.createProject({ name: 'x', clientId: c.value.id }, HER).ok, space).toBe(false);
        expect(m.createProject({ name: 'x', business: c.value.id }, HER).ok, space).toBe(false);
        const p = m.createProject({ name: 'plain' }, HER);
        if (!p.ok) throw new Error(p.reason);
        expect(m.updateProject(p.value.id, { clientId: c.value.id }, HER).ok, space).toBe(false);
        expect(m.followUps(null, false)).toEqual([]);
        expect(m.unlinkClient(c.value.id)).toEqual({ todos: 0, projects: 0 });
      }
    } finally {
      core.close();
    }
  });

  it('every Work module method that takes an actor answers not found for her', () => {
    const { core, work } = build();
    try {
      const c = work.createClient({ name: 'Acme Studio', kind: 'company' }, PHONE);
      if (!c.ok) throw new Error(c.reason);
      const id = c.value.id;
      const m = { id: '01JZZZZZZZZZZZZZZZZZZZZZM1', projectId: null, startedAt: '2026-11-03T09:00:00.000Z', people: ['Sam'] };
      const calls: [string, () => unknown][] = [
        ['seed', () => work.seed([{ folder: '/synthetic/a', name: 'A' }], HER)],
        ['search', () => work.search('acme', 5, HER)],
        ['clients', () => work.clients({ sort: 'name' }, HER)],
        ['createClient', () => work.createClient({ name: 'X' }, HER)],
        ['similar', () => work.similar({ name: 'Acme' }, HER)],
        ['names', () => work.names([id], HER)],
        ['client', () => work.client(id, HER)],
        ['clientLog', () => work.clientLog(id, undefined, HER)],
        ['updateClient', () => work.updateClient(id, { name: 'X' }, HER)],
        ['removeClient', () => work.removeClient(id, HER)],
        ['addLog', () => work.addLog(id, { kind: 'note' }, HER)],
        ['updateLog', () => work.updateLog(id, { body: 'x' }, HER)],
        ['removeLog', () => work.removeLog(id, HER)],
        ['projectPart', () => work.projectPart(id, id, HER)],
        ['setMeetingClients', () => work.setMeetingClients(m, [id], HER)],
        ['meetingSuggest', () => work.meetingSuggest(m, HER)],
        ['meetingClientNew', () => work.meetingClientNew(m, { person: 0 }, HER)],
        ['importPreview', () => work.importPreview({ format: 'csv', text: 'Name\nX\n' }, HER)],
        ['importRows', () => work.importRows({ previewId: id, rows: [] }, HER)],
        ['imports', () => work.imports(HER)],
        ['undoImport', () => work.undoImport(id, HER)],
        ['exportCsv', () => work.exportCsv(HER)],
        ['settingsGet', () => work.settingsGet(HER)],
        ['settingsUpdate', () => work.settingsUpdate({ quietDays: 3 }, HER)],
        // P3: deals, stages, insights.
        ['deals', () => work.deals({ open: true }, HER)],
        ['createDeal', () => work.createDeal({ clientId: id, title: 'X' }, HER)],
        ['deal', () => work.deal(id, HER)],
        ['updateDeal', () => work.updateDeal(id, { title: 'X' }, HER)],
        ['removeDeal', () => work.removeDeal(id, HER)],
        ['moveDeal', () => work.moveDeal(id, { stage: 'won' }, HER)],
        ['stagesGet', () => work.stagesGet(HER)],
        ['stagesPut', () => work.stagesPut({ stages: [{ id: 'new', name: 'X' }, { id: 'won', name: 'Won' }, { id: 'lost', name: 'Lost' }] }, HER)],
        ['insights', () => work.insights({ period: '90d' }, HER)],
        ['exportCsv deals', () => work.exportCsv(HER, 'deals')],
      ];
      for (const [name, call] of calls) expect(call(), name).toEqual({ ok: false, code: 'not_found', reason: 'Not found.' });
      // Nothing of his changed meanwhile.
      const still = work.client(id, PHONE);
      expect(still.ok && still.value.contact.name).toBe('Acme Studio');
      expect(still.ok && still.value.deals).toEqual([]);
      const stages = work.stagesGet(PHONE);
      expect(stages.ok && stages.value.stages).toHaveLength(6);
    } finally {
      core.close();
    }
  });

  it('no statement moves a project or a todo out of his space; no Work code ticks her counters', () => {
    const bad: string[] = [];
    for (const f of src) {
      for (const sql of statements(f.text)) {
        const m = /\bUPDATE\s+(?:projects|todos)\s+SET\s+space\s*=\s*([^,\s]+)/i.exec(sql);
        if (m && m[1] !== "''") bad.push(`${f.rel}: ${sql.slice(0, 80)}`);
      }
    }
    expect(bad).toEqual([]);
    for (const f of src.filter((x) => x.rel.startsWith('life/work/'))) expect(/PersonTicks|\.bump\(|life\/people\//.test(f.text), f.rel).toBe(false);
  });
});

describe('W-T5 and her Chat', () => {
  it('work is not an agreement area', () => {
    expect(AREA_NAMES as readonly string[]).not.toContain('work');
  });

  it('no Work tool is in the list her Chat may ever use', () => {
    for (const t of PERSON_CHAT_TOOLS) expect(/client|deal|work|project_get|log_add|followup|search/.test(t), t).toBe(false);
  });

  it("her bundle (the partner app's source) imports nothing of Work", () => {
    const WEB = fileURLToPath(new URL('../../../web/src', import.meta.url));
    const hers = [...files(join(WEB, 'partner')), ...files(join(WEB, 'ui', 'screens', 'people'))].filter((p) => /\.tsx?$/.test(p));
    expect(hers.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const p of hers) for (const m of imports(code(p))) if (/protocol\/work|screens\/work|\/work(?:\/|\.js$)/.test(m)) bad.push(`${relative(WEB, p)} -> ${m}`);
    expect(bad).toEqual([]);
  });
});

/** Every object key a zod schema accepts, at any depth (objects, wrappers, arrays, unions, pipes). */
function keysOf(schema: unknown, seen = new Set<unknown>()): string[] {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return [];
  seen.add(schema);
  const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (!def) return [];
  const out: string[] = [];
  const shape = def.shape as Record<string, unknown> | undefined;
  if (shape) for (const [k, v] of Object.entries(shape)) out.push(k, ...keysOf(v, seen));
  for (const key of ['innerType', 'element', 'in', 'out', 'left', 'right', 'valueType', 'catchall']) out.push(...keysOf(def[key], seen));
  for (const o of (def.options as unknown[] | undefined) ?? []) out.push(...keysOf(o, seen));
  return out;
}

describe('W-T7: no person route takes a Work field', () => {
  it('the walker finds a nested key', async () => {
    const { z: zod } = await import('zod');
    expect(keysOf(zod.strictObject({ a: zod.array(zod.object({ contactId: zod.string() })).optional() }))).toEqual(['a', 'contactId']);
  });

  it("her routes and his /v1/people routes: no body or query has one, at any depth", () => {
    const bad: string[] = [];
    for (const [name, def] of Object.entries({ ...PERSON_ROUTES, ...PEOPLE_ROUTES }) as [string, RouteDef][]) {
      for (const part of ['body', 'query', 'params'] as const) {
        for (const k of keysOf(def[part])) if (WORK_FIELDS.includes(k) && !HER_IDEMPOTENCY_CLIENT_ID.includes(`${name}.${part}.${k}`)) bad.push(`${name}.${part}.${k}`);
      }
    }
    expect(Object.keys(PERSON_ROUTES).length).toBeGreaterThan(10);
    expect(bad).toEqual([]);
    // Each reviewed one is still that idempotency id: a short string, never a Life id that could name a client.
    for (const at of HER_IDEMPOTENCY_CLIENT_ID) {
      const [name] = at.split('.');
      const body = (PERSON_ROUTES as Record<string, RouteDef>)[name as string]?.body as { shape?: Record<string, z.ZodType> } | undefined;
      const field = body?.shape?.clientId;
      expect(field?.safeParse('retry-1234').success, at).toBe(true);
      expect(field?.safeParse('01JZZZZZZZZZZZZZZZZZZZZZZZ'.repeat(3)).success, at).toBe(false);
    }
  });

  it('the base todo and project schemas her routes reuse carry no Work field and no search', () => {
    for (const s of [TodoBodySchema, TodoPatchSchema, ProjectBodySchema, ProjectPatchSchema, TodosQuerySchema] as z.ZodType[]) {
      const keys = keysOf(s);
      expect(keys.length).toBeGreaterThan(0);
      for (const k of [...WORK_FIELDS, 'q']) expect(keys, k).not.toContain(k);
    }
  });
});
