/**
 * v0.6 Fleet: a hub and nodes over real sockets on port 0, for the link's
 * tests. The hub is the link server and NodeAuth behind the real upgrade
 * dispatcher (api/node-upgrade.ts), plus the one route a node calls
 * (POST /v1/node/pair), on plain loopback http or on https with a test
 * certificate. A node is a temp home whose node.json came from a real
 * pairing. Raw `ws` peers (`rawNode`, `rawHub`) speak the protocol by hand
 * for the cases a correct peer never makes. Every home is a temp dir; the
 * clock is a FakeClock (timers move only when a test says so).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { ERROR_STATUS, NodePairBodySchema, SettingsSchema, errorBody, type Settings } from '@jantar/protocol';
import { NODE_LINK_PATH, decodeJoinToken, linkUrl, type NodeFrame, type NodeSnapshot } from '@jantar/protocol/node-link';
import type { HubLink, NodeFile } from '../../src/contracts.js';
import { installNodeUpgrade } from '../../src/api/node-upgrade.js';
import type { ApiServices } from '../../src/api/services.js';
import { NodeAuth } from '../../src/auth/nodes.js';
import { FakeClock } from '../../src/core/clock.js';
import { createTestContext, type TestContext } from '../../src/core/testing.js';
import { createLinkServer } from '../../src/fleet/socket.js';
import { decodeFrame, encodeFrame } from '../../src/link/codec.js';
import { authFrame, newNonce } from '../../src/link/handshake.js';
import { pairWithHub } from '../../src/link/join.js';
import { privateKeyOf, writeNodeFile } from '../../src/link/keys.js';
import { loadWs, type WsSocket } from '../../src/link/ws-client.js';

export const FLEET_ON: Settings = SettingsSchema.parse({ fleet: { enabled: true } });

const cleanups: (() => Promise<void>)[] = [];

/** Run `fn` at the next cleanup (before the homes go). */
export function onCleanup(fn: () => Promise<void> | void): void {
  cleanups.push(async () => {
    await fn();
  });
}

/** Undo everything made since the last call (afterEach). */
export async function cleanup(): Promise<void> {
  for (const fn of cleanups.splice(0).reverse()) await fn().catch(() => {});
}

export async function tempHome(): Promise<{ dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'jantar-link-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return { dir };
}

export async function testCtx(opts: { settings?: Settings; clock?: FakeClock; env?: Record<string, string> } = {}): Promise<TestContext> {
  const { dir } = await tempHome();
  return createTestContext({
    userHome: dir,
    home: join(dir, '.jantar'),
    settings: opts.settings ?? FLEET_ON,
    ...(opts.clock ? { clock: opts.clock } : {}),
    env: { HOME: dir, LC_ALL: 'C', TZ: 'UTC', ...opts.env },
  });
}

/** A verified link on the hub, with what came over it. */
export interface RecordedLink {
  link: HubLink;
  snapshots: NodeSnapshot[];
  events: unknown[];
  closes: number[];
}

