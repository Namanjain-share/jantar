// @vitest-environment node
/**
 * 0.13.0 Work's client (ui/screens/work/client.ts): every path it calls is
 * one of `@jantar/protocol/work`'s WORK_ROUTES, by method and path, and
 * each call goes through `api.request` with the device secret and an
 * Idempotency-Key on a write, as every call does (lib/api.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { DEVICE_SECRET_HEADER } from '@jantar/protocol';
import { WORK_ROUTES } from '@jantar/protocol/work';
import { createApi } from '../../src/lib/api.js';
import { SEARCH_MAX, SEARCH_MIN, WORK_PATHS, workClient } from '../../src/ui/screens/work/client.js';

function recorder(reply: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const api = createApi({ fetch: fetch as unknown as typeof globalThis.fetch, base: 'http://127.0.0.1:7420', credentials: { get: async () => ({ secret: 's3cret', deviceId: 'd1', savedAt: '2026-01-15T10:00:00.000Z' }), set: async () => undefined, clear: async () => undefined } });
  return { api, calls };
}

describe("Work's client", () => {
  it('calls only routes of WORK_ROUTES, by method and path', () => {
    for (const [key, r] of Object.entries(WORK_PATHS)) {
      const def = (WORK_ROUTES as Record<string, { method: string; path: string }>)[key];
      expect(def, key).toBeDefined();
      expect({ method: r.method, path: r.path }, key).toEqual({ method: def!.method, path: def!.path });
    }
  });

  it('keeps the search caps of WORK_LIMITS', async () => {
    const { WORK_LIMITS } = await import('@jantar/protocol/work');
    expect([SEARCH_MIN, SEARCH_MAX]).toEqual([WORK_LIMITS.searchMin, WORK_LIMITS.searchMax]);
  });

  it('a read is a plain GET; a write carries the device secret and its kept Idempotency-Key', async () => {
    const { api, calls } = recorder({ projects: [], skipped: 0 });
    const w = workClient(api);
    await w.projectHub('01JWRKPRJ0000000000000ACME');
    await w.search('  acme  ');
    await w.clientNames(['01JWRKC11ENT00000000000ACM', '01JWRKC11ENT00000000000NWD']);
    await w.seed({ items: [{ root: 'r.work', path: 'client/acme', name: 'Acme' }], clients: true }, 'key-1');
    expect(calls.map((c) => `${c.init.method} ${c.url.replace('http://127.0.0.1:7420', '')}`)).toEqual([
      'GET /v1/projects/01JWRKPRJ0000000000000ACME',
      'GET /v1/search?q=acme',
      'GET /v1/work/clients/names?ids=01JWRKC11ENT00000000000ACM%2C01JWRKC11ENT00000000000NWD',
      'POST /v1/work/seed',
    ]);
    const get = calls[0]!.init.headers as Record<string, string>;
    expect(get[DEVICE_SECRET_HEADER]).toBeUndefined();
    const post = calls[3]!.init.headers as Record<string, string>;
    expect(post[DEVICE_SECRET_HEADER]).toBe('s3cret');
    expect(post['idempotency-key']).toBe('key-1');
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ items: [{ root: 'r.work', path: 'client/acme', name: 'Acme' }], clients: true });
  });

  it("his clients: the list's filters as a query, the similar check a POST (no phone in a URL), the export as text", async () => {
    const { api, calls } = recorder({ clients: [], more: 0, matches: [] });
    const w = workClient(api);
    await w.clients({ q: ' acme ', state: 'lead', tag: 'retail', sort: 'touch' });
    await w.clientSimilar({ phone: '+91 98765 43210' });
    await w.logAdd('01JWRKC11ENT00000000000ACM', { kind: 'call', next: { title: 'Send the quote', due: { day: '2026-01-16' } } }, 'key-2');
    await w.importUndo('01JWRKBATCH000000000000001', 'key-3');
    await w.notDuplicate('01JWRKC11ENT00000000000ACM', '01JWRKC11ENT00000000000NWD');
    expect(calls.map((c) => `${c.init.method} ${c.url.replace('http://127.0.0.1:7420', '')}`)).toEqual([
      'GET /v1/work/clients?q=acme&state=lead&tag=retail&sort=touch',
      'POST /v1/work/clients/similar',
      'POST /v1/work/clients/01JWRKC11ENT00000000000ACM/log',
      'DELETE /v1/work/import/01JWRKBATCH000000000000001',
      'POST /v1/work/clients/01JWRKC11ENT00000000000ACM/not-duplicate',
    ]);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ phone: '+91 98765 43210' });
    expect(JSON.parse(String(calls[4]!.init.body))).toEqual({ otherId: '01JWRKC11ENT00000000000NWD' });

    const csv = 'name,kind\r\nAcme,company\r\n';
    const fetch = vi.fn(async () => new Response(csv, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' } }));
    const raw = createApi({ fetch: fetch as unknown as typeof globalThis.fetch, base: 'http://127.0.0.1:7420', credentials: { get: async () => null, set: async () => undefined, clear: async () => undefined } });
    expect(await workClient(raw).exportCsv()).toBe(csv);
    expect(String((fetch.mock.calls[0] as unknown as [string])[0])).toBe('http://127.0.0.1:7420/v1/work/export.csv?what=clients');
  });
});
