/**
 * v0.6 Fleet: the hub's link server.
 *
 * Its own `ws` server (link/ws-client.ts linkServer) at
 * NODE_LIMITS.frameBytes (the phone's /v1/events stays at 4096), reached
 * through api/node-upgrade.ts (Fleet on, the Host allowed, no Origin). Here,
 * in order:
 *
 * - The handshake limiter, keyed by the caller (`rateLimitKey` with the
 *   front door's header, as the API's): 10 + 2 x paired nodes a minute, so
 *   ten servers behind one NAT all reconnecting after the Mac wakes fit. Over
 *   it: HTTP 429 with retry-after.
 * - The cap on sockets not yet authenticated: 8 + paired nodes at once (429);
 *   a socket refused before its welcome gives its place up at once.
 * - The handshake (link/handshake.ts): challenge, then `auth` within
 *   NODE_LIMITS.handshakeMs (else 4408) and nothing else before it (4400).
 *   A link version that differs is 4426 (read before the strict parse, so a
 *   newer node hears it; noted for the Machines line only when the node's
 *   key signed it); a node key that is unknown, revoked or idle 90 days, or
 *   a signature that fails, is 4401. The verdict is checked again once the
 *   hub's key is read, so a revoke in between still refuses. Then `welcome`.
 * - The newest link with a key wins: an older one is closed 4409 and logged.
 * - Per link: exactly one snapshot, first (a second, or an event before it,
 *   is 4400); a frame kind a node may not send (`call`, ...) is 4400; an
 *   unknown kind is ignored; a bulk over NODE_LIMITS.bulkToHubBytes, a fifth
 *   at once, a chunk out of place or a sha256 mismatch is 4400; a frame over
 *   1 MiB is 1009 (ws itself); a send buffer over MAX_BUFFERED is 1013.
 * - Liveness: a ping every HEARTBEAT_MS (the link is terminated when the
 *   previous pong never came) and an app heartbeat both ways, which keeps
 *   Cloudflare's idle timer from firing; a node heartbeat (at most one every
 *   TOUCH_GAP_MS counts) touches the node's lastSeenAt (written at most
 *   every 5 minutes).
 * - HubLink.call never rejects: a link that is down answers node_offline
 *   (nothing was sent), one that takes too long node_timeout (60 s for
 *   LONG_NODE_ROUTES, else 30 s), the 17th call in flight 429. A link that
 *   drops ends a call already on the wire node_timeout (the node may have
 *   run it: check the session) and one not yet sent node_offline. Nothing
 *   is queued across a disconnect.
 *
 * A close the hub decides (revoke, Fleet off, replaced, a protocol error)
 * fires the link's onClose at once, so its owner sees the old link go before
 * a newer one arrives. Frames are logged by kind, size, node id and close
 * code only: never a body, a header or a key.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { HEARTBEAT_MS, NodeIdSchema, errorBody } from '@jantar/protocol';
import {
  LONG_NODE_ROUTES,
  NODE_CLOSE,
  NODE_LIMITS,
  NODE_PROTO,
  NODE_SENDS,
  NodeSnapshotSchema,
  isNodeRoute,
  type NodeCallReply,
  type NodeCallRequest,
  type NodeFrame,
  type NodeFrameOf,
  type NodeSnapshot,
} from '@jantar/protocol/node-link';
import type { DaemonContext, HubLink, HubLinkInfo, LinkServer, LinkServerHooks, Logger, TimerId } from '../contracts.js';
import { refuseUpgrade } from '../api/node-upgrade.js';
import { nodeFailureReply } from '../api/errors.js';
import { MAX_BUFFERED } from '../api/events-ws.js';
import { proxyHeaderFor, rateLimitKey } from '../auth/client-ip.js';
import type { NodeAuth } from '../auth/nodes.js';
import { SlidingWindowLimiter, type RateLimitOptions } from '../auth/rate-limit.js';
import { BulkAssembler, SNAPSHOT_BULK_ID, bulkLane, decodeFrame, encodeFrame, sendWithBulk } from '../link/codec.js';
import { authValid, challengeFrame, looseAuthValid, looseFrame, newNonce, welcomeFrame } from '../link/handshake.js';
import { WS_OPEN, WS_TOO_BIG, linkServer, type WsServer, type WsSocket } from '../link/ws-client.js';

/** Late results remembered per link (a call that timed out may still be answered, its bulk included). */
const LATE_KEPT = 64;

