/**
 * jantar-messages-reader, the rest (Task 4), run as a real process on the
 * synthetic container (fixture.ts), like reader.test.ts:
 * - search: text, captions and file names, newest first, LIKE wildcards
 *   taken literally, 90 days back by default; skipped chats and people,
 *   left-out chats and the digits inside a mention never match;
 * - newSince: the morning feed by row id with a date guard; the first run
 *   (and one after WhatsApp renumbered its rows) reads firstRunHours back,
 *   never everything; maxRows cuts at a row and the next cursor goes on;
 * - lastFromMe: the owner's last line to a chat (to a person, under either id);
 * - media: a copy (0600) in <state>/spool, never the original; old copies swept;
 * - waCalls and phoneCalls: who (address book, else the number), the 1:1's
 *   key, missed and incoming; a skipped person's calls never come; the
 *   iPhone call log is `no_access` when macOS refuses it. WhatsApp's calls
 *   follow the real Mac's CallHistory.sqlite: one call per aggregate row
 *   (a redial is another attempt), its people hang off the aggregate.
 * Skipped where Swift can't build the reader (not macOS, no Command Line Tools).
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MESSAGES_LIMITS } from '@jantar/protocol';
import {
  READER_EARLIER_MAX,
  ReaderCallsSchema,
  ReaderLastFromMeSchema,
  ReaderMediaSchema,
  ReaderNewSinceSchema,
  ReaderSearchSchema,
  ReaderStatusSchema,
  type ReaderNewSince,
} from '../../src/messages/reader-protocol.js';
import {
  FIXTURE_MEDIA,
  FIXTURE_NEEL,
  FIXTURE_NEWEST_AT,
  FIXTURE_OWNER,
  FIXTURE_SINCE,
  FIXTURE_TEXT,
  appleSeconds,
  makeWhatsAppFixture,
  type FixturePaths,
} from './fixture.js';
import { buildReader, whatsAppRunning } from './reader-build.js';
import { digitsOf, filesUnder, keyOf, sha256, startReader, userJid, writeAsWhatsApp, writeSkip, type Running } from './reader-harness.js';

const reader = await buildReader();

const FEED = { guardHours: MESSAGES_LIMITS.cursorGuardHours, firstRunHours: MESSAGES_LIMITS.firstRunHours, maxRows: 1_000 };
/** Every line the first run reads: all but the status and channel chats' two. */
const FIRST_RUN_LINES = 15;
const SPOOL_TTL_MS = 10 * 60_000;
const CALL_KEY = /^k[0-9a-f]{16}$/;
/** ZCALLRECORD.ZCALLTYPE of a FaceTime video call. */
const PHONE_VIDEO = 8;

