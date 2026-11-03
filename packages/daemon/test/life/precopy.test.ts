/**
 * v0.10 (spec 0.10 A2.2): the daemon copies life.db before it moves to a
 * newer schema, so a downgrade has a way back without a step by hand.
 *
 * - openLifeDb's `preMigrateCopy` writes the copy on the read-only check
 *   connection, before anything migrates: it is at the old schema, holds
 *   rows only the WAL held, is 0600 in a 0700 folder, and is never written
 *   for a fresh file, one already current, or `:memory:`; one already there
 *   is kept as it is.
 * - A copy that fails refuses the open (`precopy_failed`), the file still
 *   at its old schema with every row, no `.tmp` left behind; a stale `.tmp`
 *   from an interrupted copy is replaced.
 * - LifeService names it life-pre-<version>.db (a valid restore name),
 *   logs `life.precopy` with the file name only, shows it in status, and
 *   restoring it migrates the staged copy without writing a second one.
 */
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LifeBackupNameSchema, SettingsSchema } from '@jantar/protocol';
import type { LifeDb, LifeModule, LifeModuleBuilders, LifeService } from '../../src/contracts.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { createTestContext, type TestContext } from '../../src/core/testing.js';
import { listBackups, preUpgradeName } from '../../src/life/backup.js';
import { LIFE_BROKEN_REASON, LIFE_MIGRATIONS, LIFE_SCHEMA_VERSION, openCheckedDb, openLifeDb } from '../../src/life/db.js';
import { buildLifeService } from '../../src/life/service.js';
import { buildTodosModule } from '../../src/life/todos/module.js';
import { makeFakes } from '../api/fakes.js';

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const mode = (p: string) => statSync(p).mode & 0o777;
const TODO_ID = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';

