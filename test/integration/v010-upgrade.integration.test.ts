/**
 * v0.10 Life's second schema change, end to end (spec 0.10 A2, A8): a
 * synthetic life.db as 0.9.0 left it (schema 2, with a todo, a post, a café
 * and a calorie target) sits in the state dir when jantard starts with the
 * production wiring (harness.ts).
 *
 * 1. Start: the daemon wrote backups/life-pre-<version>.db (0600 in a 0700
 *    folder) before migrating; the copy is still at schema 2 with every
 *    row; life.db is at the current schema (3 in 0.10, 4 since 0.11's People)
 *    with every row, and the café reads with
 *    its new fields defaulted. One `life.precopy` log line, by name only.
 * 2. `jantar life status` names the schema and the copy.
 * 3. A café added after the upgrade; `jantar life restore
 *    life-pre-<version>.db --yes` over ctl.sock brings back the 0.9.0 rows
 *    (the staged copy migrated again to the current schema), without a
 *    second copy.
 * 4. A restart writes no copy either: life.db is already current.
 */
import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { perfBudgetMs } from '@jantar/fixtures';
import { DEVICE_COOKIE, LifeBackupNameSchema, type PairStartResponse, type PlacesResponse, type TodosResponse } from '@jantar/protocol';
import { LIFE_BROKEN_REASON, LIFE_MIGRATIONS, LIFE_SCHEMA_VERSION, openCheckedDb } from '../../packages/daemon/src/life/db.js';
import { callDaemon, createCtlClient, defaultDeps, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret, type HttpResult } from './http.js';

const AT = '2026-11-01T10:00:00.000Z';
const TODO = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const CAFE = '01JFZ8X8Y3T0V5G9WQK2M4N6PS';
const mode = async (p: string) => (await stat(p)).mode & 0o777;

/** What a closed database file holds: its schema, its tables and the names in places. */
function look(path: string): { schema: string; tables: string[]; places: string[]; todos: number } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      schema: (db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string }).value,
      tables: (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name),
      places: (db.prepare('SELECT json FROM places ORDER BY id').all() as Array<{ json: string }>).map((r) => (JSON.parse(r.json) as { name: string }).name),
      todos: (db.prepare('SELECT COUNT(*) AS n FROM todos').get() as { n: number }).n,
    };
  } finally {
    db.close();
  }
}

