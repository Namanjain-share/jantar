/**
 * meetings.db (meetings/db.ts) and the Meetings shell (meetings/index.ts):
 * - MD2: created 0600 in the 0700 state dir with its tables; turning
 *   Meetings off closes it; it is opened only while Meetings are on. A
 *   deleted meeting's text is overwritten (secure_delete) and its WAL
 *   frames checkpointed away.
 * - MD1 (unit part): REFUSED, never reset, like life.db (the open is
 *   shared): random bytes, a file cut in half, a page scribbled over
 *   (quick_check fails) and a newer schema each give `ok: false` with
 *   MEETINGS_BROKEN_REASON, the file byte-identical and nothing created
 *   beside it; the shell's status says open false with the sentence and
 *   `broken()` gives it (the API answers 503 with it, v05-switches.test.ts).
 * - The shell: the status never throws, it lists paired extensions (not
 *   one idle past EXTENSION_IDLE_MS), it ticks only through `changed()`,
 *   and it sweeps at open and every 5 minutes.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MEETING_MARKER, MEETING_T0, transcriptLines } from '@jantar/fixtures';
import { EXTENSION_IDLE_MS, SettingsSchema } from '@jantar/protocol';
import type { LifeDb, MeetingCapture, MeetingLibrary, MeetingSummaries, MeetingsService } from '../../src/contracts.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { createTestContext, notBuiltParts, type TestContext } from '../../src/core/testing.js';
import { MEETINGS_BROKEN_REASON, MEETINGS_SCHEMA_VERSION, openMeetingsDb } from '../../src/meetings/db.js';
import { MEETINGS_SWEEP_EVERY_MS, buildMeetingsService, type MeetingsBuilders } from '../../src/meetings/index.js';
import { createMeetingsStore } from '../../src/meetings/store.js';
import { makeFakes } from '../api/fakes.js';

let dir: string;
let file: string;
const open: LifeDb[] = [];
const services: MeetingsService[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-meetingsdb-')));
  chmodSync(dir, 0o700);
  file = join(dir, 'meetings.db');
});
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  for (const db of open.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function openOk(path = file): LifeDb {
  const r = openMeetingsDb(path);
  if (!r.ok) throw new Error(`refused: ${r.code}`);
  open.push(r.db);
  return r.db;
}

/** A valid meetings.db with some lines in it, closed. */
function seeded(): void {
  const db = openOk();
  db.tx(() => {
    db.prepare("INSERT INTO meetings (id, ext_id, client_id, started_at, last_at, json) VALUES ('m1', 'e1', 'c1', 'a', 'a', '{}')").run();
    for (let i = 0; i < 300; i++) db.prepare("INSERT INTO lines (meeting_id, line_id, rev, at, speaker, text) VALUES ('m1', ?, 1, ?, 'Sam', ?)").run(`n-${i}`, i, 'x'.repeat(200));
  });
  db.close();
  open.splice(open.indexOf(db), 1);
}

function expectRefusedUntouched(code: string): void {
  const before = sha(file);
  const listing = readdirSync(dir).sort();
  expect(openMeetingsDb(file)).toEqual({ ok: false, code, reason: MEETINGS_BROKEN_REASON });
  expect(sha(file)).toBe(before);
  expect(readdirSync(dir).sort()).toEqual(listing);
}

/** Builders that do nothing (the shell is what these tests are about, whatever wave 1 builds). */
function inertBuilders(library: Partial<MeetingLibrary> = {}): MeetingsBuilders {
  return {
    capture: () => notBuilt<MeetingCapture>('Meetings'),
    library: () => notBuilt<MeetingLibrary>('Meetings', { sweep: async () => undefined, ...library }),
    summaries: () =>
      notBuilt<MeetingSummaries>('Meeting summaries', {
        status: () => ({ available: false, reason: 'Inert in this test.' }),
        enqueue: () => undefined,
        start: () => undefined,
        stop: () => undefined,
      }),
  };
}

/** A shell on a context whose state dir is the temp dir. */
function shell(over: { settings?: Record<string, unknown>; library?: Partial<MeetingLibrary> } = {}): { ctx: TestContext; meetings: MeetingsService } {
  const ctx = createTestContext({ userHome: dir, home: dir, settings: SettingsSchema.parse({ meetings: { enabled: true }, ...over.settings }) });
  const f = makeFakes(ctx);
  const meetings = buildMeetingsService(ctx, { life: notBuiltParts().life, usage: f.usage, ccwLegacy: f.ccwLegacy }, {}, inertBuilders(over.library));
  services.push(meetings);
  return { ctx, meetings };
}

