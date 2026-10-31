import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEVICE_COOKIE,
  LEGACY_DEVICE_COOKIE,
  DevicesResponseSchema,
  PairClaimResponseSchema,
  PairStartResponseSchema,
  SettingsSchema,
  type Scope,
} from '@jantar/protocol';
import { hashDeviceKey, hashDeviceSecret } from '../../src/auth/devices.js';
import { AUDIT_NOISE_PER_ACTOR, AUDIT_NOISE_WINDOW_MS } from '../../src/api/services.js';
import { HOST, ORIGIN, h, makeApi, makeCard, pairCookie, type TestApi } from './fakes.js';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

async function start(scopes?: Scope[], name?: string) {
  const res = await api.ctl.inject({
    method: 'POST',
    url: '/v1/pair/start',
    payload: { ...(scopes ? { scopes } : {}), ...(name ? { name } : {}) },
  });
  expect(res.statusCode).toBe(200);
  return PairStartResponseSchema.parse(res.json());
}

function claim(code: string, extra: Record<string, string> = {}) {
  return api.tcp.inject({ method: 'POST', url: '/v1/pair/claim', headers: { host: HOST, origin: ORIGIN, ...extra }, payload: { code, name: 'Pixel phone' } });
}

describe('pairing end to end', () => {
  it('ctl pair/start -> QR link with the code in the fragment -> claim -> cookie -> API access', async () => {
    api = await makeApi();
    const started = await start();
    // 128-bit code, base64url (22 chars), in the fragment only.
    expect(started.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(started.url).toBe(`http://127.0.0.1:7420/pair#c=${started.code}`);
    expect(new URL(started.url).search).toBe('');
    expect(Date.parse(started.expiresAt) - api.ctx.clock.now()).toBe(10 * 60_000);

    const res = await claim(started.code, { 'user-agent': 'Mozilla/5.0 (Linux; Android 15) Chrome/140' });
    expect(res.statusCode).toBe(200);
    const body = PairClaimResponseSchema.parse(res.json());
    expect(body.device.scopes).toEqual(['read', 'control']);
    expect(JSON.stringify(res.json())).not.toContain('keyHash');

    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(new RegExp(`^${DEVICE_COOKIE}=[A-Za-z0-9_-]{43};`));
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toMatch(/Max-Age=2592000/);

    // Only sha256(key) is stored.
    const key = res.cookies.find((c) => c.name === DEVICE_COOKIE)?.value as string;
    const stored = api.ctx.db.devices.get(body.device.id);
    expect(stored?.keyHash).toBe(hashDeviceKey(key));
    expect(JSON.stringify(api.ctx.db.devices.list())).not.toContain(key);

    const state = await api.tcp.inject({ method: 'GET', url: '/v1/state', headers: h(`${DEVICE_COOKIE}=${key}`) });
    expect(state.statusCode).toBe(200);

    // The code is single use.
    const again = await claim(started.code);
    expect(again.statusCode).toBe(403);
    expect(again.json().error.code).toBe('forbidden');
  });

  it('a phone paired with ccw-v2 (the old name) keeps working: its cookie is accepted and re-issued under the new name', async () => {
    api = await makeApi();
    const res = await claim((await start()).code);
    const key = res.cookies.find((c) => c.name === DEVICE_COOKIE)?.value as string;
    // The stored hashes keep ccw-v2's prefixes, so a database brought over by import-ccw-v2 still matches.
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(hashDeviceKey(key)).toBe(sha(`ccw-v2-device:${key}`));
    expect(hashDeviceSecret(key)).toBe(sha(`ccw-v2-device-secret:${key}`));

    const old = await api.tcp.inject({ method: 'GET', url: '/v1/state', headers: h(`${LEGACY_DEVICE_COOKIE}=${key}`) });
    expect(old.statusCode).toBe(200);
    expect(old.cookies.find((c) => c.name === DEVICE_COOKIE)?.value).toBe(key);
    // With the new cookie there is nothing to re-issue.
    const next = await api.tcp.inject({ method: 'GET', url: '/v1/state', headers: h(`${DEVICE_COOKIE}=${key}; ${LEGACY_DEVICE_COOKIE}=${key}`) });
    expect(next.statusCode).toBe(200);
    expect(next.cookies.find((c) => c.name === DEVICE_COOKIE)).toBeUndefined();
    // An unknown key under the old name is no more than an unknown key.
    const bad = await api.tcp.inject({ method: 'GET', url: '/v1/state', headers: h(`${LEGACY_DEVICE_COOKIE}=${'A'.repeat(43)}`) });
    expect(bad.statusCode).toBe(401);
  });

  it('uses remote.publicUrl for the pairing link when set', async () => {
    api = await makeApi();
    await api.ctx.settings.patch({ remote: { publicUrl: 'https://mac.tailnet-example.ts.net/' } });
    const started = await start();
    expect(started.url).toBe(`https://mac.tailnet-example.ts.net/pair#c=${started.code}`);
  });

  it('codes expire after 10 minutes', async () => {
    api = await makeApi();
    const started = await start();
    api.ctx.clock.advance(10 * 60_000 + 1);
    const res = await claim(started.code);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/expired/);
  });

  it('emits device.pending and audits start and claim without the code', async () => {
    api = await makeApi();
    const seen: string[] = [];
    api.ctx.store.subscribe((ev) => seen.push(ev.type));
    const started = await start(undefined, 'Kitchen iPad');
    expect(seen).toContain('device.pending');
    await claim(started.code);
    const audit = api.ctx.db.audit.list();
    const actions = audit.map((a) => `${a.actor}:${a.action}:${a.result}`);
    expect(actions[0]).toBe('cli:pairStart:ok');
    expect(actions[1]).toMatch(/^device:[0-9A-Z]{26}:pairClaim:ok$/);
    expect(JSON.stringify(audit)).not.toContain(started.code);
    // The name given at pair/start wins.
    const dev = DevicesResponseSchema.parse((await api.ctl.inject({ method: 'GET', url: '/v1/devices' })).json()).devices[0];
    expect(dev?.name).toBe('Kitchen iPad');
  });

  it('rate limits claims per caller (no global lockout)', async () => {
    api = await makeApi({ ctx: { settings: SettingsSchema.parse({ remote: { mode: 'tailscale' } }) } });
    const via = (n: number) => ({ 'x-forwarded-for': `100.64.0.${n}` });
    for (let i = 0; i < 8; i++) expect((await claim(`wrong-code-${i}-xxxxxxxxxx`, via(7))).statusCode).toBe(403);
    const limited = await claim('wrong-code-9-xxxxxxxxxxx', via(7));
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    // A different client behind the same Tailscale Serve proxy is not locked out.
    const started = await start();
    const other = await claim(started.code, via(9));
    expect(other.statusCode).toBe(200);

    // The window slides.
    api.ctx.clock.advance(61_000);
    const later = await start();
    expect((await claim(later.code, via(7))).statusCode).toBe(200);
  });

  it('by default the key is the socket peer: spoofed forwarded headers neither dodge the limit nor lock others out', async () => {
    api = await makeApi();
    for (let i = 0; i < 8; i++) {
      const spoof = { 'cf-connecting-ip': `203.0.113.${i}`, 'x-forwarded-for': `100.64.1.${i}`, 'x-real-ip': `198.51.100.${i}` };
      expect((await claim(`wrong-code-${i}-xxxxxxxxxx`, spoof)).statusCode).toBe(403);
    }
    const ninth = await claim('wrong-code-9-xxxxxxxxxxx', { 'cf-connecting-ip': '203.0.113.99', 'x-forwarded-for': '100.64.1.99' });
    expect(ninth.statusCode).toBe(429);
  });

  it("behind Tailscale Serve a client's own CF-Connecting-IP cannot pick the bucket", async () => {
    api = await makeApi({ ctx: { settings: SettingsSchema.parse({ remote: { mode: 'tailscale' } }) } });
    // An attacker at 100.64.0.7 cycles CF-Connecting-IP: still one bucket.
    for (let i = 0; i < 8; i++) {
      expect((await claim(`wrong-code-${i}-xxxxxxxxxx`, { 'x-forwarded-for': '100.64.0.7', 'cf-connecting-ip': `203.0.113.${i}` })).statusCode).toBe(403);
    }
    expect((await claim('wrong-code-9-xxxxxxxxxxx', { 'x-forwarded-for': '100.64.0.7', 'cf-connecting-ip': '203.0.113.50' })).statusCode).toBe(429);
    // ...and naming a victim's address in CF-Connecting-IP does not lock the victim out.
    const started = await start();
    const victim = await claim(started.code, { 'x-forwarded-for': '100.64.0.9' });
    expect(victim.statusCode).toBe(200);
  });

  it('rate limits per device too', async () => {
    api = await makeApi({
      api: { claimsPerMinute: 2 },
      ctx: { settings: SettingsSchema.parse({ remote: { mode: 'tailscale' } }) },
    });
    const { cookie } = await pairCookie(api);
    const ip = (n: number) => ({ cookie, 'x-forwarded-for': `100.64.0.${n}` });
    expect((await claim('wrong-code-a-xxxxxxxxxxx', ip(1))).statusCode).toBe(403);
    expect((await claim('wrong-code-b-xxxxxxxxxxx', ip(2))).statusCode).toBe(403);
    expect((await claim('wrong-code-c-xxxxxxxxxxx', ip(3))).statusCode).toBe(429);
  });

  it('only the CLI or an admin device may create codes, and only the CLI grants admin', async () => {
    api = await makeApi();
    const phone = await pairCookie(api, ['read', 'control']);
    const admin = await pairCookie(api, ['admin']);
    expect((await api.tcp.inject({ method: 'POST', url: '/v1/pair/start', headers: h(phone.cookie), payload: {} })).statusCode).toBe(403);
    expect((await api.tcp.inject({ method: 'POST', url: '/v1/pair/start', headers: h(admin.cookie), payload: {} })).statusCode).toBe(200);
    const byAdmin = await api.tcp.inject({ method: 'POST', url: '/v1/pair/start', headers: h(admin.cookie), payload: { scopes: ['admin'] } });
    expect(byAdmin.statusCode).toBe(403);
    expect(byAdmin.json().error.message).toBe('Pair an admin device on the Mac: jantar pair --admin');
    // admin implies launch, control and read.
    expect(api.ctx.db.devices.get(admin.deviceId)?.scopes).toEqual(['read', 'control', 'launch', 'admin']);
  });
});

