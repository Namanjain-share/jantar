/**
 * life.db (life/db.ts): created 0600 in the 0700 state dir (LD4), migrated
 * in one transaction, and REFUSED, never reset, when it is not a database,
 * cut short, fails `quick_check`, has a newer schema or a migration fails
 * (LD1, unit part): `ok: false` with the fixed sentence, the file
 * byte-identical and nothing renamed or created beside it. A file a crash
 * left with its WAL still holding pages is not "cut short".
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIFE_BROKEN_REASON, LIFE_MIGRATIONS, LIFE_SCHEMA_VERSION, openLifeDb } from '../../src/life/db.js';
import type { LifeDb } from '../../src/contracts.js';

let dir: string;
let file: string;
const open: LifeDb[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-lifedb-')));
  chmodSync(dir, 0o700);
  file = join(dir, 'life.db');
});
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function openOk(path = file): LifeDb {
  const r = openLifeDb(path);
  if (!r.ok) throw new Error(`refused: ${r.code}`);
  open.push(r.db);
  return r.db;
}

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** A valid life.db with a little data in it, closed. */
function seeded(): void {
  const db = openOk();
  db.tx(() => {
    for (let i = 0; i < 200; i++) {
      db.prepare('INSERT INTO food (id, day, at, json) VALUES (?, ?, ?, ?)').run(`f${i}`, '2026-10-30', '2026-10-30T08:00:00.000Z', JSON.stringify({ n: i, pad: 'x'.repeat(200) }));
    }
  });
  db.close();
  open.splice(open.indexOf(db), 1);
}

/**
 * A crash copy: life.db and its -wal as they are while the database is
 * open after `write` (autocheckpoint off, so the WAL keeps every write
 * since the last checkpoint). No -shm: SQLite rebuilds it.
 */
function crashCopy(write: (db: LifeDb) => void): void {
  const src = join(dir, 'src.db');
  const db = openOk(src);
  db.raw.exec('PRAGMA wal_autocheckpoint = 0');
  write(db);
  copyFileSync(src, file);
  copyFileSync(`${src}-wal`, `${file}-wal`);
  db.close();
  open.splice(open.indexOf(db), 1);
  for (const f of readdirSync(dir)) if (f.startsWith('src.db')) rmSync(join(dir, f));
}

function addFood(db: LifeDb, from: number, n: number): void {
  db.tx(() => {
    for (let i = from; i < from + n; i++) {
      db.prepare('INSERT INTO food (id, day, at, json) VALUES (?, ?, ?, ?)').run(`f${i}`, '2026-10-30', '2026-10-30T08:00:00.000Z', JSON.stringify({ n: i, pad: 'x'.repeat(200) }));
    }
  });
}

/** The newest copy of page `pgno` in a WAL file. */
function walPage(wal: Buffer, pgno: number): Buffer {
  const pageSize = wal.readUInt32BE(8);
  let found: Buffer | undefined;
  for (let at = 32; at + 24 + pageSize <= wal.length; at += 24 + pageSize) {
    if (wal.readUInt32BE(at) === pgno) found = wal.subarray(at + 24, at + 24 + pageSize);
  }
  if (!found) throw new Error(`page ${pgno} is not in the WAL`);
  return found;
}

/** Open must refuse `path` and leave it, and the folder around it, exactly as they were. */
function expectRefusedUntouched(code: string): void {
  const before = sha(file);
  const listing = readdirSync(dir).sort();
  const r = openLifeDb(file);
  expect(r).toEqual({ ok: false, code, reason: LIFE_BROKEN_REASON });
  expect(sha(file)).toBe(before);
  expect(readdirSync(dir).sort()).toEqual(listing);
}

