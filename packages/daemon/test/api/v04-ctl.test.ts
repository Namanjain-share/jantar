/**
 * LG4 and LG5 over the real pipeline: none of the health, food, money,
 * todo or Today routes is served on ctl.sock (404 there), so neither the
 * CLI nor a Claude session using it can read or write them; the shelf,
 * Life's status and Resume's history are. Backup and restore are the Mac
 * only: over TCP even an admin device gets 403 with the command to run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { RouteDef, RouteName } from '@jantar/protocol';
import { LOCAL_ONLY_REFUSED } from '../../src/api/app.js';
import { h, makeApi, pairCookie, type TestApi } from './fakes.js';
import { V04, V04_ON, v04Call } from './v04-helpers.js';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

const PRIVATE = ['/v1/medicines', '/v1/food', '/v1/weights', '/v1/places', '/v1/money', '/v1/bills', '/v1/todos', '/v1/projects', '/v1/life/today'];

describe('LG4: ctl.sock never serves Life data', () => {
  it('every medicine, food, weight, place, money, bill, todo, project and Today route is 404 on ctl.sock', async () => {
    api = await makeApi({ ctx: { settings: V04_ON } });
    let checked = 0;
    for (const [name, def] of V04 as [RouteName, RouteDef][]) {
      if (!PRIVATE.some((p) => def.path === p || def.path.startsWith(`${p}/`))) continue;
      checked += 1;
      const res = await v04Call(api, 'ctl', name);
      expect(res.statusCode, name).toBe(404);
    }
    expect(checked).toBe(40);
  });

  it('the shelf, Life status, backup, restore and Resume history are served there', async () => {
    api = await makeApi({ ctx: { settings: V04_ON } });
    for (const name of ['intelList', 'intelGet', 'intelCapture', 'intelSources', 'lifeStatus', 'lifeBackup', 'lifeRestore', 'launchHistory'] as RouteName[]) {
      expect((await v04Call(api, 'ctl', name)).statusCode, name).not.toBe(404);
    }
  });
});

describe('LG5: backup and restore are the Mac only', () => {
  it('over TCP an admin device gets 403 with the command; ctl.sock reaches the handler', async () => {
    api = await makeApi({ ctx: { settings: V04_ON } });
    const { cookie } = await pairCookie(api, ['admin']);
    for (const name of ['lifeBackup', 'lifeRestore'] as const) {
      const res = await v04Call(api, 'tcp', name, h(cookie));
      expect(res.statusCode, name).toBe(403);
      expect(res.json().error).toEqual({ code: 'forbidden', message: LOCAL_ONLY_REFUSED[name] });
      expect(res.json().error.message).toMatch(/on the Mac: jantar life (backup|restore <file>)$/);
      expect((await v04Call(api, 'ctl', name)).statusCode, `ctl ${name}`).toBe(501);
    }
    expect(api.ctx.db.audit.list().filter((a) => a.action === 'lifeRestore' && a.result === 'refused')).toHaveLength(1);
  });
});