describe('scopes', () => {
  it('read-only devices can read but not control; control devices cannot administer', async () => {
    api = await makeApi();
    const reader = await pairCookie(api, ['read']);
    const phone = await pairCookie(api, ['read', 'control']);
    const card = makeCard();
    api.ctx.store.emit({ type: 'pending.opened', sid: card.sid, data: { pending: card } });

    expect((await api.tcp.inject({ method: 'GET', url: '/v1/sessions', headers: h(reader.cookie) })).statusCode).toBe(200);
    const r1 = await api.tcp.inject({ method: 'POST', url: '/v1/sessions/sess-aaaa-1111/prompt', headers: h(reader.cookie), payload: { text: 'hi' } });
    expect(r1.statusCode).toBe(403);
    const r2 = await api.tcp.inject({ method: 'POST', url: `/v1/pending/${card.id}/decision`, headers: h(reader.cookie), payload: { behavior: 'allow' } });
    expect(r2.statusCode).toBe(403);
    expect(api.fakes.hooks.decisions).toHaveLength(0);

    const ok = await api.tcp.inject({ method: 'POST', url: `/v1/pending/${card.id}/decision`, headers: h(phone.cookie), payload: { behavior: 'allow' } });
    expect(ok.statusCode).toBe(200);
    expect(api.fakes.hooks.decisions[0]?.actor).toBe(`device:${phone.deviceId}`);

    for (const [method, url] of [
      ['GET', '/v1/settings'],
      ['GET', '/v1/devices'],
      ['GET', '/v1/audit'],
      ['DELETE', `/v1/devices/${reader.deviceId}`],
    ] as const) {
      const res = await api.tcp.inject({ method, url, headers: h(phone.cookie) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    // Refusals by a known device are audited.
    expect(api.ctx.db.audit.list().some((a) => a.action === 'sendPrompt' && a.result === 'refused')).toBe(true);
  });

  it('a paired device cannot flood the audit log with refused writes or read-scope writes', async () => {
    api = await makeApi();
    const owner = await pairCookie(api, ['read', 'control'], 'Owner phone');
    const reader = await pairCookie(api, ['read'], 'Tablet');
    const sent = await api.tcp.inject({ method: 'POST', url: '/v1/sessions/sess-aaaa-1111/prompt', headers: h(owner.cookie), payload: { text: 'hi' } });
    expect(sent.statusCode).toBe(202);

    for (let i = 0; i < 300; i++) {
      const r = await api.tcp.inject({ method: 'POST', url: '/v1/sessions/sess-aaaa-1111/focus', headers: h(reader.cookie) });
      expect(r.statusCode).toBe(403);
    }
    // Without an Origin header (a stolen cookie used from curl) too.
    for (let i = 0; i < 50; i++) {
      await api.tcp.inject({ method: 'POST', url: '/v1/sessions/sess-aaaa-1111/focus', headers: { host: HOST, cookie: reader.cookie } });
    }
    for (let i = 0; i < 100; i++) {
      const r = await api.tcp.inject({
        method: 'POST',
        url: '/v1/push/subscribe',
        headers: h(reader.cookie),
        payload: { subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${i}`, keys: { p256dh: 'p', auth: 'a' } } },
      });
      expect(r.statusCode).toBe(200);
    }

    const rows = api.ctx.db.audit.list({ limit: 10_000 });
    const byReader = rows.filter((a) => a.actor === `device:${reader.deviceId}` && a.action !== 'pairClaim');
    expect(byReader.length).toBeLessThanOrEqual(AUDIT_NOISE_PER_ACTOR);
    expect(rows.some((a) => a.actor === `device:${owner.deviceId}` && a.action === 'sendPrompt' && a.result === 'ok')).toBe(true);
    expect(api.ctx.log.records.some((r) => r.msg === 'audit rows dropped for a noisy device')).toBe(true);

    // Owner writes are never throttled, and the budget refills.
    api.ctx.clock.advance(AUDIT_NOISE_WINDOW_MS + 1);
    await api.tcp.inject({ method: 'POST', url: '/v1/sessions/sess-aaaa-1111/focus', headers: h(reader.cookie) });
    const later = api.ctx.db.audit.list({ limit: 10_000 }).filter((a) => a.actor === `device:${reader.deviceId}` && a.action !== 'pairClaim');
    expect(later.length).toBe(byReader.length + 1);
  });
});

describe('devices', () => {
  it('revoking a device ends its access, closes its event streams and drops its push subscriptions', async () => {
    api = await makeApi();
    const admin = await pairCookie(api, ['admin'], 'Mac');
    const phone = await pairCookie(api, ['read', 'control']);
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/send/abc', keys: { p256dh: 'p', auth: 'a' } };
    expect(
      (await api.tcp.inject({ method: 'POST', url: '/v1/push/subscribe', headers: h(phone.cookie), payload: { subscription: sub } })).statusCode,
    ).toBe(200);
    expect(api.ctx.db.pushSubs.list()).toHaveLength(1);

    const ws = await api.tcp.injectWS('/v1/events', { headers: h(phone.cookie) });
    const closed = new Promise<number>((resolve) => ws.on('close', (code: number) => resolve(code)));

    const res = await api.tcp.inject({ method: 'DELETE', url: `/v1/devices/${phone.deviceId}`, headers: h(admin.cookie) });
    expect(res.statusCode).toBe(200);
    expect(res.json().device.revokedAt).toBeTruthy();
    expect(await closed).toBe(4401);
    expect(api.ctx.db.pushSubs.list()).toHaveLength(0);
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/state', headers: h(phone.cookie) })).statusCode).toBe(401);

    const list = DevicesResponseSchema.parse((await api.tcp.inject({ method: 'GET', url: '/v1/devices', headers: h(admin.cookie) })).json());
    expect(list.devices.map((d) => d.name)).toEqual(['Mac', 'Test phone']);
    expect((await api.tcp.inject({ method: 'DELETE', url: '/v1/devices/nope', headers: h(admin.cookie) })).statusCode).toBe(404);
  });

  it('devices expire after 30 idle days; use keeps them alive and refreshes the cookie', async () => {
    api = await makeApi();
    const phone = await pairCookie(api);
    api.ctx.clock.advance(29 * 24 * 3600_000);
    const used = await api.tcp.inject({ method: 'GET', url: '/v1/state', headers: h(phone.cookie) });
    expect(used.statusCode).toBe(200);
    expect(String(used.headers['set-cookie'])).toContain(`${DEVICE_COOKIE}=`);
    api.ctx.clock.advance(29 * 24 * 3600_000);
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/state', headers: h(phone.cookie) })).statusCode).toBe(200);
    api.ctx.clock.advance(31 * 24 * 3600_000);
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/state', headers: h(phone.cookie) })).statusCode).toBe(401);
    expect(api.ctx.db.devices.get(phone.deviceId)?.revokedAt).toBeTruthy();
  });
});
