/**
 * jantar-messages-reader, the core (Task 3), run as a real process on the
 * synthetic container (fixture.ts) with a temp socket and state dir:
 * - the socket is 0600 and checks its caller's uid (getpeereid);
 * - status, chats, read and readByName answer what the fixture holds, in
 *   the shapes reader-protocol.ts checks;
 * - the skip list hides a person everywhere (both ids, their group lines)
 *   and a skipped chat is `not_found`, never `skipped`;
 * - a missing column is `unsupported`; a skip list that won't parse and a
 *   closed WhatsApp (no -wal) are `busy`; WhatsApp's files are never changed;
 * - keys are stable across restarts and depend on the salt.
 * WhatsApp counts as running (whatsAppRunning) unless a test says otherwise.
 * Skipped where Swift can't build the reader (not macOS, no Command Line Tools).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  READER_VERSION,
  ReaderChatsSchema,
  ReaderReadByNameSchema,
  ReaderReadSchema,
  ReaderReplySchema,
  ReaderStatusSchema,
  type ReaderReply,
} from '../../src/messages/reader-protocol.js';
import { FIXTURE_MEDIA, FIXTURE_NEWEST_AT, FIXTURE_NOW, FIXTURE_TEXT, appleSeconds, makeWhatsAppFixture, type FixturePaths } from './fixture.js';
import { READER_ASSET, buildReader, whatsAppRunning } from './reader-build.js';

const reader = await buildReader();

const START_MS = 10_000;
const EX_USAGE = 64;
const KEY_HEX = 16;

interface Running {
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
function keyOf(state: string, jid: string): string {
  return `c${createHmac('sha256', readFileSync(join(state, 'salt'))).update(jid).digest('hex').slice(0, KEY_HEX)}`;
}

/** skip.json as the daemon writes it: a temp file renamed over the old one. */
function writeSkip(state: string, chatKeys: string[]): void {
  const tmp = join(state, 'skip.json.tmp');
  writeFileSync(tmp, JSON.stringify({ version: 1, chatKeys }), { mode: 0o600 });
  renameSync(tmp, join(state, 'skip.json'));
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function filesUnder(root: string, prefix = ''): string[] {
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

describe.skipIf(!reader)('jantar-messages-reader', () => {
  let dir: string;
  let paths: FixturePaths;
  const running: Running[] = [];
  const held: { close(): void }[] = [];

  /** A fixture with WhatsApp running (its stores held open). */
  function fixture(sub: string, spec?: Parameters<typeof makeWhatsAppFixture>[1]): FixturePaths {
    const p = makeWhatsAppFixture(join(dir, sub), spec);
    held.push(whatsAppRunning(p));
    return p;
  }

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-reader-')));
    paths = fixture('wa');
  });
  afterEach(async () => {
    for (const r of running.splice(0)) await r.stop();
    for (const h of held.splice(0)) h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(opts: { state?: string; fixture?: FixturePaths; sock?: string } = {}): Promise<Running> {
    const fixture = opts.fixture ?? paths;
    const state = opts.state ?? join(dir, 'state');
    const sock = opts.sock ?? join(dir, `r${running.length}.sock`);
    const proc = spawn(reader!, ['--container', fixture.container, '--phone-db', fixture.phoneDb, '--socket', sock, '--state', state, '--now', FIXTURE_NOW], {
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
    const r: Running = {
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
    running.push(r);
    return r;
  }

  const groupLine = (key: string, stanza: string) => `${key}.${stanza}`;

  it('status reports a readable container', async () => {
    const r = await start();
    const sock = statSync(r.sock);
    expect(sock.isSocket()).toBe(true);
    expect(sock.mode & 0o777).toBe(0o600);

    const status = ReaderStatusSchema.parse(await r.ok('status'));
    expect(status).toMatchObject({
      whatsapp: { found: true, schemaOk: true, newestAt: FIXTURE_NEWEST_AT },
      phone: { readable: true },
      skipped: 0,
      version: READER_VERSION,
    });
    expect(typeof status.whatsapp.running).toBe('boolean');
    expect(status.whatsapp.walMtime).toEqual(expect.any(String));
  });

  it('a closed WhatsApp (no -wal) answers busy, never no_access', async () => {
    const closed = makeWhatsAppFixture(join(dir, 'closed'));
    const r = await start({ fixture: closed });
    const status = ReaderStatusSchema.parse(await r.ok('status'));
    expect(status.whatsapp).toMatchObject({ found: true, schemaOk: true, newestAt: null, walMtime: null });
    expect(await r.call('chats', { limit: 50 })).toMatchObject({ ok: false, error: 'busy' });
    expect(filesUnder(closed.container).filter((f) => f.endsWith('-wal'))).toEqual([]);

    held.push(whatsAppRunning(closed));
    expect(ReaderChatsSchema.parse(await r.ok('chats', { limit: 50 })).total).toBe(5);
  });

  it('a missing container is not found, and reads say so', async () => {
    const r = await start({ fixture: { ...paths, container: join(dir, 'nowhere') } });
    expect(ReaderStatusSchema.parse(await r.ok('status')).whatsapp).toMatchObject({ found: false, schemaOk: false, newestAt: null });
    expect(await r.call('chats', { limit: 50 })).toMatchObject({ ok: false, error: 'no_access' });
  });

  it('chats leaves out status, newsletter and broadcast', async () => {
    const r = await start();
    const all = ReaderChatsSchema.parse(await r.ok('chats', { limit: 50 }));
    expect(all.chats.map((c) => c.name)).toEqual(['Group One', 'Asha Test', 'Ravi Test', 'Mom', 'Mom']);
    expect(all.total).toBe(5);

    // Mom 2's last line (08:05) is newer than Mom 1's (08:02).
    const [group, asha, ravi, mom2, mom1] = all.chats;
    expect(group).toMatchObject({ chatKey: keyOf(r.state, paths.jids.group), kind: 'group', members: 4, unread: 3, lastAt: FIXTURE_NEWEST_AT, lastFromMe: false });
    expect(group).not.toHaveProperty('phone');
    // Asha's chat is under her @lid; her number comes through LID.sqlite.
    expect(asha).toMatchObject({ chatKey: keyOf(r.state, paths.jids.ashaLid), kind: 'dm', phone: '919990000001', unread: 1, lastFromMe: false, archived: false });
    expect(ravi).toMatchObject({ phone: '919990000002', lastFromMe: true });
    expect(mom1).toMatchObject({ chatKey: keyOf(r.state, paths.jids.mom1), lastFromMe: false });
    expect(mom2).toMatchObject({ chatKey: keyOf(r.state, paths.jids.mom2), lastFromMe: true });

    // Waiting on the owner: 1:1s whose last message is theirs, within three days of --now.
    const waiting = ReaderChatsSchema.parse(await r.ok('chats', { limit: 50, waiting: true }));
    expect(waiting.chats.map((c) => c.chatKey)).toEqual([asha!.chatKey, mom1!.chatKey]);

    const moms = ReaderChatsSchema.parse(await r.ok('chats', { limit: 50, q: 'MOM' }));
    expect(moms).toMatchObject({ total: 2, chats: [{ name: 'Mom' }, { name: 'Mom' }] });
    const since = ReaderChatsSchema.parse(await r.ok('chats', { limit: 50, since: '2026-11-13T12:00:00.000Z' }));
    expect(since.chats.map((c) => c.name)).toEqual(['Group One', 'Asha Test']);
    const one = ReaderChatsSchema.parse(await r.ok('chats', { limit: 1 }));
    expect(one).toMatchObject({ total: 5, chats: [{ name: 'Group One' }] });

    // WhatsApp's unsent drafts and last-message previews are never read.
    const out = JSON.stringify([all, waiting, moms]);
    expect(out).not.toContain(FIXTURE_TEXT.savedInput);
    expect(out).not.toContain(FIXTURE_TEXT.lastMessageText);
    expect(out).not.toMatch(/@s\.whatsapp\.net|@lid|@g\.us/);
  });

  it('read returns kinds, senders and replies', async () => {
    const r = await start();
    const key = keyOf(r.state, paths.jids.group);
    const res = ReaderReadSchema.parse(await r.ok('read', { chatKey: key, limit: 50 }));
    expect(res.chat).toMatchObject({ chatKey: key, name: 'Group One', kind: 'group', members: 4 });
    expect(res.more).toBe(false);
    const ats = res.messages.map((m) => m.at);
    expect(ats).toEqual([...ats].sort());
    expect(res.messages).toHaveLength(6);
    const line = (stanza: string) => res.messages.find((m) => m.msgKey === groupLine(key, stanza));

    expect(line('3EB0FX0701')).toMatchObject({ fromMe: true, sender: 'Me', kind: 'text', text: 'Agenda for Saturday is in the doc.' });
    expect(line('3EB0FX0702')).toMatchObject({ fromMe: false, sender: 'Asha Test', kind: 'text', replyTo: groupLine(key, '3EB0FX0701') });
    expect(line('3EB0FX0703')).toMatchObject({ sender: 'Ravi Test', text: FIXTURE_TEXT.mention, mentionsMe: true });
    const jpegBytes = statSync(join(paths.container, 'Message', FIXTURE_MEDIA.localPath)).size;
    expect(line('3EB0FX0704')).toMatchObject({ sender: 'Neel Test', kind: 'image', caption: FIXTURE_TEXT.caption, media: { kind: 'image', bytes: jpegBytes, local: true } });
    const deleted = line('3EB0FX0705')!;
    expect(deleted).toMatchObject({ sender: 'Ravi Test', kind: 'deleted' });
    expect(deleted).not.toHaveProperty('text');
    expect(deleted).not.toHaveProperty('media');
    const system = line('3EB0FX0706')!;
    expect(system.kind).toBe('system');
    expect(system).not.toHaveProperty('text');
    expect(res.messages.filter((m) => m.mentionsMe)).toHaveLength(1);

    // Newest first when cut: `more` says older ones exist; `before` pages back.
    const last2 = ReaderReadSchema.parse(await r.ok('read', { chatKey: key, limit: 2 }));
    expect(last2.messages.map((m) => m.msgKey)).toEqual([groupLine(key, '3EB0FX0705'), groupLine(key, '3EB0FX0706')]);
    expect(last2.more).toBe(true);
    const older = ReaderReadSchema.parse(await r.ok('read', { chatKey: key, limit: 50, before: last2.messages[0]!.at }));
    expect(older.messages).toHaveLength(4);
    expect(older.more).toBe(false);
    const since = ReaderReadSchema.parse(await r.ok('read', { chatKey: key, limit: 50, since: '2026-11-13T14:00:00.000Z' }));
    expect(since.messages).toHaveLength(3);

    // Other people's words come back as text, nothing more.
    const ravi = ReaderReadSchema.parse(await r.ok('read', { chatKey: keyOf(r.state, paths.jids.ravi), limit: 50 }));
    expect(ravi.chat.phone).toBe('919990000002');
    expect(ravi.messages.find((m) => m.text === FIXTURE_TEXT.injection)).toMatchObject({ sender: 'Ravi Test', fromMe: false, kind: 'text' });
  });

  it('readByName with two matches lists both', async () => {
    const r = await start();
    const res = ReaderReadByNameSchema.parse(await r.ok('readByName', { name: 'Mom', limit: 50 }));
    if (!('ambiguous' in res)) throw new Error('expected candidates');
    expect(res.ambiguous.map((c) => c.chatKey).sort()).toEqual([keyOf(r.state, paths.jids.mom1), keyOf(r.state, paths.jids.mom2)].sort());
    expect(res.ambiguous.map((c) => c.name)).toEqual(['Mom', 'Mom']);
    for (const c of res.ambiguous) expect(c).not.toHaveProperty('phone');

    const asha = ReaderReadByNameSchema.parse(await r.ok('readByName', { name: 'asha test', limit: 50 }));
    if ('ambiguous' in asha) throw new Error('expected one chat');
    expect(asha.chat.name).toBe('Asha Test');
    expect(asha.messages.at(-1)?.text).toBe(FIXTURE_TEXT.deck);

    expect(await r.call('readByName', { name: 'Nobody Here', limit: 50 })).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('skipping Asha hides her dm, her @lid twin, her group lines', async () => {
    const r = await start();
    const ashaKey = keyOf(r.state, paths.jids.ashaLid);
    const groupKey = keyOf(r.state, paths.jids.group);
    writeSkip(r.state, [ashaKey]);

    const chats = ReaderChatsSchema.parse(await r.ok('chats', { limit: 50 }));
    expect(chats.chats.map((c) => c.name)).toEqual(['Group One', 'Ravi Test', 'Mom', 'Mom']);
    expect(chats.total).toBe(4);
    const group = ReaderReadSchema.parse(await r.ok('read', { chatKey: groupKey, limit: 50 }));
    const hers = group.messages.find((m) => m.msgKey === groupLine(groupKey, '3EB0FX0702'))!;
    expect(hers).toMatchObject({ sender: '[skipped]', skippedSender: true, fromMe: false });
    for (const field of ['text', 'caption', 'media', 'replyTo', 'mentionsMe']) expect(hers).not.toHaveProperty(field);
    expect(JSON.stringify(group)).not.toContain('Asha');
    expect(await r.call('read', { chatKey: ashaKey, limit: 50 })).toMatchObject({ ok: false, error: 'not_found' });
    expect(await r.call('readByName', { name: 'Asha Test', limit: 50 })).toMatchObject({ ok: false, error: 'not_found' });
    expect(ReaderStatusSchema.parse(await r.ok('status')).skipped).toBe(1);

    // Skipped by her phone number's key instead, her @lid chat goes too.
    writeSkip(r.state, [keyOf(r.state, paths.jids.asha)]);
    expect(ReaderChatsSchema.parse(await r.ok('chats', { limit: 50 })).chats.map((c) => c.name)).not.toContain('Asha Test');
    expect(await r.call('read', { chatKey: ashaKey, limit: 50 })).toMatchObject({ ok: false, error: 'not_found' });

    // A skipped group is gone; its members' 1:1s stay.
    writeSkip(r.state, [groupKey]);
    const noGroup = ReaderChatsSchema.parse(await r.ok('chats', { limit: 50 }));
    expect(noGroup.chats.map((c) => c.name)).toEqual(['Asha Test', 'Ravi Test', 'Mom', 'Mom']);
    expect(await r.call('read', { chatKey: groupKey, limit: 50 })).toMatchObject({ ok: false, error: 'not_found' });

    writeSkip(r.state, []);
    expect(ReaderChatsSchema.parse(await r.ok('chats', { limit: 50 })).total).toBe(5);
  });

  it('a skip list it cannot read refuses reads (never reads everything)', async () => {
    const r = await start();
    writeFileSync(join(r.state, 'skip.json'), '{"version":1,"chatKeys":["c0123', { mode: 0o600 });
    expect(await r.call('chats', { limit: 50 })).toMatchObject({ ok: false, error: 'busy' });
    expect(await r.call('read', { chatKey: keyOf(r.state, paths.jids.group), limit: 50 })).toMatchObject({ ok: false, error: 'busy' });
    writeSkip(r.state, []);
    expect(ReaderChatsSchema.parse(await r.ok('chats', { limit: 50 })).total).toBe(5);
  });

  it('schema mismatch says unsupported', async () => {
    const broken = fixture('broken', { dropColumn: 'ZSTANZAID' });
    const r = await start({ fixture: broken });
    const status = ReaderStatusSchema.parse(await r.ok('status'));
    expect(status.whatsapp).toMatchObject({ found: true, schemaOk: false, newestAt: null });
    expect(await r.call('read', { chatKey: keyOf(r.state, broken.jids.group), limit: 50 })).toMatchObject({ ok: false, error: 'unsupported' });
    expect(await r.call('chats', { limit: 50 })).toMatchObject({ ok: false, error: 'unsupported' });
  });

  it('the container is untouched', async () => {
    const r = await start();
    const main = join(paths.container, 'ChatStorage.sqlite');
    const before = sha256(main);
    const files = filesUnder(paths.container);
    const groupKey = keyOf(r.state, paths.jids.group);

    // WhatsApp writing meanwhile: a second connection adds a line to Group One.
    const writer = new DatabaseSync(main);
    try {
      const chat = writer.prepare('SELECT Z_PK AS pk FROM ZWACHATSESSION WHERE ZCONTACTJID = ?').get(paths.jids.group) as { pk: number };
      const top = writer.prepare('SELECT max(Z_PK) AS pk, max(ZSORT) AS sort FROM ZWAMESSAGE').get() as { pk: number; sort: number };
      writer
        .prepare('INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZISFROMME, ZMESSAGETYPE, ZSORT, ZCHATSESSION, ZMESSAGEDATE, ZSTANZAID, ZTEXT) VALUES (?, 2, 1, 0, 0, ?, ?, ?, ?, ?)')
        .run(top.pk + 1, top.sort + 1, chat.pk, appleSeconds('2026-11-13T21:00:00.000Z'), '3EB0FX0799', 'A new line while the reader reads');

      for (let i = 0; i < 20; i++) {
        const op = i % 3;
        if (op === 0) await r.ok('read', { chatKey: groupKey, limit: 50 });
        else if (op === 1) await r.ok('chats', { limit: 50 });
        else await r.ok('status');
      }
      const latest = ReaderReadSchema.parse(await r.ok('read', { chatKey: groupKey, limit: 1 }));
      expect(latest.messages[0]?.msgKey).toBe(groupLine(groupKey, '3EB0FX0799'));

      expect(sha256(main)).toBe(before);
      const after = filesUnder(paths.container);
      expect(after).toEqual(expect.arrayContaining(files));
      // The one footprint SQLite may leave: -wal and -shm beside a database.
      expect(after.filter((f) => !files.includes(f)).every((f) => /\.sqlite-(?:wal|shm)$/.test(f))).toBe(true);
    } finally {
      writer.close();
    }
  });

  it('another uid is refused: the server checks every caller with getpeereid', () => {
    const src = readFileSync(READER_ASSET, 'utf8');
    expect(src).toMatch(/getpeereid\(/);
    expect(src).toMatch(/getuid\(\)/);
    // Single-purpose: no child processes, no network, never immutable=1, never WhatsApp's draft or preview columns.
    expect(src).not.toMatch(/\bProcess\(|URLSession|NSTask|immutable=1|ZSAVEDINPUT|ZLASTMESSAGETEXT/);
  });

  it('keys are stable across restarts and unguessable without the salt', async () => {
    const state = join(dir, 'kept');
    const first = await start({ state });
    const keys = ReaderChatsSchema.parse(await first.ok('chats', { limit: 50 })).chats.map((c) => c.chatKey);
    await first.stop();
    running.splice(running.indexOf(first), 1);

    const salt = statSync(join(state, 'salt'));
    expect(salt.size).toBe(32);
    expect(salt.mode & 0o777).toBe(0o600);
    expect(statSync(state).mode & 0o777).toBe(0o700);
    expect(keys).toContain(keyOf(state, paths.jids.group));

    const again = await start({ state });
    expect(ReaderChatsSchema.parse(await again.ok('chats', { limit: 50 })).chats.map((c) => c.chatKey)).toEqual(keys);
    const other = await start({ state: join(dir, 'other') });
    const otherKeys = ReaderChatsSchema.parse(await other.ok('chats', { limit: 50 })).chats.map((c) => c.chatKey);
    expect(otherKeys).toHaveLength(keys.length);
    expect(otherKeys.filter((k) => keys.includes(k))).toEqual([]);
  });

  it('bad arguments exit 64 and bad requests answer bad_request', async () => {
    expect(spawnSync(reader!, [], { stdio: 'ignore' }).status).toBe(EX_USAGE);
    expect(spawnSync(reader!, ['--container', paths.container, '--state', join(dir, 's')], { stdio: 'ignore' }).status).toBe(EX_USAGE);
    expect(spawnSync(reader!, ['--container', 'relative', '--phone-db', paths.phoneDb, '--socket', join(dir, 'x.sock'), '--state', join(dir, 's')], { stdio: 'ignore' }).status).toBe(EX_USAGE);

    const r = await start();
    expect(await r.raw('not json')).toMatchObject({ id: 0, ok: false, error: 'bad_request' });
    expect(await r.raw(JSON.stringify({ id: 5, op: 'drop', args: {} }))).toMatchObject({ id: 5, ok: false, error: 'bad_request' });
    expect(await r.raw(JSON.stringify({ id: 6, op: 'read', args: { chatKey: 'nope', limit: 5 } }))).toMatchObject({ id: 6, ok: false, error: 'bad_request' });
    expect(await r.raw(JSON.stringify({ id: 7, op: 'chats', args: { limit: 500 } }))).toMatchObject({ id: 7, ok: false, error: 'bad_request' });
    expect(await r.raw(JSON.stringify({ id: 8, op: 'read', args: { chatKey: keyOf(r.state, paths.jids.group), limit: 5, since: 'yesterday' } }))).toMatchObject({ id: 8, error: 'bad_request' });
    // The connection still answers.
    expect(await r.raw(JSON.stringify({ id: 9, op: 'status', args: {} }))).toMatchObject({ id: 9, ok: true });
  });
});
