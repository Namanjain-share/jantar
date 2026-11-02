/**
 * v0.10 Chat and the Siri door end to end (spec 0.10 B15): jantard
 * in-process on a synthetic HOME with the production wiring (harness.ts),
 * every Life part and the Intel shelf on in UTC, the fake home's sessions on
 * the board, a phone paired with control and admin (its event stream open
 * from the start), `jantar` (main() from packages/cli) on the real
 * ctl.sock, and the fake claude (through the fake cswap) in its Chat modes:
 * it starts the real bridge (assets/chat/bridge.mjs), which reaches the
 * daemon's real dispatcher. Nothing runs claude, cswap or osascript for
 * real, and nothing leaves the Mac.
 *
 * 0. Off: the phone is told `jantar chat on`; that command turns it on.
 * 1. A turn reads across modules: today, todos, cafés, money, sessions and
 *    usage in one run, each tool answering with the item's own words.
 * 2. A turn writes with Undo: a todo added, a café rated and a visit
 *    logged, in life.db at once; Undo from the phone puts each back.
 * 2b. A run's writes share the sender's Life write limit (240 a minute)
 *    with its own routes: a tablet's 239 writes and its message leave no
 *    room, and each of the run's writes is refused.
 * 3. Deletes need the user's Confirm: Chat has no delete tool, only a card;
 *    the item stays until the tap, which deletes it.
 * 4. Chat never reaches a session-writing route: the run's tools are
 *    jantar's own by exact name with no built-in tool; tools called
 *    outside the turn's list (send_prompt, pending_decide, settings_patch,
 *    session_key) are refused by the dispatcher; the terminal is never
 *    typed into and no session route is audited.
 * 5. An init line with an extra built-in tool aborts the run before any
 *    call, nothing written.
 * 6. A photo uploaded, sniffed, re-encoded by the fake sips to 1568 px and
 *    sent as one image block.
 * 7. The Siri door: a chat key made over ctl.sock answers with the spoken
 *    reply and the daemon's count sentence; a capture (save door) key is
 *    refused on it (401), a chat key on the save door too; Origin 403; 404
 *    with Chat off.
 * 8. The marker sweep: CHAT_MARKER planted in todos and a café, copied
 *    into a reply by the fake, never in a log line, an audit row, an event,
 *    a WS frame or a write reply.
 * 9. A restart keeps the thread; Clear empties chat.db and the photos.
 */
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHAT_MARKER, chatRuns, chatText, claudeCalls, makePng, perfBudgetMs, setFakeClaude } from '@jantar/fixtures';
import {
  CAPTURE_KEY_HEADER,
  DEVICE_COOKIE,
  eventsSocketProtocols,
  type CaptureKeyAddReply,
  type ChatKeyAddReply,
  type ChatList,
  type ChatTurn,
  type PairStartResponse,
  type PlaceDetail,
  type TodosResponse,
} from '@jantar/protocol';
import { callDaemon, createCtlClient, defaultDeps, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret, type HttpResult } from './http.js';

const daemonRequire = createRequire(new URL('../../packages/daemon/package.json', import.meta.url));
interface WsClient {
  on(ev: 'message', fn: (data: unknown) => void): void;
  on(ev: 'error', fn: (e: Error) => void): void;
  once(ev: 'open', fn: () => void): void;
  close(): void;
}
const WebSocket = createRequire(daemonRequire.resolve('@fastify/websocket'))('ws') as new (url: string, protocols: string[], opts: { headers: Record<string, string> }) => WsClient;

const LIFE = { todos: true, medicines: true, food: true, places: true, finance: true, posts: true, timezone: 'UTC', currency: 'INR' };
const PUBLIC = 'https://jantar.example.com';
const PUBLIC_HOST = 'jantar.example.com';
/** Routes that would type into a session, decide a prompt, drive a terminal or change settings: never audited here. */
const SESSION_WRITES = ['sendPrompt', 'decidePending', 'focusSession', 'sessionKey', 'sessionMode', 'sessionCommand', 'sessionDialog', 'sessionKeypad', 'uploadCreate', 'launchStart', 'launchAnswer', 'patchSettings', 'rewriteStart'];

