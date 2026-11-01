/**
 * v0.6 Fleet: the node's dialler.
 *
 * Reads node.json (`file`) before every attempt (so `jantar node access`
 * needs only a restart, and a replaced token is used on the next attempt),
 * dials `linkUrl(url)` with the Access headers when the file has them (no
 * redirects; TLS against Node's CA list plus NODE_EXTRA_CA_CERTS), answers
 * the challenge, checks the hub's welcome against the pinned key (an
 * impostor is closed and logged every time), and hands each verified link
 * to `onLink`. A `call` before the welcome is never acted on. Then the
 * watchdog (no frame for NODE_LIMITS.watchdogMs: the link is dropped), app
 * heartbeats every HEARTBEAT_MS, and full-jitter backoff (link/backoff.ts)
 * with the wait spec 3.8 gives each ending. An HTTP 403 with no Jantar body
 * is Cloudflare Access refusing: counted in `accessRefused` (since the last
 * good link) and sent in the next `auth`. Every timer is ctx.clock's.
 *
 * The link itself: the snapshot goes first (events sent before it is out,
 * a bulk included, wait for it); a frame too large goes as a bulk (results
 * up to NODE_LIMITS.bulkToHubBytes; over that a result is a 500 "reply too
 * large for the link"); an upload's bulk that does not arrive whole is the
 * call's 400 and nothing runs; at most NODE_LIMITS.callsInFlight calls run
 * at once (more: 429). Nothing is ever logged but kinds, sizes, codes and
 * the hub's host.
 *
 * JANTAR_NODE_RETRY_CAP_MS (tests: the Docker end-to-end run) shortens every
 * wait to at most that many milliseconds; it can only make a node retry
 * sooner, which the hub's handshake limiter still bounds.
 */
import type { KeyObject } from 'node:crypto';
import { HEARTBEAT_MS, errorBody, type DaemonEvent } from '@jantar/protocol';
import {
  HUB_SENDS,
  NODE_CLOSE,
  NODE_LIMITS,
  linkUrl,
  type NodeCallReply,
  type NodeCallRequest,
  type NodeFrame,
  type NodeFrameOf,
  type NodeSnapshot,
} from '@jantar/protocol/node-link';
import type { DaemonContext, Dialer, Logger, NodeFile, NodeLink, NodeLinkStatus, TimerId } from '../contracts.js';
import { MAX_BUFFERED } from '../api/events-ws.js';
import { NODE_LINK_OFF } from '../modes.js';
import { endingCode, retryWait, type LinkEnding } from '../link/backoff.js';
import { BulkAssembler, bulkLane, decodeFrame, encodeFrame, sendWithBulk } from '../link/codec.js';
import { authFrame, newNonce, thisNodeOs, welcomeValid, type NodeSelf } from '../link/handshake.js';
import { accessHeaders, isJantarError, isTlsError } from '../link/join.js';
import { privateKeyOf, readNodeFile } from '../link/keys.js';
import { WS_OPEN, WS_TOO_BIG, openLinkSocket, type WsSocket } from '../link/ws-client.js';

/** Events held while the snapshot is still going out, at most (then the link is dropped and the next one starts with a snapshot). */
const HELD_EVENTS_MAX = 10_000;
/** At most this much of a refused upgrade's body is read (to tell Cloudflare Access's 403 from Jantar's). */
const REFUSAL_BODY_MAX = 4096;

/** What the node says of itself when nobody told the dialler: its own OS, the backend its platform picks, not read-only. */
export function defaultSelf(ctx: Pick<DaemonContext, 'version'>, os: NodeSelf['os']): NodeSelf {
  return { os, version: ctx.version.daemon, backend: os === 'windows' ? 'none' : os === 'macos' ? 'terminal-app' : 'tmux', readOnly: false };
}