describe.skipIf(!reader)('jantar-messages-reader: search, morning feed, media, calls', () => {
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
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-reader-more-')));
    paths = fixture('wa');
  });
  afterEach(async () => {
    for (const r of running.splice(0)) await r.stop();
    for (const h of held.splice(0)) h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(opts: { state?: string; fixture?: FixturePaths; now?: string } = {}): Promise<Running> {
    const r = await startReader(reader!, {
      fixture: opts.fixture ?? paths,
      state: opts.state ?? join(dir, 'state'),
      sock: join(dir, `r${running.length}.sock`),
      ...(opts.now ? { now: opts.now } : {}),
    });
    running.push(r);
    return r;
  }

  /** A message's row id in the fixture, by stanza id. */
  function pkOf(p: FixturePaths, stanza: string): number {
    const db = new DatabaseSync(join(p.container, 'ChatStorage.sqlite'), { readOnly: true });
    try {
      return (db.prepare('SELECT Z_PK AS pk FROM ZWAMESSAGE WHERE ZSTANZAID = ?').get(stanza) as { pk: number }).pk;
    } finally {
      db.close();
    }
  }

  function maxPk(p: FixturePaths): number {
    const db = new DatabaseSync(join(p.container, 'ChatStorage.sqlite'), { readOnly: true });
    try {
      return (db.prepare('SELECT max(Z_PK) AS pk FROM ZWAMESSAGE').get() as { pk: number }).pk;
    } finally {
      db.close();
    }
  }

  const search = async (r: Running, args: Record<string, unknown>) => ReaderSearchSchema.parse(await r.ok('search', { limit: 20, ...args })).hits;
  const feed = async (r: Running, args: Record<string, unknown>) => ReaderNewSinceSchema.parse(await r.ok('newSince', { ...FEED, ...args }));
  const feedKeys = (res: ReaderNewSince) => res.chats.flatMap((c) => c.messages.map((m) => m.msgKey)).sort();

  it('search finds invoice and skips skipped chats', async () => {
    const r = await start();
    const asha = keyOf(r.state, paths.jids.ashaLid);
    const group = keyOf(r.state, paths.jids.group);

    expect(await search(r, { q: 'deck' })).toEqual([
      { chatKey: asha, chatName: 'Asha Test', msgKey: `${asha}.3EB0FX0604`, at: '2026-11-13T18:00:00.000Z', fromMe: false, sender: 'Asha Test', snippet: FIXTURE_TEXT.deck },
    ]);
    // An image's caption.
    expect(await search(r, { q: 'INVOICE' })).toMatchObject([{ chatKey: group, chatName: 'Group One', msgKey: `${group}.3EB0FX0704`, sender: 'Neel Test', snippet: FIXTURE_TEXT.caption }]);
    expect(await search(r, { q: 'two items' })).toMatchObject([{ chatKey: group, sender: 'Asha Test' }]);

    // Newest first, at most `limit`; `chatKey` keeps to one chat.
    const the = await search(r, { q: 'the' });
    expect(new Set(the.map((h) => h.chatKey)).size).toBeGreaterThan(2);
    expect(the.map((h) => h.at)).toEqual([...the.map((h) => h.at)].sort().reverse());
    expect(await search(r, { q: 'the', limit: 2 })).toEqual(the.slice(0, 2));
    const ravi = keyOf(r.state, paths.jids.ravi);
    expect((await search(r, { q: 'the', chatKey: ravi })).map((h) => h.snippet)).toEqual([FIXTURE_TEXT.hundred]);
    expect(await search(r, { q: 'deck', since: '2026-11-13T18:00:00.001Z' })).toEqual([]);
    expect(await search(r, { q: 'deck', since: '2026-11-13T18:00:00.000Z' })).toHaveLength(1);

    // Left-out chats, WhatsApp's own columns and a mention's digits never match.
    for (const q of ['weekend trip', 'weekly digest', 'Unsent draft', 'Last-message preview', digitsOf(FIXTURE_OWNER.lid)]) {
      expect(await search(r, { q })).toEqual([]);
    }
    expect(await search(r, { q: 'can you check' })).toMatchObject([{ snippet: '@Me can you check?' }]);

    // Skipping Asha: her chat and her lines in the group are gone.
    writeSkip(r.state, [asha]);
    expect(await search(r, { q: 'deck' })).toEqual([]);
    expect(await search(r, { q: 'two items' })).toEqual([]);
    expect(JSON.stringify(await search(r, { q: 'e', limit: 50 }))).not.toContain('Asha');
    expect(await r.call('search', { q: 'deck', chatKey: asha, limit: 20 })).toMatchObject({ ok: false, error: 'not_found' });
    // A skipped group is gone too.
    writeSkip(r.state, [group]);
    expect(await search(r, { q: 'invoice' })).toEqual([]);
  });

  it('search escapes LIKE wildcards', async () => {
    const r = await start();
    expect((await search(r, { q: '100' })).map((h) => h.snippet).sort()).toEqual([FIXTURE_TEXT.percent, FIXTURE_TEXT.hundred].sort());
    expect((await search(r, { q: '100%' })).map((h) => h.snippet)).toEqual([FIXTURE_TEXT.percent]);
    expect(await search(r, { q: 's_ides' })).toEqual([]);
    expect(await search(r, { q: 'slides' })).toHaveLength(1);
    expect(await search(r, { q: '\\%' })).toEqual([]);
    expect(await r.call('search', { q: 'x'.repeat(201), limit: 20 })).toMatchObject({ ok: false, error: 'bad_request' });
    expect(await r.call('search', { q: 'deck', limit: MESSAGES_LIMITS.searchMax + 1 })).toMatchObject({ ok: false, error: 'bad_request' });
  });

  it('search looks back 90 days unless told otherwise, and cuts a long line around the match', async () => {
    const wa = writeAsWhatsApp(paths);
    const long = `${'Before the point. '.repeat(20)}The kite festival is on Sunday.${' After the point.'.repeat(20)}`;
    try {
      wa.line(paths.jids.ravi, { stanza: '3EB0FXO001', at: appleSeconds('2026-08-15T10:00:00.000Z'), text: 'An old line about kites' });
      wa.line(paths.jids.ravi, { stanza: '3EB0FXO002', at: appleSeconds('2026-11-13T21:00:00.000Z'), text: long });
    } finally {
      wa.close();
    }
    const r = await start();
    expect(await search(r, { q: 'about kites' })).toEqual([]);
    expect(await search(r, { q: 'about kites', since: '2026-08-01T00:00:00.000Z' })).toHaveLength(1);

    const [hit] = await search(r, { q: 'kite festival' });
    expect(hit!.snippet).toContain('The kite festival is on Sunday.');
    expect(hit!.snippet.length).toBeLessThan(long.length);
    expect(hit!.snippet.startsWith('…') && hit!.snippet.endsWith('…')).toBe(true);
  });

  it('newSince first run returns 24h and a cursor', async () => {
    const r = await start();
    const res = await feed(r, { cursor: null });
    expect(res).toMatchObject({ reset: false, truncated: false, nextCursor: { pk: maxPk(paths), at: FIXTURE_NEWEST_AT } });
    expect(res.chats.map((c) => c.chat.name)).toEqual(['Group One', 'Asha Test', 'Ravi Test', 'Mom', 'Mom']);
    expect(res.chats.map((c) => c.messages.length)).toEqual([6, 4, 3, 1, 1]);
    expect(res.chats.flatMap((c) => c.messages)).toHaveLength(FIRST_RUN_LINES);
    for (const c of res.chats) {
      expect(c.earlier).toEqual([]);
      const ats = c.messages.map((m) => m.at);
      expect(ats).toEqual([...ats].sort());
    }
    const [group, asha] = res.chats;
    // The same lines a read gives, the owner's 1:1 numbers included.
    expect(asha!.chat).toMatchObject({ chatKey: keyOf(r.state, paths.jids.ashaLid), phone: '919990000001' });
    expect(asha!.messages.at(-1)).toMatchObject({ text: FIXTURE_TEXT.deck, sender: 'Asha Test' });
    expect(group!.messages.find((m) => m.mentionsMe)).toMatchObject({ text: '@Me can you check?' });
    const out = JSON.stringify(res);
    expect(out).not.toMatch(/Status: weekend|weekly digest|@s\.whatsapp\.net|@lid|@g\.us/);
    expect(out).not.toContain(FIXTURE_TEXT.savedInput);

    // firstRunHours bounds it: 12 h before 03:00Z is 15:00Z, and a line at 15:00:00.000 is not after it.
    const half = await feed(r, { cursor: null, firstRunHours: 12 });
    expect(half.chats.map((c) => [c.chat.name, c.messages.map((m) => m.at)])).toEqual([
      ['Group One', [FIXTURE_NEWEST_AT]],
      ['Asha Test', ['2026-11-13T18:00:00.000Z']],
    ]);
    // Skipping Asha: her chat goes, her group lines are "[skipped]" with nothing more.
    writeSkip(r.state, [keyOf(r.state, paths.jids.ashaLid)]);
    const skipped = await feed(r, { cursor: null });
    expect(skipped.chats.map((c) => c.chat.name)).toEqual(['Group One', 'Ravi Test', 'Mom', 'Mom']);
    expect(skipped.chats[0]!.messages.find((m) => m.skippedSender)).toEqual({
      msgKey: `${keyOf(r.state, paths.jids.group)}.3EB0FX0702`, at: '2026-11-13T12:30:00.000Z', fromMe: false, sender: '[skipped]', kind: 'other', skippedSender: true,
    });
    expect(JSON.stringify(skipped)).not.toContain('Asha');
  });

  it('newSince goes on from a cursor, with the lines before the first new one', async () => {
    const r = await start();
    const asha = keyOf(r.state, paths.jids.ashaLid);
    const cursor = { pk: pkOf(paths, '3EB0FX0603'), at: '2026-11-13T11:00:00.000Z' };
    const res = await feed(r, { cursor });
    expect(res).toMatchObject({ reset: false, truncated: false, nextCursor: { pk: maxPk(paths), at: FIXTURE_NEWEST_AT } });
    expect(res.chats.map((c) => [c.chat.name, c.messages.length, c.earlier.length])).toEqual([
      ['Group One', 6, 0],
      ['Asha Test', 1, 3],
    ]);
    expect(res.chats[1]!.earlier.map((m) => m.msgKey)).toEqual(['3EB0FX0601', '3EB0FX0602', '3EB0FX0603'].map((s) => `${asha}.${s}`));

    // Nothing new: nothing read, the cursor stays.
    const again = await feed(r, { cursor: res.nextCursor });
    expect(again).toMatchObject({ chats: [], reset: false, truncated: false, nextCursor: { pk: res.nextCursor.pk } });

    // Lines Asha writes later come with up to READER_EARLIER_MAX lines before them.
    const wa = writeAsWhatsApp(paths);
    try {
      for (let i = 0; i < READER_EARLIER_MAX + 2; i++) {
        wa.line(paths.jids.ashaLid, { stanza: `3EB0FXN${String(i).padStart(3, '0')}`, at: appleSeconds('2026-11-13T22:00:00.000Z') + i, text: `Later line ${i}`, fromMe: i % 2 === 0 });
      }
    } finally {
      wa.close();
    }
    const later = await feed(r, { cursor: { pk: pkOf(paths, '3EB0FXN009'), at: '2026-11-13T22:00:09.000Z' } });
    expect(later.chats.map((c) => c.chat.name)).toEqual(['Asha Test']);
    expect(later.chats[0]!.messages.map((m) => m.text)).toEqual(['Later line 10', 'Later line 11']);
    expect(later.chats[0]!.earlier.map((m) => m.text)).toEqual(Array.from({ length: READER_EARLIER_MAX }, (_, i) => `Later line ${i}`));
    expect(later.nextCursor).toEqual({ pk: maxPk(paths), at: '2026-11-13T22:00:11.000Z' });

    // Three days on, a stored cursor reads only the guard's 72 h, and a first run 24 h: never everything.
    const old = await start({ now: '2026-11-17T03:00:00.000Z' });
    expect(await feed(old, { cursor })).toMatchObject({ chats: [], reset: false, nextCursor: { pk: maxPk(paths) } });
    expect((await feed(old, { cursor: null })).chats).toEqual([]);
  });

  it('newSince falls back when cursor exceeds max pk', async () => {
    const r = await start();
    const first = await feed(r, { cursor: null });
    const relinked = await feed(r, { cursor: { pk: 10_000_000, at: FIXTURE_NEWEST_AT } });
    expect(relinked).toMatchObject({ reset: true, truncated: false, nextCursor: first.nextCursor });
    expect(feedKeys(relinked)).toEqual(feedKeys(first));

    // WhatsApp re-linked: rows renumbered from 1, stanza ids (and so message keys) kept.
    const renumbered = fixture('relinked', { renumberPk: true });
    const after = await start({ fixture: renumbered });
    const res = await feed(after, { cursor: first.nextCursor });
    expect(res.reset).toBe(true);
    expect(res.nextCursor.pk).toBe(maxPk(renumbered));
    expect(res.nextCursor.pk).toBeLessThan(first.nextCursor.pk);
    expect(feedKeys(res)).toEqual(feedKeys(first));
  });

  it('newSince stops at maxRows and the next cursor reads the rest', async () => {
    const r = await start();
    const all = feedKeys(await feed(r, { cursor: null }));
    const seen: string[] = [];
    let cursor: unknown = null;
    let pages = 0;
    for (;;) {
      const page = await feed(r, { cursor, maxRows: 4 });
      pages++;
      seen.push(...feedKeys(page));
      expect(page.chats.flatMap((c) => c.messages).length).toBeLessThanOrEqual(4);
      cursor = page.nextCursor;
      if (!page.truncated) break;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(Math.ceil(FIRST_RUN_LINES / 4));
    expect(seen.sort()).toEqual(all);
  });

  it('lastFromMe gives the owner\'s last line to each chat or person', async () => {
    const r = await start();
    const k = (jid: string) => keyOf(r.state, jid);
    const unknown = k(userJid('919990000099'));
    const chatKeys = [k(paths.jids.ashaLid), k(paths.jids.asha), k(paths.jids.ravi), k(paths.jids.mom1), k(paths.jids.mom2), k(paths.jids.group), k('status@broadcast'), unknown];
    expect(ReaderLastFromMeSchema.parse(await r.ok('lastFromMe', { chatKeys }))).toEqual({
      // Asha's chat is under her @lid; her number's key is the same person.
      [k(paths.jids.ashaLid)]: '2026-11-13T09:40:00.000Z',
      [k(paths.jids.asha)]: '2026-11-13T09:40:00.000Z',
      [k(paths.jids.ravi)]: '2026-11-13T09:10:00.000Z',
      [k(paths.jids.mom1)]: null,
      [k(paths.jids.mom2)]: '2026-11-13T08:05:00.000Z',
      [k(paths.jids.group)]: '2026-11-13T12:00:00.000Z',
      [k('status@broadcast')]: null,
      [unknown]: null,
    });
    writeSkip(r.state, [k(paths.jids.asha)]);
    expect(await r.ok('lastFromMe', { chatKeys: [k(paths.jids.ashaLid)] })).toEqual({ [k(paths.jids.ashaLid)]: null });
    expect(await r.call('lastFromMe', { chatKeys: ['nope'] })).toMatchObject({ ok: false, error: 'bad_request' });
  });

  it('media copies to spool, never the original', async () => {
    const r = await start();
    const group = keyOf(r.state, paths.jids.group);
    const original = join(paths.container, 'Message', FIXTURE_MEDIA.localPath);
    const before = sha256(original);
    const files = filesUnder(paths.container);
    const spool = join(r.state, 'spool');
    mkdirSync(spool, { recursive: true, mode: 0o700 });
    const old = join(spool, 'old.jpg');
    const fresh = join(spool, 'fresh.jpg');
    writeFileSync(old, 'x', { mode: 0o600 });
    writeFileSync(fresh, 'x', { mode: 0o600 });
    const past = new Date(Date.now() - SPOOL_TTL_MS - 60_000);
    utimesSync(old, past, past);

    const res = ReaderMediaSchema.parse(await r.ok('media', { msgKey: `${group}.3EB0FX0704`, maxBytes: MESSAGES_LIMITS.mediaMaxBytes }));
    expect(res).toMatchObject({ kind: 'image', mime: 'image/jpeg', bytes: statSync(original).size });
    expect(res).not.toHaveProperty('fileName');
    expect(res.file.startsWith(`${spool}/`)).toBe(true);
    expect(res.file).toMatch(/\/[0-9a-f]{32}\.jpg$/);
    expect(readFileSync(res.file).equals(readFileSync(original))).toBe(true);
    expect(statSync(res.file).mode & 0o777).toBe(0o600);
    expect(statSync(spool).mode & 0o777).toBe(0o700);
    // Copies older than ten minutes are swept; newer ones stay.
    expect(readdirSync(spool).sort()).toEqual([res.file.split('/').at(-1)!, 'fresh.jpg'].sort());

    const again = ReaderMediaSchema.parse(await r.ok('media', { msgKey: `${group}.3EB0FX0704`, maxBytes: MESSAGES_LIMITS.mediaMaxBytes }));
    expect(again.file).not.toBe(res.file);

    // Over maxBytes: refused, nothing left in the spool.
    const spooled = readdirSync(spool).sort();
    expect(await r.call('media', { msgKey: `${group}.3EB0FX0704`, maxBytes: 10 })).toMatchObject({ ok: false, error: 'bad_request' });
    expect(readdirSync(spool).sort()).toEqual(spooled);
    // Text, unknown, malformed.
    const asha = keyOf(r.state, paths.jids.ashaLid);
    expect(await r.call('media', { msgKey: `${asha}.3EB0FX0604`, maxBytes: 1_000 })).toMatchObject({ ok: false, error: 'not_found' });
    expect(await r.call('media', { msgKey: `${group}.3EB0FXNONE`, maxBytes: 1_000 })).toMatchObject({ ok: false, error: 'not_found' });
    expect(await r.call('media', { msgKey: 'nope', maxBytes: 1_000 })).toMatchObject({ ok: false, error: 'bad_request' });
    expect(await r.call('media', { msgKey: `${group}.3EB0FX0704`, maxBytes: MESSAGES_LIMITS.mediaMaxBytes + 1 })).toMatchObject({ ok: false, error: 'bad_request' });

    // A skipped group's files never leave.
    writeSkip(r.state, [group]);
    expect(await r.call('media', { msgKey: `${group}.3EB0FX0704`, maxBytes: MESSAGES_LIMITS.mediaMaxBytes })).toMatchObject({ ok: false, error: 'not_found' });

    expect(sha256(original)).toBe(before);
    const after = filesUnder(paths.container);
    expect(after).toEqual(expect.arrayContaining(files));
    expect(after.filter((f) => !files.includes(f)).every((f) => /\.sqlite-(?:wal|shm)$/.test(f))).toBe(true);
  });

  it('waCalls and phoneCalls', async () => {
    // Two more on the iPhone: a number nobody has, and the owner's FaceTime video to Asha.
    const phone = new DatabaseSync(paths.phoneDb);
    try {
      const add = phone.prepare(
        'INSERT INTO ZCALLRECORD (Z_PK, Z_ENT, Z_OPT, ZANSWERED, ZCALLTYPE, ZORIGINATED, ZDATE, ZDURATION, ZADDRESS, ZSERVICE_PROVIDER) VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, ?)',
      );
      add.run(2, 0, 1, 0, appleSeconds('2026-11-13T12:00:00.000Z'), 0, '+919990000009', 'com.apple.Telephony');
      add.run(3, 1, PHONE_VIDEO, 1, appleSeconds('2026-11-13T13:00:00.000Z'), 61.5, '+91 99900 00001', 'com.apple.FaceTime');
    } finally {
      phone.close();
    }

    const r = await start();
    const asha = keyOf(r.state, paths.jids.ashaLid);
    const ravi = keyOf(r.state, paths.jids.ravi);
    const missed = { incoming: true, missed: true, video: false, durationS: 0 };

    const wa = ReaderCallsSchema.parse(await r.ok('waCalls', { since: FIXTURE_SINCE })).calls;
    // Asha rang twice from her @lid: one call.
    expect(wa).toMatchObject([
      { at: '2026-11-13T09:30:00.000Z', who: 'Asha Test', chatKey: asha, via: 'whatsapp', ...missed },
      { at: '2026-11-13T10:00:00.000Z', who: 'Ravi Test', chatKey: ravi, via: 'whatsapp', ...missed },
    ]);
    const ph = ReaderCallsSchema.parse(await r.ok('phoneCalls', { since: FIXTURE_SINCE })).calls;
    expect(ph).toMatchObject([
      // Matched through ContactsV2: the number is Ravi's WhatsApp id.
      { at: '2026-11-13T11:00:00.000Z', who: 'Ravi Test', chatKey: ravi, via: 'phone', ...missed },
      { at: '2026-11-13T12:00:00.000Z', who: '+91 99900 00009', via: 'phone', ...missed },
      { at: '2026-11-13T13:00:00.000Z', who: 'Asha Test', chatKey: asha, via: 'phone', incoming: false, missed: false, video: true, durationS: 61.5 },
    ]);
    expect(ph[1]).not.toHaveProperty('chatKey');
    const keys = [...wa, ...ph].map((c) => c.callKey);
    for (const k of keys) expect(k).toMatch(CALL_KEY);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ReaderCallsSchema.parse(await r.ok('waCalls', { since: FIXTURE_SINCE })).calls.map((c) => c.callKey)).toEqual(wa.map((c) => c.callKey));
    expect(JSON.stringify([wa, ph])).not.toMatch(/@s\.whatsapp\.net|@lid|919990000002/);

    expect(ReaderCallsSchema.parse(await r.ok('waCalls', { since: '2026-11-13T09:45:00.000Z' })).calls.map((c) => c.who)).toEqual(['Ravi Test']);
    expect(await r.call('waCalls', {})).toMatchObject({ ok: false, error: 'bad_request' });

    // A skipped person's calls never come, under either id.
    writeSkip(r.state, [ravi, asha]);
    expect(ReaderCallsSchema.parse(await r.ok('waCalls', { since: FIXTURE_SINCE })).calls).toEqual([]);
    expect(ReaderCallsSchema.parse(await r.ok('phoneCalls', { since: FIXTURE_SINCE })).calls.map((c) => c.who)).toEqual(['+91 99900 00009']);
  });

  it('waCalls reads the real layout: participants hang off the aggregate', async () => {
    // WhatsApp names call participants by @lid; Ravi's chat is under his number.
    const raviLid = '88800000000002@lid';
    const lid = new DatabaseSync(join(paths.container, 'LID.sqlite'));
    try {
      lid.prepare('INSERT INTO ZWAZACCOUNT (Z_PK, Z_ENT, Z_OPT, ZIDENTIFIER, ZPHONENUMBER) VALUES (10, 1, 1, ?, ?)').run(raviLid, digitsOf(paths.jids.ravi));
    } finally {
      lid.close();
    }
    // Each call's attempts carry another call's row id, so hanging the
    // participants off an attempt would swap who is on which call.
    const at = (hhmm: string) => appleSeconds(`2026-11-13T${hhmm}.000Z`);
    const db = new DatabaseSync(join(paths.container, 'CallHistory.sqlite'));
    const attempt = db.prepare(
      'INSERT INTO ZWACDCALLEVENT (Z_PK, Z_ENT, Z_OPT, Z1CALLEVENTS, ZDATE, ZDURATION, ZOUTCOME, ZCALLIDSTRING, ZGROUPJIDSTRING, ZGROUPCALLCREATORUSERJIDSTRING) VALUES (?, 2, 1, ?, ?, ?, 0, ?, ?, ?)',
    );
    try {
      const call = db.prepare(
        'INSERT INTO ZWAAGGREGATECALLEVENT (Z_PK, Z_ENT, Z_OPT, ZINCOMING, ZMISSED, ZMISSEDREASON, ZVIDEO, ZFIRSTDATE, ZLINKTOKEN) VALUES (?, 1, 1, ?, ?, 0, ?, ?, NULL)',
      );
      const person = db.prepare('INSERT INTO ZWACDCALLEVENTPARTICIPANT (Z_PK, Z_ENT, Z_OPT, Z1PARTICIPANTS, ZJIDSTRING, ZOUTCOME) VALUES (?, 3, 1, ?, ?, 0)');
      // 20: Ravi's missed call, rung twice.
      call.run(20, 1, 1, 0, at('16:00:00'));
      attempt.run(30, 20, at('16:00:00'), 0, 'FXCALL20A', null, null);
      attempt.run(31, 20, at('16:01:00'), 0, 'FXCALL20B', null, null);
      person.run(20, 20, raviLid);
      // 30: the owner's video call to Asha, picked up on the second try; its first time is only on its attempts.
      call.run(30, 0, 0, 1, null);
      attempt.run(20, 30, at('17:00:00'), 4, 'FXCALL30A', null, FIXTURE_OWNER.lid);
      attempt.run(21, 30, at('17:02:00'), 125.5, 'FXCALL30B', null, FIXTURE_OWNER.lid);
      person.run(30, 30, paths.jids.ashaLid);
      // 40: a group call Ravi started, answered.
      call.run(40, 1, 0, 0, at('18:00:00'));
      attempt.run(50, 40, at('18:00:00'), 300, 'FXCALL40A', paths.jids.group, raviLid);
      person.run(41, 40, paths.jids.ashaLid);
      person.run(42, 40, FIXTURE_NEEL);
      // 50: Asha and Ravi together, no group.
      call.run(50, 1, 1, 0, at('19:00:00'));
      attempt.run(40, 50, at('19:00:00'), 0, 'FXCALL50A', null, paths.jids.ashaLid);
      person.run(50, 50, paths.jids.ashaLid);
      person.run(51, 50, raviLid);

      const r = await start();
      const k = (jid: string) => keyOf(r.state, jid);
      const later = async () => ReaderCallsSchema.parse(await r.ok('waCalls', { since: '2026-11-13T15:00:00.000Z' })).calls;
      const calls = await later();
      expect(calls).toEqual([
        { callKey: expect.stringMatching(CALL_KEY), at: '2026-11-13T16:00:00.000Z', who: 'Ravi Test', chatKey: k(paths.jids.ravi), via: 'whatsapp', incoming: true, missed: true, video: false, durationS: 0 },
        { callKey: expect.stringMatching(CALL_KEY), at: '2026-11-13T17:00:00.000Z', who: 'Asha Test', chatKey: k(paths.jids.ashaLid), via: 'whatsapp', incoming: false, missed: false, video: true, durationS: 125.5 },
        { callKey: expect.stringMatching(CALL_KEY), at: '2026-11-13T18:00:00.000Z', who: 'Group One', chatKey: k(paths.jids.group), via: 'whatsapp', incoming: true, missed: false, video: false, durationS: 300 },
        { callKey: expect.stringMatching(CALL_KEY), at: '2026-11-13T19:00:00.000Z', who: 'Asha Test, Ravi Test', via: 'whatsapp', incoming: true, missed: true, video: false, durationS: 0 },
      ]);
      expect(new Set(calls.map((c) => c.callKey)).size).toBe(calls.length);
      expect(JSON.stringify(calls)).not.toMatch(/@s\.whatsapp\.net|@lid|@g\.us|FXCALL/);

      // Another attempt joins its call: still one call, the same key.
      attempt.run(32, 20, at('16:03:00'), 0, 'FXCALL20C', null, null);
      expect((await later()).map((c) => c.callKey)).toEqual(calls.map((c) => c.callKey));

      // A skipped group's calls never come; nor do a skipped person's, on the call or starting a group's.
      writeSkip(r.state, [k(paths.jids.group)]);
      expect((await later()).map((c) => c.at)).toEqual(['2026-11-13T16:00:00.000Z', '2026-11-13T17:00:00.000Z', '2026-11-13T19:00:00.000Z']);
      writeSkip(r.state, [k(paths.jids.ravi)]);
      expect((await later()).map((c) => c.who)).toEqual(['Asha Test']);
    } finally {
      db.close();
    }
  });

  it('phoneCalls without access says no_access', async () => {
    const locked = join(dir, 'locked.storedata');
    writeFileSync(locked, readFileSync(paths.phoneDb));
    chmodSync(locked, 0o000);
    try {
      const r = await start({ fixture: { ...paths, phoneDb: locked } });
      expect(await r.call('phoneCalls', { since: FIXTURE_SINCE })).toMatchObject({ ok: false, error: 'no_access' });
      expect(ReaderStatusSchema.parse(await r.ok('status')).phone.readable).toBe(false);
      // WhatsApp's own calls don't need it.
      expect(ReaderCallsSchema.parse(await r.ok('waCalls', { since: FIXTURE_SINCE })).calls).toHaveLength(2);

      const none = await start({ fixture: { ...paths, phoneDb: join(dir, 'nowhere.storedata') }, state: join(dir, 'state2') });
      expect(await none.call('phoneCalls', { since: FIXTURE_SINCE })).toMatchObject({ ok: false, error: 'no_access' });
    } finally {
      chmodSync(locked, 0o600);
    }
  });

  it('calls cut at whole milliseconds, as reads do', async () => {
    const r = await start();
    // since = a call's own time keeps it; a millisecond later leaves it out.
    const calls = ReaderCallsSchema.parse(await r.ok('waCalls', { since: '2026-11-13T10:00:00.000Z' })).calls;
    expect(calls.map((c) => c.at)).toEqual(['2026-11-13T10:00:00.000Z']);
    expect(ReaderCallsSchema.parse(await r.ok('waCalls', { since: '2026-11-13T10:00:00.001Z' })).calls).toEqual([]);
    expect(ReaderCallsSchema.parse(await r.ok('phoneCalls', { since: '2026-11-13T11:00:00.001Z' })).calls).toEqual([]);
  });
});
