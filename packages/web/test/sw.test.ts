import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderServiceWorker, SW_MARKER } from '../build/pwa-plugin.js';

const ORIGIN = 'https://mac.example.test';
const TEMPLATE = readFileSync(join(__dirname, '..', 'sw', 'sw.js'), 'utf8');

class FakeRequest {
  constructor(
    readonly url: string,
    readonly init: RequestInit = {},
  ) {}
}

type Handler = (ev: Record<string, unknown>) => void;

function loadSw(build: { version: string; precache: string[] } | null, fetchImpl?: (req: unknown) => Promise<Response>) {
  const handlers: Record<string, Handler> = {};
  /** Every MessageChannel the worker opened, its port1's close() spied on. */
  const channels: MessageChannel[] = [];
  class SpyChannel extends MessageChannel {
    constructor() {
      super();
      vi.spyOn(this.port1, 'close');
      channels.push(this);
    }
  }
  const store = new Map<string, Map<string, Response>>();
  const key = (r: unknown) => (typeof r === 'string' ? r : (r as { url: string }).url).replace(ORIGIN, '');
  const caches = {
    open: vi.fn(async (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
      const m = store.get(name)!;
      return {
        add: async (req: unknown) => {
          const res = await self.fetch(req);
          if (!res.ok) throw new Error('bad');
          m.set(key(req), res);
        },
        put: async (req: unknown, res: Response) => {
          m.set(key(req), res);
        },
        match: async (req: unknown) => m.get(key(req))?.clone(),
      };
    }),
    keys: vi.fn(async () => [...store.keys()]),
    delete: vi.fn(async (n: string) => store.delete(n)),
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (t: string, fn: Handler) => {
      handlers[t] = fn;
    },
    skipWaiting: vi.fn(async () => undefined),
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => [] as unknown[]),
      openWindow: vi.fn(async () => null),
    },
    registration: {
      showNotification: vi.fn(async () => undefined),
      pushManager: { subscribe: vi.fn() },
    },
    caches,
    fetch: vi.fn(
      fetchImpl ??
        (async () => new Response('<html>shell</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })),
    ),
  };
  const code = build ? renderServiceWorker(TEMPLATE, build) : TEMPLATE;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('self', 'Request', 'Response', 'MessageChannel', code)(self, FakeRequest, Response, SpyChannel);

  async function fire(type: string, ev: Record<string, unknown> = {}) {
    const waits: Promise<unknown>[] = [];
    let responded: Promise<Response> | undefined;
    handlers[type]!({ ...ev, waitUntil: (p: Promise<unknown>) => waits.push(p), respondWith: (p: Promise<Response>) => (responded = p) });
    await Promise.all(waits);
    return responded ? await responded : undefined;
  }
  return { self, handlers, store, fire, channels };
}

const req = (path: string, mode = 'cors', method = 'GET') => ({ url: `${ORIGIN}${path}`, method, mode });

