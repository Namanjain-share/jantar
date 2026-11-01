/**
 * life.db backups and restore (life/backup.ts, LifeService.backup and
 * restore), on a temp state dir:
 *
 * - LD3: backups are 0600 in a 0700 folder; the 31st deletes only the
 *   oldest life-*.db and no other file; a restore keeps the previous file
 *   (and its -wal and -shm) as life.db.before-restore-*, and refuses a name
 *   with a separator, a name outside the pattern, a symlink, a folder and a
 *   file failing quick_check, leaving life.db as it was;
 * - restore while broken is the way out; after a restore every ring is
 *   rebuilt from the restored data and life.changed goes out; a Life that
 *   still cannot start answers so, and a later break pushes its notice
 *   again; backup while a module failed to start says that, not that
 *   life.db would not open;
 * - status lists the backups again only when the folder changed;
 * - the nightly timer runs at 03:30 in the Life zone, and at start when the
 *   newest backup is older than a day; a failure pushes "Life backup
 *   failed" once per day;
 * - lifeBackup and lifeRestore through ctl.sock.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIFE_BACKUP_KEEP, SettingsSchema, type Settings } from '@jantar/protocol';
import type { Clock, LifeModule, LifeModuleBuilders, LifePush, LifeService } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { createTestContext, type TestContext } from '../../src/core/testing.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { BACKUP_CHECK_MS, BACKUP_STALE_MS, BackupTimer, RESTORE_REFUSED, backupSummary, listBackups, nextBackupAt, pruneBackups, writeBackup } from '../../src/life/backup.js';
import { LIFE_BROKEN_REASON, LIFE_MIGRATIONS, openCheckedDb, openLifeDb } from '../../src/life/db.js';
import { BACKUP_REASONS, LIFE_START_FAILED, RESTORE_REASONS, buildLifeService } from '../../src/life/service.js';
import { buildTodosModule } from '../../src/life/todos/module.js';
import { makeApi, makeFakes, type TestApi } from '../api/fakes.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const mode = (p: string) => statSync(p).mode & 0o777;
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

let dir: string;
let backups: string;
let ctx: TestContext;
let svc: LifeService | undefined;
let pushes: LifePush[];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'jantar-life-backup-')));
  chmodSync(dir, 0o700);
  backups = join(dir, 'backups');
  pushes = [];
});
afterEach(async () => {
  await svc?.stop();
  svc = undefined;
  await rm(dir, { recursive: true, force: true });
});

function builders(over: Partial<LifeModuleBuilders> = {}): LifeModuleBuilders {
  const stub = (name: string) => () => notBuilt<LifeModule>(name, { name, today: () => ({}), start: undefined, stop: undefined } as unknown as Partial<LifeModule>);
  return {
    todos: buildTodosModule,
    medicines: stub('medicines'),
    food: stub('food'),
    places: stub('places'),
    finance: stub('finance'),
    posts: stub('posts'),
    ...over,
  } as unknown as LifeModuleBuilders;
}

/** A medicines builder that always throws (Life broken with LIFE_START_FAILED). */
const throwing = builders({
  medicines: () => {
    throw new Error('builder bug');
  },
});

function service(opts: { settings?: Settings; at?: string; tz?: string; builders?: LifeModuleBuilders } = {}): LifeService {
  ctx = createTestContext({ home: dir, settings: opts.settings ?? SettingsSchema.parse({ life: { todos: true } }) });
  ctx.clock.set(opts.at ?? '2026-10-30T09:00:00.000Z');
  const f = makeFakes(ctx);
  svc = buildLifeService(ctx, { sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy, notifiers: f.notifiers }, opts.builders ?? builders(), {
    macZone: opts.tz ?? 'UTC',
    send: async (p) => {
      pushes.push(p);
      return { delivered: 1, failed: 0 };
    },
  });
  return svc;
}

