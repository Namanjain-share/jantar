/**
 * v0.11 People, life.db schema 4 (spec 9.1.1, D6): one migration with every
 * table People's phases need. A schema-3 file with rows in every table
 * migrates in one transaction: every row keeps its data and is the owner's
 * (`space = ''`, `by_person = ''`, `person = ''`), weights and saved foods
 * are rebuilt with their counts and CHECK, the new tables exist and are
 * empty, quick_check passes, and the pre-migrate copy is written. A failure
 * between statements leaves schema 3 intact. An older build refuses it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIFE_BROKEN_REASON, LIFE_MIGRATIONS, LIFE_SCHEMA_VERSION, openCheckedDb, openLifeDb } from '../../src/life/db.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jantar-v4-'));
  file = join(dir, 'life.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = '2026-11-03T09:00:00.000Z';

function schemaThree(): void {
  const r = openCheckedDb(file, { migrations: LIFE_MIGRATIONS.slice(0, 3), brokenReason: LIFE_BROKEN_REASON });
  if (!r.ok) throw new Error(r.code);
  const db = r.db;
  db.tx(() => {
    db.prepare("INSERT INTO projects (id, status, updated_at, json) VALUES ('p1', 'active', ?, '{}')").run(NOW);
    db.prepare("INSERT INTO todos (id, project_id, due_day, done_at, updated_at, json) VALUES ('t1', 'p1', '2026-11-03', NULL, ?, '{}')").run(NOW);
    db.prepare("INSERT INTO medicines (id, stopped_on, updated_at, json) VALUES ('m1', NULL, ?, '{}')").run(NOW);
    db.prepare("INSERT INTO doses (id, med_id, day, slot, status, at) VALUES ('d1', 'm1', '2026-11-03', '08:00', 'taken', ?)").run(NOW);
    db.prepare("INSERT INTO food (id, day, at, json) VALUES ('f1', '2026-11-03', ?, '{}')").run(NOW);
    db.prepare("INSERT INTO foods_saved (id, name_key, uses, last_used, json) VALUES ('s1', 'dal', 2, ?, '{}')").run(NOW);
    db.prepare("INSERT INTO weights (day, kg10, at) VALUES ('2026-11-02', 700, ?), ('2026-11-03', 702, ?)").run(NOW, NOW);
    db.prepare("INSERT INTO places (id, best, updated_at, json) VALUES ('c1', 5, ?, '{}')").run(NOW);
    db.prepare("INSERT INTO place_visits (id, place_id, day, updated_at, json) VALUES ('v1', 'c1', '2026-11-01', ?, '{}')").run(NOW);
    db.prepare("INSERT INTO pings (id, kind, ref, sub, next_at, failures) VALUES ('g1', 'med', 'm1', '08:00', ?, 0)").run(NOW);
  });
  db.close();
}

const count = (db: { prepare(s: string): { get(): unknown } }, t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

describe('life.db schema 4 (people)', () => {
  it('migrates a schema-3 file: every row stays, and is the owner\'s', () => {
    schemaThree();
    let copied = '';
    const r = openLifeDb(file, { preMigrateCopy: () => (copied = join(dir, 'backups', 'life-pre-test.db')) });
    if (!r.ok) throw new Error(r.code);
    try {
      expect(r.db.meta('schema')).toBe(String(LIFE_SCHEMA_VERSION));
      expect(r.precopy?.from).toBe(3);
      expect(copied).not.toBe('');
      const counts = Object.fromEntries(['projects', 'todos', 'medicines', 'doses', 'food', 'foods_saved', 'weights', 'places', 'place_visits', 'pings'].map((t) => [t, count(r.db, t)]));
      expect(counts).toEqual({ projects: 1, todos: 1, medicines: 1, doses: 1, food: 1, foods_saved: 1, weights: 2, places: 1, place_visits: 1, pings: 1 });
      for (const [t, col] of [
        ['projects', 'space'],
        ['todos', 'space'],
        ['todos', 'by_person'],
        ['medicines', 'space'],
        ['medicines', 'by_person'],
        ['doses', 'space'],
        ['food', 'space'],
        ['foods_saved', 'space'],
        ['weights', 'space'],
        ['places', 'space'],
        ['places', 'by_person'],
        ['place_visits', 'space'],
        ['place_visits', 'by_person'],
        ['pings', 'person'],
      ] as const) {
        expect(r.db.prepare(`SELECT DISTINCT ${col} AS v FROM ${t}`).all(), `${t}.${col}`).toEqual([{ v: '' }]);
      }
      for (const t of ['people', 'shared_spaces', 'day_plans', 'plan_templates', 'person_alerts', 'person_activity', 'journal_entries', 'journal_comments', 'sleep_logs']) {
        expect(count(r.db, t), t).toBe(0);
      }
      // The rebuilt weights keep their CHECK and key by (space, day); saved foods are unique per space.
      expect(() => r.db.prepare("INSERT INTO weights (space, day, kg10, at) VALUES ('', '2026-11-04', 50, 'x')").run()).toThrow(/CHECK/);
      r.db.prepare("INSERT INTO weights (space, day, kg10, at) VALUES ('01JZZZZZZZZZZZZZZZZZZZZZZZ', '2026-11-03', 600, 'x')").run();
      expect(count(r.db, 'weights')).toBe(3);
      r.db.prepare("INSERT INTO foods_saved (id, space, name_key, uses, last_used, json) VALUES ('s2', '01JZZZZZZZZZZZZZZZZZZZZZZZ', 'dal', 1, NULL, '{}')").run();
      expect(() => r.db.prepare("INSERT INTO foods_saved (id, space, name_key, uses, last_used, json) VALUES ('s3', '', 'dal', 1, NULL, '{}')").run()).toThrow(/UNIQUE/);
      // One open night per space (P2's table, ready now).
      r.db.prepare("INSERT INTO sleep_logs (id, space, night, bed_at, wake_at, json) VALUES ('n1', 'S', '2026-11-02', 'x', NULL, '{}')").run();
      expect(() => r.db.prepare("INSERT INTO sleep_logs (id, space, night, bed_at, wake_at, json) VALUES ('n2', 'S', '2026-11-03', 'x', NULL, '{}')").run()).toThrow(/UNIQUE/);
      expect(Object.values(r.db.raw.prepare('PRAGMA quick_check').get() as object)[0]).toBe('ok');
    } finally {
      r.db.close();
    }
  });

  it('a failure inside the migration leaves schema 3 and every row as it was', () => {
    schemaThree();
    const raw = new DatabaseSync(file);
    // A table the migration creates already exists: its CREATE fails part way through.
    raw.exec('CREATE TABLE sleep_logs (x)');
    raw.close();
    const r = openLifeDb(file);
    expect(r).toMatchObject({ ok: false, code: 'migration_failed' });
    const check = new DatabaseSync(file, { readOnly: true });
    try {
      expect(check.prepare("SELECT value FROM meta WHERE key = 'schema'").get()).toEqual({ value: '3' });
      expect(check.prepare('PRAGMA table_info(todos)').all().map((c) => (c as { name: string }).name)).not.toContain('space');
      expect(check.prepare('SELECT COUNT(*) AS n FROM weights').get()).toEqual({ n: 2 });
    } finally {
      check.close();
    }
  });

  it('a build that knows only schema 3 refuses a schema-4 file (newer_schema), untouched', () => {
    const r = openLifeDb(file);
    if (!r.ok) throw new Error(r.code);
    r.db.close();
    const old = openCheckedDb(file, { migrations: LIFE_MIGRATIONS.slice(0, 3), brokenReason: LIFE_BROKEN_REASON });
    expect(old).toMatchObject({ ok: false, code: 'newer_schema' });
  });
});
