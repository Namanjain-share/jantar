import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonEvent, Device, PendingRequest, PushSubscriptionRecord } from '@jantar/protocol';
import type { Db } from '../../src/contracts.js';
import { createMemoryDb } from '../../src/core/memory-db.js';
import { memoryLogger } from '../../src/core/log.js';
import { MemoryStore } from '../../src/core/store.js';
import { FakeClock } from '../../src/core/clock.js';
import { createDaemonContext } from '../../src/context.js';
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  openSqliteDb,
  openSqliteFile,
  persistEvents,
  persistPendingHistory,
  type SqliteDb,
} from '../../src/db/index.js';

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'jantar-e-db-')));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ts = (s: number) => new Date(Date.parse('2026-01-15T10:00:00.000Z') + s * 1000).toISOString();

function updated(seq: number): DaemonEvent {
  return { seq, ts: ts(seq), type: 'session.updated', sid: 's1', data: { patch: { mode: `m${seq}` } } };
}
function alertEv(seq: number): DaemonEvent {
  return {
    seq,
    ts: ts(seq),
    type: 'alert.limit',
    sid: 's1',
    data: { alert: { id: `a${seq}`, ts: ts(seq), kind: 'limit', label: 'Limit hit · demo · s1', what: 'limit' } },
  };
}
function device(id: string, over: Partial<Device> = {}): Device {
  return { id, name: `dev ${id}`, keyHash: `hash-${id}`, scopes: ['read', 'control'], createdAt: ts(Number(id.replace(/\D/g, '')) || 0), lastSeenAt: ts(0), ...over };
}
function card(id: string, sid: string, s: number): PendingRequest {
  return {
    id,
    sid,
    kind: 'question',
    tool: 'AskUserQuestion',
    input: { questions: [] },
    suggestions: [],
    correlationKey: `${sid}|AskUserQuestion|{}`,
    createdAt: ts(s),
    settleUntil: ts(s + 3),
    state: 'open',
  };
}
function sub(endpoint: string, deviceId: string): PushSubscriptionRecord {
  return { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } }, deviceId, createdAt: ts(1) };
}

// ---------------------------------------------------------------------------
// The same contract for the SQLite db and the in-memory test db.

const impls: [string, () => Db][] = [
  ['sqlite', () => openSqliteFile(join(dir, 'contract.db'))],
  ['memory', () => createMemoryDb()],
];

