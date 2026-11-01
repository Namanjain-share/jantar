/**
 * SQLite schema, as an ordered list of migrations. Each migration runs once,
 * inside a transaction, and is recorded in the `migrations` table. Never edit
 * a migration that has shipped: add a new one.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Replay ring of daemon events (the newest EVENT_RING_SIZE), plus a
      -- longer history of alert events for GET /v1/alerts.
      CREATE TABLE events (
        seq      INTEGER PRIMARY KEY,
        ts       TEXT    NOT NULL,
        type     TEXT    NOT NULL,
        sid      TEXT,
        account  INTEGER,
        is_alert INTEGER NOT NULL DEFAULT 0,
        json     TEXT    NOT NULL
      );
      CREATE INDEX events_type ON events (type, seq);
      CREATE INDEX events_alert ON events (is_alert, seq);

      CREATE TABLE audit (
        seq    INTEGER PRIMARY KEY AUTOINCREMENT,
        ts     TEXT NOT NULL,
        actor  TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        params TEXT NOT NULL,
        result TEXT NOT NULL,
        detail TEXT
      );

      CREATE TABLE devices (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        key_hash     TEXT NOT NULL UNIQUE,
        scopes       TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at   TEXT,
        user_agent   TEXT
      );

      CREATE TABLE push_subs (
        endpoint   TEXT PRIMARY KEY,
        device_id  TEXT NOT NULL,
        json       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX push_subs_device ON push_subs (device_id);

      CREATE TABLE pending (
        id         TEXT PRIMARY KEY,
        sid        TEXT NOT NULL,
        created_at TEXT NOT NULL,
        state      TEXT NOT NULL,
        json       TEXT NOT NULL
      );
      CREATE INDEX pending_sid ON pending (sid, created_at);
      CREATE INDEX pending_created ON pending (created_at);

      CREATE TABLE kv (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'device secret',
    sql: `
      -- sha256 of each device's second credential (SEC-2). NULL for devices
      -- paired before it existed: they can read but must pair again to write.
      ALTER TABLE devices ADD COLUMN secret_hash TEXT;
    `,
  },
  {
    version: 3,
    name: 'v0.3 launches, folders, rewrite runs',
    // Additive only, and safe to run over tables that already exist.
    sql: `
      -- Every launch, saved at each stage change (the job as JSON).
      CREATE TABLE IF NOT EXISTS launches (
        id         TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        stage      TEXT NOT NULL,
        sid        TEXT,
        json       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS launches_created ON launches (created_at);

      CREATE TABLE IF NOT EXISTS folders_pinned (
        root_id   TEXT NOT NULL,
        rel       TEXT NOT NULL,
        label     TEXT,
        pinned_at TEXT NOT NULL,
        by        TEXT NOT NULL,
        PRIMARY KEY (root_id, rel)
      );

      -- Folders sessions ran in (one row per cwd, updated on every session.added).
      CREATE TABLE IF NOT EXISTS folders_seen (
        cwd          TEXT PRIMARY KEY,
        last_seen_at TEXT NOT NULL,
        account      INTEGER,
        name         TEXT
      );
      CREATE INDEX IF NOT EXISTS folders_seen_last ON folders_seen (last_seen_at);

      -- The launch flags each actor last started a session with.
      CREATE TABLE IF NOT EXISTS launch_flags (
        actor      TEXT PRIMARY KEY,
        json       TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- One row per Rewrite run, for burn attribution. Never any text.
      CREATE TABLE IF NOT EXISTS rewrite_runs (
        id             TEXT PRIMARY KEY,
        at             TEXT NOT NULL,
        account        INTEGER,
        model          TEXT NOT NULL,
        ok             INTEGER NOT NULL,
        ms             INTEGER,
        input_tokens   INTEGER,
        output_tokens  INTEGER,
        prompt_version TEXT,
        outcome        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rewrite_runs_at ON rewrite_runs (at);
    `,
  },
  {
    version: 4,
    name: 'v0.5 extension keys',
    // Additive: v0.4.1 opens a file at this schema and carries on with the tables it knows.
    sql: `
      -- Paired Chrome extensions (Meetings). Only the key's prefixed sha256 is
      -- kept; the Origin the claim came from is bound to it.
      CREATE TABLE IF NOT EXISTS extensions (
        id           TEXT PRIMARY KEY,
        key_hash     TEXT NOT NULL UNIQUE,
        origin       TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at   TEXT
      );
    `,
  },
  {
    version: 5,
    name: 'v0.6 nodes',
    // Additive: v0.5.3 (and v0.5.2) opens a file at this schema, warns, and carries on with the tables it knows.
    sql: `
      -- Paired servers (Fleet). Only each node's public key is kept; its
      -- name is the hub's, unique among live rows. A revoked row stays.
      CREATE TABLE IF NOT EXISTS nodes (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        public_key   TEXT NOT NULL,
        os           TEXT NOT NULL,
        version      TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at   TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS nodes_live_name ON nodes (name) WHERE revoked_at IS NULL;
    `,
  },
  {
    version: 6,
    name: 'v0.8 capture keys',
    // Additive: 0.7 opens a file at this schema, warns, and carries on with the tables it knows.
    sql: `
      -- The iOS Shortcut's keys (Intel's capture door). Only the key's
      -- prefixed sha256 is kept; a revoked row stays.
      CREATE TABLE IF NOT EXISTS capture_keys (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        key_hash     TEXT NOT NULL UNIQUE,
        created_at   TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at   TEXT
      );
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
