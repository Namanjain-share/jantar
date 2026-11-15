/**
 * The daemon's Messages part (0.15, messages/service.ts) against a fake
 * reader (fake-reader.ts: the reader's protocol, no Swift):
 * - status: a socket that doesn't answer is `down`, its sentence naming the
 *   fix; no reader installed is `not_installed`; an installed reader built
 *   from another source (its .key) or speaking another version is
 *   `update_needed`; the reader's own flags map to `unsupported`,
 *   `no_access` and details; a messages.db that won't open is in it, and
 *   the morning run is unknown while messages.db is closed;
 * - every read lands in the read log with ids and counts only (never text,
 *   a name or a number), the newest READS_KEEP kept;
 * - the skip list lives in messages.db and its 0600 mirror (skip.json, what
 *   the reader enforces) is written at open and after every change; only
 *   the Mac's CLI removes a skip; a new messages.db keeps the keys skip.json
 *   lists (one that won't open, or that the reader would refuse, is never
 *   written over, and reads wait for it), a mirror deleted or edited
 *   outside is written again before the next read, and a change that fails
 *   leaves the mirror as the table is; after a lost salt status says so,
 *   and the Mac's reset finds the old chats again by name before reads go
 *   on (`--forget` only after a lookup with the reader back, naming them);
 * - media: an image comes back shrunk by jantar-media (stubbed), anything
 *   else by name and size, and the reader's spool copy is gone either way;
 *   a job left from a crash goes at start;
 * - callsToReturn leaves out calls returned by a later message, an outgoing
 *   call or a later answered call, and a calls store refused or changed
 *   (named in the answer), never a reader of another build;
 * - Today's runs: the day's runs that made something, at most five;
 * - with the real reader (where Swift builds it): the skip list the daemon
 *   writes is the one the reader enforces, and media comes through its spool.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsSchema } from '@jantar/protocol';
import { MessagesStatusSchema, type Call, type Chat, type Message, type MorningRun } from '@jantar/protocol/messages';
import type { Actor, CcwLegacySource, DaemonContext, LifeService, MessagesService, Paths, UsageSource } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { createTestContext } from '../../src/core/testing.js';
import { resolvePaths } from '../../src/config.js';
import { MESSAGES_BROKEN_REASON, READS_KEEP, addRead, listReads, madeRuns, openMessagesDb, putRun } from '../../src/messages/db.js';
import { buildMessagesService, type ImageShrinker } from '../../src/messages/index.js';
import { ReaderFailure, createReaderClient, type ReaderClient } from '../../src/messages/reader-client.js';
import { READER_SOURCE, READER_VERSION, readerSourceKey, type ReaderOp, type ReaderStatus } from '../../src/messages/reader-protocol.js';
import { MESSAGES_SAYS, READER_MISMATCH } from '../../src/messages/says.js';
import { SKIP_KEPT_NAME } from '../../src/messages/skip.js';
import { readerError, startFakeReader, type FakeHandler, type FakeHandlers, type FakeReader } from './fake-reader.js';
import { makeWhatsAppFixture } from './fixture.js';
import { buildReader, whatsAppRunning } from './reader-build.js';
import { keyOf, startReader } from './reader-harness.js';

const bin = await buildReader();

const NOW = '2026-11-14T03:00:00.000Z';
// Keys as the reader makes them ("c" + 16 hex); no run of ten digits in any of them.
const ASHA = 'ca1b2c3d4e5f6a7b8';
const RAVI = 'cb2c3d4e5f6a7b8c9';
const MOM = 'cc3d4e5f6a7b8c9d0';
const GROUP = 'cd4e5f6a7b8c9d0e1';
const DECK = 'Can you send the deck by Friday 5pm?';
const CLI: Actor = { kind: 'cli' };
const PHONE: Actor = { kind: 'device', deviceId: 'dev1', scopes: ['control'] };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

const chat = (chatKey: string, name: string, kind: Chat['kind'] = 'dm', lastAt = '2026-11-13T18:00:00.000Z'): Chat => ({
  chatKey,
  name,
  kind,
  lastAt,
  unread: 0,
  lastFromMe: false,
  archived: false,
});
const line = (chatKey: string, n: number, text: string, at: string, fromMe = false): Message => ({
  msgKey: `${chatKey}.3EB0A${n}`,
  at,
  fromMe,
  sender: fromMe ? 'Me' : 'Asha Test',
  kind: 'text',
  text,
});
const call = (n: number, o: Partial<Call> & Pick<Call, 'at' | 'who'>): Call => ({
  callKey: `k${String(n).padStart(2, '0')}e1f2a3b4c5d6e7`,
  via: 'whatsapp',
  incoming: true,
  missed: true,
  video: false,
  durationS: 0,
  ...o,
});

/** What a reader that is up and reading says. */
const READY: ReaderStatus = {
  whatsapp: { found: true, running: true, schemaOk: true, contactsOk: true, newestAt: '2026-11-13T20:00:00.000Z', walMtime: '2026-11-13T20:00:01.000Z' },
  phone: { readable: false },
  skipped: 0,
  skipOk: true,
  version: READER_VERSION,
};

const notUsed = <T extends object>() => notBuilt<T>('not used here');

let dir: string;
const cleanups: (() => Promise<void> | void)[] = [];

beforeEach(() => {
  // A short folder: the reader's socket path must stay under 104 bytes.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'jm-')));
  chmodSync(dir, 0o700);
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  rmSync(dir, { recursive: true, force: true });
});

interface Setup {
  svc: MessagesService;
  paths: Paths;
  reader: FakeReader | null;
  ctx: DaemonContext;
}

/** The part on a test context (FakeClock at NOW, Messages on), the reader installed from this source, and a fake reader when `handlers` are given. */
async function setup(o: { handlers?: FakeHandlers; shrinker?: ImageShrinker; dbFile?: string; installed?: boolean; prepare?: (paths: Paths) => void } = {}): Promise<Setup> {
  const paths: Paths = { ...resolvePaths({ env: { HOME: dir }, userHome: dir, home: join(dir, 'j') }), messagesReaderSock: join(dir, 'r.sock') };
  const ctx = createTestContext({ paths, clock: new FakeClock(NOW), settings: SettingsSchema.parse({ messages: { enabled: true } }) });
  if (o.installed !== false) {
    mkdirSync(dirname(paths.messagesReaderBin), { recursive: true, mode: 0o700 });
    writeFileSync(paths.messagesReaderBin, '', { mode: 0o700 });
    writeFileSync(`${paths.messagesReaderBin}.key`, readerSourceKey(readFileSync(join(paths.assetsDir, READER_SOURCE), 'utf8')));
  }
  o.prepare?.(paths);
  const reader = o.handlers ? await startFakeReader(paths.messagesReaderSock, o.handlers) : null;
  if (reader) cleanups.push(() => reader.close());
  const svc = buildMessagesService(
    ctx,
    { life: notUsed<LifeService>(), usage: notUsed<UsageSource>(), ccwLegacy: notUsed<CcwLegacySource>() },
    { dbFile: o.dbFile ?? ':memory:', ...(o.shrinker ? { shrinker: o.shrinker } : {}) },
  );
  await svc.start();
  cleanups.push(() => svc.stop());
  return { svc, paths, reader, ctx };
}