describe('openLifeDb', () => {
  it('LD4: creates life.db 0600 inside the 0700 state dir, with every table', () => {
    const db = openOk();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(['bills', 'budgets', 'doses', 'food', 'foods_saved', 'medicines', 'meta', 'money', 'pings', 'places', 'projects', 'todos', 'weights']);
    expect(db.meta('schema')).toBe(String(LIFE_SCHEMA_VERSION));
    expect(LIFE_SCHEMA_VERSION).toBe(LIFE_MIGRATIONS.length);
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777, f).toBe(0o600);
  });

  it('opens an existing file again with its data, and migrates nothing twice', () => {
    seeded();
    const db = openOk();
    expect((db.prepare('SELECT count(*) AS n FROM food').get() as { n: number }).n).toBe(200);
    expect(db.meta('schema')).toBe('1');
  });

  it('keeps the unique dose slot and the weight range in the schema', () => {
    const db = openOk();
    const dose = db.prepare('INSERT INTO doses (id, med_id, day, slot, status, at) VALUES (?, ?, ?, ?, ?, ?)');
    dose.run('d1', 'm1', '2026-10-30', '08:00', 'taken', '2026-10-30T08:05:00.000Z');
    expect(() => dose.run('d2', 'm1', '2026-10-30', '08:00', 'skipped', '2026-10-30T08:06:00.000Z')).toThrow(/UNIQUE/);
    expect(() => dose.run('d3', 'm1', '2026-10-30', '09:00', 'missed', '2026-10-30T09:00:00.000Z')).toThrow(/CHECK/);
    expect(() => db.prepare('INSERT INTO weights (day, kg10, at) VALUES (?, ?, ?)').run('2026-10-30', 50, 'x')).toThrow(/CHECK/);
  });

  it('tx commits, rolls back on a throw, and joins an outer one', () => {
    const db = openOk();
    const add = (id: string) => db.prepare('INSERT INTO budgets (category, amount) VALUES (?, 1)').run(id);
    db.tx(() => add('a'));
    expect(() =>
      db.tx(() => {
        add('b');
        db.tx(() => add('c'));
        throw new Error('nope');
      }),
    ).toThrow('nope');
    expect((db.prepare('SELECT category FROM budgets ORDER BY category').all() as { category: string }[]).map((r) => r.category)).toEqual(['a']);
  });

  it('meta set, get and delete', () => {
    const db = openOk();
    db.setMeta('kcal_target', '1800');
    db.setMeta('kcal_target', '1900');
    expect(db.meta('kcal_target')).toBe('1900');
    db.deleteMeta('kcal_target');
    expect(db.meta('kcal_target')).toBeUndefined();
  });

  it('opens an in-memory database for tests', () => {
    const r = openLifeDb(':memory:');
    expect(r.ok).toBe(true);
    if (r.ok) r.db.close();
  });
});

