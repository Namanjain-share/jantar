/**
 * WP0's v0.3 API plumbing: every v0.3 route is wired (a stub answers 501
 * until its package lands), each switch closes its routes with 403 before
 * any handler runs, Mac-only settings, rewriteJobId on sends, raw replies,
 * the launch scope, scopes granted on the Mac only, and the feature switches
 * in daemon.version.
 */
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LAUNCH_FLAGS,
  ErrorBodySchema,
  MAC_ONLY_SETTING_GROUPS,
  ROUTES,
  SettingsSchema,
  settingsFeatures,
  type RouteDef,
  type RouteName,
  type Settings,
} from '@jantar/protocol';
import type { Actor, RewriteService } from '../../src/contracts.js';
import { notBuiltParts } from '../../src/core/testing.js';
import { FEATURE_OFF, LOCAL_ONLY_REFUSED, NO_TERMINAL_REFUSED, READ_ONLY_REFUSED } from '../../src/api/app.js';
import { ROUTE_IMPLS, type RawReply } from '../../src/api/routes.js';
import { ApiServerImpl } from '../../src/api/server.js';
import { createTestContext } from '../../src/core/testing.js';
import { depsOf, h, makeApi, makeFakes, pairCookie, type TestApi } from './fakes.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const ALL_ON: Settings = SettingsSchema.parse({
  files: { enabled: true },
  launch: { enabled: true },
  rewrite: { enabled: true },
  controls: { enabled: true },
  screenshots: { enabled: true },
});
const ALL_OFF: Settings = SettingsSchema.parse({ controls: { enabled: false } });

const PARAMS: Record<string, string> = { sid: 'sess-aaaa-1111', jobId: 'rw-0001', id: 'l-0001', changeId: 'c-0001' };

/** A request that passes validation for every v0.3 route, so a status says something about the pipeline. */
const REQ: Partial<Record<RouteName, { query?: string; body?: unknown }>> = {
  rewriteStart: { body: { text: 'fix the flaky test' } },
  filesList: { query: '?root=r.work' },
  filesStat: { query: '?root=r.work&path=a.ts' },
  filesText: { query: '?root=r.work&path=a.ts' },
  filesRaw: { query: '?root=r.work&path=a.png' },
  foldersList: { query: '?root=r.work' },
  foldersPin: { body: { root: 'r.work', path: 'foo', pinned: true } },
  foldersCreate: { body: { root: 'r.work', parent: '', name: 'new-app' } },
  launchPreview: { query: '?root=r.work&path=foo' },
  launchStart: { body: { root: 'r.work', path: 'foo', account: 'auto', flags: DEFAULT_LAUNCH_FLAGS } },
  launchAnswer: { body: { option: 0, title: 'Do you trust the files in this folder?' } },
  deviceScopes: { body: { add: ['launch'] } },
  sessionKey: { body: { key: 'interrupt' } },
  sessionMode: { body: { mode: 'plan' } },
  sessionCommand: { body: { name: 'compact' } },
};

const v03 = (Object.entries(ROUTES) as [RouteName, RouteDef][]).filter(([, d]) => d.phase === 'v0.3');

function urlOf(name: RouteName, def: RouteDef): string {
  return def.path.replace(/:([A-Za-z]+)/g, (_m, n: string) => PARAMS[n] ?? 'x') + (REQ[name]?.query ?? '');
}

function call(api: TestApi, transport: 'tcp' | 'ctl', name: RouteName, headers: Record<string, string> = {}) {
  const def = ROUTES[name] as RouteDef;
  const body = REQ[name]?.body;
  return api[transport].inject({
    method: def.method as Method,
    url: urlOf(name, def),
    headers,
    ...(body !== undefined ? { payload: body as object } : {}),
  });
}

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