let dir: string;
let file: string;
let backups: string;
let target: string;
const open: LifeDb[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-precopy-')));
  chmodSync(dir, 0o700);
  file = join(dir, 'life.db');
  backups = join(dir, 'backups');
  target = join(backups, 'life-pre-0.10.0.db');
});
afterEach(async () => {
  await svc?.stop();
  svc = undefined;
  for (const db of open.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function keep(db: LifeDb): LifeDb {
  open.push(db);
  return db;
}

function addTodo(db: LifeDb, title: string, id = TODO_ID): void {
  db.prepare('INSERT INTO todos (id, project_id, due_day, done_at, updated_at, json) VALUES (?, NULL, NULL, NULL, ?, ?)').run(
    id,
    '2026-11-01T10:00:00.000Z',
    JSON.stringify({ id, title, priority: 'normal', createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' }),
  );
}

/** life.db as 0.9.0 left it (schema 2, WAL mode) with one todo, closed. */
function schemaTwoFile(path = file): void {
  const r = openCheckedDb(path, { migrations: LIFE_MIGRATIONS.slice(0, 2), brokenReason: LIFE_BROKEN_REASON });
  if (!r.ok) throw new Error(`refused: ${r.code}`);
  addTodo(r.db, 'Example todo');
  r.db.setMeta('kcal_target', '1800');
  r.db.close();
}

/** Read a closed database file: its schema and its todo titles. */
function look(path: string): { schema: string; titles: string[]; tables: string[] } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      schema: (db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string }).value,
      titles: (db.prepare('SELECT json FROM todos ORDER BY id').all() as { json: string }[]).map((r) => (JSON.parse(r.json) as { title: string }).title),
      tables: (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name),
    };
  } finally {
    db.close();
  }
}

describe('openLifeDb with preMigrateCopy', () => {
  it('copies a schema-2 file before migrating it: the copy is at 2 with every row, life.db moves to the current schema', () => {
    schemaTwoFile();
    const asked: [number, number][] = [];
    const r = openLifeDb(file, {
      preMigrateCopy: (from, to) => {
        asked.push([from, to]);
        return target;
      },
    });
    if (!r.ok) throw new Error(r.code);
    keep(r.db);
    expect(asked).toEqual([[2, LIFE_SCHEMA_VERSION]]);
    expect(r.precopy).toEqual({ from: 2, to: LIFE_SCHEMA_VERSION, file: 'life-pre-0.10.0.db' });
    expect(r.db.meta('schema')).toBe(String(LIFE_SCHEMA_VERSION));
    const copy = look(target);
    expect(copy.schema).toBe('2');
    expect(copy.titles).toEqual(['Example todo']);
    expect(copy.tables).not.toContain('place_visits');
    expect(Object.values(new DatabaseSync(target, { readOnly: true }).prepare('PRAGMA quick_check').get() as object)[0]).toBe('ok');
    expect(readdirSync(backups)).toEqual(['life-pre-0.10.0.db']);
  });

  it('the copy is 0600 in a 0700 folder, and its name is one jantar life restore takes', () => {
    schemaTwoFile();
    const r = openLifeDb(file, { preMigrateCopy: () => target });
    if (!r.ok) throw new Error(r.code);
    keep(r.db);
    expect(mode(target)).toBe(0o600);
    expect(mode(backups)).toBe(0o700);
    expect(LifeBackupNameSchema.safeParse('life-pre-0.10.0.db').success).toBe(true);
    expect(LifeBackupNameSchema.safeParse(preUpgradeName('0.10.0')).success).toBe(true);
    expect(preUpgradeName('0.10.0')).toBe('life-pre-0.10.0.db');
  });

  it('holds rows that were only in the WAL when the daemon stopped', () => {
    // A crash copy: life.db and its -wal while 0.9.0 still had it open, autocheckpoint off.
    const src = join(dir, 'src.db');
    const r = openCheckedDb(src, { migrations: LIFE_MIGRATIONS.slice(0, 2), brokenReason: LIFE_BROKEN_REASON });
    if (!r.ok) throw new Error(r.code);
    r.db.raw.exec('PRAGMA wal_autocheckpoint = 0');
    addTodo(r.db, 'Only in the WAL');
    copyFileSync(src, file);
    copyFileSync(`${src}-wal`, `${file}-wal`);
    r.db.close();
    for (const f of readdirSync(dir)) if (f.startsWith('src.db')) rmSync(join(dir, f));
    expect(statSync(`${file}-wal`).size).toBeGreaterThan(0);

    const opened = openLifeDb(file, { preMigrateCopy: () => target });
    if (!opened.ok) throw new Error(opened.code);
    keep(opened.db);
    expect(look(target)).toMatchObject({ schema: '2', titles: ['Only in the WAL'] });
    expect(existsSync(`${target}-wal`)).toBe(false);
  });

  it('is not written for a fresh file, a file already at the current schema, or :memory:', () => {
    let calls = 0;
    const copy = () => {
      calls += 1;
      return target;
    };
    const fresh = openLifeDb(file, { preMigrateCopy: copy });
    if (!fresh.ok) throw new Error(fresh.code);
    expect(fresh.precopy).toBeUndefined();
    fresh.db.close();
    const current = openLifeDb(file, { preMigrateCopy: copy });
    if (!current.ok) throw new Error(current.code);
    expect(current.precopy).toBeUndefined();
    current.db.close();
    const memory = openLifeDb(':memory:', { preMigrateCopy: copy });
    if (!memory.ok) throw new Error(memory.code);
    memory.db.close();
    expect(calls).toBe(0);
    expect(existsSync(backups)).toBe(false);
  });

  it('a copy already there (an earlier open whose migration then failed) is kept, never overwritten', () => {
    schemaTwoFile();
    mkdirSync(backups, { mode: 0o700 });
    schemaTwoFile(target);
    for (const s of ['-wal', '-shm']) rmSync(target + s, { force: true });
    const db = new DatabaseSync(target);
    db.exec("UPDATE todos SET json = json_set(json, '$.title', 'The first copy')");
    db.close();
    const before = sha(target);
    const r = openLifeDb(file, { preMigrateCopy: () => target });
    if (!r.ok) throw new Error(r.code);
    keep(r.db);
    expect(r.precopy).toBeUndefined();
    expect(r.db.meta('schema')).toBe(String(LIFE_SCHEMA_VERSION));
    expect(sha(target)).toBe(before);
    expect(look(target).titles).toEqual(['The first copy']);
  });

  it('a copy that fails refuses the open (precopy_failed): life.db stays at 2 with its rows, no .tmp is left', () => {
    schemaTwoFile();
    // The backups folder cannot be made: a plain file has its name.
    writeFileSync(backups, 'not a folder');
    const before = sha(file);
    const listing = readdirSync(dir).sort();
    expect(openLifeDb(file, { preMigrateCopy: () => target })).toEqual({ ok: false, code: 'precopy_failed', reason: LIFE_BROKEN_REASON });
    expect(sha(file)).toBe(before);
    expect(readdirSync(dir).sort()).toEqual(listing);
    expect(look(file)).toMatchObject({ schema: '2', titles: ['Example todo'] });
  });

  it('a .tmp an interrupted copy left behind is replaced, and none is left', () => {
    schemaTwoFile();
    mkdirSync(backups, { mode: 0o700 });
    writeFileSync(`${target}.tmp`, 'half a copy', { mode: 0o600 });
    const r = openLifeDb(file, { preMigrateCopy: () => target });
    if (!r.ok) throw new Error(r.code);
    keep(r.db);
    expect(readdirSync(backups)).toEqual(['life-pre-0.10.0.db']);
    expect(look(target).schema).toBe('2');
  });

  it('a hook that throws refuses as precopy_failed; one that answers null migrates with no copy', () => {
    schemaTwoFile();
    expect(
      openLifeDb(file, {
        preMigrateCopy: () => {
          throw new Error('bug');
        },
      }),
    ).toMatchObject({ ok: false, code: 'precopy_failed' });
    expect(look(file).schema).toBe('2');
    const r = openLifeDb(file, { preMigrateCopy: () => null });
    if (!r.ok) throw new Error(r.code);
    keep(r.db);
    expect(r.precopy).toBeUndefined();
    expect(r.db.meta('schema')).toBe(String(LIFE_SCHEMA_VERSION));
    expect(existsSync(backups)).toBe(false);
  });
});

let ctx: TestContext;
let svc: LifeService | undefined;

function builders(): LifeModuleBuilders {
  const stub = (name: string) => () => notBuilt<LifeModule>(name, { name, today: () => ({}), start: undefined, stop: undefined } as unknown as Partial<LifeModule>);
  return {
    todos: buildTodosModule,
    medicines: stub('medicines'),
    food: stub('food'),
    places: stub('places'),
    finance: stub('finance'),
    posts: stub('posts'),
    work: stub('work'),
  } as unknown as LifeModuleBuilders;
}

function service(): LifeService {
  ctx = createTestContext({ home: dir, settings: SettingsSchema.parse({ life: { todos: true } }) });
  ctx.clock.set('2026-11-02T09:00:00.000Z');
  const f = makeFakes(ctx);
  svc = buildLifeService(ctx, { sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy, notifiers: f.notifiers }, builders(), {
    macZone: 'UTC',
    send: async () => ({ delivered: 0, failed: 0 }),
  });
  return svc;
}

describe('LifeService: life-pre-<version>.db', () => {
  it('is written at start before the upgrade, logged by name only, and shown in status with the schema', async () => {
    schemaTwoFile();
    const life = service();
    const name = preUpgradeName(ctx.version.daemon);
    await life.start();
    expect(life.broken()).toBeNull();
    expect(listBackups(backups).map((b) => b.name)).toEqual([name]);
    expect(look(join(backups, name))).toMatchObject({ schema: '2', titles: ['Example todo'] });
    const st = life.status();
    expect(st.schema).toBe(LIFE_SCHEMA_VERSION);
    expect(st.preUpgrade).toBe(name);
    const logged = ctx.log.records.filter((r) => r.fields?.['event'] === 'life.precopy');
    expect(logged.map((r) => r.fields)).toEqual([expect.objectContaining({ event: 'life.precopy', from: 2, to: LIFE_SCHEMA_VERSION, file: name })]);
    expect(JSON.stringify(ctx.log.records)).not.toContain(dir);
    expect(JSON.stringify(ctx.log.records)).not.toContain('Example todo');
  });

  it('a copy that fails leaves Life broken with the usual sentence, life.db at 2', async () => {
    schemaTwoFile();
    writeFileSync(backups, 'not a folder');
    const life = service();
    await life.start();
    expect(life.broken()).toBe(LIFE_BROKEN_REASON);
    expect(ctx.log.records.some((r) => r.fields?.['event'] === 'life.broken' && r.fields?.['code'] === 'precopy_failed')).toBe(true);
    expect(look(file).schema).toBe('2');
  });

  it('restoring the copy on this build migrates the staged file and writes no second copy', async () => {
    schemaTwoFile();
    const life = service();
    const name = preUpgradeName(ctx.version.daemon);
    await life.start();
    const before = sha(join(backups, name));
    life.todos.createTodo({ title: 'After the upgrade' }, { kind: 'cli' });
    const r = await life.restore(name);
    expect(r.ok).toBe(true);
    expect(life.broken()).toBeNull();
    const now = look(file);
    expect(now.schema).toBe(String(LIFE_SCHEMA_VERSION));
    expect(now.titles).toEqual(['Example todo']);
    expect(now.tables).toContain('place_visits');
    expect(listBackups(backups).filter((b) => b.name.startsWith('life-pre-')).map((b) => b.name)).toEqual([name]);
    expect(readdirSync(backups).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    // The copy itself is left as it was, for another way back.
    expect(sha(join(backups, name))).toBe(before);
    expect(ctx.log.records.filter((r) => r.fields?.['event'] === 'life.precopy')).toHaveLength(1);
  });
});