describe('LD1: refuse on corruption, never reset', () => {
  it('4 KB of random bytes', () => {
    writeFileSync(file, randomBytes(4096), { mode: 0o600 });
    expectRefusedUntouched('not_sqlite');
  });

  it('a valid file cut at half its size', () => {
    seeded();
    const bytes = readFileSync(file);
    writeFileSync(file, bytes.subarray(0, Math.floor(bytes.length / 2)));
    expectRefusedUntouched('truncated');
  });

  it("a valid file with one page's bytes overwritten (quick_check fails)", () => {
    seeded();
    const bytes = readFileSync(file);
    const pageSize = bytes.readUInt16BE(16);
    // Every page past the first that holds rows: scribble over its b-tree header and cell pointers.
    for (let page = 2; page * pageSize <= bytes.length; page++) {
      const at = (page - 1) * pageSize;
      if (bytes[at] === 0x0d) {
        bytes.fill(0xa5, at + 1, at + 64);
        break;
      }
    }
    writeFileSync(file, bytes);
    expectRefusedUntouched('corrupt');
  });

  it('a database whose migration fails: rolled back, the file left as it was (never switched to WAL)', () => {
    // A rollback-journal database with a table migration 1 creates: CREATE TABLE fails mid-migration.
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE projects (x)');
    raw.close();
    expect(readFileSync(file)[18]).toBe(1);
    expectRefusedUntouched('migration_failed');
  });

  it('a corrupt file with a WAL beside it: neither is checkpointed into nor removed', () => {
    crashCopy((db) => {
      addFood(db, 0, 200);
      db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.setMeta('kcal_target', '1800');
    });
    const bytes = readFileSync(file);
    const pageSize = bytes.readUInt16BE(16);
    // The last table leaf in the file holds food rows; the WAL only has the meta write.
    let leaf = -1;
    for (let page = 2; page * pageSize <= bytes.length; page++) if (bytes[(page - 1) * pageSize] === 0x0d) leaf = page;
    bytes.fill(0xa5, (leaf - 1) * pageSize + 1, (leaf - 1) * pageSize + 64);
    writeFileSync(file, bytes);
    const wal = sha(`${file}-wal`);
    expectRefusedUntouched('corrupt');
    expect(existsSync(`${file}-wal`)).toBe(true);
    expect(sha(`${file}-wal`)).toBe(wal);
  });

  it('no state dir: refused as open_failed, nothing created', () => {
    const r = openLifeDb(join(dir, 'missing', 'life.db'));
    expect(r).toEqual({ ok: false, code: 'open_failed', reason: LIFE_BROKEN_REASON });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a file shorter than its header says, with the WAL that completes it, opens with every row', () => {
    // A crash after a checkpoint wrote page 1 (with the new page count) but before the file grew.
    crashCopy((db) => {
      addFood(db, 0, 20);
      db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      addFood(db, 20, 300);
    });
    const page1 = walPage(readFileSync(`${file}-wal`), 1);
    const bytes = readFileSync(file);
    page1.copy(bytes, 0);
    writeFileSync(file, bytes);
    const pageSize = bytes.readUInt16BE(16);
    expect(bytes.length).toBeLessThan(bytes.readUInt32BE(28) * pageSize);
    const db = openOk();
    expect((db.prepare('SELECT count(*) AS n FROM food').get() as { n: number }).n).toBe(320);
    expect(Object.values(db.raw.prepare('PRAGMA quick_check').get() as object)[0]).toBe('ok');
  });

  it('a file whose schema is newer than this build', () => {
    const db = openOk();
    db.setMeta('schema', '99');
    db.close();
    open.splice(open.indexOf(db), 1);
    expectRefusedUntouched('newer_schema');
  });
});

describe('createTestLifeCore (core/testing.ts)', () => {
  it('gives modules a migrated in-memory life.db, a recording scheduler and a changed counter', async () => {
    const { createTestLifeCore } = await import('../../src/core/testing.js');
    const core = createTestLifeCore({ tz: 'Asia/Kolkata', settings: { medicines: true } });
    try {
      core.clock.set('2026-10-30T20:00:00.000Z');
      expect(core.today()).toBe('2026-10-31');
      expect(core.db.meta('schema')).toBe('1');
      expect(core.settings().medicines).toBe(true);
      expect(core.newId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      core.scheduler.set('med', 'm1', '08:00', new Date('2026-10-31T02:30:00.000Z'));
      core.scheduler.set('refill', 'm1', '', null);
      core.scheduler.clear('refill', 'm1');
      expect(core.scheduler.row('med', 'm1', '08:00')?.nextAt).toBe('2026-10-31T02:30:00.000Z');
      expect(core.scheduler.list().map((r) => r.kind)).toEqual(['med']);
      core.changed();
      expect(core.changedCount).toBe(1);
      core.setSettings({ timezone: 'UTC' });
      expect(core.tz()).toBe('UTC');
      expect(core.today()).toBe('2026-10-30');
      // A zone this runtime does not know (a config from a newer Node): the core's own zone.
      core.setSettings({ timezone: 'Mars/Olympus' });
      expect(core.tz()).toBe('Asia/Kolkata');
      expect(await core.pushes.send({ kind: 'med', title: 'Medicine due', body: '', url: '/today', tag: 'med:08:00' })).toEqual({ delivered: 1, failed: 0 });
      expect(core.pushes.pushes).toHaveLength(1);
    } finally {
      core.close();
    }
  });
});
