/**
 * Keeps the store in sync with the daemon.
 *
 * 1. GET /v1/state (snapshot, seq, epoch).
 * 2. WS /v1/events?after=<seq>: hello, replay, then live events, applied with
 *    the shared reducer. A heartbeat arrives every 20 s; silence for longer
 *    than `heartbeatTimeoutMs` counts as a dead socket.
 * 3. A gap or a new daemon epoch -> start again from step 1.
 * 4. The socket keeps failing -> poll GET /v1/state every `pollMs` while
 *    retrying the socket with backoff (1 s, 2 s, 4 s ... 30 s, jittered).
 * 5. 401 -> "unauthorized" (the app shows how to pair); retried slowly.
 *
 * The socket offers the device secret as a subprotocol (`api.eventsProtocols`,
 * SEC-2): browsers cannot set headers on a WebSocket. Without a stored secret
 * the daemon refuses the stream, and the app keeps itself current by polling
 * (reads need only the cookie).
 *
 * Coming back to the page or the network reconnects at once.
 */
import type { DaemonEvent, WsServerMessage } from '@jantar/protocol';
import { isApiError, type Api } from './api.js';
import type { AppStore, ConnInfo } from '../store.js';

export interface WsLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}
export type WsCtor = new (url: string, protocols?: string | string[]) => WsLike;

export interface ConnectionOptions {
  store: AppStore;
  api: Api;
  /** WebSocket constructor; null means "not available": poll only. */
  WebSocket?: WsCtor | null;
  pollMs?: number;
  heartbeatTimeoutMs?: number;
  maxBackoffMs?: number;
  /** Socket failures in a row before falling back to polling. */
  failuresBeforePolling?: number;
  unauthorizedRetryMs?: number;
  random?: () => number;
  now?: () => number;
  /** Called for every live event after the store applied it. */
  onEvent?: (ev: DaemonEvent) => void;
}

export interface Connection {
  start(): void;
  stop(): void;
  /** Reconnect now if the socket is not open (page shown again, network back). */
  kick(): void;
}

const OPEN = 1;

