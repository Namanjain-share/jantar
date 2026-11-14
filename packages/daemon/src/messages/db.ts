/**
 * messages.db: Messages' own SQLite file (node:sqlite, WAL), apart from
 * jantar.db, life.db and meetings.db (0.15).
 *
 * - Opened by life.db's checked open (life/db.ts openCheckedDb): REFUSED,
 *   NEVER RESET. A file that will not open, fails `quick_check`, carries a
 *   schema newer than this build or fails a migration is left exactly as it
 *   is, and every messages route answers 503 with MESSAGES_BROKEN_REASON
 *   until it is moved aside at the Mac.
 * - Opened only while Messages is on (messages/service.ts). Never in the
 *   nightly Life backup, never in Jantar's search.
 * - A new file is created 0600 inside the 0700 state dir; secure_delete is
 *   on, so a dismissed draft's text is overwritten, not left in free pages.
 *
 * It holds the skip list (mirrored to the reader's skip.json), reply drafts,
 * morning run reports, what each run made (so a re-run makes nothing
 * twice), the read log (ids and counts only) and Messages' own settings
 * (the morning and call-back times, the "ran today" mark). No message
 * text but a draft's quote of what they asked, never a WhatsApp id.
 */
import { basename } from 'node:path';
import { DEFAULT_MESSAGES_PREFS, MessagesPrefsSchema, ReadLogEntrySchema, type MessagesPrefs, type ReadLogEntry } from '@jantar/protocol/messages';
import type { LifeDb } from '../contracts.js';
import { openCheckedDb, type LifeMigration, type LifeOpenResult } from '../life/db.js';

/** What every messages route but the status answers (503 messages_unavailable) while messages.db will not open. */
export const MESSAGES_BROKEN_REASON =
  'Messages data could not be opened. The file is untouched. Move messages.db aside at your Mac to start again (jantar messages on makes a new one).';

/** messages.db, open: the same handle shape as life.db's (prepare, tx, meta, close). */
export type MessagesDb = LifeDb;

/** The read log keeps this many rows; older ones go as new ones come. */
export const READS_KEEP = 5_000;
/** A read-log folder: a basename, cut to the protocol's length. */
const FOLDER_MAX = 255;
/** The `settings` row with the morning and call-back times (MessagesPrefs as JSON). */
const PREFS_KEY = 'prefs';

export const MESSAGES_MIGRATIONS: readonly LifeMigration[] = [
  {
    version: 1,
    name: 'messages',
    sql: `
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); -- schema, project_id, morning cursor

      CREATE TABLE skip (
        chat_key TEXT PRIMARY KEY,                  -- the reader's chat key; mirrored to <messagesDir>/skip.json
        name     TEXT NOT NULL,
        kind     TEXT NOT NULL,
        added_at TEXT NOT NULL
      );

      CREATE TABLE drafts (
        id         TEXT PRIMARY KEY,                -- ulid
        run_id     TEXT NOT NULL,
        chat_key   TEXT NOT NULL,
        chat_name  TEXT NOT NULL,
        phone      TEXT,                            -- a 1:1's number (digits), for Open in WhatsApp
        they_asked TEXT NOT NULL,
        draft      TEXT NOT NULL,
        at         TEXT NOT NULL,
        state      TEXT NOT NULL CHECK (state IN ('open', 'done', 'dismissed'))
      );
      CREATE INDEX drafts_run ON drafts (run_id);
      CREATE INDEX drafts_state ON drafts (state, at);

      CREATE TABLE runs (
        id      TEXT PRIMARY KEY,                   -- ulid
        at      TEXT NOT NULL,
        trigger TEXT NOT NULL,
        state   TEXT NOT NULL,
        json    TEXT NOT NULL                       -- MorningRun, zod-checked on read
      );
      CREATE INDEX runs_at ON runs (at);

      CREATE TABLE made (
        src_key   TEXT PRIMARY KEY,                 -- kind + ':' + msgKey or callKey
        run_id    TEXT NOT NULL,
        kind      TEXT NOT NULL,
        target_id TEXT                              -- the todo or draft made
      );
      CREATE INDEX made_run ON made (run_id);

      CREATE TABLE reads (
        id       INTEGER PRIMARY KEY,
        at       TEXT NOT NULL,
        via      TEXT NOT NULL,
        pid      INTEGER,
        folder   TEXT,                              -- a basename
        op       TEXT NOT NULL,
        chat_key TEXT,
        count    INTEGER NOT NULL
      );

      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `,
  },
];

/** The schema this build writes and reads. A file with a newer one is refused, never downgraded. */
export const MESSAGES_SCHEMA_VERSION = Math.max(...MESSAGES_MIGRATIONS.map((m) => m.version));

/** Open (creating and migrating) messages.db at `path`, or ":memory:" (tests). A refusal answers MESSAGES_BROKEN_REASON. */
export function openMessagesDb(path: string): LifeOpenResult {
  return openCheckedDb(path, { migrations: MESSAGES_MIGRATIONS, brokenReason: MESSAGES_BROKEN_REASON, pragmas: ['PRAGMA secure_delete = ON'] });
}

/** One read-log row (a folder kept as its basename), and the oldest past READS_KEEP gone. */
export function addRead(db: MessagesDb, e: ReadLogEntry): void {
  const folder = e.folder ? basename(e.folder).slice(0, FOLDER_MAX) : null;
  const pid = e.pid !== undefined && Number.isSafeInteger(e.pid) && e.pid > 0 ? e.pid : null;
  db.tx(() => {
    db.prepare('INSERT INTO reads (at, via, pid, folder, op, chat_key, count) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      e.at,
      e.via,
      pid,
      folder || null,
      e.op,
      e.chatKey ?? null,
      e.count,
    );
    db.prepare('DELETE FROM reads WHERE id <= (SELECT id FROM reads ORDER BY id DESC LIMIT 1 OFFSET ?)').run(READS_KEEP);
  });
}

interface ReadRow {
  at: string;
  via: string;
  pid: number | null;
  folder: string | null;
  op: string;
  chat_key: string | null;
  count: number;
}

/** The newest `limit` reads, newest first (a row that doesn't check is left out). */
export function listReads(db: MessagesDb, limit: number): ReadLogEntry[] {
  const rows = db.prepare('SELECT at, via, pid, folder, op, chat_key, count FROM reads ORDER BY id DESC LIMIT ?').all(limit) as unknown as ReadRow[];
  return rows.flatMap((r) => {
    const e = ReadLogEntrySchema.safeParse({
      at: r.at,
      via: r.via,
      ...(r.pid !== null ? { pid: r.pid } : {}),
      ...(r.folder !== null ? { folder: r.folder } : {}),
      op: r.op,
      ...(r.chat_key !== null ? { chatKey: r.chat_key } : {}),
      count: r.count,
    });
    return e.success ? [e.data] : [];
  });
}

/** The morning and call-back times (the defaults until they are set). */
export function readPrefs(db: MessagesDb): MessagesPrefs {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(PREFS_KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_MESSAGES_PREFS };
  try {
    return MessagesPrefsSchema.parse(JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_MESSAGES_PREFS };
  }
}

/** When the newest morning run that wasn't a dry run started, or null. */
export function lastRunAt(db: MessagesDb): string | null {
  const row = db.prepare("SELECT at FROM runs WHERE trigger <> 'dry' ORDER BY at DESC LIMIT 1").get() as { at: string } | undefined;
  return row?.at ?? null;
}
