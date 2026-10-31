import { afterEach, describe, expect, it } from 'vitest';
import { WsServerMessageSchema, type WsServerMessage } from '@jantar/protocol';
import { MemoryStore } from '../../src/core/store.js';
import { createTestContext } from '../../src/core/testing.js';
import { buildApp } from '../../src/api/app.js';
import { ApiServices } from '../../src/api/services.js';
import { depsOf, h, makeApi, makeFakes, makeSession, pairCookie, type TestApi } from './fakes.js';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

interface Client {
  messages: WsServerMessage[];
  next(n?: number): Promise<WsServerMessage[]>;
  send(data: string): void;
  close(): void;
}

async function connect(target: { tcp: TestApi['tcp'] }, headers: Record<string, string>, query = ''): Promise<Client> {
  const messages: WsServerMessage[] = [];
  const waiters: (() => void)[] = [];
  const ws = await target.tcp.injectWS(`/v1/events${query}`, { headers }, {
    onInit: (sock) => {
      sock.on('message', (data: Buffer) => {
        messages.push(WsServerMessageSchema.parse(JSON.parse(String(data))));
        for (const w of waiters.splice(0)) w();
      });
    },
  });
  let read = 0;
  return {
    messages,
    async next(n = 1) {
      const deadline = Date.now() + 2000;
      while (messages.length < read + n) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} message(s); have ${JSON.stringify(messages.slice(read))}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
      const out = messages.slice(read, read + n);
      read += n;
      return out;
    },
    send: (d) => ws.send(d),
    close: () => ws.terminate(),
  };
}

function emitUpdates(a: TestApi, n: number): void {
  for (let i = 0; i < n; i++) {
    a.ctx.store.emit({ type: 'session.updated', sid: 'sess-aaaa-1111', data: { patch: { mode: `m${i}` } } });
  }
}

describe('WS /v1/events', () => {
  it('without ?after: hello, then a snapshot, then live events in seq order', async () => {
    api = await makeApi();
    const { cookie } = await pairCookie(api);
    const c = await connect(api, h(cookie));
    const [hello, snap] = await c.next(2);
    expect(hello).toMatchObject({ kind: 'hello', protocol: 3, daemonVersion: '0.0.0-test', epoch: api.ctx.store.epoch, seq: api.ctx.store.seq, webHash: null });
    expect(snap).toMatchObject({ kind: 'snapshot', seq: api.ctx.store.seq });
    if (snap?.kind !== 'snapshot') throw new Error('expected a snapshot');
    expect(Object.keys(snap.state.sessions)).toEqual(['sess-aaaa-1111']);

    const before = api.ctx.store.seq;
    emitUpdates(api, 3);
    const live = await c.next(3);
    expect(live.map((m) => (m.kind === 'event' ? m.event.seq : -1))).toEqual([before + 1, before + 2, before + 3]);
    c.close();
  });

  it('with ?after inside the ring: only the missed events (a delta), no snapshot', async () => {
    api = await makeApi();
    const { cookie } = await pairCookie(api);
    const after = api.ctx.store.seq;
    emitUpdates(api, 4);
    const c = await connect(api, h(cookie), `?after=${after}`);
    const msgs = await c.next(5);
    expect(msgs[0]?.kind).toBe('hello');
    expect(msgs.slice(1).map((m) => m.kind)).toEqual(['event', 'event', 'event', 'event']);
    expect(msgs.slice(1).map((m) => (m.kind === 'event' ? m.event.seq : 0))).toEqual([after + 1, after + 2, after + 3, after + 4]);
    expect(c.messages.some((m) => m.kind === 'snapshot')).toBe(false);

    // Already up to date: nothing but hello.
    const d = await connect(api, h(cookie), `?after=${api.ctx.store.seq}`);
    await d.next(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(d.messages.map((m) => m.kind)).toEqual(['hello']);
    c.close();
    d.close();
  });

  it('with ?after older than the ring, or newer than seq (daemon restarted): a snapshot', async () => {
    const ctx = createTestContext();
    // A small ring so it overflows quickly.
    (ctx as { store: MemoryStore }).store = new MemoryStore({ clock: ctx.clock, ringSize: 5 });
    const fakes = makeFakes(ctx);
    const services = new ApiServices(ctx, depsOf(fakes), { port: 7420, webDist: null });
    const tcp = await buildApp(services, 'tcp');
    const ctl = await buildApp(services, 'ctl');
    api = { ctx, fakes, services, tcp, ctl, close: async () => { await tcp.close(); await ctl.close(); } };
    const s = makeSession();
    ctx.store.emit({ type: 'session.added', sid: s.sid, data: { session: s } });
    const { cookie } = await pairCookie(api);
    emitUpdates(api, 10);

    const old = await connect(api, h(cookie), '?after=1');
    const [, snap] = await old.next(2);
    expect(snap?.kind).toBe('snapshot');

    const future = await connect(api, h(cookie), `?after=${ctx.store.seq + 100}`);
    const [, snap2] = await future.next(2);
    expect(snap2).toMatchObject({ kind: 'snapshot', seq: ctx.store.seq });
    old.close();
    future.close();
  });

  it('rejects a bad ?after before upgrading', async () => {
    api = await makeApi();
    const { cookie } = await pairCookie(api);
    await expect(api.tcp.injectWS('/v1/events?after=-3', { headers: h(cookie) })).rejects.toThrow(/400/);
  });

  it('sends a heartbeat every 20 s and answers a client ping', async () => {
    api = await makeApi();
    const { cookie } = await pairCookie(api);
    const c = await connect(api, h(cookie));
    await c.next(2);
    api.ctx.clock.advance(20_000);
    const [hb] = await c.next(1);
    expect(hb).toEqual({ kind: 'heartbeat', seq: api.ctx.store.seq, ts: '2026-01-15T10:00:20.000Z' });
    c.send(JSON.stringify({ kind: 'ping' }));
    const [pong] = await c.next(1);
    expect(pong?.kind).toBe('heartbeat');
    c.send('not json');
    c.send(JSON.stringify({ kind: 'unknown' }));
    expect(api.services.sockets.count()).toBe(1);
    c.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(api.services.sockets.count()).toBe(0);
  });

  it('the CLI can tail events on the control socket without a cookie', async () => {
    api = await makeApi();
    let resolveFirst: (s: string) => void = () => {};
    const first = new Promise<string>((resolve) => (resolveFirst = resolve));
    const ws = await api.ctl.injectWS('/v1/events', {}, { onInit: (sock) => sock.once('message', (d: Buffer) => resolveFirst(String(d))) });
    expect(JSON.parse(await first).kind).toBe('hello');
    ws.terminate();
  });
});
