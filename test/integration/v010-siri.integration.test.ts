/**
 * v0.10 the Siri door's wait (spec 0.10 B11.4): tailscale mode with an
 * https public address, a chat key made over ctl.sock, and the fake claude
 * answering after the door's 20 s: the door says "Still working on it. The
 * answer will be in Jantar." and the turn keeps running; when it ends, one
 * Web Push "Your answer is in Chat." (no text of the answer) goes to the
 * phone, and the answer is in the thread. A voice delete is a card.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHAT_MARKER, chatText, perfBudgetMs, setFakeClaude } from '@jantar/fixtures';
import { CAPTURE_KEY_HEADER, CHAT_VOICE_WAIT_MS, DEVICE_COOKIE, type ChatKeyAddReply, type ChatList, type PairStartResponse } from '@jantar/protocol';
import { callDaemon, createCtlClient, defaultDeps, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret } from './http.js';


const LIFE = { todos: true, places: true, timezone: 'UTC', currency: 'INR' };
const PUBLIC = 'https://jantar.example.com';
const PUBLIC_HOST = 'jantar.example.com';
const PHONE_PUSH = 'https://fcm.googleapis.com/fcm/send/synthetic-chat-phone';
const KEYS = { p256dh: 'BSyntheticP256dhKeyForTheChatRun', auth: 'synthetic-auth' };

describe('v0.10 the Siri door: the 20 s wait, then a push', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let phone = '';
  let key = '';

  beforeAll(async () => {
    // The remote mode is patched after boot: the harness's own `remote.port` (never the real daemon's) stays.
    d = await bootDaemon({ home: { sessions: [] }, settings: { life: LIFE, ask: { enabled: true } } });
    await d.ctx.settings.patch({ remote: { mode: 'tailscale', publicUrl: PUBLIC } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'Example phone', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'Example phone' } });
    phone = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(phone, claim.body);
    const sub = await http(d.port, 'POST', '/v1/push/subscribe', { cookie: phone, body: { subscription: { endpoint: PHONE_PUSH, keys: KEYS } } });
    expect(sub.status, sub.text).toBeLessThan(300);
    key = (await callDaemon<ChatKeyAddReply>(ctl, 'POST', '/v1/chat/keys', {})).key;
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    await d?.stop();
  }, perfBudgetMs(30_000));

  const ask = (text: string) =>
    http(d.port, 'POST', '/v1/capture/chat', { origin: null, body: { text }, headers: { host: PUBLIC_HOST, [CAPTURE_KEY_HEADER]: key }, timeoutMs: perfBudgetMs(60_000) });

  it('a slow answer: "Still working" within the wait, then one push with no text, and the answer in the thread', async () => {
    await setFakeClaude(d.home, { slowMs: CHAT_VOICE_WAIT_MS + 2_000 });
    const started = Date.now();
    const r = await ask(chatText('chat-slow', `how am I doing ${CHAT_MARKER}`));
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ message: 'Still working on it. The answer will be in Jantar.' });
    expect(Date.now() - started).toBeLessThan(CHAT_VOICE_WAIT_MS + perfBudgetMs(8_000));
    const push = await eventually(async () => d.webPushes.find((p) => p.endpoint === PHONE_PUSH && p.payload.includes('Your answer is in Chat.')) ?? null, perfBudgetMs(60_000), 'the answer push');
    expect(JSON.parse(push.payload)).toMatchObject({ title: 'Jantar', body: 'Your answer is in Chat.', url: '/chat', tag: 'chat:answer' });
    expect(push.payload).not.toContain(CHAT_MARKER);
    expect(push.payload).not.toContain('Here is what I found');
    const thread = (await http(d.port, 'GET', '/v1/chat', { cookie: phone })).body as ChatList;
    expect(thread.turns.at(-1)).toMatchObject({ via: 'voice', state: 'done' });
    expect(thread.turns.at(-1)?.reply).toMatch(/^Here is what I found/);
  }, perfBudgetMs(120_000));

  it('a delete by voice is a card, never a delete', async () => {
    await setFakeClaude(d.home, {});
    const made = await http(d.port, 'POST', '/v1/todos', { cookie: phone, body: { title: 'Call the bank' }, headers: { 'idempotency-key': 'k-siri-todo' } });
    expect(made.status).toBe(200);
    const r = await ask(chatText('chat-delete', 'delete the bank todo'));
    expect(r.body).toEqual({ message: 'I asked you to confirm the delete. 1 to confirm in Jantar.' });
    const todos = (await http(d.port, 'GET', '/v1/todos', { cookie: phone })).body as { todos: Array<{ title: string }> };
    expect(todos.todos.map((t) => t.title)).toContain('Call the bank');
  }, perfBudgetMs(60_000));

  it('jantar chat status names the door and its key', async () => {
    const io = memoryIo(d.home.env);
    expect(await main(['chat', 'status'], { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } })).toBe(0);
    expect(io.stdout).toContain(`Siri door: POST ${PUBLIC}/v1/capture/chat, 1 Siri key`);
  });
});