/** Set the backups folder's mtime (and atime) to `ms`, the way a filesystem would stamp a change then. */
function folderTimeAt(ms: number): void {
  utimesSync(backups, ms / 1000, ms / 1000);
}

/** A backup file the way the service writes one, with `todo` titles in it and its mtime set. */
function seedBackup(name: string, titles: string[], mtimeMs: number): string {
  const tmp = join(dir, `seed-${name}`);
  const r = openLifeDb(tmp);
  if (!r.ok) throw new Error(r.code);
  for (const title of titles) {
    const id = `01JFZ8X8Y3T0V5G9WQK2M4N6${String(titles.indexOf(title)).padStart(2, '0')}`.slice(0, 26);
    r.db.prepare('INSERT INTO todos (id, updated_at, json) VALUES (?, ?, ?)').run(id, 'x', JSON.stringify({ id, title, priority: 'normal', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }));
  }
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  const out = join(backups, name);
  r.db.prepare('VACUUM INTO ?').run(out);
  r.db.close();
  for (const s of ['', '-wal', '-shm']) rmSync(tmp + s, { force: true });
  utimesSync(out, mtimeMs / 1000, mtimeMs / 1000);
  return out;
}

/** An empty life.db in place, as on a Mac that has used Life (with backups and no life.db, Life refuses to start). */
function lifeDbThere(): void {
  const r = openLifeDb(join(dir, 'life.db'));
  if (!r.ok) throw new Error(r.code);
  r.db.close();
}

/** Titles of the todos in the open life.db, read beside the service. */
function titles(): string[] {
  const db = new DatabaseSync(join(dir, 'life.db'), { readOnly: true });
  try {
    return (db.prepare('SELECT json FROM todos').all() as { json: string }[]).map((r) => (JSON.parse(r.json) as { title: string }).title).sort();
  } finally {
    db.close();
  }
}

