/**
 * jantar-messages-reader run for the reader tests (reader.test.ts,
 * reader-more.test.ts): the reader as a real process on a fixture with its
 * own socket and state dir, the keys it gives (from the salt in that dir),
 * the skip list as the daemon writes it, and WhatsApp writing to the
 * fixture meanwhile (writeAsWhatsApp).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { ReaderReplySchema, type ReaderReply } from '../../src/messages/reader-protocol.js';
import { FIXTURE_NOW, WA_TYPE, type FixturePaths } from './fixture.js';

const START_MS = 10_000;
const KEY_HEX = 16;

/** An id's digits, as WhatsApp stores a mention of it ("@" + these). */
export const digitsOf = (jid: string) => jid.split('@')[0]!;
/** Fake ids for chats a test adds (fixture.ts's ranges). */
export const userJid = (digits: string) => `${digits}${'@s.whatsapp.net'}`;
export const groupJid = (n: number) => `120363000000000${String(n).padStart(3, '0')}${'@g.us'}`;

export interface AddedLine {
  stanza: string;
  /** Core Data seconds. */
  at: number;
  text?: string;
  /** Who wrote a group line, by member id; the owner's lines carry none. */
  member?: string;
  fromMe?: boolean;
  /** An image with this caption. */
  caption?: string;
  /** Its file, under <container>/Message (written by the test). */
  localPath?: string;
  /** ZMESSAGETYPE (WA_TYPE); text, or image with a caption, by default. */
  type?: number;
}

/**
 * WhatsApp writing to the fixture's ChatStorage meanwhile (its own
 * connection): a line at the end of a chat, a chat with one line, or a chat
 * gone with its lines.
 */
export function writeAsWhatsApp(p: FixturePaths) {
  const db = new DatabaseSync(join(p.container, 'ChatStorage.sqlite'));
  const one = <T>(sql: string, ...args: (string | number)[]) => db.prepare(sql).get(...args) as T;
  const nextPk = (table: string) => one<{ pk: number | null }>(`SELECT max(Z_PK) AS pk FROM ${table}`).pk! + 1;
  const line = (jid: string, l: AddedLine) => {
    const chat = one<{ pk: number }>('SELECT Z_PK AS pk FROM ZWACHATSESSION WHERE ZCONTACTJID = ?', jid).pk;
    const sort = one<{ sort: number | null }>('SELECT max(ZSORT) AS sort FROM ZWAMESSAGE WHERE ZCHATSESSION = ?', chat).sort ?? 0;
    const member = l.member
      ? one<{ pk: number }>('SELECT Z_PK AS pk FROM ZWAGROUPMEMBER WHERE ZCHATSESSION = ? AND ZMEMBERJID = ?', chat, l.member).pk
      : null;
    let media: number | null = null;
    if (l.caption !== undefined) {
      media = nextPk('ZWAMEDIAITEM');
      db.prepare('INSERT INTO ZWAMEDIAITEM (Z_PK, Z_ENT, Z_OPT, ZFILESIZE, ZTITLE, ZMEDIALOCALPATH) VALUES (?, 3, 1, 0, ?, ?)').run(media, l.caption, l.localPath ?? null);
    }
    db.prepare(
      'INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZISFROMME, ZMESSAGETYPE, ZSORT, ZCHATSESSION, ZGROUPMEMBER, ZMEDIAITEM, ZMESSAGEDATE, ZSTANZAID, ZTEXT) VALUES (?, 2, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(nextPk('ZWAMESSAGE'), l.fromMe ? 1 : 0, l.type ?? (media === null ? WA_TYPE.text : WA_TYPE.image), sort + 1, chat, member, media, l.at, l.stanza, l.text ?? null);
  };
  return {
    line,
    chat(c: { jid: string; type: number; name: string; at: number; removed?: boolean; hidden?: boolean }) {
      db.prepare(
        'INSERT INTO ZWACHATSESSION (Z_PK, Z_ENT, Z_OPT, ZARCHIVED, ZHIDDEN, ZREMOVED, ZSESSIONTYPE, ZUNREADCOUNT, ZLASTMESSAGEDATE, ZCONTACTJID, ZPARTNERNAME) VALUES (?, 1, 1, 0, ?, ?, ?, 0, ?, ?, ?)',
      ).run(nextPk('ZWACHATSESSION'), c.hidden ? 1 : 0, c.removed ? 1 : 0, c.type, c.at, c.jid, c.name);
      line(c.jid, { stanza: `3EB0FXC${digitsOf(c.jid).slice(-6)}`, at: c.at, text: `A line in ${c.name}` });
    },
    /** A chat gone from WhatsApp (the owner deleted it): its row and its lines. */
    drop(jid: string) {
      const chat = one<{ pk: number }>('SELECT Z_PK AS pk FROM ZWACHATSESSION WHERE ZCONTACTJID = ?', jid).pk;
      db.prepare('DELETE FROM ZWAMESSAGE WHERE ZCHATSESSION = ?').run(chat);
      db.prepare('DELETE FROM ZWACHATSESSION WHERE Z_PK = ?').run(chat);
    },
    close: () => db.close(),
  };
}

export interface Running {
  sock: string;
  state: string;
  call(op: string, args?: Record<string, unknown>): Promise<ReaderReply>;
  /** The reply's data, failing the test on an error reply. */
  ok(op: string, args?: Record<string, unknown>): Promise<unknown>;
  /** One raw line out, the next reply back. */
  raw(line: string): Promise<ReaderReply>;
  stop(): Promise<void>;
}

/** The reader's key for a WhatsApp id, from the salt in its state dir. */
export function keyOf(state: string, jid: string): string {
  return `c${createHmac('sha256', readFileSync(join(state, 'salt'))).update(jid).digest('hex').slice(0, KEY_HEX)}`;
}

/** skip.json as the daemon writes it: a temp file renamed over the old one. */
export function writeSkip(state: string, chatKeys: string[]): void {
  const tmp = join(state, 'skip.json.tmp');
  writeFileSync(tmp, JSON.stringify({ version: 1, chatKeys }), { mode: 0o600 });
  renameSync(tmp, join(state, 'skip.json'));
}

export function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function filesUnder(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? filesUnder(root, rel) : [rel];
  });
}

