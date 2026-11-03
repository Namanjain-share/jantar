/**
 * v0.12 People: WS /v1/p/events, her stream (spec 9.3.6).
 *
 * 1. `hello {protocol, daemonVersion, webHash, personEpoch}`
 * 2. `tick {seq, life, plan, alerts, me}`: her counters only (life/people/ticks.ts)
 * 3. `heartbeat {ts}` every 25 s
 *
 * Registered on the TCP app only, with its own gate (app.ts personGate:
 * the people host, her cookie, exactly the people origin, her secret, the
 * ledger and her state). It reads no State, no replay, no store and no
 * owner event (T7): his sessions, usage and Life writes never reach it,
 * so her stream can't tell her when he is active. Revoke, leave and remove
 * close it with 4401.
 */
import type { PersonWsMessage } from '@jantar/protocol/people';
import type { TimerId } from '../contracts.js';
import { newId } from '../core/ids.js';
import type { RequestAuth } from './request.js';
import { WS_OPEN, type ApiServices, type WsLike } from './services.js';

export const PERSON_HEARTBEAT_MS = 25_000;
export const PERSON_CLOSE_REVOKED = 4401;
const MAX_BUFFERED = 1024 * 1024;

/** One epoch per daemon run: a reconnect after a restart re-fetches. */
const PERSON_EPOCH = newId();

export function openPersonEventStream(socket: WsLike, s: ApiServices, auth: RequestAuth): void {
  const me = auth.person;
  if (!me) {
    socket.close(PERSON_CLOSE_REVOKED, 'not a person device');
    return;
  }
  const people = s.deps.life.people;
  let closed = false;
  let timer: TimerId | undefined;
  const unsubs: (() => void)[] = [];

  const cleanup = () => {
    if (closed) return;
    closed = true;
    for (const u of unsubs) u();
    s.ctx.clock.clearInterval(timer);
  };
  const send = (msg: PersonWsMessage) => {
    if (closed || socket.readyState !== WS_OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED) {
      socket.close(1013, 'too far behind; reconnect');
      cleanup();
      return;
    }
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      /* the close handler cleans up */
    }
  };

  send({ kind: 'hello', protocol: s.ctx.version.protocol, daemonVersion: s.ctx.version.daemon, webHash: s.webHash, personEpoch: PERSON_EPOCH });
  const c = people.ticks.of(me.personId);
  send({ kind: 'tick', seq: c.seq, life: c.life, plan: c.plan, alerts: c.alerts, me: c.me });
  unsubs.push(people.ticks.subscribe(me.personId, (t) => send({ kind: 'tick', seq: t.seq, life: t.life, plan: t.plan, alerts: t.alerts, me: t.me })));
  unsubs.push(
    people.ticks.onClose(me.personId, (deviceId) => {
      if (deviceId !== null && deviceId !== me.deviceId) return;
      socket.close(PERSON_CLOSE_REVOKED, 'device revoked');
      cleanup();
    }),
  );
  timer = s.ctx.clock.setInterval(() => {
    if (closed) return;
    const d = s.personDevices.get(me.deviceId);
    if (!d || d.revokedAt) {
      socket.close(PERSON_CLOSE_REVOKED, 'device revoked');
      cleanup();
      return;
    }
    send({ kind: 'heartbeat', ts: s.ctx.clock.iso() });
  }, PERSON_HEARTBEAT_MS);
  socket.on('message', () => {
    /* her app sends nothing; anything sent is ignored */
  });
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}