describe('openMeetingsDb', () => {
  it('MD2: creates meetings.db 0600 inside the 0700 state dir, with its tables', () => {
    const db = openOk();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(['lines', 'meetings', 'meta', 'shots']);
    expect(db.meta('schema')).toBe(String(MEETINGS_SCHEMA_VERSION));
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777, f).toBe(0o600);
  });

  it('keeps one meeting per (extension, client id), and lines and shots go with their meeting', () => {
    const db = openOk();
    const add = db.prepare("INSERT INTO meetings (id, ext_id, client_id, started_at, last_at, json) VALUES (?, 'e1', ?, 'a', 'a', '{}')");
    add.run('m1', 'c1');
    expect(() => add.run('m2', 'c1')).toThrow(/UNIQUE/);
    db.prepare("INSERT INTO lines (meeting_id, line_id, rev, at, speaker, text) VALUES ('m1', 'n-1', 1, 0, 'Sam', 'hi')").run();
    db.prepare("INSERT INTO shots (id, meeting_id, key, at, bytes) VALUES ('s1', 'm1', 'k1', 0, 10)").run();
    expect(() => db.prepare("INSERT INTO shots (id, meeting_id, key, at, bytes) VALUES ('s2', 'm1', 'k1', 0, 10)").run()).toThrow(/UNIQUE/);
    db.prepare("DELETE FROM meetings WHERE id = 'm1'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM lines').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM shots').get()).toEqual({ n: 0 });
  });

  it("a deleted meeting's text is gone from the file and its WAL (secure_delete, then a checkpoint)", () => {
    const db = openOk();
    expect(db.prepare('PRAGMA secure_delete').get()).toEqual({ secure_delete: 1 });
    const store = createMeetingsStore(db);
    const at = new Date(MEETING_T0).toISOString();
    const record = { name: `Sync ${MEETING_MARKER}`, site: 'meet' as const, autoTodos: false, notes: true, summary: { state: 'none' as const, decisions: [], items: [] } };
    for (const id of ['m1', 'm2']) {
      store.create({ id, extId: 'e1', clientId: `c-${id}`, startedAt: at, endedAt: null, lastAt: at, projectId: null, record });
      store.upsertLines(id, transcriptLines(40, { marked: true }));
    }
    const onDisk = () => Buffer.concat([file, `${file}-wal`].filter((f) => existsSync(f)).map((f) => readFileSync(f)));
    expect(onDisk().includes(MEETING_MARKER)).toBe(true);
    store.remove('m1');
    store.remove('m2');
    expect(onDisk().includes(MEETING_MARKER)).toBe(false);
  });
});

describe('MD1: refuse on corruption, never reset', () => {
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

  it("a file whose meta('schema') is 99", () => {
    seeded();
    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE meta SET value = '99' WHERE key = 'schema'").run();
    raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    raw.close();
    for (const f of readdirSync(dir)) if (f !== 'meetings.db') rmSync(join(dir, f));
    expectRefusedUntouched('newer_schema');
  });

  it('the shell: status open false with the sentence, broken() gives it, the file is untouched', async () => {
    writeFileSync(file, randomBytes(4096), { mode: 0o600 });
    const before = sha(file);
    const { meetings } = shell();
    await meetings.start();
    expect(meetings.broken()).toBe(MEETINGS_BROKEN_REASON);
    expect(meetings.status()).toMatchObject({ on: true, open: false, broken: MEETINGS_BROKEN_REASON, meetings: 0 });
    expect(sha(file)).toBe(before);
    expect(readdirSync(dir).filter((f) => f.startsWith('meetings'))).toEqual(['meetings.db']);
  });
});

