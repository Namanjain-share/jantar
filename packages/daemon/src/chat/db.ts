/**
 * chat.db (spec 0.10 B3): Chat's own SQLite file (node:sqlite, WAL), apart
 * from jantar.db, life.db and meetings.db.
 *
 * - Opened by life.db's checked open (life/db.ts openCheckedDb): REFUSED,
 *   NEVER RESET. A file that will not open, fails `quick_check`, carries a
 *   schema newer than this build or fails a migration is left as it is, and
 *   Chat answers 503 with CHAT_BROKEN_REASON until it is moved aside at the
 *   Mac (`jantar chat clear --broken`).
 * - A new file is created 0600 inside the 0700 state dir.
 * - secure_delete is on: a deleted turn's text is overwritten in the file,
 *   not left in free pages.
 * - Never in the nightly Life backup: chat text never lands in backups/,
 *   except the one copy kept before a schema change (v0.12:
 *   backups/chat-pre-<version>.db, 0600, which Life's restore never reads).
 *
 * Rows: `turns` (a turn without its changes and cards, zod-checked JSON),
 * `changes` (each direct write and, while Undo works, its journal of prior
 * values), `confirms` (each card and the checked action its tap runs) and
 * `photos` (the file under <chatDir>/photos is <id>.<ext of type>).
 */
import { CLI_NAME } from '@jantar/protocol';
import { openCheckedDb, type LifeMigration, type LifeOpenResult } from '../life/db.js';

/** What every Chat route but the switch answers (503) while chat.db will not open. */
export const CHAT_BROKEN_REASON = `Chat history could not be opened. The file is untouched. Move it aside at your Mac: ${CLI_NAME} chat clear --broken`;

export const CHAT_MIGRATIONS: readonly LifeMigration[] = [
  {
    version: 1,
    name: 'chat',
    sql: `
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); -- schema

      CREATE TABLE turns (
        id    TEXT PRIMARY KEY,   -- ulid
        at    TEXT NOT NULL,
        state TEXT NOT NULL,
        json  TEXT NOT NULL       -- the turn without its changes and cards (zod-checked)
      );
      CREATE INDEX turns_at ON turns (at, id);

      CREATE TABLE changes (
        turn_id TEXT NOT NULL,
        n       INTEGER NOT NULL,
        at      TEXT NOT NULL,
        state   TEXT NOT NULL,
        json    TEXT NOT NULL,    -- module, op, ref, label, undoable
        journal TEXT,             -- before and after values for Undo; NULL once the Undo window ends
        PRIMARY KEY (turn_id, n)
      );

      CREATE TABLE confirms (
        turn_id TEXT NOT NULL,
        n       INTEGER NOT NULL,
        at      TEXT NOT NULL,
        state   TEXT NOT NULL,
        json    TEXT NOT NULL,    -- kind, module, op, ref, label, and the checked action the tap runs
        PRIMARY KEY (turn_id, n)
      );

      CREATE TABLE photos (
        id      TEXT PRIMARY KEY, -- ulid; the file is <chatDir>/photos/<id>.<ext>
        turn_id TEXT,             -- null until a message takes it
        at      TEXT NOT NULL,
        bytes   INTEGER NOT NULL,
        w       INTEGER NOT NULL,
        h       INTEGER NOT NULL,
        type    TEXT NOT NULL     -- image/jpeg, image/png, image/webp or image/gif
      );
      CREATE INDEX photos_turn ON photos (turn_id);
      CREATE INDEX photos_at ON photos (at, id);
    `,
  },
  {
    // v0.12 People (P3, spec 9.1.3): a thread on every row. '' is the owner's thread (every existing row),
    // 'p:<pid>' a partner's. Every query in store.ts names it. An older daemon refuses a schema-2 file;
    // going back means restoring backups/chat-pre-<version>.db.
    version: 2,
    name: 'threads',
    sql: `
      ALTER TABLE turns    ADD COLUMN thread TEXT NOT NULL DEFAULT '';
      ALTER TABLE photos   ADD COLUMN thread TEXT NOT NULL DEFAULT '';
      ALTER TABLE changes  ADD COLUMN thread TEXT NOT NULL DEFAULT '';
      ALTER TABLE confirms ADD COLUMN thread TEXT NOT NULL DEFAULT '';
      CREATE INDEX turns_thread ON turns (thread, at, id);
    `,
  },
];

/** The schema this build writes and reads. A file with a newer one is refused, never downgraded. */
export const CHAT_SCHEMA_VERSION = Math.max(...CHAT_MIGRATIONS.map((m) => m.version));

/** The copy kept before chat.db moves to a newer schema (v0.12: in backups/, beside life's; never restored by Life). */
export function chatPreUpgradeName(version: string): string {
  return `chat-pre-${version}.db`;
}

/**
 * Open (creating and migrating) chat.db at `path`, or ":memory:" (tests). A refusal answers CHAT_BROKEN_REASON.
 * v0.12: `preMigrateCopy` names the copy an existing file is kept as before it migrates (backups/chat-pre-<version>.db).
 */
export function openChatDb(path: string, opts: { preMigrateCopy?: (from: number, to: number) => string | null } = {}): LifeOpenResult {
  return openCheckedDb(path, {
    migrations: CHAT_MIGRATIONS,
    brokenReason: CHAT_BROKEN_REASON,
    pragmas: ['PRAGMA secure_delete = ON'],
    ...(opts.preMigrateCopy ? { preMigrateCopy: opts.preMigrateCopy } : {}),
  });
}
