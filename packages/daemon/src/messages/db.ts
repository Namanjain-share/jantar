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
 * morning run reports, what each run made and from which chat (so a re-run
 * makes nothing twice, and a skip takes it from view) and whose call-back
 * each is (one person's, or a group line's), the chats each run
 * sent to Claude, the read log (ids and counts only) and Messages' own
 * settings (the morning and call-back times, the "ran this morning" mark,
 * the skipped chats whose todos are still to leave Life). No
 * message text but a draft's quote of what they asked, never a WhatsApp id.
 */
import { basename } from 'node:path';
import { MESSAGES_LIMITS } from '@jantar/protocol';
import {
  ChatKeySchema,
  DEFAULT_MESSAGES_PREFS,
  MessagesPrefsSchema,
  MorningRunSchema,
  ReadLogEntrySchema,
  type MessagesPrefs,
  type MorningRun,
  type ReadLogEntry,
} from '@jantar/protocol/messages';
import type { LifeDb } from '../contracts.js';
import { openCheckedDb, type LifeMigration, type LifeOpenResult } from '../life/db.js';
import { ReaderCursorSchema, type ReaderCursor } from './reader-protocol.js';

/** What every messages route but the status answers (503 messages_unavailable) while messages.db will not open. */
export const MESSAGES_BROKEN_REASON =
  'Messages data could not be opened. The file is untouched. To start again, move messages.db aside at your Mac and turn Messages off and on (the skip list is kept): jantar messages off, then jantar messages on.';

/** messages.db, open: the same handle shape as life.db's (prepare, tx, meta, close). */
export type MessagesDb = LifeDb;

/** The read log keeps this many rows; older ones go as new ones come. */
export const READS_KEEP = 5_000;
/** A read-log folder: a basename, cut to the protocol's length. */
const FOLDER_MAX = 255;
/** The `settings` row with the morning and call-back times (MessagesPrefs as JSON). */
const PREFS_KEY = 'prefs';
/** meta: where the morning feed got to (ReaderCursor as JSON), moved only by a run that went well. */
export const CURSOR_KEY = 'morning.cursor';
/** meta: when the morning the timer's newest run that went well was for was due (ISO; read as a day in the Life zone as it is now). */
export const LAST_MORNING_KEY = 'morning.last_at';
/** meta: when the morning a new morning time left as done (set after it had passed) was due (ISO): the timer reads it with LAST_MORNING_KEY, so a restart honours it. */
export const PASSED_MORNING_KEY = 'morning.passed_at';
/**
 * meta: the skipped chats whose open morning todos and call-backs are still
 * to leave Life (JSON chat keys): each goes in with its skip, in the skip's
 * own transaction, and out once Life's todos took them (service.ts
 * settleOwed), so a Life that refuses at the skip can't lose them.
 */