describe('the Meetings shell', () => {
  it('opens meetings.db only while Meetings are on, and closes it when they go off', async () => {
    const { ctx, meetings } = shell({ settings: { meetings: { enabled: false } } });
    await meetings.start();
    expect(existsSync(file)).toBe(false);
    expect(meetings.status()).toMatchObject({ on: false, open: false });
    await ctx.settings.patch({ meetings: { enabled: true } });
    expect(existsSync(file)).toBe(true);
    expect(meetings.status()).toMatchObject({ on: true, open: true, meetings: 0, running: 0, shotsBytes: 0 });
    expect(meetings.broken()).toBeNull();
    await ctx.settings.patch({ meetings: { enabled: false } });
    expect(meetings.status()).toMatchObject({ on: false, open: false });
    // Closed: a new connection may take the file again.
    const db = openOk();
    expect(db.meta('schema')).toBe('1');
  });

  it('turning Meetings off and on tries a refused file again', async () => {
    writeFileSync(file, randomBytes(4096), { mode: 0o600 });
    const { ctx, meetings } = shell();
    await meetings.start();
    expect(meetings.broken()).toBe(MEETINGS_BROKEN_REASON);
    await ctx.settings.patch({ meetings: { enabled: false } });
    expect(meetings.broken()).toBeNull();
    rmSync(file);
    await ctx.settings.patch({ meetings: { enabled: true } });
    expect(meetings.broken()).toBeNull();
    expect(meetings.status().open).toBe(true);
  });

  it("the status never throws, carries the summaries' status, and lists the paired extensions (not the revoked)", async () => {
    const { ctx, meetings } = shell();
    await meetings.start();
    const at = ctx.clock.iso();
    ctx.db.extensions.insert({ id: '01JFZ8X8Y3T0V5G9WQK2M4N6PR', keyHash: 'h1', origin: 'chrome-extension://x', createdAt: at, lastSeenAt: null, revokedAt: null });
    ctx.db.extensions.insert({ id: '01JFZ8X8Y3T0V5G9WQK2M4N6PS', keyHash: 'h2', origin: 'chrome-extension://x', createdAt: at, lastSeenAt: at, revokedAt: at });
    const st = meetings.status();
    expect(st.extensions).toEqual([{ id: '01JFZ8X8Y3T0V5G9WQK2M4N6PR', pairedAt: at, lastSeenAt: null }]);
    expect(st.summary).toEqual({ available: false, reason: 'Inert in this test.' });
  });

  it('lists no key idle past 90 days, though it is revoked only when next presented', async () => {
    const { ctx, meetings } = shell();
    await meetings.start();
    const paired = ctx.clock.iso();
    ctx.db.extensions.insert({ id: '01JFZ8X8Y3T0V5G9WQK2M4N6PR', keyHash: 'h1', origin: 'chrome-extension://x', createdAt: paired, lastSeenAt: null, revokedAt: null });
    ctx.clock.advance(EXTENSION_IDLE_MS / 2);
    const seen = ctx.clock.iso();
    ctx.db.extensions.insert({ id: '01JFZ8X8Y3T0V5G9WQK2M4N6PS', keyHash: 'h2', origin: 'chrome-extension://x', createdAt: paired, lastSeenAt: seen, revokedAt: null });
    ctx.clock.advance(EXTENSION_IDLE_MS / 2);
    expect(meetings.status().extensions.map((e) => e.id)).toEqual(['01JFZ8X8Y3T0V5G9WQK2M4N6PR', '01JFZ8X8Y3T0V5G9WQK2M4N6PS']);
    ctx.clock.advance(1);
    expect(meetings.status().extensions).toEqual([{ id: '01JFZ8X8Y3T0V5G9WQK2M4N6PS', pairedAt: paired, lastSeenAt: seen }]);
    expect(ctx.db.extensions.get('01JFZ8X8Y3T0V5G9WQK2M4N6PR')?.revokedAt).toBeNull();
  });

  it('sweeps at open and every 5 minutes while open, never while off', async () => {
    const swept: number[] = [];
    const { ctx, meetings } = shell({ library: { sweep: async (now: number) => void swept.push(now) } });
    await meetings.start();
    await Promise.resolve();
    expect(swept).toHaveLength(1);
    await ctx.clock.tick(MEETINGS_SWEEP_EVERY_MS);
    expect(swept).toHaveLength(2);
    await ctx.settings.patch({ meetings: { enabled: false } });
    await ctx.clock.tick(3 * MEETINGS_SWEEP_EVERY_MS);
    expect(swept).toHaveLength(2);
  });

  it('a sweep that throws is logged by its code only', async () => {
    const { ctx, meetings } = shell({ library: { sweep: async () => Promise.reject(Object.assign(new Error('/secret/path meeting text'), { code: 'EACCES' })) } });
    await meetings.start();
    await ctx.clock.tick(0);
    const line = ctx.log.records.find((r) => r.msg === 'meetings: the sweep failed');
    expect(line?.fields).toMatchObject({ error: 'EACCES' });
    expect(JSON.stringify(ctx.log.records)).not.toContain('/secret/path');
  });
});
