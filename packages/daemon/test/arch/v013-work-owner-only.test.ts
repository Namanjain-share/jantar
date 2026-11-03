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
 * - W-T5: `work` is not an agreement area.
 * - W-T6 (P1's part): no Work tool in her Chat's list.
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

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (name.endsWith('.ts')) out.push(p);
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
  it('finds the P1 and P2 routes', () => {
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
        'workExport',
        'workImport',
        'workImportPreview',
        'workImportUndo',
        'workImports',
        'workLogAdd',
        'workLogDelete',
        'workLogUpdate',
        'workMeetingClientNew',
        'workMeetingClients',
        'workMeetingSuggest',
        'workSettings',
        'workSettingsUpdate',
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

describe('W-T5 and her Chat', () => {
  it('work is not an agreement area', () => {
    expect(AREA_NAMES as readonly string[]).not.toContain('work');
  });

  it('no Work tool is in the list her Chat may ever use', () => {
    for (const t of PERSON_CHAT_TOOLS) expect(/client|deal|work|project_get|log_add|search/.test(t), t).toBe(false);
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
