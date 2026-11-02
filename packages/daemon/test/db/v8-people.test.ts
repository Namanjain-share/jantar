/**
 * v0.12 People, jantar.db migration 8 (spec 9.1.2): additive and
 * idempotent. A 0.10 file (schema 7) moves to 8 and keeps every row; an
 * older daemon opening a schema-8 file warns and carries on (it never reads
 * these tables, so a partner is locked out: fails closed). The repos it
 * backs keep hashes only, and the ledger has no update or delete.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryLogger } from '../../src/core/log.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../src/db/schema.js';
import { openSqliteFile } from '../../src/db/sqlite.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jantar-v8-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('jantar.db migration 8 (v0.12 people)', () => {
  it('is the latest, named, and only adds (no DROP, no data change)', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(8);
    const m = MIGRATIONS.find((x) => x.version === 8);
    expect(m?.name).toBe('v0.12 people');
    expect(m?.sql).not.toMatch(/DROP|UPDATE|DELETE/i);
    expect(m?.sql).toMatch(/ALTER TABLE audit ADD COLUMN person TEXT/);
  });

  it('a 0.10 file (schema 7) moves to 8 with every row, and the new tables are empty', () => {
    const file = join(dir, 'jantar.db');
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.version <= 7)) {
      raw.exec(m.sql);
      raw.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, '2026-11-03T00:00:00.000Z');
    }
    raw.prepare("INSERT INTO devices (id, name, key_hash, scopes, created_at, last_seen_at) VALUES ('d1', 'Phone', 'h', '[\"read\"]', 'x', 'x')").run();
    raw.prepare("INSERT INTO audit (ts, actor, action, params, result) VALUES ('x', 'cli', 'a', '{}', 'ok')").run();
    raw.close();
    const db = openSqliteFile(file);
    try {
      expect(db.schemaVersion()).toBe(8);
      expect(db.devices.get('d1')?.name).toBe('Phone');
      expect(db.audit.list()).toHaveLength(1);
      for (const t of ['person_devices', 'person_link_codes', 'person_push_subs', 'person_invites', 'person_consents']) {
        expect((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, t).toBe(0);
      }
      // The person column is filled by the auditor for People writes, and null otherwise.
      db.audit.append({ ts: 'y', actor: 'person:P:D', action: 'person.write', params: {}, result: 'ok' }, 'P');
      expect(db.raw.prepare("SELECT person FROM audit WHERE actor = 'person:P:D'").get()).toEqual({ person: 'P' });
      expect(db.raw.prepare("SELECT person FROM audit WHERE actor = 'cli'").get()).toEqual({ person: null });
    } finally {
      db.close();
    }
    // Opening again migrates nothing twice.
    const again = openSqliteFile(file);
    expect(again.schemaVersion()).toBe(8);
    again.close();
  });

  it('an older daemon opening a schema-8 file warns and carries on', () => {
    const file = join(dir, 'jantar.db');
    openSqliteFile(file).close();
    const raw = new DatabaseSync(file);
    raw.prepare("INSERT INTO migrations (version, name, applied_at) VALUES (9, 'later', 'x')").run();
    raw.close();
    const log = memoryLogger();
    const db = openSqliteFile(file, { log });
    expect(log.records.some((r) => r.level === 'warn' && /newer Jantar/.test(r.msg))).toBe(true);
    db.close();
  });

  it('the repos: hashes only, spends once, the ledger appends', () => {
    const db = openSqliteFile(join(dir, 'jantar.db'));
    try {
      const p = db.people;
      p.invites.insert({ id: 'i1', personId: 'P', codeHash: 'h1', offerVersion: 1, createdAt: 'a', expiresAt: 'b', usedAt: null, revokedAt: null });
      expect(p.invites.use('i1', 'c')).toBe(true);
      expect(p.invites.use('i1', 'd')).toBe(false);
      p.linkCodes.insert({ id: 'l1', personId: 'P', codeHash: 'lh', byDevice: 'D', createdAt: 'a', expiresAt: 'b', usedAt: null });
      expect(p.linkCodes.use('l1', 'c')).toBe(true);
      expect(p.linkCodes.use('l1', 'c')).toBe(false);
      const a = p.consents.append({ personId: 'P', version: 1, action: 'offered', by: 'cli', at: 'a', json: { agreement: null } });
      const b = p.consents.append({ personId: 'P', version: 1, action: 'joined', by: 'person:P:D', at: 'b', json: { agreement: null } });
      expect(b.seq).toBeGreaterThan(a.seq);
      expect(p.consents.latestFor('P')?.action).toBe('joined');
      expect(Object.keys(p.consents)).toEqual(['append', 'listFor', 'latestFor', 'persons']);
    } finally {
      db.close();
    }
  });
});
