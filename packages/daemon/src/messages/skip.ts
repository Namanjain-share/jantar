/**
 * The skip list (0.15): the chats Messages never reads. messages.db's `skip`
 * table is the list; <messagesDir>/skip.json is its mirror for the reader,
 * which enforces it (a skipped 1:1 hides that person everywhere, a skipped
 * group the group) and reloads it when the file changes.
 *
 * The mirror is `{"version":1,"chatKeys":[…]}`, written 0600 to a temp file
 * in the same folder and renamed over the old one, so the reader never sees
 * half a file. The service writes it at open (before the first read) and in
 * the same transaction as every change: a mirror that can't be written rolls
 * the change back. Names stay in messages.db; the mirror holds keys only.
 *
 * The list never empties by itself: a new or reset messages.db keeps every
 * key skip.json still lists (`keep`), under SKIP_KEPT_NAME, before the
 * mirror is written from the table again.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ChatKeySchema, SkipEntrySchema, type SkipEntry } from '@jantar/protocol/messages';
import type { MessagesDb } from './db.js';

export const SKIP_FILE = 'skip.json';
/** skip.json's format, as the reader parses it. */
export const SKIP_FILE_VERSION = 1;
/** A kept key's name: skip.json holds keys only, and the reader shows no skipped chat. */
export const SKIP_KEPT_NAME = 'A chat skipped before messages.db was reset (its name is not known)';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const TMP_BYTES = 8;
/** The reader's own cap on skip.json (SKIP_FILE_MAX in the Swift source). */
const SKIP_FILE_MAX = 4 * 1024 * 1024;

export interface SkipStore {
  /** Oldest first. */
  list(): SkipEntry[];
  /** Already there: left as it was. */
  add(e: SkipEntry): void;
  /** False when it wasn't there. */
  remove(chatKey: string): boolean;
  /** skip.json from the table (0600, temp file and rename); throws when it can't be written. */
  writeMirror(): void;
  /** Keys skip.json lists that the table hasn't, added under SKIP_KEPT_NAME at `addedAt` (how many); throws when it won't read. */
  keep(addedAt: string): number;
  /** Rows in the table (the keys the mirror lists). */
  count(): number;
  /** skip.json's inode, size and mtime, or null when there is none: another one than written means someone else changed it. */
  stamp(): string | null;
}

interface SkipRow {
  chat_key: string;
  name: string;
  kind: string;
  added_at: string;
}

/** The folder the reader keeps its state in: made 0700 when missing, and it must be a real folder of ours. */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error('the messages folder is not a folder');
  if (process.getuid && st.uid !== process.getuid()) throw new Error('the messages folder is not ours');
  if ((st.mode & 0o077) !== 0) chmodSync(dir, DIR_MODE);
}

/** The chat keys in skip.json (the reader's rules: a regular file of ours, version 1), [] when there is none. */
function mirroredKeys(file: string): string[] {
  let st;
  try {
    st = lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  if (!st.isFile() || st.size > SKIP_FILE_MAX || (process.getuid && st.uid !== process.getuid())) return [];
  const text = readFileSync(file, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const o = json as { version?: unknown; chatKeys?: unknown } | null;
  if (o?.version !== SKIP_FILE_VERSION || !Array.isArray(o.chatKeys)) return [];
  return o.chatKeys.filter((k): k is string => ChatKeySchema.safeParse(k).success);
}

/** The skip list in `db`, mirrored into `dir` (paths.messagesDir). */
export function createSkipStore(db: MessagesDb, dir: string): SkipStore {
  const file = join(dir, SKIP_FILE);
  const list = (): SkipEntry[] => {
    const rows = db.prepare('SELECT chat_key, name, kind, added_at FROM skip ORDER BY added_at, chat_key').all() as unknown as SkipRow[];
    return rows.flatMap((r) => {
      const e = SkipEntrySchema.safeParse({ chatKey: r.chat_key, name: r.name, kind: r.kind, addedAt: r.added_at });
      return e.success ? [e.data] : [];
    });
  };
  return {
    list,
    add(e) {
      db.prepare('INSERT OR IGNORE INTO skip (chat_key, name, kind, added_at) VALUES (?, ?, ?, ?)').run(e.chatKey, e.name, e.kind, e.addedAt);
    },
    remove(chatKey) {
      return Number(db.prepare('DELETE FROM skip WHERE chat_key = ?').run(chatKey).changes) > 0;
    },
    keep(addedAt) {
      const insert = db.prepare('INSERT OR IGNORE INTO skip (chat_key, name, kind, added_at) VALUES (?, ?, ?, ?)');
      let kept = 0;
      db.tx(() => {
        // A 1:1 or a group, unknown: 'dm' is only what the list shows.
        for (const k of mirroredKeys(file)) kept += Number(insert.run(k, SKIP_KEPT_NAME, 'dm', addedAt).changes);
      });
      return kept;
    },
    count() {
      return Number((db.prepare('SELECT count(*) AS n FROM skip').get() as { n: number }).n);
    },
    stamp() {
      try {
        const st = lstatSync(file, { bigint: true });
        return `${st.ino}:${st.size}:${st.mtimeNs}`;
      } catch {
        return null;
      }
    },
    writeMirror() {
      // Every key in the table, a row that won't check included: the reader hides more, never less.
      const keys = (db.prepare('SELECT chat_key FROM skip ORDER BY chat_key').all() as unknown as { chat_key: string }[]).map((r) => r.chat_key);
      ensurePrivateDir(dir);
      const tmp = join(dir, `.${SKIP_FILE}.${randomBytes(TMP_BYTES).toString('hex')}.tmp`);
      const fd = openSync(tmp, 'wx', FILE_MODE);
      try {
        writeSync(fd, JSON.stringify({ version: SKIP_FILE_VERSION, chatKeys: keys }));
        fsyncSync(fd);
      } catch (e) {
        closeSync(fd);
        unlinkSync(tmp);
        throw e;
      }
      closeSync(fd);
      try {
        renameSync(tmp, file);
      } catch (e) {
        unlinkSync(tmp);
        throw e;
      }
    },
  };
}
