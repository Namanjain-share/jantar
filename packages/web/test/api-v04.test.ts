// @vitest-environment node
/**
 * The v0.4 calls of the API client: a call per Life, Intel and Resume
 * route (the Mac-only backup and restore have none), paths and queries from
 * the route table, writes with an Idempotency-Key and the device secret, and
 * Ask Claude with no Idempotency-Key at all (LP3, web part), cancellable.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEVICE_SECRET_HEADER, ROUTES, type RouteDef } from '@jantar/protocol';
import { createApi, type Api } from '../src/lib/api.js';
import type { CredentialStore } from '../src/lib/credential.js';

const BASE = 'http://127.0.0.1:7420';
const ID = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const DOSE = '01JFZ8X8Y3T0V5G9WQK2M4N6PS';

function fetchOk(body: unknown = { ok: true }) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
}

const credentials: CredentialStore = {
  get: async () => ({ secret: 'S'.repeat(43), deviceId: 'dev-1', savedAt: '2026-10-30T00:00:00.000Z' }),
  set: async () => undefined,
  clear: async () => undefined,
} as unknown as CredentialStore;

const apiWith = (f: ReturnType<typeof fetchOk>) => createApi({ fetch: f as unknown as typeof fetch, base: BASE, credentials });

const headersOf = (init: RequestInit | undefined) => (init?.headers ?? {}) as Record<string, string>;

describe('v0.4 api client', () => {
  it('has a call for every v0.4 route except the Mac-only ones', () => {
    const api = apiWith(fetchOk());
    const v04 = (Object.entries(ROUTES) as [string, RouteDef][]).filter(([, r]) => r.phase === 'v0.4');
    for (const [name, r] of v04) {
      if (r.localOnly) expect((api as unknown as Record<string, unknown>)[name], name).toBeUndefined();
      else expect(typeof (api as unknown as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  it('reads with the day, month, filter and folder in the query', async () => {
    const f = fetchOk({});
    const api = apiWith(f);
    await api.lifeStatus();
    await api.lifeToday('2026-10-30');
    await api.todosList({ project: 'none', done: true });
    await api.medsGet('2026-10-29');
    await api.foodDay();
    await api.placesList('want');
    await api.moneyMonth('2026-10');
    await api.intelList({ q: 'hooks', tag: 'repo', limit: 10 });
    await api.intelGet('captures:01J/x');
    await api.launchHistory({ root: 'r.work', path: 'foo' });
    await api.launchPreview({ root: 'r.work', path: 'foo', resume: '0b4e7c4e-0000-4000-8000-000000000000' });
    expect(f.mock.calls.map(([url]) => String(url).slice(BASE.length))).toEqual([
      '/v1/life/status',
      '/v1/life/today?day=2026-10-30',
      '/v1/todos?project=none&done=1',
      '/v1/medicines?day=2026-10-29',
      '/v1/food',
      '/v1/places?filter=want',
      '/v1/money?month=2026-10',
      '/v1/intel?q=hooks&tag=repo&limit=10',
      '/v1/intel/items/captures%3A01J%2Fx',
      '/v1/launch/history?root=r.work&path=foo',
      '/v1/launch/preview?root=r.work&path=foo&resume=0b4e7c4e-0000-4000-8000-000000000000',
    ]);
    for (const [, init] of f.mock.calls) expect(init?.method).toBe('GET');
  });

  it('writes go to their routes with an Idempotency-Key (the one kept, when given) and the device secret', async () => {
    const f = fetchOk({ id: ID });
    const api = apiWith(f);
    const writes: [() => Promise<unknown>, string, string][] = [
      [() => api.projectCreate({ name: 'Example project' }), 'POST', '/v1/projects'],
      [() => api.todoDone(ID, false, 'kept-key'), 'POST', `/v1/todos/${ID}/done`],
      [() => api.todoSnooze(ID, 'tonight'), 'POST', `/v1/todos/${ID}/snooze`],
      [() => api.medStop(ID), 'POST', `/v1/medicines/${ID}/stop`],
      [() => api.doseLog(ID, { day: '2026-10-30', slot: '08:00', status: 'taken' }), 'POST', `/v1/medicines/${ID}/doses`],
      [() => api.doseUndo(ID, DOSE), 'DELETE', `/v1/medicines/${ID}/doses/${DOSE}`],
      [() => api.foodSavedDelete(ID), 'DELETE', `/v1/food/saved/${ID}`],
      [() => api.foodTargets({ kcalTarget: 1800 }), 'PUT', '/v1/food/targets'],
      [() => api.weightSet('2026-10-30', 72.4), 'PUT', '/v1/weights/2026-10-30'],
      [() => api.placeUpdate(ID, { tried: true }), 'PATCH', `/v1/places/${ID}`],
      [() => api.budgetSet({ category: 'Food', amount: null }), 'PUT', '/v1/money/budgets'],
      [() => api.billPaid(ID), 'POST', `/v1/bills/${ID}/paid`],
      [() => api.intelCapture({ title: 'Example capture' }), 'POST', '/v1/intel/captures'],
    ];
    for (const [i, [run, method, path]] of writes.entries()) {
      await run();
      const [url, init] = f.mock.calls[i]!;
      expect(String(url).slice(BASE.length), path).toBe(path);
      expect(init?.method, path).toBe(method);
      expect(headersOf(init)['idempotency-key'], path).toMatch(/.{8,}/);
      expect(headersOf(init)[DEVICE_SECRET_HEADER], path).toBe('S'.repeat(43));
    }
    expect(headersOf(f.mock.calls[1]![1])['idempotency-key']).toBe('kept-key');
    expect(JSON.parse(String(f.mock.calls[1]![1]?.body))).toEqual({ done: false });
    expect(JSON.parse(String(f.mock.calls[8]![1]?.body))).toEqual({ kg: 72.4 });
    expect(JSON.parse(String(f.mock.calls[11]![1]?.body))).toEqual({});
  });

  it('LP3: Ask Claude sends no Idempotency-Key, still sends the device secret, and can be cancelled', async () => {
    const f = fetchOk({ items: [{ name: 'Roti', kcal: 240 }] });
    const api: Api = apiWith(f);
    const ac = new AbortController();
    const r = await api.foodEstimate('2 rotis and dal', { signal: ac.signal });
    expect(r.items).toHaveLength(1);
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}/v1/food/estimate`);
    expect(init?.method).toBe('POST');
    expect(headersOf(init)).not.toHaveProperty('idempotency-key');
    expect(headersOf(init)[DEVICE_SECRET_HEADER]).toBe('S'.repeat(43));
    expect(init?.signal).toBe(ac.signal);
    expect(JSON.parse(String(init?.body))).toEqual({ text: '2 rotis and dal' });
  });
});
