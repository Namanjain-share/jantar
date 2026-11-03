/**
 * v0.11 People (P3, spec 7.2, 7.3, M14, O19): her tools, by reading the
 * lists and calling them on her deps, with no Claude run.
 *
 * - Her tool list is `CHAT_TOOLS ∩ PERSON_CHAT_TOOLS` plus hers alone, and
 *   holds no session, account, Intel, meeting, money, post, assigning or
 *   journal tool; his never holds hers.
 * - A tool listed for her by mistake still sees only her space: every
 *   other Life module, Intel, meetings and the board are denied on her
 *   deps (spec 7.3, the second layer).
 * - Nothing under chat/ imports the journal (M14).
 * - Photo metadata stripping, format by format (O19).
 * - chat.db 1 → 2 keeps every row in the owner's thread and copies the
 *   file first (spec 9.1.3).
 */
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHAT_MIGRATIONS, openChatDb } from '../../src/chat/db.js';
import { personChatDeps, threadOf } from '../../src/chat/person-deps.js';
import { PERSON_CHAT_TOOLS, PERSON_FOOD_TOOLS, PERSON_ONLY_TOOLS } from '../../src/chat/person-tools.js';
import { ChatStore } from '../../src/chat/store.js';
import { stripImageMetadata } from '../../src/chat/strip.js';
import { CHAT_TOOLS, PERSON_TOOLS, TurnTools, toolsFor } from '../../src/chat/tools.js';
import { chatRig, turnId, type ChatRig } from './helpers.js';

const NEVER = /^(sessions?_|session_get|accounts_|intel_|meetings?_|money_|budget_|bill_|post_|request_action|plan_set)|journal|assign/;

describe('her tools (spec 7.2)', () => {
  it('are exactly her list: the shared to-do and weight tools and hers alone; never a session, money, journal or assigning tool', () => {
    const names = PERSON_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual([...PERSON_CHAT_TOOLS].sort());
    for (const n of names) expect(n, n).not.toMatch(NEVER);
    for (const t of PERSON_TOOLS.filter((x) => x.name === 'todo_add')) expect(Object.keys((t.input as unknown as { shape: object }).shape)).not.toContain('person');
  });

  it("his tool list never holds hers", () => {
    const his = new Set(CHAT_TOOLS.map((t) => t.name));
    for (const t of PERSON_ONLY_TOOLS) if (t.name !== 'today' && t.name !== 'request_delete') expect(his.has(t.name), t.name).toBe(false);
  });
});

describe('her deps (spec 7.3)', () => {
  let rig: ChatRig;
  beforeAll(async () => {
    rig = await chatRig();
  });
  afterAll(async () => {
    await rig.close();
  });

  it('threadOf: hers is p:<pid>, every other actor is the owner\'s', () => {
    expect(threadOf({ kind: 'person', personId: '01JASHA0000000000000000000', deviceId: 'd' })).toBe('p:01JASHA0000000000000000000');
    expect(threadOf({ kind: 'device', deviceId: 'x', scopes: ['read', 'control'] })).toBe('');
    expect(threadOf({ kind: 'cli' })).toBe('');
  });

  it("a tool listed by mistake fails closed: his modules, Intel, meetings and the board are denied on her deps", async () => {
    rig.life.finance.add({ day: '2026-11-02', kind: 'expense', amount: 12300, category: 'Food' }, { kind: 'cli' });
    const her = personChatDeps(rig.deps, { pid: '01JASHA0000000000000000000', people: rig.life.people });
    expect(() => her.life.finance.month()).toThrow(/not_in_her_space/);
    expect(() => her.life.medicines.get()).toThrow(/not_in_her_space/);
    expect(() => her.life.places.list({ filter: 'all', sort: 'best' } as never)).toThrow(/not_in_her_space/);
    expect(() => her.intel.list({ limit: 5 })).toThrow(/not_in_her_space/);
    expect(() => her.board.state()).toThrow(/not_in_her_space/);
    expect(() => her.life.todos.forFolder('/tmp')).toThrow(/not_in_her_space/);
    // Her tool list on her deps is hers alone, whatever his switches say (her food log's tools only with her food module on: none here).
    expect(toolsFor(rig.ctx.settings.get(), her).map((t) => t.name).sort()).toEqual([...PERSON_CHAT_TOOLS].filter((n) => !PERSON_FOOD_TOOLS.has(n)).sort());
    // A turn whose list named money_month by mistake: the part is not hers and the read is not hers.
    const id = turnId();
    rig.store.inThread('p:01JASHA0000000000000000000').insertTurn({ id, at: rig.ctx.clock.iso(), via: 'phone', text: '', photos: [], state: 'running', tainted: false, refused: 0, by: 'person:01JASHA0000000000000000000:d' });
    const money = CHAT_TOOLS.find((t) => t.name === 'money_month');
    const sessions = CHAT_TOOLS.find((t) => t.name === 'sessions_find');
    if (!money || !sessions) throw new Error('tools');
    const tools = new TurnTools({
      ctx: rig.ctx,
      deps: her,
      store: rig.store.inThread('p:01JASHA0000000000000000000'),
      turnId: id,
      actor: { kind: 'person', personId: '01JASHA0000000000000000000', deviceId: 'd' },
      actorName: 'person:01JASHA0000000000000000000:d',
      message: '',
      tools: [money, sessions],
      lifeWrites: rig.lifeWrites,
      live: () => true,
    });
    for (const n of ['money_month', 'sessions_find']) {
      const a = await tools.call(n, {});
      expect(a.isError, n).toBe(true);
      expect(a.text).not.toMatch(/123|Food/);
    }
  });

  it('M14: nothing under chat/ imports the journal; her reads name no journal', () => {
    const src = fileURLToPath(new URL('../../src/chat', import.meta.url));
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith('.ts') ? [join(dir, n)] : []));
    for (const p of files(src)) {
      const text = readFileSync(p, 'utf8');
      expect(text, relative(src, p).split(sep).join('/')).not.toMatch(/from '[^']*life\/journal/);
    }
  });
});