export function createDialer(ctx: DaemonContext, file: string, self: () => NodeSelf = () => defaultSelf(ctx, thisNodeOs())): Dialer {
  const log = ctx.log.child({ part: 'nodeLink' });
  let status: NodeLinkStatus = { ...NODE_LINK_OFF };
  let stopped = true;
  let attempt = 0;
  let accessRefused = 0;
  let retryTimer: TimerId | undefined;
  let current: Attempt | null = null;
  let onLink: ((link: NodeLink) => void) | null = null;
  let lastLogged = '';

  const capMs = (): number => {
    const raw = Number(ctx.env.JANTAR_NODE_RETRY_CAP_MS);
    return Number.isInteger(raw) && raw > 0 ? raw : Number.POSITIVE_INFINITY;
  };

  const dial = async (): Promise<void> => {
    retryTimer = undefined;
    if (stopped) return;
    const node = await readNodeFile(file);
    if (stopped) return;
    const key = node ? privateKeyOf(node.privateKey) : null;
    if (!node || !key) {
      log.error('node.json is missing or unreadable: this server cannot link (jantar node leave, then join again)');
      status = { ...NODE_LINK_OFF };
      return;
    }
    status = { ...status, state: 'connecting', name: node.name, hubHost: new URL(node.url).hostname, accessRefused, retryAt: null };
    const a = new Attempt(ctx, log, node, key, self(), accessRefused, {
      linked: (link, name) => {
        accessRefused = 0;
        status = { ...status, state: 'linked', name, accessRefused: 0, retryAt: null };
        lastLogged = '';
        log.info('linked to the hub', { host: status.hubHost });
        onLink?.(link);
      },
    });
    current = a;
    const ending = await a.ended;
    current = null;
    if (stopped) return;
    if (ending.kind === 'http' && ending.access) accessRefused += 1;
    if (a.linkedMs() >= NODE_LIMITS.backoffResetMs) attempt = 0;
    const wait = Math.min(retryWait(ending, attempt, Math.random), capMs());
    attempt += 1;
    const at = ctx.clock.now() + wait;
    status = {
      ...status,
      state: 'waiting',
      lastClose: { code: endingCode(ending), at: ctx.clock.iso() },
      accessRefused,
      retryAt: ctx.clock.iso(at),
    };
    report(ending, wait);
    retryTimer = ctx.clock.setTimeout(() => void dial(), wait);
  };

  /** One line per change of how attempts end (an impostor: every time). */
  const report = (e: LinkEnding, wait: number): void => {
    const fields = { host: status.hubHost, code: endingCode(e), retryInMs: wait };
    if (e.kind === 'impostor') {
      log.error("the hub's welcome is not signed by the key this server joined with: not linking", fields);
      return;
    }
    const sig = `${e.kind}:${endingCode(e)}`;
    if (sig === lastLogged) return;
    lastLogged = sig;
    log.warn(endingText(e), e.kind === 'tls' || e.kind === 'network' ? { ...fields, error: e.error } : fields);
  };

  return {
    start(fn) {
      if (!stopped) return;
      stopped = false;
      onLink = fn;
      void dial();
    },
    stop: async () => {
      stopped = true;
      onLink = null;
      ctx.clock.clearTimeout(retryTimer);
      retryTimer = undefined;
      const a = current;
      if (a) {
        // A polite close, but never a long wait for it: after a second the socket is cut.
        a.end(NODE_CLOSE.goingAway, 'going away');
        const quiet = new AbortController();
        const closed = await Promise.race([a.ended.then(() => true), ctx.clock.sleep(1000, quiet.signal).then(() => false, () => true)]);
        quiet.abort();
        if (!closed) a.cut();
        await a.ended;
      }
      status = { ...status, state: 'off', retryAt: null };
    },
    status: () => ({ ...status, ...(status.lastClose ? { lastClose: { ...status.lastClose } } : {}) }),
  };
}

