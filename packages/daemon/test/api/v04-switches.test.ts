/**
 * LG2 and the v0.4 stubs: each Life module and the shelf close their routes
 * with 403 and the sentence that turns them on, before validation and
 * before any handler; `life` (Today) is on with any module; lifeStatus,
 * backup and restore sit behind no switch. With every switch on, each stub
 * answers 501. A broken life.db makes every Life route but status, backup
 * and restore answer 503 with LIFE_BROKEN_REASON (LD1, API part); the shelf
 * and sessions are unaffected.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBodySchema, SettingsSchema, type RouteDef, type RouteName } from '@jantar/protocol';
import type { LifeService } from '../../src/contracts.js';
import { FEATURE_OFF, LIFE_FEATURES } from '../../src/api/app.js';
import { V04_LIMITS } from '../../src/api/services.js';
import { ROUTE_IMPLS } from '../../src/api/routes.js';
import { notBuiltParts } from '../../src/core/testing.js';
import { LIFE_BROKEN_REASON } from '../../src/life/db.js';
import { h, makeApi, pairCookie, type TestApi } from './fakes.js';
import { V04, V04_OFF, V04_ON, v04Call } from './v04-helpers.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

describe('v0.4 stubs', () => {
  it('with every switch on, each answers 501 over TCP, and over ctl.sock where served (404 elsewhere)', async () => {
    api = await makeApi({ ctx: { settings: V04_ON } });
    const { cookie } = await pairCookie(api, ['admin']);
    for (const [name, def] of V04) {
      if (!ROUTE_IMPLS[name]?.stub) continue;
      if (!def.localOnly) {
        const res = await v04Call(api, 'tcp', name, h(cookie));
        expect(res.statusCode, `${name} ${res.body}`).toBe(501);
        expect(ErrorBodySchema.parse(res.json()).error.code).toBe('not_implemented');
      }
      const viaCtl = await v04Call(api, 'ctl', name);
      expect(viaCtl.statusCode, `ctl ${name}`).toBe(def.ctl ? 501 : 404);
    }
  });
});

describe('LG2: each module behind its own switch', () => {
  it('every switch off: each route with a switch answers 403 with its sentence, even with a bad body; no handler runs', async () => {
    api = await makeApi({ ctx: { settings: V04_OFF } });
    const { cookie } = await pairCookie(api, ['admin']);
    const gated = V04.filter(([, d]) => d.feature);
    const spies = gated.map(([name]) => vi.spyOn(ROUTE_IMPLS[name] as { handle: () => unknown }, 'handle'));
    for (const [name, def] of gated) {
      const off = FEATURE_OFF[def.feature as keyof typeof FEATURE_OFF];
      const res = await v04Call(api, 'tcp', name, h(cookie));
      expect(res.statusCode, name).toBe(403);
      expect(res.json().error, name).toEqual({ code: off.code, message: off.message });
      if (def.method !== 'GET') {
        const bad = await v04Call(api, 'tcp', name, h(cookie), { nonsense: 1 });
        expect(bad.statusCode, `${name} bad body`).toBe(403);
      }
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    // Status says which modules are on, so it always answers (501 while it is a stub).
    expect((await v04Call(api, 'tcp', 'lifeStatus', h(cookie))).statusCode).not.toBe(403);
    expect((await v04Call(api, 'ctl', 'lifeBackup')).statusCode).not.toBe(403);
  });

  it('one module on opens its routes and Today, and no other module', async () => {
    const byFeature = (f: string) => V04.filter(([, d]) => d.feature === f).map(([n]) => n);
    for (const mod of ['todos', 'medicines', 'food', 'places', 'finance'] as const) {
      api = await makeApi({ ctx: { settings: SettingsSchema.parse({ life: { [mod]: true } }) } });
      const { cookie } = await pairCookie(api, ['read', 'control']);
      for (const name of [...byFeature(mod), 'lifeToday'] as RouteName[]) {
        expect((await v04Call(api, 'tcp', name, h(cookie))).statusCode, `${mod}: ${name}`).not.toBe(403);
      }
      for (const other of ['todos', 'medicines', 'food', 'places', 'finance'].filter((m) => m !== mod)) {
        const name = byFeature(other)[0] as RouteName;
        expect((await v04Call(api, 'tcp', name, h(cookie))).statusCode, `${mod} keeps ${name} shut`).toBe(403);
      }
      for (const name of byFeature('intel') as RouteName[]) expect((await v04Call(api, 'tcp', name, h(cookie))).statusCode).toBe(403);
      await api.close();
    }
  });

  it('a switch turned on at the Mac opens its routes at once', async () => {
    api = await makeApi({ ctx: { settings: V04_OFF } });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    expect((await v04Call(api, 'tcp', 'medsGet', h(cookie))).statusCode).toBe(403);
    expect((await api.ctl.inject({ method: 'PATCH', url: '/v1/settings', payload: { life: { medicines: true } } })).statusCode).toBe(200);
    expect((await v04Call(api, 'tcp', 'medsGet', h(cookie))).statusCode).toBe(501);
    expect((await v04Call(api, 'tcp', 'intelList', h(cookie))).statusCode).toBe(403);
    expect((await api.ctl.inject({ method: 'PATCH', url: '/v1/settings', payload: { intel: { enabled: true } } })).statusCode).toBe(200);
    expect((await v04Call(api, 'tcp', 'intelList', h(cookie))).statusCode).toBe(501);
  });

  it('every switch sentence names the Mac command that turns it on', () => {
    for (const f of ['life', 'todos', 'medicines', 'food', 'places', 'finance'] as const) {
      expect(FEATURE_OFF[f].message, f).toMatch(/at your Mac: jantar life on (todos|medicines|food|places|finance)$/);
    }
    expect(FEATURE_OFF.intel.message).toBe('The Intel shelf is off. Turn it on at your Mac: jantar intel on');
  });
});

describe('a broken life.db (LD1, API part)', () => {
  /** The inert Life part, broken: the pipeline asks `broken()` before every Life route's handler. */
  function brokenLife(): LifeService {
    const life = notBuiltParts().life;
    return new Proxy(life, { get: (t, p, r) => (p === 'broken' ? () => LIFE_BROKEN_REASON : Reflect.get(t, p, r)) });
  }

  it('every Life route but status, backup and restore answers 503 with the sentence; the shelf and sessions carry on', async () => {
    api = await makeApi({ ctx: { settings: V04_ON }, deps: () => ({ life: brokenLife() }) });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    for (const [name, def] of V04 as [RouteName, RouteDef][]) {
      const res = def.localOnly ? await v04Call(api, 'ctl', name) : await v04Call(api, 'tcp', name, h(cookie));
      if (def.feature !== undefined && LIFE_FEATURES.has(def.feature)) {
        expect(res.statusCode, name).toBe(503);
        expect(res.json().error, name).toEqual({ code: 'life_unavailable', message: LIFE_BROKEN_REASON });
      } else {
        expect(res.statusCode, name).not.toBe(503);
      }
    }
    expect(LIFE_BROKEN_REASON).toBe('Life data could not be opened. The file is untouched. Restore a backup at your Mac: jantar life restore <file>');
    // Sessions still answer.
    expect((await api.tcp.inject({ method: 'GET' as Method, url: '/v1/sessions', headers: h(cookie) })).statusCode).toBe(200);
  });

  it('a module that is off says so before the 503', async () => {
    api = await makeApi({ ctx: { settings: V04_OFF }, deps: () => ({ life: brokenLife() }) });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    expect((await v04Call(api, 'tcp', 'medsGet', h(cookie))).json().error.code).toBe('forbidden');
  });
});