describe('LD3: backups', () => {
  it('a backup is 0600 in a 0700 folder, named by the day in the Life zone; the same day replaces it; no .tmp is left', async () => {
    const life = service({ at: '2026-10-30T20:00:00.000Z', tz: 'Asia/Kolkata' }); // 01:30 on the 31st in Kolkata
    await life.start();
    life.todos.createTodo({ title: 'Example todo' }, { kind: 'cli' });
    const r = await life.backup();
    expect(r).toEqual({ ok: true, value: { file: 'life-2026-10-31.db', at: '2026-10-30T20:00:00.000Z' } });
    expect(mode(backups)).toBe(0o700);
    expect(mode(join(backups, 'life-2026-10-31.db'))).toBe(0o600);
    expect(readdirSync(backups).sort()).toEqual(['life-2026-10-31.db']);
    life.todos.createTodo({ title: 'Second todo' }, { kind: 'cli' });
    await life.backup();
    expect(readdirSync(backups).sort()).toEqual(['life-2026-10-31.db']);
    const copy = new DatabaseSync(join(backups, 'life-2026-10-31.db'), { readOnly: true });
    expect((copy.prepare('SELECT COUNT(*) AS n FROM todos').get() as { n: number }).n).toBe(2);
    expect(Object.values(copy.prepare('PRAGMA quick_check').get() as object)[0]).toBe('ok');
    copy.close();
  });

  it('an existing folder is tightened to 0700', async () => {
    mkdirSync(backups, { mode: 0o755 });
    chmodSync(backups, 0o755);
    const life = service();
    await life.start();
    await life.backup();
    expect(mode(backups)).toBe(0o700);
  });

  it('the 31st deletes only the oldest life-*.db, and no other file', async () => {
    const now = Date.parse('2026-10-30T09:00:00.000Z');
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    for (let i = 1; i <= LIFE_BACKUP_KEEP; i++) {
      const day = new Date(now - (LIFE_BACKUP_KEEP + 1 - i) * DAY).toISOString().slice(0, 10);
      const p = join(backups, `life-${day}.db`);
      writeFileSync(p, `backup ${i}`, { mode: 0o600 });
      utimesSync(p, (now - (LIFE_BACKUP_KEEP + 1 - i) * DAY) / 1000, (now - (LIFE_BACKUP_KEEP + 1 - i) * DAY) / 1000);
    }
    const old = 1000;
    for (const other of ['notes.txt', 'life-2026-01-01.db.keep', 'life.db', 'something.db']) {
      writeFileSync(join(backups, other), 'not a backup');
      utimesSync(join(backups, other), old, old);
    }
    writeFileSync(join(dir, 'elsewhere.db'), 'not ours');
    symlinkSync(join(dir, 'elsewhere.db'), join(backups, 'life-0000-link.db'));
    mkdirSync(join(backups, 'life-folder.db'));
    const oldest = listBackups(backups).at(-1)?.name;
    expect(oldest).toBe('life-2026-09-30.db');

    lifeDbThere();
    const life = service();
    await life.start();
    const r = await life.backup();
    expect(r.ok).toBe(true);
    const left = readdirSync(backups).sort();
    expect(left).not.toContain(oldest);
    expect(listBackups(backups)).toHaveLength(LIFE_BACKUP_KEEP);
    for (const other of ['notes.txt', 'life-2026-01-01.db.keep', 'life.db', 'something.db', 'life-0000-link.db', 'life-folder.db']) expect(left).toContain(other);
    expect(existsSync(join(dir, 'elsewhere.db'))).toBe(true);
    expect(pruneBackups(backups)).toEqual([]);
  });

  it('the summary: the newest backup time and the count', () => {
    expect(backupSummary(backups)).toEqual({ last: null, count: 0 });
    seedBackup('life-2026-10-01.db', [], Date.parse('2026-10-01T03:30:00.000Z'));
    seedBackup('life-2026-10-02.db', [], Date.parse('2026-10-02T03:30:00.000Z'));
    expect(backupSummary(backups)).toEqual({ last: '2026-10-02T03:30:00.000Z', count: 2 });
  });

  it('refused while Life is off or broken: nothing to copy', async () => {
    const off = service({ settings: SettingsSchema.parse({}) });
    await off.start();
    expect(await off.backup()).toEqual({ ok: false, code: 'unavailable', reason: BACKUP_REASONS.closed });
    await off.stop();
    writeFileSync(join(dir, 'life.db'), 'garbage '.repeat(600));
    const broken = service();
    await broken.start();
    expect(await broken.backup()).toEqual({ ok: false, code: 'unavailable', reason: BACKUP_REASONS.broken });
    await broken.stop();
    // A module that fails to start leaves life.db fine: the sentence says which.
    rmSync(join(dir, 'life.db'));
    const notStarted = service({ builders: throwing });
    await notStarted.start();
    expect(notStarted.broken()).toBe(LIFE_START_FAILED);
    expect(await notStarted.backup()).toEqual({ ok: false, code: 'unavailable', reason: BACKUP_REASONS.notStarted });
  });

  it('status lists the backups again only when the folder changed', async () => {
    const life = service();
    await life.start();
    await ctx.clock.tick(0); // the start backup (there was none)
    expect(life.status().backups.count).toBe(1);
    seedBackup('life-2026-10-01.db', [], Date.parse('2026-10-01T03:30:00.000Z'));
    expect(life.status().backups.count).toBe(2);
    rmSync(join(backups, 'life-2026-10-01.db'));
    expect(life.status().backups).toEqual({ last: expect.any(String), count: 1 });
    // Unchanged since well before the last listing, the folder is not listed again: a listing now would find nothing.
    folderTimeAt(Date.now() - MIN);
    expect(life.status().backups.count).toBe(1);
    chmodSync(backups, 0o300);
    try {
      expect(life.status().backups.count).toBe(1);
    } finally {
      chmodSync(backups, 0o700);
    }
  });

  it('status sees a change the folder time missed: a create and a delete in one tick of a coarse clock', async () => {
    const life = service();
    await life.start();
    await ctx.clock.tick(0);
    expect(life.status().backups.count).toBe(1);
    // Linux stamps a folder from a coarse clock, and some filesystems keep whole seconds: a file made and
    // removed within one step leaves the folder's mtime where it was. Here that time is put back by hand.
    const tick = Date.now();
    seedBackup('life-2026-10-01.db', [], Date.parse('2026-10-01T03:30:00.000Z'));
    folderTimeAt(tick);
    expect(life.status().backups.count).toBe(2);
    rmSync(join(backups, 'life-2026-10-01.db'));
    folderTimeAt(tick);
    expect(life.status().backups).toEqual({ last: expect.any(String), count: 1 });
  });

  it('a failure to write answers a fixed sentence and logs a code', async () => {
    writeFileSync(backups, 'a file where the folder should be');
    const life = service();
    await life.start();
    expect(await life.backup()).toEqual({ ok: false, code: 'unavailable', reason: BACKUP_REASONS.failed });
    expect(ctx.log.records.some((r) => r.fields.event === 'life.backup' && r.fields.code === 'dir_failed')).toBe(true);
  });

  it('writeBackup leaves nothing half-written when the copy fails', () => {
    const r = openLifeDb(':memory:');
    if (!r.ok) throw new Error(r.code);
    r.db.close();
    expect(writeBackup(r.db, backups, '2026-10-30')).toEqual({ ok: false, code: 'vacuum_failed' });
    expect(readdirSync(backups)).toEqual([]);
  });
});

