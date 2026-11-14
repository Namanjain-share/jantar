/**
 * jantar-messages-reader, the core (Task 3), run as a real process on the
 * synthetic container (fixture.ts) with a temp socket and state dir:
 * - the socket is 0600 and checks its caller's uid (getpeereid);
 * - status, chats, read and readByName answer what the fixture holds, in
 *   the shapes reader-protocol.ts checks; removed, hidden and broadcast-list
 *   chats are left out; deleted and system lines never make a chat wait;
 *   times are whole milliseconds, so `since` and `before` cut exactly and
 *   paging back with `before` returns every line once;
 * - a mention is the person's name ("@Me", "@[skipped]"), never their id;
 * - the skip list hides a person everywhere (both ids, their group lines)
 *   and a skipped chat is `not_found`, never `skipped`;
 * - a missing column is `unsupported`; a skip list that won't parse and a
 *   closed WhatsApp (no -wal) are `busy`; a refused ContactsV2 still lets
 *   status answer, and reads refuse; WhatsApp's files are never changed;
 * - keys are stable across restarts and depend on the salt.
 * Lines and chats a test adds are written as WhatsApp would (writeAsWhatsApp).
 * WhatsApp counts as running (whatsAppRunning) unless a test says otherwise.
 * Skipped where Swift can't build the reader (not macOS, no Command Line Tools).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  READER_VERSION,
  ReaderChatsSchema,
  ReaderReadByNameSchema,
  ReaderReadSchema,
  ReaderStatusSchema,
  type ReaderRead,
} from '../../src/messages/reader-protocol.js';
import {
  FIXTURE_MEDIA,
  FIXTURE_NEEL,
  FIXTURE_NEWEST_AT,
  FIXTURE_OWNER,
  FIXTURE_TEXT,
  WA_SESSION,
  WA_TYPE,
  appleSeconds,
  makeWhatsAppFixture,
  type FixturePaths,
} from './fixture.js';
import { MESSAGES_SAYS, readerSays } from '../../src/messages/says.js';
import { READER_ASSET, buildReader, whatsAppRunning } from './reader-build.js';
import {
  digitsOf,
  filesUnder,
  groupJid,
  keyOf,
  sha256,
  startReader,
  userJid,
  writeAsWhatsApp,
  writeSkip,
  type AddedLine,
  type Running,
} from './reader-harness.js';

const reader = await buildReader();

const EX_USAGE = 64;
/** reader-protocol's AMBIGUOUS_MAX: the most candidates a name answers. */
const AMBIGUOUS_MAX = 20;
const PAGES_MAX = 100;

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
    const r = await startReader(reader!, {
      fixture: opts.fixture ?? paths,
      state: opts.state ?? join(dir, 'state'),
      sock: opts.sock ?? join(dir, `r${running.length}.sock`),
    });
    running.push(r);
    return r;
  }

  const groupLine = (key: string, stanza: string) => `${key}.${stanza}`;

  /** A chat paged back from its newest line, `before` = each page's first `at`; oldest page first. */
  async function pageBack(r: Running, chatKey: string, limit: number, since?: string): Promise<ReaderRead[]> {
    const pages: ReaderRead[] = [];
    let before: string | undefined;
    do {
      const page = ReaderReadSchema.parse(await r.ok('read', { chatKey, limit, ...(before ? { before } : {}), ...(since ? { since } : {}) }));
      pages.push(page);
      expect(page.messages.length).toBeGreaterThan(0);
      // Past the limit only to hold one millisecond's lines whole.
      if (page.messages.length > limit) expect(new Set(page.messages.map((m) => m.at)).size).toBe(1);
      // Wholly older than the page before: never the same page again.
      if (before) expect(page.messages.at(-1)!.at < before).toBe(true);
      before = page.more ? page.messages[0]!.at : undefined;
    } while (before && pages.length < PAGES_MAX);
    expect(pages.at(-1)!.more).toBe(false);
    return pages.reverse();
  }

  it('status reports a readable container', async () => {
    const r = await start();
    const sock = statSync(r.sock);
    expect(sock.isSocket()).toBe(true);
    expect(sock.mode & 0o777).toBe(0o600);

    const status = ReaderStatusSchema.parse(await r.ok('status'));
    expect(status).toMatchObject({
      whatsapp: { found: true, schemaOk: true, contactsOk: true, newestAt: FIXTURE_NEWEST_AT },
      phone: { readable: true },
      skipped: 0,
      skipOk: true,
      version: READER_VERSION,
    });
    expect(typeof status.whatsapp.running).toBe('boolean');
    expect(status.whatsapp.walMtime).toEqual(expect.any(String));
  });

  it('a closed WhatsApp (no -wal) answers busy, never no_access', async () => {
    const closed = makeWhatsAppFixture(join(dir, 'closed'));
    const r = await start({ fixture: closed });
    const status = ReaderStatusSchema.parse(await r.ok('status'));
    expect(status.whatsapp).toMatchObject({ found: true, schemaOk: true, contactsOk: true, newestAt: null, walMtime: null });
    expect(await r.call('chats', { limit: 50 })).toMatchObject({ ok: false, error: 'busy' });
    expect(filesUnder(closed.container).filter((f) => f.endsWith('-wal'))).toEqual([]);

    held.push(whatsAppRunning(closed));
    expect(ReaderChatsSchema.parse(await r.ok('chats', { limit: 50 })).total).toBe(5);
  });

  it('a missing container is not found, and reads say so', async () => {
    const r = await start({ fixture: { ...paths, container: join(dir, 'nowhere') } });
    expect(ReaderStatusSchema.parse(await r.ok('status')).whatsapp).toMatchObject({ found: false, schemaOk: false, newestAt: null });
    const failed = await r.call('chats', { limit: 50 });
    expect(failed).toMatchObject({ ok: false, error: 'no_access' });
    // The daemon tells it apart by the reader's detail: no WhatsApp here, not Full Disk Access.
    expect(readerSays('no_access', failed.ok ? undefined : failed.detail)).toBe(MESSAGES_SAYS.noWhatsAppHere);
  });

  it('chats leaves out status, newsletter and broadcast', async () => {
    // Newer than every fixture chat, so each would come first if it were shown.
    const wa = writeAsWhatsApp(paths);
    const leftOut = [
      { jid: groupJid(3), type: WA_SESSION.group, name: 'Removed Group', removed: true },
      { jid: userJid('919990000006'), type: WA_SESSION.dm, name: 'Hidden Test', hidden: true },
      // A broadcast list, under an id only its type rules out.
      { jid: groupJid(4), type: WA_SESSION.broadcast, name: 'Broadcast List' },
    ];
    try {
      for (const c of leftOut) wa.chat({ ...c, at: appleSeconds('2026-11-13T21:00:00.000Z') });
    } finally {
      wa.close();
    }

    const r = await start();
    for (const c of leftOut) {
      expect(await r.call('read', { chatKey: keyOf(r.state, c.jid), limit: 50 })).toMatchObject({ ok: false, error: 'not_found' });
      expect(await r.call('readByName', { name: c.name, limit: 50 })).toMatchObject({ ok: false, error: 'not_found' });
    }
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
    // FIXTURE_TEXT.mention is "@" + the owner's @lid digits.
    expect(line('3EB0FX0703')).toMatchObject({ sender: 'Ravi Test', text: '@Me can you check?', mentionsMe: true });
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
    expect(JSON.stringify(res)).not.toMatch(/@\d{8,}/);

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

  it('paging with before never skips lines that share a second', async () => {
    // A burst: three lines in one second (one millisecond, give or take
    // WhatsApp's sub-ms digits), then one five minutes later.
    const second = appleSeconds('2026-11-13T21:00:00.000Z');
    const added: AddedLine[] = [
      { stanza: '3EB0FXT001', at: second + 0.0002, member: paths.jids.ravi, text: 'Burst one' },
      { stanza: '3EB0FXT002', at: second, member: paths.jids.ravi, text: 'Burst two' },
      { stanza: '3EB0FXT003', at: second + 0.0007, member: paths.jids.ravi, text: 'Burst three' },
      { stanza: '3EB0FXT004', at: appleSeconds('2026-11-13T21:05:00.000Z'), member: FIXTURE_NEEL, text: 'After the burst' },
    ];
    const wa = writeAsWhatsApp(paths);
    try {
      for (const l of added) wa.line(paths.jids.group, l);
    } finally {
      wa.close();
    }

    const r = await start();
    const key = keyOf(r.state, paths.jids.group);
    const everything = ReaderReadSchema.parse(await r.ok('read', { chatKey: key, limit: 50 })).messages.map((m) => m.msgKey);
    expect(everything).toHaveLength(10);
    expect(everything.slice(-4)).toEqual(added.map((l) => groupLine(key, l.stanza)));

    for (const limit of [1, 2, 3, 4, 5]) {
      const pages = await pageBack(r, key, limit);
      // Every line exactly once, in WhatsApp's order.
      expect(pages.flatMap((p) => p.messages.map((m) => m.msgKey))).toEqual(everything);
      // Under three, the burst can't fit beside another line: its page grows.
      expect(pages.some((p) => p.messages.length > limit)).toBe(limit < 3);
    }

    // A grown page that is also the last: nothing older within `since`.
    const sinceBurst = await pageBack(r, key, 1, '2026-11-13T21:00:00.000Z');
    expect(sinceBurst.map((p) => p.messages.length)).toEqual([3, 1]);
    expect(sinceBurst.flatMap((p) => p.messages.map((m) => m.msgKey))).toEqual(everything.slice(-4));
  });

  it('times are whole milliseconds: since and before cut exactly, paging never repeats', async () => {
    // Each on a millisecond, as seconds (so a hair either side of it, as a
    // time WhatsApp keeps to the millisecond would be); lines 9 and 30 each
    // have a twin in the same millisecond.
    const first = Date.parse('2026-11-13T21:00:00.000Z');
    const at = (ms: number) => appleSeconds(new Date(first + ms).toISOString());
    const MS_LINES = 40;
    const STEP_MS = 7;
    const TWINS = [9, 30];
    const added: AddedLine[] = [];
    for (let i = 0; i < MS_LINES; i++) {
      const line = { at: at(STEP_MS * (i + 1)), member: i % 2 ? paths.jids.ravi : FIXTURE_NEEL };
      added.push({ ...line, stanza: `3EB0FXS${String(i).padStart(3, '0')}`, text: `Line ${i}` });
      if (TWINS.includes(i)) added.push({ ...line, stanza: `3EB0FXS${String(i).padStart(3, '0')}B`, text: `Line ${i} again` });
    }
    const CHATS = 10;
    const chats = Array.from({ length: CHATS }, (_, i) => ({ jid: userJid(`9199900002${String(i).padStart(2, '0')}`), type: WA_SESSION.dm, name: `Ms Test ${i}`, at: at(STEP_MS * i + 2) }));
    const wa = writeAsWhatsApp(paths);
    try {
      for (const l of added) wa.line(paths.jids.group, l);
      for (const c of chats) wa.chat(c);
    } finally {
      wa.close();
    }

    const r = await start();
    const key = keyOf(r.state, paths.jids.group);
    const keysOf = (res: ReaderRead) => res.messages.map((m) => m.msgKey);
    const all = ReaderReadSchema.parse(await r.ok('read', { chatKey: key, limit: 200 }));
    const everything = keysOf(all);
    expect(everything.slice(-added.length)).toEqual(added.map((l) => groupLine(key, l.stanza)));

    // Every line's own time: `since` holds it and every newer line, `before` every older one.
    for (const m of all.messages) {
      const since = keysOf(ReaderReadSchema.parse(await r.ok('read', { chatKey: key, limit: 200, since: m.at })));
      const before = keysOf(ReaderReadSchema.parse(await r.ok('read', { chatKey: key, limit: 200, before: m.at })));
      expect(since).toContain(m.msgKey);
      expect([...before, ...since]).toEqual(everything);
    }

    for (const limit of [1, 2, 3, 4, 5]) {
      const pages = await pageBack(r, key, limit);
      expect(pages.flatMap((p) => p.messages.map((m) => m.msgKey))).toEqual(everything);
      // Only the twins outgrow a page, and only one of a single line.
      expect(pages.some((p) => p.messages.length > limit)).toBe(limit < 2);
    }

    // A chat's lastAt as `since` keeps it; a millisecond later leaves it out.
    const listed = ReaderChatsSchema.parse(await r.ok('chats', { limit: 200 })).chats;
    for (const c of chats) {
      const chat = listed.find((l) => l.chatKey === keyOf(r.state, c.jid))!;
      const since = async (iso: string) => ReaderChatsSchema.parse(await r.ok('chats', { limit: 200, since: iso })).chats.map((l) => l.chatKey);
      expect(await since(chat.lastAt)).toContain(chat.chatKey);
      expect(await since(new Date(Date.parse(chat.lastAt) + 1).toISOString())).not.toContain(chat.chatKey);
    }
  });

  it('a deleted or system last line never makes a chat wait', async () => {
    // Ravi's last line is the owner's; then Ravi deletes one, and a system line follows.
    const later = (minute: number) => appleSeconds(`2026-11-13T21:0${minute}:00.000Z`);
    const wa = writeAsWhatsApp(paths);
    try {
      wa.line(paths.jids.ravi, { stanza: '3EB0FXD001', at: later(0), type: WA_TYPE.deleted });
      wa.line(paths.jids.ravi, { stanza: '3EB0FXD002', at: later(1), type: WA_TYPE.system });
    } finally {
      wa.close();
    }

    const r = await start();
    const ravi = keyOf(r.state, paths.jids.ravi);
    const waiting = async () => ReaderChatsSchema.parse(await r.ok('chats', { limit: 50, waiting: true })).chats.map((c) => c.chatKey);
    const chats = ReaderChatsSchema.parse(await r.ok('chats', { limit: 50 })).chats;
    expect(chats.find((c) => c.chatKey === ravi)).toMatchObject({ lastFromMe: true });
    expect(await waiting()).not.toContain(ravi);

    // A line he writes after them does.
    const again = writeAsWhatsApp(paths);
    try {
      again.line(paths.jids.ravi, { stanza: '3EB0FXD003', at: later(2), text: 'Are you there?' });
    } finally {
      again.close();
    }
    expect(await waiting()).toContain(ravi);
  });

  it('a mention is the person\'s name, never their number', async () => {
    const wa = writeAsWhatsApp(paths);
    try {
      wa.line(paths.jids.group, {
        stanza: '3EB0FXM001',
        at: appleSeconds('2026-11-13T21:00:00.000Z'),
        member: paths.jids.ravi,
        // Asha by @lid and by number, Neel (push name only), an id nobody
        // knows, and an "@" before a time, which is no mention.
        text: `@${digitsOf(paths.jids.ashaLid)} and @${digitsOf(FIXTURE_NEEL)}: ask @919990000077 by @5pm, cc @${digitsOf(paths.jids.asha)}`,
      });
      wa.line(paths.jids.group, {
        stanza: '3EB0FXM002',
        at: appleSeconds('2026-11-13T21:01:00.000Z'),
        member: FIXTURE_NEEL,
        caption: `@${digitsOf(FIXTURE_OWNER.phone)} is this the one?`,
      });
    } finally {
      wa.close();
    }

    const r = await start();
    const key = keyOf(r.state, paths.jids.group);
    const read = async () => ReaderReadSchema.parse(await r.ok('read', { chatKey: key, limit: 50 }));
    const line = (res: ReaderRead, stanza: string) => res.messages.find((m) => m.msgKey === groupLine(key, stanza))!;

    const res = await read();
    expect(line(res, '3EB0FXM001')).toMatchObject({ sender: 'Ravi Test', text: '@Asha Test and @Neel Test: ask @Unknown by @5pm, cc @Asha Test' });
    expect(line(res, '3EB0FXM001')).not.toHaveProperty('mentionsMe');
    expect(line(res, '3EB0FXM002')).toMatchObject({ kind: 'image', caption: '@Me is this the one?', mentionsMe: true });
    expect(JSON.stringify(res)).not.toMatch(/@\d{8,}/);

    writeSkip(r.state, [keyOf(r.state, paths.jids.ashaLid)]);
    const skipped = await read();
    expect(line(skipped, '3EB0FXM001').text).toBe('@[skipped] and @Neel Test: ask @Unknown by @5pm, cc @[skipped]');
    expect(JSON.stringify(skipped)).not.toContain('Asha');
  });

  it('readByName with two matches lists both', async () => {
    const r = await start();
    const res = ReaderReadByNameSchema.parse(await r.ok('readByName', { name: 'Mom', limit: 50 }));
    if (!('ambiguous' in res)) throw new Error('expected candidates');
    expect(res.total).toBe(2);
    expect(res.ambiguous.map((c) => c.chatKey).sort()).toEqual([keyOf(r.state, paths.jids.mom1), keyOf(r.state, paths.jids.mom2)].sort());
    expect(res.ambiguous.map((c) => c.name)).toEqual(['Mom', 'Mom']);
    for (const c of res.ambiguous) expect(c).not.toHaveProperty('phone');

    const asha = ReaderReadByNameSchema.parse(await r.ok('readByName', { name: 'asha test', limit: 50 }));
    if ('ambiguous' in asha) throw new Error('expected one chat');
    expect(asha.chat.name).toBe('Asha Test');
    expect(asha.messages.at(-1)?.text).toBe(FIXTURE_TEXT.deck);

    expect(await r.call('readByName', { name: 'Nobody Here', limit: 50 })).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('readByName lists at most 20 candidates and says how many matched', async () => {
    const MORE_MOMS = 22;
    const wa = writeAsWhatsApp(paths);
    try {
      for (let i = 0; i < MORE_MOMS; i++) {
        wa.chat({ jid: userJid(`9199900001${String(i).padStart(2, '0')}`), type: WA_SESSION.dm, name: 'Mom', at: appleSeconds('2026-11-13T07:00:00.000Z') - i });
      }
    } finally {
      wa.close();
    }
    const r = await start();
    const res = ReaderReadByNameSchema.parse(await r.ok('readByName', { name: 'mom', limit: 50 }));
    if (!('ambiguous' in res)) throw new Error('expected candidates');
    expect(res.ambiguous).toHaveLength(AMBIGUOUS_MAX);
    expect(res.total).toBe(MORE_MOMS + 2);
    // Newest first: the fixture's two come before the ones added earlier in the day.
    expect(res.ambiguous.slice(0, 2).map((c) => c.chatKey)).toEqual([keyOf(r.state, paths.jids.mom2), keyOf(r.state, paths.jids.mom1)]);
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
    // Status says so, so the phone can tell a broken skip list from a closed WhatsApp.
    expect(ReaderStatusSchema.parse(await r.ok('status'))).toMatchObject({ skipOk: false, whatsapp: { found: true, schemaOk: true } });
    writeSkip(r.state, []);
    expect(ReaderChatsSchema.parse(await r.ok('chats', { limit: 50 })).total).toBe(5);
    expect(ReaderStatusSchema.parse(await r.ok('status'))).toMatchObject({ skipOk: true, skipped: 0 });
  });

  it('schema mismatch says unsupported', async () => {
    const broken = fixture('broken', { dropColumn: 'ZSTANZAID' });
    const r = await start({ fixture: broken });
    const status = ReaderStatusSchema.parse(await r.ok('status'));
    expect(status.whatsapp).toMatchObject({ found: true, schemaOk: false, newestAt: null });
    expect(await r.call('read', { chatKey: keyOf(r.state, broken.jids.group), limit: 50 })).toMatchObject({ ok: false, error: 'unsupported' });
    expect(await r.call('chats', { limit: 50 })).toMatchObject({ ok: false, error: 'unsupported' });
  });

  it('a refused ContactsV2 still lets status answer, and reads refuse', async () => {
    const contacts = join(paths.container, 'ContactsV2.sqlite');
    const mode = statSync(contacts).mode & 0o777;
    chmodSync(contacts, 0o000);
    try {
      const r = await start();
      const status = ReaderStatusSchema.parse(await r.ok('status'));
      expect(status.whatsapp).toMatchObject({ found: true, schemaOk: true, contactsOk: false, newestAt: FIXTURE_NEWEST_AT });
      // Never read without it: a skipped person's other id could show.
      const failed = await r.call('chats', { limit: 50 });
      expect(failed).toMatchObject({ ok: false, error: 'no_access' });
      expect(readerSays('no_access', failed.ok ? undefined : failed.detail)).toBe(MESSAGES_SAYS.contacts);

      chmodSync(contacts, mode);
      expect(ReaderStatusSchema.parse(await r.ok('status')).whatsapp.contactsOk).toBe(true);
      expect(ReaderChatsSchema.parse(await r.ok('chats', { limit: 50 })).total).toBe(5);
    } finally {
      chmodSync(contacts, mode);
    }
  });

  it('the container is untouched', async () => {
    const r = await start();
    const main = join(paths.container, 'ChatStorage.sqlite');
    const before = sha256(main);
    const files = filesUnder(paths.container);
    const groupKey = keyOf(r.state, paths.jids.group);

    // WhatsApp writing meanwhile: a second connection adds a line to Group
    // One every few reads, and each read after it sees that line.
    const wa = writeAsWhatsApp(paths);
    try {
      let newest = '';
      for (let i = 0; i < 20; i++) {
        if (i % 4 === 0) {
          newest = `3EB0FX08${String(i).padStart(2, '0')}`;
          wa.line(paths.jids.group, { stanza: newest, at: appleSeconds('2026-11-13T21:00:00.000Z') + i * 60, member: paths.jids.ravi, text: 'A new line while the reader reads' });
        }
        const op = i % 3;
        if (op === 0) {
          const res = ReaderReadSchema.parse(await r.ok('read', { chatKey: groupKey, limit: 50 }));
          expect(res.messages.at(-1)?.msgKey).toBe(groupLine(groupKey, newest));
        } else if (op === 1) await r.ok('chats', { limit: 50 });
        else await r.ok('status');
      }
      const latest = ReaderReadSchema.parse(await r.ok('read', { chatKey: groupKey, limit: 1 }));
      expect(latest.messages[0]?.msgKey).toBe(groupLine(groupKey, newest));

      expect(sha256(main)).toBe(before);
      const after = filesUnder(paths.container);
      expect(after).toEqual(expect.arrayContaining(files));
      // The one footprint SQLite may leave: -wal and -shm beside a database.
      expect(after.filter((f) => !files.includes(f)).every((f) => /\.sqlite-(?:wal|shm)$/.test(f))).toBe(true);
    } finally {
      wa.close();
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
