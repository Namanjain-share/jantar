/**
 * The synthetic WhatsApp container (fixture.ts) the reader tests run on:
 * - it opens read-only, is in WAL mode, holds the seven chats in the order
 *   and window the reader tests expect, with the image on disk and the
 *   iPhone call log beside the container;
 * - no file it writes holds a real-looking Indian mobile number: the only
 *   ten-digit runs (with or without 91) are the 99900000xx fakes;
 * - dropColumn, renumberPk and extraMessages change only what they name.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FIXTURE_MEDIA,
  FIXTURE_NEWEST_AT,
  FIXTURE_NOW,
  FIXTURE_OWNER,
  FIXTURE_SINCE,
  FIXTURE_TEXT,
  WA_SESSION,
  appleSeconds,
  makeWhatsAppFixture,
} from './fixture.js';

/** A ten-digit Indian mobile number, bare or after 91. */
const MOBILE = /\b(?:91)?[6-9]\d{9}\b/g;
const FAKE_MOBILE = /^(?:91)?99900000\d\d$/;

let dir: string;
const open: DatabaseSync[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-wa-fixture-')));
});
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function readOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  open.push(db);
  return db;
}

function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const p = join(root, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

const chatStorage = (container: string) => readOnly(join(container, 'ChatStorage.sqlite'));
const count = (db: DatabaseSync, sql: string, ...args: (string | number)[]) => (db.prepare(sql).get(...args) as { n: number }).n;

describe('makeWhatsAppFixture', () => {
  it('fixture builds a readable WAL container', () => {
    const paths = makeWhatsAppFixture(dir);
    const db = chatStorage(paths.container);
    expect(count(db, 'SELECT count(*) AS n FROM ZWACHATSESSION')).toBe(7);
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    for (const name of ['CallHistory.sqlite', 'ContactsV2.sqlite', 'LID.sqlite']) {
      expect(readOnly(join(paths.container, name)).prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    }
    expect(count(readOnly(paths.phoneDb), 'SELECT count(*) AS n FROM ZCALLRECORD')).toBe(1);

    const media = join(paths.container, 'Message', FIXTURE_MEDIA.localPath);
    expect(existsSync(media)).toBe(true);
    const jpeg = readFileSync(media);
    expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
    const sof = jpeg.indexOf(Buffer.from('ffc0', 'hex'));
    expect([jpeg.readUInt16BE(sof + 5), jpeg.readUInt16BE(sof + 7)]).toEqual([32, 32]);
    expect(count(db, 'SELECT ZFILESIZE AS n FROM ZWAMEDIAITEM WHERE ZMEDIALOCALPATH = ?', FIXTURE_MEDIA.localPath)).toBe(jpeg.length);

    const mobiles = filesUnder(dir).flatMap((f) => readFileSync(f).toString('latin1').match(MOBILE) ?? []);
    expect(mobiles.length).toBeGreaterThan(0);
    expect(mobiles.filter((m) => !FAKE_MOBILE.test(m))).toEqual([]);
  });

  it('holds what the reader tests expect', () => {
    const paths = makeWhatsAppFixture(dir);
    const db = chatStorage(paths.container);
    const shown = db
      .prepare('SELECT ZPARTNERNAME AS name FROM ZWACHATSESSION WHERE ZSESSIONTYPE IN (?, ?) ORDER BY ZLASTMESSAGEDATE DESC')
      .all(WA_SESSION.dm, WA_SESSION.group)
      .map((r) => r.name);
    expect(shown).toEqual(['Group One', 'Asha Test', 'Ravi Test', 'Mom', 'Mom']);
    expect(db.prepare('SELECT ZCONTACTJID AS jid FROM ZWACHATSESSION WHERE ZPARTNERNAME = ?').get('Asha Test')).toEqual({ jid: paths.jids.ashaLid });

    const span = db.prepare('SELECT min(ZMESSAGEDATE) AS lo, max(ZMESSAGEDATE) AS hi FROM ZWAMESSAGE').get() as { lo: number; hi: number };
    expect(span.lo).toBeGreaterThanOrEqual(appleSeconds(FIXTURE_SINCE));
    expect(span.hi).toBe(appleSeconds(FIXTURE_NEWEST_AT));
    expect(span.hi).toBeLessThan(appleSeconds(FIXTURE_NOW));

    expect(db.prepare("SELECT ZCHATSESSION AS chat FROM ZWAMESSAGE WHERE ZTEXT LIKE '%deck%'").all()).toHaveLength(1);
    const group = db.prepare('SELECT Z_PK AS pk FROM ZWACHATSESSION WHERE ZCONTACTJID = ?').get(paths.jids.group) as { pk: number };
    expect(count(db, 'SELECT count(*) AS n FROM ZWAMESSAGE WHERE ZCHATSESSION = ?', group.pk)).toBe(6);
    const members = db.prepare('SELECT ZMEMBERJID AS jid FROM ZWAGROUPMEMBER WHERE ZCHATSESSION = ?').all(group.pk).map((r) => r.jid);
    expect(members).toEqual(expect.arrayContaining([FIXTURE_OWNER.phone, FIXTURE_OWNER.lid, paths.jids.ashaLid, paths.jids.ravi]));
    expect(count(db, "SELECT count(*) AS n FROM ZWAMESSAGE WHERE ZTEXT = ? AND ZTEXT LIKE '@' || ? || '%'", FIXTURE_TEXT.mention, FIXTURE_OWNER.lid.split('@')[0]!)).toBe(1);
    expect(count(db, 'SELECT count(*) AS n FROM ZWAMESSAGE WHERE ZPARENTMESSAGE IS NOT NULL')).toBe(1);

    const lid = readOnly(join(paths.container, 'LID.sqlite'));
    expect(lid.prepare('SELECT ZPHONENUMBER AS phone FROM ZWAZACCOUNT WHERE ZIDENTIFIER = ?').get(paths.jids.ashaLid)).toEqual({ phone: '919990000001' });
  });

  it('dropColumn, renumberPk and extraMessages change only what they name', () => {
    const plain = makeWhatsAppFixture(join(dir, 'plain'));
    const base = chatStorage(plain.container);
    const maxPk = count(base, 'SELECT max(Z_PK) AS n FROM ZWAMESSAGE');
    const stanzas = base.prepare('SELECT ZSTANZAID AS id FROM ZWAMESSAGE ORDER BY ZMESSAGEDATE').all();

    const dropped = chatStorage(makeWhatsAppFixture(join(dir, 'dropped'), { dropColumn: 'ZSTANZAID' }).container);
    const cols = dropped.prepare("SELECT name FROM pragma_table_info('ZWAMESSAGE')").all().map((r) => r.name);
    expect(cols).not.toContain('ZSTANZAID');
    expect(cols).toContain('ZTEXT');
    expect(() => makeWhatsAppFixture(join(dir, 'typo'), { dropColumn: 'ZNOSUCHCOLUMN' })).toThrow(/ZNOSUCHCOLUMN/);

    const relinked = chatStorage(makeWhatsAppFixture(join(dir, 'relinked'), { renumberPk: true }).container);
    expect(count(relinked, 'SELECT max(Z_PK) AS n FROM ZWAMESSAGE')).toBeLessThan(maxPk);
    expect(relinked.prepare('SELECT ZSTANZAID AS id FROM ZWAMESSAGE ORDER BY ZMESSAGEDATE').all()).toEqual(stanzas);

    const busy = makeWhatsAppFixture(join(dir, 'busy'), { extraMessages: 50 });
    const busyDb = chatStorage(busy.container);
    const group = busyDb.prepare('SELECT Z_PK AS pk FROM ZWACHATSESSION WHERE ZCONTACTJID = ?').get(busy.jids.group) as { pk: number };
    expect(count(busyDb, 'SELECT count(*) AS n FROM ZWAMESSAGE WHERE ZCHATSESSION = ?', group.pk)).toBe(56);
    expect(count(busyDb, 'SELECT count(*) AS n FROM ZWACHATSESSION')).toBe(7);
  });
});
