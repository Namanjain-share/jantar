import { afterEach, describe, expect, it } from 'vitest';
import { DEVICE_COOKIE, ErrorBodySchema, ROUTES, type RouteDef, type RouteName } from '@jantar/protocol';
import { HOST, ORIGIN, h, makeApi, pairCookie, type TestApi } from './fakes.js';

const PARAMS: Record<string, string> = {
  sid: 'sess-aaaa-1111',
  id: '01JTESTPENDINGIDXXXXXXXXXXabcdefghijkl',
  jobId: '01JTESTJOBXXXXXXXXXXXXXXXX',
  // v0.5: the extension's client id, a screenshot id, an action item's place.
  clientId: '0b4e7c4e-0000-4000-8000-000000000000',
  shotId: '01JFZ8X8Y3T0V5G9WQK2M4N6PS',
  n: '0',
};

/** A body that passes validation for each write route (so 401/403 is about auth, not input). */
const BODIES: Partial<Record<RouteName, unknown>> = {
  sendPrompt: { text: 'hello' },
  decidePending: { behavior: 'allow' },
  patchSettings: { notify: { bodies: 'short' } },
  muteNotify: { minutes: 5 },
  pairStart: {},
  pairClaim: { code: 'A'.repeat(22), name: 'x' },
  // v0.5
  extPairClaim: { code: 'A'.repeat(22) },
  extMeetingLines: { lines: [] },
  extMeetingEnd: { reason: 'user', at: 0 },
  meetingUpdate: { name: 'Weekly sync' },
  pushSubscribe: { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } } },
  pushUnsubscribe: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' },
};

function urlOf(def: RouteDef): string {
  return def.path.replace(/:([A-Za-z]+)/g, (_m, n: string) => PARAMS[n] ?? 'x');
}

// v0.6's `node` routes read no device at all: 404 while Fleet is off, 403 with any Origin (v06-gate.test.ts).
const httpRoutes = (Object.entries(ROUTES) as [RouteName, RouteDef][]).filter(([, d]) => d.method !== 'WS' && d.scope !== 'node');
const protectedRoutes = httpRoutes.filter(([, d]) => d.scope !== 'public');
const writeRoutes = httpRoutes.filter(([, d]) => d.method !== 'GET');

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

async function call(name: RouteName, headers: Record<string, string>, url?: string) {
  const def = ROUTES[name] as RouteDef;
  const body = BODIES[name];
  return api.tcp.inject({
    method: def.method as Method,
    url: url ?? urlOf(def),
    headers,
    ...(body !== undefined ? { payload: body as object } : {}),
  });
}

describe('every /v1 route needs a paired device', () => {
  it('lists every v0.1 route in the protected set', () => {
    expect(protectedRoutes.length).toBeGreaterThanOrEqual(25);
    expect(protectedRoutes.every(([, d]) => d.path.startsWith('/v1/'))).toBe(true);
  });

  for (const [name, def] of protectedRoutes) {
    it(`${def.method} ${def.path} -> 401 without a device cookie`, async () => {
      api = await makeApi();
      const res = await call(name, h());
      expect(res.statusCode).toBe(401);
      expect(ErrorBodySchema.parse(res.json()).error.code).toBe('unauthorized');
      expect(res.headers['cache-control']).toBe('no-store');
    });
  }

  it('rejects unknown, malformed and revoked device keys', async () => {
    api = await makeApi();
    const { cookie, deviceId } = await pairCookie(api, ['read', 'control', 'admin']);
    for (const bad of [`${DEVICE_COOKIE}=garbage`, `${DEVICE_COOKIE}=${'A'.repeat(43)}`, 'other=1']) {
      const res = await api.tcp.inject({ method: 'GET', url: '/v1/state', headers: h(bad) });
      expect(res.statusCode).toBe(401);
    }
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/state', headers: h(cookie) })).statusCode).toBe(200);
    const rev = await api.tcp.inject({ method: 'DELETE', url: `/v1/devices/${deviceId}`, headers: h(cookie) });
    expect(rev.statusCode).toBe(200);
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/state', headers: h(cookie) })).statusCode).toBe(401);
  });

  it('never accepts the key from a header or the query string (no tokens in URLs)', async () => {
    api = await makeApi();
    const { cookie } = await pairCookie(api);
    const key = cookie.split('=')[1] as string;
    const viaQuery = await api.tcp.inject({ method: 'GET', url: `/v1/state?key=${key}&token=${key}&${DEVICE_COOKIE}=${key}`, headers: h() });
    expect(viaQuery.statusCode).toBe(401);
    const viaHeader = await api.tcp.inject({ method: 'GET', url: '/v1/state', headers: h(undefined, { authorization: `Bearer ${key}` }) });
    expect(viaHeader.statusCode).toBe(401);
  });

  it('does not treat a loopback peer as local: pair/start over TCP needs an admin device', async () => {
    api = await makeApi();
    // light-my-request connects from 127.0.0.1, like Tailscale Serve or a tunnel would.
    const res = await api.tcp.inject({ method: 'POST', url: '/v1/pair/start', headers: h(), payload: {}, remoteAddress: '127.0.0.1' });
    expect(res.statusCode).toBe(401);
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const phone = await api.tcp.inject({ method: 'POST', url: '/v1/pair/start', headers: h(cookie), payload: {} });
    expect(phone.statusCode).toBe(403);
  });
});

