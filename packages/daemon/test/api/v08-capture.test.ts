/**
 * G13: the capture door (`POST /v1/capture/save`, the iOS Shortcut) and its
 * keys. Synthetic values only (keys made here, links on example.com).
 *
 * - It does not exist (404) in loopback and lan mode, with Intel off, or
 *   with no working key; a device cookie or a key changes nothing then.
 * - Any Origin is 403; a missing, malformed, unknown, revoked or idle key is
 *   401, answered before the body is read (an oversized or broken body never
 *   reaches the parser); a device cookie grants nothing and is not looked at.
 * - The reply is byte-identical for a new link, one already saved, reading
 *   off and a read over the cap; a link Intel refuses says Intel's sentence.
 * - Limits: 30 saves an hour per key, 20 wrong keys per caller (by
 *   CF-Connecting-IP in cloudflare mode).
 * - Keys: made, listed and revoked over ctl.sock only; shown once; kept as
 *   a prefixed hash; five at most (a sixth revokes the oldest); never in a
 *   log line, an audit row or an event. The door's URL comes back only in a
 *   TLS mode.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_KEY_HEADER,
  CAPTURE_SAVED_SENTENCE,
  CaptureKeyAddReplySchema,
  ErrorBodySchema,
  INTEL_READ_LIMITS,
  INTEL_READ_REASONS,
  ROUTES,
  SettingsSchema,
  type IntelReadBody,
  type IntelReadReply,
  type Settings,
} from '@jantar/protocol';
import type { IntelService, IntelVia, LifeResult } from '../../src/contracts.js';
import { CAPTURE_BAD_KEYS, CAPTURE_KEY_REFUSED, CAPTURE_LIMITED, captureDoorOpen } from '../../src/api/app.js';
import { captureText } from '../../src/api/routes/capture.js';
import { captureDoor, hashCaptureKey } from '../../src/auth/capture-keys.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { HOST, h, makeApi, pairCookie, type TestApi } from './fakes.js';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

const PUBLIC = 'https://jantar.example.com';
const PUBLIC_HOST = 'jantar.example.com';
const ID = 'captures:01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const LINK = 'https://example.com/a/post';

function settingsFor(mode: Settings['remote']['mode'], over: { intel?: boolean; read?: boolean } = {}): Settings {
  return SettingsSchema.parse({
    intel: { enabled: over.intel ?? true, read: over.read ?? true },
    remote: { mode, ...(mode === 'cloudflare' || mode === 'tailscale' ? { publicUrl: PUBLIC } : {}) },
  });
}

interface ReadCall {
  body: IntelReadBody;
  from: { via: IntelVia; keyId?: string };
}

/** Intel with only `read` built: it answers `next` (default: a new item, queued). */
function fakeIntel() {
  const calls: ReadCall[] = [];
  let next: LifeResult<IntelReadReply> = { ok: true, value: { id: ID, duplicate: false, queued: true, message: 'Saved. Reading it on your Mac.' } };
  const intel = notBuilt<IntelService>('Intel', {
    start: async () => {},
    stop: async () => {},
    read: async (body, from) => {
      calls.push({ body, from });
      return next;
    },
  });
  return {
    intel,
    calls,
    answer(r: LifeResult<IntelReadReply>) {
      next = r;
    },
  };
}

async function doorApi(settings: Settings) {
  const f = fakeIntel();
  api = await makeApi({ ctx: { settings }, deps: () => ({ intel: f.intel }) });
  return f;
}

async function addKey(t: TestApi, name?: string) {
  const res = await t.ctl.inject({ method: 'POST', url: ROUTES.captureKeyAdd.path, payload: name ? { name } : {} });
  expect(res.statusCode, res.body).toBe(200);
  return CaptureKeyAddReplySchema.parse(res.json());
}

/** What the Shortcut sends through the public door: the public Host, the key, JSON. */
function door(t: TestApi, headers: Record<string, string | undefined> = {}, payload: unknown = { text: LINK, depth: 'standard' }) {
  const all: Record<string, string> = { host: PUBLIC_HOST, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' };
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) delete all[k];
    else all[k] = v;
  }
  return t.tcp.inject({ method: 'POST', url: ROUTES.captureSave.path, headers: all, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) });
}

