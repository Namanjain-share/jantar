/**
 * v0.10 the Siri door (spec 0.10 B11): `POST /v1/capture/chat` with a chat
 * key, and its keys. Synthetic values only.
 *
 * - 404 unless TLS mode with an https address, Chat on and an active chat
 *   key; Origin 403; a missing, malformed or wrong-scope key is 401 and
 *   counted by the shared bad-key limiter, both ways (a capture key on the
 *   Siri door, a chat key on the save door);
 * - the reply is what the Chat part says (spoken, later, busy), with a
 *   top-level `message` on every error; 10 a minute per key; read-only 403;
 *   chat.db broken 503;
 * - the keys: made, listed and revoked over ctl.sock only, shown once, only
 *   their prefixed hash stored, kept apart from the save door's keys.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CAPTURE_KEY_HEADER, CaptureKeyAddReplySchema, ChatKeyAddReplySchema, ROUTES, SettingsSchema, type IntelReadReply, type Settings } from '@jantar/protocol';
import type { ChatService, IntelService, LifeResult } from '../../src/contracts.js';
import { CHAT_KEY_REFUSED, CHAT_VOICE_LIMITED, captureDoorOpen } from '../../src/api/app.js';
import { hashChatKey } from '../../src/auth/capture-keys.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { HOST, makeApi, type TestApi } from './fakes.js';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

const PUBLIC = 'https://jantar.example.com';
const PUBLIC_HOST = 'jantar.example.com';

function settingsFor(mode: Settings['remote']['mode'], over: { chat?: boolean } = {}): Settings {
  return SettingsSchema.parse({
    ask: { enabled: over.chat ?? true },
    intel: { enabled: true },
    remote: { mode, ...(mode === 'cloudflare' || mode === 'tailscale' ? { publicUrl: PUBLIC } : {}) },
  });
}

/** The Chat part as the door sees it: voice() answers `next` and records what it was asked. */
function fakeChat() {
  const calls: Array<{ text: string; actor: unknown; waitMs: number }> = [];
  let next: Awaited<ReturnType<ChatService['voice']>> = { message: 'You ate 1830 calories today. Added 1. Undo is in Jantar.', outcome: 'answered', turnId: '01JTURN0000000000000000001' };
  let broken: string | null = null;
  const chat = notBuilt<ChatService>('Chat', {
    start: async () => {},
    stop: async () => {},
    broken: () => broken,
    voice: async (text, actor, waitMs) => {
      calls.push({ text, actor, waitMs });
      return next;
    },
  });
  return {
    chat,
    calls,
    answer(r: typeof next) {
      next = r;
    },
    setBroken(b: string | null) {
      broken = b;
    },
  };
}

const intel = notBuilt<IntelService>('Intel', {
  start: async () => {},
  stop: async () => {},
  read: async (): Promise<LifeResult<IntelReadReply>> => ({ ok: true, value: { id: 'captures:01JFZ8X8Y3T0V5G9WQK2M4N6PR', duplicate: false, queued: true, message: 'Saved.' } }),
});

async function doorApi(settings: Settings, opts: { readOnly?: boolean } = {}) {
  const f = fakeChat();
  api = await makeApi({ ctx: { settings }, deps: () => ({ chat: f.chat, intel }), ...(opts.readOnly ? { api: { mode: { readOnly: true, terminal: 'terminal-app' } } } : {}) });
  return f;
}

async function chatKey(t: TestApi) {
  const res = await t.ctl.inject({ method: 'POST', url: ROUTES.chatKeyAdd.path, payload: {} });
  expect(res.statusCode, res.body).toBe(200);
  return ChatKeyAddReplySchema.parse(res.json());
}
async function saveKey(t: TestApi) {
  const res = await t.ctl.inject({ method: 'POST', url: ROUTES.captureKeyAdd.path, payload: {} });
  expect(res.statusCode, res.body).toBe(200);
  return CaptureKeyAddReplySchema.parse(res.json());
}

function door(t: TestApi, path: string, headers: Record<string, string | undefined> = {}, payload: unknown = { text: 'How many calories today?' }) {
  const all: Record<string, string> = { host: PUBLIC_HOST, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' };
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) delete all[k];
    else all[k] = v;
  }
  return t.tcp.inject({ method: 'POST', url: path, headers: all, payload: JSON.stringify(payload) });
}
const ask = (t: TestApi, key: string, extra: Record<string, string | undefined> = {}, payload?: unknown) => door(t, ROUTES.captureChat.path, { [CAPTURE_KEY_HEADER]: key, ...extra }, payload);

describe('v0.10 the Siri door exists only in a TLS mode with Chat on and a chat key', () => {
  it('loopback and lan: 404; no chat key: 404; Chat off: 404', async () => {
    for (const mode of ['loopback', 'lan'] as const) {
      await api?.close();
      const f = await doorApi(settingsFor(mode));
      const { key, chatUrl } = await chatKey(api);
      expect(chatUrl).toBeNull();
      const res = await ask(api, key, mode === 'loopback' ? { host: HOST } : {});
      expect(res.statusCode, mode).toBe(404);
      expect(f.calls).toHaveLength(0);
    }
    await api?.close();
    await doorApi(settingsFor('tailscale'));
    expect((await ask(api, `jchat_${'A'.repeat(43)}`)).statusCode).toBe(404);
    const { key, chatUrl } = await chatKey(api);
    expect(chatUrl).toBe(`${PUBLIC}/v1/capture/chat`);
    expect(captureDoorOpen(api.services, 'chat')).toBe(true);
    expect((await ask(api, key)).statusCode).toBe(200);
    await api.ctx.settings.patch({ ask: { enabled: false } });
    expect((await ask(api, key)).statusCode).toBe(404);
  });
});