export function createConnection(opts: ConnectionOptions): Connection {
  const { store, api } = opts;
  const WS: WsCtor | null =
    opts.WebSocket === undefined ? ((globalThis.WebSocket as unknown as WsCtor | undefined) ?? null) : opts.WebSocket;
  const pollMs = opts.pollMs ?? 5000;
  const heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 50_000;
  const maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  const failuresBeforePolling = opts.failuresBeforePolling ?? 2;
  const unauthorizedRetryMs = opts.unauthorizedRetryMs ?? 30_000;
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;

  let running = false;
  let ws: WsLike | null = null;
  let cycleId = 0;
  let wsFailures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;

  const setConn = (p: Partial<ConnInfo>) => store.getState().setConn(p);

  function backoff(n: number): number {
    const base = Math.min(maxBackoffMs, 1000 * 2 ** Math.max(0, n - 1));
    return Math.round(base * (0.8 + 0.4 * random()));
  }

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }
  function clearWatchdog() {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function schedule(ms: number) {
    clearRetry();
    if (!running) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void cycle();
    }, ms);
  }

  /** Detach and close the socket without counting it as a failure. */
  function dropSocket() {
    clearWatchdog();
    const s = ws;
    ws = null;
    if (!s) return;
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
    try {
      s.close(1000, 'client');
    } catch {
      // already closed
    }
  }

  function unauthorized() {
    dropSocket();
    stopPolling();
    setConn({ status: 'unauthorized' });
    schedule(unauthorizedRetryMs);
  }

  function startPolling() {
    if (pollTimer || !running) return;
    setConn({ status: 'polling' });
    pollTimer = setInterval(() => {
      void (async () => {
        try {
          const res = await api.getState();
          if (!running) return;
          store.getState().applyStateResponse(res);
          const st = store.getState().conn.status;
          setConn({ lastOkAt: now(), ...(st !== 'live' ? { status: 'polling' as const } : {}) });
        } catch (e) {
          if (!running) return;
          if (isApiError(e, 'unauthorized')) unauthorized();
          else if (store.getState().conn.status !== 'live') setConn({ status: 'offline' });
        }
      })();
    }, pollMs);
  }

  async function cycle(): Promise<void> {
    if (!running) return;
    const id = ++cycleId;
    clearRetry();
    dropSocket();
    try {
      const res = await api.getState();
      if (!running || id !== cycleId) return;
      store.getState().applyStateResponse(res);
      const conn = store.getState().conn;
      setConn({
        lastOkAt: now(),
        failures: 0,
        status: conn.status === 'live' || pollTimer ? conn.status : 'connecting',
      });
    } catch (e) {
      if (!running || id !== cycleId) return;
      if (isApiError(e, 'unauthorized')) {
        unauthorized();
        return;
      }
      const failures = store.getState().conn.failures + 1;
      stopPolling();
      setConn({ status: 'offline', failures });
      schedule(backoff(failures));
      return;
    }
    if (!WS) {
      startPolling();
      return;
    }
    openSocket(id);
  }

  function armWatchdog() {
    clearWatchdog();
    watchdog = setTimeout(() => {
      watchdog = null;
      // Silent socket: treat as dead.
      dropSocket();
      wsFailures += 1;
      afterSocketLoss();
    }, heartbeatTimeoutMs);
  }

  function afterSocketLoss() {
    if (!running) return;
    if (wsFailures >= failuresBeforePolling) startPolling();
    else if (!pollTimer) setConn({ status: 'connecting' });
    schedule(backoff(wsFailures));
  }

  function openSocket(id: number) {
    if (!WS) return;
    if (!api.eventsProtocols) {
      connectSocket(id, []);
      return;
    }
    void api
      .eventsProtocols()
      .catch(() => [] as string[])
      .then((protocols) => {
        // The cycle may have moved on (or stopped) while the secret was read.
        if (!running || id !== cycleId) return;
        connectSocket(id, protocols);
      });
  }

  function connectSocket(id: number, protocols: string[]) {
    if (!WS) return;
    let s: WsLike;
    try {
      const url = api.eventsUrl(store.getState().state.seq);
      s = protocols.length > 0 ? new WS(url, protocols) : new WS(url);
    } catch {
      wsFailures += 1;
      afterSocketLoss();
      return;
    }
    ws = s;
    let opened = false;
    s.onopen = () => {
      if (ws !== s || id !== cycleId) return;
      opened = true;
      wsFailures = 0;
      stopPolling();
      setConn({ status: 'live', lastOkAt: now(), failures: 0 });
      armWatchdog();
    };
    s.onmessage = (ev) => {
      if (ws !== s) return;
      armWatchdog();
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as WsServerMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.kind === 'error') {
        if (msg.error?.code === 'unauthorized') unauthorized();
        return;
      }
      store.getState().applyMessage(msg);
      if (store.getState().needsResync) {
        void cycle();
        return;
      }
      if (msg.kind === 'event' && opts.onEvent) {
        try {
          opts.onEvent(msg.event as DaemonEvent);
        } catch {
          // a listener bug must not break the stream
        }
      }
    };
    s.onerror = () => {
      // onclose follows; nothing to do here
    };
    s.onclose = () => {
      if (ws !== s) return;
      ws = null;
      clearWatchdog();
      wsFailures = opened ? 1 : wsFailures + 1;
      afterSocketLoss();
    };
  }

  function onVisible() {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') kick();
  }
  function onOnline() {
    kick();
  }

  function kick() {
    if (!running) return;
    if (ws && ws.readyState === OPEN) return;
    wsFailures = 0;
    setConn({ failures: 0 });
    void cycle();
  }

  return {
    start() {
      if (running) return;
      running = true;
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
      if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
      void cycle();
    },
    stop() {
      running = false;
      cycleId += 1;
      clearRetry();
      stopPolling();
      dropSocket();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
    },
    kick,
  };
}
