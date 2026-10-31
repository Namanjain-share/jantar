/**
 * The worker's daemon client: its fixed table equals the protocol's routes;
 * every call goes to http://127.0.0.1:<port> with credentials omitted and
 * the key in its own header (never for the claim); a 401 forgets the key
 * once; no answer and a timeout are "down". One run against a real HTTP
 * server on port 0 shows what the daemon receives.
 */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ROUTES } from '@jantar/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CALL_TIMEOUT_MS, EXT_ROUTES, SHOT_TIMEOUT_MS, createClient } from '../../src/background/client.js';
import { memoryKeyStore } from '../../src/background/store.js';
import { EXTENSION_KEY_HEADER } from '../../src/shared/wire.js';
import { KEY, PAIRED, PORT, daemonError, fakeDaemon } from './chrome.js';

const CLIENT_ID = '0b6f5e2a-3c1d-4e8f-9a7b-2c4d6e8f0a1b';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the route table', () => {
  it("equals the protocol's extension routes, GET and POST only", () => {
    const names = { info: 'extInfo', claim: 'extPairClaim', open: 'extMeetingOpen', lines: 'extMeetingLines', shot: 'extMeetingShot', end: 'extMeetingEnd' } as const;
    for (const [op, name] of Object.entries(names)) {
      const ours = EXT_ROUTES[op as keyof typeof EXT_ROUTES];
      expect({ method: ours.method, path: ours.path }, op).toEqual({ method: ROUTES[name].method, path: ROUTES[name].path });
    }
    for (const r of Object.values(EXT_ROUTES)) expect(['GET', 'POST']).toContain(r.method);
    expect(Object.keys(EXT_ROUTES).sort()).toEqual(Object.keys(names).sort());
  });

  it('keeps the timeouts the spec names: 5 s, a screenshot 15 s', () => {
    expect(CALL_TIMEOUT_MS).toBe(5_000);
    expect(SHOT_TIMEOUT_MS).toBe(15_000);
  });
});