export interface TestHub {
  ctx: TestContext;
  auth: NodeAuth;
  url: string;
  port: number;
  server: Server;
  links: RecordedLink[];
  /** Replaces what happens to each verified link (default: record it and what comes over it). */
  onLink(fn: (link: HubLink) => void): void;
  linkServer: ReturnType<typeof createLinkServer>;
  /** POST bodies' headers seen by the pair route (names only checked by tests). */
  pairHeaders: Record<string, string | string[] | undefined>[];
  /** One join line. */
  token(name?: string): Promise<string>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

/** A hub: NodeAuth + the link server behind the real upgrade dispatcher, and POST /v1/node/pair. */
export async function startHub(opts: { ctx?: TestContext; tls?: { key: string; cert: string } } = {}): Promise<TestHub> {
  const ctx = opts.ctx ?? (await testCtx({ clock: new FakeClock(Date.parse('2026-11-01T10:00:00.000Z')) }));
  const auth = new NodeAuth(ctx);
  const links: RecordedLink[] = [];
  let onLink = (link: HubLink): void => {
    const r: RecordedLink = { link, snapshots: [], events: [], closes: [] };
    link.onSnapshot((snap) => r.snapshots.push(snap));
    link.onEvent((e) => r.events.push(e));
    link.onClose((code) => r.closes.push(code));
    links.push(r);
  };
  const linkServer = createLinkServer(ctx, auth, { onLink: (l) => onLink(l) });
  const pairHeaders: TestHub['pairHeaders'] = [];
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST' || req.url !== '/v1/node/pair') return json(res, 404, errorBody('not_found', 'not found'));
    pairHeaders.push(req.headers);
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, errorBody('invalid_request', 'bad json'));
    }
    const parsed = NodePairBodySchema.safeParse(body);
    if (!parsed.success) return json(res, 400, errorBody('invalid_request', 'bad body'));
    const r = await auth.pair(parsed.data, { rateKey: `ip:${req.socket.remoteAddress ?? ''}` });
    if (!r.ok) return json(res, ERROR_STATUS[r.code], errorBody(r.code, r.reason), r.headers);
    json(res, 201, r.reply);
  };
  const server = (opts.tls ? createHttpsServer({ key: opts.tls.key, cert: opts.tls.cert }) : createHttpServer()) as Server;
  server.on('request', (req: IncomingMessage, res: ServerResponse) => void handler(req, res));
  // The real dispatcher: Fleet on, the Host (allowed here), no Origin, then the link server.
  const services = {
    ctx,
    origin: { hostAllowed: () => true },
    fleet: { acceptLink: (req: IncomingMessage, socket: Duplex, head: Buffer) => linkServer.accept(req, socket, head) },
  } as unknown as ApiServices;
  installNodeUpgrade(server, services);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `${opts.tls ? 'https' : 'http'}://127.0.0.1:${port}`;
  cleanups.push(async () => {
    await linkServer.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    ctx,
    auth,
    url,
    port,
    server,
    links,
    linkServer,
    pairHeaders,
    onLink: (fn) => {
      onLink = fn;
    },
    token: async (name) => {
      const r = await auth.makeTokens(name ? { name } : {}, { hubUrl: url, createdBy: 'cli', loopbackHttp: true });
      if (!r.ok) throw new Error(r.reason);
      return r.tokens[0]!.token;
    },
  };
}

/** A node's home with node.json from a real pairing with `hub`. */
export async function joinNode(
  hub: TestHub,
  opts: { name?: string; clock?: FakeClock; env?: Record<string, string>; cfAccess?: NodeFile['cfAccess'] } = {},
): Promise<{ ctx: TestContext; node: NodeFile }> {
  const ctx = await testCtx({ clock: opts.clock ?? new FakeClock(Date.parse('2026-11-01T10:00:00.000Z')), ...(opts.env ? { env: opts.env } : {}) });
  const r = await pairWithHub(await hub.token(opts.name), { os: 'linux', version: '0.6.0', cfAccess: opts.cfAccess ?? null });
  if (!r.ok) throw new Error(r.reason);
  await writeNodeFile(ctx.paths, r.node);
  return { ctx, node: r.node };
}

/** Every frame text a raw peer received, decoded. */
export interface RawPeer {
  ws: WsSocket;
  frames: NodeFrame[];
  closed: Promise<number>;
  send(frame: NodeFrame | Record<string, unknown>): void;
  sendText(text: string): void;
  /** A binary frame (the link takes text only). */
  sendBinary(bytes: Buffer): void;
  /** The next frame of kind `k` (already received or still to come). */
  next(k: NodeFrame['k']): Promise<NodeFrame>;
}

function rawPeer(ws: WsSocket): RawPeer {
  const frames: NodeFrame[] = [];
  const waiters: { k: string; resolve: (f: NodeFrame) => void }[] = [];
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  ws.on('error', () => {});
  ws.on('message', (data) => {
    const d = decodeFrame(data.toString('utf8'));
    if (!d.ok) return;
    frames.push(d.frame);
    for (const w of waiters.filter((x) => x.k === d.frame.k)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(d.frame);
    }
  });
  return {
    ws,
    frames,
    closed,
    send: (frame) => ws.send(JSON.stringify(frame)),
    sendText: (text) => ws.send(text),
    sendBinary: (bytes) => (ws as unknown as { send(b: Buffer): void }).send(bytes),
    next: (k) => {
      const seen = frames.find((f) => f.k === k);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve) => waiters.push({ k, resolve }));
    },
  };
}

/** A raw node socket to the hub's link path (no handshake yet). */
export async function rawSocket(url: string, headers: Record<string, string> = {}, opts: { autoPong?: boolean } = {}): Promise<RawPeer> {
  const { WebSocket } = loadWs();
  const ws = new WebSocket(linkUrl(url), { headers, followRedirects: false, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024, ...opts });
  const peer = rawPeer(ws);
  cleanups.push(async () => ws.terminate());
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('unexpected-response', (_req, res) => reject(new Error(`unexpected response ${res.statusCode}`)));
    ws.on('error', reject);
  });
  return peer;
}

