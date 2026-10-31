/**
 * WS /v1/events?after=<seq>
 *
 * 1. `hello {protocol, daemonVersion, webHash, epoch, seq}`
 * 2. A `snapshot {seq, state}` when `after` is missing, older than the
 *    replay ring, or newer than the daemon's seq (it restarted); otherwise
 *    each missed `event` in seq order.
 * 3. Live `event`s, and a `heartbeat {seq, ts}` every 20 s (also sent in
 *    reply to a client `{"kind":"ping"}`).
 *
 * Replay and subscription happen in one synchronous step, so no event can
 * slip between them. A client that falls too far behind (send buffer over
 * MAX_BUFFERED) is closed with 1013 and resyncs on reconnect. A revoked
 * device's sockets are closed with 4401.
 */
import {
  HEARTBEAT_MS,
  WsClientMessageSchema,
  type DaemonEvent,
  type WsServerMessage,
} from '@jantar/protocol';
import type { TimerId, Unsubscribe } from '../contracts.js';
import type { RequestAuth } from './request.js';
import { WS_OPEN, type ApiServices, type WsLike } from './services.js';

export const MAX_BUFFERED = 8 * 1024 * 1024;
export const CLOSE_REVOKED = 4401;
export const CLOSE_SLOW = 1013;
export const CLOSE_SHUTDOWN = 1001;

export function openEventStream(socket: WsLike, s: ApiServices, auth: RequestAuth, after: number | undefined): void {
  const { ctx } = s;
  const deviceId = auth.device?.id ?? null;
  let unsub: Unsubscribe | null = null;
  let timer: TimerId | undefined;
  let alive = true;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsub?.();
    unsub = null;
    ctx.clock.clearInterval(timer);
    s.sockets.remove(socket, deviceId);
  };

  const send = (msg: WsServerMessage): void => {
    if (closed || socket.readyState !== WS_OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED) {
      s.log.warn('event stream client too slow; closing', { deviceId });
      socket.close(CLOSE_SLOW, 'too far behind; reconnect');
      cleanup();
      return;
    }
    try {
      socket.send(JSON.stringify(msg));
    } catch (e) {
      s.log.warn('event stream send failed', { deviceId, error: String(e) });
    }
  };

  const heartbeat = () => send({ kind: 'heartbeat', seq: ctx.store.seq, ts: ctx.clock.iso() });

  s.sockets.add(socket, deviceId);

  // hello, then replay, then live: all in this synchronous block.
  const state = ctx.store.getState();
  send({
    kind: 'hello',
    protocol: ctx.version.protocol,
    daemonVersion: ctx.version.daemon,
    webHash: s.webHash,
    epoch: ctx.store.epoch,
    seq: ctx.store.seq,
  });
  const replay = after === undefined ? null : ctx.store.replay(after);
  if (!replay || replay.kind === 'snapshot') {
    const snap = replay ?? { seq: ctx.store.seq, state };
    send({ kind: 'snapshot', seq: snap.seq, state: snap.state });
  } else {
    for (const event of replay.events) send({ kind: 'event', event });
  }
  unsub = ctx.store.subscribe((event: DaemonEvent) => send({ kind: 'event', event }));

  timer = ctx.clock.setInterval(() => {
    if (closed) return;
    if (deviceId) {
      const d = s.devices.get(deviceId);
      if (!d || d.revokedAt) {
        socket.close(CLOSE_REVOKED, 'device revoked');
        cleanup();
        return;
      }
    }
    if (!alive) {
      socket.terminate();
      cleanup();
      return;
    }
    alive = false;
    try {
      socket.ping();
    } catch {
      /* closing */
    }
    heartbeat();
  }, HEARTBEAT_MS);

  socket.on('pong', () => {
    alive = true;
  });
  socket.on('message', (data: unknown) => {
    alive = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return;
    }
    const msg = WsClientMessageSchema.safeParse(parsed);
    if (msg.success && msg.data.kind === 'ping') heartbeat();
  });
  socket.on('close', cleanup);
  socket.on('error', (err: Error) => {
    s.log.debug('event stream socket error', { deviceId, error: err.message });
    cleanup();
  });
}
