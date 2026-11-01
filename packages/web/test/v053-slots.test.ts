// @vitest-environment node
/**
 * WP0's v0.5.3 slots in the web app's shared files: the three v0.5.3 routes
 * are the Mac's only, so the client has no call for them; the shelf's list
 * takes `sort`; /intel reads `?focus=search` (the header magnifier's link)
 * and nothing else there; the Board's chip uses protocol's projectFor (the
 * daemon's folder todos pick the same project).
 */
import { describe, expect, it, vi } from 'vitest';
import { ROUTES, inFolder as protocolInFolder, projectFor as protocolProjectFor, type RouteDef } from '@jantar/protocol';
import { createApi } from '../src/lib/api.js';
import type { CredentialStore } from '../src/lib/credential.js';
import { parseRoute, routePath, type Route } from '../src/lib/router.js';
import { inFolder, projectFor } from '../src/ui/screens/life/todos/useProjects.js';

const BASE = 'http://127.0.0.1:7420';

function fetchOk(body: unknown = {}) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
}

const credentials: CredentialStore = {
  get: async () => ({ secret: 'S'.repeat(43), deviceId: 'dev-1', savedAt: '2026-10-30T00:00:00.000Z' }),
  set: async () => undefined,
  clear: async () => undefined,
} as unknown as CredentialStore;

describe('v0.5.3 api client', () => {
  it('has no call for the Mac-only routes', () => {
    const api = createApi({ fetch: fetchOk() as unknown as typeof fetch, base: BASE, credentials }) as unknown as Record<string, unknown>;
    // Ask's seven v0.5.3 routes are the phone's, with calls of their own (ask.test.tsx).
    const v053 = (Object.entries(ROUTES) as [string, RouteDef][]).filter(([, r]) => r.phase === 'v0.5.3' && r.feature !== 'ask');
    expect(v053).toHaveLength(3);
    for (const [name, r] of v053) {
      expect(r.localOnly, name).toBe(true);
      expect(api[name], name).toBeUndefined();
    }
  });

  it('lists the shelf with sort in the query', async () => {
    const f = fetchOk();
    const api = createApi({ fetch: f as unknown as typeof fetch, base: BASE, credentials });
    await api.intelList({ q: 'prisma migrate', sort: 'best' });
    await api.intelList({ sort: 'new', limit: 10 });
    expect(f.mock.calls.map(([url]) => String(url).slice(BASE.length))).toEqual(['/v1/intel?q=prisma+migrate&sort=best', '/v1/intel?limit=10&sort=new']);
  });
});

describe('the intel route', () => {
  it('round-trips focus=search and drops any other focus', () => {
    const cases: Route[] = [{ name: 'intel', focus: 'search' }, { name: 'intel', q: 'hooks', focus: 'search' }, { name: 'intel' }];
    for (const r of cases) {
      const u = new URL(routePath(r), 'http://x');
      expect(parseRoute(u.pathname, u.search), routePath(r)).toEqual(r);
    }
    expect(routePath({ name: 'intel', focus: 'search' })).toBe('/intel?focus=search');
    expect(parseRoute('/intel', '?focus=menu')).toEqual({ name: 'intel' });
    expect(parseRoute('/intel', '?focus=__proto__')).toEqual({ name: 'intel' });
  });
});

describe("the Board's project chip", () => {
  it('uses protocol\'s folder rule, the one the daemon uses', () => {
    expect(projectFor).toBe(protocolProjectFor);
    expect(inFolder).toBe(protocolInFolder);
  });
});
