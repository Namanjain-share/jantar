/**
 * v0.6 Fleet, the API's gate (wave 0): the node routes and the node link's
 * upgrade (404 while Fleet is off, 403 with any Origin, no device cookie,
 * secret or extension key read there), the phone's event stream keeping its
 * 4096-byte frames, a server's session refused on the Mac-only routes, the
 * link transport (NODE_ROUTES only, the phone's scopes), and the forward
 * step (only with a target: the hub's own switch and idempotency cache are
 * skipped, a read-only hub forwards no write, a `?node=` naming no machine
 * never runs on the Mac).
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { NODE_SUPPLIED_ID } from '@jantar/protocol/node-link';
import { NODE_PREFIX, ROUTES, SettingsSchema, errorBody, type RouteName, type Session } from '@jantar/protocol';
import type { FleetService, FleetTarget, ForwardCall } from '../../src/contracts.js';
import { newId, newSecretId } from '../../src/core/ids.js';
import { buildApp } from '../../src/api/app.js';
import { installNodeUpgrade, refuseUpgrade } from '../../src/api/node-upgrade.js';
import { linkInjector } from '../../src/api/server.js';
import { offFleet } from '../../src/modes.js';
import { HOST, ORIGIN, h, makeApi, makeSession, pairCookie, type TestApi } from './fakes.js';

const NODE = '01JF1EETN0DEBV11D1000000A1';
const FLEET_ON = SettingsSchema.parse({ fleet: { enabled: true } });

/** A Fleet part that sends `sids` to NODE and records what it was asked. */
function fakeFleet(sids: readonly string[] = []) {
  const forwarded: { target: FleetTarget; call: ForwardCall }[] = [];
  const accepted: string[] = [];
  const paired: { rateKey: string }[] = [];
  const fleet: FleetService = {
    ...offFleet(),
    target: (route, params, query) => {
      if (params.sid !== undefined && sids.includes(params.sid)) return { nodeId: NODE, name: 'build-1' };
      if (query.node === NODE) return { nodeId: NODE, name: 'build-1' };
      return route === 'getSettings' ? { nodeId: NODE, name: 'build-1' } : null;
    },
    forward: async (target, call) => {
      forwarded.push({ target, call });
      return { status: 202, body: { forwarded: call.route } };
    },
    acceptLink: (req, socket) => {
      accepted.push(req.url ?? '');
      refuseUpgrade(socket, 501, 'not_implemented', 'a fake link server');
    },
    pair: async (_body, meta) => {
      paired.push(meta);
      return { ok: false, code: 'unauthorized', reason: 'this join line is not valid (used, expired or mistyped): make a new one at the Mac' };
    },
  };
  return { fleet, forwarded, accepted, paired };
}

const nodeSession = (over: Partial<Session> = {}): Session => makeSession({ sid: 'node-sess-1', node: NODE, tty: '/dev/pts/3', ...over });

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

/** An upgrade through the dispatcher (installed as the server does), answered with the status the upgrade got. */
async function upgrade(a: TestApi, path: string, headers: Record<string, string>): Promise<number> {
  const drop = installNodeUpgrade(a.tcp.server, a.services);
  try {
    await a.tcp.injectWS(path, { headers });
    return 101;
  } catch (e) {
    const m = /response: (\d+)/.exec(String(e));
    return m ? Number(m[1]) : -1;
  } finally {
    drop();
  }
}

