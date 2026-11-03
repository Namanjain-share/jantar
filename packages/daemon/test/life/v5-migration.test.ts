/**
 * v0.13 Work, life.db schema 5 (`work`): one migration with every table
 * Work's phases need. A schema-4 file (0.11's) with rows in its tables
 * migrates in one transaction: every row stays, the follow-up column is
 * there and empty, Work's tables exist and are empty with their indexes,
 * quick_check passes, and the service writes its pre-migrate copy first. A
 * failure part way leaves schema 4 and every row. A 0.11 build (schema 4)
 * refuses a schema-5 file untouched. The nightly backup and a restore carry
 * Work's rows with the rest of Life.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsSchema } from '@jantar/protocol';
import type { LifeService } from '../../src/contracts.js';
import { createTestContext } from '../../src/core/testing.js';
import { listBackups, preUpgradeName, writeBackup } from '../../src/life/backup.js';
import { LIFE_BROKEN_REASON, LIFE_MIGRATIONS, LIFE_SCHEMA_VERSION, openCheckedDb, openLifeDb } from '../../src/life/db.js';
import { LIFE_MODULE_BUILDERS } from '../../src/life/index.js';
import { buildLifeService } from '../../src/life/service.js';
import { makeFakes } from '../api/fakes.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jantar-v5-'));
  file = join(dir, 'life.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = '2026-11-03T09:00:00.000Z';
const HER = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const count = (db: { prepare(s: string): { get(): unknown } }, t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
const WORK_TABLES = ['work_contacts', 'work_deals', 'work_log'] as const;

/** A life.db as 0.11.0 left it (schema 4): his project and todos, her todo, a medicine, a café, a ping. */
function schemaFour(): void {
  const r = openCheckedDb(file, { migrations: LIFE_MIGRATIONS.slice(0, 4), brokenReason: LIFE_BROKEN_REASON });
  if (!r.ok) throw new Error(r.code);
  const db = r.db;
  db.tx(() => {
    db.prepare("INSERT INTO projects (id, status, updated_at, json) VALUES ('p1', 'active', ?, '{}')").run(NOW);
    db.prepare("INSERT INTO todos (id, project_id, due_day, done_at, updated_at, json) VALUES ('t1', 'p1', '2026-11-03', NULL, ?, '{}')").run(NOW);
    db.prepare("INSERT INTO todos (id, project_id, due_day, done_at, updated_at, json) VALUES ('t2', NULL, NULL, ?, ?, '{}')").run(NOW, NOW);
    db.prepare("INSERT INTO todos (id, project_id, due_day, done_at, updated_at, json, space, by_person) VALUES ('t3', NULL, NULL, NULL, ?, '{}', ?, ?)").run(NOW, HER, HER);
    db.prepare("INSERT INTO medicines (id, stopped_on, updated_at, json) VALUES ('m1', NULL, ?, '{}')").run(NOW);
    db.prepare("INSERT INTO places (id, best, updated_at, json) VALUES ('c1', 5, ?, '{}')").run(NOW);
    db.prepare("INSERT INTO pings (id, kind, ref, sub, next_at, failures) VALUES ('g1', 'todo', 't1', '', ?, 0)").run(NOW);
    db.prepare("INSERT INTO people (id, state, updated_at, json) VALUES (?, 'active', ?, '{}')").run(HER, NOW);
  });
  db.setMeta('kcal_target', '1800');
  db.close();
}

