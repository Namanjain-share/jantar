/**
 * v0.8 wave 0, the pipeline's part for Intel reading links:
 * - The `intelRead` switch: on only with the shelf on too. Off, the phone's
 *   and the CLI's reads and the extension's reads answer 403 with the
 *   sentence that names `jantar intel read on`, before validation and any
 *   handler; the jobs, Delete and thumbnails need only the shelf.
 * - ctl.sock serves the reads, the jobs, Delete, the status and the capture
 *   keys; never a thumbnail, the capture door or the extension's routes.
 * - The status and the capture keys are the Mac's only: an admin phone gets
 *   the sentence naming the CLI command.
 * - The capture door reads no device cookie and does not exist (404) in
 *   loopback and lan mode, while Intel is off, or with no key.
 * - The extension's reads take its key (401 without), its switch, then its
 *   handler.
 * - The writes that need the device secret; nothing new under --read-only
 *   (Intel saves a link failed there itself).
 * - The reasons table and the capture reply's one sentence.
 * Synthetic values only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_KEY_HEADER,
  CAPTURE_SAVED_SENTENCE,
  CaptureSaveReplySchema,
  ErrorBodySchema,
  INTEL_READ_REASONS,
  ROUTES,
  SettingsSchema,
  type RouteDef,
  type RouteName,
} from '@jantar/protocol';
import { FEATURE_OFF, LOCAL_ONLY_REFUSED, READ_ONLY_REFUSED, needsDeviceSecret } from '../../src/api/app.js';
import { ROUTE_IMPLS } from '../../src/api/routes.js';
import { V08_LIMITS } from '../../src/api/services.js';
import { hashCaptureKey } from '../../src/auth/capture-keys.js';
import { hashExtensionKey } from '../../src/auth/extensions.js';
import { actorId } from '../../src/core/actor.js';
import { sha256Hex } from '../../src/core/hash.js';
import { HOST, h, makeApi, pairCookie, type TestApi } from './fakes.js';
import { extHeaders, pairExtension } from './v05-helpers.js';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const ITEM = 'captures:01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const V08 = (Object.entries(ROUTES) as [RouteName, RouteDef][]).filter(([, d]) => d.phase === 'v0.8');
const REQ: Partial<Record<RouteName, { params?: Record<string, string>; body?: object }>> = {
  intelRead: { body: { text: 'https://www.instagram.com/reel/AbC123xyz/ dal recipe', depth: 'standard' } },
  intelReread: { params: { id: ITEM }, body: { depth: 'full' } },
  intelDelete: { params: { id: ITEM } },
  intelFrame: { params: { id: ITEM, n: '0' } },
  captureKeyAdd: { body: { name: 'iphone' } },
  captureKeyRevoke: { body: { all: true } },
  captureSave: { body: { text: 'https://example.com/a', depth: 'light' } },
  extReadResult: { params: { id: 'lease_0123456789' }, body: { ok: false, why: 'login' } },
};
const SHELF_ON = SettingsSchema.parse({ intel: { enabled: true } });
const READ_ON = SettingsSchema.parse({ intel: { enabled: true, read: true } });
const READ_ONLY_SWITCH = SettingsSchema.parse({ intel: { read: true } });

function urlOf(name: RouteName): string {
  const def = ROUTES[name] as RouteDef;
  const params = REQ[name]?.params ?? {};
  return def.path.replace(/:([A-Za-z]+)/g, (_m, p: string) => encodeURIComponent(params[p] ?? 'x'));
}

function call(t: TestApi, transport: 'tcp' | 'ctl', name: RouteName, headers: Record<string, string> = {}) {
  const def = ROUTES[name] as RouteDef;
  const body = REQ[name]?.body;
  return t[transport].inject({ method: def.method as Method, url: urlOf(name), headers, ...(body ? { payload: body } : {}) });
}

const byFeature = (f: string) => V08.filter(([, d]) => d.feature === f).map(([n]) => n);

describe('v0.8: the route table as wave 0 left it', () => {
  it('every v0.8 route has a handler; the stubs answer 501 until their lane lands', () => {
    for (const [name] of V08) expect(ROUTE_IMPLS[name], name).toBeDefined();
    expect(byFeature('intelRead').sort()).toEqual(['extReadNext', 'extReadResult', 'intelRead', 'intelReread']);
    expect(byFeature('intel').sort()).toEqual(['captureKeyAdd', 'intelDelete', 'intelFrame', 'intelJobs']);
  });

  it('the switch sentence is the reason table\'s, and the door has one reply', () => {
    expect(FEATURE_OFF.intelRead).toEqual({ code: 'forbidden', message: INTEL_READ_REASONS.off });
    expect(FEATURE_OFF.intelRead.message).toBe('Reading links is off. Turn it on at your Mac: jantar intel read on');
    expect(CaptureSaveReplySchema.parse({ message: CAPTURE_SAVED_SENTENCE })).toEqual({ message: 'Saved to Jantar.' });
  });

  it('the writes that need the device secret; nothing new is refused under --read-only by the pipeline', () => {
    const secret = V08.filter(([, d]) => needsDeviceSecret(d)).map(([n]) => n).sort();
    // The two capture key writes are the Mac's only (refused over TCP anyway); the door and the extension carry no device.
    expect(secret).toEqual(['captureKeyAdd', 'captureKeyRevoke', 'intelDelete', 'intelRead', 'intelReread'].sort());
    for (const [name] of V08) expect(READ_ONLY_REFUSED.has(name), name).toBe(false);
  });
});

describe('v0.8: the intelRead switch', () => {
  it('reading off (the shelf on): the reads are 403 with the sentence, even with a bad body; no handler runs', async () => {
    api = await makeApi({ ctx: { settings: SHELF_ON } });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const spies = (['intelRead', 'intelReread'] as const).map((n) => vi.spyOn(ROUTE_IMPLS[n] as { handle: () => unknown }, 'handle'));
    for (const name of ['intelRead', 'intelReread'] as const) {
      for (const transport of ['tcp', 'ctl'] as const) {
        const res = await call(api, transport, name, transport === 'tcp' ? h(cookie) : {});
        expect(res.statusCode, `${transport} ${name}`).toBe(403);
        expect(ErrorBodySchema.parse(res.json()).error).toEqual({ code: 'forbidden', message: INTEL_READ_REASONS.off });
      }
      const bad = await api.tcp.inject({ method: 'POST', url: urlOf(name), headers: h(cookie), payload: { nonsense: 1 } });
      expect(bad.statusCode, `${name} bad body`).toBe(403);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    // The shelf's own v0.8 routes are on.
    for (const name of ['intelJobs', 'intelDelete', 'intelFrame'] as const) {
      const res = await call(api, 'tcp', name, h(cookie));
      expect(res.statusCode, `${name} ${res.body}`).not.toBe(403);
      if (ROUTE_IMPLS[name]?.stub) expect(res.statusCode, name).toBe(501);
    }
  });

  it('reading on without the shelf is off: the shelf sentence first for its routes, the read sentence for reads', async () => {
    api = await makeApi({ ctx: { settings: READ_ONLY_SWITCH } });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    expect(ErrorBodySchema.parse((await call(api, 'tcp', 'intelRead', h(cookie))).json()).error.message).toBe(INTEL_READ_REASONS.off);
    expect(ErrorBodySchema.parse((await call(api, 'tcp', 'intelJobs', h(cookie))).json()).error.message).toBe(FEATURE_OFF.intel.message);
  });

  it('on: the phone\'s routes reach their handlers; a read-only device gets none of them', async () => {
    api = await makeApi({ ctx: { settings: READ_ON } });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    for (const name of ['intelRead', 'intelReread', 'intelJobs', 'intelDelete', 'intelFrame'] as const) {
      const res = await call(api, 'tcp', name, h(cookie));
      expect(res.statusCode, `${name} ${res.body}`).not.toBe(403);
      if (ROUTE_IMPLS[name]?.stub) expect(res.statusCode, name).toBe(501);
    }
    const reader = await pairCookie(api, ['read'], 'Reader');
    for (const name of ['intelRead', 'intelReread', 'intelJobs', 'intelDelete', 'intelFrame'] as const) {
      expect((await call(api, 'tcp', name, h(reader.cookie))).statusCode, name).toBe(403);
    }
  });
});

describe('v0.8: ctl.sock and the Mac-only routes', () => {
  it('ctl.sock serves the reads, jobs, Delete, the status and the keys; never a thumbnail, the door or the extension', async () => {
    api = await makeApi({ ctx: { settings: READ_ON } });
    for (const name of ['intelRead', 'intelReread', 'intelJobs', 'intelDelete', 'intelReadStatus', 'captureKeyAdd', 'captureKeyList', 'captureKeyRevoke'] as const) {
      const res = await call(api, 'ctl', name);
      expect(res.statusCode, `${name} ${res.body}`).not.toBe(404);
      if (ROUTE_IMPLS[name]?.stub) expect(res.statusCode, name).toBe(501);
    }
    for (const name of ['intelFrame', 'captureSave', 'extReadNext', 'extReadResult'] as const) expect((await call(api, 'ctl', name)).statusCode, name).toBe(404);
  });

  it('an admin phone gets the sentence naming the CLI command for the status and the keys', async () => {
    api = await makeApi({ ctx: { settings: READ_ON } });
    const { cookie } = await pairCookie(api, ['read', 'control', 'admin']);
    for (const name of ['intelReadStatus', 'captureKeyAdd', 'captureKeyList', 'captureKeyRevoke'] as const) {
      const res = await call(api, 'tcp', name, h(cookie));
      expect(res.statusCode, name).toBe(403);
      expect(ErrorBodySchema.parse(res.json()).error.message, name).toBe(LOCAL_ONLY_REFUSED[name]);
    }
    expect(LOCAL_ONLY_REFUSED.captureKeyAdd).toBe('Make a Shortcut key at the Mac: jantar intel shortcut add');
  });
});

describe('v0.8: the capture door', () => {
  const door = (t: TestApi, headers: Record<string, string> = {}) =>
    t.tcp.inject({ method: 'POST', url: ROUTES.captureSave.path, headers: { host: HOST, 'content-type': 'application/json', ...headers }, payload: { text: 'https://example.com/a' } });

  it('does not exist in loopback or lan mode, with Intel off, or with no key: 404, a device cookie or a key changes nothing', async () => {
    for (const settings of [READ_ON, SettingsSchema.parse({ intel: { enabled: true, read: true }, remote: { mode: 'lan' } }), SettingsSchema.parse({})]) {
      await api?.close();
      api = await makeApi({ ctx: { settings } });
      const { cookie } = await pairCookie(api, ['read', 'control', 'admin']);
      for (const headers of [{}, h(cookie), { [CAPTURE_KEY_HEADER]: `jcap_${'A'.repeat(43)}` }]) {
        const res = await door(api, headers);
        expect(res.statusCode, `${settings.remote.mode} ${JSON.stringify(Object.keys(headers))}`).toBe(404);
        expect(res.body).not.toContain(CAPTURE_SAVED_SENTENCE);
      }
    }
  });

  it('reads no device cookie on its paths (the device is not even looked at)', async () => {
    api = await makeApi({ ctx: { settings: READ_ON } });
    const { cookie } = await pairCookie(api, ['read', 'control', 'admin']);
    const seen = vi.spyOn(api.services.devices, 'authenticate');
    await door(api, h(cookie));
    expect(seen).not.toHaveBeenCalled();
    await api.tcp.inject({ method: 'GET', url: '/v1/state', headers: h(cookie) });
    expect(seen).toHaveBeenCalled();
  });
});

describe('v0.8: the capture key, as wave 0 names it', () => {
  it('its own hash prefix, its own actor, its limits; until lane C builds it no key authenticates', async () => {
    const key = `jcap_${'A'.repeat(43)}`;
    expect(hashCaptureKey(key)).toBe(sha256Hex(`jantar-capture-key:${key}`));
    expect(hashCaptureKey(key)).not.toBe(hashExtensionKey(key));
    expect(actorId({ kind: 'capture', keyId: '01JFZ8X8Y3T0V5G9WQK2M4N6PR' })).toBe('capture:01JFZ8X8Y3T0V5G9WQK2M4N6PR');
    expect(V08_LIMITS).toEqual({
      captureHour: { limit: 30, windowMs: 3_600_000 },
      captureDay: { limit: 200, windowMs: 86_400_000 },
      captureBadKey: { limit: 20, windowMs: 600_000 },
    });
    api = await makeApi();
    expect(api.services.captureKeys.activeCount()).toBe(0);
    expect(api.services.captureKeys.authenticate(key).ok).toBe(false);
  });
});

describe("v0.8: the extension's reads", () => {
  it('take its key (401 without), its switch (403 with the sentence), then reach the handler', async () => {
    api = await makeApi({ ctx: { settings: SHELF_ON } });
    const { key } = await pairExtension(api);
    for (const name of ['extReadNext', 'extReadResult'] as const) {
      const origin = ROUTES[name].method === 'GET' ? null : undefined;
      expect((await call(api, 'tcp', name, extHeaders(undefined, origin))).statusCode, name).toBe(401);
      const off = await call(api, 'tcp', name, extHeaders(key, origin));
      expect(off.statusCode, name).toBe(403);
      expect(ErrorBodySchema.parse(off.json()).error.message, name).toBe(INTEL_READ_REASONS.off);
    }
    await api.ctx.settings.patch({ intel: { read: true } });
    for (const name of ['extReadNext', 'extReadResult'] as const) {
      const origin = ROUTES[name].method === 'GET' ? null : undefined;
      const res = await call(api, 'tcp', name, extHeaders(key, origin));
      expect(res.statusCode, `${name} ${res.body}`).not.toBe(403);
      if (ROUTE_IMPLS[name]?.stub) expect(res.statusCode, name).toBe(501);
    }
  });
});