for (const [name, open] of impls) {
  describe(`Db contract (${name})`, () => {
    it('events: append, since, latest, maxSeq, prune', () => {
      const db = open();
      try {
        for (let i = 1; i <= 6; i++) db.events.append(i % 3 === 0 ? alertEv(i) : updated(i));
        expect(db.events.maxSeq()).toBe(6);
        expect(db.events.since(2).map((e) => e.seq)).toEqual([3, 4, 5, 6]);
        expect(db.events.since(0, { limit: 2 }).map((e) => e.seq)).toEqual([1, 2]);
        expect(db.events.since(0, { types: ['alert.limit'] }).map((e) => e.seq)).toEqual([3, 6]);
        expect(db.events.latest({ limit: 2 }).map((e) => e.seq)).toEqual([6, 5]);
        expect(db.events.latest({ limit: 10, types: ['alert.limit'], after: 3 }).map((e) => e.seq)).toEqual([6]);
        // Round-trips the full event (since() is exclusive of `after`).
        expect(db.events.since(4)[0]).toEqual(updated(5));
        expect(db.events.prune(2)).toBe(4);
        expect(db.events.since(0).map((e) => e.seq)).toEqual([5, 6]);
      } finally {
        db.close();
      }
    });

    it('audit: append assigns increasing seq; list oldest-first after, newest window otherwise', () => {
      const db = open();
      try {
        const a = db.audit.append({ ts: ts(1), actor: 'cli', action: 'pairStart', params: { scopes: ['read'] }, result: 'ok' });
        const b = db.audit.append({ ts: ts(2), actor: 'device:X', action: 'sendPrompt', target: 's1', params: {}, result: 'refused', detail: 'refused: busy' });
        db.audit.append({ ts: ts(3), actor: 'cli', action: 'focusSession', params: {}, result: 'ok' });
        expect(b.seq).toBeGreaterThan(a.seq);
        expect(db.audit.list({ after: a.seq }).map((e) => e.action)).toEqual(['sendPrompt', 'focusSession']);
        expect(db.audit.list({ limit: 2 }).map((e) => e.action)).toEqual(['sendPrompt', 'focusSession']);
        expect(db.audit.list({ after: a.seq, limit: 1 })[0]).toEqual({ ...b, seq: b.seq });
      } finally {
        db.close();
      }
    });

    it('devices: insert, lookups, touch, revoke (first revoke time wins)', () => {
      const db = open();
      try {
        db.devices.insert(device('d1'));
        db.devices.insert(device('d2', { userAgent: 'UA' }));
        expect(() => db.devices.insert(device('d1'))).toThrow();
        expect(db.devices.get('d2')).toEqual(device('d2', { userAgent: 'UA' }));
        expect(db.devices.byKeyHash('hash-d1')?.id).toBe('d1');
        expect(db.devices.byKeyHash('nope')).toBeNull();
        db.devices.touch('d1', ts(50));
        expect(db.devices.get('d1')?.lastSeenAt).toBe(ts(50));
        expect(db.devices.revoke('d1', ts(60))?.revokedAt).toBe(ts(60));
        expect(db.devices.revoke('d1', ts(70))?.revokedAt).toBe(ts(60));
        expect(db.devices.revoke('nope', ts(70))).toBeNull();
        expect(db.devices.list().map((d) => d.id)).toEqual(['d1', 'd2']);
      } finally {
        db.close();
      }
    });

    it('push subscriptions: upsert by endpoint, remove, remove for device', () => {
      const db = open();
      try {
        db.pushSubs.upsert(sub('https://push.example.com/1', 'd1'));
        db.pushSubs.upsert(sub('https://push.example.com/2', 'd1'));
        db.pushSubs.upsert({ ...sub('https://push.example.com/2', 'd2'), kinds: ['question'] });
        expect(db.pushSubs.list()).toHaveLength(2);
        expect(db.pushSubs.list().find((r) => r.subscription.endpoint.endsWith('/2'))).toMatchObject({ deviceId: 'd2', kinds: ['question'] });
        expect(db.pushSubs.removeForDevice('d1')).toBe(1);
        expect(db.pushSubs.remove('https://push.example.com/2')).toBe(true);
        expect(db.pushSubs.remove('https://push.example.com/2')).toBe(false);
        expect(db.pushSubs.list()).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('pending history: record replaces by id; list newest first, by sid, with a limit', () => {
      const db = open();
      try {
        db.pending.record(card('p1', 's1', 1));
        db.pending.record(card('p2', 's2', 2));
        db.pending.record(card('p3', 's1', 3));
        db.pending.record({ ...card('p1', 's1', 1), state: 'closed', closeReason: 'stop' });
        expect(db.pending.get('p1')?.state).toBe('closed');
        expect(db.pending.get('nope')).toBeNull();
        expect(db.pending.list().map((p) => p.id)).toEqual(['p3', 'p2', 'p1']);
        expect(db.pending.list({ sid: 's1' }).map((p) => p.id)).toEqual(['p3', 'p1']);
        expect(db.pending.list({ limit: 1 }).map((p) => p.id)).toEqual(['p3']);
      } finally {
        db.close();
      }
    });

    it('kv: get, set (JSON values), delete', () => {
      const db = open();
      try {
        expect(db.kv.get('x')).toBeUndefined();
        db.kv.set('x', { a: [1, 2], b: null });
        expect(db.kv.get('x')).toEqual({ a: [1, 2], b: null });
        db.kv.set('x', 5);
        expect(db.kv.get<number>('x')).toBe(5);
        db.kv.delete('x');
        expect(db.kv.get('x')).toBeUndefined();
      } finally {
        db.close();
      }
    });
  });
}

// ---------------------------------------------------------------------------

describe('SQLite specifics', () => {
  it('creates the file 0600 in WAL mode, records migrations once, and survives a reopen', async () => {
    const file = join(dir, 'state', 'jantar.db');
    const log = memoryLogger();
    let db: SqliteDb = openSqliteFile(file, { log });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'state'))).mode & 0o777).toBe(0o700);
    expect((db.raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect(db.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    db.events.append(updated(7));
    db.devices.insert(device('d1'));
    db.close();
    db.close(); // idempotent

    db = openSqliteFile(file, { log });
    expect(db.events.maxSeq()).toBe(7);
    expect(db.devices.get('d1')?.id).toBe('d1');
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }).n).toBe(MIGRATIONS.length);
    for (const f of readdirSync(join(dir, 'state')).filter((n) => n.startsWith('jantar.db'))) {
      expect((await stat(join(dir, 'state', f))).mode & 0o077, f).toBe(0);
    }
    db.close();
    expect(log.records.filter((r) => r.msg === 'database migrated')).toHaveLength(MIGRATIONS.length);
  });

  it('migration 2 adds the device secret hash to a v1 database; v1 devices keep working without one', async () => {
    const file = join(dir, 'v1.db');
    const { createRequire } = await import('node:module');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    raw.exec(MIGRATIONS[0]?.sql ?? '');
    raw.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (1, ?, ?)').run('initial', ts(0));
    raw
      .prepare('INSERT INTO devices (id, name, key_hash, scopes, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('old', 'Old phone', 'hash-old', JSON.stringify(['read', 'control']), ts(0), ts(0));
    raw.close();

    const db = openSqliteFile(file);
    try {
      // Migrated through every later migration too (3: the v0.3 tables).
      expect(db.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
      const old = db.devices.get('old');
      expect(old?.name).toBe('Old phone');
      expect(old && 'secretHash' in old).toBe(false);
      db.devices.insert(device('d9', { secretHash: 'secret-hash-d9' }));
      expect(db.devices.get('d9')?.secretHash).toBe('secret-hash-d9');
      expect(db.devices.byKeyHash('hash-d9')?.secretHash).toBe('secret-hash-d9');
    } finally {
      db.close();
    }
  });

  it('keeps a 2000-event replay ring and a separate alert history', () => {
    const db = openSqliteFile(join(dir, 'ring.db'), { ringSize: 5, alertCap: 2 });
    try {
      for (let i = 1; i <= 30; i++) db.events.append(i % 10 === 0 ? alertEv(i) : updated(i));
      db.pruneNow();
      const seqs = db.events.since(0).map((e) => e.seq);
      expect(seqs.filter((s) => s % 10 !== 0)).toEqual([25, 26, 27, 28, 29]);
      expect(seqs.filter((s) => s % 10 === 0)).toEqual([20, 30]);
      // The high-water mark survives pruning everything, so seq never goes backwards after a restart.
      db.events.prune(0);
      expect(db.events.maxSeq()).toBe(30);
    } finally {
      db.close();
    }
  });

  it('keeps ok audit rows on their own budget: refusals never push them out', () => {
    const db = openSqliteFile(join(dir, 'audit.db'), { auditCap: 3 });
    try {
      for (let i = 1; i <= 4; i++) db.audit.append({ ts: ts(i), actor: 'device:owner', action: `ok${i}`, params: {}, result: 'ok' });
      for (let i = 1; i <= 50; i++) {
        db.audit.append({ ts: ts(10 + i), actor: 'device:tablet', action: 'focusSession', params: {}, result: i % 2 ? 'refused' : 'failed' });
      }
      db.pruneNow();
      const rows = db.audit.list({ limit: 100 });
      expect(rows.filter((r) => r.result === 'ok').map((r) => r.action)).toEqual(['ok2', 'ok3', 'ok4']);
      expect(rows.filter((r) => r.result !== 'ok')).toHaveLength(3);
      expect(rows.at(-1)?.ts).toBe(ts(60));
    } finally {
      db.close();
    }
  });

  it('applies retention automatically every 100 writes', () => {
    const db = openSqliteFile(join(dir, 'auto.db'), { ringSize: 10 });
    try {
      for (let i = 1; i <= 250; i++) db.events.append(updated(i));
      const n = db.events.since(0).length;
      expect(n).toBeLessThanOrEqual(10 + 99);
      expect(db.events.maxSeq()).toBe(250);
    } finally {
      db.close();
    }
  });

  it('moves a corrupt file aside and starts fresh (never refuses to start)', async () => {
    const file = join(dir, 'bad.db');
    await writeFile(file, 'this is not a sqlite database, just text '.repeat(200));
    const log = memoryLogger();
    const db = openSqliteFile(file, { log, now: () => Date.parse('2026-01-15T10:00:00.000Z') });
    try {
      expect(db.events.maxSeq()).toBe(0);
      const aside = readdirSync(dir).filter((f) => f.startsWith('bad.db.corrupt-'));
      expect(aside).toHaveLength(1);
      expect(log.records.some((r) => r.level === 'error' && /moving it aside/.test(r.msg))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('openSqliteDb is the DbOpener: the store continues numbering after a restart', async () => {
    const env = { HOME: join(dir, 'home'), JANTAR_HOME: join(dir, 'jantar-home'), PATH: '' };
    let ctx = await createDaemonContext({ env, openDb: openSqliteDb, log: memoryLogger() });
    const unsub = persistEvents(ctx.store, ctx.db);
    ctx.store.emit({ type: 'session.added', sid: 's1', data: { session: SESSION } });
    ctx.store.emit({ type: 'session.updated', sid: 's1', data: { patch: { mode: 'plan' } } });
    unsub();
    expect(existsSync(join(dir, 'jantar-home', 'jantar.db'))).toBe(true);
    ctx.db.close();

    ctx = await createDaemonContext({ env, openDb: openSqliteDb, log: memoryLogger() });
    try {
      expect(ctx.store.seq).toBe(2);
      expect(ctx.store.emit({ type: 'session.removed', sid: 's1', data: {} }).seq).toBe(3);
    } finally {
      ctx.db.close();
    }
  });

  it('persistPendingHistory records cards and their outcome', () => {
    const db = openSqliteFile(join(dir, 'pending.db'));
    const store = new MemoryStore({ clock: new FakeClock() });
    try {
      store.emit({ type: 'session.added', sid: 's1', data: { session: SESSION } });
      const unsub = persistPendingHistory(store, db);
      const p = card('01JTESTCARDXXXXXXXXXXXXXXXXXXXX', 's1', 1);
      store.emit({ type: 'pending.opened', sid: 's1', data: { pending: p } });
      store.emit({ type: 'pending.resolved', sid: 's1', data: { id: p.id, state: 'decided', decidedBy: 'device:D', decision: { behavior: 'allow' } } });
      expect(db.pending.get(p.id)).toMatchObject({ state: 'decided', decidedBy: 'device:D' });
      store.emit({ type: 'pending.resolved', sid: 's1', data: { id: p.id, state: 'confirmed', reason: 'PostToolUse' } });
      expect(db.pending.get(p.id)).toMatchObject({ state: 'confirmed', closeReason: 'PostToolUse', closedAt: '2026-01-15T10:00:00.000Z' });
      unsub();
    } finally {
      db.close();
    }
  });
});

const SESSION = {
  sid: 's1',
  pid: 1,
  procStart: 'x',
  account: 1,
  configDir: '/synthetic/.claude',
  cwd: '/synthetic/demo',
  folder: 'demo',
  entrypoint: 'cli',
  status: 'idle' as const,
  statusSource: 'session-file' as const,
  statusSince: '2026-01-15T10:00:00.000Z',
  subagentsRunning: 0,
};