describe('LD3: restore', () => {
  it('puts a backup back and keeps the previous file beside it; the rings are rebuilt; life.changed goes out', async () => {
    const life = service();
    await life.start();
    life.todos.createTodo({ title: 'Before the backup', due: { day: '2026-10-30', time: '23:00' } }, { kind: 'cli' });
    const b = await life.backup();
    if (!b.ok) throw new Error(b.reason);
    life.todos.createTodo({ title: 'After the backup' }, { kind: 'cli' });
    expect(titles()).toEqual(['After the backup', 'Before the backup']);
    const seq = ctx.store.seq;
    ctx.clock.advance(MIN);
    const r = await life.restore(b.value.file);
    expect(r).toEqual({ ok: true, value: { kept: 'life.db.before-restore-2026-10-30T09-01-00-000Z' } });
    expect(titles()).toEqual(['Before the backup']);
    expect(mode(join(dir, 'life.db'))).toBe(0o600);
    // The kept file holds what was there before.
    const kept = new DatabaseSync(join(dir, 'life.db.before-restore-2026-10-30T09-01-00-000Z'), { readOnly: true });
    expect((kept.prepare('SELECT COUNT(*) AS n FROM todos').get() as { n: number }).n).toBe(2);
    kept.close();
    expect(readdirSync(dir).filter((n) => n.includes('restoring'))).toEqual([]);
    // The module reads the new handle; its ring is set from the restored data.
    const list = life.todos.listTodos({ done: false });
    expect(list.ok && list.value.todos.map((t) => t.title)).toEqual(['Before the backup']);
    const replay = ctx.store.replay(seq);
    expect(replay.kind === 'events' && replay.events.some((e) => e.type === 'life.changed')).toBe(true);
    for (let i = 0; i < 14 * 60; i++) await ctx.clock.tick(MIN);
    expect(pushes.filter((p) => p.title === 'Todo due').map((p) => p.body)).toEqual(['Before the backup · 23:00']);
  });

  it('never catches up a ring that came due between the backup and the restore', async () => {
    const life = service();
    await life.start();
    life.todos.createTodo({ title: 'Call at ten', due: { day: '2026-10-30', time: '10:00' } }, { kind: 'cli' });
    life.todos.createTodo({ title: 'Call at six', due: { day: '2026-10-30', time: '18:00' } }, { kind: 'cli' });
    const b = await life.backup();
    if (!b.ok) throw new Error(b.reason);
    for (let i = 0; i < 5 * 60; i++) await ctx.clock.tick(MIN); // 14:00
    expect(pushes.filter((p) => p.title === 'Todo due').map((p) => p.body)).toEqual(['Call at ten · 10:00']);
    const r = await life.restore(b.value.file);
    expect(r.ok).toBe(true);
    for (let i = 0; i < 5 * 60; i++) await ctx.clock.tick(MIN); // 19:00
    // The 10:00 ring is not repeated as a late one; the 18:00 ring, still ahead at the restore, goes out.
    expect(pushes.filter((p) => p.title === 'Todo due').map((p) => p.body)).toEqual(['Call at ten · 10:00', 'Call at six · 18:00']);
    expect(pushes.some((p) => /Missed/.test(`${p.title} ${p.body}`))).toBe(false);
  });

  it('refuses a separator, a name outside the pattern, a missing file, a symlink and a folder', async () => {
    const life = service();
    await life.start();
    const before = sha(join(dir, 'life.db'));
    writeFileSync(join(dir, 'life-outside.db'), 'x');
    mkdirSync(backups, { recursive: true });
    symlinkSync(join(dir, 'life-outside.db'), join(backups, 'life-link.db'));
    mkdirSync(join(backups, 'life-folder.db'));
    const cases: [string, string, string][] = [
      ['../life-outside.db', 'invalid_request', RESTORE_REFUSED.name],
      ['sub/life-2026-10-01.db', 'invalid_request', RESTORE_REFUSED.name],
      ['life-2026-10-01.db/x', 'invalid_request', RESTORE_REFUSED.name],
      ['backup.db', 'invalid_request', RESTORE_REFUSED.name],
      ['life-2026-10-01.sqlite', 'invalid_request', RESTORE_REFUSED.name],
      ['life-2026-10-01.db', 'not_found', RESTORE_REFUSED.missing],
      ['life-link.db', 'invalid_request', RESTORE_REFUSED.notFile],
      ['life-folder.db', 'invalid_request', RESTORE_REFUSED.notFile],
    ];
    for (const [name, code, reason] of cases) expect(await life.restore(name), name).toEqual({ ok: false, code, reason });
    expect(sha(join(dir, 'life.db'))).toBe(before);
    expect(readdirSync(dir).filter((n) => n.startsWith('life.db.'))).toEqual([]);
  });

  it('refuses a backup that fails quick_check; life.db and the backup are left as they were', async () => {
    const life = service();
    await life.start();
    const path = seedBackup('life-2026-10-01.db', Array.from({ length: 40 }, (_, i) => `Todo ${i} ${'x'.repeat(100)}`), Date.parse('2026-10-01T00:00:00.000Z'));
    const bytes = readFileSync(path);
    const pageSize = bytes.readUInt16BE(16);
    for (let page = 2; page * pageSize <= bytes.length; page++) {
      const at = (page - 1) * pageSize;
      if (bytes[at] === 0x0d) {
        bytes.fill(0xa5, at + 1, at + 64);
        break;
      }
    }
    writeFileSync(path, bytes);
    const backupSha = sha(path);
    const before = sha(join(dir, 'life.db'));
    expect(await life.restore('life-2026-10-01.db')).toEqual({ ok: false, code: 'invalid_request', reason: RESTORE_REASONS.check });
    expect(sha(join(dir, 'life.db'))).toBe(before);
    expect(sha(path)).toBe(backupSha);
    expect(readdirSync(dir).filter((n) => n.startsWith('life.db.'))).toEqual([]);
    expect(life.status().open).toBe(true);
  });

  it('while broken, a restore is the way out; the bad file and its WAL are kept together', async () => {
    seedBackup('life-2026-10-29.db', ['From the backup'], Date.parse('2026-10-29T03:30:00.000Z'));
    writeFileSync(join(dir, 'life.db'), 'garbage '.repeat(600));
    writeFileSync(join(dir, 'life.db-wal'), 'a wal that belongs to the bad file');
    const bad = sha(join(dir, 'life.db'));
    const life = service();
    await life.start();
    expect(life.broken()).toBe(LIFE_BROKEN_REASON);
    const r = await life.restore('life-2026-10-29.db');
    expect(r.ok).toBe(true);
    const kept = r.ok ? r.value.kept : '';
    expect(life.broken()).toBeNull();
    expect(life.status().open).toBe(true);
    expect(titles()).toEqual(['From the backup']);
    expect(sha(join(dir, kept))).toBe(bad);
    expect(readFileSync(join(dir, `${kept}-wal`), 'utf8')).toBe('a wal that belongs to the bad file');
    expect(life.todos.listTodos({ done: false })).toMatchObject({ ok: true });
  });

  it('a Life that still cannot start on the restored file answers so; it stays broken', async () => {
    seedBackup('life-2026-10-29.db', ['From the backup'], Date.parse('2026-10-29T03:30:00.000Z'));
    lifeDbThere();
    const life = service({ builders: throwing });
    await life.start();
    expect(life.broken()).toBe(LIFE_START_FAILED);
    expect(await life.restore('life-2026-10-29.db')).toEqual({ ok: false, code: 'unavailable', reason: RESTORE_REASONS.reopen });
    expect(life.broken()).toBe(LIFE_START_FAILED);
    expect(titles()).toEqual(['From the backup']);
    expect(ctx.log.records.some((r) => r.fields.event === 'life.restore' && r.fields.code === 'reopen_failed')).toBe(true);
  });

  it('after a restore mends Life, a later break pushes "Life data needs attention" again', async () => {
    seedBackup('life-2026-10-29.db', ['From the backup'], Date.parse('2026-10-29T03:30:00.000Z'));
    writeFileSync(join(dir, 'life.db'), 'garbage '.repeat(600));
    const life = service();
    await life.start();
    await ctx.clock.tick(0);
    const notices = () => pushes.filter((p) => p.title === 'Life data needs attention');
    expect(notices()).toHaveLength(1);
    expect((await life.restore('life-2026-10-29.db')).ok).toBe(true);
    await life.stop();
    writeFileSync(join(dir, 'life.db'), 'garbage '.repeat(600));
    await life.start();
    await ctx.clock.tick(0);
    expect(life.broken()).toBe(LIFE_BROKEN_REASON);
    expect(notices()).toHaveLength(2);
  });

  it('with every module off, a restore swaps the file and leaves Life closed', async () => {
    seedBackup('life-2026-10-29.db', ['From the backup'], Date.parse('2026-10-29T03:30:00.000Z'));
    const life = service({ settings: SettingsSchema.parse({}) });
    await life.start();
    const r = await life.restore('life-2026-10-29.db');
    expect(r).toEqual({ ok: true, value: { kept: '' } });
    expect(life.status().open).toBe(false);
    expect(titles()).toEqual(['From the backup']);
  });
});