/** The one log sentence per kind of ending (never a URL path, header or body). */
export function endingText(e: LinkEnding): string {
  switch (e.kind) {
    case 'closed':
      if (e.code === NODE_CLOSE.unknown) return 'removed from the hub: run jantar node join with a new line';
      if (e.code === NODE_CLOSE.version) return 'the hub speaks another link version: update Jantar here';
      if (e.code === NODE_CLOSE.fleetOff) return 'Fleet is off at the Mac';
      if (e.code === NODE_CLOSE.replaced) return 'another machine linked with this server\'s key (a cloned machine?)';
      return 'the link to the hub closed';
    case 'http':
      if (e.access) return 'Cloudflare Access refused the connection: the service token may have expired or been revoked (jantar node access)';
      if (e.status === 404) return 'Fleet is off at the Mac (the hub answered 404)';
      if (e.status === 429) return 'the hub asked this server to wait';
      return 'the hub refused the link';
    case 'redirect':
      return "the hub's address answered with a redirect: servers never follow one";
    case 'tls':
      return "the hub's certificate is not trusted here (Node's CA list plus NODE_EXTRA_CA_CERTS)";
    case 'network':
      return 'could not reach the hub';
    case 'timeout':
      return 'the hub did not answer in time';
    case 'impostor':
      return "the hub's welcome is not signed by the key this server joined with";
    case 'protocol':
      return 'the hub sent a frame this server does not accept';
  }
}

/** One dial: the upgrade, the handshake, then the link until it ends. */
class Attempt {
  readonly ended: Promise<LinkEnding>;
  private resolveEnded!: (e: LinkEnding) => void;
  private readonly ws: WsSocket | null;
  private phase: 'challenge' | 'welcome' | 'linked' | 'done' = 'challenge';
  private ending: LinkEnding | null = null;
  private hubNonce = '';
  private nodeNonce = '';
  private linkedAt: number | null = null;
  private endedAt: number | null = null;
  private timer: TimerId | undefined;
  private beat: TimerId | undefined;
  private link: SocketNodeLink | null = null;

  constructor(
    private readonly ctx: DaemonContext,
    private readonly log: Logger,
    private readonly node: NodeFile,
    private readonly key: KeyObject,
    private readonly self: NodeSelf,
    private readonly accessRefused: number,
    private readonly hooks: { linked(link: NodeLink, name: string): void },
  ) {
    this.ended = new Promise((resolve) => {
      this.resolveEnded = resolve;
    });
    let ws: WsSocket | null = null;
    try {
      ws = openLinkSocket(linkUrl(node.url), accessHeaders(node.cfAccess));
    } catch (e) {
      this.ws = null;
      this.done({ kind: 'network', error: String((e as { code?: unknown }).code ?? 'EINVAL') });
      return;
    }
    this.ws = ws;
    // The handshake must finish in time; once linked, the watchdog takes over.
    this.timer = ctx.clock.setTimeout(() => this.drop({ kind: 'timeout' }), NODE_LIMITS.handshakeMs);
    ws.on('unexpected-response', (_req, res) => this.refused(res.statusCode ?? 0, res));
    ws.on('error', (err: Error & { code?: string }) => {
      const code = typeof err.code === 'string' ? err.code : 'NETWORK';
      // `ws` closes 1009 on a frame over maxPayload, 1002 on a malformed one; its own close then says 1006.
      if (code === WS_TOO_BIG) this.ending ??= { kind: 'closed', code: NODE_CLOSE.tooBig };
      else if (code.startsWith('WS_ERR_')) this.ending ??= { kind: 'protocol' };
      else this.ending ??= isTlsError(code) ? { kind: 'tls', error: code } : { kind: 'network', error: code };
    });
    ws.on('ping', () => this.alive());
    ws.on('message', (data, isBinary) => this.onFrame(data, isBinary));
    ws.on('close', (code) => this.done(this.ending ?? { kind: 'closed', code }));
  }

  /** How long the link was up (0 if it never was). */
  linkedMs(): number {
    return this.linkedAt === null ? 0 : (this.endedAt ?? this.ctx.clock.now()) - this.linkedAt;
  }

