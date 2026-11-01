/**
 * v0.6 Fleet: `ws` (8.22.0, a direct dependency; no @types/ws), typed by the
 * small interfaces below (lane L1 grows them as it needs). The one place the
 * daemon loads `ws` for the link: the node's client socket and the hub's own
 * link server (fleet/socket.ts), separate from the phone's event stream
 * (@fastify/websocket, maxPayload 4096).
 *
 * The client never follows a redirect (`followRedirects: false`) and checks
 * TLS against Node's CA list plus NODE_EXTRA_CA_CERTS; there is no switch
 * that loosens either.
 */
import { createRequire } from 'node:module';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

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
  on(event: 'open' | 'pong', fn: () => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  on(event: 'unexpected-response', fn: (req: unknown, res: IncomingMessage) => void): unknown;
}

export interface WsClientOptions {
  headers?: Record<string, string>;
  maxPayload?: number;
  handshakeTimeout?: number;
  followRedirects?: false;
  perMessageDeflate?: false;
}

export interface WsServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: WsSocket) => void): void;
  close(cb?: () => void): void;
}

export interface WsServerOptions {
  noServer: true;
  maxPayload: number;
  perMessageDeflate?: false;
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
