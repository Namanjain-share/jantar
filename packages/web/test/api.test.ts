import { describe, expect, it, vi } from 'vitest';
import { DEVICE_SECRET_HEADER, EVENTS_WS_PROTOCOL } from '@jantar/protocol';
import { ApiError, createApi, errorText, isApiError } from '../src/lib/api.js';
import { createCredentialStore } from '../src/lib/credential.js';

function fetchReturning(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

describe('api client', () => {
  it('builds paths from the route table and sends cookies same-origin', async () => {
    const f = fetchReturning(200, { session: {}, pending: [], pane: null });
    const api = createApi({ fetch: f as unknown as typeof fetch, base: 'https://mac.example.test' });
    await api.getSession('a b/c');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://mac.example.test/v1/sessions/a%20b%2Fc');
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('same-origin');
    expect((init?.headers as Record<string, string>)['idempotency-key']).toBeUndefined();
  });

  it('adds query parameters and skips undefined ones', async () => {
    const f = fetchReturning(200, { items: [], nextBefore: null });
    const api = createApi({ fetch: f as unknown as typeof fetch, base: 'http://127.0.0.1:7420' });
    await api.getTranscript('s1', { limit: 20 });
    expect(f.mock.calls[0]![0]).toBe('http://127.0.0.1:7420/v1/sessions/s1/transcript?limit=20');
    await api.getScreen('s1');
    expect(f.mock.calls[1]![0]).toBe('http://127.0.0.1:7420/v1/sessions/s1/screen?lines=80');
  });

  it('sends JSON bodies with an Idempotency-Key on writes', async () => {
    const f = fetchReturning(202, { jobId: 'j', job: {} });
    const api = createApi({ fetch: f as unknown as typeof fetch, base: 'http://127.0.0.1:7420' });
    await api.sendPrompt('s1', 'hello', 'key-123');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:7420/v1/sessions/s1/prompt');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'hello', onDraft: 'refuse' });
    const headers = init?.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('key-123');
    expect(headers['content-type']).toBe('application/json');

    await api.decide('p'.repeat(30), { behavior: 'allow', suggestion: 1, confirm: true });
    const [url2, init2] = f.mock.calls[1]!;
    expect(url2).toBe(`http://127.0.0.1:7420/v1/pending/${'p'.repeat(30)}/decision`);
    expect(JSON.parse(String(init2?.body))).toEqual({ behavior: 'allow', suggestion: 1, confirm: true });
    expect((init2?.headers as Record<string, string>)['idempotency-key']).toMatch(/.{16,}/);

    await api.pushUnsubscribe('https://push.example.test/x');
    const [url3, init3] = f.mock.calls[2]!;
    expect(url3).toBe('http://127.0.0.1:7420/v1/push/subscribe');
    expect(init3?.method).toBe('DELETE');
    expect(JSON.parse(String(init3?.body))).toEqual({ endpoint: 'https://push.example.test/x' });
  });

  it("turns the daemon's error body into an ApiError", async () => {
    const f = fetchReturning(409, { error: { code: 'needs_confirm', message: 'tap again' } });
    const api = createApi({ fetch: f as unknown as typeof fetch, base: 'http://127.0.0.1:7420' });
    const err = await api.decide('x'.repeat(30), { behavior: 'allow', suggestion: 0 }).catch((e: unknown) => e);
    expect(isApiError(err, 'needs_confirm')).toBe(true);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toBe('tap again');
  });

  it('maps a bare status to a code, and a network failure to "network"', async () => {
    const api1 = createApi({ fetch: fetchReturning(401, undefined) as unknown as typeof fetch, base: 'http://h' });
    const e1 = await api1.getState().catch((e: unknown) => e);
    expect(isApiError(e1, 'unauthorized')).toBe(true);
    const api2 = createApi({
      fetch: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
      base: 'http://h',
    });
    const e2 = await api2.getState().catch((e: unknown) => e);
    expect(isApiError(e2, 'network')).toBe(true);
    expect(errorText(e2)).toMatch(/Could not reach the Mac/);
  });

  it('rejects an unreadable success body', async () => {
    const f = vi.fn(async () => new Response('<html>', { status: 200 }));
    const api = createApi({ fetch: f as unknown as typeof fetch, base: 'http://h' });
    const e = await api.getState().catch((x: unknown) => x);
    expect(isApiError(e, 'bad_response')).toBe(true);
  });

  it('builds the event stream URL with ws or wss', () => {
    expect(createApi({ base: 'http://127.0.0.1:7420' }).eventsUrl(12)).toBe('ws://127.0.0.1:7420/v1/events?after=12');
    expect(createApi({ base: 'https://mac.example.test' }).eventsUrl()).toBe('wss://mac.example.test/v1/events');
    expect(createApi({ base: 'https://mac.example.test' }).eventsUrl(0)).toBe('wss://mac.example.test/v1/events');
  });
});

describe('device secret (SEC-2)', () => {
  const SECRET = 'Zx'.repeat(21) + 'Q';
  const device = { id: 'dev-9', name: 'Phone', scopes: ['read', 'control'], createdAt: '2026-01-15T10:00:00.000Z', lastSeenAt: '2026-01-15T10:00:00.000Z' };

  it('pairClaim keeps the secret in the credential store and hands the screen only the device', async () => {
    const credentials = createCredentialStore({ indexedDB: null });
    const f = fetchReturning(200, { device, deviceSecret: SECRET });
    const api = createApi({ fetch: f as unknown as typeof fetch, base: 'http://127.0.0.1:7420', credentials });
    const r = await api.pairClaim({ code: 'C'.repeat(22), name: 'Phone' });
    expect(r).toEqual({ device });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect((await credentials.get())?.secret).toBe(SECRET);
    expect((await credentials.get())?.deviceId).toBe('dev-9');
    // The claim itself carries no (old) secret.
    expect((f.mock.calls[0]![1]?.headers as Record<string, string>)[DEVICE_SECRET_HEADER]).toBeUndefined();
  });

  it('sends the secret on every write, and never on a read', async () => {
    const credentials = createCredentialStore({ indexedDB: null });
    await credentials.set({ secret: SECRET, deviceId: 'dev-9', savedAt: '2026-01-15T10:00:00.000Z' });
    const f = fetchReturning(200, { ok: true });
    const api = createApi({ fetch: f as unknown as typeof fetch, base: 'http://127.0.0.1:7420', credentials });
    await api.getState();
    await api.listDevices();
    await api.sendPrompt('s1', 'hi', 'k1');
    await api.decide('p'.repeat(30), { behavior: 'allow' });
    await api.focus('s1');
    await api.mute(5);
    await api.revokeDevice('dev-1');
    await api.pushSubscribe({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' } } });
    const sent = f.mock.calls.map(([url, init]) => ({
      what: `${init?.method} ${String(url).replace('http://127.0.0.1:7420', '')}`,
      secret: (init?.headers as Record<string, string>)[DEVICE_SECRET_HEADER],
    }));
    expect(sent.filter((c) => c.what.startsWith('GET')).every((c) => c.secret === undefined)).toBe(true);
    const writes = sent.filter((c) => !c.what.startsWith('GET'));
    expect(writes).toHaveLength(6);
    for (const w of writes) expect(w.secret, w.what).toBe(SECRET);
    // Never in a URL.
    expect(f.mock.calls.some(([url]) => String(url).includes(SECRET))).toBe(false);
  });

  it('sends the secret with a screenshot that selects a tab (it changes the Mac), not with a plain one', async () => {
    const credentials = createCredentialStore({ indexedDB: null });
    await credentials.set({ secret: SECRET, deviceId: 'dev-9', savedAt: '2026-01-15T10:00:00.000Z' });
    const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(new Uint8Array([1]), { status: 200 }));
    const api = createApi({ fetch: f as unknown as typeof fetch, base: 'http://127.0.0.1:7420', credentials });
    await api.screenshot('s1');
    await api.screenshot('s1', { select: true });
    const secrets = f.mock.calls.map(([, init]) => (init?.headers as Record<string, string> | undefined)?.[DEVICE_SECRET_HEADER]);
    expect(secrets).toEqual([undefined, SECRET]);
    expect(f.mock.calls.some(([url]) => String(url).includes(SECRET))).toBe(false);
  });

  it('with no secret stored, writes go out without the header (the daemon then asks to pair again)', async () => {
    const credentials = createCredentialStore({ indexedDB: null });
    const f = fetchReturning(401, { error: { code: 'unauthorized', message: 'pair it again' } });
    const api = createApi({ fetch: f as unknown as typeof fetch, base: 'http://127.0.0.1:7420', credentials });
    const e = await api.refreshUsage().catch((x: unknown) => x);
    expect(isApiError(e, 'unauthorized')).toBe(true);
    expect((f.mock.calls[0]![1]?.headers as Record<string, string>)[DEVICE_SECRET_HEADER]).toBeUndefined();
  });

  it('offers the secret to the event stream as a WebSocket subprotocol (browsers cannot set headers there)', async () => {
    const credentials = createCredentialStore({ indexedDB: null });
    const api = createApi({ base: 'http://127.0.0.1:7420', credentials });
    expect(await api.eventsProtocols?.()).toEqual([]);
    await credentials.set({ secret: SECRET, deviceId: 'dev-9', savedAt: '2026-01-15T10:00:00.000Z' });
    expect(await api.eventsProtocols?.()).toEqual([EVENTS_WS_PROTOCOL, `jantar.secret.${SECRET}`]);
    // ...and never in the URL.
    expect(api.eventsUrl(3)).not.toContain(SECRET);
  });
});