describe('service worker', () => {
  it('needs the build marker, and the build fills it in', () => {
    expect(TEMPLATE).toContain(SW_MARKER);
    const out = renderServiceWorker(TEMPLATE, { version: 'v1', precache: ['/a.js'] });
    expect(out).toContain('self.__CCW_BUILD__ = {"version":"v1","precache":["/a.js"]};');
    expect(out.split('\n').slice(0, 5).join('\n')).toContain('Portions adapted from Shed (c) Sukhad Anand, MIT');
    expect(() => renderServiceWorker('no marker', { version: 'v', precache: [] })).toThrow();
  });

  it('precaches the shell on install and drops old caches on activate, ccw-v2\'s too', async () => {
    const { self, fire, store } = loadSw({ version: 'v2', precache: ['/', '/index.html', '/assets/app.js'] });
    store.set('jantar-shell-v1', new Map());
    store.set('ccw-v2-shell-v9', new Map());
    store.set('unrelated', new Map());
    await fire('install');
    expect([...store.get('jantar-shell-v2')!.keys()].sort()).toEqual(['/', '/assets/app.js', '/index.html']);
    expect(self.skipWaiting).toHaveBeenCalled();
    await fire('activate');
    expect([...store.keys()].sort()).toEqual(['jantar-shell-v2', 'unrelated']);
    expect(self.clients.claim).toHaveBeenCalled();
  });

  it('never handles /v1, /healthz, writes or other origins', async () => {
    const { fire } = loadSw({ version: 'v', precache: [] });
    expect(await fire('fetch', { request: req('/v1/state') })).toBeUndefined();
    expect(await fire('fetch', { request: req('/v1/events', 'websocket') })).toBeUndefined();
    expect(await fire('fetch', { request: req('/healthz') })).toBeUndefined();
    expect(await fire('fetch', { request: req('/v1/pending/x/decision', 'cors', 'POST') })).toBeUndefined();
    expect(await fire('fetch', { request: { url: 'https://cdn.example.test/x.js', method: 'GET', mode: 'cors' } })).toBeUndefined();
  });

  it('W7: never caches file contents or terminal screenshots, whatever the precache says', async () => {
    const paths = [
      '/v1/files/raw?root=r.work&path=docs%2Fspec.pdf',
      '/v1/files/text?root=r.work&path=src%2Fapp.ts',
      '/v1/files/list?root=r.work&path=',
      '/v1/files/changes',
      '/v1/sessions/a1b2/screenshot?max=1600&format=png',
      '/v1/sessions/a1b2/changes/c1',
    ];
    const { fire, store, self } = loadSw({ version: 'v', precache: paths.map((p) => p.split('?')[0]!) });
    for (const p of paths) {
      expect(await fire('fetch', { request: req(p) }), p).toBeUndefined();
      expect(await fire('fetch', { request: req(p, 'no-cors') }), p).toBeUndefined();
    }
    expect(self.fetch).not.toHaveBeenCalled();
    expect([...store.values()].every((c) => c.size === 0)).toBe(true);
  });

  it('LP6 (v0.4): never caches Life or the shelf, whatever the precache says', async () => {
    const paths = ['/v1/life/today?day=2026-10-30', '/v1/life/status', '/v1/medicines?day=2026-10-30', '/v1/food', '/v1/money?month=2026-10', '/v1/intel?q=x', '/v1/intel/items/captures%3A1'];
    const { fire, store, self } = loadSw({ version: 'v', precache: paths.map((p) => p.split('?')[0]!) });
    for (const p of paths) expect(await fire('fetch', { request: req(p) }), p).toBeUndefined();
    expect(self.fetch).not.toHaveBeenCalled();
    expect([...store.values()].every((c) => c.size === 0)).toBe(true);
  });

  it('LN4 (v0.4): a medicine stays on the lock screen until tapped, opening its dose sheet; a reminder does not stay', async () => {
    const { fire, self } = loadSw({ version: 'v', precache: [] });
    await fire('push', { data: { json: () => ({ title: 'Medicine due', body: 'Tap to log · 08:00', tag: 'med:08:00', kind: 'med', url: '/today?dose=01JFZ8X8Y3T0V5G9WQK2M4N6PR@0800' }) } });
    expect((self.registration.showNotification.mock.calls[0] as unknown[])[1]).toMatchObject({ requireInteraction: true, data: { url: '/today?dose=01JFZ8X8Y3T0V5G9WQK2M4N6PR@0800', kind: 'med' } });
    await fire('push', { data: { json: () => ({ title: 'Todo due', body: 'Tap to open · 11:00', tag: 'life:todo:x', kind: 'life', url: '/todos?id=01JFZ8X8Y3T0V5G9WQK2M4N6PR' }) } });
    expect((self.registration.showNotification.mock.calls[1] as unknown[])[1]).toMatchObject({ requireInteraction: false, data: { url: '/todos?id=01JFZ8X8Y3T0V5G9WQK2M4N6PR', kind: 'life' } });
  });

  it('serves the cached shell for app routes when offline or unknown to the server', async () => {
    let online = true;
    const { fire, self } = loadSw({ version: 'v', precache: [] }, async (r) => {
      if (!online) throw new TypeError('offline');
      const url = typeof r === 'string' ? r : (r as { url: string }).url;
      if (url.endsWith('/s/abc')) return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
      return new Response('<html>shell</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const first = await fire('fetch', { request: req('/', 'navigate') });
    expect(await first!.text()).toBe('<html>shell</html>');
    const unknown = await fire('fetch', { request: req('/s/abc', 'navigate') });
    expect(unknown!.status).toBe(200);
    expect(await unknown!.text()).toBe('<html>shell</html>');
    online = false;
    const offline = await fire('fetch', { request: req('/accounts', 'navigate') });
    expect(await offline!.text()).toBe('<html>shell</html>');
    expect(self.fetch).toHaveBeenCalled();
  });

  it('says offline when nothing is cached', async () => {
    const { fire } = loadSw({ version: 'v', precache: [] }, async () => {
      throw new TypeError('offline');
    });
    const res = await fire('fetch', { request: req('/', 'navigate') });
    expect(res!.status).toBe(503);
  });

  it('serves hashed assets from the cache first', async () => {
    const { fire, store, self } = loadSw({ version: 'v', precache: [] });
    store.set('jantar-shell-v', new Map([['/assets/app.js', new Response('cached js')]]));
    const res = await fire('fetch', { request: req('/assets/app.js') });
    expect(await res!.text()).toBe('cached js');
    expect(self.fetch).not.toHaveBeenCalled();
  });

  it('shows a push with a deep link to the session and card', async () => {
    const { fire, self } = loadSw({ version: 'v', precache: [] });
    await fire('push', {
      data: { json: () => ({ title: 'Question · web-app · fix login', body: 'Which database?', tag: 's:abc', kind: 'question', sid: 'abc', pendingId: 'p1' }) },
    });
    expect(self.registration.showNotification).toHaveBeenCalledWith('Question · web-app · fix login', {
      body: 'Which database?',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: 's:abc',
      renotify: true,
      requireInteraction: true,
      timestamp: expect.any(Number),
      data: { url: '/s/abc?p=p1', kind: 'question' },
    });
  });

  it('keeps push targets on this origin, and survives a bad payload', async () => {
    const { fire, self } = loadSw({ version: 'v', precache: [] });
    await fire('push', { data: { json: () => ({ title: 'x', url: 'https://evil.example/phish' }) } });
    expect((self.registration.showNotification.mock.calls[0] as unknown[])[1]).toMatchObject({ data: { url: '/' }, requireInteraction: false });
    await fire('push', { data: { json: () => ({ title: 'y', url: `${ORIGIN}/alerts` }) } });
    expect((self.registration.showNotification.mock.calls[1] as unknown[])[1]).toMatchObject({ data: { url: '/alerts' } });
    await fire('push', {
      data: {
        json: () => {
          throw new SyntaxError('bad');
        },
        text: () => 'plain words',
      },
    });
    expect(self.registration.showNotification.mock.calls[2]).toEqual(['Jantar', expect.objectContaining({ body: 'plain words' })]);
  });

  it('focuses an open window and routes it when a notification is tapped', async () => {
    const { fire, self } = loadSw({ version: 'v', precache: [] });
    const client = { url: `${ORIGIN}/accounts`, focused: false, focus: vi.fn(async () => undefined), postMessage: vi.fn() };
    self.clients.matchAll.mockResolvedValue([{ url: 'https://other.example/', focused: true }, client]);
    const close = vi.fn();
    await fire('notificationclick', { notification: { close, data: { url: '/s/abc?p=p1' } } });
    expect(close).toHaveBeenCalled();
    expect(client.focus).toHaveBeenCalled();
    expect(client.postMessage).toHaveBeenCalledWith({ type: 'jantar:navigate', url: '/s/abc?p=p1' });
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('opens a window when none is open', async () => {
    const { fire, self } = loadSw({ version: 'v', precache: [] });
    await fire('notificationclick', { notification: { close: vi.fn(), data: { url: '/s/abc' } } });
    expect(self.clients.openWindow).toHaveBeenCalledWith('/s/abc');
  });

  it('re-registers a rotated push subscription', async () => {
    const { fire, self } = loadSw({ version: 'v', precache: [] }, async () => new Response('{"ok":true}', { status: 200 }));
    const fresh = { endpoint: 'https://push.example.test/new', toJSON: () => ({ endpoint: 'https://push.example.test/new', keys: { p256dh: 'a', auth: 'b' } }) };
    await fire('pushsubscriptionchange', { oldSubscription: { endpoint: 'https://push.example.test/old' }, newSubscription: fresh });
    const calls = self.fetch.mock.calls as unknown[][];
    expect(calls[0]![0]).toBe('/v1/push/subscribe');
    expect(JSON.parse((calls[0]![1] as RequestInit).body as string)).toEqual({ subscription: fresh.toJSON() });
    expect((calls[1]![1] as RequestInit).method).toBe('DELETE');
  });

  it('v0.5.3: takes the push\'s own time from its ISO `ts`', async () => {
    const { fire, self } = loadSw({ version: 'v', precache: [] });
    await fire('push', { data: { json: () => ({ title: 'x', ts: '2026-11-01T06:30:00.000Z' }) } });
    await fire('push', { data: { json: () => ({ title: 'y', ts: 'not a time' }) } });
    const calls = self.registration.showNotification.mock.calls as unknown[][];
    expect((calls[0]![1] as { timestamp: number }).timestamp).toBe(Date.parse('2026-11-01T06:30:00.000Z'));
    expect(Math.abs((calls[1]![1] as { timestamp: number }).timestamp - Date.now())).toBeLessThan(5_000);
  });
});

/** A window the worker can see: visible on this origin unless told otherwise; `answer` is what the page posts back on the port. */
function windowClient(over: { url?: string; visibilityState?: string; answer?: unknown } = {}) {
  return {
    url: over.url ?? `${ORIGIN}/s/abc`,
    visibilityState: over.visibilityState ?? 'visible',
    focused: true,
    postMessage: vi.fn((_msg: unknown, transfer?: MessagePort[]) => {
      if ('answer' in over) transfer?.[0]?.postMessage(over.answer);
    }),
  };
}

describe('v0.5.3: the chime from a push (S4, S5)', () => {
  const push = (group?: string, kind = 'permission') => ({
    data: { json: () => ({ title: 'web-app · Permission', body: 'Bash: pnpm test', tag: 's:abc', kind, sid: 'abc', ...(group ? { group } : {}) }) },
  });
  /** The one notification shown: always exactly one. */
  async function shown(sw: ReturnType<typeof loadSw>, ev: Record<string, unknown>) {
    sw.self.registration.showNotification.mockClear();
    await sw.fire('push', ev);
    expect(sw.self.registration.showNotification).toHaveBeenCalledTimes(1);
    return (sw.self.registration.showNotification.mock.calls[0] as unknown[])[1] as { silent?: boolean };
  }

  it('silent only when the visible app answers { played: true }; the message is the group name only, the port closed', async () => {
    const sw = loadSw({ version: 'v', precache: [] });
    const client = windowClient({ answer: { played: true } });
    sw.self.clients.matchAll.mockResolvedValue([client]);
    expect((await shown(sw, push('needs'))).silent).toBe(true);
    expect(sw.self.clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
    expect(client.postMessage).toHaveBeenCalledTimes(1);
    const [msg, transfer] = client.postMessage.mock.calls[0] as [unknown, MessagePort[]];
    expect(msg).toEqual({ type: 'jantar:chime', group: 'needs' });
    expect(transfer).toEqual([sw.channels[0]!.port2]);
    expect(sw.channels[0]!.port1.close).toHaveBeenCalled();
    // done and problem the same way.
    for (const g of ['done', 'problem']) expect((await shown(sw, push(g))).silent, g).toBe(true);
  });

  it('keeps the sound for { played: false } or any other answer', async () => {
    for (const answer of [{ played: false }, { played: 'yes' }, { played: 1 }, 'played', null, {}]) {
      const sw = loadSw({ version: 'v', precache: [] });
      sw.self.clients.matchAll.mockResolvedValue([windowClient({ answer })]);
      expect((await shown(sw, push('done'))).silent, JSON.stringify(answer)).toBeUndefined();
      expect(sw.channels[0]!.port1.close).toHaveBeenCalled();
    }
  });

  it('keeps the sound when the app never answers, after waiting 300 ms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const sw = loadSw({ version: 'v', precache: [] });
      const client = windowClient();
      sw.self.clients.matchAll.mockResolvedValue([client]);
      let settled = false;
      const options = shown(sw, push('needs')).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(299);
      expect(settled).toBe(false);
      expect(sw.self.registration.showNotification).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect((await options).silent).toBeUndefined();
      expect(client.postMessage).toHaveBeenCalledTimes(1);
      expect(sw.channels[0]!.port1.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks no window that is hidden or on another origin, and shows the push as usual', async () => {
    const sw = loadSw({ version: 'v', precache: [] });
    const hidden = windowClient({ visibilityState: 'hidden', answer: { played: true } });
    const other = windowClient({ url: 'https://other.example/s/abc', answer: { played: true } });
    const bad = windowClient({ url: 'not a url', answer: { played: true } });
    sw.self.clients.matchAll.mockResolvedValue([hidden, other, bad]);
    expect((await shown(sw, push('needs'))).silent).toBeUndefined();
    for (const c of [hidden, other, bad]) expect(c.postMessage).not.toHaveBeenCalled();
    expect(sw.channels).toEqual([]);
    // No window at all.
    sw.self.clients.matchAll.mockResolvedValue([]);
    expect((await shown(sw, push('needs'))).silent).toBeUndefined();
    // The first visible one on this origin is the one asked.
    const first = windowClient({ answer: { played: true } });
    const second = windowClient({ answer: { played: false } });
    sw.self.clients.matchAll.mockResolvedValue([hidden, first, second]);
    expect((await shown(sw, push('needs'))).silent).toBe(true);
    expect(second.postMessage).not.toHaveBeenCalled();
  });

  it('never silences medicines and Life (care): the bell is posted without a port, the push keeps its sound', async () => {
    const sw = loadSw({ version: 'v', precache: [] });
    const client = windowClient({ answer: { played: true } });
    sw.self.clients.matchAll.mockResolvedValue([client]);
    // It does not wait for an answer: shown with no time passing, no timer left.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const options = shown(sw, push('care', 'med')).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect((await options).silent).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(client.postMessage.mock.calls).toEqual([[{ type: 'jantar:chime', group: 'care' }]]);
    expect(sw.channels).toEqual([]);
  });

  it('never silences Answer soon (urgent): the alarm is posted without a port, the push keeps its sound or buzz', async () => {
    // iOS Web Audio follows the silent switch while the context still runs: a "played" alarm may be unheard.
    const sw = loadSw({ version: 'v', precache: [] });
    const client = windowClient({ answer: { played: true } });
    sw.self.clients.matchAll.mockResolvedValue([client]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const options = shown(sw, push('urgent')).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect((await options).silent).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(client.postMessage.mock.calls).toEqual([[{ type: 'jantar:chime', group: 'urgent' }]]);
    expect(sw.channels).toEqual([]);
  });

  it('no group, an unknown one or a plain-text push: no chime, shown as usual', async () => {
    const sw = loadSw({ version: 'v', precache: [] });
    const client = windowClient({ answer: { played: true } });
    sw.self.clients.matchAll.mockResolvedValue([client]);
    expect((await shown(sw, push())).silent).toBeUndefined();
    expect((await shown(sw, push('loud'))).silent).toBeUndefined();
    expect((await shown(sw, { data: { json: () => ({ title: 'x', group: ['needs'] }) } })).silent).toBeUndefined();
    const plain = { data: { json: () => { throw new SyntaxError('bad'); }, text: () => 'plain words' } };
    expect((await shown(sw, plain)).silent).toBeUndefined();
    expect(client.postMessage).not.toHaveBeenCalled();
    expect(sw.self.clients.matchAll).not.toHaveBeenCalled();
  });

  it('shows the push once with its sound when asking the window fails', async () => {
    const sw = loadSw({ version: 'v', precache: [] });
    sw.self.clients.matchAll.mockRejectedValue(new Error('gone'));
    expect((await shown(sw, push('needs'))).silent).toBeUndefined();
    const throwing = { ...windowClient(), postMessage: vi.fn(() => { throw new Error('detached'); }) };
    sw.self.clients.matchAll.mockResolvedValue([throwing]);
    expect((await shown(sw, push('needs'))).silent).toBeUndefined();
    expect(sw.channels[0]!.port1.close).toHaveBeenCalled();
    expect((await shown(sw, push('care'))).silent).toBeUndefined();
  });
});
