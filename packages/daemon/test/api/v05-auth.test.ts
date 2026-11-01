/**
 * The v0.5 gate. A request that gets through answers whatever its handler
 * says (WP0's stubs: 501; the built routes: their own answers), never the
 * gate's 401 or 403:
 * - MA1: every phone meeting route needs a paired device with control,
 *   reads included; writes need an allowed Origin and the device secret.
 * - MA2: every capture route needs the extension's key, never a device
 *   cookie; a POST needs the Origin bound to the key, a GET none or that
 *   one; revoked and idle keys stop working; 300 requests a minute.
 * - MA3: the key reaches nothing else, and nothing else is the key.
 * - MA4: the capture routes and the extension's claim answer only from this
 *   Mac: a loopback peer, a loopback Host, no forwarding header.
 * - MA5 (route part): pairing the extension is the Mac's (start and unpair
 *   are localOnly), its claim only the published extension's, a code works
 *   once and only at its own claim, the key is sent once and kept as a hash.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_COOKIE, EXTENSION_IDLE_MS, ErrorBodySchema, ROUTES, SettingsSchema, type RouteDef, type RouteName } from '@jantar/protocol';
import { EXTENSION_NOT_PAIRED, LOCAL_ONLY_REFUSED } from '../../src/api/app.js';
import { ROUTE_IMPLS } from '../../src/api/routes.js';
import { V05_LIMITS } from '../../src/api/services.js';
import { hashExtensionKey } from '../../src/auth/extensions.js';
import { HOST, ORIGIN, PORT, bare, h, makeApi, pairCookie, type TestApi } from './fakes.js';
import { EXT_ORIGIN, V05, V05_EXT, V05_ON, V05_PHONE, extHeaders, pairExtension, pastGate, v05Call, v05Url } from './v05-helpers.js';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

describe('MA1: the phone routes need a paired device with control', () => {
  it('nine routes, each refused to an unpaired browser and to a read-only device; no handler runs', async () => {
    expect(V05).toHaveLength(17);
    expect(V05_PHONE).toHaveLength(9);
    api = await makeApi({ ctx: { settings: V05_ON } });
    const reader = await pairCookie(api, ['read']);
    const spies = V05_PHONE.map(([name]) => vi.spyOn(ROUTE_IMPLS[name] as { handle: () => unknown }, 'handle'));
    for (const [name] of V05_PHONE) {
      const unpaired = await v05Call(api, 'tcp', name, h());
      expect(unpaired.statusCode, `${name} unpaired`).toBe(401);
      const read = await v05Call(api, 'tcp', name, h(reader.cookie));
      expect(read.statusCode, `${name} read`).toBe(403);
      expect(read.json().error.message, name).toBe('this device does not have the control scope');
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('writes need an allowed Origin and the device secret', async () => {
    api = await makeApi({ ctx: { settings: V05_ON } });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    for (const [name, def] of V05_PHONE) {
      if (def.method === 'GET') continue;
      const evil = await v05Call(api, 'tcp', name, h(cookie, { origin: 'https://evil.example' }));
      expect(evil.statusCode, `${name} origin`).toBe(403);
      expect(evil.json().error.message).toBe('request origin is not allowed');
      const noSecret = await v05Call(api, 'tcp', name, bare(cookie));
      expect(noSecret.statusCode, `${name} secret`).toBe(401);
    }
  });

  it('a control device gets past the gate', async () => {
    api = await makeApi({ ctx: { settings: V05_ON } });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    for (const [name] of V05_PHONE) {
      const res = await v05Call(api, 'tcp', name, h(cookie));
      expect(pastGate(res), `${name} ${res.body}`).toBe(true);
    }
  });
});

describe('MA2: the capture routes take the extension key only', () => {
  it('no key is 401 with the pairing sentence; the key with its Origin gets past the gate', async () => {
    api = await makeApi({ ctx: { settings: V05_ON } });
    const { key } = await pairExtension(api);
    for (const [name, def] of V05_EXT) {
      const none = await v05Call(api, 'tcp', name, extHeaders(undefined));
      expect(none.statusCode, name).toBe(401);
      expect(none.json().error).toEqual({ code: 'unauthorized', message: EXTENSION_NOT_PAIRED });
      const ok = await v05Call(api, 'tcp', name, extHeaders(key, def.method === 'GET' ? null : EXT_ORIGIN));
      expect(pastGate(ok), `${name} ${ok.body}`).toBe(true);
    }
  });

  it('a device cookie is refused whatever comes with it: its secret, the dashboard Origin, a valid key', async () => {
    api = await makeApi({ ctx: { settings: V05_ON } });
    const { key } = await pairExtension(api);
    const { cookie } = await pairCookie(api, ['read', 'control', 'admin']);
    for (const [name] of V05_EXT) {
      for (const headers of [h(cookie), h(cookie, extHeaders(key, ORIGIN)), h(cookie, extHeaders(key))]) {
        const res = await v05Call(api, 'tcp', name, headers);
        expect(res.statusCode, name).toBe(403);
        expect(res.json().error.message).toBe('only the paired Jantar extension can call this');
      }
    }
  });

  it("a POST needs the key's own Origin; a GET carries none or that one", async () => {
    api = await makeApi({ ctx: { settings: V05_ON } });
    const { key } = await pairExtension(api);
    const others = [`chrome-extension://${'b'.repeat(32)}`, ORIGIN, 'https://meet.google.com', 'null'];
    for (const [name, def] of V05_EXT) {
      if (def.method === 'GET') {
        for (const origin of others) expect((await v05Call(api, 'tcp', name, extHeaders(key, origin))).statusCode, `${name} ${origin}`).toBe(403);
        expect(pastGate(await v05Call(api, 'tcp', name, extHeaders(key, EXT_ORIGIN))), name).toBe(true);
        continue;
      }
      for (const origin of [...others, null]) {
        const res = await v05Call(api, 'tcp', name, extHeaders(key, origin));
        expect(res.statusCode, `${name} ${origin}`).toBe(403);
        expect(res.json().error.message).toBe('request origin is not allowed');
      }
    }
  });

  it('a revoked key, and one idle past 90 days, are 401', async () => {
    api = await makeApi({ ctx: { settings: V05_ON } });
    const a = await pairExtension(api);
    expect((await v05Call(api, 'ctl', 'extUnpair')).json()).toEqual({ ok: true, revoked: 1 });
    expect((await v05Call(api, 'tcp', 'extInfo', extHeaders(a.key, null))).statusCode).toBe(401);
    const b = await pairExtension(api);
    expect(pastGate(await v05Call(api, 'tcp', 'extInfo', extHeaders(b.key, null)))).toBe(true);
    api.ctx.clock.advance(EXTENSION_IDLE_MS + 1);
    expect((await v05Call(api, 'tcp', 'extInfo', extHeaders(b.key, null))).statusCode).toBe(401);
    expect(api.ctx.db.extensions.get(b.id)?.revokedAt).toBeTruthy();
  });

  it('the 301st request in a minute is 429 with retry-after; another minute lets it through', async () => {
    api = await makeApi({ ctx: { settings: V05_ON } });
    const { key } = await pairExtension(api);
    for (let i = 0; i < V05_LIMITS.extRequest.limit; i++) {
      const name: RouteName = i % 2 ? 'extInfo' : 'extMeetingLines';
      const res = await v05Call(api, 'tcp', name, extHeaders(key, name === 'extInfo' ? null : EXT_ORIGIN));
      expect(pastGate(res) && res.statusCode !== 429, `request ${i + 1}`).toBe(true);
    }
    const limited = await v05Call(api, 'tcp', 'extInfo', extHeaders(key, null));
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.message).toBe('Too many requests from the Jantar extension; try again in a minute');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    api.ctx.clock.advance(60_001);
    const again = await v05Call(api, 'tcp', 'extInfo', extHeaders(key, null));
    expect(pastGate(again) && again.statusCode !== 429).toBe(true);
  });
});

describe('MA3: the key reaches nothing else', () => {
  // v0.6's `node` routes read no key and no cookie: 404 while Fleet is off (v06-gate.test.ts); v0.8's capture door
  // neither: 404 while it is closed (v08-contracts.test.ts).
  const httpRoutes = (Object.entries(ROUTES) as [RouteName, RouteDef][]).filter(([, d]) => d.method !== 'WS' && d.scope !== 'public' && d.scope !== 'node' && d.scope !== 'capture');

  it('in its own header on every route outside /v1/ext/ it is 401, and on the event stream', async () => {
    api = await makeApi({ ctx: { settings: V05_ON } });
    const { key } = await pairExtension(api);
    const wrong: string[] = [];
    for (const [name, def] of httpRoutes) {
      if (def.path.startsWith('/v1/ext/')) continue;
      const url = def.path.replace(/:([A-Za-z]+)/g, 'x');
      const res = await api.tcp.inject({ method: def.method as Method, url, headers: extHeaders(key, ORIGIN) });
      if (res.statusCode !== 401) wrong.push(`${name}: ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
    await expect(api.tcp.injectWS('/v1/events', { headers: extHeaders(key, ORIGIN) })).rejects.toThrow(/401/);
  });

  it('in a cookie, a bearer header or the query string it is no key at all', async () => {
    api = await makeApi({ ctx: { settings: V05_ON } });
    const { key } = await pairExtension(api);
    const base = extHeaders(undefined, null);
    const viaCookie = await api.tcp.inject({ method: 'GET', url: '/v1/ext/info', headers: { ...base, cookie: `${DEVICE_COOKIE}=${key}` } });
    expect(viaCookie.statusCode).toBe(401);
    const viaBearer = await api.tcp.inject({ method: 'GET', url: '/v1/ext/info', headers: { ...base, authorization: `Bearer ${key}` } });
    expect(viaBearer.statusCode).toBe(401);
    const viaQuery = await api.tcp.inject({ method: 'GET', url: `/v1/ext/info?key=${key}&x-jantar-extension-key=${key}`, headers: base });
    expect(viaQuery.statusCode).toBe(401);
    // Nor anywhere else.
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/state', headers: { host: HOST, cookie: `${DEVICE_COOKIE}=${key}` } })).statusCode).toBe(401);
  });

  it("a device key in the extension's header, or the extension key in the device cookie, matches nothing", async () => {
    api = await makeApi({ ctx: { settings: V05_ON } });
    const { key } = await pairExtension(api);
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const deviceKey = cookie.split('=')[1] as string;
    expect((await v05Call(api, 'tcp', 'extInfo', extHeaders(deviceKey, null))).statusCode).toBe(401);
    expect((await v05Call(api, 'tcp', 'extMeetingLines', extHeaders(deviceKey))).statusCode).toBe(401);
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/meetings', headers: h(`${DEVICE_COOKIE}=${key}`) })).statusCode).toBe(401);
  });
});

describe('MA4: loopback only', () => {
  const FORWARDING = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'cf-connecting-ip'];

  it('through the public URL, with a forwarding header, or from a LAN peer the capture routes and the claim are 403', async () => {
    const publicUrl = 'https://mac.tailnet-example.ts.net';
    api = await makeApi({ ctx: { settings: SettingsSchema.parse({ meetings: { enabled: true }, remote: { mode: 'tailscale', publicUrl } }) } });
    const { key, code } = await (async () => {
      const p = await pairExtension(api);
      const next = await api.ctl.inject({ method: 'POST', url: '/v1/ext/pair/start' });
      return { key: p.key, code: (next.json() as { code: string }).code };
    })();
    const calls: [RouteName, Record<string, string>, unknown?][] = [
      ...V05_EXT.map(([n, d]): [RouteName, Record<string, string>] => [n, extHeaders(key, d.method === 'GET' ? null : EXT_ORIGIN)]),
      ['extPairClaim', { host: HOST, origin: EXT_ORIGIN }, { code }],
    ];
    for (const [name, headers, body] of calls) {
      const viaPublic = await v05Call(api, 'tcp', name, { ...headers, host: 'mac.tailnet-example.ts.net' }, body);
      expect(viaPublic.statusCode, `${name} public host`).toBe(403);
      expect(viaPublic.json().error.message).toBe('only the Jantar extension on this Mac can call this');
      for (const f of FORWARDING) {
        expect((await v05Call(api, 'tcp', name, { ...headers, [f]: '203.0.113.7' }, body)).statusCode, `${name} ${f}`).toBe(403);
      }
    }
    // The code was never spent: from this Mac it still pairs.
    expect((await v05Call(api, 'tcp', 'extPairClaim', { host: HOST, origin: EXT_ORIGIN }, { code })).statusCode).toBe(200);
  });

  it('in lan mode a LAN peer sending a loopback Host is 403; the same request from a loopback peer passes', async () => {
    api = await makeApi({ ctx: { settings: SettingsSchema.parse({ meetings: { enabled: true }, remote: { mode: 'lan' } }) } });
    const { key } = await pairExtension(api);
    for (const [name, def] of V05_EXT) {
      const headers = extHeaders(key, def.method === 'GET' ? null : EXT_ORIGIN);
      expect((await v05Call(api, 'tcp', name, headers, undefined, { remoteAddress: '192.168.1.20' })).statusCode, name).toBe(403);
      expect((await v05Call(api, 'tcp', name, headers, undefined, { remoteAddress: '::ffff:192.168.1.20' })).statusCode, name).toBe(403);
      for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        expect(pastGate(await v05Call(api, 'tcp', name, headers, undefined, { remoteAddress: peer })), `${name} ${peer}`).toBe(true);
      }
    }
    // localhost and [::1] on the bound port are loopback Hosts too; another port is not.
    for (const host of [`localhost:${PORT}`, `[::1]:${PORT}`]) expect(pastGate(await v05Call(api, 'tcp', 'extInfo', { ...extHeaders(key, null), host })), host).toBe(true);
    expect((await v05Call(api, 'tcp', 'extInfo', { ...extHeaders(key, null), host: `127.0.0.1:${PORT + 1}` })).statusCode).toBe(403);
  });

  it("a 5 MB screenshot body from off this Mac, or without the key, is refused before it is read; only the key's is", async () => {
    api = await makeApi({ ctx: { settings: SettingsSchema.parse({ meetings: { enabled: true }, remote: { mode: 'lan' } }) } });
    const { key } = await pairExtension(api);
    // Not JSON: a body that was read and parsed answers 400, never the gate's refusal.
    const payload = `[${'0,'.repeat(2_500_000)}`;
    const shot = (headers: Record<string, string>, remoteAddress = '127.0.0.1', url = v05Url('extMeetingShot')) =>
      api.tcp.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, remoteAddress, payload });
    const lan = await shot(extHeaders(key), '192.168.1.20');
    expect([lan.statusCode, lan.json().error.message]).toEqual([403, 'only the Jantar extension on this Mac can call this']);
    const tunnel = await shot({ ...extHeaders(undefined), host: 'mac.tailnet-example.ts.net' });
    expect([tunnel.statusCode, tunnel.json().error.message]).toEqual([403, 'only the Jantar extension on this Mac can call this']);
    const keyless = await shot(extHeaders(undefined));
    expect([keyless.statusCode, keyless.json().error.message]).toEqual([401, EXTENSION_NOT_PAIRED]);
    const stale = await shot(extHeaders('k'.repeat(43)));
    expect(stale.statusCode).toBe(401);
    // An encoded path reaches the same route but reads no key, so it is refused the same way.
    const encoded = await shot(extHeaders(key), '127.0.0.1', v05Url('extMeetingShot').replace('/ext/', '/%65xt/'));
    expect(encoded.statusCode).toBe(401);
    // The paired extension on this Mac gets its body read.
    const paired = await shot(extHeaders(key));
    expect([paired.statusCode, paired.json().error.message]).toEqual([400, 'request body is not valid JSON']);
  });
});

describe('MA5: pairing the extension', () => {
  it('start and unpair are the Mac only: an admin device over TCP gets the sentence', async () => {
    api = await makeApi({ ctx: { settings: V05_ON } });
    const { cookie } = await pairCookie(api, ['read', 'control', 'admin']);
    for (const name of ['extPairStart', 'extUnpair'] as const) {
      const res = await v05Call(api, 'tcp', name, h(cookie));
      expect(res.statusCode, name).toBe(403);
      expect(res.json().error.message).toBe(LOCAL_ONLY_REFUSED[name]);
    }
    expect(LOCAL_ONLY_REFUSED.extPairStart).toBe('Pair the extension on the Mac: jantar pair --extension');
    expect(LOCAL_ONLY_REFUSED.extUnpair).toBe('Unpair on the Mac: jantar meetings unpair');
  });

  it('the start answers a code, the TCP port and the expiry; with Meetings off too', async () => {
    api = await makeApi();
    const res = await v05Call(api, 'ctl', 'extPairStart');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { code: string; port: number; expiresAt: string };
    expect(body.code).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(body.port).toBe(PORT);
    expect(Date.parse(body.expiresAt) - api.ctx.clock.now()).toBe(10 * 60_000);
    const audit = api.ctx.db.audit.list().find((a) => a.action === 'extPairStart');
    expect(JSON.stringify(audit)).not.toContain(body.code);
  });

  it('a claim from anything but the published extension is 403, and the code still works afterwards', async () => {
    api = await makeApi({ ctx: { settings: V05_ON } });
    const code = ((await v05Call(api, 'ctl', 'extPairStart')).json() as { code: string }).code;
    for (const origin of [undefined, `http://127.0.0.1:${PORT}`, 'https://evil.example', `chrome-extension://${'c'.repeat(32)}`]) {
      const headers: Record<string, string> = { host: HOST };
      if (origin) headers.origin = origin;
      const res = await v05Call(api, 'tcp', 'extPairClaim', headers, { code });
      expect(res.statusCode, String(origin)).toBe(403);
      expect(res.json().error.message).toBe('only the Jantar extension can pair here');
    }
    const ok = await v05Call(api, 'tcp', 'extPairClaim', { host: HOST, origin: EXT_ORIGIN }, { code });
    expect(ok.statusCode).toBe(200);
    // Once.
    expect((await v05Call(api, 'tcp', 'extPairClaim', { host: HOST, origin: EXT_ORIGIN }, { code })).statusCode).toBe(403);
  });

  it('each code works only at its own claim, and is not spent by the other', async () => {
    api = await makeApi({ ctx: { settings: V05_ON } });
    const extCode = ((await v05Call(api, 'ctl', 'extPairStart')).json() as { code: string }).code;
    const deviceCode = ((await api.ctl.inject({ method: 'POST', url: '/v1/pair/start', payload: {} })).json() as { code: string }).code;
    const asDevice = await api.tcp.inject({ method: 'POST', url: '/v1/pair/claim', headers: { host: HOST, origin: ORIGIN }, payload: { code: extCode, name: 'x' } });
    expect(asDevice.statusCode).toBe(403);
    const asExtension = await v05Call(api, 'tcp', 'extPairClaim', { host: HOST, origin: EXT_ORIGIN }, { code: deviceCode });
    expect(asExtension.statusCode).toBe(403);
    expect(asExtension.json().error.message).toBe('pairing code is not valid');
    expect((await v05Call(api, 'tcp', 'extPairClaim', { host: HOST, origin: EXT_ORIGIN }, { code: extCode })).statusCode).toBe(200);
    expect((await api.tcp.inject({ method: 'POST', url: '/v1/pair/claim', headers: { host: HOST, origin: ORIGIN }, payload: { code: deviceCode, name: 'x' } })).statusCode).toBe(200);
  });

  it('a code expires at 10 minutes', async () => {
    api = await makeApi({ ctx: { settings: V05_ON } });
    const code = ((await v05Call(api, 'ctl', 'extPairStart')).json() as { code: string }).code;
    api.ctx.clock.advance(10 * 60_000 + 1);
    const res = await v05Call(api, 'tcp', 'extPairClaim', { host: HOST, origin: EXT_ORIGIN }, { code });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/expired/);
  });

  it('the key comes back once, is stored only as its prefixed hash, and is in no audit row or log line', async () => {
    api = await makeApi({ ctx: { settings: V05_ON } });
    const { id, key } = await pairExtension(api);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = api.ctx.db.extensions.get(id);
    expect(stored).toMatchObject({ keyHash: hashExtensionKey(key), origin: EXT_ORIGIN, revokedAt: null });
    expect(JSON.stringify(api.ctx.db.extensions.list())).not.toContain(key);
    const audit = api.ctx.db.audit.list();
    expect(audit.find((a) => a.action === 'ext.pair')).toMatchObject({ actor: `extension:${id}`, target: id, result: 'ok' });
    expect(JSON.stringify(audit)).not.toContain(key);
    expect(JSON.stringify(api.ctx.log.records)).not.toContain(key);
  });

  it('a sixth extension revokes the oldest; unpair makes the next capture call 401', async () => {
    api = await makeApi({ ctx: { settings: V05_ON }, api: { claimsPerMinute: 50 } });
    const keys: { id: string; key: string }[] = [];
    for (let i = 0; i < 6; i++) {
      keys.push(await pairExtension(api));
      api.ctx.clock.advance(1000);
    }
    expect((await v05Call(api, 'tcp', 'extInfo', extHeaders(keys[0]?.key, null))).statusCode).toBe(401);
    for (const k of keys.slice(1)) expect(pastGate(await v05Call(api, 'tcp', 'extInfo', extHeaders(k.key, null)))).toBe(true);
    expect((await v05Call(api, 'ctl', 'extUnpair')).json()).toEqual({ ok: true, revoked: 5 });
    for (const k of keys) expect((await v05Call(api, 'tcp', 'extMeetingLines', extHeaders(k.key))).statusCode).toBe(401);
  });

  it('claims are rate limited per caller', async () => {
    api = await makeApi({ ctx: { settings: V05_ON }, api: { claimsPerMinute: 2 } });
    const bad = { code: 'B'.repeat(22) };
    expect((await v05Call(api, 'tcp', 'extPairClaim', { host: HOST, origin: EXT_ORIGIN }, bad)).statusCode).toBe(403);
    expect((await v05Call(api, 'tcp', 'extPairClaim', { host: HOST, origin: EXT_ORIGIN }, bad)).statusCode).toBe(403);
    const limited = await v05Call(api, 'tcp', 'extPairClaim', { host: HOST, origin: EXT_ORIGIN }, bad);
    expect(limited.statusCode).toBe(429);
    expect(ErrorBodySchema.parse(limited.json()).error.code).toBe('rate_limited');
  });
});
