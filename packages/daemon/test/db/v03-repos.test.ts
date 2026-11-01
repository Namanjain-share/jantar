/**
 * Migration 3 and the v0.3 repos (launches, folders, launch flags, rewrite
 * runs, device scopes), with the same contract for SQLite and the in-memory
 * test db.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LAUNCH_FLAGS, type Device, type LaunchJob } from '@jantar/protocol';
import type { Db, RewriteRun } from '../../src/contracts.js';
import { createMemoryDb } from '../../src/core/memory-db.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, openSqliteFile } from '../../src/db/index.js';

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'jantar-v03-db-')));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ts = (s: number) => new Date(Date.parse('2026-10-30T10:00:00.000Z') + s * 1000).toISOString();

function launch(id: string, s: number, over: Partial<LaunchJob> = {}): LaunchJob {
  return {
    id,
    createdAt: ts(s),
    updatedAt: ts(s),
    actor: 'device:d1',
    rootId: 'r.work',
    folder: '/synthetic/home/Desktop/work/foo',
    display: '~/Desktop/work/foo',
    account: 7,
    accountSource: 'auto',
    requested: 'auto',
    flags: { ...DEFAULT_LAUNCH_FLAGS },
    dangerous: true,
    name: 'foo',
    sid: `00000000-0000-4000-8000-00000000000${s}`,
    stage: 'queued',
    steps: [],
    ...over,
  };
}

function run(id: string, s: number, over: Partial<RewriteRun> = {}): RewriteRun {
  return { id, at: ts(s), account: 4, model: 'opus', ok: true, ms: 2400, inputTokens: 900, outputTokens: 80, promptVersion: 'v1', outcome: 'ready', ...over };
}

const device = (id: string): Device => ({ id, name: id, keyHash: `hash-${id}`, scopes: ['read', 'control'], createdAt: ts(0), lastSeenAt: ts(0) });

const impls: [string, () => Db][] = [
  ['sqlite', () => openSqliteFile(join(dir, 'v03.db'))],
  ['memory', () => createMemoryDb()],
];

for (const [name, open] of impls) {
  describe(`v0.3 Db contract (${name})`, () => {
    it('launches: save replaces by id, list is newest first, unfinished leaves out final stages', () => {
      const db = open();
      try {
        db.launches.save(launch('l1', 1));
        db.launches.save(launch('l2', 2, { stage: 'dialog', dialog: { title: 'Trust?', options: ['Yes', 'No'], current: 0, since: ts(2) } }));
        db.launches.save(launch('l3', 3, { stage: 'done' }));
        db.launches.save(launch('l1', 1, { stage: 'failed', reason: 'cs: command not found' }));
        expect(db.launches.get('l1')).toMatchObject({ stage: 'failed', reason: 'cs: command not found' });
        expect(db.launches.get('nope')).toBeNull();
        expect(db.launches.list().map((j) => j.id)).toEqual(['l3', 'l2', 'l1']);
        expect(db.launches.list({ unfinished: true }).map((j) => j.id)).toEqual(['l2']);
        expect(db.launches.list({ limit: 1 }).map((j) => j.id)).toEqual(['l3']);
        expect(db.launches.get('l2')?.dialog?.options).toEqual(['Yes', 'No']);
      } finally {
        db.close();
      }
    });

    it('folders: pins by (root, rel), and the folders sessions ran in, newest first', () => {
      const db = open();
      try {
        db.folders.pin({ rootId: 'r.work', rel: 'foo', pinnedAt: ts(1), by: 'device:d1' });
        db.folders.pin({ rootId: 'r.work', rel: '', label: 'work', pinnedAt: ts(2), by: 'cli' });
        db.folders.pin({ rootId: 'r.work', rel: 'foo', label: 'Foo', pinnedAt: ts(3), by: 'device:d2' });
        expect(db.folders.pins()).toEqual([
          { rootId: 'r.work', rel: '', label: 'work', pinnedAt: ts(2), by: 'cli' },
          { rootId: 'r.work', rel: 'foo', label: 'Foo', pinnedAt: ts(3), by: 'device:d2' },
        ]);
        expect(db.folders.unpin('r.work', 'foo')).toBe(true);
        expect(db.folders.unpin('r.work', 'foo')).toBe(false);
        expect(db.folders.pins()).toHaveLength(1);

        db.folders.seen({ cwd: '/w/a', lastSeenAt: ts(1), account: 3, name: 'fix login' });
        db.folders.seen({ cwd: '/w/b', lastSeenAt: ts(5) });
        db.folders.seen({ cwd: '/w/a', lastSeenAt: ts(9), account: 7 });
        expect(db.folders.recentSeen(10)).toEqual([{ cwd: '/w/a', lastSeenAt: ts(9), account: 7 }, { cwd: '/w/b', lastSeenAt: ts(5) }]);
        expect(db.folders.recentSeen(1)).toHaveLength(1);
      } finally {
        db.close();
      }
    });

    it('launch flags: one row per actor, replaced on set', () => {
      const db = open();
      try {
        expect(db.launchFlags.get('device:d1')).toBeNull();
        db.launchFlags.set('device:d1', { ...DEFAULT_LAUNCH_FLAGS }, ts(1));
        db.launchFlags.set('device:d1', { permission: 'plan', chrome: false, effort: 'high', model: 'sonnet' }, ts(2));
        db.launchFlags.set('cli', { ...DEFAULT_LAUNCH_FLAGS }, ts(3));
        expect(db.launchFlags.get('device:d1')).toEqual({ permission: 'plan', chrome: false, effort: 'high', model: 'sonnet' });
        expect(db.launchFlags.get('cli')).toEqual(DEFAULT_LAUNCH_FLAGS);
      } finally {
        db.close();
      }
    });

    it('rewrite runs: recorded with nulls kept, newest first', () => {
      const db = open();
      try {
        db.rewriteRuns.record(run('r1', 1));
        db.rewriteRuns.record(run('r2', 2, { ok: false, account: null, ms: null, inputTokens: null, outputTokens: null, outcome: 'no_account' }));
        expect(db.rewriteRuns.list()).toEqual([
          run('r2', 2, { ok: false, account: null, ms: null, inputTokens: null, outputTokens: null, outcome: 'no_account' }),
          run('r1', 1),
        ]);
        expect(db.rewriteRuns.list({ limit: 1 }).map((r) => r.id)).toEqual(['r2']);
      } finally {
        db.close();
      }
    });

    it('devices: scopes can be replaced', () => {
      const db = open();
      try {
        db.devices.insert(device('d1'));
        expect(db.devices.setScopes('d1', ['read', 'control', 'launch'])?.scopes).toEqual(['read', 'control', 'launch']);
        expect(db.devices.get('d1')?.scopes).toEqual(['read', 'control', 'launch']);
        expect(db.devices.setScopes('nope', ['read'])).toBeNull();
      } finally {
        db.close();
      }
    });
  });
}

describe('migration 3', () => {
  it('upgrades a v0.2 database in place and keeps its rows', async () => {
    const file = join(dir, 'v2.db');
    const { createRequire } = await import('node:module');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.version <= 2)) {
      raw.exec(m.sql);
      raw.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, ts(0));
    }
    raw
      .prepare('INSERT INTO devices (id, name, key_hash, scopes, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('old', 'Old phone', 'hash-old', JSON.stringify(['read', 'control']), ts(0), ts(0));
    raw.close();

    const db = openSqliteFile(file);
    try {
      // v0.5 added migration 4 (extension keys), v0.6 5 (nodes), v0.8 6 (capture keys); a v0.2 file still migrates through every one.
      expect(LATEST_SCHEMA_VERSION).toBe(6);
      expect(db.schemaVersion()).toBe(6);
      expect(db.devices.get('old')?.name).toBe('Old phone');
      db.launches.save(launch('l1', 1));
      expect(db.launches.list()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('is additive and safe to run over tables that already exist', async () => {
    const m3 = MIGRATIONS.find((m) => m.version === 3);
    expect(m3).toBeDefined();
    expect(m3?.sql).not.toMatch(/\b(DROP|ALTER|DELETE|UPDATE)\b/i);
    const db = openSqliteFile(join(dir, 'twice.db'));
    try {
      db.folders.pin({ rootId: 'r.work', rel: 'foo', pinnedAt: ts(1), by: 'cli' });
      db.raw.exec(m3?.sql ?? '');
      expect(db.folders.pins()).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
