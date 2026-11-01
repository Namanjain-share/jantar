// @vitest-environment node
/**
 * The v0.8 calls of the API client (Intel reads links): save and read a
 * link, Retry and Read again (with or without a depth), the jobs, Delete,
 * and a thumbnail as a Blob. Every write carries the device secret and the
 * Idempotency-Key it was given. The phone calls exactly the shelf's v0.8
 * routes: never the capture door, the capture keys, the Mac's read status
 * or the extension's reads. A fakeApi knows the new calls.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEVICE_SECRET_HEADER, ROUTES, type RouteDef } from '@jantar/protocol';
import { ApiError, createApi } from '../src/lib/api.js';
import type { CredentialStore } from '../src/lib/credential.js';
import { fakeApi } from './helpers.js';

const BASE = 'http://127.0.0.1:7420';
const ID = 'captures:01JSYNTHREAD0000000000000A';

function fetchOk(body: unknown = { ok: true }) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
}

const credentials = {
  get: async () => ({ secret: 'S'.repeat(43), deviceId: 'dev-1', savedAt: '2026-11-02T00:00:00.000Z' }),
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

describe('v0.8 api client: Intel reads links', () => {
  it('saves and reads, reads again, deletes: each write with the device secret and the key given', async () => {
    const f = fetchOk({ id: ID, duplicate: false, queued: true, message: 'Saved. Reading it on your Mac.' });
    const api = apiWith(f);
    await api.intelRead({ text: 'https://www.example.com/reel/AbC123xyz/ worth a look', depth: 'full' }, 'k1');
    await api.intelReread(ID, 'light', 'k2');
    await api.intelReread(ID, undefined, 'k3');
    await api.intelDelete(ID, 'k4');
    const c = calls(f);
    const id = encodeURIComponent(ID);
    expect(c.map((x) => [x.method, x.path])).toEqual([
      ['POST', '/v1/intel/reads'],
      ['POST', `/v1/intel/items/${id}/read`],
      ['POST', `/v1/intel/items/${id}/read`],
      ['DELETE', `/v1/intel/items/${id}`],
    ]);
    expect(c[0]!.body).toEqual({ text: 'https://www.example.com/reel/AbC123xyz/ worth a look', depth: 'full' });
    expect(c[1]!.body).toEqual({ depth: 'light' });
    // Retry with no depth: the item's own depth (the body the route's strict schema takes).
    expect(c[2]!.body).toEqual({});
    expect(c[3]!.body).toBeUndefined();
    expect(c.map((x) => x.headers['idempotency-key'])).toEqual(['k1', 'k2', 'k3', 'k4']);
    for (const x of c) expect(x.headers[DEVICE_SECRET_HEADER], x.path).toBe('S'.repeat(43));
  });

  it('reads the jobs with no secret and no key', async () => {
    const f = fetchOk({ jobs: [], reading: { on: true, canRun: true } });
    const r = await apiWith(f).intelJobs();
    expect(r.reading.on).toBe(true);
    const [c] = calls(f);
    expect([c!.method, c!.path]).toEqual(['GET', '/v1/intel/jobs']);
    expect(c!.headers['idempotency-key']).toBeUndefined();
    expect(c!.headers[DEVICE_SECRET_HEADER]).toBeUndefined();
  });

  it("brings a thumbnail's bytes as a Blob, and the Mac's refusal as an ApiError", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url).endsWith('/frames/0')
        ? new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })
        : new Response(JSON.stringify({ error: { code: 'not_found', message: 'No such picture.' } }), { status: 404, headers: { 'content-type': 'application/json' } }),
    );
    const api = createApi({ fetch: f as unknown as typeof fetch, base: BASE, credentials });
    const blob = await api.intelFrame(ID, 0);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(jpeg);
    expect(String(f.mock.calls[0]![0]).slice(BASE.length)).toBe(`/v1/intel/items/${encodeURIComponent(ID)}/frames/0`);
    const err = await api.intelFrame(ID, 6).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('not_found');
  });

  it("calls the shelf's v0.8 routes and no other, and a fakeApi knows them", () => {
    const api = apiWith(fetchOk());
    const v08 = (Object.entries(ROUTES) as [string, RouteDef][]).filter(([, r]) => r.phase === 'v0.8').map(([n]) => n);
    const phone = ['intelDelete', 'intelFrame', 'intelJobs', 'intelRead', 'intelReread'];
    for (const n of phone) {
      expect(v08, n).toContain(n);
      expect(typeof (api as unknown as Record<string, unknown>)[n], n).toBe('function');
      expect(typeof (fakeApi() as unknown as Record<string, unknown>)[n], n).toBe('function');
    }
    // The Shortcut's door, the Mac's status and keys, and the extension's reads are never the phone's.
    for (const n of v08.filter((x) => !phone.includes(x))) expect((api as unknown as Record<string, unknown>)[n], n).toBeUndefined();
  });
});
