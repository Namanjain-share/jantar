/**
 * SEC-2: the device cookie is not enough for writes or the event stream.
 *
 * Browsers send a 127.0.0.1 cookie to every port on 127.0.0.1, so whoever
 * runs or logs another loopback server can read it. Pairing therefore also
 * hands out a device secret that the web app keeps in IndexedDB (which is
 * per origin, port included) and sends as a header on writes and as a
 * WebSocket subprotocol. Reads keep working with the cookie alone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEVICE_COOKIE,
  DEVICE_SECRET_HEADER,
  ErrorBodySchema,
  EVENTS_WS_PROTOCOL,
  SettingsSchema,
  PairClaimResponseSchema,
  ROUTES,
  eventsSocketProtocols,
  secretFromSocketProtocols,
  type RouteDef,
  type RouteName,
} from '@jantar/protocol';
import { hashDeviceSecret } from '../../src/auth/devices.js';
import { needsDeviceSecret } from '../../src/api/app.js';
import { HOST, ORIGIN, bare, h, makeApi, makeCard, pairCookie, type TestApi } from './fakes.js';

const PARAMS: Record<string, string> = {
  sid: 'sess-aaaa-1111',
  id: '01JTESTPENDINGIDXXXXXXXXXXabcdefghijkl',
  jobId: '01JTESTJOBXXXXXXXXXXXXXXXX',
  // v0.5: the extension's client id, a screenshot id, an action item's place.
  clientId: '0b4e7c4e-0000-4000-8000-000000000000',
  shotId: '01JFZ8X8Y3T0V5G9WQK2M4N6PS',
  n: '0',
};

const BODIES: Partial<Record<RouteName, unknown>> = {
  sendPrompt: { text: 'hello' },
  decidePending: { behavior: 'allow' },
  patchSettings: { notify: { bodies: 'short' } },
  muteNotify: { minutes: 5 },
  pairStart: {},
  // v0.5
  meetingUpdate: { name: 'Weekly sync' },
  pushSubscribe: { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } } },
  pushUnsubscribe: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' },
};

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

function urlOf(def: RouteDef): string {
  return def.path.replace(/:([A-Za-z]+)/g, (_m, n: string) => PARAMS[n] ?? 'x');
}

const httpRoutes = (Object.entries(ROUTES) as [RouteName, RouteDef][]).filter(([, d]) => d.method !== 'WS');
const secretWrites = httpRoutes.filter(([, d]) => needsDeviceSecret(d));
const reads = httpRoutes.filter(([, d]) => d.method === 'GET' && d.scope !== 'public');

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

function call(name: RouteName, headers: Record<string, string>) {
  const def = ROUTES[name] as RouteDef;
  const body = BODIES[name];
  return api.tcp.inject({
    method: def.method as Method,
    url: urlOf(def),
    headers,
    ...(body !== undefined ? { payload: body as object } : {}),
  });
}

describe('which routes need the device secret', () => {
  it('every control, launch and admin write, and the event stream; never reads, push subscriptions or the pairing claim', () => {
    // v0.4's writes (every one at control scope) are swept in v04-auth.test.ts, v0.4.2's in v042-routes.test.ts,
    // v0.5's in v05-auth.test.ts.
    expect(
      secretWrites
        .filter(([, d]) => d.phase !== 'v0.4' && d.phase !== 'v0.4.2' && d.phase !== 'v0.5')
        .map(([n]) => n)
        .sort(),
    ).toEqual(
      [
        'decidePending',
        'focusSession',
        'muteNotify',
        'pairStart',
        'patchSettings',
        'refreshUsage',
        'revokeDevice',
        'sendPrompt',
        // v0.3
        'deviceScopes',
        'foldersCreate',
        'foldersPin',
        'launchAnswer',
        'launchStart',
        'rewriteCancel',
        'rewriteStart',
        'sessionCommand',
        'sessionKey',
        'sessionMode',
        // v0.5.3 (localOnly: over TCP they are refused anyway, after this check)
        'folderTodoCreate',
        'notifyTest',
      ].sort(),
    );
    expect(needsDeviceSecret(ROUTES.events)).toBe(true);
    for (const n of ['pairClaim', 'pushSubscribe', 'pushUnsubscribe', 'getState', 'listDevices', 'listAudit', 'extPairClaim', 'extMeetingLines'] as const) {
      expect(needsDeviceSecret(ROUTES[n]), n).toBe(false);
    }
  });
});

describe('pairing hands out a device secret', () => {
  it('returns it once in the claim reply, stores only its hash, and never shows it again', async () => {
    api = await makeApi();
    const start = await api.ctl.inject({ method: 'POST', url: '/v1/pair/start', payload: {} });
    const code = (start.json() as { code: string }).code;
    const res = await api.tcp.inject({ method: 'POST', url: '/v1/pair/claim', headers: { host: HOST, origin: ORIGIN }, payload: { code, name: 'Phone' } });
    expect(res.statusCode).toBe(200);
    const body = PairClaimResponseSchema.parse(res.json());
    expect(body.deviceSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookieKey = res.cookies.find((c) => c.name === DEVICE_COOKIE)?.value;
    expect(body.deviceSecret).not.toBe(cookieKey);
    // Not in the cookie, not in a header, not in the public device.
    expect(String(res.headers['set-cookie'])).not.toContain(body.deviceSecret);
    expect(JSON.stringify(body.device)).not.toContain('secret');

    const stored = api.ctx.db.devices.get(body.device.id);
    expect(stored?.secretHash).toBe(hashDeviceSecret(body.deviceSecret));
    expect(JSON.stringify(api.ctx.db.devices.list())).not.toContain(body.deviceSecret);
    const listed = await api.ctl.inject({ method: 'GET', url: '/v1/devices' });
    expect(listed.body).not.toContain(body.deviceSecret);
    expect(listed.body).not.toContain('secretHash');
    expect(JSON.stringify(api.ctx.db.audit.list())).not.toContain(body.deviceSecret);
  });

  it('each device gets its own secret', async () => {
    api = await makeApi();
    const a = await pairCookie(api);
    const b = await pairCookie(api);
    expect(a.secret).not.toBe(b.secret);
  });
});

describe('a replayed cookie alone cannot write', () => {
  for (const [name, def] of secretWrites) {
    it(`${def.method} ${def.path}: 401 with the cookie alone or a wrong secret, accepted with the right one`, async () => {
      api = await makeApi();
      const { cookie, secret } = await pairCookie(api, ['read', 'control', 'admin']);
      const alone = await call(name, bare(cookie));
      expect(alone.statusCode).toBe(401);
      expect(ErrorBodySchema.parse(alone.json()).error.code).toBe('unauthorized');
      expect(alone.json().error.message).toMatch(/device secret/);

      const wrong = await call(name, bare(cookie, { [DEVICE_SECRET_HEADER]: `${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}` }));
      expect(wrong.statusCode).toBe(401);
      for (const junk of ['', 'x', 'A'.repeat(500), `${secret} `]) {
        expect((await call(name, bare(cookie, { [DEVICE_SECRET_HEADER]: junk }))).statusCode, JSON.stringify(junk.slice(0, 8))).toBe(401);
      }

      const ok = await call(name, h(cookie));
      expect(ok.statusCode, ok.body).not.toBe(401);
    });
  }

  it("another device's secret does not unlock this cookie", async () => {
    api = await makeApi();
    const a = await pairCookie(api, ['read', 'control']);
    const b = await pairCookie(api, ['read', 'control']);
    const res = await api.tcp.inject({ method: 'POST', url: '/v1/usage/refresh', headers: bare(a.cookie, { [DEVICE_SECRET_HEADER]: b.secret }) });
    expect(res.statusCode).toBe(401);
    const own = await api.tcp.inject({ method: 'POST', url: '/v1/usage/refresh', headers: bare(a.cookie, { [DEVICE_SECRET_HEADER]: a.secret }) });
    expect(own.statusCode).toBe(202);
  });

  it('the secret alone (no cookie) is nothing', async () => {
    api = await makeApi();
    const { secret } = await pairCookie(api);
    const res = await api.tcp.inject({ method: 'POST', url: '/v1/usage/refresh', headers: bare(undefined, { [DEVICE_SECRET_HEADER]: secret }) });
    expect(res.statusCode).toBe(401);
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/state', headers: bare(undefined, { [DEVICE_SECRET_HEADER]: secret }) })).statusCode).toBe(401);
  });

  it('an approval from a replayed cookie never reaches the hooks bridge, and the refusal is audited', async () => {
    api = await makeApi();
    const { cookie, deviceId } = await pairCookie(api);
    const card = makeCard();
    api.ctx.store.emit({ type: 'pending.opened', sid: card.sid, data: { pending: card } });
    const res = await api.tcp.inject({
      method: 'POST',
      url: `/v1/pending/${card.id}/decision`,
      headers: bare(cookie),
      payload: { behavior: 'allow' },
    });
    expect(res.statusCode).toBe(401);
    expect(api.fakes.hooks.decisions).toHaveLength(0);
    const sent = await api.tcp.inject({ method: 'POST', url: '/v1/sessions/sess-aaaa-1111/prompt', headers: bare(cookie), payload: { text: 'rm -rf ~' } });
    expect(sent.statusCode).toBe(401);
    expect(api.fakes.writer.submits).toHaveLength(0);
    const audit = api.ctx.db.audit.list().filter((a) => a.actor === `device:${deviceId}` && a.action !== 'pairClaim');
    expect(audit.map((a) => `${a.action}:${a.result}`)).toEqual(['decidePending:refused', 'sendPrompt:refused']);
    expect(audit[0]?.detail).toMatch(/device secret/);
  });

  it('a device paired before device secrets existed can still read, but must pair again to write', async () => {
    api = await makeApi();
    const { cookie, deviceId, secret } = await pairCookie(api);
    // What a v0.1 database row looks like: no secret hash.
    const raw = api.ctx.db.devices.get(deviceId);
    if (!raw) throw new Error('no device');
    const { secretHash: _gone, ...legacy } = raw;
    const db = api.ctx.db as unknown as { devices: { insert(d: unknown): void } };
    const legacyCookie = await (async () => {
      const k = 'L'.repeat(43);
      const { hashDeviceKey } = await import('../../src/auth/devices.js');
      db.devices.insert({ ...legacy, id: `${deviceId}-legacy`, keyHash: hashDeviceKey(k) });
      return `${DEVICE_COOKIE}=${k}`;
    })();
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/state', headers: bare(legacyCookie) })).statusCode).toBe(200);
    for (const s of [undefined, secret]) {
      const res = await api.tcp.inject({
        method: 'POST',
        url: '/v1/usage/refresh',
        headers: bare(legacyCookie, s ? { [DEVICE_SECRET_HEADER]: s } : {}),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toMatch(/pair it again/);
    }
    // The freshly paired device next to it is unaffected.
    expect((await api.tcp.inject({ method: 'POST', url: '/v1/usage/refresh', headers: h(cookie) })).statusCode).toBe(202);
  });
});

describe('reads and the CLI', () => {
  for (const [name, def] of reads) {
    it(`${def.method} ${def.path} still works with the cookie alone`, async () => {
      api = await makeApi();
      const { cookie } = await pairCookie(api, ['read', 'control', 'admin']);
      const res = await call(name, bare(cookie));
      expect(res.statusCode, res.body).not.toBe(401);
    });
  }

  it('push subscriptions work with the cookie alone (the service worker re-subscribes without the page)', async () => {
    api = await makeApi();
    const { cookie } = await pairCookie(api);
    const sub = BODIES.pushSubscribe as { subscription: { endpoint: string } };
    expect((await api.tcp.inject({ method: 'POST', url: '/v1/push/subscribe', headers: bare(cookie), payload: sub })).statusCode).toBe(200);
    const del = await api.tcp.inject({ method: 'DELETE', url: '/v1/push/subscribe', headers: bare(cookie), payload: { endpoint: sub.subscription.endpoint } });
    expect(del.statusCode).toBe(200);
    expect(api.ctx.db.pushSubs.list()).toHaveLength(0);
  });

  it("removing another device's push subscription needs admin and the secret", async () => {
    api = await makeApi();
    const phone = await pairCookie(api);
    const admin = await pairCookie(api, ['admin']);
    const sub = BODIES.pushSubscribe as { subscription: { endpoint: string } };
    await api.tcp.inject({ method: 'POST', url: '/v1/push/subscribe', headers: h(phone.cookie), payload: sub });
    const body = { endpoint: sub.subscription.endpoint };
    await api.tcp.inject({ method: 'DELETE', url: '/v1/push/subscribe', headers: bare(admin.cookie), payload: body });
    expect(api.ctx.db.pushSubs.list()).toHaveLength(1);
    await api.tcp.inject({ method: 'DELETE', url: '/v1/push/subscribe', headers: h(admin.cookie), payload: body });
    expect(api.ctx.db.pushSubs.list()).toHaveLength(0);
  });

  it('the control socket needs no cookie and no secret', async () => {
    api = await makeApi();
    expect((await api.ctl.inject({ method: 'POST', url: '/v1/usage/refresh' })).statusCode).toBe(202);
    expect((await api.ctl.inject({ method: 'POST', url: '/v1/sessions/sess-aaaa-1111/prompt', payload: { text: 'hi' } })).statusCode).toBe(202);
    const ws = await api.ctl.injectWS('/v1/events');
    ws.terminate();
  });
});

describe('the event stream', () => {
  it('needs the secret: as a subprotocol (browsers) or a header (other clients); never the cookie alone', async () => {
    api = await makeApi();
    const { cookie, secret } = await pairCookie(api);
    await expect(api.tcp.injectWS('/v1/events', { headers: bare(cookie) })).rejects.toThrow(/401/);
    const wrong = eventsSocketProtocols('B'.repeat(43)).join(', ');
    await expect(api.tcp.injectWS('/v1/events', { headers: bare(cookie, { 'sec-websocket-protocol': wrong }) })).rejects.toThrow(/401/);
    const viaProtocol = await api.tcp.injectWS('/v1/events', {
      headers: bare(cookie, { 'sec-websocket-protocol': eventsSocketProtocols(secret).join(', ') }),
    });
    viaProtocol.terminate();
    const viaHeader = await api.tcp.injectWS('/v1/events', { headers: bare(cookie, { [DEVICE_SECRET_HEADER]: secret }) });
    viaHeader.terminate();
  });

  it('the subprotocol helpers round-trip and ignore junk', () => {
    const s = 'S'.repeat(43);
    expect(eventsSocketProtocols(s)[0]).toBe(EVENTS_WS_PROTOCOL);
    expect(secretFromSocketProtocols(eventsSocketProtocols(s).join(', '))).toBe(s);
    expect(secretFromSocketProtocols(eventsSocketProtocols(s).join(','))).toBe(s);
    expect(secretFromSocketProtocols(undefined)).toBeUndefined();
    expect(secretFromSocketProtocols('jantar')).toBeUndefined();
    expect(secretFromSocketProtocols('chat, superchat')).toBeUndefined();
    expect(secretFromSocketProtocols(['jantar', `jantar.secret.${s}`])).toBe(s);
  });
});

describe('through an https public URL the cookie alone is enough (it is host-bound there)', () => {
  // SEC-2 guards against browsers sending a 127.0.0.1 cookie to every port on 127.0.0.1. A cookie set
  // for the https public URL (Tailscale Serve, Cloudflare) only ever goes to that hostname. It also
  // matters on iPhone: a Home Screen app copies Safari's cookies but not its IndexedDB, so the secret
  // the web app stored while pairing in Safari is not there.
  const PUB = 'https://agent.example.com';
  const viaPublic = (cookie: string) => bare(cookie, { host: 'agent.example.com', origin: PUB });
  const withPublicUrl = (publicUrl: string) =>
    makeApi({ ctx: { settings: SettingsSchema.parse({ remote: { mode: 'cloudflare', publicUrl, allowedOrigins: [publicUrl] } }) } });

  it('writes with the cookie alone are accepted through the public hostname', async () => {
    api = await withPublicUrl(PUB);
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const res = await call('sendPrompt', viaPublic(cookie));
    expect(res.statusCode).not.toBe(401);
  });

  it('the same cookie on 127.0.0.1 still needs the secret', async () => {
    api = await withPublicUrl(PUB);
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const res = await call('sendPrompt', bare(cookie));
    expect(res.statusCode).toBe(401);
  });

  it('a public URL that is not https, or is an IP literal, does not count', async () => {
    for (const publicUrl of ['http://agent.example.com', 'https://192.168.1.4']) {
      api = await withPublicUrl(publicUrl);
      const { cookie } = await pairCookie(api, ['read', 'control']);
      const host = new URL(publicUrl).host;
      const res = await call('sendPrompt', bare(cookie, { host, origin: publicUrl }));
      expect(res.statusCode, publicUrl).toBe(401);
      await api.close();
    }
  });
});
