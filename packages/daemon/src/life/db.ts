/**
 * life.db: Life's own SQLite file (node:sqlite, WAL), apart from jantar.db.
 *
 * - Its own migrations, recorded in `meta('schema')` inside the same
 *   transaction. Never edit a migration that has shipped: add one.
 * - REFUSE ON CORRUPTION. jantar.db is an event ring: db/sqlite.ts moves a
 *   bad file aside and starts fresh, and prunes on caps. Medicine history is
 *   not: a file that will not open, fails `PRAGMA quick_check`, carries a
 *   schema newer than this build or fails a migration is left exactly as it
 *   is (nothing renamed, deleted, rewritten or created beside it, a WAL
 *   beside it included) and the open answers `{ ok: false }`. Life then answers 503 with LIFE_BROKEN_REASON until a
 *   backup is restored at the Mac; sessions and approvals carry on.
 * - Never pruned. Caps per store (LIFE_LIMITS) are checked by the modules.
 * - A new file is created 0600 inside the 0700 state dir.
 *
 * Each table keeps a few indexed columns plus a `json` column the modules
 * validate with zod on read and write.
 *
 * v0.5: the checked open is shared. `openCheckedDb(path, { migrations,
 * brokenReason })` is the body of the open; `openLifeDb` calls it with
 * Life's migrations, and meetings/db.ts with Meetings' (meetings.db is
 * refused, never reset, the same way).
 */
import { closeSync, existsSync, openSync, readSync, fstatSync, chmodSync, statSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { CLI_NAME } from '@jantar/protocol';
import type { LifeDb } from '../contracts.js';

/** What every Life route but status, backup and restore answers (503 life_unavailable) while life.db is broken. */
export const LIFE_BROKEN_REASON = `Life data could not be opened. The file is untouched. Restore a backup at your Mac: ${CLI_NAME} life restore <file>`;

export interface LifeMigration {
  version: number;
  name: string;
  sql: string;
}

export const LIFE_MIGRATIONS: readonly LifeMigration[] = [
  {
    version: 1,
    name: 'life',
    sql: `
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); -- schema, kcal_target, goal_kg10

      CREATE TABLE projects (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE todos (id TEXT PRIMARY KEY, project_id TEXT, due_day TEXT, done_at TEXT, updated_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX todos_open ON todos (done_at, due_day);
      CREATE INDEX todos_project ON todos (project_id);

      CREATE TABLE medicines (id TEXT PRIMARY KEY, stopped_on TEXT, updated_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE doses (
        id     TEXT PRIMARY KEY,
        med_id TEXT NOT NULL,
        day    TEXT NOT NULL,
        slot   TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('taken', 'skipped')),
        at     TEXT NOT NULL,
        UNIQUE (med_id, day, slot)
      );
      CREATE INDEX doses_day ON doses (day);

      CREATE TABLE food (id TEXT PRIMARY KEY, day TEXT NOT NULL, at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX food_day ON food (day);
      CREATE TABLE foods_saved (
        id        TEXT PRIMARY KEY,
        name_key  TEXT NOT NULL UNIQUE,
        uses      INTEGER NOT NULL DEFAULT 0,
        last_used TEXT,
        json      TEXT NOT NULL
      );
      CREATE TABLE weights (day TEXT PRIMARY KEY, kg10 INTEGER NOT NULL CHECK (kg10 BETWEEN 200 AND 4000), at TEXT NOT NULL);

      CREATE TABLE places (id TEXT PRIMARY KEY, best INTEGER, updated_at TEXT NOT NULL, json TEXT NOT NULL);

      CREATE TABLE money (
        id       TEXT PRIMARY KEY,
        month    TEXT NOT NULL,
        day      TEXT NOT NULL,
        kind     TEXT NOT NULL,
        category TEXT NOT NULL,
        amount   INTEGER NOT NULL,
        json     TEXT NOT NULL
      );
      CREATE INDEX money_month ON money (month);
      CREATE TABLE budgets (category TEXT PRIMARY KEY, amount INTEGER NOT NULL);
      CREATE TABLE bills (id TEXT PRIMARY KEY, next_due TEXT NOT NULL, json TEXT NOT NULL);

      CREATE TABLE pings (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        ref          TEXT NOT NULL,
        sub          TEXT NOT NULL DEFAULT '',
        next_at      TEXT,
        claimed_at   TEXT,
        failures     INTEGER NOT NULL DEFAULT 0,
        last_sent_at TEXT,
        UNIQUE (kind, ref, sub)
      );
      CREATE INDEX pings_next ON pings (next_at) WHERE next_at IS NOT NULL;
    `,
  },
  {
    // v0.7: life.db's first schema change. A 0.6.1 daemon refuses a schema-2 file (newer_schema), so going
    // back means restoring a backup taken before the upgrade (docs/upgrading.md). Pings need no change:
    // `kind` has no CHECK, and a post rings as kind 'post'. Weekly goals live in meta('post_goals').
    version: 2,
    name: 'posts',
    sql: `
      CREATE TABLE posts (id TEXT PRIMARY KEY, status TEXT NOT NULL, due_day TEXT, posted_at TEXT, updated_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX posts_open ON posts (status, due_day);
    `,
  },
];

/** The schema this build writes and reads. A file with a newer one is refused, never downgraded. */
export const LIFE_SCHEMA_VERSION = Math.max(...LIFE_MIGRATIONS.map((m) => m.version));

/**
 * Why an open was refused, for logs only (`{ event: 'life.broken', code }`).
 * The phone only ever sees LIFE_BROKEN_REASON.
 */
export type LifeOpenFailure = 'not_sqlite' | 'truncated' | 'open_failed' | 'corrupt' | 'newer_schema' | 'migration_failed';

export type LifeOpenResult = { ok: true; db: LifeDb } | { ok: false; code: LifeOpenFailure; reason: string };

type SqliteModule = typeof import('node:sqlite');
let sqliteModule: SqliteModule | undefined;

/** node:sqlite, loaded once with its ExperimentalWarning filtered (as db/sqlite.ts does). */
function sqlite(): SqliteModule {
  if (sqliteModule) return sqliteModule;
  const require = createRequire(import.meta.url);
  const original = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (typeof text === 'string' && text.startsWith('SQLite is an experimental feature')) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    sqliteModule = require('node:sqlite') as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

const MAGIC = Buffer.from('SQLite format 3\u0000', 'latin1');

/** Size of `file` in bytes, or 0 when it is missing. */
function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Header checks before SQLite ever opens the file, so a file that is not a
 * database, or one cut short, is refused without SQLite reading (or
 * creating anything beside) it: the magic string, and a size that holds the
 * page count the header gives (when that count is valid, header bytes 92
 * and 24 agree). With a non-empty `-wal` beside it the size says nothing (a
 * crash between a checkpoint's first page and the file growing leaves a
 * short file the WAL completes), so only quick_check judges it.
 */
function headerProblem(file: string): LifeOpenFailure | null {
  const walPending = sizeOf(`${file}-wal`) > 0;
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return null; // an empty file is a new database
    const head = Buffer.alloc(100);
    const n = readSync(fd, head, 0, 100, 0);
    if (n < 100 || !head.subarray(0, 16).equals(MAGIC)) return 'not_sqlite';
    const rawPage = head.readUInt16BE(16);
    const pageSize = rawPage === 1 ? 65_536 : rawPage;
    if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0) return 'not_sqlite';
    if (walPending) return null;
    const pages = head.readUInt32BE(28);
    const valid = head.readUInt32BE(92) === head.readUInt32BE(24);
    if (valid && pages > 0 && size < pages * pageSize) return 'truncated';
    if (size % pageSize !== 0) return 'truncated';
    return null;
  } finally {
    closeSync(fd);
  }
}

