/**
 * v0.6 Fleet: migration 5 and the `nodes` repo, the same contract for SQLite
 * and the in-memory test db. The hub keeps each paired server's public key,
 * never a secret; a name is unique among live nodes only; a revoked row stays.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db, NodeRecord } from '../../src/contracts.js';
import { createMemoryDb } from '../../src/core/memory-db.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, openSqliteFile } from '../../src/db/index.js';

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'jantar-v06-db-')));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ts = (s: number) => new Date(Date.parse('2026-11-01T10:00:00.000Z') + s * 1000).toISOString();

function node(id: string, name: string, s = 0, over: Partial<NodeRecord> = {}): NodeRecord {
  return { id, name, publicKey: Buffer.alloc(32, s + 1).toString('base64url'), os: 'linux', version: '0.6.0', createdAt: ts(s), lastSeenAt: null, revokedAt: null, ...over };
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

describe('v0.6: migration 5', () => {
  it('is the latest, additive, and makes the nodes table with a live-name index', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(5);
    const m = MIGRATIONS.find((x) => x.version === 5);
    expect(m?.sql).toMatch(/CREATE TABLE IF NOT EXISTS nodes/);
    expect(m?.sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS nodes_live_name ON nodes \(name\) WHERE revoked_at IS NULL/);
    // No secret column: public keys only.
    expect(m?.sql).not.toMatch(/secret|private|token/i);
    const db = openSqliteFile(join(dir, 'jantar.db'));
    try {
      expect(db.schemaVersion()).toBe(5);
    } finally {
      db.close();
    }
  });
});

for (const [kind, open] of repos) {
  describe(`v0.6: the nodes repo (${kind})`, () => {
    it('inserts, reads, lists oldest first, touches and records what a node reports', () => {
      const { db, close } = open();
      try {
        db.nodes.insert(node(B, 'build-2', 2));
        db.nodes.insert(node(A, 'build-1', 1));
        expect(db.nodes.get(A)).toEqual(node(A, 'build-1', 1));
        expect(db.nodes.get('nope')).toBeNull();
        expect(db.nodes.list().map((n) => n.id)).toEqual([A, B]);
        db.nodes.touch(A, ts(60));
        db.nodes.setInfo(A, { os: 'wsl', version: '0.6.1' });
        expect(db.nodes.get(A)).toMatchObject({ lastSeenAt: ts(60), os: 'wsl', version: '0.6.1' });
        expect(db.nodes.byName('build-1')?.id).toBe(A);
      } finally {
        close();
      }
    });

    it('keeps a name unique among live nodes; a revoked one frees it, and revoking twice keeps the first time', () => {
      const { db, close } = open();
      try {
        db.nodes.insert(node(A, 'build-1', 1));
        expect(() => db.nodes.insert(node(B, 'build-1', 2))).toThrow();
        expect(db.nodes.revoke(A, ts(10))?.revokedAt).toBe(ts(10));
        expect(db.nodes.revoke(A, ts(20))?.revokedAt).toBe(ts(10));
        expect(db.nodes.revoke('nope', ts(20))).toBeNull();
        expect(db.nodes.byName('build-1')).toBeNull();
        db.nodes.insert(node(C, 'build-1', 3));
        expect(db.nodes.byName('build-1')?.id).toBe(C);
        // The revoked row stays, for the audit log.
        expect(db.nodes.list().map((n) => [n.id, n.revokedAt])).toEqual([
          [A, ts(10)],
          [C, null],
        ]);
      } finally {
        close();
      }
    });
  });
}

describe('v0.6: the nodes table survives a restart', () => {
  it('reopens with its rows', () => {
    const file = join(dir, 'jantar.db');
    const first = openSqliteFile(file);
    first.nodes.insert(node(A, 'build-1', 1));
    first.close();
    const again = openSqliteFile(file);
    try {
      expect(again.nodes.get(A)?.name).toBe('build-1');
    } finally {
      again.close();
    }
  });
});