describe('photo metadata (O19)', () => {
  const seg = (marker: number, body: Buffer) => {
    const head = Buffer.alloc(4);
    head[0] = 0xff;
    head[1] = marker;
    head.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([head, body]);
  };

  it('JPEG: EXIF, XMP and comments go, a JFIF thumbnail goes, ICC and the image stay', () => {
    const jfif = Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.from('0101000001000100', 'hex'), Buffer.from('0101'), Buffer.from('aabbcc', 'hex')]);
    const jpeg = Buffer.concat([
      Buffer.from('ffd8', 'hex'),
      seg(0xe0, jfif),
      seg(0xe1, Buffer.from('Exif\0\0GPS-SYNTHETIC serial 0042', 'latin1')),
      seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>synthetic</x:xmpmeta>', 'latin1')),
      seg(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01profile', 'latin1')),
      seg(0xfe, Buffer.from('a synthetic comment', 'latin1')),
      seg(0xdb, Buffer.alloc(65, 1)),
      seg(0xc0, Buffer.from('0800020002011100', 'hex')),
      seg(0xda, Buffer.from('01010000', 'hex')),
      Buffer.from('1234567890', 'hex'),
      Buffer.from('ffd9', 'hex'),
    ]);
    const out = stripImageMetadata(jpeg);
    if (!out) throw new Error('refused');
    for (const s of ['Exif', 'GPS-SYNTHETIC', 'xmpmeta', 'a synthetic comment']) expect(out.includes(Buffer.from(s, 'latin1')), s).toBe(false);
    expect(out.includes(Buffer.from('ICC_PROFILE', 'latin1'))).toBe(true);
    expect(out.includes(Buffer.from('1234567890', 'hex'))).toBe(true);
    expect(out.includes(Buffer.from('aabbcc', 'hex'))).toBe(false);
    expect(out.subarray(-2).toString('hex')).toBe('ffd9');
  });

  it('WebP: EXIF and XMP chunks go, the VP8X flags and RIFF size follow; GIF comments go', () => {
    const chunk = (type: string, data: Buffer) => {
      const h = Buffer.alloc(8);
      h.write(type, 0, 'latin1');
      h.writeUInt32LE(data.length, 4);
      return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x08 | 0x04;
    const body = Buffer.concat([chunk('VP8X', vp8x), chunk('VP8 ', Buffer.alloc(10, 7)), chunk('EXIF', Buffer.from('GPS-SYNTHETIC')), chunk('XMP ', Buffer.from('<x:xmpmeta/>'))]);
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'latin1');
    head.writeUInt32LE(body.length + 4, 4);
    head.write('WEBP', 8, 'latin1');
    const out = stripImageMetadata(Buffer.concat([head, body]));
    if (!out) throw new Error('refused');
    expect(out.includes(Buffer.from('GPS-SYNTHETIC'))).toBe(false);
    expect(out.includes(Buffer.from('xmpmeta'))).toBe(false);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect((out[20] ?? 0) & 0x0c).toBe(0);

    const gif = Buffer.concat([
      Buffer.from('GIF89a', 'latin1'),
      Buffer.from('01000100000000', 'hex'),
      Buffer.from('21fe', 'hex'),
      Buffer.from([9]),
      Buffer.from('a comment', 'latin1'),
      Buffer.from([0]),
      Buffer.from('2c00000000010001000002024401', 'hex'),
      Buffer.from([0]),
      Buffer.from('3b', 'hex'),
    ]);
    const g = stripImageMetadata(gif);
    if (!g) throw new Error('refused');
    expect(g.includes(Buffer.from('a comment', 'latin1'))).toBe(false);
    expect(g.subarray(-1).toString('hex')).toBe('3b');
  });

  it('anything that does not walk cleanly is refused, never kept with its metadata', () => {
    expect(stripImageMetadata(Buffer.from('ffd8ffe1ffff', 'hex'))).toBeNull();
    expect(stripImageMetadata(Buffer.from('not an image'))).toBeNull();
  });
});

describe('chat.db schema 2 (spec 9.1.3)', () => {
  let dir: string;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-chatdb-')));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a schema-1 file moves to 2 after a copy; every row is the owner\'s thread', () => {
    const path = join(dir, 'chat.db');
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec((CHAT_MIGRATIONS[0] as { sql: string }).sql);
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema', '1')").run();
    raw.prepare("INSERT INTO turns (id, at, state, json) VALUES ('01JTURN0000000000000000001', '2026-11-01T09:00:00.000Z', 'done', ?)").run(
      JSON.stringify({ id: '01JTURN0000000000000000001', at: '2026-11-01T09:00:00.000Z', via: 'phone', text: 'an old message', photos: [], state: 'done', tainted: false, refused: 0, by: 'device:x' }),
    );
    raw.close();
    const copy = join(dir, 'chat-pre-0.11.0.db');
    const r = openChatDb(path, { preMigrateCopy: () => copy });
    if (!r.ok) throw new Error(r.reason);
    expect(existsSync(copy)).toBe(true);
    const store = new ChatStore(r.db);
    expect(store.page(undefined).turns.map((t) => t.text)).toEqual(['an old message']);
    expect(store.inThread('p:01JASHA0000000000000000000').page(undefined).turns).toEqual([]);
    expect(store.threads()).toEqual(['']);
    store.close();
  });
});