  /** Close from this side (stop, or the link's own decision). */
  end(code: number, reason: string): void {
    if (this.phase === 'done' || !this.ws) return;
    this.ending ??= { kind: 'closed', code };
    if (this.ws.readyState === WS_OPEN) this.ws.close(code, reason);
    else this.ws.terminate();
  }

  /** Cut the socket without a close frame. */
  cut(): void {
    this.ws?.terminate();
  }

  /** Give the socket up at once (a timeout, a protocol error, an impostor). */
  private drop(e: LinkEnding, code: number = NODE_CLOSE.protocol): void {
    if (this.phase === 'done' || !this.ws) return;
    this.ending ??= e;
    if (this.ws.readyState === WS_OPEN && e.kind !== 'timeout') this.ws.close(code, e.kind);
    else this.ws.terminate();
  }

  /** The upgrade was answered with a status, not 101: read enough of a 403 to tell Access's from Jantar's. */
  private refused(status: number, res: NodeJS.ReadableStream & { headers: Record<string, string | string[] | undefined> }): void {
    if (status >= 300 && status < 400) return this.drop({ kind: 'redirect', status });
    if (status === 429) {
      const after = Number(res.headers['retry-after']);
      return this.drop({ kind: 'http', status, ...(Number.isFinite(after) && after > 0 ? { retryAfterMs: after * 1000 } : {}) });
    }
    if (status !== 403) return this.drop({ kind: 'http', status });
    const parts: Buffer[] = [];
    let size = 0;
    const decide = (): void => {
      const text = size > REFUSAL_BODY_MAX ? '' : Buffer.concat(parts).toString('utf8');
      this.drop({ kind: 'http', status, ...(isJantarError(text) ? {} : { access: true }) });
    };
    res.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= REFUSAL_BODY_MAX) parts.push(chunk);
      else decide();
    });
    res.on('end', decide);
    res.on('error', decide);
  }

  private onFrame(data: Buffer, isBinary: boolean): void {
    if (this.phase === 'done') return;
    this.alive();
    if (isBinary) return this.drop({ kind: 'protocol' });
    const d = decodeFrame(data.toString('utf8'));
    if (!d.ok) {
      if (d.problem === 'unknown-kind' && this.phase === 'linked') return;
      return this.drop({ kind: 'protocol' });
    }
    const f = d.frame;
    if (!HUB_SENDS.has(f.k)) return this.drop({ kind: 'protocol' });
    if (this.phase === 'challenge') {
      if (f.k === 'challenge') return this.answer(f);
      // Acts on nothing before a verified welcome.
      if (f.k === 'call' || f.k === 'chunk' || f.k === 'heartbeat') return;
      return this.drop({ kind: 'protocol' });
    }
    if (this.phase === 'welcome') {
      if (f.k === 'welcome') return this.welcome(f);
      if (f.k === 'call' || f.k === 'chunk' || f.k === 'heartbeat') return;
      return this.drop({ kind: 'protocol' });
    }
    if (f.k === 'challenge' || f.k === 'welcome') return this.drop({ kind: 'protocol' });
    this.link?.frame(f);
  }

  private answer(c: NodeFrameOf<'challenge'>): void {
    if (!this.ws) return;
    this.hubNonce = c.nonce;
    this.nodeNonce = newNonce();
    this.phase = 'welcome';
    this.ws.send(encodeFrame(authFrame(this.key, this.node.nodeId, c.nonce, this.nodeNonce, this.self, this.accessRefused)));
  }

  private welcome(w: NodeFrameOf<'welcome'>): void {
    if (!this.ws) return;
    if (!welcomeValid(this.node.hubKey, this.node.nodeId, this.hubNonce, this.nodeNonce, w)) return this.drop({ kind: 'impostor' });
    this.phase = 'linked';
    this.linkedAt = this.ctx.clock.now();
    this.alive();
    this.link = new SocketNodeLink(this.ws, this.ctx, this.log);
    this.beat = this.ctx.clock.setInterval(() => this.link?.heartbeat(), HEARTBEAT_MS);
    this.hooks.linked(this.link, w.name);
  }

  /** A frame (or a ping) came: the watchdog starts over. */
  private alive(): void {
    if (this.phase !== 'linked') return;
    this.ctx.clock.clearTimeout(this.timer);
    this.timer = this.ctx.clock.setTimeout(() => this.drop({ kind: 'timeout' }), NODE_LIMITS.watchdogMs);
  }

  private done(e: LinkEnding): void {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this.endedAt = this.ctx.clock.now();
    this.ctx.clock.clearTimeout(this.timer);
    this.ctx.clock.clearInterval(this.beat);
    this.link?.closed(endingCode(e));
    this.resolveEnded(e);
  }
}