describe('status', () => {
  it('status maps a missing socket to down', async () => {
    const { svc } = await setup();
    const st = await svc.status();
    expect(MessagesStatusSchema.parse(st)).toEqual(st);
    expect(st).toEqual({
      enabled: true,
      // Status's own sentence names the fix (the 503s keep MESSAGES_SAYS.down).
      reader: { state: 'down', detail: MESSAGES_SAYS.readerDown },
      whatsapp: { found: false, running: false, newestAt: null, schemaOk: false },
      phone: { readable: false },
      skipped: 0,
      morning: { at: null, lastRunAt: null },
    });
  });

  it("status says update_needed when the installed reader's key differs", async () => {
    let version = READER_VERSION;
    const t = await setup({ handlers: { status: () => ({ ...READY, version }) } });
    expect(await t.svc.status()).toMatchObject({
      reader: { state: 'ok' },
      whatsapp: { found: true, running: true, newestAt: '2026-11-13T20:00:00.000Z', schemaOk: true },
    });

    writeFileSync(`${t.paths.messagesReaderBin}.key`, 'f'.repeat(64));
    expect((await t.svc.status()).reader).toEqual({ state: 'update_needed', detail: MESSAGES_SAYS.updateNeeded });

    // The right build, but a running reader that speaks another version (not restarted since the update).
    writeFileSync(`${t.paths.messagesReaderBin}.key`, readerSourceKey(readFileSync(join(t.paths.assetsDir, READER_SOURCE), 'utf8')));
    version = READER_VERSION + 1;
    expect((await t.svc.status()).reader.state).toBe('update_needed');

    rmSync(t.paths.messagesReaderBin);
    expect((await t.svc.status()).reader).toEqual({ state: 'not_installed', detail: MESSAGES_SAYS.notInstalled });
  });

  it("status says which: WhatsApp's layout, its contact files, a broken skip list, WhatsApp closed", async () => {
    let st: ReaderStatus = READY;
    const t = await setup({ handlers: { status: () => st } });
    st = { ...READY, whatsapp: { ...READY.whatsapp, schemaOk: false } };
    expect((await t.svc.status()).reader).toEqual({ state: 'unsupported', detail: MESSAGES_SAYS.unsupported });
    st = { ...READY, whatsapp: { ...READY.whatsapp, contactsOk: false } };
    expect((await t.svc.status()).reader).toEqual({ state: 'no_access', detail: MESSAGES_SAYS.contacts });
    st = { ...READY, whatsapp: { ...READY.whatsapp, found: false, schemaOk: false, newestAt: null, walMtime: null } };
    expect((await t.svc.status()).reader).toEqual({ state: 'ok', detail: MESSAGES_SAYS.noWhatsApp });
    st = { ...READY, skipOk: false };
    expect((await t.svc.status()).reader).toEqual({ state: 'ok', detail: MESSAGES_SAYS.skipBroken });
    st = { ...READY, whatsapp: { ...READY.whatsapp, running: false, newestAt: null, walMtime: null } };
    expect((await t.svc.status()).reader).toEqual({ state: 'ok', detail: MESSAGES_SAYS.closed });
    // Every read answers busy while WhatsApp is closed: the sentence says nothing reads, not only the newest.
    expect(MESSAGES_SAYS.closed).toBe('WhatsApp is closed, and Messages reads nothing while it is. Open WhatsApp on the Mac.');
  });

  it("status says messages.db won't open, and the morning run is unknown while messages.db is closed", async () => {
    // A folder where messages.db should be: it won't open.
    const dbFile = join(dir, 'messages.db');
    mkdirSync(dbFile);
    const t = await setup({ dbFile, handlers: { status: () => READY } });
    expect(t.svc.broken()).toBe(MESSAGES_BROKEN_REASON);
    const broken = await t.svc.status();
    expect(MessagesStatusSchema.parse(broken)).toEqual(broken);
    expect(broken).toMatchObject({ enabled: true, reader: { state: 'ok' }, broken: MESSAGES_BROKEN_REASON, morning: null });
  });

  it('status while Messages is off: nothing broken, the morning run unknown (a time may be saved), never "off, never"', async () => {
    const on = await setup({ handlers: { status: () => READY } });
    expect(on.svc.morning.setPrefs({ morningAt: '08:00' }, CLI)).toEqual({ ok: true, value: true });
    expect((await on.svc.status()).morning).toEqual({ at: '08:00', lastRunAt: null });
    await on.ctx.settings.patch({ messages: { enabled: false } });
    const off = await on.svc.status();
    expect(off).toMatchObject({ enabled: false, morning: null });
    expect(off).not.toHaveProperty('broken');
  });
});

describe('the read log', () => {
  it('every read is logged with ids and counts only', async () => {
    const file = join(dir, 'messages.db');
    const asha = chat(ASHA, 'Asha Test');
    const t = await setup({
      dbFile: file,
      handlers: {
        read: (a) => {
          if (a.chatKey !== ASHA) throw readerError('not_found');
          return {
            chat: { ...asha, phone: '919990000001' },
            messages: [
              line(ASHA, 1, 'Hi, are you free tomorrow?', '2026-11-13T17:00:00.000Z'),
              line(ASHA, 2, 'Yes', '2026-11-13T17:05:00.000Z', true),
              line(ASHA, 3, DECK, '2026-11-13T18:00:00.000Z'),
            ],
            more: false,
          };
        },
        chats: () => ({ chats: [asha, chat(RAVI, 'Ravi Test')], total: 2 }),
        readByName: () => ({ ambiguous: [chat(MOM, 'Mom'), chat(GROUP, 'Mom')], total: 2 }),
        search: () => ({ hits: [{ chatKey: ASHA, chatName: 'Asha Test', msgKey: `${ASHA}.3EB0A3`, at: '2026-11-13T18:00:00.000Z', fromMe: false, sender: 'Asha Test', snippet: DECK }] }),
      },
    });
    const by = { via: 'mcp', pid: 4242, folder: '/Users/example/proj' } as const;

    const r = await t.svc.read(ASHA, { limit: 50 }, by);
    expect(r.messages).toHaveLength(3);
    expect(t.reader!.calls).toContainEqual({ op: 'read', args: { chatKey: ASHA, limit: 50 } });
    expect(t.svc.reads(1)).toEqual([{ at: NOW, via: 'mcp', pid: 4242, folder: 'proj', op: 'read', chatKey: ASHA, count: 3 }]);

    await t.svc.chats({ limit: 30, waiting: 'true' }, { via: 'cli' });
    expect(t.reader!.calls.at(-1)).toEqual({ op: 'chats', args: { limit: 30, waiting: true } });
    expect(await t.svc.readByName('Mom', { limit: 50 }, { via: 'phone' })).toMatchObject({ total: 2 });
    await t.svc.search({ q: 'deck', limit: 20, chat: ASHA }, { via: 'cli' });
    expect(t.reader!.calls.at(-1)).toEqual({ op: 'search', args: { q: 'deck', limit: 20, chatKey: ASHA } });
    // A read that fails reads nothing and logs nothing.
    await expect(t.svc.read(RAVI, { limit: 50 }, by)).rejects.toMatchObject({ code: 'not_found' });

    expect(t.svc.reads(10)).toEqual([
      { at: NOW, via: 'cli', op: 'search', chatKey: ASHA, count: 1 },
      { at: NOW, via: 'phone', op: 'readByName', count: 0 },
      { at: NOW, via: 'cli', op: 'chats', count: 2 },
      { at: NOW, via: 'mcp', pid: 4242, folder: 'proj', op: 'read', chatKey: ASHA, count: 3 },
    ]);

    const raw = new DatabaseSync(file, { readOnly: true });
    cleanups.push(() => raw.close());
    const rows = JSON.stringify(raw.prepare('SELECT * FROM reads').all());
    for (const words of [DECK, 'deck', 'Asha', 'Mom', '/Users/example', '919990000001']) expect(rows).not.toContain(words);
    expect(rows).not.toMatch(/\d{10}/);
  });

  it(`the read log keeps the newest ${READS_KEEP}`, () => {
    const r = openMessagesDb(':memory:');
    if (!r.ok) throw new Error(r.code);
    cleanups.push(() => r.db.close());
    for (let i = 0; i < READS_KEEP + 5; i++) addRead(r.db, { at: NOW, via: 'cli', op: 'read', chatKey: ASHA, count: i });
    expect((r.db.prepare('SELECT count(*) AS n FROM reads').get() as { n: number }).n).toBe(READS_KEEP);
    expect(listReads(r.db, 1)[0]!.count).toBe(READS_KEEP + 4);
  });
});

