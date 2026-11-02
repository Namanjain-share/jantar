/**
 * v0.10 jantar.db migration 7 (spec 0.10 B11.2): additive, a scope column
 * on capture_keys; a 0.9 file's keys stay `capture`; list, activeCount and
 * revokeAll by scope, on SQLite and the in-memory Db alike.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaptureKeyRecord, Db } from '../../src/contracts.js';
import { createMemoryDb } from '../../src/core/memory-db.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, openSqliteFile } from '../../src/db/index.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'jantar-v010-db-')));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ts = (s: number) => new Date(Date.parse('2026-11-02T10:00:00.000Z') + s * 1000).toISOString();
const key = (id: string, scope: CaptureKeyRecord['scope'], s = 0): CaptureKeyRecord => ({ id, scope, name: 'iphone', keyHash: `hash-${id}`, createdAt: ts(s), lastSeenAt: null, revokedAt: null });

describe('v0.10: migration 7', () => {
  it('is the latest and only adds a column', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(7);
    const m = MIGRATIONS.find((x) => x.version === 7);
    expect(m?.name).toBe('v0.10 chat keys');
    expect(m?.sql).toMatch(/ALTER TABLE capture_keys ADD COLUMN scope TEXT NOT NULL DEFAULT 'capture'/);
    expect(m?.sql).not.toMatch(/DROP|CREATE/i);
  });

  it('a 0.9 file (schema 6) keeps every capture key as capture', () => {
    const file = join(dir, 'v09.db');
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.version <= 6)) {
      raw.exec(m.sql);
      raw.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, ts(0));
    }
    raw.prepare('INSERT INTO capture_keys (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)').run('old', 'iphone', 'hash-old', ts(0));
    raw.close();
    const db = openSqliteFile(file);
    try {
      expect(db.schemaVersion()).toBe(7);
      expect(db.captureKeys.list()).toEqual([expect.objectContaining({ id: 'old', scope: 'capture' })]);
    } finally {
      db.close();
    }
  });

  for (const [name, open] of [
    ['sqlite', () => openSqliteFile(join(dir, 'jantar.db'))],
    ['memory', () => createMemoryDb()],
  ] as const) {
    it(`${name}: list, activeCount and revokeAll by scope`, () => {
      const db: Db = open();
      try {
        db.captureKeys.insert(key('a', 'capture', 1));
        db.captureKeys.insert(key('b', 'chat', 2));
        db.captureKeys.insert(key('c', 'chat', 3));
        expect(db.captureKeys.list('chat').map((k) => k.id)).toEqual(['b', 'c']);
        expect(db.captureKeys.list().map((k) => k.id)).toEqual(['a', 'b', 'c']);
        expect(db.captureKeys.activeCount('capture')).toBe(1);
        expect(db.captureKeys.activeCount('chat')).toBe(2);
        expect(db.captureKeys.revokeAll(ts(9), 'chat')).toBe(2);
        expect(db.captureKeys.activeCount()).toBe(1);
        expect(db.captureKeys.byHash('hash-b')?.scope).toBe('chat');
      } finally {
        db.close();
      }
    });
  }
});
