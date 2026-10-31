/**
 * meetings.db: Meetings' own SQLite file (node:sqlite, WAL), apart from
 * jantar.db and life.db.
 *
 * - Opened by life.db's checked open (life/db.ts openCheckedDb): REFUSED,
 *   NEVER RESET. A file that will not open, fails `quick_check`, carries a
 *   schema newer than this build or fails a migration is left exactly as it
 *   is, and every meetings route answers 503 with MEETINGS_BROKEN_REASON
 *   until it is moved aside at the Mac. Transcripts are not an event ring.
 * - Opened only while Meetings are on (meetings/index.ts); never backed up
 *   (deleting a meeting deletes it for good; Time Machine and the CLI's
 *   export are the copies).
 * - A new file is created 0600 inside the 0700 state dir.
 * - secure_delete is on: a deleted meeting's text is overwritten in the
 *   file, not left in free pages (store.ts checkpoints the WAL after a
 *   delete, so its old frames go too).
 * - Its own file keeps a rollback to v0.4.1 safe: v0.4.1 never opens it.
 *
 * The record of a meeting is a `json` column checked with zod on read and
 * write (store.ts); lines and screenshot rows hang off it and go with it.
 */
import type { LifeDb } from '../contracts.js';
import { openCheckedDb, type LifeMigration, type LifeOpenResult } from '../life/db.js';

/** What every meetings route but the status and pairing answers (503 meetings_unavailable) while meetings.db will not open. */
export const MEETINGS_BROKEN_REASON =
  'Meetings data could not be opened. The file is untouched. Move meetings.db aside at your Mac to start again (docs/extension.md).';

/** meetings.db, open: the same handle shape as life.db's (prepare, tx, meta, close). */
export type MeetingsDb = LifeDb;

export const MEETINGS_MIGRATIONS: readonly LifeMigration[] = [
  {
    version: 1,
    name: 'meetings',
    sql: `
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); -- schema

      CREATE TABLE meetings (
        id          TEXT PRIMARY KEY,               -- ulid
        ext_id      TEXT NOT NULL,                  -- the extension that made it (jantar.db extensions.id)
        client_id   TEXT NOT NULL,                  -- that extension's uuid for the tab's call
        started_at  TEXT NOT NULL,
        ended_at    TEXT,
        last_at     TEXT NOT NULL,                  -- the last open, line, keep-alive or screenshot (the stale sweep)
        project_id  TEXT,                           -- a life.db project id; may dangle
        json        TEXT NOT NULL,                  -- MeetingRecord, zod-checked on read and write
        UNIQUE (ext_id, client_id)
      );
      CREATE INDEX meetings_started ON meetings (started_at DESC, id DESC);
      CREATE INDEX meetings_project ON meetings (project_id, started_at DESC);

      CREATE TABLE lines (
        meeting_id TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
        line_id    TEXT NOT NULL,
        rev        INTEGER NOT NULL,
        at         INTEGER NOT NULL,                -- ms since epoch
        speaker    TEXT NOT NULL,
        text       TEXT NOT NULL,
        PRIMARY KEY (meeting_id, line_id)
      );
      CREATE INDEX lines_at ON lines (meeting_id, at);

      CREATE TABLE shots (
        id         TEXT PRIMARY KEY,                -- ulid; the file is <meetingsDir>/<meeting_id>/<id>.jpg
        meeting_id TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
        key        TEXT NOT NULL,                   -- the extension's uuid for this shot
        at         INTEGER NOT NULL,
        bytes      INTEGER NOT NULL,
        UNIQUE (meeting_id, key)
      );
      CREATE INDEX shots_meeting ON shots (meeting_id, at);
    `,
  },
];

/** The schema this build writes and reads. A file with a newer one is refused, never downgraded. */
export const MEETINGS_SCHEMA_VERSION = Math.max(...MEETINGS_MIGRATIONS.map((m) => m.version));

/** Open (creating and migrating) meetings.db at `path`, or ":memory:" (tests). A refusal answers MEETINGS_BROKEN_REASON. */
export function openMeetingsDb(path: string): LifeOpenResult {
  return openCheckedDb(path, { migrations: MEETINGS_MIGRATIONS, brokenReason: MEETINGS_BROKEN_REASON, pragmas: ['PRAGMA secure_delete = ON'] });
}