export function createLinkServer(ctx: DaemonContext, auth: NodeAuth, hooks: LinkServerHooks): LinkServer {
  const log = ctx.log.child({ part: 'fleet' });
  const limits: RateLimitOptions = { limit: NODE_LIMITS.handshakesPerMin, windowMs: 60_000, clock: ctx.clock };
  const limiter = new SlidingWindowLimiter(limits);
  const links = new Map<string, LiveLink>();
  const sockets = new Set<WsSocket>();
  let wss: WsServer | null = null;
  let unauth = 0;
  let stopped = false;

  const accept = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (stopped || !ctx.settings.get().fleet.enabled) return refuseUpgrade(socket, 404, 'not_found', 'not found');
    const paired = auth.pairedCount();
    limits.limit = NODE_LIMITS.handshakesPerMin + NODE_LIMITS.handshakesPerNode * paired;
    const key = rateLimitKey({ remoteAddress: req.socket.remoteAddress, headers: req.headers }, proxyHeaderFor(ctx.settings.get().remote.mode));
    const hit = limiter.hit(key);
    if (!hit.ok) {
      log.info('server link refused', { why: 'rate limited' });
      return refuseUpgrade(socket, 429, 'rate_limited', 'Too many link attempts: try again in a minute', {
        'retry-after': String(Math.max(1, Math.ceil(hit.retryAfterMs / 1000))),
      });
    }
    if (unauth >= NODE_LIMITS.unauthSockets + paired) {
      log.info('server link refused', { why: 'too many handshakes at once' });
      return refuseUpgrade(socket, 429, 'rate_limited', 'Too many servers are connecting at once: try again shortly', { 'retry-after': '5' });
    }
    unauth += 1;
    let counted = true;
    const release = (): void => {
      if (!counted) return;
      counted = false;
      unauth -= 1;
    };
    socket.once('close', release);
    wss ??= linkServer();
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (stopped) {
        ws.close(NODE_CLOSE.goingAway, 'going away');
        return;
      }
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      handshake(ws, release);
    });
  };

  /** Challenge, auth, welcome: then the link is live. */
  const handshake = (ws: WsSocket, release: () => void): void => {
    const hubNonce = newNonce();
    let phase: 'auth' | 'checking' | 'done' = 'auth';
    /** `nodeId`: only one whose key signed this auth (anyone may name a node id). */
    const refuse = (code: number, why: string, nodeId?: string): void => {
      phase = 'done';
      ctx.clock.clearTimeout(timer);
      // Its place is free now, not once a peer that ignores the close frame lets go.
      release();
      log.info('server link refused', { why, closeCode: code, ...(nodeId ? { nodeId } : {}) });
      if (nodeId && code === NODE_CLOSE.version) auth.noteRefusal(nodeId, code);
      ws.close(code, why);
    };
    const timer: TimerId = ctx.clock.setTimeout(() => {
      if (phase !== 'done') refuse(NODE_CLOSE.handshakeTimeout, 'handshake timeout');
    }, NODE_LIMITS.handshakeMs);
    ws.on('error', () => {});
    ws.on('close', () => {
      ctx.clock.clearTimeout(timer);
      phase = 'done';
    });
    ws.on('message', (data, isBinary) => {
      if (phase === 'done') return;
      if (phase === 'checking') return refuse(NODE_CLOSE.protocol, 'a frame before welcome');
      const text = isBinary ? null : data.toString('utf8');
      // The link version first, before the strict parse: a newer node's auth may carry what this version does not know (4426, never 4400).
      const raw = text === null ? null : looseFrame(text);
      if (raw?.k === 'auth' && typeof raw.proto === 'number' && raw.proto !== NODE_PROTO) {
        const rec = typeof raw.nodeId === 'string' && NodeIdSchema.safeParse(raw.nodeId).success ? auth.lookup(raw.nodeId) : null;
        return refuse(NODE_CLOSE.version, 'link versions differ', rec && looseAuthValid(rec.publicKey, raw, hubNonce) ? rec.id : undefined);
      }
      const d = text === null ? null : decodeFrame(text);
      if (!d?.ok || d.frame.k !== 'auth') return refuse(NODE_CLOSE.protocol, 'expected auth');
      const a = d.frame;
      const rec = auth.lookup(a.nodeId);
      if (!rec || !authValid(rec.publicKey, a, hubNonce)) return refuse(NODE_CLOSE.unknown, 'unknown server');
      const verdict = auth.verify(a.nodeId);
      if (!verdict.ok) return refuse(NODE_CLOSE.unknown, `server ${verdict.why}`, a.nodeId);
      phase = 'checking';
      auth.hubKey().then(
        (key) => {
          if (phase !== 'checking' || ws.readyState !== WS_OPEN) return;
          // Again: a revoke while the key was read found no link to close, so it is stopped here.
          const now = auth.verify(a.nodeId);
          if (!now.ok) return refuse(NODE_CLOSE.unknown, `server ${now.why}`, a.nodeId);
          phase = 'done';
          ctx.clock.clearTimeout(timer);
          release();
          const info: HubLinkInfo = { os: a.os, version: a.version, backend: a.backend, readOnly: a.readOnly, accessRefused: a.accessRefused };
          const older = links.get(a.nodeId);
          if (older) {
            log.warn('a newer link with the same key replaced a server link', { nodeId: a.nodeId });
            older.end(NODE_CLOSE.replaced, 'replaced by a newer link');
          }
          auth.touch(a.nodeId, { os: a.os, version: a.version });
          auth.clearRefusal(a.nodeId);
          ws.send(encodeFrame(welcomeFrame(key.privateKey, now.node.name, a.nodeId, hubNonce, a.nonce)));
          const link = new LiveLink(ws, a.nodeId, now.node.name, info, ctx, auth, log, () => {
            if (links.get(a.nodeId) === link) links.delete(a.nodeId);
          });
          links.set(a.nodeId, link);
          log.info('server linked', { nodeId: a.nodeId, os: a.os, backend: a.backend });
          hooks.onLink(link);
        },
        () => {
          if (phase !== 'checking') return;
          log.error("the hub's key could not be read: no server can link");
          refuse(1011, 'hub key unavailable');
        },
      );
    });
    ws.send(encodeFrame(challengeFrame(hubNonce)));
  };

  const closeAll = (code: number, reason: string): void => {
    for (const link of [...links.values()]) link.end(code, reason);
    for (const ws of [...sockets]) ws.close(code, reason);
  };

  return {
    accept,
    closeNode(nodeId, code, reason) {
      links.get(nodeId)?.end(code, reason);
    },
    closeAll,
    linked: () => [...links.keys()],
    stop: async () => {
      stopped = true;
      closeAll(NODE_CLOSE.goingAway, 'going away');
      const server = wss;
      wss = null;
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A node's heartbeats closer together than this touch nothing (each touch reads the node's row). */
const TOUCH_GAP_MS = 5000;

interface Waiting {
  settle(reply: NodeCallReply): void;
  timer: TimerId;
  /** Its frame was handed to the socket: the node may have run it. */
  sent: boolean;
}

/** One authenticated node link (the HubLink its owner wires). */
class LiveLink implements HubLink {
  private readonly snapshotFns: ((snap: NodeSnapshot) => void)[] = [];
  private readonly eventFns: ((event: unknown) => void)[] = [];
  private readonly closeFns: ((code: number) => void)[] = [];
  private readonly waiting = new Map<string, Waiting>();
  private readonly late = new Set<string>();
  private readonly bulkStatus = new Map<string, number>();
  private readonly bulks = new BulkAssembler({ maxBytes: NODE_LIMITS.bulkToHubBytes, maxInFlight: NODE_LIMITS.bulkInFlight });
  private readonly lane = bulkLane(NODE_LIMITS.bulkInFlight);
  private snapshot: 'none' | 'assembling' | 'done' = 'none';
  private closedWith: number | null = null;
  private alive = true;
  private readonly beat: TimerId;
  /** When a heartbeat last touched the node's row (linking touched it). */
  private touchedAt: number;

  constructor(
    private readonly ws: WsSocket,
    readonly nodeId: string,
    private readonly name: string,
    readonly info: HubLinkInfo,
    private readonly ctx: DaemonContext,
    private readonly auth: NodeAuth,
    private readonly log: Logger,
    private readonly gone: () => void,
  ) {
    ws.on('message', (data, isBinary) => this.onFrame(data, isBinary));
    // `ws` refuses a frame over maxPayload (it closes 1009 and stops reading, so its own close says 1006).
    ws.on('error', (err: Error & { code?: unknown }) => {
      if (err.code === WS_TOO_BIG) this.protocol(NODE_CLOSE.tooBig, 'a frame over the size limit');
      else if (typeof err.code === 'string' && err.code.startsWith('WS_ERR_')) this.protocol(NODE_CLOSE.protocol, 'a bad WebSocket frame');
    });
    ws.on('pong', () => {
      this.alive = true;
    });
    ws.on('close', (code) => this.finish(code));
    this.beat = ctx.clock.setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.touchedAt = ctx.clock.now();
  }

  onSnapshot(fn: (snap: NodeSnapshot) => void): void {
    this.snapshotFns.push(fn);
  }

  onEvent(fn: (event: unknown) => void): void {
    this.eventFns.push(fn);
  }

  onClose(fn: (code: number) => void): void {
    if (this.closedWith !== null) {
      const code = this.closedWith;
      queueMicrotask(() => fn(code));
      return;
    }
    this.closeFns.push(fn);
  }

  call(req: NodeCallRequest, bulk?: Buffer): Promise<NodeCallReply> {
    if (this.closedWith !== null || this.ws.readyState !== WS_OPEN) return Promise.resolve(nodeFailureReply('node_offline', this.name));
    if (this.waiting.size >= NODE_LIMITS.callsInFlight) {
      return Promise.resolve({ status: 429, body: errorBody('rate_limited', `${this.name} has too many calls waiting: try again in a moment.`) });
    }
    if (this.waiting.has(req.id) || this.late.has(req.id) || req.id === SNAPSHOT_BULK_ID) {
      return Promise.resolve({ status: 500, body: errorBody('internal', 'a call with this id is already on the link') });
    }
    const frame: NodeFrameOf<'call'> = { k: 'call', id: req.id, route: req.route, params: req.params, query: req.query, actor: req.actor };
    if (req.body !== undefined) frame.body = req.body;
    if (req.idem !== undefined) frame.idem = req.idem;
    let text: string | null = null;
    if (!bulk) {
      try {
        text = encodeFrame(frame);
      } catch {
        return Promise.resolve({ status: 500, body: errorBody('internal', 'the call is too large for the link') });
      }
    }
    return new Promise<NodeCallReply>((resolve) => {
      const ms = isNodeRoute(req.route) && LONG_NODE_ROUTES.has(req.route) ? NODE_LIMITS.longCallTimeoutMs : NODE_LIMITS.callTimeoutMs;
      const timer = this.ctx.clock.setTimeout(() => {
        if (!this.waiting.delete(req.id)) return;
        this.remember(req.id);
        resolve(nodeFailureReply('node_timeout', this.name));
      }, ms);
      const w: Waiting = { settle: resolve, timer, sent: false };
      this.waiting.set(req.id, w);
      const send = (): Promise<void> => {
        w.sent = true;
        return bulk ? sendWithBulk(this.ws, frame, bulk) : new Promise<void>((ok, fail) => this.ws.send(text ?? '', (err) => (err ? fail(err) : ok())));
      };
      const sent = bulk ? this.lane(send) : send();
      sent.catch((e: unknown) => {
        if (this.waiting.get(req.id) !== w) return;
        this.waiting.delete(req.id);
        this.ctx.clock.clearTimeout(w.timer);
        if (e instanceof RangeError) resolve({ status: 500, body: errorBody('internal', 'the call is too large for the link') });
        else resolve(nodeFailureReply('node_offline', this.name));
      });
    });
  }

  close(code: number, reason: string): void {
    this.end(code, reason);
  }

  /** Close from the hub's side: onClose fires now, the socket follows (cut, for a code a close frame cannot carry). */
  end(code: number, reason: string): void {
    if (this.closedWith !== null) return;
    this.finish(code);
    try {
      this.ws.close(code, reason);
    } catch {
      this.ws.terminate();
    }
  }

  private finish(code: number): void {
    if (this.closedWith !== null) return;
    this.closedWith = code;
    this.ctx.clock.clearInterval(this.beat);
    this.bulks.clear();
    this.gone();
    for (const [id, w] of this.waiting) {
      this.waiting.delete(id);
      this.ctx.clock.clearTimeout(w.timer);
      // A call already on the wire may have run on the node: its outcome is unknown (spec 3.6), so never "Nothing was sent".
      w.settle(nodeFailureReply(w.sent ? 'node_timeout' : 'node_offline', this.name));
    }
    this.log.info('server link closed', { nodeId: this.nodeId, closeCode: code });
    for (const fn of this.closeFns.splice(0)) fn(code);
  }

  private heartbeat(): void {
    if (this.closedWith !== null) return;
    if (!this.alive) {
      this.log.info('server link silent; dropping it', { nodeId: this.nodeId });
      this.finish(1006);
      this.ws.terminate();
      return;
    }
    this.alive = false;
    try {
      this.ws.ping();
      this.send({ k: 'heartbeat', ts: this.ctx.clock.iso() });
    } catch {
      /* closing */
    }
  }

  private send(frame: NodeFrame): void {
    if (this.closedWith !== null || this.ws.readyState !== WS_OPEN) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED) return this.protocol(NODE_CLOSE.slow, 'too far behind', frame.k);
    this.ws.send(encodeFrame(frame));
  }

  private protocol(code: number, problem: string, kind?: string, size?: number): void {
    this.log.warn('server link protocol error', { nodeId: this.nodeId, problem, ...(kind ? { kind } : {}), ...(size !== undefined ? { size } : {}) });
    this.end(code, problem);
  }

  private onFrame(data: Buffer, isBinary: boolean): void {
    if (this.closedWith !== null) return;
    this.alive = true;
    if (isBinary) return this.protocol(NODE_CLOSE.protocol, 'a binary frame', undefined, data.length);
    const d = decodeFrame(data.toString('utf8'));
    if (!d.ok) {
      if (d.problem === 'unknown-kind') return;
      return this.protocol(NODE_CLOSE.protocol, `a bad frame (${d.problem})`, d.kind, data.length);
    }
    const f = d.frame;
    if (!NODE_SENDS.has(f.k) || f.k === 'auth') return this.protocol(NODE_CLOSE.protocol, 'a frame a server may not send', f.k, data.length);
    switch (f.k) {
      case 'snapshot':
        return this.onSnapshotFrame(f);
      case 'event':
        if (this.snapshot !== 'done') return this.protocol(NODE_CLOSE.protocol, 'an event before the snapshot', f.k);
        for (const fn of this.eventFns) fn(f.event);
        return;
      case 'result':
        return this.onResult(f);
      case 'chunk':
        return this.onChunk(f);
      case 'heartbeat': {
        const now = this.ctx.clock.now();
        if (now - this.touchedAt < TOUCH_GAP_MS) return;
        this.touchedAt = now;
        this.auth.touch(this.nodeId, { os: this.info.os, version: this.info.version });
        return;
      }
      default:
        return;
    }
  }

  private onSnapshotFrame(f: NodeFrameOf<'snapshot'>): void {
    if (this.snapshot !== 'none') return this.protocol(NODE_CLOSE.protocol, 'a second snapshot', f.k);
    if (f.state) {
      this.snapshot = 'done';
      for (const fn of this.snapshotFns) fn(f.state);
      return;
    }
    if (!f.bulk) return this.protocol(NODE_CLOSE.protocol, 'a snapshot with nothing in it', f.k);
    this.snapshot = 'assembling';
    const step = this.bulks.begin(SNAPSHOT_BULK_ID, f.bulk);
    if (!step.ok) return this.protocol(NODE_CLOSE.protocol, `a bad bulk (${step.problem})`, f.k, f.bulk.size);
    if (step.done) this.snapshotArrived(step.done);
  }

  private snapshotArrived(bytes: Buffer): void {
    let json: unknown;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      return this.protocol(NODE_CLOSE.protocol, 'a bad snapshot (json)', 'snapshot', bytes.length);
    }
    const snap = NodeSnapshotSchema.safeParse(json);
    if (!snap.success) return this.protocol(NODE_CLOSE.protocol, 'a bad snapshot (shape)', 'snapshot', bytes.length);
    this.snapshot = 'done';
    for (const fn of this.snapshotFns) fn(snap.data);
  }

  private onResult(f: NodeFrameOf<'result'>): void {
    if (!this.waiting.has(f.id) && !this.late.has(f.id)) return this.protocol(NODE_CLOSE.protocol, 'a result for no call', f.k);
    if (!f.bulk) return this.answer(f.id, { status: f.status, body: f.body });
    const step = this.bulks.begin(f.id, f.bulk);
    if (!step.ok) return this.protocol(NODE_CLOSE.protocol, `a bad bulk (${step.problem})`, f.k, f.bulk.size);
    this.bulkStatus.set(f.id, f.status);
    if (step.done) this.resultArrived(f.id, step.done);
  }

  private onChunk(f: NodeFrameOf<'chunk'>): void {
    const step = this.bulks.add(f);
    if (!step.ok) return this.protocol(NODE_CLOSE.protocol, `a bad bulk (${step.problem})`, f.k);
    if (!step.done) return;
    if (f.id === SNAPSHOT_BULK_ID && this.snapshot === 'assembling') this.snapshotArrived(step.done);
    else this.resultArrived(f.id, step.done);
  }

  private resultArrived(id: string, bytes: Buffer): void {
    const status = this.bulkStatus.get(id) ?? 500;
    this.bulkStatus.delete(id);
    let body: unknown;
    try {
      body = JSON.parse(bytes.toString('utf8'));
    } catch {
      return this.protocol(NODE_CLOSE.protocol, 'a bad result (json)', 'result', bytes.length);
    }
    this.answer(id, { status, body });
  }

  private answer(id: string, reply: NodeCallReply): void {
    const w = this.waiting.get(id);
    if (!w) {
      this.late.delete(id);
      return;
    }
    this.waiting.delete(id);
    this.ctx.clock.clearTimeout(w.timer);
    w.settle(reply);
  }

  private remember(id: string): void {
    this.late.add(id);
    for (const old of this.late) {
      if (this.late.size <= LATE_KEPT) break;
      this.late.delete(old);
    }
  }
}