/** How an upgrade to the link path was answered: open (101), or refused with a status, its headers and body. */
export type Upgrade =
  | { open: true; status: 101; peer: RawPeer }
  | { open: false; status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** Try one upgrade to the hub's link path (for the budgets: a refusal is a value, not a throw). */
export async function upgrade(url: string, headers: Record<string, string> = {}): Promise<Upgrade> {
  const { WebSocket } = loadWs();
  const ws = new WebSocket(linkUrl(url), { headers, followRedirects: false, perMessageDeflate: false });
  cleanups.push(async () => ws.terminate());
  return new Promise<Upgrade>((resolve, reject) => {
    const peer = rawPeer(ws);
    ws.on('open', () => resolve({ open: true, status: 101, peer }));
    ws.on('unexpected-response', (_req, res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => {
        resolve({ open: false, status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString('utf8') });
        ws.terminate();
      });
    });
    ws.on('error', reject);
  });
}

/** A raw node that answers the challenge with `node`'s key (its `auth` sent; `next('welcome')` for the hub's answer). */
export async function rawNode(
  url: string,
  node: NodeFile,
  over: Record<string, unknown> = {},
  opts: { autoPong?: boolean } = {},
): Promise<RawPeer & { hubNonce: string; nodeNonce: string; auth: NodeFrame }> {
  const peer = await rawSocket(url, {}, opts);
  const challenge = (await peer.next('challenge')) as Extract<NodeFrame, { k: 'challenge' }>;
  const nodeNonce = newNonce();
  const key = privateKeyOf(node.privateKey)!;
  const auth = { ...authFrame(key, node.nodeId, challenge.nonce, nodeNonce, { os: 'linux', version: '0.6.0', backend: 'tmux', readOnly: false }, 0), ...over } as NodeFrame;
  peer.send(auth);
  return { ...peer, hubNonce: challenge.nonce, nodeNonce, auth };
}

/** How a door answers an upgrade instead of opening it. */
export interface Refusal {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

function refuseRaw(socket: Duplex, a: Refusal): void {
  const body = a.body ?? '';
  const lines = [
    `HTTP/1.1 ${a.status} Refused`,
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    ...Object.entries(a.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
  ];
  socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`);
}

/**
 * A hand-made hub: an http server whose link upgrades `onSocket` handles (no
 * checks at all). `refuse` (the n-th upgrade, from 0) may answer one with a
 * status instead, as a door in front of a hub would.
 */
export async function rawHub(
  onSocket: (peer: RawPeer, req: IncomingMessage) => void,
  opts: { refuse?: (req: IncomingMessage, n: number) => Refusal | null } = {},
): Promise<{ url: string; port: number; server: Server; upgrades: IncomingMessage[] }> {
  const { WebSocketServer } = loadWs();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  const upgrades: IncomingMessage[] = [];
  const server = createHttpServer((_req, res) => json(res, 404, errorBody('not_found', 'not found')));
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgrades.push(req);
    if ((req.url ?? '').split('?')[0] !== NODE_LINK_PATH) return socket.destroy();
    const refusal = opts.refuse?.(req, upgrades.length - 1);
    if (refusal) return refuseRaw(socket, refusal);
    wss.handleUpgrade(req, socket, head, (ws) => {
      cleanups.push(async () => ws.terminate());
      onSocket(rawPeer(ws), req);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${port}`, port, server, upgrades };
}

/** A plain http server answering every upgrade with `status`, `headers` and `body` (a door that refuses). */
export async function refusingDoor(answer: (req: IncomingMessage) => Refusal): Promise<{ url: string; seen: IncomingMessage[] }> {
  const seen: IncomingMessage[] = [];
  const server = createHttpServer((_req, res) => json(res, 404, errorBody('not_found', 'not found')));
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    seen.push(req);
    refuseRaw(socket, answer(req));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${port}`, seen };
}

/**
 * Move fake time on in 5 s steps with a little real time between them, so a
 * ping's pong (or any frame in flight) arrives as it would in real time and
 * the liveness checks never drop a healthy link.
 */
export async function pass(clock: FakeClock, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 5000) {
    clock.advance(Math.min(5000, left));
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** The hub key a join line pins. */
export function pinnedKey(token: string): string {
  const d = decodeJoinToken(token);
  if (!d.ok) throw new Error(d.reason);
  return d.token.hubKey;
}

export { encodeFrame };