describe('v0.6: the node routes', () => {
  it('POST /v1/node/pair is 404 while Fleet is off, cookie or not', async () => {
    api = await makeApi();
    const { cookie } = await pairCookie(api, ['read', 'control', 'admin']);
    for (const headers of [{ host: HOST }, { host: HOST, cookie }, h(cookie)]) {
      const res = await api.tcp.inject({ method: 'POST', url: ROUTES.nodePair.path, headers, payload: { code: 'c'.repeat(22) } });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(errorBody('not_found', 'not found'));
    }
  });

  it('with Fleet on: 403 with any Origin; without one it reaches the Fleet part, reading no cookie or secret', async () => {
    const f = fakeFleet();
    api = await makeApi({ ctx: { settings: FLEET_ON }, deps: () => ({ fleet: f.fleet }) });
    const { cookie } = await pairCookie(api, ['read', 'control', 'admin']);
    const body = { code: 'c'.repeat(22), publicKey: Buffer.alloc(32, 1).toString('base64url'), os: 'linux', version: '0.6.0', proto: 1 };
    for (const origin of [ORIGIN, 'https://evil.example', 'null']) {
      const res = await api.tcp.inject({ method: 'POST', url: ROUTES.nodePair.path, headers: { host: HOST, origin, cookie }, payload: body });
      expect(res.statusCode, origin).toBe(403);
    }
    expect(f.paired).toEqual([]);
    // A paired phone's cookie and secret change nothing: the claim is answered as from nobody.
    const res = await api.tcp.inject({ method: 'POST', url: ROUTES.nodePair.path, headers: { ...h(cookie), origin: '' }, payload: body });
    expect(res.statusCode).toBe(403);
    const plain = await api.tcp.inject({ method: 'POST', url: ROUTES.nodePair.path, headers: { host: HOST, cookie, 'x-jantar-device-secret': 'x' }, payload: body });
    expect(plain.statusCode).toBe(401);
    expect(f.paired).toHaveLength(1);
    // The refusal is audited as nobody's, never with the code.
    const row = api.ctx.db.audit.list().find((a) => a.action === 'node.pair');
    expect(row).toMatchObject({ actor: 'anonymous', result: 'refused' });
    expect(JSON.stringify(api.ctx.db.audit.list())).not.toContain(body.code);
    // Unknown Host: the DNS-rebinding guard, as everywhere.
    expect((await api.tcp.inject({ method: 'POST', url: ROUTES.nodePair.path, headers: { host: 'evil.example' }, payload: body })).statusCode).toBe(403);
  });

  it('is under NODE_PREFIX, the one prefix whose paths read no device cookie', () => {
    expect(ROUTES.nodePair.path.startsWith(NODE_PREFIX)).toBe(true);
    for (const [name, def] of Object.entries(ROUTES)) if (def.path.startsWith(NODE_PREFIX)) expect(def.scope, name).toBe('node');
  });
});

describe('v0.6: the node link upgrade', () => {
  it('is 404 while Fleet is off', async () => {
    const f = fakeFleet();
    api = await makeApi({ deps: () => ({ fleet: f.fleet }) });
    expect(await upgrade(api, '/v1/node/link', { host: HOST })).toBe(404);
    expect(f.accepted).toEqual([]);
  });

  it('with Fleet on: 403 with an Origin or an unknown Host; else handed to the Fleet part', async () => {
    const f = fakeFleet();
    api = await makeApi({ ctx: { settings: FLEET_ON }, deps: () => ({ fleet: f.fleet }) });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    expect(await upgrade(api, '/v1/node/link', { host: HOST, origin: ORIGIN, cookie })).toBe(403);
    expect(await upgrade(api, '/v1/node/link', { host: 'evil.example' })).toBe(403);
    expect(f.accepted).toEqual([]);
    await upgrade(api, '/v1/node/link?x=1', { host: HOST, cookie });
    expect(f.accepted).toEqual(['/v1/node/link?x=1']);
  });

  it("wave 0's link server refuses every upgrade with 503", async () => {
    api = await makeApi({ ctx: { settings: FLEET_ON } });
    const { createFleet } = await import('../../src/fleet/index.js');
    api = await makeApi({ ctx: { settings: FLEET_ON }, deps: (ctx) => ({ fleet: createFleet(ctx, {}) }) });
    expect(await upgrade(api, '/v1/node/link', { host: HOST })).toBe(503);
  });

  it("leaves every other upgrade to Fastify: the phone's stream still works and still closes 1009 past 4096 bytes", async () => {
    api = await makeApi({ ctx: { settings: FLEET_ON } });
    const { cookie, secret } = await pairCookie(api, ['read', 'control']);
    const drop = installNodeUpgrade(api.tcp.server, api.services);
    try {
      const closed = new Promise<number>((resolve, reject) => {
        api.tcp
          .injectWS('/v1/events', { headers: { host: HOST, origin: ORIGIN, cookie, 'sec-websocket-protocol': `jantar, jantar.secret.${secret}` } }, {
            onInit: (ws) => ws.on('close', (code: number) => resolve(code)),
          })
          .then((ws) => ws.send('x'.repeat(4097)), reject);
      });
      expect(await closed).toBe(1009);
      // An unknown path is Fastify's 404, as before.
      await expect(api.tcp.injectWS('/v1/nope', { headers: { host: HOST, origin: ORIGIN, cookie } })).rejects.toThrow(/404/);
    } finally {
      drop();
    }
  });
});