describe('v0.3 routes are wired', () => {
  it('every route in the table has a handler (26 of them v0.3)', () => {
    for (const name of Object.keys(ROUTES) as RouteName[]) {
      if (name === 'health' || name === 'events') continue;
      expect(ROUTE_IMPLS[name], name).toBeDefined();
    }
    expect(v03.length).toBe(26);
  });

  it('with every switch on, each stub answers 501 over TCP (and over ctl.sock where served)', async () => {
    api = await makeApi({ ctx: { settings: ALL_ON } });
    const { cookie } = await pairCookie(api, ['admin']);
    for (const [name, def] of v03) {
      if (!ROUTE_IMPLS[name]?.stub) continue;
      if (def.localOnly) {
        // Never served over TCP ('scopes' below); the CLI reaches the stub.
        expect((await call(api, 'ctl', name)).statusCode, `ctl ${name}`).toBe(501);
        continue;
      }
      const res = await call(api, 'tcp', name, h(cookie));
      expect(res.statusCode, `${name} ${res.body}`).toBe(501);
      expect(ErrorBodySchema.parse(res.json()).error.code).toBe('not_implemented');
      expect(res.headers['cache-control']).toBe('no-store');
      const viaCtl = await call(api, 'ctl', name);
      expect(viaCtl.statusCode, `ctl ${name}`).toBe(def.ctl ? 501 : 404);
    }
  });

  it('the stub parts behind them throw NotImplementedError, which the API turns into 501', async () => {
    api = await makeApi({ ctx: { settings: ALL_ON } });
    const rewrite = notBuiltParts().rewrite;
    expect(() => rewrite.get('x', { kind: 'cli' })).toThrow(/not built yet/);
    const res = await api.tcp.inject({
      method: 'POST',
      url: '/v1/sessions/sess-aaaa-1111/prompt',
      headers: h((await pairCookie(api)).cookie),
      payload: { text: 'go', rewriteJobId: 'rw-1' },
    });
    expect(res.statusCode).toBe(501);
    expect(api.fakes.writer.submits).toHaveLength(0);
  });
});