async function connect(sock: string, proc: ChildProcess): Promise<Socket> {
  const until = Date.now() + START_MS;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`reader exited ${proc.exitCode}`);
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const s = createConnection(sock);
        s.once('connect', () => resolve(s));
        s.once('error', reject);
      });
    } catch (e) {
      if (Date.now() > until) throw e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

/** Starts the reader binary on `fixture` (with `--now`, FIXTURE_NOW unless given) and connects to it. */
export async function startReader(bin: string, o: { fixture: FixturePaths; state: string; sock: string; now?: string }): Promise<Running> {
  const { fixture, state, sock } = o;
  const proc = spawn(bin, ['--container', fixture.container, '--phone-db', fixture.phoneDb, '--socket', sock, '--state', state, '--now', o.now ?? FIXTURE_NOW], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr!.on('data', (b: Buffer) => (stderr += b.toString()));
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  let socket: Socket;
  try {
    socket = await connect(sock, proc);
  } catch (e) {
    proc.kill('SIGKILL');
    throw new Error(`reader did not start: ${String(e)} ${stderr}`);
  }
  const waiting: ((r: ReaderReply) => void)[] = [];
  createInterface({ input: socket }).on('line', (line) => waiting.shift()?.(ReaderReplySchema.parse(JSON.parse(line))));
  let next = 1;
  const raw = (line: string) =>
    new Promise<ReaderReply>((resolve) => {
      waiting.push(resolve);
      socket.write(`${line}\n`);
    });
  const call = (op: string, args: Record<string, unknown> = {}) => raw(JSON.stringify({ id: next++, op, args }));
  return {
    sock,
    state,
    call,
    raw,
    async ok(op, args) {
      const reply = await call(op, args);
      if (!reply.ok) throw new Error(`${op}: ${reply.error} ${reply.detail ?? ''}`);
      return reply.data;
    },
    async stop() {
      socket.destroy();
      proc.kill('SIGTERM');
      await exited;
    },
  };
}