describe('the skip list', () => {
  it('skip add writes the mirror 0600 and remove refuses unknown', async () => {
    const t = await setup({
      handlers: {
        read: (a) => {
          if (a.chatKey !== ASHA) throw readerError('not_found');
          return { chat: chat(ASHA, 'Asha Test'), messages: [], more: false };
        },
      },
    });
    const mirror = join(t.paths.messagesDir, 'skip.json');
    const mirrored = () => JSON.parse(readFileSync(mirror, 'utf8')) as unknown;
    // Written at open, before any read.
    expect(mirrored()).toEqual({ version: 1, chatKeys: [] });
    expect(statSync(t.paths.messagesDir).mode & 0o777).toBe(0o700);

    expect(await t.svc.skip.add(ASHA, PHONE)).toEqual({ ok: true, value: true });
    expect(mirrored()).toEqual({ version: 1, chatKeys: [ASHA] });
    expect(statSync(mirror).mode & 0o777).toBe(0o600);
    expect(t.svc.skip.list()).toEqual([{ chatKey: ASHA, name: 'Asha Test', kind: 'dm', addedAt: NOW }]);
    expect((await t.svc.status()).skipped).toBe(1);
    // Again: nothing new, and the reader isn't asked (a skipped chat is not_found there).
    const asked = t.reader!.calls.length;
    expect(await t.svc.skip.add(ASHA, CLI)).toEqual({ ok: true, value: true });
    expect(t.reader!.calls).toHaveLength(asked);
    expect(t.svc.skip.list()).toHaveLength(1);
    // A chat the reader doesn't show can't be added.
    expect(await t.svc.skip.add(RAVI, CLI)).toMatchObject({ ok: false, code: 'not_found' });

    expect(t.svc.skip.remove(RAVI, CLI)).toMatchObject({ ok: false, code: 'not_found' });
    // The phone never widens what Jantar reads.
    expect(t.svc.skip.remove(ASHA, PHONE)).toEqual({ ok: false, code: 'forbidden', reason: MESSAGES_SAYS.skipRemoveMacOnly });
    expect(mirrored()).toEqual({ version: 1, chatKeys: [ASHA] });
    expect(t.svc.skip.remove(ASHA, CLI)).toEqual({ ok: true, value: true });
    expect(mirrored()).toEqual({ version: 1, chatKeys: [] });
    expect(t.svc.skip.list()).toEqual([]);
    // Only the mirror beside the installed reader: no temp file left.
    expect(readdirSync(t.paths.messagesDir).sort()).toEqual(['bin', 'skip.json']);
  });

  /** A reader that shows any chat it is asked for, as `name`. */
  const anyChat: FakeHandlers = { read: (a) => ({ chat: chat(String(a.chatKey), 'Asha Test'), messages: [], more: false }) };
  const mirrorOf = (t: Setup) => JSON.parse(readFileSync(join(t.paths.messagesDir, 'skip.json'), 'utf8')) as unknown;

  it('a reset messages.db keeps skip.json keys', async () => {
    const t = await setup({ dbFile: join(dir, 'messages.db'), handlers: anyChat });
    expect(await t.svc.skip.add(ASHA, CLI)).toEqual({ ok: true, value: true });
    await t.svc.stop();
    // The owner moved messages.db aside (its broken sentence says to) and a new, empty one opens.
    writeFileSync(join(t.paths.messagesDir, 'skip.json'), JSON.stringify({ version: 1, chatKeys: [ASHA] }));
    const fresh = await setup({ dbFile: join(dir, 'messages-new.db') });
    expect(fresh.svc.skip.list()).toEqual([{ chatKey: ASHA, name: SKIP_KEPT_NAME, kind: 'dm', addedAt: NOW }]);
    expect(mirrorOf(fresh)).toEqual({ version: 1, chatKeys: [ASHA] });
    expect((await fresh.svc.status()).skipped).toBe(1);
    // It is a skip like any other: the Mac removes it.
    expect(fresh.svc.skip.remove(ASHA, CLI)).toEqual({ ok: true, value: true });
    expect(mirrorOf(fresh)).toEqual({ version: 1, chatKeys: [] });
  });

  it('a reset messages.db never writes an empty list over a skip.json the reader would refuse', async () => {
    const own = JSON.stringify({ version: 1, chatKeys: [ASHA] });
    // Each breaks one of the reader's rules (jantar-messages-reader.swift SkipList.refresh).
    const broken: [string, (file: string) => void][] = [
      ['cut short', (f) => writeFileSync(f, own.slice(0, -3), { mode: 0o600 })],
      ['a trailing comma', (f) => writeFileSync(f, `{"version":1,"chatKeys":["${ASHA}"],}`, { mode: 0o600 })],
      ['another version', (f) => writeFileSync(f, JSON.stringify({ version: 2, chatKeys: [ASHA] }), { mode: 0o600 })],
      ['version true', (f) => writeFileSync(f, JSON.stringify({ version: true, chatKeys: [ASHA] }), { mode: 0o600 })],
      ['not a list', (f) => writeFileSync(f, JSON.stringify({ version: 1, chatKeys: { [ASHA]: true } }), { mode: 0o600 })],
      ['a key that is not one', (f) => writeFileSync(f, JSON.stringify({ version: 1, chatKeys: [ASHA, 'not a key'] }), { mode: 0o600 })],
      ['a folder', (f) => mkdirSync(f)],
      ['too large', (f) => writeFileSync(f, `${own}${' '.repeat(4 * 1024 * 1024)}`, { mode: 0o600 })],
    ];
    for (const [i, [why, write]] of broken.entries()) {
      const prepared: { file?: string; before?: string } = {};
      const t = await setup({
        dbFile: join(dir, `fresh-${i}.db`),
        handlers: { ...anyChat, chats: () => ({ chats: [], total: 0 }), status: () => ({ ...READY, skipOk: false }) },
        prepare: (paths) => {
          mkdirSync(paths.messagesDir, { recursive: true, mode: 0o700 });
          prepared.file = join(paths.messagesDir, 'skip.json');
          rmSync(prepared.file, { recursive: true, force: true });
          write(prepared.file);
          prepared.before = statSync(prepared.file).isFile() ? readFileSync(prepared.file, 'utf8') : 'a folder';
        },
      });
      const file = prepared.file!;
      // Never written over: the reader goes on refusing reads, and so does the daemon.
      await expect(t.svc.chats({ limit: 30 }, { via: 'cli' }), why).rejects.toMatchObject({ code: 'messages_unavailable', message: MESSAGES_SAYS.skipUnreadable });
      expect((await t.svc.status()).reader, why).toEqual({ state: 'ok', detail: MESSAGES_SAYS.skipLocked });
      expect(await t.svc.skip.add(RAVI, CLI), why).toEqual({ ok: false, code: 'unavailable', reason: MESSAGES_SAYS.skipWrite });
      expect(statSync(file).isFile() ? readFileSync(file, 'utf8') : 'a folder', why).toBe(prepared.before);
      expect(t.svc.skip.list(), why).toEqual([]);
      expect(t.reader!.calls.filter((c) => c.op === 'chats'), why).toEqual([]);
      await t.svc.stop();
      await t.reader!.close();
    }
  });

  it('skip.json deleted or edited outside the daemon is written again before the next read, and by status', async () => {
    const seen: unknown[] = [];
    let mirror = '';
    let skipped = 0;
    const t = await setup({
      handlers: {
        ...anyChat,
        chats: () => {
          // What the reader would enforce for this read.
          seen.push(existsSync(mirror) ? JSON.parse(readFileSync(mirror, 'utf8')) : null);
          return { chats: [], total: 0 };
        },
        status: () => ({ ...READY, skipped }),
      },
    });
    mirror = join(t.paths.messagesDir, 'skip.json');
    expect(await t.svc.skip.add(ASHA, CLI)).toEqual({ ok: true, value: true });
    rmSync(mirror);
    await t.svc.chats({ limit: 30 }, { via: 'cli' });
    writeFileSync(mirror, JSON.stringify({ version: 1, chatKeys: [] }));
    await t.svc.chats({ limit: 30 }, { via: 'cli' });
    expect(seen).toEqual([
      { version: 1, chatKeys: [ASHA] },
      { version: 1, chatKeys: [ASHA] },
    ]);
    // status: the reader counts another list than the table's.
    writeFileSync(mirror, JSON.stringify({ version: 1, chatKeys: [] }));
    skipped = 0;
    await t.svc.status();
    expect(JSON.parse(readFileSync(mirror, 'utf8'))).toEqual({ version: 1, chatKeys: [ASHA] });
    expect(statSync(mirror).mode & 0o777).toBe(0o600);
  });

  it('a skip change whose commit fails leaves skip.json as messages.db is', async () => {
    const t = await setup({ handlers: anyChat });
    expect(await t.svc.skip.add(ASHA, CLI)).toEqual({ ok: true, value: true });
    const raw = (t.svc as unknown as { db: { raw: { exec(sql: string): void } } }).db.raw;
    const exec = raw.exec.bind(raw);
    raw.exec = (sql: string) => {
      if (sql === 'COMMIT') throw new Error('disk I/O error');
      exec(sql);
    };
    // The mirror was written inside the transaction: it must follow the rollback.
    expect(t.svc.skip.remove(ASHA, CLI)).toEqual({ ok: false, code: 'unavailable', reason: MESSAGES_SAYS.skipWrite });
    expect(t.svc.skip.list().map((e) => e.chatKey)).toEqual([ASHA]);
    expect(mirrorOf(t)).toEqual({ version: 1, chatKeys: [ASHA] });
    expect(await t.svc.skip.add(GROUP, CLI)).toEqual({ ok: false, code: 'unavailable', reason: MESSAGES_SAYS.skipWrite });
    expect(t.svc.skip.list().map((e) => e.chatKey)).toEqual([ASHA]);
    expect(mirrorOf(t)).toEqual({ version: 1, chatKeys: [ASHA] });
  });

  // Root reads a chmod 000 file.
  it.skipIf(process.getuid?.() === 0)('an unreadable skip.json is never overwritten and reads are refused', async () => {
    let file = '';
    let ino = 0;
    let status: ReaderStatus = { ...READY, skipOk: false };
    const seen: unknown[] = [];
    const t = await setup({
      dbFile: join(dir, 'messages.db'),
      handlers: {
        ...anyChat,
        chats: () => {
          seen.push(JSON.parse(readFileSync(file, 'utf8')));
          return { chats: [], total: 0 };
        },
        status: () => status,
      },
      // A new messages.db beside a skip.json the owner's chmod (or a disk error) keeps from opening.
      prepare: (paths) => {
        file = join(paths.messagesDir, 'skip.json');
        writeFileSync(file, JSON.stringify({ version: 1, chatKeys: [ASHA] }), { mode: 0o600 });
        chmodSync(file, 0o000);
        ino = statSync(file).ino;
      },
    });
    const untouched = () => {
      expect(statSync(file).ino).toBe(ino);
      expect(statSync(file).mode & 0o777).toBe(0);
    };
    const refused = { code: 'messages_unavailable', message: MESSAGES_SAYS.skipUnreadable };
    untouched();
    await expect(t.svc.chats({ limit: 30 }, { via: 'cli' })).rejects.toMatchObject(refused);
    await expect(t.svc.read(RAVI, { limit: 30 }, { via: 'cli' })).rejects.toMatchObject(refused);
    expect(t.reader!.calls.filter((c) => c.op !== 'status')).toEqual([]);
    // status neither (the reader can't parse it, or counts another list than the table's), and says why.
    expect((await t.svc.status()).reader).toEqual({ state: 'ok', detail: MESSAGES_SAYS.skipLocked });
    status = { ...READY, skipped: 1 };
    expect((await t.svc.status()).reader).toEqual({ state: 'ok', detail: MESSAGES_SAYS.skipLocked });
    // Nor a skip change: it would write the table's list over the file's.
    expect(await t.svc.skip.add(RAVI, CLI)).toEqual({ ok: false, code: 'unavailable', reason: MESSAGES_SAYS.skipWrite });
    expect(t.svc.skip.list()).toEqual([]);
    untouched();

    // It opens again: its keys are kept, then it is written, before the next read.
    chmodSync(file, 0o600);
    expect(await t.svc.chats({ limit: 30 }, { via: 'cli' })).toEqual({ chats: [], total: 0 });
    expect(seen).toEqual([{ version: 1, chatKeys: [ASHA] }]);
    expect(t.svc.skip.list()).toEqual([{ chatKey: ASHA, name: SKIP_KEPT_NAME, kind: 'dm', addedAt: NOW }]);
    expect((await t.svc.status()).reader).toEqual({ state: 'ok' });

    // The same messages.db opened again while it won't open: a remove is refused too.
    await t.svc.stop();
    chmodSync(file, 0o000);
    const again = statSync(file).ino;
    await t.svc.start();
    expect(t.svc.skip.remove(ASHA, CLI)).toEqual({ ok: false, code: 'unavailable', reason: MESSAGES_SAYS.skipWrite });
    expect(t.svc.skip.list().map((e) => e.chatKey)).toEqual([ASHA]);
    await expect(t.svc.chats({ limit: 30 }, { via: 'cli' })).rejects.toMatchObject(refused);
    expect(statSync(file).ino).toBe(again);
    expect(statSync(file).mode & 0o777).toBe(0);
  });

  it.skipIf(process.getuid?.() === 0)('a skip add that outlives a Messages off and on finds skip.json unreadable and writes nothing', async () => {
    const t = await setup({ dbFile: join(dir, 'messages.db'), handlers: anyChat });
    const file = join(t.paths.messagesDir, 'skip.json');
    const shell = t.svc as unknown as { reader: ReaderClient };
    const call = shell.reader.call.bind(shell.reader);
    let ino = 0;
    // While the add waits on the reader, Messages goes off and on, and the new open finds skip.json won't open.
    shell.reader.call = (async (op: ReaderOp, args: never) => {
      const got = await call(op, args);
      if (op === 'read') {
        await t.svc.stop();
        chmodSync(file, 0o000);
        ino = statSync(file).ino;
        await t.svc.start();
      }
      return got;
    }) as ReaderClient['call'];
    expect(await t.svc.skip.add(RAVI, CLI)).toEqual({ ok: false, code: 'unavailable', reason: MESSAGES_SAYS.skipWrite });
    expect(statSync(file).ino).toBe(ino);
    expect(statSync(file).mode & 0o777).toBe(0);
    expect(t.svc.skip.list()).toEqual([]);
  });

  it('a lost salt: status says why, and skip reset finds the old chats again by name before reads go on', async () => {
    const before: Record<string, Chat> = { [ASHA]: chat(ASHA, 'Asha Test'), [GROUP]: chat(GROUP, 'Group One', 'group'), [MOM]: chat(MOM, 'Mom'), [RAVI]: chat(RAVI, 'Ravi Test') };
    const t = await setup({
      handlers: {
        read: (a) => {
          const c = before[String(a.chatKey)];
          if (!c) throw readerError('not_found');
          return { chat: c, messages: [], more: false };
        },
      },
    });
    for (const k of [ASHA, GROUP, MOM, RAVI]) expect(await t.svc.skip.add(k, CLI)).toEqual({ ok: true, value: true });
    const salt = join(t.paths.messagesDir, 'salt');
    writeFileSync(salt, Buffer.alloc(32, 7), { mode: 0o600 });
    // The salt there: nothing to reset, and only the Mac's CLI may.
    expect(await t.svc.skip.reset({}, CLI)).toEqual({ ok: false, code: 'conflict', reason: MESSAGES_SAYS.skipResetNotNeeded });
    expect(await t.svc.skip.reset({}, PHONE)).toEqual({ ok: false, code: 'forbidden', reason: MESSAGES_SAYS.skipResetMacOnly });

    // The salt deleted: the reader won't start over keys it can't match, and status says why.
    rmSync(salt);
    await t.reader!.close();
    expect((await t.svc.status()).reader).toEqual({ state: 'down', detail: MESSAGES_SAYS.saltLost });

    // The reset drops the old keys at once (so the reader can start with a new salt); reads wait for the chats to be found again.
    const waiting = await t.svc.skip.reset({}, CLI);
    expect(waiting).toMatchObject({ ok: true, value: { skipped: [], waiting: true } });
    expect(waiting.ok && waiting.value.left).toHaveLength(4);
    expect(t.svc.skip.list()).toEqual([]);
    expect(mirrorOf(t)).toEqual({ version: 1, chatKeys: [] });

    // The reader is back with a new salt: every chat has a new key.
    const NEW = { asha: 'ce1b2c3d4e5f6a7b8', group: 'ce2b2c3d4e5f6a7b8', mom1: 'ce3b2c3d4e5f6a7b8', mom2: 'ce4b2c3d4e5f6a7b8', other: 'ce5b2c3d4e5f6a7b8' };
    const after = [
      chat(NEW.asha, 'Asha Test'),
      chat(NEW.group, 'Group One', 'group'),
      chat(NEW.mom1, 'Mom'),
      chat(NEW.mom2, 'Mom'),
      // Holds a name, isn't it: never skipped for it.
      chat(NEW.other, 'Asha Test and Group One', 'group'),
    ];
    const reader = await startFakeReader(t.paths.messagesReaderSock, {
      status: () => READY,
      chats: (a) => {
        const q = String(a.q ?? '').toLowerCase();
        const hits = after.filter((c) => c.name.toLowerCase().includes(q));
        return { chats: hits, total: hits.length };
      },
    });
    cleanups.push(() => reader.close());
    const refused = { code: 'messages_unavailable', message: MESSAGES_SAYS.skipResetLeft };
    await expect(t.svc.chats({ limit: 30 }, { via: 'mcp' })).rejects.toMatchObject(refused);
    expect((await t.svc.status()).reader).toEqual({ state: 'ok', detail: MESSAGES_SAYS.skipResetLeft });

    // Found again by name and kind (both chats named Mom: the list hides more, never less); Ravi's name is gone.
    const found = await t.svc.skip.reset({}, CLI);
    expect(found).toEqual({
      ok: true,
      value: {
        skipped: [
          { chatKey: NEW.asha, name: 'Asha Test', kind: 'dm', addedAt: NOW },
          { chatKey: NEW.group, name: 'Group One', kind: 'group', addedAt: NOW },
          { chatKey: NEW.mom1, name: 'Mom', kind: 'dm', addedAt: NOW },
          { chatKey: NEW.mom2, name: 'Mom', kind: 'dm', addedAt: NOW },
        ],
        left: [{ name: 'Ravi Test', kind: 'dm' }],
        waiting: false,
      },
    });
    expect((mirrorOf(t) as { chatKeys: string[] }).chatKeys).toEqual([NEW.asha, NEW.group, NEW.mom1, NEW.mom2].sort());
    // One still to find: reads stay refused.
    await expect(t.svc.chats({ limit: 30 }, { via: 'mcp' })).rejects.toMatchObject(refused);
    expect(await t.svc.skip.reset({}, CLI)).toMatchObject({ ok: true, value: { skipped: [], left: [{ name: 'Ravi Test', kind: 'dm' }], waiting: false } });

    // The owner lets it go (he skips it by hand): reads go on, the found ones skipped.
    expect(await t.svc.skip.reset({ forget: true }, CLI)).toEqual({ ok: true, value: { skipped: [], left: [], forgot: [{ name: 'Ravi Test', kind: 'dm' }], waiting: false } });
    expect(await t.svc.chats({ limit: 30 }, { via: 'cli' })).toMatchObject({ total: after.length });
    expect((await t.svc.status()).reader).toEqual({ state: 'ok' });
    expect(t.svc.skip.list().map((e) => e.chatKey).sort()).toEqual([NEW.asha, NEW.group, NEW.mom1, NEW.mom2].sort());
    writeFileSync(salt, Buffer.alloc(32, 8), { mode: 0o600 });
    expect(await t.svc.skip.reset({}, CLI)).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('skip reset --forget lets go only of chats a reset looked for with the reader back, and names them', async () => {
    const before: Record<string, Chat> = { [ASHA]: chat(ASHA, 'Asha Test'), [RAVI]: chat(RAVI, 'Ravi Test') };
    const t = await setup({
      handlers: {
        read: (a) => {
          const c = before[String(a.chatKey)];
          if (!c) throw readerError('not_found');
          return { chat: c, messages: [], more: false };
        },
      },
    });
    for (const k of [ASHA, RAVI]) expect(await t.svc.skip.add(k, CLI)).toEqual({ ok: true, value: true });
    const salt = join(t.paths.messagesDir, 'salt');
    writeFileSync(salt, Buffer.alloc(32, 7), { mode: 0o600 });
    rmSync(salt);
    await t.reader!.close();
    const first = { ok: false, code: 'conflict', reason: MESSAGES_SAYS.skipForgetFirst };

    // A first call with --forget looks nothing up: refused, and the list is as it was.
    expect(await t.svc.skip.reset({ forget: true }, CLI)).toEqual(first);
    expect(t.svc.skip.list().map((e) => e.chatKey).sort()).toEqual([ASHA, RAVI].sort());

    // The reset starts; while the reader isn't back, --forget is still refused.
    expect(await t.svc.skip.reset({}, CLI)).toMatchObject({ ok: true, value: { skipped: [], waiting: true } });
    expect(await t.svc.skip.reset({ forget: true }, CLI)).toEqual(first);
    await expect(t.svc.chats({ limit: 30 }, { via: 'cli' })).rejects.toMatchObject({ code: 'messages_unavailable', message: MESSAGES_SAYS.skipResetLeft });

    // The reader back with a new salt: Asha is found, Ravi isn't.
    const NEW_ASHA = 'ce1b2c3d4e5f6a7b8';
    const reader = await startFakeReader(t.paths.messagesReaderSock, {
      status: () => READY,
      chats: (a) => (String(a.q).startsWith('Asha') ? { chats: [chat(NEW_ASHA, 'Asha Test')], total: 1 } : { chats: [], total: 0 }),
    });
    cleanups.push(() => reader.close());
    expect(await t.svc.skip.reset({}, CLI)).toMatchObject({ ok: true, value: { left: [{ name: 'Ravi Test', kind: 'dm' }], waiting: false } });

    // Now --forget lets Ravi go and names him, so the owner knows whom to skip again; reads go on.
    expect(await t.svc.skip.reset({ forget: true }, CLI)).toEqual({ ok: true, value: { skipped: [], left: [], forgot: [{ name: 'Ravi Test', kind: 'dm' }], waiting: false } });
    expect(t.svc.skip.list().map((e) => e.chatKey)).toEqual([NEW_ASHA]);
    expect(await t.svc.chats({ limit: 30 }, { via: 'cli' })).toEqual({ chats: [], total: 0 });
  });

  it('status passes on how many skips name no chat on this Mac', async () => {
    let st: ReaderStatus = READY;
    const t = await setup({ handlers: { status: () => st } });
    expect(await t.svc.status()).not.toHaveProperty('skipUnmatched');
    st = { ...READY, skipped: 2, skipUnmatched: 1 };
    expect((await t.svc.status()).skipUnmatched).toBe(1);
  });

  it("skip.json keys messages.db won't take: reads say the list couldn't be written, not that the file won't open", async () => {
    const dbFile = join(dir, 'messages.db');
    const t = await setup({ dbFile, handlers: { ...anyChat, chats: () => ({ chats: [], total: 0 }), status: () => READY } });
    await t.svc.stop();
    // skip.json lists a chat the table hasn't, and messages.db won't take it (as when the disk is full).
    writeFileSync(join(t.paths.messagesDir, 'skip.json'), JSON.stringify({ version: 1, chatKeys: [ASHA] }), { mode: 0o600 });
    const raw = new DatabaseSync(dbFile);
    raw.exec("CREATE TRIGGER no_room BEFORE INSERT ON skip BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END");
    raw.close();
    await t.svc.start();
    await expect(t.svc.chats({ limit: 30 }, { via: 'cli' })).rejects.toMatchObject({ code: 'messages_unavailable', message: MESSAGES_SAYS.noMirror });
    expect((await t.svc.status()).reader).toEqual({ state: 'ok', detail: MESSAGES_SAYS.skipUnsaved });
    expect(await t.svc.skip.add(RAVI, CLI)).toEqual({ ok: false, code: 'unavailable', reason: MESSAGES_SAYS.skipWrite });
    // Nothing wrote over it.
    expect(mirrorOf(t)).toEqual({ version: 1, chatKeys: [ASHA] });
    // messages.db takes it again: kept, written, and reads go on.
    const fix = new DatabaseSync(dbFile);
    fix.exec('DROP TRIGGER no_room');
    fix.close();
    expect(await t.svc.chats({ limit: 30 }, { via: 'cli' })).toEqual({ chats: [], total: 0 });
    expect(t.svc.skip.list().map((e) => e.chatKey)).toEqual([ASHA]);
    expect((await t.svc.status()).reader).toEqual({ state: 'ok' });
  });
});

describe('media', () => {
  it('media shrinks images through jantar-media and deletes the spool copy', async () => {
    const shrunk = Buffer.concat([JPEG, Buffer.from('shrunk')]);
    const seen: { job: string; input: string; edge: number }[] = [];
    const shrinker: ImageShrinker = {
      ensure: async () => true,
      image: async (job, input, output, edge) => {
        seen.push({ job, input, edge });
        writeFileSync(output, shrunk);
        return { ok: true, value: { w: 32, h: 32 } };
      },
    };
    let spooled = '';
    const t = await setup({
      shrinker,
      handlers: {
        media: (a) => {
          const spool = join(t.paths.messagesDir, 'spool');
          mkdirSync(spool, { recursive: true, mode: 0o700 });
          const image = String(a.msgKey).endsWith('IMG');
          spooled = join(spool, `${image ? 'a' : 'b'}${'0'.repeat(31)}.${image ? 'jpg' : 'pdf'}`);
          writeFileSync(spooled, image ? JPEG : Buffer.from('%PDF-1.4'), { mode: 0o600 });
          return image
            ? { file: spooled, bytes: JPEG.length, kind: 'image', mime: 'image/jpeg' }
            : { file: spooled, bytes: 8, kind: 'document', mime: 'application/pdf', fileName: 'invoice.pdf' };
        },
      },
    });

    const got = await t.svc.media(`${GROUP}.3EB0IMG`, { via: 'mcp', pid: 7, folder: '/tmp/x' });
    expect(got).toEqual({ jpeg: shrunk });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.edge).toBe(1024);
    expect(seen[0]!.input.startsWith(`${seen[0]!.job}/`)).toBe(true);
    expect(t.reader!.calls.at(-1)).toEqual({ op: 'media', args: { msgKey: `${GROUP}.3EB0IMG`, maxBytes: 25 * 1024 * 1024 } });
    expect(existsSync(spooled)).toBe(false);
    expect(existsSync(seen[0]!.job)).toBe(false);

    expect(await t.svc.media(`${GROUP}.3EB0DOC`, { via: 'cli' })).toEqual({ document: { fileName: 'invoice.pdf', bytes: 8, kind: 'document' } });
    expect(existsSync(spooled)).toBe(false);
    expect(t.svc.reads(2)).toEqual([
      { at: NOW, via: 'cli', op: 'media', chatKey: GROUP, count: 1 },
      { at: NOW, via: 'mcp', pid: 7, folder: 'x', op: 'media', chatKey: GROUP, count: 1 },
    ]);
  });

  it("a file the reader names outside its spool is never touched", async () => {
    const outside = join(dir, `${'c'.repeat(32)}.jpg`);
    writeFileSync(outside, JPEG);
    const t = await setup({ handlers: { media: () => ({ file: outside, bytes: JPEG.length, kind: 'image', mime: 'image/jpeg' }) } });
    await expect(t.svc.media(`${GROUP}.3EB0IMG`, { via: 'cli' })).rejects.toBeInstanceOf(ReaderFailure);
    // Its own sentence, never "this WhatsApp version" or "busy".
    await expect(t.svc.media(`${GROUP}.3EB0IMG`, { via: 'cli' })).rejects.toMatchObject({ detail: MESSAGES_SAYS.notInSpool });
    expect(readFileSync(outside)).toEqual(JPEG);
  });

  it("an image job folder that can't be made says so, not that jantar-media needs its tools", async () => {
    let spooled = '';
    const t = await setup({
      shrinker: { ensure: async () => true, image: async () => ({ ok: false, why: 'failed' }) },
      // A file where the jobs folder goes.
      prepare: (p) => {
        mkdirSync(p.messagesDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(p.messagesDir, 'jobs'), '');
      },
      handlers: {
        media: () => {
          const spool = join(t.paths.messagesDir, 'spool');
          mkdirSync(spool, { recursive: true, mode: 0o700 });
          spooled = join(spool, `a${'0'.repeat(31)}.jpg`);
          writeFileSync(spooled, JPEG, { mode: 0o600 });
          return { file: spooled, bytes: JPEG.length, kind: 'image', mime: 'image/jpeg' };
        },
      },
    });
    await expect(t.svc.media(`${GROUP}.3EB0IMG`, { via: 'cli' })).rejects.toMatchObject({ code: 'busy', detail: MESSAGES_SAYS.imageJob });
    expect(existsSync(spooled)).toBe(false);
  });

  it('a job left by a crash is gone at start', async () => {
    const t = await setup({
      prepare: (p) => {
        const job = join(p.messagesDir, 'jobs', 'img-left0');
        mkdirSync(job, { recursive: true, mode: 0o700 });
        writeFileSync(join(job, 'in.jpg'), JPEG);
      },
    });
    expect(readdirSync(join(t.paths.messagesDir, 'jobs'))).toEqual([]);
  });
});

describe('calls to return', () => {
  it('callsToReturn drops returned calls', async () => {
    const ashaMissed = call(1, { at: '2026-11-13T09:30:00.000Z', who: 'Asha Test', chatKey: ASHA });
    const raviWa = call(2, { at: '2026-11-13T10:00:00.000Z', who: 'Ravi Test', chatKey: RAVI });
    const raviPhone = call(3, { at: '2026-11-13T11:00:00.000Z', who: 'Ravi Test', chatKey: RAVI, via: 'phone' });
    // Mom's missed call was returned by a call.
    const momMissed = call(4, { at: '2026-11-13T12:00:00.000Z', who: 'Mom', chatKey: MOM });
    const momBack = call(5, { at: '2026-11-13T12:30:00.000Z', who: 'Mom', chatKey: MOM, incoming: false, missed: false, durationS: 60 });
    const old = call(7, { at: '2026-11-10T09:00:00.000Z', who: 'Ravi Test', chatKey: RAVI });
    const t = await setup({
      handlers: {
        waCalls: () => ({ calls: [old, ashaMissed, raviWa, momMissed, momBack] }),
        phoneCalls: () => ({ calls: [raviPhone] }),
        lastFromMe: (a) => {
          expect([...(a.chatKeys as string[])].sort()).toEqual([ASHA, MOM, RAVI].sort());
          return { [ASHA]: '2026-11-13T09:40:00.000Z', [RAVI]: '2026-11-13T09:10:00.000Z', [MOM]: null };
        },
      },
    });
    const r = await t.svc.callsToReturn({ via: 'mcp', pid: 9 });
    expect(r.calls.map((c) => c.callKey)).toEqual([raviPhone.callKey, raviWa.callKey]);
    expect(r.calls.every((c) => c.returned === false)).toBe(true);
    // The last 3 days only.
    expect(t.reader!.calls.find((c) => c.op === 'waCalls')!.args).toEqual({ since: '2026-11-11T03:00:00.000Z' });
    expect(t.svc.reads(1)).toEqual([{ at: NOW, via: 'mcp', pid: 9, op: 'calls', count: 2 }]);
  });

  it('a later answered call counts as returned', async () => {
    const raviWa = call(2, { at: '2026-11-13T10:00:00.000Z', who: 'Ravi Test', chatKey: RAVI });
    const raviPhone = call(3, { at: '2026-11-13T11:00:00.000Z', who: 'Ravi Test', chatKey: RAVI, via: 'phone' });
    // He rang again and the owner picked up: they spoke.
    const answered = call(6, { at: '2026-11-13T13:00:00.000Z', who: 'Ravi Test', chatKey: RAVI, missed: false, durationS: 30 });
    // Neel (no chat): answered once before he missed, then a call he made that nobody picked up; neither returns it.
    const neelAnswered = call(8, { at: '2026-11-13T08:00:00.000Z', who: 'Neel Test', missed: false, durationS: 40 });
    const neelMissed = call(9, { at: '2026-11-13T12:15:00.000Z', who: 'Neel Test' });
    const neelAgain = call(10, { at: '2026-11-13T12:20:00.000Z', who: 'Neel Test' });
    const t = await setup({
      handlers: {
        waCalls: () => ({ calls: [neelAnswered, raviWa, neelMissed, neelAgain] }),
        phoneCalls: () => ({ calls: [raviPhone, answered] }),
        lastFromMe: () => ({ [RAVI]: null }),
      },
    });
    expect((await t.svc.callsToReturn({ via: 'cli' })).calls.map((c) => c.callKey)).toEqual([neelAgain.callKey, neelMissed.callKey]);
  });

  it('a call log macOS keeps from the reader leaves WhatsApp calls', async () => {
    const raviWa = call(2, { at: '2026-11-13T10:00:00.000Z', who: 'Ravi Test', chatKey: RAVI });
    const t = await setup({
      handlers: {
        waCalls: () => ({ calls: [raviWa] }),
        phoneCalls: () => {
          throw readerError('no_access', 'no Full Disk Access');
        },
        lastFromMe: () => ({ [RAVI]: null }),
      },
    });
    expect((await t.svc.callsToReturn({ via: 'cli' })).calls.map((c) => c.callKey)).toEqual([raviWa.callKey]);
  });

  it("a calls store refused or changed by an update is left out and named, as the morning run does; the other still answers", async () => {
    const raviWa = call(2, { at: '2026-11-13T10:00:00.000Z', who: 'Ravi Test', chatKey: RAVI });
    const momPhone = call(3, { at: '2026-11-13T11:00:00.000Z', who: 'Mom', chatKey: MOM, via: 'phone' });
    let wa: FakeHandler = () => ({ calls: [raviWa] });
    let phone: FakeHandler = () => ({ calls: [momPhone] });
    const t = await setup({ handlers: { waCalls: (a) => wa(a), phoneCalls: (a) => phone(a), lastFromMe: () => ({ [RAVI]: null, [MOM]: null }) } });
    const answer = async () => {
      const r = await t.svc.callsToReturn({ via: 'cli' });
      return { ...r, calls: r.calls.map((c) => c.callKey) };
    };
    expect(await answer()).toEqual({ calls: [momPhone.callKey, raviWa.callKey] });
    for (const code of ['no_access', 'unsupported'] as const) {
      phone = () => {
        throw readerError(code);
      };
      expect(await answer(), code).toEqual({ calls: [raviWa.callKey], phoneCalls: false });
      phone = () => ({ calls: [momPhone] });
      wa = () => {
        throw readerError(code);
      };
      expect(await answer(), code).toEqual({ calls: [momPhone.callKey], waCalls: false });
      wa = () => ({ calls: [raviWa] });
    }
    // A reader of another build is never left out quietly: the read fails, and says to run setup.
    wa = () => ({ calls: [{ callKey: 'an old shape' }] });
    await expect(t.svc.callsToReturn({ via: 'cli' })).rejects.toMatchObject({ code: 'unsupported', detail: READER_MISMATCH });
  });
});

describe("Today's runs", () => {
  const made = (id: string, at: string, o: Partial<MorningRun> = {}): MorningRun => ({
    id,
    at,
    trigger: 'now',
    state: 'ok',
    stale: false,
    newestAt: null,
    counts: { chats: 1, messages: 1, calls: 0, todos: 1, replies: 0, callbacks: 0, dropped: 0 },
    dropped: [],
    todoIds: [],
    ...o,
  });

  it("lists the day's runs that made something, newest first, at most five", () => {
    const r = openMessagesDb(':memory:');
    if (!r.ok) throw new Error(r.reason);
    const db = r.db;
    try {
      const id = (n: number) => `01JFZ8X8Y3T0V5G9WQK2M4N0${String(n).padStart(2, '0')}`;
      // Yesterday's, a dry run, a failed one and one that made nothing never count.
      putRun(db, made(id(1), '2026-11-13T23:59:00.000Z'));
      putRun(db, made(id(2), '2026-11-14T00:10:00.000Z', { trigger: 'dry' }));
      putRun(db, made(id(3), '2026-11-14T00:20:00.000Z', { state: 'failed' }));
      putRun(db, made(id(4), '2026-11-14T00:30:00.000Z', { counts: { chats: 0, messages: 0, calls: 0, todos: 0, replies: 0, callbacks: 0, dropped: 0 } }));
      for (let n = 5; n <= 11; n += 1) putRun(db, made(id(n), `2026-11-14T0${n - 4}:00:00.000Z`, { trigger: n === 5 ? 'timer' : 'now' }));
      expect(madeRuns(db, '2026-11-14T00:00:00.000Z').map((x) => x.id)).toEqual([id(11), id(10), id(9), id(8), id(7)]);
      expect(madeRuns(db, '2026-11-14T06:30:00.000Z').map((x) => x.id)).toEqual([id(11)]);
    } finally {
      db.close();
    }
  });
});

describe('the reader client', () => {
  it("matches replies by id, out of order, and refuses an answer that doesn't check", async () => {
    const sock = join(dir, 'c.sock');
    const reader = await startFakeReader(sock, {
      status: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return READY;
      },
      chats: () => ({ chats: [chat(ASHA, 'Asha Test')], total: 1 }),
      read: () => ({ chat: chat(ASHA, 'Asha Test'), messages: [{ msgKey: 'not a key' }], more: false }),
    });
    cleanups.push(() => reader.close());
    const client = createReaderClient(sock);
    cleanups.push(() => client.close());
    const [st, chats] = await Promise.all([client.call('status', {}), client.call('chats', { limit: 5 })]);
    expect(st).toEqual(READY);
    expect(chats.total).toBe(1);
    // A reader of another build: its own detail, which the routes and the morning run say as "update needed".
    await expect(client.call('read', { chatKey: ASHA, limit: 5 })).rejects.toMatchObject({ code: 'unsupported', detail: READER_MISMATCH });
    // Args are checked before anything is sent.
    const sent = reader.calls.length;
    await expect(client.call('read', { chatKey: 'Asha', limit: 5 })).rejects.toMatchObject({ code: 'bad_request' });
    expect(reader.calls).toHaveLength(sent);
    // The reader going away is `down`; it coming back is picked up again.
    await reader.close();
    await expect(client.call('status', {})).rejects.toMatchObject({ code: 'down' });
  });
});