describe('Origin and Host checks', () => {
  for (const [name, def] of writeRoutes) {
    it(`${def.method} ${def.path} -> 403 with a wrong Origin`, async () => {
      api = await makeApi();
      const { cookie } = await pairCookie(api, ['read', 'control', 'admin']);
      const wrong = await call(name, { host: HOST, origin: 'https://evil.example', cookie });
      expect(wrong.statusCode).toBe(403);
      expect(ErrorBodySchema.parse(wrong.json()).error.code).toBe('forbidden');
      const missing = await call(name, { host: HOST, cookie });
      expect(missing.statusCode).toBe(403);
    });
  }

  it('accepts the configured public URL and extra origins', async () => {
    api = await makeApi({
      ctx: {
        settings: (await import('@jantar/protocol')).SettingsSchema.parse({
          remote: { mode: 'tailscale', publicUrl: 'https://mac.tailnet-example.ts.net', allowedOrigins: ['https://other.example'] },
        }),
      },
    });
    const { cookie } = await pairCookie(api);
    for (const origin of ['https://mac.tailnet-example.ts.net', 'https://other.example', 'http://localhost:7420']) {
      const res = await api.tcp.inject({ method: 'POST', url: '/v1/usage/refresh', headers: h(cookie, { origin }) });
      expect(res.statusCode, origin).toBe(202);
    }
    const viaServe = await api.tcp.inject({
      method: 'GET',
      url: '/v1/state',
      headers: { host: 'mac.tailnet-example.ts.net', cookie },
    });
    expect(viaServe.statusCode).toBe(200);
  });

  it('refuses unknown Host headers on every path (DNS rebinding)', async () => {
    api = await makeApi();
    const { cookie } = await pairCookie(api);
    for (const url of ['/v1/state', '/healthz', '/']) {
      const res = await api.tcp.inject({ method: 'GET', url, headers: { host: 'rebind.example:7420', cookie, origin: ORIGIN } });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it('WS /v1/events: 401 without a cookie, 403 with a wrong or missing Origin', async () => {
    api = await makeApi();
    await expect(api.tcp.injectWS('/v1/events', { headers: h() })).rejects.toThrow(/401/);
    const { cookie } = await pairCookie(api);
    await expect(api.tcp.injectWS('/v1/events', { headers: { host: HOST, origin: 'https://evil.example', cookie } })).rejects.toThrow(/403/);
    await expect(api.tcp.injectWS('/v1/events', { headers: { host: HOST, cookie } })).rejects.toThrow(/403/);
    const ws = await api.tcp.injectWS('/v1/events', { headers: h(cookie) });
    ws.terminate();
  });
});

describe('control socket', () => {
  it('serves ctl routes to the CLI without a cookie, and never approvals or pairing claims', async () => {
    api = await makeApi();
    expect((await api.ctl.inject({ method: 'GET', url: '/v1/state' })).statusCode).toBe(200);
    for (const [name, def] of httpRoutes.filter(([, d]) => !d.ctl)) {
      const res = await api.ctl.inject({
        method: def.method as Method,
        url: urlOf(def),
        ...(BODIES[name] !== undefined ? { payload: BODIES[name] as object } : {}),
      });
      expect(res.statusCode, `${def.method} ${def.path}`).toBe(404);
    }
  });
});