describe('v0.10 the Siri door: keys, Origin, answers', () => {
  it('answers what the Chat part says, as the key actor, waiting at most 20 s; the audit row has ids only', async () => {
    const f = await doorApi(settingsFor('cloudflare'));
    const { key, id } = await chatKey(api);
    const res = await ask(api, key);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ message: 'You ate 1830 calories today. Added 1. Undo is in Jantar.' });
    expect(f.calls).toEqual([{ text: 'How many calories today?', actor: { kind: 'capture', keyId: id }, waitMs: 20_000 }]);
    f.answer({ message: 'Still working on it. The answer will be in Jantar.', outcome: 'later', turnId: '01JTURN0000000000000000002' });
    expect((await ask(api, key)).json()).toEqual({ message: 'Still working on it. The answer will be in Jantar.' });
    const rows = api.ctx.db.audit.list({ limit: 50 }).filter((a) => a.action === 'capture.chat');
    expect(rows.map((r) => r.params)).toEqual([
      { keyId: id, turnId: '01JTURN0000000000000000001', outcome: 'answered' },
      { keyId: id, turnId: '01JTURN0000000000000000002', outcome: 'later' },
    ]);
    expect(JSON.stringify(rows)).not.toContain('calories');
    expect(JSON.stringify(rows)).not.toContain(key);
  });

  it('Origin 403; missing, malformed and wrong-scope keys 401 both ways, counted; every error has a message', async () => {
    await doorApi(settingsFor('tailscale'));
    const chat = await chatKey(api);
    const save = await saveKey(api);
    const origin = await ask(api, chat.key, { origin: 'https://example.com' });
    expect(origin.statusCode).toBe(403);
    expect(origin.json().message).toBe('browsers cannot call this');
    for (const k of [undefined, 'jchat_short', save.key]) {
      const r = await door(api, ROUTES.captureChat.path, { [CAPTURE_KEY_HEADER]: k });
      expect(r.statusCode, String(k)).toBe(401);
      expect(r.json().message).toBe(CHAT_KEY_REFUSED);
    }
    // A chat key on the save door: refused like an unknown key.
    const wrong = await door(api, ROUTES.captureSave.path, { [CAPTURE_KEY_HEADER]: chat.key }, { text: 'https://example.com/a' });
    expect(wrong.statusCode).toBe(401);
    expect(api.services.captureBadKeyLimiter.check('203.0.113.9').ok).toBe(true);
    // The chat key is stored only as its own-domain hash, with the chat scope.
    const rows = api.ctx.db.captureKeys.list();
    expect(rows.find((r) => r.id === chat.id)).toMatchObject({ scope: 'chat', keyHash: hashChatKey(chat.key) });
    expect(rows.find((r) => r.id === save.id)?.scope).toBe('capture');
  });

  it('10 questions a minute per key; then 429 with the sentence', async () => {
    await doorApi(settingsFor('tailscale'));
    const { key } = await chatKey(api);
    for (let i = 0; i < 10; i++) expect((await ask(api, key)).statusCode).toBe(200);
    const r = await ask(api, key);
    expect(r.statusCode).toBe(429);
    expect(r.json().message).toBe(CHAT_VOICE_LIMITED);
  });

  it('a strict body; chat.db broken is 503 with its sentence; read-only refuses', async () => {
    const f = await doorApi(settingsFor('tailscale'));
    const { key } = await chatKey(api);
    expect((await ask(api, key, {}, { text: 'x', photos: [] })).statusCode).toBe(400);
    expect((await ask(api, key, {}, { text: '   ' })).statusCode).toBe(400);
    f.setBroken('Chat history could not be opened.');
    const broken = await ask(api, key);
    expect(broken.statusCode).toBe(503);
    expect(broken.json().message).toBe('Chat history could not be opened.');
    await api.close();
    await doorApi(settingsFor('tailscale'), { readOnly: true });
    const ro = await chatKey(api);
    expect((await ask(api, ro.key)).statusCode).toBe(403);
  });
});

describe('v0.10 chat keys', () => {
  it('ctl only, shown once, listed without the key, five at most, apart from the save door keys', async () => {
    await doorApi(settingsFor('tailscale'));
    const tcp = await api.tcp.inject({ method: 'POST', url: ROUTES.chatKeyAdd.path, headers: { host: HOST }, payload: {} });
    expect(tcp.statusCode).not.toBe(200);
    const made = [];
    for (let i = 0; i < 6; i++) made.push(await chatKey(api));
    await saveKey(api);
    const list = (await api.ctl.inject({ method: 'GET', url: ROUTES.chatKeyList.path })).json() as { keys: Array<{ id: string }>; chatUrl: string };
    expect(list.keys.map((k) => k.id)).toEqual(made.slice(1).map((k) => k.id));
    expect(JSON.stringify(list)).not.toMatch(/jchat_/);
    const saves = (await api.ctl.inject({ method: 'GET', url: ROUTES.captureKeyList.path })).json() as { keys: unknown[] };
    expect(saves.keys).toHaveLength(1);
    const all = await api.ctl.inject({ method: 'POST', url: ROUTES.chatKeyRevoke.path, payload: { all: true } });
    expect(all.json()).toEqual({ revoked: 5 });
    expect(api.services.captureKeys.activeCount()).toBe(1);
  });
});
