/**
 * The daemon's SQLite database (node:sqlite, WAL mode) at paths.dbFile.
 *
 * - One file, mode 0600, in the 0700 state dir. The daemon is the only writer.
 * - Migrations run once each, in order, inside a transaction.
 * - Retention: the newest EVENT_RING_SIZE non-alert events (the replay ring),
 *   the newest ALERT_HISTORY_CAP alert events (GET /v1/alerts), and caps on
 *   audit (successful and refused rows counted apart), pending history and
 *   the v0.3 tables (launches, folders seen, rewrite runs), applied every
 *   PRUNE_EVERY writes.
 * - A file that is not a database (or is corrupt) is moved aside to
 *   `<file>.corrupt-<time>` and a fresh one is created, so a bad file never
 *   stops the daemon from starting. Nothing outside the state dir is touched.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType, StatementSync } from 'node:sqlite';
import {
  ALERT_EVENT_TYPES,
  EVENT_RING_SIZE,
  LAUNCH_FINAL_STAGES,
  type AuditEntry,
  type DaemonEvent,
  type Device,
  type EventType,
  type LaunchFlags,
  type LaunchJob,
  type NodeOs,
  type PendingRequest,
  type PushSubscriptionRecord,
  type Scope,
} from '@jantar/protocol';
import type {
  AuditLog,
  Db,
  DeviceRepo,
  EventLog,
  ExtensionRecord,
  ExtensionsRepo,
  FolderPin,
  FolderRepo,
  FolderSeen,
  KvStore,
  LaunchFlagsRepo,
  LaunchRepo,
  Logger,
  NodeRecord,
  NodesRepo,
  PendingHistory,
  PushSubRepo,
  RewriteRun,
  RewriteRunRepo,
} from '../contracts.js';
import { silentLogger } from '../core/log.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema.js';

/** Alert events kept for the alerts feed (independent of the replay ring). */
export const ALERT_HISTORY_CAP = 1000;
/** Audit rows kept per result class: AUDIT_CAP 'ok' rows plus AUDIT_CAP refused/failed rows. */
export const AUDIT_CAP = 20_000;
export const PENDING_HISTORY_CAP = 5000;
/** v0.3 retention: launches, folders seen and rewrite runs kept. */
export const LAUNCH_HISTORY_CAP = 1000;
export const FOLDERS_SEEN_CAP = 2000;
export const REWRITE_RUNS_CAP = 5000;
/** Retention runs after this many writes (and once at open). */
export const PRUNE_EVERY = 100;

const ALERT_TYPES: ReadonlySet<string> = new Set(ALERT_EVENT_TYPES);
const HIGH_WATER_KEY = 'events.high_water';

type SqliteModule = typeof import('node:sqlite');
let sqliteModule: SqliteModule | undefined;

/**
 * Load node:sqlite once. Node 22 prints an ExperimentalWarning when the
 * module loads; that one warning is filtered so the daemon log stays clean.
 */
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

export interface OpenSqliteOptions {
  log?: Logger;
  /** Override the replay ring size (tests). */
  ringSize?: number;
  /** Override the alert history cap (tests). */
  alertCap?: number;
  auditCap?: number;
  pendingCap?: number;
  /** Clock for kv `updated_at` and corrupt-file names. */
  now?: () => number;
}

export type SqliteDb = Db & {
  /** The underlying connection (tests and diagnostics only). */
  readonly raw: DatabaseSyncType;
  readonly file: string;
  /** Run the retention policy now. */
  pruneNow(): void;
  /** Applied schema version. */
  schemaVersion(): number;
};

const NOT_A_DB = /file is not a database|database disk image is malformed|SQLITE_NOTADB|SQLITE_CORRUPT/i;

/**
 * Copy the SQLite file at `src` to `dest` (which must not exist yet) with
 * VACUUM INTO on a read-only connection: a consistent snapshot even while
 * another process writes to `src`, and `src` itself is never written. The
 * copy is made 0600. Reading a WAL-mode file makes SQLite create an empty
 * `-wal` and a `-shm` beside it (it needs them to read; they hold no data):
 * the ones this copy created are removed again, unless a writer has put
 * something in the `-wal` since, so nothing new is left beside `src`.
 */
