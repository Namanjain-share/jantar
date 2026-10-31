/**
 * LG7: `--read-only` is about sessions. Life and Intel writes pass the
 * pipeline (here they reach WP0's stubs, 501), while a start is refused as
 * in v0.3, with or without `resume`. Ask Claude is refused too, on the
 * route and on the food module: like a Rewrite run it spends an account's
 * quota.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { V03_LAUNCH_FLAGS, type RouteDef, type RouteName } from '@jantar/protocol';
import type { Actor } from '../src/contracts.js';
import { READ_ONLY_REFUSED } from '../src/api/app.js';
import { createFakeExec, createTestContext, createTestLifeCore, type TestLifeCore } from '../src/core/testing.js';
import { LIFE_MODULE_BUILDERS } from '../src/life/index.js';
import { READ_ONLY_REASON, readOnlyLifeBuilders } from '../src/modes.js';
import { h, makeApi, makeFakes, pairCookie, type TestApi } from './api/fakes.js';
import { V04, V04_ON, v04Call } from './api/v04-helpers.js';

let api: TestApi | undefined;
let core: TestLifeCore | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
  core?.close();
  core = undefined;
});

describe('LG7: --read-only', () => {
  it('lists Ask Claude and no other v0.4 route', () => {
    for (const [name] of V04) expect(READ_ONLY_REFUSED.has(name), name).toBe(name === 'foodEstimate');
  });

  it('lets every Life and Intel write through; refuses Ask Claude, and a start with or without resume', async () => {
    api = await makeApi({ ctx: { settings: V04_ON }, api: { mode: { readOnly: true, terminal: 'terminal-app' } } });
    const { cookie } = await pairCookie(api, ['admin']);
    for (const [name, def] of V04 as [RouteName, RouteDef][]) {
      if (def.method === 'GET' || def.localOnly) continue;
      const res = await v04Call(api, 'tcp', name, h(cookie));
      if (name === 'foodEstimate') {
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json().error.message).toMatch(/read-only/);
      } else {
        expect(res.statusCode, `${name} ${res.body}`).toBe(501);
      }
    }
    const start = { root: 'r.work', path: 'foo', account: 'auto', flags: { ...V03_LAUNCH_FLAGS } };
    for (const body of [start, { ...start, resume: '0b4e7c4e-0000-4000-8000-000000000000' }]) {
      const res = await api.tcp.inject({ method: 'POST', url: '/v1/launches', headers: h(cookie, { 'idempotency-key': 'k1' }), payload: body });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toMatch(/read-only/);
    }
  });

  it("the food module itself never runs Ask Claude, and says so in Life's status; the rest of food still works", async () => {
    const exec = createFakeExec(() => ({ stdout: '{}' }));
    const ctx = createTestContext({ exec, accountsMode: 'single', settings: V04_ON });
    core = createTestLifeCore({ clock: ctx.clock, settings: { food: true } });
    const f = makeFakes(ctx);
    const food = readOnlyLifeBuilders(LIFE_MODULE_BUILDERS).food(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
    const phone: Actor = { kind: 'device', deviceId: 'dev-phone', scopes: ['read', 'control'] };

    expect(food.estimateStatus()).toEqual({ available: false, reason: READ_ONLY_REASON });
    expect(await food.estimate('2 rotis and dal', new AbortController().signal, phone)).toEqual({ ok: false, code: 'unavailable', reason: READ_ONLY_REASON });
    expect(exec.calls).toEqual([]);
    expect(food.add({ day: '2026-01-15', name: 'Roti', kcal: 120 }, phone).ok).toBe(true);
    expect(food.day().ok).toBe(true);
  });
});