describe("v0.6: a server's session on the hub", () => {
  it('is refused 409 node_unsupported on the routes that work for the Mac only, and read from state by getSession', async () => {
    api = await makeApi({ sessions: [makeSession(), nodeSession()], ctx: { settings: SettingsSchema.parse({ files: { enabled: true }, screenshots: { enabled: true } }) } });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    for (const url of ['/v1/sessions/node-sess-1/screenshot', '/v1/sessions/node-sess-1/changes']) {
      const res = await api.tcp.inject({ method: 'GET', url, headers: h(cookie) });
      expect(res.statusCode, url).toBe(409);
      expect(res.json().error.code).toBe('node_unsupported');
    }
    const one = await api.tcp.inject({ method: 'GET', url: '/v1/sessions/node-sess-1', headers: h(cookie) });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ session: { sid: 'node-sess-1', node: NODE }, pane: null });
    expect(api.fakes.terminal.calls.filter((c) => c.startsWith('findPane'))).toEqual([]);
  });
});

describe('v0.6: the forward step', () => {
  it("forwards a target's call past the hub's own switch, without the hub's idempotency cache", async () => {
    const f = fakeFleet(['node-sess-1']);
    // Controls are off on the Mac: the node's own switch decides for its sessions.
    api = await makeApi({
      sessions: [makeSession(), nodeSession()],
      ctx: { settings: SettingsSchema.parse({ controls: { enabled: false } }) },
      deps: () => ({ fleet: f.fleet }),
    });
    const { cookie, deviceId } = await pairCookie(api, ['read', 'control', 'admin']);
    const key = randomUUID();
    for (let i = 0; i < 2; i++) {
      const res = await api.tcp.inject({ method: 'POST', url: '/v1/sessions/node-sess-1/keys', headers: h(cookie, { 'idempotency-key': key }), payload: { key: 'enter' } });
      expect(res.statusCode).toBe(202);
      expect(res.headers['idempotent-replayed']).toBeUndefined();
    }
    expect(f.forwarded).toHaveLength(2);
    expect(f.forwarded[0]?.call).toMatchObject({
      route: 'sessionKey',
      params: { sid: 'node-sess-1' },
      body: { key: 'enter' },
      idem: `${deviceId}:${key}`,
      // An admin phone's scopes go without admin (the chain gave it launch).
      actor: { deviceId, deviceName: 'Test phone', scopes: ['read', 'control', 'launch'] },
    });
    // The hub's own session: its switch still applies, and nothing is forwarded.
    const mac = await api.tcp.inject({ method: 'POST', url: '/v1/sessions/sess-aaaa-1111/keys', headers: h(cookie), payload: { key: 'enter' } });
    expect(mac.statusCode).toBe(403);
    expect(f.forwarded).toHaveLength(2);
    // Audited with its node, never the body.
    const row = api.ctx.db.audit.list().filter((a) => a.action === 'sessionKey' && a.target === 'node-sess-1').at(-1);
    expect(row).toMatchObject({ params: { node: NODE }, result: 'ok' });
  });

  it("audits a refused forward by its error code only: the server's own words never reach the Mac's audit log", async () => {
    const f = fakeFleet(['node-sess-1']);
    const said = 'PLANTED server text '.repeat(25);
    const fleet: FleetService = {
      ...f.fleet,
      forward: async (_t, call) =>
        call.route === 'sessionKey' ? { status: 409, body: { error: { code: 'conflict', message: said } } } : { status: 500, body: { error: { code: 'made-up', message: said } } },
    };
    api = await makeApi({ sessions: [nodeSession()], deps: () => ({ fleet }) });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    expect((await api.tcp.inject({ method: 'POST', url: '/v1/sessions/node-sess-1/keys', headers: h(cookie), payload: { key: 'enter' } })).statusCode).toBe(409);
    expect((await api.tcp.inject({ method: 'POST', url: '/v1/sessions/node-sess-1/prompt', headers: h(cookie), payload: { text: 'hi' } })).statusCode).toBe(500);
    const rows = api.ctx.db.audit.list().filter((a) => a.target === 'node-sess-1');
    expect(rows.map((r) => [r.action, r.detail])).toEqual([
      ['sessionKey', 'conflict'],
      ['sendPrompt', undefined],
    ]);
    expect(JSON.stringify(api.ctx.db.audit.list())).not.toContain('PLANTED');
  });

  it('still checks the device, scope, Origin and secret first, and the body', async () => {
    const f = fakeFleet(['node-sess-1']);
    api = await makeApi({ sessions: [nodeSession()], deps: () => ({ fleet: f.fleet }) });
    const reader = await pairCookie(api, ['read']);
    const control = await pairCookie(api, ['read', 'control']);
    const prompt = (headers: Record<string, string>, payload: unknown) =>
      api.tcp.inject({ method: 'POST', url: '/v1/sessions/node-sess-1/prompt', headers, payload: payload as object });
    expect((await prompt(h(), { text: 'hi' })).statusCode).toBe(401);
    expect((await prompt(h(reader.cookie), { text: 'hi' })).statusCode).toBe(403);
    expect((await prompt({ ...h(control.cookie), origin: 'https://evil.example' }, { text: 'hi' })).statusCode).toBe(403);
    expect((await prompt(h(control.cookie), { text: '' })).statusCode).toBe(400);
    expect((await prompt(h(control.cookie, { 'idempotency-key': 'k'.repeat(200) }), { text: 'hi' })).statusCode).toBe(400);
    expect(f.forwarded).toEqual([]);
    expect((await prompt(h(control.cookie), { text: 'fix the tests;' })).statusCode).toBe(202);
    expect(f.forwarded[0]?.call.body).toMatchObject({ text: 'fix the tests;', onDraft: 'refuse' });
  });

  it('a read-only hub forwards reads, never writes', async () => {
    const f = fakeFleet(['node-sess-1']);
    api = await makeApi({ sessions: [nodeSession()], api: { mode: { readOnly: true, terminal: 'terminal-app' } }, deps: () => ({ fleet: f.fleet }) });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const write = await api.tcp.inject({ method: 'POST', url: '/v1/sessions/node-sess-1/prompt', headers: h(cookie), payload: { text: 'hi' } });
    expect(write.statusCode).toBe(403);
    const read = await api.tcp.inject({ method: 'GET', url: '/v1/sessions/node-sess-1/screen', headers: h(cookie) });
    expect(read.statusCode).toBe(202);
    expect(f.forwarded.map((x) => x.call.route)).toEqual(['getScreen']);
  });

  it('?node= naming no paired machine is 404 and never runs on the Mac; a known one is forwarded without it', async () => {
    api = await makeApi({ ctx: { settings: SettingsSchema.parse({ launch: { enabled: true } }) } });
    const { cookie } = await pairCookie(api, ['read', 'control', 'launch']);
    const unknown = await api.tcp.inject({ method: 'GET', url: `/v1/folders/roots?node=${NODE}`, headers: h(cookie) });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual(errorBody('not_found', 'no such machine'));
    await api.close();
    const f = fakeFleet();
    api = await makeApi({ deps: () => ({ fleet: f.fleet }) });
    const c2 = await pairCookie(api, ['read', 'control', 'launch']);
    // Starting sessions is off on the Mac: the node's own switch decides.
    const res = await api.tcp.inject({ method: 'GET', url: `/v1/folders?root=r.work&path=a&node=${NODE}`, headers: h(c2.cookie) });
    expect(res.statusCode).toBe(202);
    expect(f.forwarded[0]?.call).toMatchObject({ route: 'foldersList', query: { root: 'r.work', path: 'a' } });
    expect(f.forwarded[0]?.call.query.node).toBeUndefined();
  });

  it('never forwards a route outside NODE_ROUTES, whatever the Fleet part says', async () => {
    const f = fakeFleet();
    api = await makeApi({ deps: () => ({ fleet: f.fleet }) });
    const { cookie } = await pairCookie(api, ['read', 'control', 'admin']);
    // fakeFleet targets getSettings: the pipeline never asks for it.
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/settings', headers: h(cookie) })).statusCode).toBe(200);
    expect(f.forwarded).toEqual([]);
  });

  it('the CLI forwards as `cli`, with read, control and launch', async () => {
    const f = fakeFleet(['node-sess-1']);
    api = await makeApi({ sessions: [nodeSession()], deps: () => ({ fleet: f.fleet }) });
    const res = await api.ctl.inject({ method: 'POST', url: '/v1/sessions/node-sess-1/prompt', payload: { text: 'hi' } });
    expect(res.statusCode).toBe(202);
    expect(f.forwarded[0]?.call.actor).toEqual({ deviceId: 'cli', deviceName: 'cli', scopes: ['read', 'control', 'launch'] });
  });
});

