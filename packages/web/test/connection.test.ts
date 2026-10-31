import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyState, type StateResponse } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import { createConnection, type WsLike } from '../src/lib/connection.js';
import { createAppStore } from '../src/store.js';
import { fakeApi, session, stateWith, T0 } from './helpers.js';

class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWs.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  send(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  fail() {
    this.readyState = 3;
    this.onclose?.({});
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  static last() {
    return FakeWs.all.at(-1)!;
  }
}

const resp = (seq: number, epoch = 'e1', state = stateWith({ seq })): StateResponse => ({ seq, epoch, state: { ...state, seq } });

async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('connection', () => {
  beforeEach(() => {
    FakeWs.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(over: Parameters<typeof fakeApi>[0] = {}, opts: { WebSocket?: null } = {}) {
    const store = createAppStore();
    const api = fakeApi({ getState: vi.fn(async () => resp(5, 'e1', stateWith({ sessions: [session('a')], seq: 5 }))), ...over });
    const conn = createConnection({
      store,
      api,
      WebSocket: opts.WebSocket === null ? null : FakeWs,
      pollMs: 1000,
      heartbeatTimeoutMs: 10_000,
      random: () => 0.5,
    });
    return { store, api, conn };
  }

  it('snapshots over REST, then streams events after that seq', async () => {
    const { store, api, conn } = setup();
    conn.start();
    await flush();
    expect(api.getState).toHaveBeenCalledTimes(1);
    expect(store.getState().state.sessions.a).toBeTruthy();
    expect(api.eventsUrl).toHaveBeenCalledWith(5);
    const ws = FakeWs.last();
    ws.open();
    expect(store.getState().conn.status).toBe('live');
    ws.send({ kind: 'hello', protocol: 1, daemonVersion: '0.1.0', webHash: 'h1', epoch: 'e1', seq: 5 });
    ws.send({ kind: 'event', event: { seq: 6, ts: T0, type: 'session.updated', sid: 'a', data: { patch: { status: 'idle' } } } });
    expect(store.getState().state.sessions.a?.status).toBe('idle');
    expect(store.getState().state.seq).toBe(6);
    conn.stop();
  });

  it('offers the device secret subprotocols when the api has them (SEC-2)', async () => {
    const protocols = ['jantar', `jantar.secret.${'S'.repeat(43)}`];
    const { conn, api } = setup({ eventsProtocols: vi.fn(async () => protocols) });
    conn.start();
    await flush();
    expect(api.eventsProtocols).toHaveBeenCalled();
    expect(FakeWs.last().protocols).toEqual(protocols);
    expect(FakeWs.last().url).not.toContain('secret');
    conn.stop();
  });

  it('opens a plain socket when no secret is stored (reads still work; the daemon refuses the stream)', async () => {
    const { conn } = setup({ eventsProtocols: vi.fn(async () => []) });
    conn.start();
    await flush();
    expect(FakeWs.last().protocols).toBeUndefined();
    conn.stop();
  });

  it('does not open a stale socket when the cycle moved on while the secret was being read', async () => {
    let release: (p: string[]) => void = () => {};
    const eventsProtocols = vi.fn(() => new Promise<string[]>((r) => (release = r)));
    const { conn } = setup({ eventsProtocols });
    conn.start();
    await flush();
    expect(FakeWs.all).toHaveLength(0);
    conn.stop();
    release(['jantar']);
    await flush();
    expect(FakeWs.all).toHaveLength(0);
  });

  it('resyncs from REST on a gap', async () => {
    const getState = vi.fn().mockResolvedValueOnce(resp(5)).mockResolvedValueOnce(resp(9));
    const { store, conn } = setup({ getState });
    conn.start();
    await flush();
    FakeWs.last().open();
    FakeWs.last().send({ kind: 'event', event: { seq: 8, ts: T0, type: 'session.removed', sid: 'x', data: {} } });
    await flush();
    expect(getState).toHaveBeenCalledTimes(2);
    expect(store.getState().state.seq).toBe(9);
    expect(store.getState().needsResync).toBe(false);
    expect(FakeWs.all.length).toBe(2);
    expect(FakeWs.all[0]!.closed).toBe(true);
    conn.stop();
  });

  it('resyncs when the daemon restarted (new epoch)', async () => {
    const getState = vi.fn().mockResolvedValueOnce(resp(5, 'e1')).mockResolvedValueOnce(resp(1, 'e2'));
    const { store, conn } = setup({ getState });
    conn.start();
    await flush();
    FakeWs.last().open();
    FakeWs.last().send({ kind: 'hello', protocol: 1, daemonVersion: '0.1.0', webHash: null, epoch: 'e2', seq: 1 });
    await flush();
    expect(getState).toHaveBeenCalledTimes(2);
    expect(store.getState().epoch).toBe('e2');
    expect(store.getState().state.seq).toBe(1);
    conn.stop();
  });

  it('reconnects with backoff and falls back to polling', async () => {
    const { store, api, conn } = setup();
    conn.start();
    await flush();
    FakeWs.last().fail(); // failure 1
    expect(store.getState().conn.status).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWs.all.length).toBe(2);
    FakeWs.last().fail(); // failure 2 -> polling
    expect(store.getState().conn.status).toBe('polling');
    const before = api.getState.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.getState.mock.calls.length).toBeGreaterThan(before);
    expect(store.getState().conn.status).toBe('polling');
    // the socket comes back: polling stops
    await vi.advanceTimersByTimeAsync(2000);
    FakeWs.last().open();
    expect(store.getState().conn.status).toBe('live');
    const calls = api.getState.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.getState.mock.calls.length).toBe(calls);
    conn.stop();
  });

  it('treats a silent socket as dead', async () => {
    const { conn } = setup();
    conn.start();
    await flush();
    const first = FakeWs.last();
    first.open();
    await vi.advanceTimersByTimeAsync(9000);
    first.send({ kind: 'heartbeat', seq: 5, ts: T0 });
    await vi.advanceTimersByTimeAsync(9000);
    expect(first.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(first.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(FakeWs.all.length).toBe(2);
    conn.stop();
  });

  it('stops at 401 and shows "unauthorized"', async () => {
    const { store, conn } = setup({ getState: vi.fn().mockRejectedValue(new ApiError('unauthorized', 'no cookie', 401)) });
    conn.start();
    await flush();
    expect(store.getState().conn.status).toBe('unauthorized');
    expect(FakeWs.all.length).toBe(0);
    conn.stop();
  });

  it('goes offline when the daemon is unreachable, then recovers', async () => {
    const getState = vi.fn().mockRejectedValueOnce(new ApiError('network', 'down', 0)).mockResolvedValue(resp(5));
    const { store, conn } = setup({ getState });
    conn.start();
    await flush();
    expect(store.getState().conn.status).toBe('offline');
    expect(store.getState().conn.failures).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    FakeWs.last().open();
    expect(store.getState().conn.status).toBe('live');
    conn.stop();
  });

  it('reconnects at once on kick (page shown again)', async () => {
    const { conn } = setup();
    conn.start();
    await flush();
    FakeWs.last().fail();
    conn.kick();
    await flush();
    expect(FakeWs.all.length).toBe(2);
    conn.stop();
  });

  it('polls only when WebSocket is unavailable', async () => {
    const { store, api, conn } = setup({}, { WebSocket: null });
    conn.start();
    await flush();
    expect(store.getState().conn.status).toBe('polling');
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.getState.mock.calls.length).toBeGreaterThanOrEqual(3);
    conn.stop();
    const n = api.getState.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.getState.mock.calls.length).toBe(n);
  });

  it('marks unauthorized when the stream says so', async () => {
    const { store, conn } = setup();
    conn.start();
    await flush();
    FakeWs.last().open();
    FakeWs.last().send({ kind: 'error', error: { code: 'unauthorized', message: 'revoked' } });
    expect(store.getState().conn.status).toBe('unauthorized');
    conn.stop();
  });

  it('passes live events to onEvent', async () => {
    const store = createAppStore();
    const seen: string[] = [];
    const api = fakeApi({ getState: vi.fn(async () => ({ seq: 0, epoch: 'e1', state: emptyState() })) });
    const conn = createConnection({ store, api, WebSocket: FakeWs, onEvent: (ev) => seen.push(ev.type) });
    conn.start();
    await flush();
    FakeWs.last().open();
    FakeWs.last().send({ kind: 'event', event: { seq: 1, ts: T0, type: 'session.done', sid: 'a', data: {} } });
    expect(seen).toEqual(['session.done']);
    conn.stop();
  });
});
