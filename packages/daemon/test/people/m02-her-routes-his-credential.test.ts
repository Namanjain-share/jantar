/**
 * v0.11 People, M2, T3 (c) and T4 (spec 9.7.2):
 *
 * - M2 / T3 (c): every route of hers × his credential. On her host his
 *   credential never becomes hers: every person route answers his cookie
 *   and secret, at every scope, exactly as it answers no credential (401;
 *   the join routes their own 400). On his hosts every `/v1/p/*` is 404.
 *   ctl.sock doesn't serve them at all.
 * - T4, the positive control (without it the refusals could pass
 *   vacuously): every person route, with her credential on her host, gives
 *   neither 401 nor the gate's 404. A 404 for a missing row is allowed and
 *   tagged; every 2xx body validates against the route's response schema.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_PREFIX } from '@jantar/protocol/people';
import {
  LOOPBACK_HOST,
  LOOPBACK_ORIGIN,
  NONE,
  OWNER_HOST,
  OWNER_ORIGIN,
  PEOPLE_HOST,
  PEOPLE_ORIGIN,
  call,
  credHeaders,
  makeFixture,
  routeEntries,
  type Cred,
  type Fixture,
} from './isolation-fixture.js';

let f: Fixture;
beforeAll(async () => {
  f = await makeFixture();
}, 60_000);
afterAll(async () => {
  await f?.close();
});

const herRoutes = () => routeEntries().filter(([, def]) => def.scope === 'person');
const hisCreds = (): Cred[] => [f.owner.read, f.owner.control, f.owner.launch, f.owner.admin, f.owner.cookieOnly];

describe('M2 / T3 (c): her routes × his credential', () => {
  it('lists her routes (the matrix is not empty)', () => {
    expect(herRoutes().length).toBeGreaterThanOrEqual(20);
    for (const [name, def] of herRoutes()) expect(def.path.startsWith(PERSON_PREFIX), name).toBe(true);
  });

  it('on her host, his credential answers exactly as no credential', async () => {
    const bad: string[] = [];
    for (const [name, def] of herRoutes()) {
      if (def.method === 'WS') continue;
      for (const origin of [PEOPLE_ORIGIN, OWNER_ORIGIN]) {
        const bare = await call(f.api, def, { host: PEOPLE_HOST, cred: NONE, origin });
        if (bare.status < 300) bad.push(`${name}: ${bare.status} with no credential`);
        for (const cred of hisCreds()) {
          const r = await call(f.api, def, { host: PEOPLE_HOST, cred, origin });
          if (r.status !== bare.status || r.body !== bare.body) bad.push(`${name} ${cred.name} ${origin}: ${r.status} vs ${bare.status}`);
        }
      }
    }
    expect(bad).toEqual([]);
  }, 60_000);

  it('without a credential: 401 on every non-join route, 400 on the join routes (a body that is not a code)', async () => {
    for (const [name, def] of herRoutes()) {
      if (def.method === 'WS') continue;
      const r = await call(f.api, def, { host: PEOPLE_HOST, cred: NONE, origin: PEOPLE_ORIGIN });
      expect(r.status, name).toBe(def.join ? 400 : 401);
    }
  });

  it('on his hosts every /v1/p/* is 404, whoever calls', async () => {
    const bad: string[] = [];
    for (const [name, def] of herRoutes()) {
      for (const [host, origin] of [
        [OWNER_HOST, OWNER_ORIGIN],
        [LOOPBACK_HOST, LOOPBACK_ORIGIN],
        [OWNER_HOST, PEOPLE_ORIGIN],
      ] as const) {
        for (const cred of [NONE, ...hisCreds(), f.asha.full]) {
          const r = await call(f.api, def, { host, cred, origin });
          if (r.status !== 404) bad.push(`${name} ${host} ${cred.name}: ${r.status}`);
        }
      }
    }
    expect(bad).toEqual([]);
  }, 60_000);

  it('ctl.sock serves none of her routes', async () => {
    for (const [name, def] of herRoutes()) {
      if (def.method === 'WS') continue;
      const r = await f.api.ctl.inject({ method: def.method, url: def.path.replace(/:[a-zA-Z]+/g, '01JZZZZZZZZZZZZZZZZZZZZZZZ'), ...(def.method === 'GET' ? {} : { payload: {} }) });
      expect(r.statusCode, name).toBe(404);
    }
  });

  it('her stream does not open for his credential (401 on her host, 404 on his)', async () => {
    for (const cred of hisCreds()) {
      await expect(f.api.tcp.injectWS('/v1/p/events', { headers: { host: PEOPLE_HOST, origin: PEOPLE_ORIGIN, ...credHeaders(cred) } })).rejects.toThrow(/401/);
      await expect(f.api.tcp.injectWS('/v1/p/events', { headers: { host: OWNER_HOST, origin: OWNER_ORIGIN, ...credHeaders(cred) } })).rejects.toThrow(/404/);
    }
  });
});

describe('T4: the positive control', () => {
  it('every person route with her credential on her host passes the gate; 2xx bodies validate', async () => {
    const tagged: string[] = [];
    const bad: string[] = [];
    for (const [name, def] of herRoutes()) {
      if (def.method === 'WS' || def.join) continue;
      // Her exits that end or change her account run last, in their own tests.
      if (name === 'personLeave' || name === 'personPause' || name === 'personResume') continue;
      const r = await call(f.api, def, { host: PEOPLE_HOST, cred: f.asha.full, origin: PEOPLE_ORIGIN });
      if (r.status === 401) bad.push(`${name}: 401`);
      if (r.status === 404 && r.body.includes('"message":"not found"')) bad.push(`${name}: the gate's 404`);
      if (r.status === 404) tagged.push(name);
      if (r.status < 300 && def.response && !def.rawResponse) {
        const parsed = def.response.safeParse(JSON.parse(r.body));
        if (!parsed.success) bad.push(`${name}: ${parsed.error.issues[0]?.message} at ${parsed.error.issues[0]?.path.join('.')}`);
      }
    }
    expect(bad).toEqual([]);
    // Only the routes naming a row that doesn't exist answer 404 here.
    for (const name of tagged) expect(herRoutes().find(([n]) => n === name)?.[1].path, name).toMatch(/:/);
  });

  it('her stream opens for her, on her host, with her origin', async () => {
    const ws = await f.api.tcp.injectWS('/v1/p/events', { headers: { host: PEOPLE_HOST, origin: PEOPLE_ORIGIN, ...credHeaders(f.asha.full) } });
    ws.terminate();
  });
});