describe('v0.7: the pre-upgrade copy, life-pre-0.7.0.db', () => {
  /** A schema-1 life.db (what 0.6.1 writes), copied into the backups folder as `name`. */
  function schemaOneBackup(name: string, title: string): string {
    const tmp = join(dir, 'seed-schema-1.db');
    const r = openCheckedDb(tmp, { migrations: LIFE_MIGRATIONS.slice(0, 1), brokenReason: LIFE_BROKEN_REASON });
    if (!r.ok) throw new Error(r.code);
    const id = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
    r.db.prepare('INSERT INTO todos (id, updated_at, json) VALUES (?, ?, ?)').run(id, 'x', JSON.stringify({ id, title, priority: 'normal', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }));
    expect(r.db.meta('schema')).toBe('1');
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    const out = join(backups, name);
    r.db.prepare('VACUUM INTO ?').run(out);
    r.db.close();
    for (const s of ['', '-wal', '-shm']) rmSync(tmp + s, { force: true });
    chmodSync(out, 0o600);
    return out;
  }

  it('is listed, survives backups written the same day, and restores: the 0.6.1 copy moves to schema 2', async () => {
    const pre = schemaOneBackup('life-pre-0.7.0.db', 'Before the upgrade');
    const before = sha(pre);
    lifeDbThere();
    const life = service({ at: '2026-11-02T09:00:00.000Z' });
    await life.start();
    life.todos.createTodo({ title: 'After the upgrade' }, { kind: 'cli' });
    for (let i = 0; i < 2; i++) expect(await life.backup()).toMatchObject({ ok: true, value: { file: 'life-2026-11-02.db' } });
    expect(listBackups(backups).map((b) => b.name).sort()).toEqual(['life-2026-11-02.db', 'life-pre-0.7.0.db']);
    expect(sha(pre)).toBe(before);

    const r = await life.restore('life-pre-0.7.0.db');
    expect(r.ok).toBe(true);
    expect(titles()).toEqual(['Before the upgrade']);
    const db = new DatabaseSync(join(dir, 'life.db'), { readOnly: true });
    try {
      expect((db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string }).value).toBe('2');
    } finally {
      db.close();
    }
    // The copy itself is left as it was, for another way back.
    expect(sha(pre)).toBe(before);
  });
});