const withKey = (key: string, extra: Record<string, string | undefined> = {}) => ({ [CAPTURE_KEY_HEADER]: key, ...extra });

describe('G13: the door does not exist outside a TLS mode, with Intel off, or with no key', () => {
  it('loopback and lan: 404 whatever comes with it, even with a key made at the Mac', async () => {
    for (const mode of ['loopback', 'lan'] as const) {
      await api?.close();
      const f = await doorApi(settingsFor(mode));
      const { key } = await addKey(api);
      const { cookie } = await pairCookie(api, ['read', 'control', 'admin']);
      // Loopback answers its own Host only (another is 403 before any route): the door is 404 there all the same.
      const host = mode === 'loopback' ? { host: HOST } : {};
      for (const headers of [{}, withKey(key), h(cookie, withKey(key)), { host: HOST, ...withKey(key) }]) {
        const res = await door(api, { ...host, ...headers });
        expect(res.statusCode, `${mode} ${Object.keys(headers).join(',')}`).toBe(404);
        expect(res.body).not.toContain(CAPTURE_SAVED_SENTENCE);
      }
      expect(captureDoorOpen(api.services)).toBe(false);
      expect(f.calls).toHaveLength(0);
    }
  });

  it('cloudflare and tailscale with no key, or with Intel off: 404', async () => {
    for (const mode of ['cloudflare', 'tailscale'] as const) {
      await api?.close();
      await doorApi(settingsFor(mode));
      expect((await door(api, withKey(`jcap_${'A'.repeat(43)}`))).statusCode, `${mode} no key`).toBe(404);
      const { key } = await addKey(api);
      expect((await door(api, withKey(key))).statusCode, `${mode} with key`).toBe(202);
      await api.ctx.settings.patch({ intel: { enabled: false } });
      expect((await door(api, withKey(key))).statusCode, `${mode} intel off`).toBe(404);
    }
  });

  it('every key revoked, or the last one idle past 180 days: 404 again', async () => {
    await doorApi(settingsFor('cloudflare'));
    const { key, id } = await addKey(api);
    expect((await door(api, withKey(key))).statusCode).toBe(202);
    await api.ctl.inject({ method: 'POST', url: ROUTES.captureKeyRevoke.path, payload: { id } });
    expect((await door(api, withKey(key))).statusCode).toBe(404);
    const b = await addKey(api);
    expect((await door(api, withKey(b.key))).statusCode).toBe(202);
    api.ctx.clock.advance(INTEL_READ_LIMITS.captureKeyIdleMs + 1);
    expect(captureDoorOpen(api.services)).toBe(false);
    expect((await door(api, withKey(b.key))).statusCode).toBe(404);
  });

  it('only POST /v1/capture/save: other methods and paths are the plain 404', async () => {
    await doorApi(settingsFor('cloudflare'));
    const { key } = await addKey(api);
    for (const [method, url] of [['GET', '/v1/capture/save'], ['POST', '/v1/capture/other'], ['PUT', '/v1/capture/save']] as const) {
      const res = await api.tcp.inject({ method, url, headers: { host: PUBLIC_HOST, ...withKey(key) } });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });
});

describe('G13: the gate, before the body', () => {
  it('any Origin is 403, a valid key included', async () => {
    const f = await doorApi(settingsFor('cloudflare'));
    const { key } = await addKey(api);
    for (const origin of [PUBLIC, 'https://evil.example', 'null', `http://${HOST}`]) {
      const res = await door(api, withKey(key, { origin }));
      expect(res.statusCode, origin).toBe(403);
    }
    expect(f.calls).toHaveLength(0);
  });

  it('no key, a malformed, an unknown or a revoked key: 401 with the sentence; Intel never called', async () => {
    const f = await doorApi(settingsFor('cloudflare'));
    const live = await addKey(api);
    const old = await addKey(api, 'old');
    await api.ctl.inject({ method: 'POST', url: ROUTES.captureKeyRevoke.path, payload: { id: old.id } });
    for (const key of [undefined, '', 'jcap_short', `jcap_${'!'.repeat(43)}`, `jcap_${'B'.repeat(43)}`, live.key.replace('jcap_', 'jext_'), old.key]) {
      const res = await door(api, { [CAPTURE_KEY_HEADER]: key });
      expect(res.statusCode, String(key)).toBe(401);
      expect(ErrorBodySchema.parse(res.json()).error).toEqual({ code: 'unauthorized', message: CAPTURE_KEY_REFUSED });
    }
    expect(f.calls).toHaveLength(0);
  });

  it('a wrong key is refused before the body: an 8 KB+ body and broken JSON are still 401, not 413 or 400', async () => {
    await doorApi(settingsFor('cloudflare'));
    const { key } = await addKey(api);
    const big = JSON.stringify({ text: `${LINK} ${'x'.repeat(INTEL_READ_LIMITS.captureBodyBytes)}` });
    expect((await door(api, withKey(`jcap_${'C'.repeat(43)}`), big)).statusCode).toBe(401);
    expect((await door(api, {}, '{ not json')).statusCode).toBe(401);
    // With the key, the body's own checks answer.
    expect((await door(api, withKey(key), big)).statusCode).toBe(413);
    expect((await door(api, withKey(key), '{ not json')).statusCode).toBe(400);
    expect((await door(api, withKey(key), { text: LINK, extra: 1 })).statusCode).toBe(400);
    expect((await door(api, withKey(key), { depth: 'full' })).statusCode).toBe(400);
  });

  it('a device cookie grants nothing, and is never looked at on the door', async () => {
    const f = await doorApi(settingsFor('cloudflare'));
    await addKey(api);
    const { cookie } = await pairCookie(api, ['read', 'control', 'admin']);
    const seen = vi.spyOn(api.services.devices, 'authenticate');
    const res = await door(api, { cookie });
    expect(res.statusCode).toBe(401);
    expect(seen).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
  });

  it('the key header is read on the door only: elsewhere it authenticates nothing', async () => {
    await doorApi(settingsFor('cloudflare'));
    const { key } = await addKey(api);
    const auth = vi.spyOn(api.services.captureKeys, 'authenticate');
    for (const url of ['/v1/state', ROUTES.intelList.path, '/v1/ext/info']) {
      const res = await api.tcp.inject({ method: 'GET', url, headers: { host: PUBLIC_HOST, ...withKey(key) } });
      expect(res.statusCode, url).toBe(url === '/v1/ext/info' ? 403 : 401);
    }
    expect(auth).not.toHaveBeenCalled();
  });
});

describe('G13: one reply, whatever happened', () => {
  it('new, already saved, reading off and over the cap: byte-identical 202s', async () => {
    const f = await doorApi(settingsFor('cloudflare'));
    const { key, id } = await addKey(api);
    const answers: LifeResult<IntelReadReply>[] = [
      { ok: true, value: { id: ID, duplicate: false, queued: true, message: 'Saved. Reading it on your Mac.' } },
      { ok: true, value: { id: ID, duplicate: true, queued: false, message: 'Already saved.' } },
      { ok: true, value: { id: ID, duplicate: false, queued: false, message: INTEL_READ_REASONS.off } },
      { ok: true, value: { id: ID, duplicate: false, queued: false, message: INTEL_READ_REASONS.daily } },
    ];
    const replies: { status: number; body: string; type: unknown }[] = [];
    for (const a of answers) {
      f.answer(a);
      const res = await door(api, withKey(key));
      replies.push({ status: res.statusCode, body: res.body, type: res.headers['content-type'] });
    }
    for (const r of replies) expect(r).toEqual({ status: 202, body: JSON.stringify({ message: CAPTURE_SAVED_SENTENCE }), type: replies[0]?.type });
    expect(replies[0]?.body).toBe('{"message":"Saved to Jantar."}');
    // Intel got the text and depth, as the Shortcut, with the key's id (never the key).
    expect(f.calls[0]).toEqual({ body: { text: LINK, depth: 'standard' }, from: { via: 'shortcut', keyId: id } });
  });

  it('with reading off at the Mac the door still saves (Intel keeps the link as a plain capture)', async () => {
    const f = await doorApi(settingsFor('cloudflare', { read: false }));
    const { key } = await addKey(api);
    const res = await door(api, withKey(key));
    expect(res.statusCode).toBe(202);
    expect(f.calls).toHaveLength(1);
  });

  it("a link Intel refuses (not public https) answers Intel's sentence: nothing about the shelf", async () => {
    const f = await doorApi(settingsFor('cloudflare'));
    const { key } = await addKey(api);
    f.answer({ ok: false, code: 'invalid_request', reason: INTEL_READ_REASONS.badLink });
    const res = await door(api, withKey(key), { text: 'http://192.168.1.10/admin' });
    expect(res.statusCode).toBe(400);
    expect(ErrorBodySchema.parse(res.json()).error.message).toBe(INTEL_READ_REASONS.badLink);
  });

  it('url and text: the url first (the link), the text after it (the note), the same link once, cut to 4,000', () => {
    expect(captureText({ url: LINK })).toBe(LINK);
    expect(captureText({ text: `look ${LINK}` })).toBe(`look ${LINK}`);
    expect(captureText({ url: LINK, text: LINK })).toBe(LINK);
    expect(captureText({ url: LINK, text: 'dal recipe' })).toBe(`${LINK}\ndal recipe`);
    expect(captureText({ url: LINK, text: 'x'.repeat(4000) })).toHaveLength(INTEL_READ_LIMITS.textMax);
    expect(captureText({ text: `${'a'.repeat(3999)}😀` })).toHaveLength(3999);
  });
});

describe('G13: limits', () => {
  it('30 saves an hour per key, then 429 with retry-after; another key is not held up', async () => {
    const f = await doorApi(settingsFor('cloudflare'));
    const a = await addKey(api, 'a');
    const b = await addKey(api, 'b');
    for (let i = 0; i < INTEL_READ_LIMITS.capturePerHour; i++) expect((await door(api, withKey(a.key))).statusCode, `save ${i + 1}`).toBe(202);
    const limited = await door(api, withKey(a.key));
    expect(limited.statusCode).toBe(429);
    expect(ErrorBodySchema.parse(limited.json()).error.message).toBe(CAPTURE_LIMITED);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await door(api, withKey(b.key))).statusCode).toBe(202);
    expect(f.calls).toHaveLength(INTEL_READ_LIMITS.capturePerHour + 1);
    api.ctx.clock.advance(60 * 60_000 + 1);
    expect((await door(api, withKey(a.key))).statusCode).toBe(202);
  });

  it('20 wrong keys per caller in 10 minutes, keyed by CF-Connecting-IP in cloudflare mode; then even a good key waits', async () => {
    await doorApi(settingsFor('cloudflare'));
    const { key } = await addKey(api);
    const wrong = `jcap_${'D'.repeat(43)}`;
    for (let i = 0; i < INTEL_READ_LIMITS.badKeys; i++) expect((await door(api, withKey(wrong))).statusCode, `wrong ${i + 1}`).toBe(401);
    const limited = await door(api, withKey(key));
    expect(limited.statusCode).toBe(429);
    expect(ErrorBodySchema.parse(limited.json()).error.message).toBe(CAPTURE_BAD_KEYS);
    // Another caller is not held up.
    expect((await door(api, withKey(key, { 'cf-connecting-ip': '198.51.100.9' }))).statusCode).toBe(202);
    api.ctx.clock.advance(INTEL_READ_LIMITS.badKeyWindowMs + 1);
    expect((await door(api, withKey(key))).statusCode).toBe(202);
  });
});