export function copySqliteFile(src: string, dest: string): void {
  const { DatabaseSync } = sqlite();
  const made = ['-wal', '-shm'].filter((suffix) => !existsSync(src + suffix));
  const db = new DatabaseSync(src, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('VACUUM INTO ?').run(dest);
  } finally {
    db.close();
  }
  chmodSync(dest, 0o600);
  try {
    if (made.includes('-wal') && existsSync(`${src}-wal`) && statSync(`${src}-wal`).size > 0) return;
    for (const suffix of made) rmSync(src + suffix, { force: true });
  } catch {
    // Left beside src: they hold no data.
  }
}

/** Open (creating and migrating) the database at `file`. */
export function openSqliteFile(file: string, opts: OpenSqliteOptions = {}): SqliteDb {
  const log = opts.log ?? silentLogger;
  const now = opts.now ?? Date.now;
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (!existsSync(file)) closeSync(openSync(file, 'a', 0o600));
    chmodSync(file, 0o600);
  }
  try {
    return connect(file, opts, log, now);
  } catch (e) {
    if (file === ':memory:' || !NOT_A_DB.test(String((e as Error)?.message ?? e))) throw e;
    const aside = `${file}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`;
    log.error('database file is unreadable; moving it aside and starting fresh', { file, aside, error: String(e) });
    renameSync(file, aside);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(file + suffix)) renameSync(file + suffix, aside + suffix);
    }
    closeSync(openSync(file, 'a', 0o600));
    chmodSync(file, 0o600);
    return connect(file, opts, log, now);
  }
}

function connect(file: string, opts: OpenSqliteOptions, log: Logger, now: () => number): SqliteDb {
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (file !== ':memory:') {
      const row = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string } | undefined;
      if (row?.journal_mode !== 'wal') log.warn('database is not in WAL mode', { mode: row?.journal_mode });
    }
    db.exec('PRAGMA synchronous = NORMAL');
    migrate(db, log, now);
    // Fail fast on a corrupt file (quick_check reads every page header).
    const check = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    const verdict = check ? String(Object.values(check)[0]) : 'ok';
    if (verdict !== 'ok') throw new Error(`SQLITE_CORRUPT: ${verdict}`);
  } catch (e) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    throw e;
  }
  if (file !== ':memory:') {
    for (const suffix of ['-wal', '-shm']) {
      try {
        if (existsSync(file + suffix)) chmodSync(file + suffix, 0o600);
      } catch {
        /* best effort */
      }
    }
  }
  return build(db, file, opts, now);
}