export const SKIP_OWED_KEY = 'skip.owed';

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
  {
    // What a skip takes from view: each item made, by the chat it came from; the chats each run sent to Claude.
    version: 2,
    name: 'chats',
    sql: `
      ALTER TABLE made ADD COLUMN chat_key TEXT;      -- a line's chat, a call's 1:1 (null: not known)
      UPDATE made SET chat_key = substr(src_key, instr(src_key, ':') + 1, instr(src_key, '.') - instr(src_key, ':') - 1)
        WHERE instr(src_key, '.') > 0;
      CREATE INDEX made_chat ON made (chat_key);

      CREATE TABLE run_chats (
        run_id   TEXT NOT NULL,
        chat_key TEXT NOT NULL,
        PRIMARY KEY (run_id, chat_key)
      );
      CREATE INDEX run_chats_chat ON run_chats (chat_key);
    `,
  },
  {
    // Whose a call-back is (apply.ts): one person's, so its title's name or number counts for them across a 1:1 and
    // none; or a group's line's, which stays the group's. A call-back from a call before this was one person's.
    version: 3,
    name: 'callback person',
    sql: `
      ALTER TABLE made ADD COLUMN person INTEGER;     -- a call-back's: 1 one person's (a call, a 1:1's line), 0 a group's line
      UPDATE made SET person = 1 WHERE kind = 'callback' AND src_key LIKE 'callback:k%';
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

/** The morning and call-back times, as they are now. */
export function writePrefs(db: MessagesDb, prefs: MessagesPrefs): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(PREFS_KEY, JSON.stringify(prefs));
}

/** Where the morning feed got to, or null (the first run, or a mark that doesn't check). */
export function readCursor(db: MessagesDb): ReaderCursor | null {
  const raw = db.meta(CURSOR_KEY);
  if (!raw) return null;
  try {
    const c = ReaderCursorSchema.safeParse(JSON.parse(raw));
    return c.success ? c.data : null;
  } catch {
    return null;
  }
}

export function writeCursor(db: MessagesDb, cursor: ReaderCursor): void {
  db.setMeta(CURSOR_KEY, JSON.stringify(cursor));
}

/** The skipped chats whose todos are still owed to Life (SKIP_OWED_KEY); none when there is no mark or it doesn't read. */
export function readOwed(db: MessagesDb): string[] {
  const raw = db.meta(SKIP_OWED_KEY);
  if (!raw) return [];
  try {
    const keys: unknown = JSON.parse(raw);
    return Array.isArray(keys) ? keys.filter((k): k is string => ChatKeySchema.safeParse(k).success) : [];
  } catch {
    return [];
  }
}

/** The skipped chats still owed, each once; none clears the mark. */
export function writeOwed(db: MessagesDb, keys: readonly string[]): void {
  if (keys.length === 0) db.deleteMeta(SKIP_OWED_KEY);
  else db.setMeta(SKIP_OWED_KEY, JSON.stringify([...new Set(keys)]));
}

/** A run's report, written or replaced by its id (a preview is never kept). */
export function putRun(db: MessagesDb, run: MorningRun): void {
  const kept: MorningRun = { ...run };
  delete kept.preview;
  db.prepare('INSERT INTO runs (id, at, trigger, state, json) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state, json = excluded.json').run(
    run.id,
    run.at,
    run.trigger,
    run.state,
    JSON.stringify(kept),
  );
}

/** A stored report, or null when it doesn't check. */
function parseRun(json: string): MorningRun | null {
  try {
    const r = MorningRunSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** The newest run's report (`real`: not a dry run), or null; a report that doesn't check counts as none. */
export function newestRun(db: MessagesDb, real: boolean): MorningRun | null {
  const sql = `SELECT json FROM runs ${real ? "WHERE trigger <> 'dry' " : ''}ORDER BY at DESC, rowid DESC LIMIT 1`;
  const row = db.prepare(sql).get() as { json: string } | undefined;
  return row ? parseRun(row.json) : null;
}

/** Runs looked at for Today's `made`, newest first, at most. */
const MADE_SCAN = 50;

/**
 * The runs Today reports on (MessagesTodayResponse `made`): each one, not
 * dry, that went well and made anything, started at `since` or later (the
 * Life zone's day), newest first, at most MESSAGES_LIMITS.todayRuns.
 */
export function madeRuns(db: MessagesDb, since: string): MorningRun[] {
  const rows = db.prepare("SELECT json FROM runs WHERE trigger <> 'dry' AND state = 'ok' AND at >= ? ORDER BY at DESC, rowid DESC LIMIT ?").all(since, MADE_SCAN) as { json: string }[];
  const out: MorningRun[] = [];
  for (const row of rows) {
    const run = parseRun(row.json);
    if (run && run.counts.todos + run.counts.replies + run.counts.callbacks > 0) out.push(run);
    if (out.length >= MESSAGES_LIMITS.todayRuns) break;
  }
  return out;
}

/** The chats a run sends to Claude (a skip later takes that run's summary away). */
export function addRunChats(db: MessagesDb, runId: string, chatKeys: readonly string[]): void {
  const add = db.prepare('INSERT OR IGNORE INTO run_chats (run_id, chat_key) VALUES (?, ?)');
  db.tx(() => {
    for (const k of chatKeys) add.run(runId, k);
  });
}

/**
 * A chat just skipped, in the skip's own transaction: its open drafts are
 * dismissed, a run that sent it to Claude loses its summary (the model's
 * words about it), and every report its left-out line. Answers how many
 * drafts were dismissed.
 */
export function forgetChat(db: MessagesDb, chatKey: string): number {
  const dismissed = Number(db.prepare("UPDATE drafts SET state = 'dismissed' WHERE chat_key = ? AND state = 'open'").run(chatKey).changes);
  const read = new Set((db.prepare('SELECT run_id FROM run_chats WHERE chat_key = ?').all(chatKey) as { run_id: string }[]).map((r) => r.run_id));
  // The key is in a report's JSON only where its left-out line names it.
  const rows = db.prepare("SELECT id, json FROM runs WHERE id IN (SELECT run_id FROM run_chats WHERE chat_key = ?) OR instr(json, ?) > 0").all(chatKey, `"${chatKey}"`) as { id: string; json: string }[];
  for (const row of rows) {
    const run = parseRun(row.json);
    if (!run) continue;
    const kept: MorningRun = { ...run, dropped: run.dropped.filter((d) => d.chatKey !== chatKey) };
    if (read.has(run.id)) delete kept.summary;
    putRun(db, kept);
  }
  return dismissed;
}

/** Runs still `running` (the daemon stopped during them) become failed with `why`. */
export function failRunning(db: MessagesDb, why: string): number {
  const rows = db.prepare("SELECT id, json FROM runs WHERE state = 'running'").all() as { id: string; json: string }[];
  for (const row of rows) {
    const run = parseRun(row.json);
    if (run) putRun(db, { ...run, state: 'failed', why });
    else db.prepare("UPDATE runs SET state = 'failed' WHERE id = ?").run(row.id);
  }
  return rows.length;
}

/** When the newest morning run that wasn't a dry run started, or null. */
export function lastRunAt(db: MessagesDb): string | null {
  const row = db.prepare("SELECT at FROM runs WHERE trigger <> 'dry' ORDER BY at DESC LIMIT 1").get() as { at: string } | undefined;
  return row?.at ?? null;
}