describe('G13: the keys, at the Mac only', () => {
  it('add shows the key once with the door URL in a TLS mode; list never shows a key; the db keeps the hash', async () => {
    await doorApi(settingsFor('cloudflare'));
    const made = await addKey(api, 'iphone');
    expect(made.key).toMatch(/^jcap_[A-Za-z0-9_-]{43}$/);
    expect(made).toMatchObject({ name: 'iphone', saveUrl: `${PUBLIC}/v1/capture/save` });
    const listed = await api.ctl.inject({ method: 'GET', url: ROUTES.captureKeyList.path });
    expect(listed.json()).toEqual({ keys: [{ id: made.id, name: 'iphone', createdAt: expect.any(String), lastSeenAt: null }] });
    expect(listed.body).not.toContain(made.key);
    const row = api.ctx.db.captureKeys.list()[0];
    expect(row?.keyHash).toBe(hashCaptureKey(made.key));
    expect(JSON.stringify(api.ctx.db.captureKeys.list())).not.toContain(made.key.slice(5));
  });

  it('loopback and lan: the key is made, with no door URL, and captureDoor says why', async () => {
    for (const mode of ['loopback', 'lan'] as const) {
      await api?.close();
      await doorApi(settingsFor(mode));
      const made = await addKey(api);
      expect(made.saveUrl).toBeNull();
      const d = captureDoor(settingsFor(mode));
      expect(d.open).toBe(false);
      expect(d.open ? '' : d.why).toMatch(mode === 'lan' ? /plain http/ : /loopback/);
    }
    expect(captureDoor(SettingsSchema.parse({ remote: { mode: 'cloudflare', publicUrl: 'http://jantar.example.com' } })).open).toBe(false);
    expect(captureDoor(SettingsSchema.parse({ remote: { mode: 'tailscale', publicUrl: 'https://mac.tail0.ts.net' } }))).toEqual({ open: true, url: 'https://mac.tail0.ts.net/v1/capture/save' });
  });

  it('five at most: a sixth revokes the oldest; revoke one, then all', async () => {
    await doorApi(settingsFor('cloudflare'));
    const keys = [];
    for (let i = 0; i < 6; i++) keys.push(await addKey(api, `k${i}`));
    const active = api.services.captureKeys.list().map((k) => k.id);
    expect(active).toHaveLength(INTEL_READ_LIMITS.captureKeysMax);
    expect(active).not.toContain(keys[0]?.id);
    expect((await door(api, withKey(keys[0]?.key ?? ''))).statusCode).toBe(401);
    const one = await api.ctl.inject({ method: 'POST', url: ROUTES.captureKeyRevoke.path, payload: { id: keys[1]?.id } });
    expect(one.json()).toEqual({ revoked: 1 });
    const again = await api.ctl.inject({ method: 'POST', url: ROUTES.captureKeyRevoke.path, payload: { id: keys[1]?.id } });
    expect(again.json()).toEqual({ revoked: 0 });
    const all = await api.ctl.inject({ method: 'POST', url: ROUTES.captureKeyRevoke.path, payload: { all: true } });
    expect(all.json()).toEqual({ revoked: 4 });
    expect(api.services.captureKeys.activeCount()).toBe(0);
  });

  it('a phone, even an admin one, makes no key', async () => {
    await doorApi(settingsFor('cloudflare'));
    const { cookie } = await pairCookie(api, ['read', 'control', 'admin']);
    const res = await api.tcp.inject({ method: 'POST', url: ROUTES.captureKeyAdd.path, headers: h(cookie), payload: {} });
    expect(res.statusCode).toBe(403);
    expect(api.services.captureKeys.list()).toHaveLength(0);
  });

  it('the key is never in a log line, an audit row or an event; the audit names the key by its id', async () => {
    await doorApi(settingsFor('cloudflare'));
    const { key, id } = await addKey(api);
    await door(api, withKey(key));
    await door(api, withKey(`${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`));
    await api.ctl.inject({ method: 'POST', url: ROUTES.captureKeyRevoke.path, payload: { all: true } });
    const secret = key.slice(5);
    const audit = api.ctx.db.audit.list({ limit: 500 });
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(JSON.stringify(api.ctx.log.records)).not.toContain(secret);
    const events = api.ctx.store.replay(0);
    expect(JSON.stringify(events)).not.toContain(secret);
    const save = audit.find((r) => r.action === 'capture.save');
    expect(save).toMatchObject({ actor: `capture:${id}`, target: ID, result: 'ok', params: { keyId: id, via: 'shortcut' } });
    expect(JSON.stringify(save)).not.toContain(LINK);
  });
});
