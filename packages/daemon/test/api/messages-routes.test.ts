/**
 * The Messages routes (0.15) over the real pipeline, with the real Messages
 * part (messages.db in memory) and a fake reader on its socket (no Swift):
 * - behind the switch: every route but the status answers 403 with its
 *   sentence while Messages is off, on both transports; a messages.db that
 *   won't open answers 503 with its sentence;
 * - a reader that is down, refused or busy answers 503 messages_unavailable
 *   with the MESSAGES_SAYS sentence; a chat or file it doesn't show is 404;
 * - a name two chats share answers the candidates and how many matched;
 * - a 1:1's number is on the owner's answers over TCP, never on ctl.sock's;
 * - who read: the phone, the CLI, or `jantar mcp` with its caller's pid and
 *   folder (its headers count on ctl.sock only);
 * - removing a skip: refused over TCP, done over ctl.sock;
 * - media: an image as image/jpeg with meetingShot's headers, counted on the
 *   device's raw byte budget; anything else is 415 with its name and size;
 * - writes are audited with their target id only, never a name or text;
 * - a person's device (People) reaches no messages route, Messages on.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorBodySchema, SettingsSchema, type RouteDef } from '@jantar/protocol';
import {
  MESSAGES_CALLER_HEADERS,
  MESSAGES_ROUTES,
  MessagesChatsResponseSchema,
  MessagesReadResponseSchema,
  MessagesReadsResponseSchema,
  MessagesStatusSchema,
  type Call,
  type Chat,
  type ChatOwner,
  type Draft,
  type Message,
  type MessagesRouteName,
  type MorningRun,
} from '@jantar/protocol/messages';
import { ASK_WRITES_LIMITED, FEATURE_OFF } from '../../src/api/app.js';
import { V03_LIMITS } from '../../src/api/services.js';
import { MESSAGE_FILE_READS_LIMITED, notAnImage } from '../../src/api/routes/messages.js';
import { resolvePaths } from '../../src/config.js';
import type { LifeResult, LifeService, MessagesService, MorningApi } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { MESSAGES_BROKEN_REASON, MESSAGES_SAYS, buildMessagesService, type ImageShrinker } from '../../src/messages/index.js';
import { readerError, startFakeReader, type FakeHandlers, type FakeReader } from '../messages/fake-reader.js';
import { LOOPBACK_HOST, LOOPBACK_ORIGIN, NONE, OWNER_HOST, OWNER_ORIGIN, PEOPLE_HOST, PEOPLE_ORIGIN, call as callAs, makeFixture } from '../people/isolation-fixture.js';
import { h, makeApi, pairCookie, type TestApi } from './fakes.js';

const NOW = '2026-11-14T03:00:00.000Z';
// Keys as the reader makes them ("c" + 16 hex); no run of ten digits in any of them.
const ASHA = 'ca1b2c3d4e5f6a7b8';
const MOM1 = 'cb2c3d4e5f6a7b8c9';
const MOM2 = 'cc3d4e5f6a7b8c9d0';
const GROUP = 'cd4e5f6a7b8c9d0e1';
const ASHA_PHONE = '919990000001';
const DECK = 'Can you send the deck by Friday 5pm?';
const RUN_ID = '01JFZ8X8Y3T0V5G9WQK2M4N0R1';
const DRAFT_ID = '01JFZ8X8Y3T0V5G9WQK2M4N0D1';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const SHRUNK = Buffer.concat([JPEG, Buffer.from('shrunk')]);
const OK: LifeResult = { ok: true, value: true };

const chat = (chatKey: string, name: string, kind: Chat['kind'] = 'dm', lastAt = '2026-11-13T18:00:00.000Z'): Chat => ({
  chatKey,
  name,
  kind,
  lastAt,
  unread: 0,
  lastFromMe: false,
  archived: false,
});
const ASHA_CHAT: ChatOwner = { ...chat(ASHA, 'Asha Test'), phone: ASHA_PHONE };
const line = (chatKey: string, n: number, text: string): Message => ({
  msgKey: `${chatKey}.3EB0A${n}`,
  at: '2026-11-13T18:00:00.000Z',
  fromMe: false,
  sender: 'Asha Test',
  kind: 'text',
  text,
});
const missed = (n: number, who: string, chatKey?: string): Call => ({
  callKey: `k${String(n).padStart(2, '0')}e1f2a3b4c5d6e7`,
  at: '2026-11-13T10:00:00.000Z',
  who,
  ...(chatKey ? { chatKey } : {}),
  via: 'whatsapp',
  incoming: true,
  missed: true,
  video: false,
  durationS: 0,
});

/** The reader of a Mac where Asha, two "Mom"s and Group One are readable. */
const READER: FakeHandlers = {
  chats: () => ({ chats: [ASHA_CHAT, chat(GROUP, 'Group One', 'group')], total: 2 }),
  read: (a) => {
    if (a.chatKey !== ASHA) throw readerError('not_found');
    return { chat: ASHA_CHAT, messages: [line(ASHA, 1, DECK)], more: false };
  },
  readByName: (a) => {
    if (a.name === 'Mom') return { ambiguous: [chat(MOM1, 'Mom', 'dm', '2026-11-13T08:05:00.000Z'), chat(MOM2, 'Mom', 'dm', '2026-11-13T08:02:00.000Z')], total: 2 };
    if (a.name === 'Asha Test') return { chat: ASHA_CHAT, messages: [line(ASHA, 1, DECK)], more: false };
    throw readerError('not_found');
  },
  search: () => ({ hits: [{ chatKey: ASHA, chatName: 'Asha Test', msgKey: `${ASHA}.3EB0A1`, at: '2026-11-13T18:00:00.000Z', fromMe: false, sender: 'Asha Test', snippet: DECK }] }),
  waCalls: () => ({ calls: [missed(1, 'Asha Test', ASHA)] }),
  phoneCalls: () => {
    throw readerError('no_access');
  },
  lastFromMe: () => ({ [ASHA]: null }),
};

