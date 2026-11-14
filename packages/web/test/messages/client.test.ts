// @vitest-environment node
/**
 * 0.15 Messages' client (ui/screens/messages/client.ts): every path it calls
 * is one of `@jantar/protocol/messages`'s MESSAGES_ROUTES, by method and
 * path; it never calls the skip list's remove (a phone never widens what
 * Jantar reads); writes carry the device secret and their kept
 * Idempotency-Key; a blank search is left out of the query.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEVICE_SECRET_HEADER } from '@jantar/protocol';
import { MESSAGES_ROUTES } from '@jantar/protocol/messages';
import { createApi } from '../../src/lib/api.js';
import { MESSAGES_PATHS, messagesClient } from '../../src/ui/screens/messages/client.js';
import { IDS } from './helpers.js';

function recorder(reply: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const api = createApi({
    fetch: fetch as unknown as typeof globalThis.fetch,
    base: 'http://127.0.0.1:7420',
    credentials: { get: async () => ({ secret: 's3cret', deviceId: 'd1', savedAt: '2026-01-15T10:00:00.000Z' }), set: async () => undefined, clear: async () => undefined },
  });
  return { api, calls };
}

const line = (c: { url: string; init: RequestInit }) => `${c.init.method} ${c.url.replace('http://127.0.0.1:7420', '')}`;

describe("Messages' client", () => {
  it('calls only routes of MESSAGES_ROUTES, by method and path, and never the skip remove', () => {
    for (const [key, r] of Object.entries(MESSAGES_PATHS)) {
      const def = (MESSAGES_ROUTES as Record<string, { method: string; path: string }>)[key];
      expect(def, key).toBeDefined();
      expect({ method: r.method, path: r.path }, key).toEqual({ method: def!.method, path: def!.path });
    }
    expect(Object.keys(MESSAGES_PATHS)).not.toContain('messagesSkipRemove');
    expect(Object.values(MESSAGES_PATHS).map((r) => r.method)).not.toContain('DELETE');
  });

  it('reads are plain GETs; a blank search is left out, a search is trimmed', async () => {
    const { api, calls } = recorder({});
    const m = messagesClient(api);
    await m.status();
    await m.today();
    await m.prefs();
    await m.skipList();
    await m.reads(50);
    await m.chats('  ', 20);
    await m.chats('  Asha ', 20);
    expect(calls.map(line)).toEqual([
      'GET /v1/messages/status',
      'GET /v1/messages/today',
      'GET /v1/messages/prefs',
      'GET /v1/messages/skip',
      'GET /v1/messages/reads?limit=50',
      'GET /v1/messages/chats?limit=20',
      'GET /v1/messages/chats?q=Asha&limit=20',
    ]);
    for (const c of calls) expect((c.init.headers as Record<string, string>)[DEVICE_SECRET_HEADER]).toBeUndefined();
  });

  it('writes carry the device secret and their kept Idempotency-Key, with strict bodies', async () => {
    const { api, calls } = recorder({ ok: true });
    const m = messagesClient(api);
    await m.setDraft(IDS.draftAsha, 'done', 'key-1');
    await m.run('key-2');
    await m.undo(IDS.run, 'key-3');
    await m.setPrefs({ morningAt: null }, 'key-4');
    await m.skip(IDS.asha, 'key-5');
    expect(calls.map(line)).toEqual([
      `PATCH /v1/messages/drafts/${IDS.draftAsha}`,
      'POST /v1/messages/morning/run',
      `POST /v1/messages/morning/${IDS.run}/undo`,
      'PATCH /v1/messages/prefs',
      'POST /v1/messages/skip',
    ]);
    const bodies = calls.map((c) => (c.init.body === undefined ? undefined : JSON.parse(String(c.init.body))));
    expect(bodies).toEqual([{ state: 'done' }, {}, undefined, { morningAt: null }, { chatKey: IDS.asha }]);
    calls.forEach((c, i) => {
      const h = c.init.headers as Record<string, string>;
      expect(h[DEVICE_SECRET_HEADER]).toBe('s3cret');
      expect(h['idempotency-key']).toBe(`key-${i + 1}`);
    });
  });
});