/** What a checked open needs: the file's own migrations and the sentence its routes answer while it is refused. */
export interface CheckedDbOptions {
  migrations: readonly LifeMigration[];
  brokenReason: string;
  /** Pragmas for this file's every connection, set with WAL (meetings.db: secure_delete). */
  pragmas?: readonly string[];
}

function build(raw: DatabaseSync, file: string): LifeDb {
  const cache = new Map<string, StatementSync>();
  let depth = 0;
  const prepare = (sql: string): StatementSync => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  return {
    raw,
    file,
    prepare,
    tx<T>(fn: () => T): T {
      if (depth > 0) {
        depth += 1;
        try {
          return fn();
        } finally {
          depth -= 1;
        }
      }
      raw.exec('BEGIN IMMEDIATE');
      depth = 1;
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw e;
      } finally {
        depth = 0;
      }
    },
    meta(key: string): string | undefined {
      const row = prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value;
    },
    setMeta(key: string, value: string): void {
      prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
    },
    deleteMeta(key: string): void {
      prepare('DELETE FROM meta WHERE key = ?').run(key);
    },
    close(): void {
      try {
        raw.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/** The applied schema version: meta('schema'), 0 before the first migration. */
function schemaOf(raw: DatabaseSync): number {
  const table = raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!table) return 0;
  const row = raw.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | undefined;
  const n = Number(row?.value ?? 0);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function migrate(raw: DatabaseSync, from: number, migrations: readonly LifeMigration[]): void {
  for (const m of migrations) {
    if (m.version <= from) continue;
    raw.exec('BEGIN IMMEDIATE');
    try {
      raw.exec(m.sql);
      raw.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(m.version));
      raw.exec('COMMIT');
    } catch (e) {
      raw.exec('ROLLBACK');
      throw e;
    }
  }
}

function closeQuietly(raw: DatabaseSync): void {
  try {
    raw.close();
  } catch {
    /* already closed */
  }
}

/** busy_timeout, then `quick_check` and the schema version (newer than `latest` is refused): a refusal code, or the schema. */
function checked(raw: DatabaseSync, latest: number): { code: LifeOpenFailure } | { schema: number } {
  let schema: number;
  try {
    raw.exec('PRAGMA busy_timeout = 2000');
    const check = raw.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    const verdict = check ? String(Object.values(check)[0]) : 'ok';
    if (verdict !== 'ok') return { code: 'corrupt' };
    schema = schemaOf(raw);
  } catch {
    return { code: 'corrupt' };
  }
  return schema > latest ? { code: 'newer_schema' } : { schema };
}

/**
 * The refusal checks on a file that exists, through a read-only connection:
 * closing it never checkpoints a WAL into a file being refused, nor deletes
 * that WAL. A read-only connection to a WAL-mode file still makes an empty
 * `-wal` and a `-shm` when they are missing; those two are removed again, so
 * nothing is left beside a refused file.
 */
function checkReadOnly(path: string, latest: number): { code: LifeOpenFailure } | { schema: number } {
  const had = { wal: existsSync(`${path}-wal`), shm: existsSync(`${path}-shm`) };
  let raw: DatabaseSync;
  try {
    const { DatabaseSync } = sqlite();
    raw = new DatabaseSync(path, { readOnly: true });
  } catch {
    return { code: 'open_failed' };
  }
  const out = checked(raw, latest);
  closeQuietly(raw);
  try {
    if (!had.wal && existsSync(`${path}-wal`) && sizeOf(`${path}-wal`) === 0) unlinkSync(`${path}-wal`);
    if (!had.shm && existsSync(`${path}-shm`)) unlinkSync(`${path}-shm`);
  } catch {
    /* best effort: an empty -wal and a -shm hold no data */
  }
  return out;
}

/**
 * Open (creating and migrating) life.db at `path`, or ":memory:" (tests).
 * A refusal answers LIFE_BROKEN_REASON.
 */
export function openLifeDb(path: string): LifeOpenResult {
  return openCheckedDb(path, { migrations: LIFE_MIGRATIONS, brokenReason: LIFE_BROKEN_REASON });
}

/**
 * Open (creating and migrating) a database that is refused, never reset, at
 * `path`, or ":memory:" (tests). Order: header checks; then, on a read-only
 * connection, `quick_check` and the schema version; then the real
 * connection with busy_timeout and foreign keys, the pending migrations
 * (each in one transaction, rolled back on a failure, so a refused file is
 * not changed), and only then WAL and the file's own pragmas. Every check
 * that can refuse runs before anything is written. Its migrations record
 * their version in `meta('schema')`, so the first one must create the
 * `meta` table.
 */
export function openCheckedDb(path: string, opts: CheckedDbOptions): LifeOpenResult {
  const latest = Math.max(...opts.migrations.map((m) => m.version));
  const refused = (code: LifeOpenFailure): LifeOpenResult => ({ ok: false, code, reason: opts.brokenReason });
  const memory = path === ':memory:';
  const fresh = !memory && !existsSync(path);
  if (fresh) {
    try {
      closeSync(openSync(path, 'wx', 0o600));
      chmodSync(path, 0o600);
    } catch {
      // The state dir is missing or not writable (or the file appeared since).
      return refused('open_failed');
    }
  } else if (!memory) {
    try {
      const problem = headerProblem(path);
      if (problem) return refused(problem);
    } catch {
      return refused('open_failed');
    }
    const ro = checkReadOnly(path, latest);
    if ('code' in ro) return refused(ro.code);
  }
  let raw: DatabaseSync;
  try {
    const { DatabaseSync } = sqlite();
    raw = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  } catch {
    return refused('open_failed');
  }
  const fail = (code: LifeOpenFailure): LifeOpenResult => {
    closeQuietly(raw);
    return refused(code);
  };
  // Again on the real connection: the file can have changed since, and a new file was never checked.
  const rw = checked(raw, latest);
  if ('code' in rw) return fail(rw.code);
  try {
    raw.exec('PRAGMA foreign_keys = ON');
    migrate(raw, rw.schema, opts.migrations);
  } catch {
    return fail('migration_failed');
  }
  try {
    if (!memory) raw.prepare('PRAGMA journal_mode = WAL').get();
    raw.exec('PRAGMA synchronous = NORMAL');
    for (const pragma of opts.pragmas ?? []) raw.exec(pragma);
  } catch {
    return fail('open_failed');
  }
  if (!memory) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
      } catch {
        /* best effort */
      }
    }
  }
  return { ok: true, db: build(raw, path) };
}
