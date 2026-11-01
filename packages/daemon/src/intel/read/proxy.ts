/**
 * The CONNECT proxy (spec 13.2) for the headless browser and yt-dlp, so
 * their subresources, redirects, WebSockets and own connections pass the
 * same guard as the daemon's fetches, and DNS is resolved by the daemon.
 *
 * - Listens on 127.0.0.1:0, only while a job needs it (pipeline.ts starts
 *   it and closes it at the job's end).
 * - Accepts only `CONNECT <host>:443`: no plain-HTTP forwarding (a GET with
 *   an absolute URI is refused), no other port, no IP literal or internal
 *   name; the host goes through the guard's rules 2-3 and the tunnel opens
 *   to the vetted address.
 * - Counts the bytes through it both ways; past the job's cap (200 MB) every
 *   tunnel closes. `close()` (the job's end or deadline) closes them all.
 *
 * Nothing is logged but counts: no host, no path.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { GuardNet, VetResult } from './guard.js';

export interface ProxyOptions {
  /** The guard's rules 2-3 for a host. */
  vet(host: string): Promise<VetResult>;
  /** Bytes through the proxy, both ways, for the job. */
  maxBytes: number;
  /** Tests only: where a vetted address is dialed. */
  net?: GuardNet;
}

/** A CONNECT target: `host:443` only, the host a name. */
export function connectTarget(target: string | undefined): string | null {
  if (typeof target !== 'string' || target.length > 300) return null;
  const m = /^([A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(target);
  if (!m || m[2] !== '443') return null;
  const host = m[1] as string;
  return isIP(host) === 0 ? host : null;
}

export class ConnectProxy {
  /** Bytes through every tunnel so far. */
  bytes = 0;
  /** Tunnels refused (a count for the log). */
  refused = 0;
  private readonly sockets = new Set<Duplex | Socket>();
  private closed = false;

  private constructor(
    private readonly server: Server,
    readonly port: number,
    private readonly opts: ProxyOptions,
  ) {}

  static async start(opts: ProxyOptions): Promise<ConnectProxy> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const proxy = new ConnectProxy(server, port, opts);
    server.on('request', (req: IncomingMessage, res: ServerResponse) => proxy.plain(req, res));
    server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => void proxy.tunnel(req, client, head));
    server.on('upgrade', (_req: IncomingMessage, client: Duplex) => {
      proxy.refused += 1;
      client.destroy();
    });
    server.on('clientError', (_e, socket) => socket.destroy());
    return proxy;
  }

  /** Close every tunnel and stop listening. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** A plain request (GET http://..., or anything else): never forwarded. */
  private plain(_req: IncomingMessage, res: ServerResponse): void {
    this.refused += 1;
    res.writeHead(403, { connection: 'close', 'content-type': 'text/plain' });
    res.end('Only CONNECT to port 443.\n');
  }

  private refuse(client: Duplex, status: number): void {
    this.refused += 1;
    if (!client.destroyed) client.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nconnection: close\r\n\r\n`);
  }

  private async tunnel(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
    client.on('error', () => client.destroy());
    const host = connectTarget(req.url);
    if (this.closed || !host || this.bytes >= this.opts.maxBytes) return this.refuse(client, 403);
    const vet = await this.opts.vet(host);
    if (this.closed || client.destroyed) return void client.destroy();
    if (!vet.ok) return this.refuse(client, 403);
    const dial = this.opts.net?.dial?.(vet.vetted.address, 443) ?? { address: vet.vetted.address, port: 443 };
    const upstream = connect({ host: dial.address, port: dial.port, family: isIP(dial.address) === 6 ? 6 : 4 });
    this.sockets.add(upstream);
    upstream.on('close', () => {
      this.sockets.delete(upstream);
      client.destroy();
    });
    client.on('close', () => upstream.destroy());
    upstream.on('error', () => this.refuse(client, 502));
    const count = (n: number) => {
      this.bytes += n;
      if (this.bytes > this.opts.maxBytes) {
        upstream.destroy();
        client.destroy();
      }
    };
    upstream.once('connect', () => {
      if (client.destroyed) return void upstream.destroy();
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) {
        count(head.length);
        upstream.write(head);
      }
      upstream.on('data', (c: Buffer) => count(c.length));
      client.on('data', (c: Buffer) => count(c.length));
      upstream.pipe(client);
      client.pipe(upstream);
    });
  }
}