describe('createClient', () => {
  const make = (daemon = fakeDaemon(), keys = memoryKeyStore(PAIRED), onUnpaired = vi.fn(async () => undefined)) => ({
    client: createClient({ keys, fetch: daemon.fetch, onUnpaired }),
    daemon,
    keys,
    onUnpaired,
  });

  it('calls 127.0.0.1 on the stored port with the key, credentials omitted', async () => {
    const { client, daemon } = make();
    expect(await client.call('info')).toEqual({ kind: 'ok', status: 200, body: { projects: [] } });
    await client.call('lines', { clientId: CLIENT_ID, body: { lines: [] } });
    const [info, lines] = daemon.calls;
    expect(info).toMatchObject({ method: 'GET', url: `http://127.0.0.1:${PORT}/v1/ext/info`, credentials: 'omit', body: undefined });
    expect(info?.headers).toEqual({ [EXTENSION_KEY_HEADER]: KEY });
    expect(lines).toMatchObject({ method: 'POST', url: `http://127.0.0.1:${PORT}/v1/ext/meetings/${CLIENT_ID}/lines`, credentials: 'omit', body: { lines: [] } });
    expect(lines?.headers).toEqual({ [EXTENSION_KEY_HEADER]: KEY, 'content-type': 'application/json' });
  });

  it('claims on the pasted port without a key', async () => {
    const { client, daemon } = make(fakeDaemon(), memoryKeyStore(null));
    const reply = await client.claim(40_001, 'C0DEc0de_C0DE-c0deC0');
    expect(reply.kind).toBe('ok');
    expect(daemon.calls[0]).toMatchObject({ method: 'POST', url: 'http://127.0.0.1:40001/v1/ext/pair', credentials: 'omit', body: { code: 'C0DEc0de_C0DE-c0deC0' } });
    expect(daemon.calls[0]?.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('answers unpaired without calling when no key is stored', async () => {
    const { client, daemon } = make(fakeDaemon(), memoryKeyStore(null));
    expect(await client.call('info')).toEqual({ kind: 'unpaired' });
    expect(daemon.calls).toHaveLength(0);
  });

  it("passes the daemon's sentence on, and a plain one when it gave none", async () => {
    const daemon = fakeDaemon();
    daemon.on('info', daemonError(403, 'Meetings are off. Turn them on at your Mac: jantar meetings on'), { status: 500, body: 'nope' });
    const { client } = make(daemon);
    expect(await client.call('info')).toEqual({ kind: 'error', status: 403, sentence: 'Meetings are off. Turn them on at your Mac: jantar meetings on' });
    expect(await client.call('info')).toEqual({ kind: 'error', status: 500, sentence: 'Jantar answered with an error (500).' });
  });

  it('a refused connection is down', async () => {
    const daemon = fakeDaemon();
    daemon.on('info', 'down');
    expect(await make(daemon).client.call('info')).toEqual({ kind: 'down' });
  });

  it('a 401 forgets the key and says so, once', async () => {
    const daemon = fakeDaemon();
    daemon.on('info', daemonError(401, 'The Jantar extension is not paired.'));
    const { client, keys, onUnpaired } = make(daemon);
    expect(await client.call('info')).toEqual({ kind: 'unpaired', forgotten: true });
    expect(await keys.get()).toBeNull();
    expect(onUnpaired).toHaveBeenCalledTimes(1);
    expect(await client.call('info')).toEqual({ kind: 'unpaired' });
    expect(daemon.calls).toHaveLength(1);
  });

  it('a 401 keeps a key that was paired while the call was out', async () => {
    const daemon = fakeDaemon();
    const keys = memoryKeyStore(PAIRED);
    const held = daemon.hold('info');
    const { client, onUnpaired } = make(daemon, keys);
    const call = client.call('info');
    await held.started;
    await keys.set({ ...PAIRED, key: `${KEY.slice(0, -1)}Z` });
    held.release(daemonError(401, 'not paired'));
    expect(await call).toEqual({ kind: 'unpaired', forgotten: true });
    expect((await keys.get())?.key).toBe(`${KEY.slice(0, -1)}Z`);
    expect(onUnpaired).not.toHaveBeenCalled();
  });

  it('a call that takes too long is down', async () => {
    const hang: typeof fetch = (_u, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError'))));
    const client = createClient({ keys: memoryKeyStore(PAIRED), fetch: hang, onUnpaired: async () => undefined, timeouts: { call: 20, shot: 40 } });
    expect(await client.call('info')).toEqual({ kind: 'down' });
    expect(await client.call('shot', { clientId: CLIENT_ID, body: {} })).toEqual({ kind: 'down' });
  });

  it('never puts anything but a uuid it was given into a path', async () => {
    const { client, daemon } = make();
    await expect(client.call('lines', { clientId: '../../v1/settings', body: { lines: [] } })).rejects.toThrow();
    await expect(client.call('end', { body: {} })).rejects.toThrow();
    expect(daemon.calls).toHaveLength(0);
  });
});

describe('against a real HTTP server', () => {
  it('sends what the daemon expects: the key header, JSON, no cookie', async () => {
    const seen: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        res.end(req.url === '/v1/ext/info' ? '{"projects":null}' : '{"id":"01JFZ8X8Y3T0V5G9WQK2M4N6PR"}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const client = createClient({ keys: memoryKeyStore({ ...PAIRED, port }), fetch: (u, i) => fetch(u, i), onUnpaired: async () => undefined });
      expect(await client.call('info')).toEqual({ kind: 'ok', status: 200, body: { projects: null } });
      const open = await client.call('open', { clientId: CLIENT_ID, body: { site: 'meet', name: 'Weekly sync', autoTodos: false, captions: true, at: 1 } });
      expect(open).toEqual({ kind: 'ok', status: 200, body: { id: '01JFZ8X8Y3T0V5G9WQK2M4N6PR' } });
      expect(seen[0]).toMatchObject({ method: 'GET', url: '/v1/ext/info', body: '' });
      expect(seen[0]?.headers[EXTENSION_KEY_HEADER]).toBe(KEY);
      expect(seen[0]?.headers.cookie).toBeUndefined();
      expect(seen[1]).toMatchObject({ method: 'POST', url: `/v1/ext/meetings/${CLIENT_ID}` });
      expect(seen[1]?.headers['content-type']).toBe('application/json');
      expect(JSON.parse(seen[1]?.body ?? '')).toEqual({ site: 'meet', name: 'Weekly sync', autoTodos: false, captions: true, at: 1 });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