/** The node's side of a verified link. */
class SocketNodeLink implements NodeLink {
  private readonly closeFns: ((code: number) => void)[] = [];
  private callFn: ((req: NodeCallRequest, bulk?: Buffer) => Promise<NodeCallReply>) | null = null;
  private readonly bulks = new BulkAssembler({ maxBytes: NODE_LIMITS.bulkToNodeBytes, maxInFlight: NODE_LIMITS.bulkInFlight });
  private readonly lane = bulkLane(NODE_LIMITS.bulkInFlight);
  /** Calls whose upload is still arriving. */
  private readonly assembling = new Map<string, NodeCallRequest>();
  private readonly running = new Set<string>();
  /** null once the snapshot is out; until then, events wait here. */
  private held: DaemonEvent[] | null = [];
  private snapshotSent = false;
  private closedWith: number | null = null;

  constructor(
    private readonly ws: WsSocket,
    private readonly ctx: DaemonContext,
    private readonly log: Logger,
  ) {}

  sendSnapshot(snap: NodeSnapshot): void {
    if (this.closedWith !== null) return;
    if (this.snapshotSent) {
      // The hub allows one per link: a second is its protocol error, so it is never sent.
      this.log.warn('a second snapshot on one link was not sent');
      return;
    }
    this.snapshotSent = true;
    const frame: NodeFrame = { k: 'snapshot', state: snap } as NodeFrame;
    let text: string | null = null;
    try {
      text = encodeFrame(frame);
    } catch {
      text = null;
    }
    if (text !== null) {
      this.write(text);
      this.flushHeld();
      return;
    }
    const bytes = Buffer.from(JSON.stringify(snap), 'utf8');
    if (bytes.length > NODE_LIMITS.bulkToHubBytes) {
      this.log.error('the snapshot is too large for the link', { size: bytes.length });
      return this.end(NODE_CLOSE.tooBig, 'snapshot too large');
    }
    this.lane(() => sendWithBulk(this.ws, { k: 'snapshot' } as NodeFrame, bytes)).then(
      () => this.flushHeld(),
      () => {
        /* the link closed */
      },
    );
  }

  sendEvent(event: DaemonEvent): void {
    if (this.closedWith !== null) return;
    if (this.held) {
      if (this.held.length >= HELD_EVENTS_MAX) return this.end(NODE_CLOSE.slow, 'too far behind');
      this.held.push(event);
      return;
    }
    this.event(event);
  }

  onCall(fn: (req: NodeCallRequest, bulk?: Buffer) => Promise<NodeCallReply>): void {
    this.callFn = fn;
  }

  onClose(fn: (code: number) => void): void {
    if (this.closedWith !== null) {
      const code = this.closedWith;
      queueMicrotask(() => fn(code));
      return;
    }
    this.closeFns.push(fn);
  }

  /** The socket ended (fires onClose once). */
  closed(code: number): void {
    if (this.closedWith !== null) return;
    this.closedWith = code;
    this.bulks.clear();
    this.assembling.clear();
    this.held = null;
    for (const fn of this.closeFns.splice(0)) fn(code);
  }

