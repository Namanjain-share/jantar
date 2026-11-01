/**
 * v0.6 Fleet: the node link's upgrade, taken before Fastify sees it.
 *
 * @fastify/websocket upgrades every route with its one `ws` server
 * (maxPayload 4096), so a 1 MiB node link cannot be a Fastify route without
 * raising every phone socket to 1 MiB. Instead the TCP server's `upgrade`
 * listeners are wrapped once at start: a request whose path is exactly
 * NODE_LINK_PATH goes to `s.fleet.acceptLink` (its own `ws` server); every
 * other upgrade goes to Fastify's listeners unchanged, so `/v1/events` keeps
 * 4096.
 *
 * Before handing over, the cheap checks run here, in order, answered on the
 * raw socket: Fleet on (else 404, as if there were no such path), the Host
 * allowed (the DNS-rebinding guard, as for every request), and no `Origin`
 * header (403: a browser can never open a node link, a paired phone's
 * included). No device cookie, secret or extension key is read. The link
 * server then applies its handshake limiter and the cap on unauthenticated
 * sockets, and the handshake proves the node.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { errorBody, type ErrorCode } from '@jantar/protocol';
import { NODE_LINK_PATH } from '@jantar/protocol/node-link';
import type { ApiServices } from './services.js';

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  426: 'Upgrade Required',
  429: 'Too Many Requests',
  501: 'Not Implemented',
  503: 'Service Unavailable',
};

/**
 * Answer an upgrade request on its raw socket with a JSON error and close
 * it. `headers`: e.g. retry-after on a 429. Never echoes anything the
 * request carried.
 */
export function refuseUpgrade(socket: Duplex, status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}): void {
  if (socket.destroyed) return;
  const body = JSON.stringify(errorBody(code, message));
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Cache-Control: no-store',
    'Connection: close',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ];
  // Destroyed once the reply is flushed: destroying at once could cut it off on a slow socket, and a node
  // that saw no 404 or 429 would read a network error and retry sooner than it was told to.
  socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`, () => socket.destroy());
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** The checks of the node link's upgrade, then the hand-over (see the file header). */
export function handleNodeUpgrade(s: ApiServices, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  if (!s.ctx.settings.get().fleet.enabled) return refuseUpgrade(socket, 404, 'not_found', 'not found');
  if (!s.origin.hostAllowed(headerValue(req.headers.host))) return refuseUpgrade(socket, 403, 'forbidden', 'unknown Host header');
  if (req.headers.origin !== undefined) return refuseUpgrade(socket, 403, 'forbidden', 'browsers cannot open this');
  s.fleet.acceptLink(req, socket, head);
}

/**
 * Wrap `server`'s upgrade listeners (Fastify's, registered by
 * @fastify/websocket) so the node link's path never reaches them. Returns
 * a function that puts them back.
 */
export function installNodeUpgrade(server: Server, s: ApiServices): () => void {
  const inner = server.listeners('upgrade') as ((req: IncomingMessage, socket: Duplex, head: Buffer) => void)[];
  const dispatch = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === NODE_LINK_PATH) {
      // Node drops its own error listener before 'upgrade': a reset must not throw.
      socket.on('error', () => socket.destroy());
      handleNodeUpgrade(s, req, socket, head);
      return;
    }
    for (const fn of inner) fn.call(server, req, socket, head);
  };
  server.removeAllListeners('upgrade');
  server.on('upgrade', dispatch);
  return () => {
    server.removeListener('upgrade', dispatch);
    for (const fn of inner) server.on('upgrade', fn);
  };
}