describe('v0.6: the link transport (a node runs the hub calls)', () => {
  it('serves NODE_ROUTES only, as the device hub.<id> with the phone scopes', async () => {
    api = await makeApi();
    const link = await buildApp(api.services, 'link');
    try {
      const inject = linkInjector(link, api.services);
      const phone = { deviceId: 'dev-1', deviceName: 'Sam phone', scopes: ['read', 'control'] as ('read' | 'control')[] };
      // Outside NODE_ROUTES: not there at all.
      for (const url of ['/v1/settings', '/v1/state', '/v1/devices', '/v1/life/status', '/healthz', '/ctl/status']) {
        expect((await inject.inject({ method: 'GET', url, actor: phone })).status, url).toBe(404);
      }
      // A NODE_ROUTE runs with the phone's scopes: a read-only phone cannot prompt.
      const reader = await inject.inject({ method: 'POST', url: '/v1/sessions/sess-aaaa-1111/prompt', actor: { ...phone, scopes: ['read'] }, body: { text: 'hi' } });
      expect(reader.status).toBe(403);
      const ok = await inject.inject({ method: 'POST', url: '/v1/sessions/sess-aaaa-1111/prompt', actor: phone, body: { text: 'hi' }, idem: 'dev-1:k1' });
      expect(ok.status).toBe(202);
      expect(api.fakes.writer.submits[0]?.actor).toEqual({ kind: 'device', deviceId: 'hub.dev-1', scopes: ['read', 'control'] });
      // The node's own idempotency cache replays.
      await inject.inject({ method: 'POST', url: '/v1/sessions/sess-aaaa-1111/prompt', actor: phone, body: { text: 'hi' }, idem: 'dev-1:k1' });
      expect(api.fakes.writer.submits).toHaveLength(1);
      // Nobody outside the process can call it: no token, no caller.
      expect((await link.inject({ method: 'GET', url: '/v1/sessions/sess-aaaa-1111/screen' })).statusCode).toBe(401);
      expect(api.services.linkCalls.size).toBe(0);
    } finally {
      await link.close();
    }
  });
});

describe('v0.6: ids a node supplies', () => {
  it('every id format the daemon makes fits NODE_SUPPLIED_ID', () => {
    for (const id of [newId(), newSecretId(), randomUUID(), newId().toLowerCase()]) expect(NODE_SUPPLIED_ID.test(id), id).toBe(true);
  });

  it('every NODE_ROUTE has a handler (the link app registers each)', async () => {
    const { ROUTE_IMPLS } = await import('../../src/api/routes.js');
    const { NODE_ROUTES } = await import('@jantar/protocol/node-link');
    for (const name of Object.keys(NODE_ROUTES) as RouteName[]) expect(ROUTE_IMPLS[name], name).toBeDefined();
  });
});