describe('the nightly backup', () => {
  it('runs at 03:30 in the Life zone', async () => {
    // 01:30 in Kolkata; a backup from an hour ago, so none at start.
    const start = Date.parse('2026-10-30T20:00:00.000Z');
    seedBackup('life-2026-10-30.db', [], start - HOUR);
    lifeDbThere();
    const life = service({ at: '2026-10-30T20:00:00.000Z', tz: 'Asia/Kolkata' });
    await life.start();
    expect(listBackups(backups).map((b) => b.name)).toEqual(['life-2026-10-30.db']);
    await ctx.clock.tick(2 * HOUR - MIN); // 03:29
    expect(listBackups(backups)).toHaveLength(1);
    await ctx.clock.tick(MIN); // 03:30
    expect(listBackups(backups).map((b) => b.name).sort()).toEqual(['life-2026-10-30.db', 'life-2026-10-31.db']);
    // And again the next night.
    await ctx.clock.tick(DAY);
    expect(listBackups(backups).map((b) => b.name)).toContain('life-2026-11-01.db');
  });

  it('runs at start when the newest backup is older than a day, or there is none', async () => {
    const at = Date.parse('2026-10-30T09:00:00.000Z');
    seedBackup('life-2026-10-28.db', [], at - BACKUP_STALE_MS - MIN);
    lifeDbThere();
    const life = service();
    await life.start();
    await ctx.clock.tick(0);
    expect(listBackups(backups).map((b) => b.name)).toContain('life-2026-10-30.db');
  });

  it('a failure pushes "Life backup failed" once a day', async () => {
    writeFileSync(backups, 'a file where the folder should be');
    const life = service({ at: '2026-10-30T03:00:00.000Z' });
    await life.start(); // no backup yet: one at start, which fails
    await ctx.clock.tick(0);
    expect(pushes.map((p) => p.title)).toEqual(['Life backup failed']);
    expect(pushes[0]).toMatchObject({ kind: 'life', url: '/today', tag: 'life:backup' });
    await ctx.clock.tick(30 * MIN); // 03:30 the same day: fails again, said once
    expect(pushes.filter((p) => p.title === 'Life backup failed')).toHaveLength(1);
    await ctx.clock.tick(DAY);
    expect(pushes.filter((p) => p.title === 'Life backup failed')).toHaveLength(2);
  });

  it('goes by the wall clock: a 03:30 the Mac slept through runs within a minute of waking, then the next night as usual', async () => {
    // Node's timers stop while the Mac sleeps: here they run on `awake`, while now() also counts the time asleep.
    const awake = new FakeClock('2026-10-30T20:00:00.000Z');
    let slept = 0;
    const clock: Clock = {
      now: () => awake.now() + slept,
      iso: (ms) => new Date(ms ?? awake.now() + slept).toISOString(),
      setTimeout: (fn, ms) => awake.setTimeout(fn, ms),
      clearTimeout: (id) => awake.clearTimeout(id),
      setInterval: (fn, ms) => awake.setInterval(fn, ms),
      clearInterval: (id) => awake.clearInterval(id),
      sleep: (ms, signal) => awake.sleep(ms, signal),
    };
    seedBackup('life-2026-10-30.db', [], clock.now() - HOUR);
    const runs: string[] = [];
    const timer = new BackupTimer(clock, createTestContext().log, {
      dir: backups,
      tz: () => 'UTC',
      run: async () => {
        runs.push(clock.iso());
      },
    });
    timer.start();
    try {
      expect(runs).toEqual([]);
      slept += 9 * HOUR; // the lid closes at 20:00 and opens at 05:00
      await awake.tick(BACKUP_CHECK_MS);
      expect(runs).toEqual(['2026-10-31T05:01:00.000Z']);
      await awake.tick(22 * HOUR + 28 * MIN); // 03:29 the next night
      expect(runs).toHaveLength(1);
      await awake.tick(MIN);
      expect(runs).toEqual(['2026-10-31T05:01:00.000Z', '2026-11-01T03:30:00.000Z']);
    } finally {
      timer.stop();
    }
    expect(awake.pending()).toBe(0);
  });

  it('the next 03:30 is strictly ahead, in the zone', () => {
    expect(nextBackupAt(new Date('2026-10-30T03:29:00.000Z'), 'UTC').toISOString()).toBe('2026-10-30T03:30:00.000Z');
    expect(nextBackupAt(new Date('2026-10-30T03:30:00.000Z'), 'UTC').toISOString()).toBe('2026-10-31T03:30:00.000Z');
    expect(nextBackupAt(new Date('2026-10-30T20:00:00.000Z'), 'Asia/Kolkata').toISOString()).toBe('2026-10-30T22:00:00.000Z');
  });
});