const RUN: MorningRun = {
  id: RUN_ID,
  at: NOW,
  trigger: 'now',
  state: 'ok',
  stale: false,
  newestAt: null,
  counts: { chats: 1, messages: 1, calls: 0, todos: 0, replies: 1, callbacks: 0, dropped: 0 },
  dropped: [{ chatName: 'Asha Test', kept: 1, left: 0 }],
  todoIds: [],
};
const DRAFT: Draft = { id: DRAFT_ID, runId: RUN_ID, chatKey: ASHA, chatName: 'Asha Test', phone: ASHA_PHONE, theyAsked: DECK, draft: 'Sending it tonight.', at: NOW, state: 'open' };

/** A morning run that records what it was asked (the real one is Task 12's). */
function fakeMorning(seen: string[]): MorningApi {
  return {
    prefs: () => ({ morningAt: '07:30', callbackAt: '11:00' }),
    setPrefs: (p) => {
      seen.push(`prefs ${JSON.stringify(p)}`);
      return OK;
    },
    run: async (o) => {
      seen.push(`run ${o.trigger}`);
      return { ...RUN, trigger: o.trigger };
    },
    today: () => ({ run: RUN, made: RUN, drafts: [DRAFT], callbacks: [] }),
    setDraft: (id, state) => {
      seen.push(`draft ${id} ${state}`);
      return OK;
    },
    undo: (runId) => {
      seen.push(`undo ${runId}`);
      return OK;
    },
    last: () => RUN,
  };
}