describe('v0.10 Chat through jantard: the phone, the Siri door, the fake claude and the bridge', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let phone = '';
  let ws: WsClient | null = null;
  const frames: string[] = [];
  const writes: Array<{ what: string; text: string }> = [];
  let cafeId = '';
  let todoId = '';

  const dumpLog = () =>
    d?.log.records
      .filter((r) => r.level === 'warn' || r.level === 'error')
      .slice(-20)
      .map((r) => `${r.level} ${r.msg} ${JSON.stringify(r.fields)}`)
      .join('\n');

  async function call(method: string, path: string, body?: unknown, extra: Parameters<typeof http>[3] = {}): Promise<HttpResult> {
    const r = await http(d.port, method, path, { cookie: phone, headers: method === 'GET' ? {} : { 'idempotency-key': `k-${randomUUID()}` }, ...(body === undefined ? {} : { body }), ...extra });
    if (method !== 'GET') writes.push({ what: `${method} ${path}`, text: r.text });
    return r;
  }
  async function ok<T>(method: string, path: string, body?: unknown, extra?: Parameters<typeof http>[3]): Promise<T> {
    const r = await call(method, path, body, extra);
    expect(r.status, `${method} ${path}: ${r.text}\n${dumpLog()}`).toBeLessThan(300);
    return r.body as T;
  }
  async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const io = memoryIo(d.home.env);
    const code = await main(argv, { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } });
    return { code, out: io.stdout, err: io.stderr };
  }
  async function pair(name: string, scopes: string[]) {
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name, scopes });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name } });
    expect(claim.status, claim.text).toBe(200);
    const cookie = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(cookie, claim.body);
    return { cookie, secret: (claim.body as { deviceSecret: string }).deviceSecret };
  }
  /** Send and wait until the turn has ended. */
  async function chat(text: string, photos: string[] = []): Promise<ChatTurn> {
    const { id } = await ok<{ id: string }>('POST', '/v1/chat', photos.length ? { text, photos } : { text });
    return eventually(
      async () => {
        const t = (await ok<ChatList>('GET', '/v1/chat')).turns.find((x) => x.id === id);
        return t && t.state !== 'queued' && t.state !== 'running' ? t : null;
      },
      perfBudgetMs(30_000),
      `the answer to "${text}"`,
    );
  }
  const lastRun = async () => (await chatRuns(d.home)).at(-1);
  const chatClaudeCalls = async () => (await claudeCalls(d.home)).filter((c) => c.args.some((a) => a.endsWith('chat-v1.md')));
  const todoTitles = async () => (await ok<TodosResponse>('GET', '/v1/todos')).todos.map((t) => t.title);

  beforeAll(async () => {
    d = await bootDaemon({ settings: { life: LIFE, intel: { enabled: true, read: false } } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const p = await pair('Example phone', ['read', 'control', 'admin']);
    phone = p.cookie;
    const socket = new WebSocket(`ws://127.0.0.1:${d.port}/v1/events`, eventsSocketProtocols(p.secret), { headers: { origin: `http://127.0.0.1:${d.port}`, cookie: phone } });
    socket.on('message', (data) => frames.push(String(data)));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.on('error', reject);
    });
    ws = socket;
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    ws?.close();
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('0. off: the phone is told the command; jantar chat on turns Chat on', async () => {
    const off = await http(d.port, 'GET', '/v1/chat', { cookie: phone });
    expect(off.status).toBe(403);
    expect((off.body as { error: { message: string } }).error.message).toBe('Chat is off. Turn it on at your Mac: jantar chat on');
    const on = await cli('chat', 'on');
    expect(on.code, on.err).toBe(0);
    expect(on.out).toContain('Chat is on. The phone shows Chat.');
    expect((await ok<ChatList>('GET', '/v1/chat')).ready).toEqual({ ok: true });
    // Seed Life from the phone, with the marker in two notes (only the owner's thread may ever show it).
    todoId = (await ok<{ id: string }>('POST', '/v1/todos', { title: 'Call the bank', notes: `about the card ${CHAT_MARKER}` })).id;
    cafeId = (await ok<{ id: string }>('POST', '/v1/places', { name: 'Sample Dosa House', area: 'Synthetic Street', tags: ['wifi'], notes: `quiet mornings ${CHAT_MARKER}` })).id;
    await ok('POST', '/v1/money', { kind: 'expense', amount: 25000, category: 'Food', note: 'lunch', day: (await ok<{ day: string }>('GET', '/v1/life/today')).day });
  });

  it('1. one turn reads across modules: todos, cafés, money, sessions and usage', async () => {
    const t = await chat(chatText('chat-read', 'how am I doing'));
    expect(t.state, `${t.reason}\n${dumpLog()}`).toBe('done');
    expect(t.changes).toEqual([]);
    expect(t.cards).toEqual([]);
    const run = await lastRun();
    expect(run?.calls.map((c) => [c.name, c.isError])).toEqual([
      ['today', false],
      ['todos_find', false],
      ['places_find', false],
      ['money_month', false],
      ['sessions_find', false],
      ['accounts_usage', false],
    ]);
    const text = (name: string) => run?.calls.find((c) => c.name === name)?.text ?? '';
    expect(text('todos_find')).toContain('Call the bank');
    expect(text('places_find')).toContain('Sample Dosa House');
    expect(text('places_find')).toContain('Wi-Fi');
    expect(text('money_month')).toContain('spent 250');
    expect(text('sessions_find')).toMatch(/\d+ sessions? \(read only\)/);
    expect(text('sessions_find')).not.toContain(d.home.home);
  });

  it('2. one turn writes with Undo: a todo added, a café rated, a visit logged; Undo puts each back', async () => {
    const t = await chat(chatText('chat-write', 'add oat milk and rate the dosa place'));
    expect(t.state, `${t.reason}\n${dumpLog()}`).toBe('done');
    expect(t.changes.map((c) => [c.module, c.op, c.state, c.undoable])).toEqual([
      ['todos', 'add', 'done', true],
      ['places', 'edit', 'done', true],
      ['places', 'log', 'done', true],
    ]);
    expect(await todoTitles()).toContain('Buy oat milk');
    const rated = await ok<PlaceDetail>('GET', `/v1/places/${cafeId}`);
    expect(rated.place).toMatchObject({ stars: 4, ratings: { work: 5 }, tried: true });
    expect(rated.visits).toHaveLength(1);

    await ok('POST', `/v1/chat/turns/${t.id}/changes/2/undo`);
    await ok('POST', `/v1/chat/turns/${t.id}/changes/1/undo`);
    await ok('POST', `/v1/chat/turns/${t.id}/changes/0/undo`);
    expect(await todoTitles()).not.toContain('Buy oat milk');
    const back = await ok<PlaceDetail>('GET', `/v1/places/${cafeId}`);
    expect(back.place.stars).toBeUndefined();
    expect(back.place.tried).toBe(false);
    expect(back.visits).toEqual([]);
    const after = (await ok<ChatList>('GET', '/v1/chat')).turns.find((x) => x.id === t.id);
    expect(after?.changes.map((c) => c.state)).toEqual(['undone', 'undone', 'undone']);
    // A second Undo is a conflict, with the Mac's sentence.
    const again = await call('POST', `/v1/chat/turns/${t.id}/changes/0/undo`);
    expect(again.status).toBe(409);
  });

  it("2b. a run's writes share the sender's Life write limit with its own routes: past 240 a minute they are refused", async () => {
    // Another device, so the phone keeps its own minute: 239 Life writes from its screens, then its message (the 240th).
    const tablet = (await pair('Example tablet', ['read', 'control'])).cookie;
    const put = (path: string, body: unknown) => http(d.port, path === '/v1/chat' ? 'POST' : 'PUT', path, { cookie: tablet, body, headers: { 'idempotency-key': `k-${randomUUID()}` } });
    for (let i = 0; i < 239; i++) {
      const r = await put('/v1/food/targets', { kcalTarget: 2000 });
      expect(r.status, r.text).toBe(200);
    }
    const sent = await put('/v1/chat', { text: chatText('chat-write', 'add oat milk and rate the dosa place') });
    expect(sent.status, sent.text).toBe(202);
    const id = (sent.body as { id: string }).id;
    const t = await eventually(
      async () => {
        const x = (await ok<ChatList>('GET', '/v1/chat')).turns.find((y) => y.id === id);
        return x && x.state !== 'queued' && x.state !== 'running' ? x : null;
      },
      perfBudgetMs(30_000),
      "the tablet's answer",
    );
    expect(t.state, `${t.reason}\n${dumpLog()}`).toBe('done');
    expect(t.changes).toEqual([]);
    expect(t.refused).toBe(3);
    expect((await lastRun())?.calls.filter((c) => c.isError).map((c) => [c.name, c.text])).toEqual([
      ['todo_add', 'Limit reached for this message.'],
      ['place_edit', 'Limit reached for this message.'],
      ['visit_log', 'Limit reached for this message.'],
    ]);
    expect(await todoTitles()).not.toContain('Buy oat milk');
    expect((await ok<PlaceDetail>('GET', `/v1/places/${cafeId}`)).visits).toEqual([]);
    // The tablet's own next write is over the limit too; the phone's minute is its own.
    expect((await put('/v1/food/targets', { kcalTarget: 2000 })).status).toBe(429);
  });

  it('3. deletes need Confirm: no delete tool, a card only; the item stays until the tap', async () => {
    const [run] = (await chatClaudeCalls()).slice(-1);
    const allowed = run?.args[(run?.args.indexOf('--allowedTools') ?? -2) + 1]?.split(',') ?? [];
    expect(allowed).toContain('mcp__jantar__request_delete');
    expect(allowed.filter((n) => /delete|remove/.test(n) && n !== 'mcp__jantar__request_delete')).toEqual([]);

    const t = await chat(chatText('chat-delete', 'delete the bank todo'));
    expect(t.state).toBe('done');
    expect(t.changes).toEqual([]);
    expect(t.cards).toEqual([expect.objectContaining({ kind: 'confirm', module: 'todos', op: 'delete', state: 'waiting', label: 'Delete todo Call the bank?' })]);
    expect(await todoTitles()).toContain('Call the bank');
    await ok('POST', `/v1/chat/turns/${t.id}/cards/0`);
    expect(await todoTitles()).not.toContain('Call the bank');
    const done = (await ok<ChatList>('GET', '/v1/chat')).turns.find((x) => x.id === t.id);
    expect(done?.cards[0]?.state).toBe('done');
    void todoId;
  });

  it('4. Chat never reaches a session-writing route', async () => {
    const t = await chat(chatText('chat-bypass', 'type yes into my session'));
    expect(t.state).toBe('done');
    expect(t.refused).toBe(4);
    expect((await lastRun())?.calls.map((c) => [c.name, c.isError, c.text])).toEqual([
      ['send_prompt', true, 'Not a tool of this turn.'],
      ['pending_decide', true, 'Not a tool of this turn.'],
      ['settings_patch', true, 'Not a tool of this turn.'],
      ['session_key', true, 'Not a tool of this turn.'],
    ]);
    // Every run: no built-in tool, one strict MCP server, jantar's own tools by exact name, none of them a session write.
    for (const c of await chatClaudeCalls()) {
      expect(c.args[c.args.indexOf('--tools') + 1]).toBe('');
      expect(c.args).toContain('--strict-mcp-config');
      expect(c.args).not.toContain('--disallowedTools');
      const allowed = c.args[c.args.indexOf('--allowedTools') + 1]?.split(',') ?? [];
      for (const n of allowed) expect(n).toMatch(/^mcp__jantar__[a-z_]+$/);
      expect(allowed.filter((n) => /send|prompt|decide|keypad|session_key|launch|settings/.test(n))).toEqual([]);
    }
    expect(d.terminal.events.typed).toEqual([]);
    expect(d.terminal.events.enters).toEqual([]);
    // Only the user's own `jantar chat on` (the CLI, actor cli) ever patched settings; nothing else here wrote to a session.
    const audited = new Set(d.ctx.db.audit.list({ limit: 5000 }).filter((a) => a.actor !== 'cli').map((a) => a.action));
    for (const route of SESSION_WRITES) expect(audited.has(route), route).toBe(false);
  });

  it('5. an init line with Bash aborts the run before any call', async () => {
    const before = (await todoTitles()).length;
    const t = await chat(chatText('chat-init-bash'));
    expect(t).toMatchObject({ state: 'failed', reason: 'Chat stopped: it could not run in its safe mode on this Mac. Check it at the Mac: jantar doctor', changes: [], cards: [] });
    expect((await todoTitles()).length).toBe(before);
    const row = d.ctx.db.audit.list({ limit: 5000 }).filter((a) => a.action === 'chat.run').at(-1);
    expect(row?.params).toMatchObject({ outcome: 'not_isolated', toolCalls: 0 });
  });

  it('6. a photo: uploaded raw, re-encoded by sips to 1568 px, sent as one image block', async () => {
    const up = await call('POST', '/v1/chat/photos', undefined, { raw: makePng(3000, 2000) });
    expect(up.status, up.text).toBe(200);
    const id = (up.body as { id: string }).id;
    const t = await chat(chatText('chat-photos', 'what is this'), [id]);
    expect(t.state).toBe('done');
    expect(t.photos).toEqual([{ id, w: 1568, h: 1045, gone: false }]);
    expect(t.reply).toBe('I see 1 photos. Photo 1 of 1 from the user.');
    const img = await http(d.port, 'GET', `/v1/chat/photos/${id}`, { cookie: phone });
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    // The run never got a path.
    const [run] = (await chatClaudeCalls()).slice(-1);
    expect(JSON.stringify(run?.stdin ?? '')).not.toContain(d.ctx.paths.chatDir);
  });

  it('7. the Siri door: a chat key answers with the count sentence; a capture key is refused; Origin 403; 404 with Chat off', async () => {
    await d.ctx.settings.patch({ remote: { mode: 'tailscale', publicUrl: PUBLIC } });
    const chatKey = await callDaemon<ChatKeyAddReply>(ctl, 'POST', '/v1/chat/keys', { name: 'iphone' });
    expect(chatKey.chatUrl).toBe(`${PUBLIC}/v1/capture/chat`);
    const saveKey = await callDaemon<CaptureKeyAddReply>(ctl, 'POST', '/v1/intel/capture-keys', { name: 'iphone' });
    const door = (path: string, key: string, body: unknown, extra: Record<string, string> = {}, origin: string | null = null) =>
      http(d.port, 'POST', path, { origin, body, headers: { host: PUBLIC_HOST, [CAPTURE_KEY_HEADER]: key, ...extra }, timeoutMs: perfBudgetMs(30_000) });

    const wrong = await door('/v1/capture/chat', saveKey.key, { text: 'How many calories today?' });
    expect(wrong.status).toBe(401);
    expect((wrong.body as { message: string }).message).toBe('This needs a Jantar Siri key. Make one at the Mac: jantar chat shortcut add');
    expect((await door('/v1/capture/save', chatKey.key, { text: 'https://example.com/a' })).status).toBe(401);
    expect((await door('/v1/capture/chat', chatKey.key, { text: 'hello' }, {}, 'https://example.com')).status).toBe(403);

    const spoken = await door('/v1/capture/chat', chatKey.key, { text: chatText('chat-write', 'by voice') });
    expect(spoken.status, spoken.text).toBe(200);
    expect(spoken.body).toEqual({ message: 'Done. todo added, cafe rated, visit logged. Added 2 and changed 1. Undo is in Jantar.' });
    const voiceTurn = (await ok<ChatList>('GET', '/v1/chat')).turns.at(-1);
    expect(voiceTurn?.via).toBe('voice');
    const row = d.ctx.db.audit.list({ limit: 5000 }).filter((a) => a.action === 'capture.chat').at(-1);
    expect(row?.params).toMatchObject({ keyId: chatKey.id, outcome: 'answered' });
    expect(JSON.stringify(row)).not.toContain(chatKey.key);

    expect((await cli('chat', 'off')).code).toBe(0);
    expect((await door('/v1/capture/chat', chatKey.key, { text: 'hello' })).status).toBe(404);
    expect((await cli('chat', 'on')).code).toBe(0);
    await d.ctx.settings.patch({ remote: { mode: 'loopback', publicUrl: null } });
  });

  it('8. the marker reaches the owner thread only: never a log line, an audit row, an event, a frame or a write reply', async () => {
    await ok('POST', '/v1/todos', { title: `Read the synthetic note ${CHAT_MARKER}` });
    const t = await chat(chatText('chat-marker', 'show me everything'));
    expect(t.state, t.reason).toBe('done');
    expect(t.reply).toContain(CHAT_MARKER);
    expect(JSON.stringify(d.log.records)).not.toContain(CHAT_MARKER);
    expect(JSON.stringify(d.ctx.db.audit.list({ limit: 5000 }))).not.toContain(CHAT_MARKER);
    expect(JSON.stringify(d.ctx.db.events.since(0, { limit: 100_000 }))).not.toContain(CHAT_MARKER);
    expect(frames.join('\n')).not.toContain(CHAT_MARKER);
    for (const w of writes) expect(w.text, w.what).not.toContain(CHAT_MARKER);
  });

  it('9. a restart keeps the thread; Clear empties chat.db and the photo folder', async () => {
    const before = (await ok<ChatList>('GET', '/v1/chat')).turns.length;
    expect(before).toBeGreaterThan(5);
    await d.restart();
    const after = await ok<ChatList>('GET', '/v1/chat');
    expect(after.turns.length).toBe(before);
    expect(after.turns.every((x) => x.state !== 'running' && x.state !== 'queued')).toBe(true);
    await ok('DELETE', '/v1/chat');
    expect((await ok<ChatList>('GET', '/v1/chat')).turns).toEqual([]);
    const photos = await readdir(join(d.ctx.paths.chatDir, 'photos')).catch(() => []);
    expect(photos).toEqual([]);
    const st = await cli('chat', 'status');
    expect(st.out).toContain('On disk: 0 messages, 0 photos');
  });

  it('the setup: the fake claude ran each Chat turn through cswap on the fake home', async () => {
    await setFakeClaude(d.home, {});
    const runs = await chatClaudeCalls();
    expect(runs.length).toBeGreaterThanOrEqual(8);
    expect(runs.every((r) => r.via === 'cswap')).toBe(true);
  });
});
