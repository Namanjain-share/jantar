// @vitest-environment node
/**
 * The v0.6 calls of the API client (wave 0): every folder, start-sheet and
 * usage call takes an optional `node`, sent as `?node=` (the Mac forwards
 * it), and sends exactly what it sent before without one; the admin's
 * /v1/machines list and Remove (with the device secret). No call pairs a
 * server: that is the Mac's alone. A fakeApi knows the new calls.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEVICE_SECRET_HEADER, ROUTES, type RouteDef } from '@jantar/protocol';
import { createApi } from '../src/lib/api.js';
import type { CredentialStore } from '../src/lib/credential.js';
import { fakeApi } from './helpers.js';

const BASE = 'http://127.0.0.1:7420';
const NODE = '01JF1EETN0DEBV11D1000000A1';

function fetchOk(body: unknown = { ok: true }) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
}

const credentials = {
  get: async () => ({ secret: 'S'.repeat(43), deviceId: 'dev-1', savedAt: '2026-10-30T00:00:00.000Z' }),
  set: async () => undefined,
  clear: async () => undefined,
} as unknown as CredentialStore;

const apiWith = (f: ReturnType<typeof fetchOk>) => createApi({ fetch: f as unknown as typeof fetch, base: BASE, credentials });
const paths = (f: ReturnType<typeof fetchOk>) => f.mock.calls.map(([url]) => String(url).slice(BASE.length));
const flags = { permission: 'manual', chrome: false, effort: 'default', model: 'default' } as const;
const start = { root: 'r.work', path: 'api-server', account: 'auto' as const, flags };

describe('v0.6 api client', () => {
  it('sends ?node= on every folder, start-sheet and usage call when given', async () => {
    const f = fetchOk({});
    const api = apiWith(f);
    await api.foldersRoots({ node: NODE });
    await api.foldersList({ root: 'r.work', path: 'a', node: NODE });
    await api.foldersRecent({ node: NODE });
    await api.foldersPin({ root: 'r.work', path: 'a', pinned: true }, { node: NODE });
    await api.foldersCreate({ root: 'r.work', parent: '', name: 'new-app' }, 'k1', { node: NODE });
    await api.launchPreview({ root: 'r.work', path: 'a', node: NODE });
    await api.launchStart(start, 'k2', { node: NODE });
    await api.launchHistory({ root: 'r.work', path: 'a', node: NODE });
    await api.refreshUsage({ node: NODE });
    for (const p of paths(f)) expect(p, p).toContain(`node=${NODE}`);
    expect(paths(f)[0]).toBe(`/v1/folders/roots?node=${NODE}`);
    expect(paths(f)[6]).toBe(`/v1/launches?node=${NODE}`);
    // The body stays the Mac's shape: the node rides in the query only.
    expect(JSON.parse(String(f.mock.calls[6]?.[1]?.body))).toEqual(start);
  });

  it("sends exactly v0.5's calls without one", async () => {
    const f = fetchOk({});
    const api = apiWith(f);
    await api.foldersRoots();
    await api.foldersList({ root: 'r.work' });
    await api.foldersRecent();
    await api.launchStart(start, 'k2');
    await api.launchHistory({ root: 'r.work' });
    await api.refreshUsage();
    expect(paths(f)).toEqual(['/v1/folders/roots', '/v1/folders?root=r.work', '/v1/folders/recent', '/v1/launches', '/v1/launch/history?root=r.work', '/v1/usage/refresh']);
  });

  it('lists the machines and removes one with the device secret; never pairs one', async () => {
    const f = fetchOk({ machines: [] });
    const api = apiWith(f);
    await api.machinesList();
    await api.machineRevoke(NODE, 'k3');
    expect(paths(f)).toEqual(['/v1/machines', `/v1/machines/${NODE}`]);
    const [, init] = f.mock.calls[1] ?? [];
    expect(init?.method).toBe('DELETE');
    expect((init?.headers as Record<string, string>)[DEVICE_SECRET_HEADER]).toBe('S'.repeat(43));
    expect((init?.headers as Record<string, string>)['idempotency-key']).toBe('k3');
    const names = Object.keys(api);
    expect(names).not.toContain('machinesPair');
    expect(names).not.toContain('nodePair');
    const v06 = (Object.entries(ROUTES) as [string, RouteDef][]).filter(([, r]) => r.phase === 'v0.6').map(([n]) => n);
    // Of v0.6's routes the phone calls the admin's two; the server's claim and the Mac's pairing are not its.
    expect(v06.filter((n) => typeof (api as unknown as Record<string, unknown>)[n] === 'function').sort()).toEqual(['machineRevoke', 'machinesList']);
  });

  it('fakeApi knows the new calls (no machines until a test gives some)', async () => {
    const api = fakeApi();
    expect(await api.machinesList()).toEqual({ machines: [] });
    await expect(api.machineRevoke(NODE)).rejects.toThrow(/not built yet/);
  });
});
