// @vitest-environment node
/**
 * The v0.7 calls of the API client: Posts' list (open, or ?done=1), add,
 * change, delete and the weekly goals, each write with the device secret
 * and the Idempotency-Key it was given. The phone calls every one of
 * v0.7's routes; none posts anything anywhere (they keep the plan at the
 * Mac). A fakeApi knows the new calls.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEVICE_SECRET_HEADER, ROUTES, type RouteDef } from '@jantar/protocol';
import { createApi } from '../src/lib/api.js';
import type { CredentialStore } from '../src/lib/credential.js';
import { fakeApi } from './helpers.js';

const BASE = 'http://127.0.0.1:7420';
const ID = '01JF1EETN0DEBV11D1000000A1';

function fetchOk(body: unknown = { ok: true }) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
}

const credentials = {
  get: async () => ({ secret: 'S'.repeat(43), deviceId: 'dev-1', savedAt: '2026-10-30T00:00:00.000Z' }),
  set: async () => undefined,
  clear: async () => undefined,
} as unknown as CredentialStore;

const apiWith = (f: ReturnType<typeof fetchOk>) => createApi({ fetch: f as unknown as typeof fetch, base: BASE, credentials });
const calls = (f: ReturnType<typeof fetchOk>) =>
  f.mock.calls.map(([url, init]) => ({
    path: String(url).slice(BASE.length),
    method: init?.method,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
    headers: (init?.headers ?? {}) as Record<string, string>,
  }));

describe('v0.7 api client: posts', () => {
  it('lists the posts to make, or the posted and skipped ones', async () => {
    const f = fetchOk({ today: '2026-11-02', week: { from: '2026-11-02', to: '2026-11-08', posted: 0, goals: [] }, posts: [] });
    const api = apiWith(f);
    await api.postsList();
    await api.postsList('open');
    await api.postsList('done');
    expect(calls(f).map((c) => [c.method, c.path])).toEqual([
      ['GET', '/v1/posts'],
      ['GET', '/v1/posts'],
      ['GET', '/v1/posts?done=1'],
    ]);
  });

  it('adds, changes and deletes a post, and sets the goals, with the device secret and the key given', async () => {
    const f = fetchOk({ ok: true });
    const api = apiWith(f);
    const body = { platform: 'reddit' as const, where: 'r/exampletools', title: 'An example', due: { day: '2026-11-02', time: '19:30' }, status: 'ready' as const };
    await api.postCreate(body, 'k1');
    await api.postUpdate(ID, { status: 'posted' }, 'k2');
    await api.postDelete(ID, 'k3');
    await api.postGoalsSet({ goals: [{ platform: 'instagram', kind: 'reel', perWeek: 3 }] }, 'k4');
    const c = calls(f);
    expect(c.map((x) => [x.method, x.path])).toEqual([
      ['POST', '/v1/posts'],
      ['PATCH', `/v1/posts/${ID}`],
      ['DELETE', `/v1/posts/${ID}`],
      ['PUT', '/v1/posts/goals'],
    ]);
    expect(c[0]!.body).toEqual(body);
    expect(c[1]!.body).toEqual({ status: 'posted' });
    expect(c[2]!.body).toBeUndefined();
    expect(c[3]!.body).toEqual({ goals: [{ platform: 'instagram', kind: 'reel', perWeek: 3 }] });
    expect(c.map((x) => x.headers['idempotency-key'])).toEqual(['k1', 'k2', 'k3', 'k4']);
    for (const x of c) expect(x.headers[DEVICE_SECRET_HEADER], x.path).toBe('S'.repeat(43));
  });

  it("calls every one of v0.7's routes, and a fakeApi knows them", () => {
    const api = apiWith(fetchOk());
    const v07 = (Object.entries(ROUTES) as [string, RouteDef][]).filter(([, r]) => r.phase === 'v0.7').map(([n]) => n);
    expect(v07.sort()).toEqual(['postCreate', 'postDelete', 'postGoalsSet', 'postUpdate', 'postsList']);
    for (const n of v07) {
      expect(typeof (api as unknown as Record<string, unknown>)[n], n).toBe('function');
      expect(typeof (fakeApi() as unknown as Record<string, unknown>)[n], n).toBe('function');
    }
  });
});