const columns = (db: { raw: DatabaseSync }, t: string) => (db.raw.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
const indexes = (db: { raw: DatabaseSync }, t: string) =>
  (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name").all(t) as { name: string }[]).map((i) => i.name);

describe('life.db schema 5 (work)', () => {
  it('is the fifth migration, named work, and the current schema', () => {
    expect(LIFE_SCHEMA_VERSION).toBe(5);
    expect(LIFE_MIGRATIONS.at(-1)).toMatchObject({ version: 5, name: 'work' });
    // Shipped migrations are never edited: Work only adds.
    for (const m of LIFE_MIGRATIONS.slice(0, 4)) expect(m.sql).not.toMatch(/\bwork_/);
  });

  it("migrates a schema-4 file: every row stays (hers in her space too); Work's tables are there and empty", () => {
    schemaFour();
    let copied = '';
    const r = openLifeDb(file, { preMigrateCopy: (from, to) => (copied = join(dir, 'backups', `life-pre-test-${from}-${to}.db`)) });
    if (!r.ok) throw new Error(r.code);
    try {
      expect(r.db.meta('schema')).toBe('5');
      expect(r.precopy).toEqual({ from: 4, to: 5, file: 'life-pre-test-4-5.db' });
      expect(existsSync(copied)).toBe(true);
      expect(r.db.meta('kcal_target')).toBe('1800');
      const counts = Object.fromEntries(['projects', 'todos', 'medicines', 'places', 'pings', 'people'].map((t) => [t, count(r.db, t)]));
      expect(counts).toEqual({ projects: 1, todos: 3, medicines: 1, places: 1, pings: 1, people: 1 });
      expect(r.db.prepare('SELECT id, space, contact_id FROM todos ORDER BY id').all()).toEqual([
        { id: 't1', space: '', contact_id: null },
        { id: 't2', space: '', contact_id: null },
        { id: 't3', space: HER, contact_id: null },
      ]);
      for (const t of WORK_TABLES) expect(count(r.db, t), t).toBe(0);
      expect(columns(r.db, 'work_contacts')).toEqual(['id', 'kind', 'state', 'company_id', 'name_key', 'last_touch_at', 'merged_into', 'updated_at', 'json']);
      expect(columns(r.db, 'work_deals')).toEqual(['id', 'contact_id', 'stage', 'closed_at', 'updated_at', 'json']);
      expect(columns(r.db, 'work_log')).toEqual(['id', 'contact_id', 'deal_id', 'project_id', 'meeting_id', 'at', 'kind', 'json']);
      expect(indexes(r.db, 'work_contacts')).toEqual(['work_contacts_company', 'work_contacts_name', 'work_contacts_state']);
      expect(indexes(r.db, 'work_deals')).toEqual(['work_deals_contact', 'work_deals_open']);
      expect(indexes(r.db, 'work_log')).toEqual(['work_log_contact', 'work_log_deal', 'work_log_meeting', 'work_log_project']);
      expect(indexes(r.db, 'todos')).toContain('todos_contact');
      // Owner-only by construction: no Work table has a space column.
      for (const t of WORK_TABLES) expect(columns(r.db, t), t).not.toContain('space');
      expect(Object.values(r.db.raw.prepare('PRAGMA quick_check').get() as object)[0]).toBe('ok');
    } finally {
      r.db.close();
    }
  });

  it("a meeting links to a client once: (meeting_id, contact_id) is unique, rows with no meeting are not", () => {
    const r = openLifeDb(file);
    if (!r.ok) throw new Error(r.code);
    try {
      const add = r.db.prepare("INSERT INTO work_log (id, contact_id, meeting_id, at, kind, json) VALUES (?, ?, ?, ?, ?, '{}')");
      add.run('l1', 'c1', 'mt1', NOW, 'meeting');
      add.run('l2', 'c2', 'mt1', NOW, 'meeting');
      expect(() => add.run('l3', 'c1', 'mt1', NOW, 'meeting')).toThrow(/UNIQUE/);
      add.run('l4', 'c1', null, NOW, 'call');
      add.run('l5', 'c1', null, NOW, 'call');
      expect(count(r.db, 'work_log')).toBe(4);
    } finally {
      r.db.close();
    }
  });

  it('a failure inside the migration leaves schema 4 and every row as it was', () => {
    schemaFour();
    const raw = new DatabaseSync(file);
    // A table the migration creates already exists: its CREATE fails part way through.
    raw.exec('CREATE TABLE work_log (x)');
    raw.close();
    const r = openLifeDb(file);
    expect(r).toMatchObject({ ok: false, code: 'migration_failed' });
    const check = new DatabaseSync(file, { readOnly: true });
    try {
      expect(check.prepare("SELECT value FROM meta WHERE key = 'schema'").get()).toEqual({ value: '4' });
      expect((check.prepare('PRAGMA table_info(todos)').all() as { name: string }[]).map((c) => c.name)).not.toContain('contact_id');
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'work_contacts%'").all()).toEqual([]);
      expect(check.prepare('SELECT COUNT(*) AS n FROM todos').get()).toEqual({ n: 3 });
    } finally {
      check.close();
    }
  });

  it('0.11 (schema 4) refuses a schema-5 file (newer_schema) and leaves it exactly as it was', () => {
    const r = openLifeDb(file);
    if (!r.ok) throw new Error(r.code);
    r.db.prepare("INSERT INTO work_contacts (id, kind, state, name_key, updated_at, json) VALUES ('c1', 'company', 'client', 'acme', ?, '{}')").run(NOW);
    r.db.close();
    const before = sha(file);
    const listing = readdirSync(dir).sort();
    const old = openCheckedDb(file, { migrations: LIFE_MIGRATIONS.slice(0, 4), brokenReason: LIFE_BROKEN_REASON });
    expect(old).toEqual({ ok: false, code: 'newer_schema', reason: LIFE_BROKEN_REASON });
    expect(sha(file)).toBe(before);
    expect(readdirSync(dir).sort()).toEqual(listing);
  });

  it("the nightly backup holds Work's rows", () => {
    const r = openLifeDb(file);
    if (!r.ok) throw new Error(r.code);
    r.db.prepare("INSERT INTO work_contacts (id, kind, state, name_key, updated_at, json) VALUES ('c1', 'company', 'client', 'acme', ?, '{}')").run(NOW);
    r.db.prepare("INSERT INTO work_deals (id, contact_id, stage, updated_at, json) VALUES ('d1', 'c1', 'new', ?, '{}')").run(NOW);
    r.db.prepare("INSERT INTO work_log (id, contact_id, at, kind, json) VALUES ('l1', 'c1', ?, 'call', '{}')").run(NOW);
    const b = writeBackup(r.db, join(dir, 'backups'), '2026-11-03');
    r.db.close();
    if (!b.ok) throw new Error(b.code);
    const copy = new DatabaseSync(join(dir, 'backups', b.file), { readOnly: true });
    try {
      for (const t of WORK_TABLES) expect(count(copy, t), t).toBe(1);
      expect(copy.prepare("SELECT value FROM meta WHERE key = 'schema'").get()).toEqual({ value: '5' });
    } finally {
      copy.close();
    }
  });
});

describe('the service: the pre-upgrade copy, and a restore brings Work back with the rest of Life', () => {
  let life: LifeService | undefined;
  afterEach(async () => {
    await life?.stop();
    life = undefined;
  });

  const start = async () => {
    const ctx = createTestContext({ home: dir, settings: SettingsSchema.parse({ life: { todos: true, work: true } }) });
    ctx.clock.set(NOW);
    const f = makeFakes(ctx);
    life = buildLifeService(ctx, { sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy, notifiers: f.notifiers }, LIFE_MODULE_BUILDERS, { macZone: 'UTC' });
    await life.start();
    return { ctx, life };
  };

  it('copies a schema-4 file to backups/life-pre-<version>.db before migrating it', async () => {
    schemaFour();
    const { ctx, life } = await start();
    expect(life.broken()).toBeNull();
    expect(life.status().schema).toBe(5);
    const name = preUpgradeName(ctx.version.daemon);
    expect(listBackups(ctx.paths.backupsDir).map((b) => b.name)).toContain(name);
    const copy = new DatabaseSync(join(ctx.paths.backupsDir, name), { readOnly: true });
    try {
      expect(copy.prepare("SELECT value FROM meta WHERE key = 'schema'").get()).toEqual({ value: '4' });
      expect(count(copy, 'todos')).toBe(3);
    } finally {
      copy.close();
    }
  });

  it("a restore puts Work's rows back with the rest of Life (they can't be restored apart)", async () => {
    const { ctx, life } = await start();
    const side = new DatabaseSync(ctx.paths.lifeDb);
    side.prepare("INSERT INTO work_contacts (id, kind, state, name_key, updated_at, json) VALUES ('c1', 'company', 'client', 'acme', ?, '{}')").run(NOW);
    side.close();
    life.todos.createTodo({ title: 'Synthetic todo' }, { kind: 'cli' });
    const b = await life.backup();
    if (!b.ok) throw new Error(b.reason);
    const after = new DatabaseSync(ctx.paths.lifeDb);
    after.prepare('DELETE FROM work_contacts').run();
    after.close();
    const r = await life.restore(b.value.file);
    expect(r.ok).toBe(true);
    const check = new DatabaseSync(ctx.paths.lifeDb, { readOnly: true });
    try {
      expect(count(check, 'work_contacts')).toBe(1);
      expect(count(check, 'todos')).toBe(1);
    } finally {
      check.close();
    }
  });
});