function migrate(db: DatabaseSyncType, log: Logger, now: () => number): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    (db.prepare('SELECT version FROM migrations').all() as { version: number }[]).map((r) => Number(r.version)),
  );
  const highest = Math.max(0, ...applied);
  if (highest > LATEST_SCHEMA_VERSION) {
    log.warn('database was written by a newer Jantar; continuing with the known tables', {
      dbVersion: highest,
      known: LATEST_SCHEMA_VERSION,
    });
  }
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date(now()).toISOString(),
      );
      db.exec('COMMIT');
      log.info('database migrated', { version: m.version, name: m.name });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parse<T>(text: unknown): T {
  return JSON.parse(String(text)) as T;
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

function build(db: DatabaseSyncType, file: string, opts: OpenSqliteOptions, now: () => number): SqliteDb {
  const ringSize = Math.max(1, opts.ringSize ?? EVENT_RING_SIZE);
  const alertCap = Math.max(1, opts.alertCap ?? ALERT_HISTORY_CAP);
  const auditCap = Math.max(1, opts.auditCap ?? AUDIT_CAP);
  const pendingCap = Math.max(1, opts.pendingCap ?? PENDING_HISTORY_CAP);
  const cache = new Map<string, StatementSync>();
  const stmt = (sql: string): StatementSync => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  let writes = 0;
  let closed = false;

  const metaGet = (key: string): string | undefined => {
    const row = stmt('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  };
  const metaSet = (key: string, value: string): void => {
    stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  };

  const pruneNow = (): void => {
    stmt(
      `DELETE FROM events WHERE is_alert = 0 AND seq < (
         SELECT MIN(seq) FROM (SELECT seq FROM events WHERE is_alert = 0 ORDER BY seq DESC LIMIT ?))`,
    ).run(ringSize);
    stmt(
      `DELETE FROM events WHERE is_alert = 1 AND seq < (
         SELECT MIN(seq) FROM (SELECT seq FROM events WHERE is_alert = 1 ORDER BY seq DESC LIMIT ?))`,
    ).run(alertCap);
    // Successful writes and refusals/failures have separate budgets, so a
    // flood of refused requests can never push real entries out.
    stmt(
      `DELETE FROM audit WHERE result = 'ok' AND seq < (
         SELECT MIN(seq) FROM (SELECT seq FROM audit WHERE result = 'ok' ORDER BY seq DESC LIMIT ?))`,
    ).run(auditCap);
    stmt(
      `DELETE FROM audit WHERE result <> 'ok' AND seq < (
         SELECT MIN(seq) FROM (SELECT seq FROM audit WHERE result <> 'ok' ORDER BY seq DESC LIMIT ?))`,
    ).run(auditCap);
    stmt(
      `DELETE FROM pending WHERE id IN (
         SELECT id FROM pending ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)`,
    ).run(pendingCap);
    stmt(
      `DELETE FROM launches WHERE id IN (
         SELECT id FROM launches ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)`,
    ).run(LAUNCH_HISTORY_CAP);
    stmt(
      `DELETE FROM folders_seen WHERE cwd IN (
         SELECT cwd FROM folders_seen ORDER BY last_seen_at DESC, cwd DESC LIMIT -1 OFFSET ?)`,
    ).run(FOLDERS_SEEN_CAP);
    stmt(
      `DELETE FROM rewrite_runs WHERE id IN (
         SELECT id FROM rewrite_runs ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?)`,
    ).run(REWRITE_RUNS_CAP);
  };
  const wrote = (): void => {
    writes += 1;
    if (writes % PRUNE_EVERY === 0) pruneNow();
  };

  const typeFilter = (types: readonly EventType[] | undefined): { sql: string; args: string[] } =>
    types && types.length > 0 ? { sql: ` AND type IN (${placeholders(types.length)})`, args: [...types] } : { sql: '', args: [] };

  const events: EventLog = {
    append(ev: DaemonEvent) {
      stmt(
        `INSERT INTO events (seq, ts, type, sid, account, is_alert, json) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(seq) DO UPDATE SET ts = excluded.ts, type = excluded.type, sid = excluded.sid,
           account = excluded.account, is_alert = excluded.is_alert, json = excluded.json`,
      ).run(ev.seq, ev.ts, ev.type, ev.sid ?? null, ev.account ?? null, ALERT_TYPES.has(ev.type) ? 1 : 0, json(ev));
      const hw = Number(metaGet(HIGH_WATER_KEY) ?? 0);
      if (ev.seq > hw) metaSet(HIGH_WATER_KEY, String(ev.seq));
      wrote();
    },
    since(after, opts = {}) {
      const f = typeFilter(opts.types);
      const limit = opts.limit ?? -1;
      const rows = stmt(`SELECT json FROM events WHERE seq > ?${f.sql} ORDER BY seq ASC LIMIT ?`).all(
        after,
        ...f.args,
        limit,
      ) as { json: string }[];
      return rows.map((r) => parse<DaemonEvent>(r.json));
    },
    latest(opts) {
      const f = typeFilter(opts.types);
      const rows = stmt(`SELECT json FROM events WHERE seq > ?${f.sql} ORDER BY seq DESC LIMIT ?`).all(
        opts.after ?? 0,
        ...f.args,
        Math.max(0, opts.limit),
      ) as { json: string }[];
      return rows.map((r) => parse<DaemonEvent>(r.json));
    },
    maxSeq() {
      const row = stmt('SELECT MAX(seq) AS m FROM events').get() as { m: number | null } | undefined;
      return Math.max(Number(row?.m ?? 0), Number(metaGet(HIGH_WATER_KEY) ?? 0));
    },
    prune(keep) {
      const r = stmt(
        `DELETE FROM events WHERE seq NOT IN (SELECT seq FROM events ORDER BY seq DESC LIMIT ?)`,
      ).run(Math.max(0, keep));
      return Number(r.changes);
    },
  };

  type AuditRow = {
    seq: number;
    ts: string;
    actor: string;
    action: string;
    target: string | null;
    params: string;
    result: AuditEntry['result'];
    detail: string | null;
  };
  const auditFrom = (r: AuditRow): AuditEntry => {
    const e: AuditEntry = {
      seq: Number(r.seq),
      ts: r.ts,
      actor: r.actor,
      action: r.action,
      params: parse(r.params),
      result: r.result,
    };
    if (r.target !== null) e.target = r.target;
    if (r.detail !== null) e.detail = r.detail;
    return e;
  };
  const audit: AuditLog = {
    append(entry) {
      const r = stmt(
        'INSERT INTO audit (ts, actor, action, target, params, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(entry.ts, entry.actor, entry.action, entry.target ?? null, json(entry.params), entry.result, entry.detail ?? null);
      wrote();
      const full: AuditEntry = { ...structuredClone(entry), seq: Number(r.lastInsertRowid) };
      if (full.params === undefined) full.params = null;
      return full;
    },
    list(opts = {}) {
      const limit = opts.limit ?? 100;
      if (opts.after !== undefined) {
        return (stmt('SELECT * FROM audit WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(opts.after, limit) as AuditRow[]).map(
          auditFrom,
        );
      }
      const rows = stmt('SELECT * FROM audit ORDER BY seq DESC LIMIT ?').all(limit) as AuditRow[];
      return rows.reverse().map(auditFrom);
    },
  };

  type DeviceRow = {
    id: string;
    name: string;
    key_hash: string;
    secret_hash: string | null;
    scopes: string;
    created_at: string;
    last_seen_at: string;
    revoked_at: string | null;
    user_agent: string | null;
  };
  const deviceFrom = (r: DeviceRow): Device => {
    const d: Device = {
      id: r.id,
      name: r.name,
      keyHash: r.key_hash,
      scopes: parse<Scope[]>(r.scopes),
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
    };
    if (r.secret_hash !== null && r.secret_hash !== undefined) d.secretHash = r.secret_hash;
    if (r.revoked_at !== null) d.revokedAt = r.revoked_at;
    if (r.user_agent !== null) d.userAgent = r.user_agent;
    return d;
  };
  const devices: DeviceRepo = {
    insert(d) {
      stmt(
        `INSERT INTO devices (id, name, key_hash, secret_hash, scopes, created_at, last_seen_at, revoked_at, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        d.id,
        d.name,
        d.keyHash,
        d.secretHash ?? null,
        json(d.scopes),
        d.createdAt,
        d.lastSeenAt,
        d.revokedAt ?? null,
        d.userAgent ?? null,
      );
      wrote();
    },
    get(id) {
      const r = stmt('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
      return r ? deviceFrom(r) : null;
    },
    byKeyHash(hash) {
      const r = stmt('SELECT * FROM devices WHERE key_hash = ?').get(hash) as DeviceRow | undefined;
      return r ? deviceFrom(r) : null;
    },
    list() {
      return (stmt('SELECT * FROM devices ORDER BY created_at ASC, id ASC').all() as DeviceRow[]).map(deviceFrom);
    },
    touch(id, at) {
      stmt('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(at, id);
    },
    revoke(id, at) {
      stmt('UPDATE devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(at, id);
      wrote();
      return devices.get(id);
    },
    setScopes(id, scopes) {
      stmt('UPDATE devices SET scopes = ? WHERE id = ?').run(json(scopes), id);
      wrote();
      return devices.get(id);
    },
  };

  const pushSubs: PushSubRepo = {
    upsert(rec) {
      stmt(
        `INSERT INTO push_subs (endpoint, device_id, json, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id, json = excluded.json,
           created_at = excluded.created_at`,
      ).run(rec.subscription.endpoint, rec.deviceId, json(rec), rec.createdAt);
      wrote();
    },
    remove(endpoint) {
      return Number(stmt('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint).changes) > 0;
    },
    removeForDevice(deviceId) {
      return Number(stmt('DELETE FROM push_subs WHERE device_id = ?').run(deviceId).changes);
    },
    list() {
      return (stmt('SELECT json FROM push_subs ORDER BY created_at ASC, endpoint ASC').all() as { json: string }[]).map((r) =>
        parse<PushSubscriptionRecord>(r.json),
      );
    },
  };

  const pending: PendingHistory = {
    record(p) {
      stmt(
        `INSERT INTO pending (id, sid, created_at, state, json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET sid = excluded.sid, created_at = excluded.created_at,
           state = excluded.state, json = excluded.json`,
      ).run(p.id, p.sid, p.createdAt, p.state, json(p));
      wrote();
    },
    get(id) {
      const r = stmt('SELECT json FROM pending WHERE id = ?').get(id) as { json: string } | undefined;
      return r ? parse<PendingRequest>(r.json) : null;
    },
    list(opts = {}) {
      const limit = opts.limit ?? -1;
      const rows = (
        opts.sid
          ? stmt('SELECT json FROM pending WHERE sid = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(opts.sid, limit)
          : stmt('SELECT json FROM pending ORDER BY created_at DESC, id DESC LIMIT ?').all(limit)
      ) as { json: string }[];
      return rows.map((r) => parse<PendingRequest>(r.json));
    },
  };

  const kv: KvStore = {
    get<T = unknown>(key: string): T | undefined {
      const r = stmt('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
      return r ? parse<T>(r.value) : undefined;
    },
    set(key, value) {
      stmt(
        'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ).run(key, json(value), new Date(now()).toISOString());
    },
    delete(key) {
      stmt('DELETE FROM kv WHERE key = ?').run(key);
    },
  };

  const finalStages: ReadonlySet<string> = new Set(LAUNCH_FINAL_STAGES);
  const launches: LaunchRepo = {
    save(job) {
      stmt(
        `INSERT INTO launches (id, created_at, stage, sid, json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, stage = excluded.stage,
           sid = excluded.sid, json = excluded.json`,
      ).run(job.id, job.createdAt, job.stage, job.sid, json(job));
      wrote();
    },
    get(id) {
      const r = stmt('SELECT json FROM launches WHERE id = ?').get(id) as { json: string } | undefined;
      return r ? parse<LaunchJob>(r.json) : null;
    },
    list(opts = {}) {
      const rows = stmt('SELECT stage, json FROM launches ORDER BY created_at DESC, id DESC').all() as { stage: string; json: string }[];
      const out = rows.filter((r) => !opts.unfinished || !finalStages.has(r.stage)).map((r) => parse<LaunchJob>(r.json));
      return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
    },
  };

  type SeenRow = { cwd: string; last_seen_at: string; account: number | null; name: string | null };
  type PinRow = { root_id: string; rel: string; label: string | null; pinned_at: string; by: string };
  const folders: FolderRepo = {
    pin(p) {
      stmt(
        `INSERT INTO folders_pinned (root_id, rel, label, pinned_at, by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(root_id, rel) DO UPDATE SET label = excluded.label, pinned_at = excluded.pinned_at, by = excluded.by`,
      ).run(p.rootId, p.rel, p.label ?? null, p.pinnedAt, p.by);
      wrote();
    },
    unpin(rootId, rel) {
      const r = stmt('DELETE FROM folders_pinned WHERE root_id = ? AND rel = ?').run(rootId, rel);
      wrote();
      return Number(r.changes) > 0;
    },
    pins() {
      return (stmt('SELECT * FROM folders_pinned ORDER BY pinned_at ASC, root_id ASC, rel ASC').all() as PinRow[]).map((r) => {
        const p: FolderPin = { rootId: r.root_id, rel: r.rel, pinnedAt: r.pinned_at, by: r.by };
        if (r.label !== null) p.label = r.label;
        return p;
      });
    },
    seen(row) {
      stmt(
        `INSERT INTO folders_seen (cwd, last_seen_at, account, name) VALUES (?, ?, ?, ?)
         ON CONFLICT(cwd) DO UPDATE SET last_seen_at = excluded.last_seen_at, account = excluded.account, name = excluded.name`,
      ).run(row.cwd, row.lastSeenAt, row.account ?? null, row.name ?? null);
      wrote();
    },
    recentSeen(limit) {
      const rows = stmt('SELECT * FROM folders_seen ORDER BY last_seen_at DESC, cwd ASC LIMIT ?').all(Math.max(0, limit)) as SeenRow[];
      return rows.map((r) => {
        const f: FolderSeen = { cwd: r.cwd, lastSeenAt: r.last_seen_at };
        if (r.account !== null) f.account = Number(r.account);
        if (r.name !== null) f.name = r.name;
        return f;
      });
    },
  };

  const launchFlags: LaunchFlagsRepo = {
    get(actor) {
      const r = stmt('SELECT json FROM launch_flags WHERE actor = ?').get(actor) as { json: string } | undefined;
      return r ? parse<LaunchFlags>(r.json) : null;
    },
    set(actor, flags, at) {
      stmt(
        `INSERT INTO launch_flags (actor, json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(actor) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      ).run(actor, json(flags), at);
      wrote();
    },
  };

  type RunRow = {
    id: string;
    at: string;
    account: number | null;
    model: string;
    ok: number;
    ms: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    prompt_version: string | null;
    outcome: string;
  };
  const num = (v: number | null): number | null => (v === null ? null : Number(v));
  const rewriteRuns: RewriteRunRepo = {
    record(run) {
      stmt(
        `INSERT INTO rewrite_runs (id, at, account, model, ok, ms, input_tokens, output_tokens, prompt_version, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET at = excluded.at, account = excluded.account, model = excluded.model, ok = excluded.ok,
           ms = excluded.ms, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
           prompt_version = excluded.prompt_version, outcome = excluded.outcome`,
      ).run(run.id, run.at, run.account, run.model, run.ok ? 1 : 0, run.ms, run.inputTokens, run.outputTokens, run.promptVersion, run.outcome);
      wrote();
    },
    list(opts = {}) {
      const rows = stmt('SELECT * FROM rewrite_runs ORDER BY at DESC, id DESC LIMIT ?').all(opts.limit ?? -1) as RunRow[];
      return rows.map(
        (r): RewriteRun => ({
          id: r.id,
          at: r.at,
          account: num(r.account),
          model: r.model,
          ok: Number(r.ok) === 1,
          ms: num(r.ms),
          inputTokens: num(r.input_tokens),
          outputTokens: num(r.output_tokens),
          promptVersion: r.prompt_version,
          outcome: r.outcome,
        }),
      );
    },
  };

  type ExtensionRow = {
    id: string;
    key_hash: string;
    origin: string;
    created_at: string;
    last_seen_at: string | null;
    revoked_at: string | null;
  };
  const extensionFrom = (r: ExtensionRow): ExtensionRecord => ({
    id: r.id,
    keyHash: r.key_hash,
    origin: r.origin,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    revokedAt: r.revoked_at,
  });
  const extensions: ExtensionsRepo = {
    insert(e) {
      stmt(
        'INSERT INTO extensions (id, key_hash, origin, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(e.id, e.keyHash, e.origin, e.createdAt, e.lastSeenAt, e.revokedAt);
      wrote();
    },
    get(id) {
      const r = stmt('SELECT * FROM extensions WHERE id = ?').get(id) as ExtensionRow | undefined;
      return r ? extensionFrom(r) : null;
    },
    byKeyHash(hash) {
      const r = stmt('SELECT * FROM extensions WHERE key_hash = ?').get(hash) as ExtensionRow | undefined;
      return r ? extensionFrom(r) : null;
    },
    list() {
      return (stmt('SELECT * FROM extensions ORDER BY created_at ASC, id ASC').all() as ExtensionRow[]).map(extensionFrom);
    },
    touch(id, at) {
      stmt('UPDATE extensions SET last_seen_at = ? WHERE id = ?').run(at, id);
    },
    revoke(id, at) {
      stmt('UPDATE extensions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(at, id);
      wrote();
      return extensions.get(id);
    },
  };

  type NodeRow = {
    id: string;
    name: string;
    public_key: string;
    os: string;
    version: string;
    created_at: string;
    last_seen_at: string | null;
    revoked_at: string | null;
  };
  const nodeFrom = (r: NodeRow): NodeRecord => ({
    id: r.id,
    name: r.name,
    publicKey: r.public_key,
    os: r.os as NodeOs,
    version: r.version,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    revokedAt: r.revoked_at,
  });
  const nodes: NodesRepo = {
    insert(n) {
      stmt(
        'INSERT INTO nodes (id, name, public_key, os, version, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(n.id, n.name, n.publicKey, n.os, n.version, n.createdAt, n.lastSeenAt, n.revokedAt);
      wrote();
    },
    get(id) {
      const r = stmt('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
      return r ? nodeFrom(r) : null;
    },
    byName(name) {
      const r = stmt('SELECT * FROM nodes WHERE name = ? AND revoked_at IS NULL').get(name) as NodeRow | undefined;
      return r ? nodeFrom(r) : null;
    },
    list() {
      return (stmt('SELECT * FROM nodes ORDER BY created_at ASC, id ASC').all() as NodeRow[]).map(nodeFrom);
    },
    touch(id, at) {
      stmt('UPDATE nodes SET last_seen_at = ? WHERE id = ?').run(at, id);
    },
    setInfo(id, info) {
      stmt('UPDATE nodes SET os = ?, version = ? WHERE id = ?').run(info.os, info.version, id);
    },
    revoke(id, at) {
      stmt('UPDATE nodes SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(at, id);
      wrote();
      return nodes.get(id);
    },
  };

  pruneNow();

  return {
    raw: db,
    file,
    events,
    audit,
    devices,
    pushSubs,
    pending,
    kv,
    launches,
    folders,
    launchFlags,
    rewriteRuns,
    extensions,
    nodes,
    pruneNow,
    schemaVersion() {
      const row = db.prepare('SELECT MAX(version) AS v FROM migrations').get() as { v: number | null } | undefined;
      return Number(row?.v ?? 0);
    },
    close() {
      if (closed) return;
      closed = true;
      cache.clear();
      try {
        db.exec('PRAGMA optimize');
      } catch {
        /* best effort */
      }
      db.close();
    },
  };
}