describe('lifeBackup and lifeRestore over ctl.sock', () => {
  let api: TestApi;
  let life: LifeService;
  beforeEach(async () => {
    api = await makeApi({
      ctx: { home: dir, settings: SettingsSchema.parse({ life: { todos: true } }) },
      deps: (c, f) => {
        life = buildLifeService(c, { sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy, notifiers: f.notifiers }, builders(), { macZone: 'UTC' });
        return { life };
      },
    });
    api.ctx.clock.set('2026-10-30T09:00:00.000Z');
    await life.start();
  });
  afterEach(async () => {
    await life.stop();
    await api.close();
  });

  it('backup answers the file and the time; restore answers ok and the kept name; both are audited by file name', async () => {
    const b = await api.ctl.inject({ method: 'POST', url: '/v1/life/backup' });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual({ file: 'life-2026-10-30.db', at: '2026-10-30T09:00:00.000Z' });
    const r = await api.ctl.inject({ method: 'POST', url: '/v1/life/restore', payload: { file: 'life-2026-10-30.db' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, kept: 'life.db.before-restore-2026-10-30T09-00-00-000Z' });
    const audit = api.ctx.db.audit.list().filter((a) => a.action === 'lifeBackup' || a.action === 'lifeRestore');
    expect(audit.map((a) => [a.action, a.target, a.result])).toEqual([
      ['lifeBackup', 'life-2026-10-30.db', 'ok'],
      ['lifeRestore', 'life-2026-10-30.db', 'ok'],
    ]);
  });

  it('an unknown backup is 404 with its sentence; a name outside the pattern is 400', async () => {
    const missing = await api.ctl.inject({ method: 'POST', url: '/v1/life/restore', payload: { file: 'life-2020-01-01.db' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe(RESTORE_REFUSED.missing);
    expect((await api.ctl.inject({ method: 'POST', url: '/v1/life/restore', payload: { file: '../life.db' } })).statusCode).toBe(400);
  });
});
