// @vitest-environment node
/**
 * v0.12 People: her API client calls her routes only, by the paths and
 * methods PERSON_ROUTES has (so a path can't drift), and sends her device
 * secret on writes.
 */
import { describe, expect, it } from 'vitest';
import { PERSON_ROUTES } from '@jantar/protocol/people';
import { PERSON_PATHS, createPersonApi } from '../../src/partner/api.js';

describe('her API client', () => {
  it('every path it calls is one of her routes, with its method', () => {
    const routes = new Set(Object.values(PERSON_ROUTES).map((d) => `${d.method} ${d.path}`));
    for (const [key, [method, path]] of Object.entries(PERSON_PATHS)) {
      expect(path.startsWith('/v1/p/'), key).toBe(true);
      expect(routes.has(`${method} ${path}`), key).toBe(true);
    }
  });

  it('sends her secret and an Idempotency-Key on writes, none on reads', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = createPersonApi({
      base: 'https://us.example.com',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      credentials: { get: async () => ({ secret: 'a'.repeat(43), deviceId: 'd' }), set: async () => {}, clear: async () => {} },
    });
    await api.me();
    await api.pause();
    const [read, write] = calls;
    expect(read?.url).toBe('https://us.example.com/v1/p/me');
    expect((read?.init.headers as Record<string, string>)['x-jantar-device-secret']).toBeUndefined();
    expect((write?.init.headers as Record<string, string>)['x-jantar-device-secret']).toBe('a'.repeat(43));
    expect((write?.init.headers as Record<string, string>)['idempotency-key']).toMatch(/^[0-9a-f]{32}$/);
  });
});