describe("v0.10: Life's second schema change through jantard: the pre-upgrade copy and the way back", () => {
  let d: Daemon;
  let ctl: CtlClient;
  let phone = '';
  let pre = '';

  async function call(method: string, path: string, body?: unknown): Promise<HttpResult> {
    const headers: Record<string, string> = method === 'GET' ? {} : { 'idempotency-key': `k-${randomUUID()}` };
    return http(d.port, method, path, { cookie: phone, headers, ...(body === undefined ? {} : { body }) });
  }
  async function ok<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await call(method, path, body);
    expect(r.status, `${method} ${path}: ${r.text}`).toBe(200);
    return r.body as T;
  }
  async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const io = memoryIo(d.home.env);
    const code = await main(argv, { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } });
    return { code, out: io.stdout, err: io.stderr };
  }
  const names = async () => (await ok<PlacesResponse>('GET', '/v1/places')).places.map((p) => p.name);

  beforeAll(async () => {
    d = await bootDaemon({
      home: { sessions: [] },
      settings: { life: { timezone: 'UTC', todos: true, places: true, posts: true } },
      before: async (home) => {
        // life.db as 0.9.0 wrote it: migrations 1 and 2 only.
        const r = openCheckedDb(join(home.jantarHome, 'life.db'), { migrations: LIFE_MIGRATIONS.slice(0, 2), brokenReason: LIFE_BROKEN_REASON });
        if (!r.ok) throw new Error(r.code);
        r.db.tx(() => {
          r.db
            .prepare('INSERT INTO todos (id, project_id, due_day, done_at, updated_at, json) VALUES (?, NULL, NULL, NULL, ?, ?)')
            .run(TODO, AT, JSON.stringify({ id: TODO, title: 'Example todo', priority: 'normal', createdAt: AT, updatedAt: AT }));
          const cafe = { id: CAFE, name: 'Example Café', tried: true, dishes: [{ name: 'Sample Dosa', rating: 5 }], best: 5, createdAt: AT, updatedAt: AT };
          r.db.prepare('INSERT INTO places (id, best, updated_at, json) VALUES (?, 5, ?, ?)').run(CAFE, AT, JSON.stringify(cafe));
          r.db.setMeta('kcal_target', '1800');
        });
        r.db.close();
      },
    });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'upgrade phone', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'upgrade phone' } });
    expect(claim.status, claim.text).toBe(200);
    phone = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(phone, claim.body);
    pre = `life-pre-${d.ctx.version.daemon}.db`;
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('1. the copy was written before the migration: 0600 in a 0700 folder, still schema 2, every row; life.db current', async () => {
    const backups = d.ctx.paths.backupsDir;
    expect(LifeBackupNameSchema.safeParse(pre).success).toBe(true);
    const names0 = (await readdir(backups)).filter((n) => n.startsWith('life-pre-'));
    expect(names0).toEqual([pre]);
    expect(await mode(join(backups, pre))).toBe(0o600);
    expect(await mode(backups)).toBe(0o700);
    expect(look(join(backups, pre))).toEqual({
      schema: '2',
      tables: expect.not.arrayContaining(['place_visits']) as unknown as string[],
      places: ['Example Café'],
      todos: 1,
    });
    expect(await names()).toEqual(['Example Café']);
    const cafe = (await ok<PlacesResponse>('GET', '/v1/places')).places[0]!;
    expect(cafe).toMatchObject({ id: CAFE, tags: [], visits: { count: 0, last: null, avgSpend: null }, best: 5 });
    expect((await ok<TodosResponse>('GET', '/v1/todos')).todos.map((t) => t.title)).toEqual(['Example todo']);
    const logged = d.log.records.filter((r) => r.fields?.['event'] === 'life.precopy');
    expect(logged.map((r) => r.fields)).toEqual([expect.objectContaining({ from: 2, to: LIFE_SCHEMA_VERSION, file: pre })]);
    expect(JSON.stringify(logged)).not.toContain(d.home.root);
  });

  it('2. jantar life status names the schema and the copy', async () => {
    const st = await cli('life', 'status');
    expect(st.code, st.err).toBe(0);
    expect(st.out).toContain(`(life.db schema ${LIFE_SCHEMA_VERSION})`);
    expect(st.out).toContain(`Pre-upgrade copy: ${pre}\n`);
  });

  it('3. restoring the copy brings back the 0.9.0 rows, migrated to the current schema again, with no second copy', async () => {
    await ok('POST', '/v1/places', { name: 'Added after the upgrade', tags: ['wifi'] });
    expect(await names()).toEqual(['Example Café', 'Added after the upgrade']);
    const r = await cli('life', 'restore', pre, '--yes');
    expect(r.code, r.err).toBe(0);
    expect(await names()).toEqual(['Example Café']);
    expect(look(d.ctx.paths.lifeDb).schema).toBe(String(LIFE_SCHEMA_VERSION));
    expect(look(d.ctx.paths.lifeDb).tables).toContain('place_visits');
    expect((await readdir(d.ctx.paths.backupsDir)).filter((n) => n.startsWith('life-pre-'))).toEqual([pre]);
    expect(look(join(d.ctx.paths.backupsDir, pre)).schema).toBe('2');
    expect(d.log.records.filter((x) => x.fields?.['event'] === 'life.precopy')).toHaveLength(1);
    // The visits table works on the restored file.
    await ok('POST', `/v1/places/${CAFE}/visits`, { spend: 45000 });
    expect((await ok<PlacesResponse>('GET', '/v1/places')).places[0]?.visits.count).toBe(1);
  });

  it('4. a restart writes no copy: life.db is current already', async () => {
    await d.restart();
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket again');
    expect(await names()).toEqual(['Example Café']);
    expect((await readdir(d.ctx.paths.backupsDir)).filter((n) => n.startsWith('life-pre-'))).toEqual([pre]);
    expect(d.log.records.filter((x) => x.fields?.['event'] === 'life.precopy')).toHaveLength(1);
  });
});