  heartbeat(): void {
    if (this.closedWith === null) this.write(encodeFrame({ k: 'heartbeat', ts: this.ctx.clock.iso() }));
  }

  /** A frame from the hub after the welcome. */
  frame(f: NodeFrame): void {
    if (this.closedWith !== null) return;
    if (f.k === 'call') return this.call(f);
    if (f.k === 'chunk') return this.chunk(f);
  }

  private end(code: number, reason: string): void {
    if (this.ws.readyState === WS_OPEN) this.ws.close(code, reason);
    else this.ws.terminate();
  }

  private write(text: string): void {
    if (this.closedWith !== null || this.ws.readyState !== WS_OPEN) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED) return this.end(NODE_CLOSE.slow, 'too far behind');
    this.ws.send(text);
  }

  private flushHeld(): void {
    const held = this.held ?? [];
    this.held = null;
    for (const e of held) this.event(e);
  }

  private event(event: DaemonEvent): void {
    let text: string;
    try {
      text = encodeFrame({ k: 'event', event } as NodeFrame);
    } catch {
      this.log.warn('an event too large for the link was not sent', { type: event.type });
      return;
    }
    this.write(text);
  }

  private call(f: NodeFrameOf<'call'>): void {
    if (this.running.has(f.id) || this.assembling.has(f.id)) return this.end(NODE_CLOSE.protocol, 'a call id twice');
    const { k: _k, bulk, ...req } = f;
    if (this.running.size + this.assembling.size >= NODE_LIMITS.callsInFlight) {
      return this.result(f.id, { status: 429, body: errorBody('rate_limited', 'Too many calls at once on this server: try again in a moment.') });
    }
    if (!bulk) return this.run(req);
    const step = this.bulks.begin(f.id, bulk);
    if (!step.ok) return this.result(f.id, uploadRefused());
    if (step.done) return this.run(req, step.done);
    this.assembling.set(f.id, req);
  }

  private chunk(f: NodeFrameOf<'chunk'>): void {
    const step = this.bulks.add(f);
    const req = this.assembling.get(f.id);
    if (!step.ok) {
      if (!req) return this.end(NODE_CLOSE.protocol, 'a chunk for no call');
      this.assembling.delete(f.id);
      this.log.warn('an upload did not arrive whole; nothing was stored', { problem: step.problem });
      return this.result(f.id, uploadRefused());
    }
    if (step.done && req) {
      this.assembling.delete(f.id);
      this.run(req, step.done);
    }
  }

  private run(req: NodeCallRequest, bytes?: Buffer): void {
    this.running.add(req.id);
    const fn = this.callFn;
    const reply = fn ? fn(req, bytes) : Promise.resolve({ status: 503, body: errorBody('unavailable', 'jantard is starting') });
    reply
      .catch(() => ({ status: 500, body: errorBody('internal', 'internal error') }))
      .then((r) => {
        this.running.delete(req.id);
        this.result(req.id, r);
      });
  }

  private result(id: string, reply: NodeCallReply): void {
    if (this.closedWith !== null) return;
    const head: NodeFrameOf<'result'> = { k: 'result', id, status: reply.status };
    if (reply.body !== undefined) head.body = reply.body;
    try {
      return this.write(encodeFrame(head));
    } catch {
      /* too large for one frame: a bulk */
    }
    const bytes = Buffer.from(JSON.stringify(reply.body), 'utf8');
    if (bytes.length > NODE_LIMITS.bulkToHubBytes) {
      return this.write(encodeFrame({ k: 'result', id, status: 500, body: errorBody('internal', 'reply too large for the link') }));
    }
    this.lane(() => sendWithBulk(this.ws, { k: 'result', id, status: reply.status }, bytes)).catch(() => {
      /* the link closed */
    });
  }
}

function uploadRefused(): NodeCallReply {
  return { status: 400, body: errorBody('invalid_request', 'The upload did not arrive whole: nothing was stored. Try again.') };
}
