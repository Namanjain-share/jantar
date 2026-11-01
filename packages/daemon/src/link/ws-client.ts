/**
 * v0.6 Fleet: `ws` (8.22.0, a direct dependency; no @types/ws), typed by the
 * small interfaces below. The one place the daemon loads `ws` for the link:
 * the node's client socket (`openLinkSocket`) and the hub's own link server
 * (fleet/socket.ts), separate from the phone's event stream
 * (@fastify/websocket, maxPayload 4096).
 *
 * The client never follows a redirect (`followRedirects: false`; a 3xx is an
 * `unexpected-response` like any other status) and checks TLS against
 * Node's CA list plus NODE_EXTRA_CA_CERTS (no `ca`, no
 * `rejectUnauthorized`: Node's defaults); there is no switch that loosens
 * either. No Origin header is sent (the hub refuses one), and no
 * permessage-deflate.
 */
import { createRequire } from 'node:module';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { NODE_LIMITS } from '@jantar/protocol/node-link';

/** WebSocket.OPEN. */
export const WS_OPEN = 1;

/** The error code `ws` gives a frame over maxPayload (it then closes 1009). Other `WS_ERR_*` codes are malformed frames. */
export const WS_TOO_BIG = 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';

/** A WebSocket as `ws` gives it (client or server side). */
export interface WsSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: 'message', fn: (data: Buffer, isBinary: boolean) => void): unknown;
  on(event: 'close', fn: (code: number, reason: Buffer) => void): unknown;
  on(event: 'open' | 'pong' | 'ping', fn: () => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  on(event: 'unexpected-response', fn: (req: ClientRequest, res: IncomingMessage) => void): unknown;
}

export interface WsClientOptions {
  headers?: Record<string, string>;
  maxPayload?: number;
  handshakeTimeout?: number;
  followRedirects?: false;
  perMessageDeflate?: false;
  /** Tests only: a peer that never answers pings. */
  autoPong?: boolean;
}

export interface WsServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: WsSocket) => void): void;
  close(cb?: () => void): void;
}

export interface WsServerOptions {
  noServer: true;
  maxPayload: number;
  perMessageDeflate?: false;
  clientTracking?: false;
}

/** What this file needs of the `ws` module. */
export interface WsModule {
  WebSocket: new (url: string, opts?: WsClientOptions) => WsSocket;
  WebSocketServer: new (opts: WsServerOptions) => WsServer;
}

let loaded: WsModule | null = null;

/** The `ws` module, loaded once. */
export function loadWs(): WsModule {
  loaded ??= createRequire(import.meta.url)('ws') as WsModule;
  return loaded;
}

/**
 * The node's link socket to `url` (wss://, or ws:// on loopback), with the
 * Access headers when given. Frames over NODE_LIMITS.frameBytes close it
 * 1009. The handshake's timeout is the caller's (on ctx.clock).
 */
export function openLinkSocket(url: string, headers: Record<string, string>): WsSocket {
  const { WebSocket } = loadWs();
  return new WebSocket(url, { headers, maxPayload: NODE_LIMITS.frameBytes, followRedirects: false, perMessageDeflate: false });
}

/** The hub's link server: `noServer` (upgrades come through api/node-upgrade.ts), at NODE_LIMITS.frameBytes. */
export function linkServer(): WsServer {
  const { WebSocketServer } = loadWs();
  return new WebSocketServer({ noServer: true, maxPayload: NODE_LIMITS.frameBytes, perMessageDeflate: false, clientTracking: false });
}
