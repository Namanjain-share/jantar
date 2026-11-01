/**
 * v0.7 wave 0, the pipeline's part for Posts (a sixth Life module):
 * - The `posts` switch: off, every posts route answers 403 with the sentence
 *   that names `jantar life on posts`, before validation and before any
 *   handler; on, the routes reach their handlers (the stand-in Life part
 *   answers 501), and `life` (Today) is on with posts alone.
 * - ctl.sock serves only the list and an add (what the user approved:
 *   `jantar post list`, `jantar post add`); a change, a delete and the goals
 *   are 404 there.
 * - A broken life.db answers 503 on every posts route, as on Life's own.
 * - Posts' writes are counted by the Life write limiter.
 * Synthetic values only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBodySchema, ROUTES, SettingsSchema, type RouteDef, type RouteName } from '@jantar/protocol';
import type { LifeService } from '../../src/contracts.js';
import { FEATURE_OFF, LIFE_FEATURES } from '../../src/api/app.js';
import { ROUTE_IMPLS } from '../../src/api/routes.js';
import { V04_LIMITS } from '../../src/api/services.js';
import { notBuiltParts } from '../../src/core/testing.js';
import { LIFE_BROKEN_REASON } from '../../src/life/db.js';
import { h, makeApi, pairCookie, type TestApi } from './fakes.js';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const ID = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const V07 = (Object.entries(ROUTES) as [RouteName, RouteDef][]).filter(([, d]) => d.phase === 'v0.7');
const REQ: Partial<Record<RouteName, { query?: string; body?: object }>> = {
  postsList: { query: '?done=0' },
  postCreate: { body: { platform: 'reddit', where: 'r/exampletools', kind: 'post', title: 'Example title', due: { day: '2026-11-02', time: '19:30' } } },
  postUpdate: { body: { status: 'ready' } },
  postGoalsSet: { body: { goals: [{ platform: 'instagram', kind: 'reel', perWeek: 3 }] } },
};
const POSTS_ON = SettingsSchema.parse({ life: { posts: true } });
const POSTS_OFF = SettingsSchema.parse({ life: { todos: true } });

function call(t: TestApi, transport: 'tcp' | 'ctl', name: RouteName, headers: Record<string, string> = {}, body?: object) {
  const def = ROUTES[name] as RouteDef;
  const r = REQ[name] ?? {};
  const payload = body ?? r.body;
  return t[transport].inject({
    method: def.method as Method,
    url: def.path.replace(':id', ID) + (r.query ?? ''),
    headers,
    ...(payload ? { payload } : {}),
  });
}

describe('v0.7: the posts switch', () => {
  it('off: every posts route is 403 with the sentence, even with a bad body; no handler runs', async () => {
    api = await makeApi({ ctx: { settings: POSTS_OFF } });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const spies = V07.map(([name]) => vi.spyOn(ROUTE_IMPLS[name] as { handle: () => unknown }, 'handle'));
    for (const [name, def] of V07) {
      const res = await call(api, 'tcp', name, h(cookie));
      expect(res.statusCode, name).toBe(403);
      expect(ErrorBodySchema.parse(res.json()).error).toEqual({ code: 'forbidden', message: FEATURE_OFF.posts.message });
      if (def.method !== 'GET') expect((await call(api, 'tcp', name, h(cookie), { nonsense: 1 })).statusCode, `${name} bad body`).toBe(403);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(FEATURE_OFF.posts.message).toBe('Posts are off. Turn them on at your Mac: jantar life on posts');
  });

  it('on: the routes reach their handlers, and Today is on with posts alone', async () => {
    api = await makeApi({ ctx: { settings: POSTS_ON } });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    for (const [name] of V07) {
      const res = await call(api, 'tcp', name, h(cookie));
      expect(res.statusCode, `${name} ${res.body}`).not.toBe(403);
      if (ROUTE_IMPLS[name]?.stub) expect(res.statusCode, name).toBe(501);
    }
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/life/today', headers: h(cookie) })).statusCode).not.toBe(403);
    // Another module stays shut.
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/todos', headers: h(cookie) })).statusCode).toBe(403);
  });

  it('a read-only device gets no posts', async () => {
    api = await makeApi({ ctx: { settings: POSTS_ON } });
    const { cookie } = await pairCookie(api, ['read']);
    for (const [name] of V07) expect((await call(api, 'tcp', name, h(cookie))).statusCode, name).toBe(403);
  });
});

describe('v0.7: ctl.sock reach is the list and an add', () => {
  it('postsList and postCreate answer there; a change, a delete and the goals are 404', async () => {
    api = await makeApi({ ctx: { settings: POSTS_ON } });
    for (const name of ['postsList', 'postCreate'] as const) {
      const res = await call(api, 'ctl', name);
      expect(res.statusCode, `${name} ${res.body}`).not.toBe(404);
      if (ROUTE_IMPLS[name]?.stub) expect(res.statusCode, name).toBe(501);
    }
    for (const name of ['postUpdate', 'postDelete', 'postGoalsSet'] as const) expect((await call(api, 'ctl', name)).statusCode, name).toBe(404);
  });
});

describe('v0.7: posts are Life', () => {
  /** The inert Life part, broken: the pipeline asks `broken()` before every Life route's handler. */
  function brokenLife(): LifeService {
    const life = notBuiltParts().life;
    return new Proxy(life, { get: (t, p, r) => (p === 'broken' ? () => LIFE_BROKEN_REASON : Reflect.get(t, p, r)) });
  }

  it('a broken life.db answers 503 with the sentence on every posts route', async () => {
    expect(LIFE_FEATURES.has('posts')).toBe(true);
    api = await makeApi({ ctx: { settings: POSTS_ON }, deps: () => ({ life: brokenLife() }) });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    for (const [name] of V07) {
      const res = await call(api, 'tcp', name, h(cookie));
      expect(res.statusCode, name).toBe(503);
      expect(res.json().error, name).toEqual({ code: 'life_unavailable', message: LIFE_BROKEN_REASON });
    }
  });

  it("a posts write counts against the device's Life write limit", async () => {
    api = await makeApi({ ctx: { settings: SettingsSchema.parse({ life: { posts: true, todos: true } }) } });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    let limited = 0;
    for (let i = 0; i <= V04_LIMITS.lifeWrite.limit; i++) if ((await call(api, 'tcp', 'postDelete', h(cookie))).statusCode === 429) limited += 1;
    expect(limited).toBe(1);
    // The same device's todo write is now limited too: one limit for every Life write.
    expect((await api.tcp.inject({ method: 'DELETE', url: `/v1/todos/${ID}`, headers: h(cookie) })).statusCode).toBe(429);
  });
});
