/**
 * LG1: every v0.4 route refuses an unpaired browser (401) and a device
 * without control scope (403, reads included); on writes, a bad Origin is
 * 403 and a missing device secret 401 (the v0.3 rule, SEC-2), before any
 * switch or handler. With control the request gets past the gate (a stub's
 * 501, or the Mac-only refusal for backup and restore).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROUTES, type RouteDef } from '@jantar/protocol';
import { ROUTE_IMPLS } from '../../src/api/routes.js';
import { bare, h, makeApi, pairCookie, type TestApi } from './fakes.js';
import { V04, V04_ON, v04Call } from './v04-helpers.js';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

describe('LG1: v0.4 routes need a paired device with control', () => {
  it('48 routes, each refused to an unpaired browser and to a read-only device', async () => {
    expect(V04).toHaveLength(48);
    api = await makeApi({ ctx: { settings: V04_ON } });
    const reader = await pairCookie(api, ['read']);
    const spies = V04.map(([name]) => vi.spyOn(ROUTE_IMPLS[name] as { handle: () => unknown }, 'handle'));
    for (const [name] of V04) {
      const unpaired = await v04Call(api, 'tcp', name, h());
      expect(unpaired.statusCode, `${name} unpaired`).toBe(401);
      const read = await v04Call(api, 'tcp', name, h(reader.cookie));
      expect(read.statusCode, `${name} read`).toBe(403);
      expect(read.json().error.message, name).toBe('this device does not have the control scope');
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('writes need an allowed Origin and the device secret', async () => {
    api = await makeApi({ ctx: { settings: V04_ON } });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    for (const [name, def] of V04 as [typeof V04[number][0], RouteDef][]) {
      if (def.method === 'GET') continue;
      const evil = await v04Call(api, 'tcp', name, h(cookie, { origin: 'https://evil.example' }));
      expect(evil.statusCode, `${name} origin`).toBe(403);
      expect(evil.json().error.message).toBe('request origin is not allowed');
      const noSecret = await v04Call(api, 'tcp', name, bare(cookie));
      expect(noSecret.statusCode, `${name} secret`).toBe(401);
    }
  });

  it('a control device gets past the gate: the stub answers, or the Mac-only refusal', async () => {
    api = await makeApi({ ctx: { settings: V04_ON } });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    for (const [name, def] of V04) {
      const res = await v04Call(api, 'tcp', name, h(cookie));
      if (def.localOnly) expect(res.statusCode, name).toBe(403);
      else expect([401, 403], `${name} ${res.body}`).not.toContain(res.statusCode);
    }
    expect(ROUTES.lifeBackup.localOnly && ROUTES.lifeRestore.localOnly).toBe(true);
  });
});