/** The real part with its morning swapped for `morning`. */
function withMorning(svc: MessagesService, morning: MorningApi): MessagesService {
  return new Proxy(svc, {
    get(target, key) {
      if (key === 'morning') return morning;
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** A well-formed value for each `:param` of a messages route. */
function urlOf(def: Pick<RouteDef, 'path'>): string {
  return def.path
    .replace(':chatKey', ASHA)
    .replace(':msgKey', `${ASHA}.3EB0A1`)
    .replace(':runId', RUN_ID)
    .replace(':id', DRAFT_ID);
}

let api: TestApi | undefined;
let messages: MessagesService | undefined;
let reader: FakeReader | null = null;
let base: string | undefined;

afterEach(async () => {
  await reader?.close();
  reader = null;
  await messages?.stop();
  messages = undefined;
  await api?.close();
  api = undefined;
  if (base) rmSync(base, { recursive: true, force: true });
  base = undefined;
});

interface Setup {
  api: TestApi;
  phone: { cookie: string; deviceId: string };
  messagesDir: string;
  seen: string[];
}

/** A daemon with Messages on (unless `on: false`), its part on messages.db in memory, a fake reader when `handlers` are given, and a control phone. */
async function messagesApi(o: { handlers?: FakeHandlers; on?: boolean; dbFile?: (dir: string) => string; shrinker?: ImageShrinker } = {}): Promise<Setup> {
  // A short folder: the reader's socket path must stay under 104 bytes.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'jr-')));
  chmodSync(base, 0o700);
  const home = join(base, 'j');
  mkdirSync(home, { mode: 0o700 });
  const paths = { ...resolvePaths({ env: { HOME: base }, userHome: base, home }), messagesReaderSock: join(base, 'r.sock') };
  const seen: string[] = [];
  const dbFile = o.dbFile?.(base) ?? ':memory:';
  const shrinker = o.shrinker ?? notBuilt<ImageShrinker>('not used here');
  const built = await makeApi({
    ctx: { paths, clock: new FakeClock(NOW), settings: SettingsSchema.parse({ messages: { enabled: o.on !== false } }) },
    deps: (ctx, fakes) => {
      const life = notBuilt<LifeService>('not used here');
      const part = buildMessagesService(ctx, { life, usage: fakes.usage, ccwLegacy: fakes.ccwLegacy }, { dbFile, shrinker });
      messages = withMorning(part, fakeMorning(seen));
      return { messages };
    },
  });
  api = built;
  await messages!.start();
  if (o.handlers) reader = await startFakeReader(paths.messagesReaderSock, o.handlers);
  const phone = await pairCookie(built, ['read', 'control']);
  return { api: built, phone, messagesDir: paths.messagesDir, seen };
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
const ROUTE_LIST = Object.entries(MESSAGES_ROUTES) as [MessagesRouteName, RouteDef][];
const err = (body: string) => ErrorBodySchema.parse(JSON.parse(body)).error;

async function tcp(t: Setup, method: Method, url: string, payload?: unknown, extra: Record<string, string> = {}) {
  return t.api.tcp.inject({ method, url, headers: h(t.phone.cookie, extra), ...(payload !== undefined ? { payload: payload as object } : {}) });
}
async function ctl(t: Setup, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return t.api.ctl.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

describe('the switch', () => {
  it('messages routes answer 403 with the switch sentence when off (all but status)', async () => {
    const t = await messagesApi({ on: false, handlers: READER });
    expect(FEATURE_OFF.messages.message).toBe(MESSAGES_SAYS.off);
    const bad: string[] = [];
    for (const [name, def] of ROUTE_LIST) {
      const method = def.method as Method;
      const body = method === 'GET' || method === 'DELETE' ? undefined : {};
      const r = await tcp(t, method, urlOf(def), body);
      if (name === 'messagesStatus') {
        expect(r.statusCode, r.body).toBe(200);
        expect(MessagesStatusSchema.parse(r.json()).enabled).toBe(false);
        continue;
      }
      if (r.statusCode !== 403 || err(r.body).message !== MESSAGES_SAYS.off) bad.push(`tcp ${name}: ${r.statusCode} ${r.body}`);
      // ctl.sock serves only the routes marked ctl; the rest don't exist there.
      const c = await ctl(t, method, urlOf(def), body);
      if (def.ctl ? c.statusCode !== 403 || err(c.body).message !== MESSAGES_SAYS.off : c.statusCode !== 404) bad.push(`ctl ${name}: ${c.statusCode} ${c.body}`);
    }
    expect(bad).toEqual([]);
    expect(reader!.calls).toEqual([]);
  });

  it('a messages.db that will not open answers 503 with its sentence; the status still answers', async () => {
    const t = await messagesApi({
      handlers: READER,
      dbFile: (dir) => {
        const file = join(dir, 'broken-messages.db');
        writeFileSync(file, 'this is not a database, and it stays as it is', { mode: 0o600 });
        return file;
      },
    });
    // The morning's routes too, whose answers don't come from messages.db here (the pipeline refuses them first).
    for (const url of ['/v1/messages/chats', `/v1/messages/chats/${ASHA}`, '/v1/messages/skip', '/v1/messages/reads', '/v1/messages/today', '/v1/messages/prefs']) {
      const r = await tcp(t, 'GET', url);
      expect(r.statusCode, url).toBe(503);
      expect(err(r.body), url).toEqual({ code: 'messages_unavailable', message: MESSAGES_BROKEN_REASON });
    }
    const st = await ctl(t, 'GET', '/v1/messages/status');
    expect(st.statusCode).toBe(200);
    expect(reader!.calls.filter((c) => c.op !== 'status')).toEqual([]);
  });
});

describe('reading', () => {
  it('reader down → 503 with the down sentence', async () => {
    const t = await messagesApi();
    const urls = [
      '/v1/messages/chats',
      `/v1/messages/chats/${ASHA}`,
      '/v1/messages/by-name?name=Asha%20Test',
      '/v1/messages/search?q=deck',
      `/v1/messages/media/${ASHA}.3EB0A1`,
      '/v1/messages/calls',
    ];
    for (const url of urls) {
      for (const r of [await tcp(t, 'GET', url), await ctl(t, 'GET', url)]) {
        expect(r.statusCode, url).toBe(503);
        expect(err(r.body), url).toEqual({ code: 'messages_unavailable', message: MESSAGES_SAYS.down });
      }
    }
    // Adding a skip asks the reader for the chat's name and kind: down too.
    const add = await tcp(t, 'POST', '/v1/messages/skip', { chatKey: ASHA });
    expect([add.statusCode, err(add.body)]).toEqual([503, { code: 'messages_unavailable', message: MESSAGES_SAYS.down }]);
  });

  it("each reader failure answers its sentence; a chat or a file it doesn't show is 404", async () => {
    let code: Parameters<typeof readerError>[0] = 'no_access';
    const t = await messagesApi({
      handlers: {
        ...READER,
        chats: () => {
          throw readerError(code, 'ChatStorage.sqlite is closed: open WhatsApp');
        },
        media: () => {
          throw readerError(code);
        },
      },
    });
    const says = { no_access: MESSAGES_SAYS.noAccess, unsupported: MESSAGES_SAYS.unsupported, busy: MESSAGES_SAYS.busy, timeout: MESSAGES_SAYS.timeout } as const;
    for (const [c, sentence] of Object.entries(says) as [keyof typeof says, string][]) {
      code = c;
      const r = await ctl(t, 'GET', '/v1/messages/chats');
      expect([r.statusCode, err(r.body)], c).toEqual([503, { code: 'messages_unavailable', message: sentence }]);
    }
    // Skipped or gone: the same 404, never which.
    const unknown = await tcp(t, 'GET', `/v1/messages/chats/${MOM1}`);
    expect([unknown.statusCode, err(unknown.body)]).toEqual([404, { code: 'not_found', message: MESSAGES_SAYS.noChat }]);
    const byName = await tcp(t, 'GET', '/v1/messages/by-name?name=Nobody');
    expect([byName.statusCode, err(byName.body)]).toEqual([404, { code: 'not_found', message: MESSAGES_SAYS.noChat }]);
    code = 'not_found';
    const file = await tcp(t, 'GET', `/v1/messages/media/${ASHA}.3EB0A1`);
    expect([file.statusCode, err(file.body)]).toEqual([404, { code: 'not_found', message: MESSAGES_SAYS.noFile }]);
    code = 'bad_request';
    const big = await tcp(t, 'GET', `/v1/messages/media/${ASHA}.3EB0A1`);
    expect([big.statusCode, err(big.body)]).toEqual([400, { code: 'invalid_request', message: MESSAGES_SAYS.tooBig }]);
  });

  it("no_access says what the reader's detail names: WhatsApp missing, its contact files, the call log, else Full Disk Access", async () => {
    let detail: string | undefined;
    const t = await messagesApi({
      handlers: {
        ...READER,
        chats: () => {
          throw readerError('no_access', detail);
        },
      },
    });
    // The reader's own fixed details (jantar-messages-reader.swift); never shown, only told apart.
    const says: [string | undefined, string][] = [
      ["ChatStorage.sqlite isn't there: is WhatsApp for Mac installed and signed in?", MESSAGES_SAYS.noWhatsAppHere],
      ['macOS refused ContactsV2.sqlite to the reader', MESSAGES_SAYS.contacts],
      ['macOS refused LID.sqlite to the reader', MESSAGES_SAYS.contacts],
      ['macOS refused the iPhone call log to the reader', MESSAGES_SAYS.phoneLog],
      ["the iPhone call log isn't on this Mac", MESSAGES_SAYS.phoneLog],
      ['macOS refused ChatStorage.sqlite to the reader', MESSAGES_SAYS.noAccess],
      [undefined, MESSAGES_SAYS.noAccess],
    ];
    for (const [d, sentence] of says) {
      detail = d;
      const r = await ctl(t, 'GET', '/v1/messages/chats');
      expect([r.statusCode, err(r.body)], d).toEqual([503, { code: 'messages_unavailable', message: sentence }]);
    }
  });

  it('read by ambiguous name lists candidates', async () => {
    const t = await messagesApi({ handlers: READER });
    for (const r of [await tcp(t, 'GET', '/v1/messages/by-name?name=Mom'), await ctl(t, 'GET', '/v1/messages/by-name?name=Mom')]) {
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json() as { ambiguous: Chat[]; total: number };
      expect(Object.keys(body).sort()).toEqual(['ambiguous', 'total']);
      expect(body.total).toBe(2);
      expect(body.ambiguous.map((c) => [c.chatKey, c.name])).toEqual([
        [MOM1, 'Mom'],
        [MOM2, 'Mom'],
      ]);
    }
    expect(reader!.calls.filter((c) => c.op === 'readByName').map((c) => c.args)).toEqual([
      { name: 'Mom', limit: 50 },
      { name: 'Mom', limit: 50 },
    ]);
  });

  it('phone is in owner answers over tcp, never over ctl', async () => {
    const t = await messagesApi({ handlers: READER });
    const overTcp = await tcp(t, 'GET', '/v1/messages/chats');
    expect(MessagesChatsResponseSchema.parse(overTcp.json()).chats[0]).toEqual(ASHA_CHAT);
    const read = await tcp(t, 'GET', `/v1/messages/chats/${ASHA}`);
    expect(MessagesReadResponseSchema.parse(read.json()).chat.phone).toBe(ASHA_PHONE);

    for (const url of ['/v1/messages/chats', `/v1/messages/chats/${ASHA}`, '/v1/messages/by-name?name=Asha%20Test']) {
      const r = await ctl(t, 'GET', url);
      expect(r.statusCode, url).toBe(200);
      expect(r.body, url).not.toContain('"phone"');
      expect(r.body, url).not.toContain(ASHA_PHONE);
    }
    const overCtl = MessagesChatsResponseSchema.parse((await ctl(t, 'GET', '/v1/messages/chats')).json());
    expect(overCtl.chats[0]).toEqual(chat(ASHA, 'Asha Test'));
    expect(overCtl.total).toBe(2);
  });

  it('search, calls and the read log answer through the part; the read log names the phone, the CLI or the MCP caller', async () => {
    const t = await messagesApi({ handlers: READER });
    const mcp = {
      [MESSAGES_CALLER_HEADERS.via]: 'mcp',
      [MESSAGES_CALLER_HEADERS.pid]: '4242',
      [MESSAGES_CALLER_HEADERS.folder]: encodeURIComponent('/synthetic/home/projects/demo app'),
    };
    expect((await ctl(t, 'GET', `/v1/messages/chats/${ASHA}`, undefined, mcp)).statusCode).toBe(200);
    expect((await ctl(t, 'GET', '/v1/messages/search?q=deck')).json()).toMatchObject({ hits: [{ msgKey: `${ASHA}.3EB0A1`, snippet: DECK }] });
    // A phone can't claim to be a Claude session.
    expect((await tcp(t, 'GET', '/v1/messages/calls', undefined, mcp)).json()).toEqual({ calls: [{ ...missed(1, 'Asha Test', ASHA), returned: false }] });
    // A pid that isn't one is left out; the folder still counts.
    const odd = { ...mcp, [MESSAGES_CALLER_HEADERS.pid]: '-3', [MESSAGES_CALLER_HEADERS.folder]: 'plain' };
    expect((await ctl(t, 'GET', '/v1/messages/chats', undefined, odd)).statusCode).toBe(200);

    const reads = await tcp(t, 'GET', '/v1/messages/reads?limit=10');
    expect(reads.statusCode, reads.body).toBe(200);
    expect(MessagesReadsResponseSchema.parse(reads.json()).reads).toEqual([
      { at: NOW, via: 'mcp', folder: 'plain', op: 'chats', count: 2 },
      { at: NOW, via: 'phone', op: 'calls', count: 1 },
      { at: NOW, via: 'cli', op: 'search', count: 1 },
      { at: NOW, via: 'mcp', pid: 4242, folder: 'demo app', op: 'read', chatKey: ASHA, count: 1 },
    ]);
    expect(reads.body).not.toContain(DECK);
    // The read log and the morning screens are the phone's (ctl.sock doesn't serve them).
    expect((await ctl(t, 'GET', '/v1/messages/reads')).statusCode).toBe(404);
  });
});

describe('media', () => {
  /** A reader that copies an image (or a PDF) into its spool, as the real one does. */
  function mediaReader(messagesDir: () => string): FakeHandlers {
    return {
      ...READER,
      media: (a) => {
        const spool = join(messagesDir(), 'spool');
        mkdirSync(spool, { recursive: true, mode: 0o700 });
        const image = String(a.msgKey).endsWith('IMG');
        const file = join(spool, `${image ? 'a' : 'b'}${'0'.repeat(31)}.${image ? 'jpg' : 'pdf'}`);
        writeFileSync(file, image ? JPEG : Buffer.from('%PDF-1.4'), { mode: 0o600 });
        return image
          ? { file, bytes: JPEG.length, kind: 'image', mime: 'image/jpeg' }
          : { file, bytes: 3 * 1024 + 1, kind: 'document', mime: 'application/pdf', fileName: 'invoice.pdf' };
      },
    };
  }
  const shrinker: ImageShrinker = {
    ensure: async () => true,
    image: async (_job, _input, output) => {
      writeFileSync(output, SHRUNK);
      return { ok: true, value: { w: 32, h: 32 } };
    },
  };

  it("an image answers image/jpeg with meetingShot's headers and counts on the device's raw byte budget (not the Mac's)", async () => {
    let dir = '';
    const t = await messagesApi({ handlers: mediaReader(() => dir), shrinker });
    dir = t.messagesDir;
    const url = `/v1/messages/media/${GROUP}.3EB0IMG`;
    const res = await tcp(t, 'GET', url);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.rawPayload.equals(SHRUNK)).toBe(true);
    expect(existsSync(join(dir, 'spool', `a${'0'.repeat(31)}.jpg`))).toBe(false);

    // The device's budget is spent: 429; the Mac's own reads are never counted.
    const left = V03_LIMITS.rawBytes.limit - SHRUNK.length;
    expect(t.api.services.rawBytesBudget.take(`device:${t.phone.deviceId}`, left).ok).toBe(true);
    const limited = await tcp(t, 'GET', url);
    expect([limited.statusCode, err(limited.body).message]).toEqual([429, MESSAGE_FILE_READS_LIMITED]);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    const mac = await ctl(t, 'GET', url);
    expect(mac.statusCode).toBe(200);
    expect(mac.rawPayload.equals(SHRUNK)).toBe(true);
  });

  it('a device whose byte budget is spent is refused before the reader or jantar-media is asked', async () => {
    let dir = '';
    let shrunk = 0;
    const t = await messagesApi({ handlers: mediaReader(() => dir), shrinker: { ensure: shrinker.ensure, image: async (...a) => (shrunk++, shrinker.image(...a)) } });
    dir = t.messagesDir;
    expect(t.api.services.rawBytesBudget.take(`device:${t.phone.deviceId}`, V03_LIMITS.rawBytes.limit).ok).toBe(true);
    const r = await tcp(t, 'GET', `/v1/messages/media/${GROUP}.3EB0IMG`);
    expect([r.statusCode, err(r.body).message]).toEqual([429, MESSAGE_FILE_READS_LIMITED]);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(reader!.calls.filter((c) => c.op === 'media')).toEqual([]);
    expect(shrunk).toBe(0);
    // Nothing was read, so nothing is logged.
    expect((await tcp(t, 'GET', '/v1/messages/reads')).json()).toEqual({ reads: [] });
  });

  it("a file the reader names outside its spool is 503 with the daemon's own sentence", async () => {
    let dir = '';
    const t = await messagesApi({
      handlers: { ...READER, media: () => ({ file: join(dir, `${'c'.repeat(32)}.jpg`), bytes: JPEG.length, kind: 'image', mime: 'image/jpeg' }) },
      shrinker,
    });
    dir = t.messagesDir;
    const r = await ctl(t, 'GET', `/v1/messages/media/${GROUP}.3EB0IMG`);
    expect([r.statusCode, err(r.body)]).toEqual([503, { code: 'messages_unavailable', message: MESSAGES_SAYS.notInSpool }]);
  });

  it("an image jantar-media can't shrink is 503 with its own sentence, not the reader's", async () => {
    let dir = '';
    const t = await messagesApi({ handlers: mediaReader(() => dir), shrinker: { ensure: async () => false, image: shrinker.image } });
    dir = t.messagesDir;
    const res = await tcp(t, 'GET', `/v1/messages/media/${GROUP}.3EB0IMG`);
    expect([res.statusCode, err(res.body)]).toEqual([503, { code: 'messages_unavailable', message: MESSAGES_SAYS.noImage }]);
    expect(existsSync(join(dir, 'spool', `a${'0'.repeat(31)}.jpg`))).toBe(false);
  });

  it('a document is 415 not_an_image with its name and size; its bytes never leave the Mac', async () => {
    let dir = '';
    const t = await messagesApi({ handlers: mediaReader(() => dir), shrinker });
    dir = t.messagesDir;
    const res = await tcp(t, 'GET', `/v1/messages/media/${GROUP}.3EB0DOC`);
    expect([res.statusCode, err(res.body)]).toEqual([415, { code: 'not_an_image', message: 'invoice.pdf, 4 KB: only images can be shown' }]);
    expect(res.body).not.toContain('%PDF');
    expect(notAnImage({ fileName: 'invoice.pdf', bytes: 3 * 1024 + 1, kind: 'document' })).toBe('invoice.pdf, 4 KB: only images can be shown');
    expect(notAnImage({ bytes: 10, kind: 'video' })).toBe('This video, 1 KB: only images can be shown');
    expect(existsSync(join(dir, 'spool', `b${'0'.repeat(31)}.pdf`))).toBe(false);
  });
});

describe('the skip list', () => {
  it('skip remove over tcp is refused, over ctl works', async () => {
    const t = await messagesApi({ handlers: READER });
    const mirror = () => JSON.parse(readFileSync(join(t.messagesDir, 'skip.json'), 'utf8')) as { chatKeys: string[] };
    const add = await tcp(t, 'POST', '/v1/messages/skip', { chatKey: ASHA });
    expect([add.statusCode, add.json()]).toEqual([200, { ok: true }]);
    expect((await tcp(t, 'GET', '/v1/messages/skip')).json()).toEqual({ skip: [{ chatKey: ASHA, name: 'Asha Test', kind: 'dm', addedAt: NOW }] });
    expect(mirror().chatKeys).toEqual([ASHA]);

    const refused = await tcp(t, 'DELETE', `/v1/messages/skip/${ASHA}`);
    expect([refused.statusCode, err(refused.body)]).toEqual([403, { code: 'forbidden', message: MESSAGES_SAYS.skipRemoveMacOnly }]);
    expect(mirror().chatKeys).toEqual([ASHA]);
    expect((await ctl(t, 'GET', '/v1/messages/skip')).json()).toMatchObject({ skip: [{ chatKey: ASHA }] });

    const removed = await ctl(t, 'DELETE', `/v1/messages/skip/${ASHA}`);
    expect([removed.statusCode, removed.json()]).toEqual([200, { ok: true }]);
    expect(mirror().chatKeys).toEqual([]);
    expect((await ctl(t, 'GET', '/v1/messages/skip')).json()).toEqual({ skip: [] });
    const again = await ctl(t, 'DELETE', `/v1/messages/skip/${ASHA}`);
    expect([again.statusCode, err(again.body)]).toEqual([404, { code: 'not_found', message: MESSAGES_SAYS.notSkipped }]);
    // A chat the reader doesn't show can't be added.
    const unknown = await tcp(t, 'POST', '/v1/messages/skip', { chatKey: MOM1 });
    expect([unknown.statusCode, err(unknown.body)]).toEqual([404, { code: 'not_found', message: MESSAGES_SAYS.notAChat }]);
  });
});

describe('the audit', () => {
  it('writes are audited with the target id only', async () => {
    const t = await messagesApi({ handlers: READER });
    expect((await tcp(t, 'POST', '/v1/messages/skip', { chatKey: ASHA })).statusCode).toBe(200);
    expect((await tcp(t, 'PATCH', `/v1/messages/drafts/${DRAFT_ID}`, { state: 'done' })).statusCode).toBe(200);
    const run = await ctl(t, 'POST', '/v1/messages/morning/run', { dryRun: true });
    expect([run.statusCode, (run.json() as MorningRun).trigger]).toEqual([200, 'dry']);
    expect(((await tcp(t, 'POST', '/v1/messages/morning/run', {})).json() as MorningRun).id).toBe(RUN_ID);
    expect((await tcp(t, 'POST', `/v1/messages/morning/${RUN_ID}/undo`)).statusCode).toBe(200);
    expect((await tcp(t, 'PATCH', '/v1/messages/prefs', { morningAt: '07:30' })).statusCode).toBe(200);
    expect((await tcp(t, 'DELETE', `/v1/messages/skip/${ASHA}`)).statusCode).toBe(403);
    expect((await ctl(t, 'DELETE', `/v1/messages/skip/${ASHA}`)).statusCode).toBe(200);
    expect(t.seen).toEqual(['draft ' + DRAFT_ID + ' done', 'run dry', 'run now', `undo ${RUN_ID}`, 'prefs {"morningAt":"07:30"}']);

    const device = `device:${t.phone.deviceId}`;
    const rows = t.api.ctx.db.audit
      .list()
      .filter((a) => a.action.startsWith('messages'))
      .map((a) => ({ actor: a.actor, action: a.action, target: a.target, params: a.params, result: a.result }));
    expect(rows).toEqual([
      { actor: device, action: 'messagesSkipAdd', target: ASHA, params: {}, result: 'ok' },
      { actor: device, action: 'messagesDraftUpdate', target: DRAFT_ID, params: {}, result: 'ok' },
      { actor: 'cli', action: 'messagesMorningRun', target: RUN_ID, params: {}, result: 'ok' },
      { actor: device, action: 'messagesMorningRun', target: RUN_ID, params: {}, result: 'ok' },
      { actor: device, action: 'messagesMorningUndo', target: RUN_ID, params: {}, result: 'ok' },
      { actor: device, action: 'messagesPrefsPatch', target: undefined, params: {}, result: 'ok' },
      { actor: device, action: 'messagesSkipRemove', target: ASHA, params: {}, result: 'refused' },
      { actor: 'cli', action: 'messagesSkipRemove', target: ASHA, params: {}, result: 'ok' },
    ]);
    const all = JSON.stringify(t.api.ctx.db.audit.list());
    for (const said of ['Asha Test', DECK, 'Sending it tonight', ASHA_PHONE]) expect(all).not.toContain(said);
    // GETs are not audited.
    await tcp(t, 'GET', '/v1/messages/today');
    await tcp(t, 'GET', '/v1/messages/chats');
    expect(t.api.ctx.db.audit.list().filter((a) => a.action.startsWith('messages'))).toHaveLength(rows.length);
  });

  it("a phone's Messages writes share Life's per-device write limit (the Mac's CLI doesn't count)", async () => {
    const t = await messagesApi({ handlers: READER });
    const device = `device:${t.phone.deviceId}`;
    while (t.api.services.lifeWriteLimiter.hit(device).ok);
    const r = await tcp(t, 'PATCH', `/v1/messages/drafts/${DRAFT_ID}`, { state: 'done' });
    expect([r.statusCode, err(r.body).message]).toEqual([429, ASK_WRITES_LIMITED]);
    expect(t.seen).toEqual([]);
    expect((await ctl(t, 'POST', '/v1/messages/morning/run', {})).statusCode).toBe(200);
  });

  it("the morning's screens answer through the part: today, prefs", async () => {
    const t = await messagesApi({ handlers: READER });
    expect((await tcp(t, 'GET', '/v1/messages/today')).json()).toEqual({ run: RUN, made: RUN, drafts: [DRAFT], callbacks: [] });
    expect((await tcp(t, 'GET', '/v1/messages/prefs')).json()).toEqual({ morningAt: '07:30', callbackAt: '11:00' });
  });
});

describe('owner only', () => {
  it('every messages route is a control route on his host, never under her prefix', () => {
    for (const [name, def] of ROUTE_LIST) {
      expect(def.scope, name).toBe('control');
      expect(def.path.startsWith('/v1/messages/'), name).toBe(true);
    }
  });

  it('a person (People) device gets 403/404 on every messages route, with Messages on', async () => {
    const f = await makeFixture();
    try {
      await f.api.ctx.settings.patch({ messages: { enabled: true } });
      const her = [f.asha.cookie, f.asha.secretOnly, f.asha.full, f.asha.revoked, f.eli.oldCookie];
      const bad: string[] = [];
      for (const [name, def] of ROUTE_LIST) {
        for (const cred of her) {
          // Her host: nothing of his exists.
          const there = await callAs(f.api, def, { host: PEOPLE_HOST, cred, origin: PEOPLE_ORIGIN, path: urlOf(def), body: {} });
          if (there.status !== 404 || there.body !== '') bad.push(`${name} her host ${cred.name}: ${there.status}`);
          // His hosts: her credential is no credential.
          for (const [host, origin] of [
            [OWNER_HOST, OWNER_ORIGIN],
            [LOOPBACK_HOST, LOOPBACK_ORIGIN],
          ] as const) {
            const bare = await callAs(f.api, def, { host, cred: NONE, origin, path: urlOf(def), body: {} });
            const r = await callAs(f.api, def, { host, cred, origin, path: urlOf(def), body: {} });
            if (r.status !== bare.status || r.body !== bare.body || ![401, 403, 404].includes(r.status)) bad.push(`${name} ${host} ${cred.name}: ${r.status} vs ${bare.status}`);
          }
        }
      }
      expect(bad).toEqual([]);
    } finally {
      await f.close();
    }
  }, 60_000);
});