describe('feature switches', () => {
  it('with a switch off, every route behind it answers 403 with the sentence that turns it on, before validation', async () => {
    api = await makeApi({ ctx: { settings: ALL_OFF } });
    const { cookie } = await pairCookie(api, ['admin']);
    for (const [name, def] of v03) {
      if (!def.feature) continue;
      const res = await call(api, 'tcp', name, h(cookie));
      const off = FEATURE_OFF[def.feature];
      expect(res.statusCode, name).toBe(403);
      expect(ErrorBodySchema.parse(res.json()).error).toEqual({ code: off.code, message: off.message });
      // An invalid body is still a 403, not a 400: the switch is checked first.
      if (def.method !== 'GET' && REQ[name]?.body !== undefined) {
        const bad = await api.tcp.inject({ method: def.method as Method, url: urlOf(name, def), headers: h(cookie), payload: { nonsense: 1 } });
        expect(bad.statusCode, `${name} bad body`).toBe(403);
      }
      if (def.ctl) expect((await call(api, 'ctl', name)).statusCode, `ctl ${name}`).toBe(403);
    }
    expect(FEATURE_OFF.screenshots.code).toBe('screenshots_off');
    expect(FEATURE_OFF.files.message).toContain('jantar files on');
  });

  it('no handler runs while its switch is off', async () => {
    api = await makeApi({ ctx: { settings: ALL_OFF } });
    const { cookie } = await pairCookie(api, ['admin']);
    const spies = v03.filter(([, d]) => d.feature).map(([name]) => vi.spyOn(ROUTE_IMPLS[name] as { handle: () => unknown }, 'handle'));
    for (const [name, def] of v03) if (def.feature) await call(api, 'tcp', name, h(cookie));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('device scopes are behind no switch', async () => {
    api = await makeApi({ ctx: { settings: ALL_OFF } });
    // 501 while it is a stub; whatever its handler answers later, the switches never close it.
    expect((await call(api, 'ctl', 'deviceScopes')).statusCode).not.toBe(403);
  });

  it('a switch turned on at the Mac opens its routes at once', async () => {
    api = await makeApi({ ctx: { settings: ALL_OFF } });
    const { cookie } = await pairCookie(api, ['admin']);
    expect((await call(api, 'tcp', 'filesRoots', h(cookie))).statusCode).toBe(403);
    expect((await api.ctl.inject({ method: 'PATCH', url: '/v1/settings', payload: { files: { enabled: true } } })).statusCode).toBe(200);
    expect((await call(api, 'tcp', 'filesRoots', h(cookie))).statusCode).toBe(501);
  });
});

describe('scopes', () => {
  // Past the scope check a stub answers 501 and a built handler something of its own; neither is 401 or 403.
  const passed = (status: number) => status !== 401 && status !== 403;

  it('launching needs the launch scope: control devices are refused, launch and admin devices pass', async () => {
    api = await makeApi({ ctx: { settings: ALL_ON } });
    const phone = await pairCookie(api, ['read', 'control']);
    const launchPhone = await pairCookie(api, ['launch']);
    expect(api.ctx.db.devices.get(launchPhone.deviceId)?.scopes).toEqual(['read', 'control', 'launch']);
    const admin = await pairCookie(api, ['admin']);
    for (const name of ['foldersCreate', 'launchStart', 'launchAnswer'] as const) {
      const refused = await call(api, 'tcp', name, h(phone.cookie));
      expect(refused.statusCode, name).toBe(403);
      expect(refused.json().error.message, name).toMatch(/launch/);
      expect(passed((await call(api, 'tcp', name, h(launchPhone.cookie))).statusCode), name).toBe(true);
      expect(passed((await call(api, 'tcp', name, h(admin.cookie))).statusCode), name).toBe(true);
    }
    // Control-scope v0.3 routes stay open to a control device.
    expect(passed((await call(api, 'tcp', 'launchPreview', h(phone.cookie))).statusCode)).toBe(true);
    expect((await call(api, 'tcp', 'deviceScopes', h(launchPhone.cookie))).statusCode).toBe(403);
  });

  it('scopes are granted on the Mac only: over TCP even an admin device is refused, before the handler', async () => {
    api = await makeApi({ ctx: { settings: ALL_ON } });
    const admin = await pairCookie(api, ['admin']);
    const phone = await pairCookie(api, ['read', 'control']);
    const handle = vi.spyOn(ROUTE_IMPLS.deviceScopes as { handle: () => unknown }, 'handle');
    const url = `/v1/devices/${phone.deviceId}/scopes`;
    const res = await api.tcp.inject({ method: 'POST', url, headers: h(admin.cookie), payload: { add: ['launch', 'admin'] } });
    expect(res.statusCode).toBe(403);
    expect(ErrorBodySchema.parse(res.json()).error).toEqual({ code: 'forbidden', message: LOCAL_ONLY_REFUSED.deviceScopes });
    expect(res.json().error.message).toContain('jantar devices grant');
    // A device without admin keeps its own scope refusal.
    const self = await api.tcp.inject({ method: 'POST', url, headers: h(phone.cookie), payload: { add: ['admin'] } });
    expect(self.statusCode).toBe(403);
    expect(self.json().error.message).toMatch(/admin scope/);
    expect(handle).not.toHaveBeenCalled();
    expect(api.ctx.db.devices.get(phone.deviceId)?.scopes).toEqual(['read', 'control']);
    expect(api.ctx.db.audit.list().find((a) => a.action === 'deviceScopes' && a.actor === `device:${admin.deviceId}`)?.result).toBe('refused');
    // Every localOnly route has its sentence.
    for (const [name, def] of Object.entries(ROUTES) as [RouteName, RouteDef][]) if (def.localOnly) expect(LOCAL_ONLY_REFUSED[name], name).toBeDefined();
    // The CLI reaches it: 501 while it is a stub, WP-L's answer once it lands.
    const viaCtl = await api.ctl.inject({ method: 'POST', url, payload: { add: ['launch'] } });
    if (ROUTE_IMPLS.deviceScopes?.stub) expect(viaCtl.statusCode).toBe(501);
    else expect(passed(viaCtl.statusCode)).toBe(true);
  });

  it('a default pairing never gets launch, and only the Mac hands it out (an admin device over TCP too is refused)', async () => {
    api = await makeApi();
    const phone = await pairCookie(api);
    expect(api.ctx.db.devices.get(phone.deviceId)?.scopes).toEqual(['read', 'control']);
    const res = await api.tcp.inject({ method: 'POST', url: '/v1/pair/start', headers: h(phone.cookie), payload: { scopes: ['launch'] } });
    expect(res.statusCode).toBe(403);
    const admin = await pairCookie(api, ['admin']);
    const before = api.ctx.db.devices.list().length;
    for (const scopes of [['launch'], ['read', 'control', 'admin']]) {
      const byAdmin = await api.tcp.inject({ method: 'POST', url: '/v1/pair/start', headers: h(admin.cookie), payload: { scopes } });
      expect(byAdmin.statusCode).toBe(403);
      expect(byAdmin.json().error.message).toMatch(/on the Mac: jantar (pair --admin|devices grant <device> launch)$/);
      expect(byAdmin.json().url).toBeUndefined();
    }
    // An admin device may still make a read and control code.
    expect((await api.tcp.inject({ method: 'POST', url: '/v1/pair/start', headers: h(admin.cookie), payload: { scopes: ['read', 'control'] } })).statusCode).toBe(200);
    expect(api.ctx.db.devices.list().length).toBe(before);
    expect((await api.ctl.inject({ method: 'POST', url: '/v1/pair/start', payload: { scopes: ['launch'] } })).statusCode).toBe(200);
  });
});

describe('Mac-only settings', () => {
  it('TCP patches touching a Mac-only group are refused even for an admin device; ctl.sock may change them', async () => {
    api = await makeApi();
    const { cookie } = await pairCookie(api, ['admin']);
    const samples: Record<(typeof MAC_ONLY_SETTING_GROUPS)[number], unknown> = {
      files: { enabled: true },
      folders: { showHidden: true },
      launch: { enabled: true },
      rewrite: { enabled: true },
      bins: { cswap: '/opt/homebrew/bin/cswap' },
      remote: { allowedOrigins: ['https://x.example'] },
      controls: { escapeVerified: true },
      screenshots: { enabled: true },
      // v0.4's groups (v04-settings.test.ts covers them on their own).
      life: { todos: true },
      intel: { enabled: true },
      accounts: { kept: [3] },
      // v0.5's (v05-settings.test.ts covers it on its own).
      meetings: { enabled: true },
      // v0.6's Fleet switch (v06-gate.test.ts).
      fleet: { enabled: true },
    };
    for (const [group, value] of Object.entries(samples)) {
      const patch = { notify: { bodies: 'short' }, [group]: value };
      const res = await api.tcp.inject({ method: 'PATCH', url: '/v1/settings', headers: h(cookie), payload: patch });
      expect(res.statusCode, group).toBe(403);
      expect(res.json().error.message).toMatch(new RegExp(`${group} settings can only be changed on the Mac: jantar `));
    }
    expect(api.ctx.settings.get().notify.bodies).toBe('full');
    expect((await api.tcp.inject({ method: 'PATCH', url: '/v1/settings', headers: h(cookie), payload: { notify: { bodies: 'short' } } })).statusCode).toBe(200);
    for (const [group, value] of Object.entries(samples)) {
      if (group === 'bins') continue; // the path must exist on this machine
      expect((await api.ctl.inject({ method: 'PATCH', url: '/v1/settings', payload: { [group]: value } })).statusCode, group).toBe(200);
    }
    expect(api.ctx.settings.get().files.enabled).toBe(true);
  });
});

describe('sendPrompt with a rewrite job', () => {
  function fakeRewrite(origin: 'rewrite' | 'rewrite-edited' | null) {
    const sent: [string, string][] = [];
    const seen: { jobId: string; sid: string; textHash: string; actor: Actor }[] = [];
    const r: RewriteService = {
      ...notBuiltParts().rewrite,
      originFor: (jobId, sid, textHash, actor) => {
        seen.push({ jobId, sid, textHash, actor });
        return origin;
      },
      markSent: (jobId, sendJobId) => void sent.push([jobId, sendJobId]),
    };
    return { r, sent, seen };
  }

  it('the daemon computes the origin, the writer records it, and the job is marked sent', async () => {
    const fake = fakeRewrite('rewrite-edited');
    api = await makeApi({ deps: () => ({ rewrite: fake.r }) });
    const { cookie } = await pairCookie(api);
    const res = await api.tcp.inject({
      method: 'POST',
      url: '/v1/sessions/sess-aaaa-1111/prompt',
      headers: h(cookie),
      payload: { text: 'Fix the flaky test in send.ts', rewriteJobId: 'rw-1' },
    });
    expect(res.statusCode).toBe(202);
    expect(api.fakes.writer.submits[0]?.origin).toBe('rewrite-edited');
    expect(fake.seen[0]).toMatchObject({ jobId: 'rw-1', sid: 'sess-aaaa-1111' });
    expect(fake.seen[0]?.textHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.sent).toEqual([['rw-1', res.json().jobId]]);
    const audit = api.ctx.db.audit.list().find((a) => a.action === 'sendPrompt');
    expect(audit?.params).toMatchObject({ rewriteJobId: 'rw-1', origin: 'rewrite-edited' });
    expect(JSON.stringify(audit)).not.toContain('flaky');
  });

  it('an unknown or foreign rewrite job is a 404 and nothing is typed', async () => {
    const fake = fakeRewrite(null);
    api = await makeApi({ deps: () => ({ rewrite: fake.r }) });
    const { cookie } = await pairCookie(api);
    const res = await api.tcp.inject({ method: 'POST', url: '/v1/sessions/sess-aaaa-1111/prompt', headers: h(cookie), payload: { text: 'go', rewriteJobId: 'rw-x' } });
    expect(res.statusCode).toBe(404);
    expect(api.fakes.writer.submits).toHaveLength(0);
    expect(fake.sent).toEqual([]);
  });

  it('a typed prompt carries no origin and never asks the rewrite service', async () => {
    const fake = fakeRewrite('rewrite');
    api = await makeApi({ deps: () => ({ rewrite: fake.r }) });
    const { cookie } = await pairCookie(api);
    expect((await api.tcp.inject({ method: 'POST', url: '/v1/sessions/sess-aaaa-1111/prompt', headers: h(cookie), payload: { text: 'go' } })).statusCode).toBe(202);
    expect(api.fakes.writer.submits[0]?.origin).toBeUndefined();
    expect(fake.seen).toHaveLength(0);
  });
});

describe('raw replies', () => {
  function rawWith(reply: RawReply) {
    return vi.spyOn(ROUTE_IMPLS.filesRaw as { handle: () => unknown }, 'handle').mockImplementation(() => reply);
  }

  it('send the bytes with their own headers; the security headers fill in, cache-control keeps no-store', async () => {
    api = await makeApi({ ctx: { settings: ALL_ON } });
    const { cookie } = await pairCookie(api);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    rawWith({
      kind: 'raw',
      type: 'image/png',
      body: png,
      headers: {
        'cache-control': 'private, no-store',
        'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        'content-disposition': "inline; filename*=UTF-8''a.png",
      },
    });
    const res = await call(api, 'tcp', 'filesRaw', h(cookie));
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(png)).toBe(true);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['permissions-policy']).toContain('microphone=()');
  });

  it('stream a Readable, and never let a raw reply drop no-store', async () => {
    api = await makeApi({ ctx: { settings: ALL_ON } });
    const { cookie } = await pairCookie(api);
    rawWith({ kind: 'raw', type: 'application/pdf', body: Readable.from([Buffer.from('%PDF-1.7\n')]), headers: { 'cache-control': 'max-age=600' } });
    const res = await call(api, 'tcp', 'filesRaw', h(cookie));
    expect(res.body).toBe('%PDF-1.7\n');
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('run modes', () => {
  it('--read-only refuses the v0.3 writes up front; --no-terminal refuses launches and controls', async () => {
    expect([...READ_ONLY_REFUSED].filter((n) => ROUTES[n].phase === 'v0.3').sort()).toEqual(
      ['foldersCreate', 'foldersPin', 'launchAnswer', 'launchStart', 'rewriteStart', 'sessionCommand', 'sessionKey', 'sessionMode'].sort(),
    );
    expect([...NO_TERMINAL_REFUSED].filter((n) => ROUTES[n].phase === 'v0.3').sort()).toEqual(
      ['launchAnswer', 'launchStart', 'sessionCommand', 'sessionKey', 'sessionMode', 'sessionScreenshot'].sort(),
    );
    api = await makeApi({ ctx: { settings: ALL_ON }, api: { mode: { readOnly: true, terminal: 'off' } } });
    const { cookie } = await pairCookie(api, ['admin']);
    const ro = await call(api, 'tcp', 'launchStart', h(cookie));
    expect(ro.statusCode).toBe(403);
    expect(ro.json().error.message).toMatch(/read-only/);
    const nt = await call(api, 'tcp', 'sessionScreenshot', h(cookie));
    expect(nt.statusCode).toBe(501);
    expect(nt.json().error.message).toMatch(/--no-terminal/);
  });
});

describe('daemon.version carries the feature switches', () => {
  it('is emitted at start and again whenever a switch changes', async () => {
    const ctx = createTestContext();
    const srv = new ApiServerImpl(ctx, depsOf(makeFakes(ctx)), { port: 0, host: '127.0.0.1', ctlSocket: false, webDist: null });
    await srv.start();
    try {
      expect(ctx.store.getState().daemon?.features).toEqual(settingsFeatures(ctx.settings.get()));
      const before = ctx.store.seq;
      await ctx.settings.patch({ notify: { bodies: 'short' } });
      expect(ctx.store.seq).toBe(before);
      await ctx.settings.patch({ files: { enabled: true } });
      expect(ctx.store.seq).toBe(before + 1);
      expect(ctx.store.getState().daemon?.features?.files).toBe(true);
    } finally {
      await srv.stop();
    }
    // Stopped: no more re-emits.
    const after = ctx.store.seq;
    await ctx.settings.patch({ launch: { enabled: true } });
    expect(ctx.store.seq).toBe(after);
  });
});
