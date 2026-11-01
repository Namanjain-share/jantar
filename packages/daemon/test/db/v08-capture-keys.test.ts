/**
 * v0.8: migration 6 and the `capture_keys` repo (the iOS Shortcut's keys),
 * the same contract for SQLite and the in-memory test db. Only a key's
 * prefixed hash is kept; a revoked row stays. A 0.7 file (schema 5) moves to
 * 6 keeping every row; a file a newer Jantar wrote opens with a warning and
 * carries on with the tables this one knows, as 0.7 does with a 0.8 file.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaptureKeyRecord, Db } from '../../src/contracts.js';
import { memoryLogger } from '../../src/core/log.js';
import { createMemoryDb } from '../../src/core/memory-db.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, openSqliteFile } from '../../src/db/index.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'jantar-v08-db-')));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ts = (s: number) => new Date(Date.parse('2026-11-02T10:00:00.000Z') + s * 1000).toISOString();

function key(id: string, name: string, s = 0, over: Partial<CaptureKeyRecord> = {}): CaptureKeyRecord {
  return { id, name, keyHash: `hash-${id}`, createdAt: ts(s), lastSeenAt: null, revokedAt: null, ...over };
}

const A = '01JF1EETN0DEBV11D1000000A1';
const B = '01JF1EETN0DEBV11D2000000A2';
const C = '01JF1EETN0DEW1N1000000000B';

const repos: [string, () => { db: Db; close(): void }][] = [
  ['sqlite', () => {
    const db = openSqliteFile(join(dir, 'jantar.db'));
    return { db, close: () => db.close() };
  }],
  ['memory', () => {
    const db = createMemoryDb();
    return { db, close: () => db.close() };
  }],
];

describe('v0.8: migration 6', () => {
  it('is the latest, additive, and makes the capture_keys table with no key column', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(6);
    const m = MIGRATIONS.find((x) => x.version === 6);
    expect(m?.name).toBe('v0.8 capture keys');
    expect(m?.sql).toMatch(/CREATE TABLE IF NOT EXISTS capture_keys/);
    expect(m?.sql).toMatch(/key_hash\s+TEXT NOT NULL UNIQUE/);
    // Only a hash: no column could hold the key itself.
    expect(m?.sql.replace(/key_hash/g, '')).not.toMatch(/\bkey\b\s+TEXT|secret|token/i);
    expect(m?.sql).not.toMatch(/DROP|ALTER/i);
  });

  it('moves a 0.7 file (schema 5) to 6, keeping every row', () => {
    const file = join(dir, 'v07.db');
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.version <= 5)) {
      raw.exec(m.sql);
      raw.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, ts(0));
    }
    raw
      .prepare('INSERT INTO devices (id, name, key_hash, scopes, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('old', 'Old phone', 'hash-old', JSON.stringify(['read', 'control']), ts(0), ts(0));
    raw.prepare('INSERT INTO nodes (id, name, public_key, os, version, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(A, 'build-1', 'pk', 'linux', '0.7.0', ts(0));
    raw.close();

    const db = openSqliteFile(file);
    try {
      expect(db.schemaVersion()).toBe(6);
      expect(db.devices.get('old')?.name).toBe('Old phone');
      expect(db.nodes.get(A)?.name).toBe('build-1');
      expect(db.captureKeys.list()).toEqual([]);
      db.captureKeys.insert(key(B, 'iphone'));
      expect(db.captureKeys.activeCount()).toBe(1);
    } finally {
      db.close();
    }
  });

  it('a file a newer Jantar wrote opens with a warning and carries on (what 0.7 does with a 0.8 file)', () => {
    const file = join(dir, 'newer.db');
    openSqliteFile(file).close();
    const raw = new DatabaseSync(file);
    raw.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)').run(LATEST_SCHEMA_VERSION + 1, 'from the future', ts(0));
    raw.exec('CREATE TABLE later_things (id TEXT PRIMARY KEY)');
    raw.close();
    const log = memoryLogger();
    const db = openSqliteFile(file, { log });
    try {
      expect(log.records.some((r) => r.msg === 'database was written by a newer Jantar; continuing with the known tables')).toBe(true);
      db.captureKeys.insert(key(A, 'iphone'));
      expect(db.captureKeys.byHash(`hash-${A}`)?.id).toBe(A);
    } finally {
      db.close();
    }
  });
});

for (const [kind, open] of repos) {
  describe(`v0.8: the capture keys repo (${kind})`, () => {
    it('inserts, finds by hash, lists oldest first, touches', () => {
      const { db, close } = open();
      try {
        db.captureKeys.insert(key(B, 'ipad', 2));
        db.captureKeys.insert(key(A, 'iphone', 1));
        expect(db.captureKeys.byHash(`hash-${A}`)).toEqual(key(A, 'iphone', 1));
        expect(db.captureKeys.byHash('nope')).toBeNull();
        expect(db.captureKeys.list().map((k) => k.id)).toEqual([A, B]);
        db.captureKeys.touch(A, ts(60));
        expect(db.captureKeys.byHash(`hash-${A}`)?.lastSeenAt).toBe(ts(60));
        // One hash, one key.
        expect(() => db.captureKeys.insert(key(C, 'again', 3, { keyHash: `hash-${A}` }))).toThrow();
      } finally {
        close();
      }
    });

    it('revokes one (the first time kept) or all live ones; revoked rows stay and are not active', () => {
      const { db, close } = open();
      try {
        db.captureKeys.insert(key(A, 'iphone', 1));
        db.captureKeys.insert(key(B, 'ipad', 2));
        db.captureKeys.insert(key(C, 'old', 3));
        expect(db.captureKeys.activeCount()).toBe(3);
        expect(db.captureKeys.revoke(A, ts(10))?.revokedAt).toBe(ts(10));
        expect(db.captureKeys.revoke(A, ts(20))?.revokedAt).toBe(ts(10));
        expect(db.captureKeys.revoke('nope', ts(20))).toBeNull();
        expect(db.captureKeys.activeCount()).toBe(2);
        expect(db.captureKeys.revokeAll(ts(30))).toBe(2);
        expect(db.captureKeys.revokeAll(ts(40))).toBe(0);
        expect(db.captureKeys.activeCount()).toBe(0);
        expect(db.captureKeys.list().map((k) => [k.id, k.revokedAt])).toEqual([
          [A, ts(10)],
          [B, ts(30)],
          [C, ts(30)],
        ]);
      } finally {
        close();
      }
    });
  });
}