describe.skipIf(!bin)('with the real reader', () => {
  it("the reader enforces the daemon's skip list and hands media through its spool", async () => {
    const fx = makeWhatsAppFixture(join(dir, 'wa'));
    const held = whatsAppRunning(fx);
    cleanups.push(() => held.close());
    const shrunk = Buffer.concat([JPEG, Buffer.from('shrunk')]);
    const t = await setup({
      shrinker: {
        ensure: async () => true,
        image: async (_job, input, output) => {
          // The fixture's own image reached the job, moved out of the spool.
          expect(readFileSync(input).subarray(0, 3)).toEqual(JPEG.subarray(0, 3));
          writeFileSync(output, shrunk);
          return { ok: true, value: { w: 32, h: 32 } };
        },
      },
    });
    // The daemon wrote skip.json first; the reader keeps its state in the same folder.
    const r = await startReader(bin!, { fixture: fx, state: t.paths.messagesDir, sock: t.paths.messagesReaderSock });
    cleanups.push(() => r.stop());
    const asha = keyOf(t.paths.messagesDir, fx.jids.ashaLid);
    const group = keyOf(t.paths.messagesDir, fx.jids.group);
    const names = async () => (await t.svc.chats({ limit: 30 }, { via: 'cli' })).chats.map((c) => c.name);

    expect((await t.svc.status()).reader).toEqual({ state: 'ok' });
    expect(await names()).toContain('Asha Test');
    expect(await t.svc.skip.add(asha, PHONE)).toEqual({ ok: true, value: true });
    expect(await names()).not.toContain('Asha Test');
    await expect(t.svc.read(asha, { limit: 50 }, { via: 'cli' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await t.svc.status()).skipped).toBe(1);

    expect(await t.svc.media(`${group}.3EB0FX0704`, { via: 'cli' })).toEqual({ jpeg: shrunk });
    expect(readdirSync(join(t.paths.messagesDir, 'spool'))).toEqual([]);

    expect(t.svc.skip.remove(asha, CLI)).toEqual({ ok: true, value: true });
    expect(await names()).toContain('Asha Test');
  });
});