describe('the pipeline guards every Life and shelf route, built or not', () => {
  it('counts every Life write per device: the 241st in a minute is 429 with retry-after; reads and the shelf are not counted', async () => {
    api = await makeApi({ ctx: { settings: V04_ON } });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const other = await pairCookie(api, ['read', 'control']);
    for (let i = 0; i < V04_LIMITS.lifeWrite.limit; i++) {
      const res = await v04Call(api, 'tcp', 'todoDelete', h(cookie));
      expect(res.statusCode, `write ${i + 1}`).not.toBe(429);
    }
    const limited = await v04Call(api, 'tcp', 'todoDelete', h(cookie));
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Another module's write from the same device is counted too; reads, the shelf and other devices are not.
    expect((await v04Call(api, 'tcp', 'moneyAdd', h(cookie))).statusCode).toBe(429);
    expect((await v04Call(api, 'tcp', 'medsGet', h(cookie))).statusCode).not.toBe(429);
    expect((await v04Call(api, 'tcp', 'intelCapture', h(cookie))).statusCode).not.toBe(429);
    expect((await v04Call(api, 'tcp', 'todoDelete', h(other.cookie))).statusCode).not.toBe(429);
  });

  it("a capture names its folder only from the Mac's CLI: a TCP body with cwd is 400 before any handler", async () => {
    api = await makeApi({ ctx: { settings: V04_ON } });
    const { cookie } = await pairCookie(api, ['admin']);
    const spy = vi.spyOn(ROUTE_IMPLS.intelCapture as { handle: () => unknown }, 'handle');
    const body = { title: 'Example capture', cwd: '/synthetic/home/work/bot' };
    const tcp = await v04Call(api, 'tcp', 'intelCapture', h(cookie), body);
    expect(tcp.statusCode).toBe(400);
    expect(tcp.json().error.message).toMatch(/^invalid body at cwd/);
    expect(spy).not.toHaveBeenCalled();
    const ctl = await v04Call(api, 'ctl', 'intelCapture', {}, body);
    expect(ctl.statusCode).not.toBe(400);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
