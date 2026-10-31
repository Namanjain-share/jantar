// @vitest-environment node
/**
 * The v0.5 calls of the API client: one per phone Meetings route, none for
 * the extension's `/v1/ext/` routes; paths and queries from the route table;
 * writes with an Idempotency-Key (the one kept, when given) and the device
 * secret; a meeting's screenshot as a Blob.
 */
import { describe, expect, it, vi } from 'vitest';
import { meetingDetail } from '@jantar/fixtures';
import { DEVICE_SECRET_HEADER, MeetingDetailSchema, ROUTES, type RouteDef } from '@jantar/protocol';
import { createApi } from '../src/lib/api.js';
import type { CredentialStore } from '../src/lib/credential.js';

const BASE = 'http://127.0.0.1:7420';
const ID = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const SHOT = '01JFZ8X8Y3T0V5G9WQK2M4N6PS';

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

describe('v0.5 api client', () => {
  it("has a call for every phone route, and none for the extension's", () => {
    const api = apiWith(fetchOk()) as unknown as Record<string, unknown>;
    const v05 = (Object.entries(ROUTES) as [string, RouteDef][]).filter(([, r]) => r.phase === 'v0.5');
    for (const [name, r] of v05) {
      if (r.path.startsWith('/v1/ext/')) expect(api[name], name).toBeUndefined();
      else expect(typeof api[name], name).toBe('function');
    }
    expect(v05.filter(([, r]) => !r.path.startsWith('/v1/ext/'))).toHaveLength(9);
  });

  it('reads with the filter, search and cursor in the query', async () => {
    const f = fetchOk({});
    const api = apiWith(f);
    await api.meetingsStatus();
    await api.meetingsList();
    await api.meetingsList({ project: 'none', q: 'launch date', before: '2026-10-30T10:00:00.000Z|x', limit: 10 });
    await api.meetingGet(ID);
    expect(f.mock.calls.map(([url]) => String(url).slice(BASE.length))).toEqual([
      '/v1/meetings/status',
      '/v1/meetings',
      '/v1/meetings?project=none&q=launch+date&before=2026-10-30T10%3A00%3A00.000Z%7Cx&limit=10',
      `/v1/meetings/${ID}`,
    ]);
    for (const [, init] of f.mock.calls) expect(init?.method).toBe('GET');
  });

  it("a meeting comes back as the daemon's detail (the fixtures' meeting parses)", async () => {
    const detail = meetingDetail();
    const got = await apiWith(fetchOk(detail)).meetingGet(detail.meeting.id);
    expect(MeetingDetailSchema.parse(got)).toEqual(detail);
  });

  it('a screenshot comes back as a Blob, cancellable, without the device secret', async () => {
    const f = vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    const api = createApi({ fetch: f as unknown as typeof fetch, base: BASE, credentials });
    const ac = new AbortController();
    const blob = await api.meetingShot(ID, SHOT, { signal: ac.signal });
    expect(blob.size).toBe(3);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe(`${BASE}/v1/meetings/${ID}/shots/${SHOT}`);
    expect(init.signal).toBe(ac.signal);
    expect(headersOf(init)).not.toHaveProperty(DEVICE_SECRET_HEADER);
  });

  it('writes go to their routes with an Idempotency-Key and the device secret', async () => {
    const f = fetchOk({ id: ID });
    const api = apiWith(f);
    const writes: [() => Promise<unknown>, string, string][] = [
      [() => api.meetingUpdate(ID, { name: 'Weekly sync', projectId: null }, 'kept-key'), 'PATCH', `/v1/meetings/${ID}`],
      [() => api.meetingDelete(ID), 'DELETE', `/v1/meetings/${ID}`],
      [() => api.meetingSummarize(ID), 'POST', `/v1/meetings/${ID}/summary`],
      [() => api.meetingItemTodo(ID, 2), 'POST', `/v1/meetings/${ID}/items/2/todo`],
      [() => api.meetingItemUntodo(ID, 0), 'DELETE', `/v1/meetings/${ID}/items/0/todo`],
    ];
    for (const [i, [run, method, path]] of writes.entries()) {
      await run();
      const [url, init] = f.mock.calls[i]!;
      expect(String(url).slice(BASE.length), path).toBe(path);
      expect(init?.method, path).toBe(method);
      expect(headersOf(init)['idempotency-key'], path).toMatch(/.{8,}/);
      expect(headersOf(init)[DEVICE_SECRET_HEADER], path).toBe('S'.repeat(43));
    }
    expect(headersOf(f.mock.calls[0]![1])['idempotency-key']).toBe('kept-key');
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({ name: 'Weekly sync', projectId: null });
  });
});
