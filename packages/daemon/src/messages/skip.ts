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
 * mirror is written from the table again. Only a missing skip.json is an
 * empty list: one that won't read or that the reader would refuse throws
 * SkipFileUnreadable, and is never written over.
 *
 * Every key is made with the reader's salt (<messagesDir>/salt). Gone while
 * the list holds keys (`saltLost`), the reader won't start, and only the
 * owner's reset at the Mac goes on: `resetStart` sets every entry aside by
 * name and kind (meta RESET_KEY) and empties the list, so the reader can
 * make a new salt; the service then skips each chat found again by its name
 * and keeps reads refused while any is left (`resetLeft`). Only after a
 * lookup with the reader back (`resetLooked`) may the owner let the rest go.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ChatKeySchema, ChatKindSchema, SkipEntrySchema, type ChatKind, type SkipEntry } from '@jantar/protocol/messages';
import type { MessagesDb } from './db.js';

export const SKIP_FILE = 'skip.json';
/** The reader's salt, beside skip.json (jantar-messages-reader.swift loadSalt). */
export const SALT_FILE = 'salt';
/** meta: the entries a reset after a lost salt has still to find again, and whether a lookup went through with the reader back ({left, looked} as JSON). */
const RESET_KEY = 'skip.reset';
/** skip.json's format, as the reader parses it. */
export const SKIP_FILE_VERSION = 1;
/** A kept key's name: skip.json holds keys only, and the reader shows no skipped chat. */
export const SKIP_KEPT_NAME = 'A chat skipped before messages.db was reset (its name is not known)';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const TMP_BYTES = 8;
/** The reader's own cap on skip.json (SKIP_FILE_MAX in the Swift source). */
const SKIP_FILE_MAX = 4 * 1024 * 1024;

/** A skipped chat set aside by a reset: what finds it again. */
export interface LostEntry {
  name: string;
  kind: ChatKind;
}
const LostListSchema = z.array(z.object({ name: z.string(), kind: ChatKindSchema }));
/** RESET_KEY's value; a bare list (as first written) has not been looked up. */
const ResetSchema = z.union([z.object({ left: LostListSchema, looked: z.boolean() }), LostListSchema.transform((left) => ({ left, looked: false }))]);

export interface SkipStore {
  /** Oldest first. */
  list(): SkipEntry[];
  /** Already there: left as it was. */
  add(e: SkipEntry): void;
  /** False when it wasn't there. */
  remove(chatKey: string): boolean;
  /** skip.json from the table (0600, temp file and rename); throws when it can't be written. */
  writeMirror(): void;
  /**
   * Keys skip.json lists that the table hasn't, added under SKIP_KEPT_NAME at
   * `addedAt` (how many). Throws SkipFileUnreadable when the file won't
   * read, and messages.db's own error when the table won't take them.
   */
  keep(addedAt: string): number;
  /** Rows in the table (the keys the mirror lists). */
  count(): number;
  /** skip.json's inode, size and mtime, or null when there is none: another one than written means someone else changed it. */
  stamp(): string | null;
  /** The salt is gone while the table or skip.json holds keys (saltLost). */
  saltLost(): boolean;
  /**
   * A reset's first step, in one transaction: every entry set aside by name
   * and kind (a key skip.json lists that the table hasn't, or a skip.json
   * that won't read, as SKIP_KEPT_NAME), the table emptied and skip.json
   * written empty. What was set aside.
   */
  resetStart(): LostEntry[];
  /** The entries a reset has still to find, or null when none is going (a value that won't read: one unnamed entry). */
  resetLeft(): LostEntry[] | null;
  /** The reset's last lookup went through with the reader back (false while none is going, or its value won't read). */
  resetLooked(): boolean;
  /** What is still to find, and whether this lookup went through with the reader back; none ends the reset. */
  setResetLeft(left: readonly LostEntry[], looked?: boolean): void;
}

/**
 * The reader's salt is gone while keys made with it are kept (`tableKeys`
 * in messages.db, or any in skip.json, or a skip.json that won't read): the
 * reader then refuses to start rather than make keys that match none of them.
 */
export function saltLost(dir: string, tableKeys: number): boolean {
  try {
    lstatSync(join(dir, SALT_FILE));
    return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  if (tableKeys > 0) return true;
  try {
    return mirroredKeys(join(dir, SKIP_FILE)).length > 0;
  } catch {
    return true;
  }
}

/** skip.json is there but won't read (permissions, a disk error) or breaks the reader's rules; `code`: why, for the log. */
export class SkipFileUnreadable extends Error {
  constructor(readonly code: string) {
    super("skip.json won't read");
    this.name = 'SkipFileUnreadable';
  }
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

/**
 * The chat keys in skip.json, [] only when there is none. The reader's rules
 * (SkipList.refresh): a regular file of ours within SKIP_FILE_MAX, JSON,
 * version 1, a list of keys; one bad key fails the whole file. Anything else
 * throws SkipFileUnreadable: the reader refuses reads on it, so it is never
 * taken as empty (and written over).
 */
export function mirroredKeys(file: string): string[] {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw new SkipFileUnreadable(typeof code === 'string' ? code : 'unknown');
  }
  let text: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SkipFileUnreadable('not_a_file');
    if (process.getuid && st.uid !== process.getuid()) throw new SkipFileUnreadable('not_ours');
    if (st.size > SKIP_FILE_MAX) throw new SkipFileUnreadable('too_large');
    text = readFileSync(fd, 'utf8');
  } catch (e) {
    if (e instanceof SkipFileUnreadable) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    throw new SkipFileUnreadable(typeof code === 'string' ? code : 'unknown');
  } finally {
    closeSync(fd);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SkipFileUnreadable('not_json');
  }
  const o = json as { version?: unknown; chatKeys?: unknown } | null;
  if (o === null || typeof o !== 'object' || Array.isArray(o) || o.version !== SKIP_FILE_VERSION) throw new SkipFileUnreadable('version');
  if (!Array.isArray(o.chatKeys)) throw new SkipFileUnreadable('not_a_list');
  if (!o.chatKeys.every((k) => ChatKeySchema.safeParse(k).success)) throw new SkipFileUnreadable('bad_key');
  return o.chatKeys as string[];
}

/** RESET_KEY's value, or null when it won't read. */
function readReset(raw: string): { left: LostEntry[]; looked: boolean } | null {
  try {
    const r = ResetSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
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
  const count = () => Number((db.prepare('SELECT count(*) AS n FROM skip').get() as { n: number }).n);
  const writeMirror = () => {
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
      const keys = mirroredKeys(file);
      const insert = db.prepare('INSERT OR IGNORE INTO skip (chat_key, name, kind, added_at) VALUES (?, ?, ?, ?)');
      let kept = 0;
      db.tx(() => {
        // A 1:1 or a group, unknown: 'dm' is only what the list shows.
        for (const k of keys) kept += Number(insert.run(k, SKIP_KEPT_NAME, 'dm', addedAt).changes);
      });
      return kept;
    },
    count,
    stamp() {
      try {
        const st = lstatSync(file, { bigint: true });
        return `${st.ino}:${st.size}:${st.mtimeNs}`;
      } catch {
        return null;
      }
    },
    writeMirror,
    saltLost: () => saltLost(dir, count()),
    resetStart() {
      const entries = list();
      const inTable = new Set(entries.map((e) => e.chatKey));
      let unnamed: number;
      try {
        unnamed = mirroredKeys(file).filter((k) => !inTable.has(k)).length;
      } catch {
        unnamed = 1;
      }
      const lost: LostEntry[] = [];
      const seen = new Set<string>();
      for (const e of [...entries.map((x) => ({ name: x.name, kind: x.kind })), ...Array.from({ length: unnamed }, () => ({ name: SKIP_KEPT_NAME, kind: 'dm' as const }))]) {
        const id = `${e.kind}\n${e.name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        lost.push(e);
      }
      db.tx(() => {
        if (lost.length > 0) db.setMeta(RESET_KEY, JSON.stringify({ left: lost, looked: false }));
        db.prepare('DELETE FROM skip').run();
        writeMirror();
      });
      return lost;
    },
    resetLeft() {
      const raw = db.meta(RESET_KEY);
      if (raw === undefined) return null;
      return readReset(raw)?.left ?? [{ name: SKIP_KEPT_NAME, kind: 'dm' }];
    },
    resetLooked() {
      const raw = db.meta(RESET_KEY);
      return raw !== undefined && readReset(raw)?.looked === true;
    },
    setResetLeft(left, looked = false) {
      if (left.length === 0) db.deleteMeta(RESET_KEY);
      else db.setMeta(RESET_KEY, JSON.stringify({ left, looked }));
    },
  };
}
