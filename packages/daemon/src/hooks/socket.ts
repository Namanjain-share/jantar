/**
 * The hooks socket: a Unix stream socket (0600 in a 0700 dir; never TCP).
 * One event per connection, written by the client as one JSON line.
 *
 * - Async events: the client writes and half-closes; the daemon never replies.
 * - Blocking events: the client writes and keeps its side open. The daemon
 *   answers with one line and closes. End-of-file from the client before that
 *   means the hook process is gone (Claude stopped it: the terminal answered).
 * - Lines over 2 MiB are dropped. A connection that sends no line within a
 *   few seconds is closed.
 */
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from '../contracts.js';
import { socketPathOk } from '../config.js';

export const MAX_HOOK_LINE_BYTES = 2 * 1024 * 1024;

/** One client connection. */
export class HookConn {
  private readonly goneFns = new Set<() => void>();
  private aliveFlag = true;
  private replied = false;

  constructor(readonly socket: Socket) {}

  /** False once the client has closed its side, the socket errored, or we replied. */
  get alive(): boolean {
    return this.aliveFlag && !this.socket.destroyed;
  }

  /** Called once when the connection goes away (EOF, error, close). */
  onGone(fn: () => void): () => void {
    if (!this.aliveFlag) {
      fn();
      return () => {};
    }
    this.goneFns.add(fn);
    return () => {
      this.goneFns.delete(fn);
    };
  }

  /** Write one reply line and close. False when the client is already gone. */
  reply(line: string): boolean {
    if (this.replied || !this.alive || !this.socket.writable) return false;
    this.replied = true;
    try {
      this.socket.end(line);
      return true;
    } catch {
      return false;
    }
  }

  /** Close without a reply. */
  close(): void {
    this.replied = true;
    try {
      this.socket.end();
    } catch {
      // already closed
    }
  }

  destroy(): void {
    this.replied = true;
    this.socket.destroy();
  }

  /** @internal */
  markGone(): void {
    if (!this.aliveFlag) return;
    this.aliveFlag = false;
    const fns = [...this.goneFns];
    this.goneFns.clear();
    for (const fn of fns) {
      try {
        fn();
      } catch {
        // listeners log their own errors
      }
    }
  }
}

export interface HookSocketOptions {
  path: string;
  log: Logger;
  onLine(conn: HookConn, line: string): void;
  maxLineBytes?: number;
  /** Close a connection that has not sent a complete line within this time. Default 5000. */
  firstLineTimeoutMs?: number;
  /** Refuse connections beyond this many at once. Default 1024. */
  maxConnections?: number;
}

export interface HookSocketServer {
  readonly path: string;
  connections(): number;
  close(): Promise<void>;
}

/** Is something already accepting connections on `path`? */
function probe(path: string, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ path });
    const t = setTimeout(() => {
      s.destroy();
      resolve(false);
    }, timeoutMs);
    s.once('connect', () => {
      clearTimeout(t);
      s.destroy();
      resolve(true);
    });
    s.once('error', () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

/** Remove a stale socket file; refuse when it is live or not a socket. */
async function clearStale(path: string): Promise<void> {
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (!st.isSocket()) throw new Error(`refusing to replace ${path}: it exists and is not a socket`);
  if (await probe(path)) throw new Error(`another process is already listening on ${path}`);
  await unlink(path);
}

export async function listenHookSocket(opts: HookSocketOptions): Promise<HookSocketServer> {
  const { path, log } = opts;
  const maxLine = opts.maxLineBytes ?? MAX_HOOK_LINE_BYTES;
  const firstLineMs = opts.firstLineTimeoutMs ?? 5000;
  const maxConns = opts.maxConnections ?? 1024;
  if (!socketPathOk(path)) throw new Error(`hooks socket path is too long for macOS (max 103 bytes): ${path}`);

  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await clearStale(path);

  const conns = new Set<HookConn>();
  const server: Server = createServer({ allowHalfOpen: false }, (socket) => {
    if (conns.size >= maxConns) {
      log.warn('hooks socket: too many connections, refusing one');
      socket.destroy();
      return;
    }
    const conn = new HookConn(socket);
    conns.add(conn);
    let chunks: Buffer[] = [];
    let size = 0;
    let haveLine = false;
    let extra = 0;

    const deliver = (buf: Buffer) => {
      haveLine = true;
      socket.setTimeout(0);
      chunks = [];
      try {
        opts.onLine(conn, buf.toString('utf8'));
      } catch (e) {
        log.error('hooks socket: line handler threw', { error: String(e) });
        conn.destroy();
      }
    };

    socket.setTimeout(firstLineMs, () => {
      if (!haveLine) {
        log.debug('hooks socket: no event line in time, closing');
        socket.destroy();
      }
    });

    socket.on('data', (c: Buffer) => {
      if (haveLine) {
        // One event per connection; ignore anything after it, but keep reading
        // so end-of-file is noticed.
        extra += c.length;
        if (extra > maxLine) socket.destroy();
        return;
      }
      const nl = c.indexOf(0x0a);
      if (nl === -1) {
        size += c.length;
        if (size > maxLine) {
          log.warn('hooks socket: event over the size limit, dropped', { bytes: size });
          haveLine = true;
          chunks = [];
          socket.destroy();
          return;
        }
        chunks.push(c);
        return;
      }
      size += nl;
      if (size > maxLine) {
        log.warn('hooks socket: event over the size limit, dropped', { bytes: size });
        haveLine = true;
        chunks = [];
        socket.destroy();
        return;
      }
      chunks.push(c.subarray(0, nl));
      deliver(Buffer.concat(chunks));
    });

    socket.on('end', () => {
      // Lenient: an async client that half-closed without a trailing newline.
      if (!haveLine && size > 0) deliver(Buffer.concat(chunks));
      conn.markGone();
    });
    socket.on('error', (e) => {
      log.debug('hooks socket: connection error', { error: (e as Error).message });
      conn.markGone();
    });
    socket.on('close', () => {
      conns.delete(conn);
      conn.markGone();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    server.once('error', onError);
    server.listen(path, () => {
      server.off('error', onError);
      resolve();
    });
  });
  server.on('error', (e) => log.error('hooks socket error', { error: e.message }));
  await chmod(path, 0o600);
  const ino = (await lstat(path)).ino;

  return {
    path,
    connections: () => conns.size,
    async close() {
      for (const c of conns) c.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Remove the socket file, unless another daemon has replaced it since.
      try {
        const st = await lstat(path);
        if (st.isSocket() && st.ino === ino) await unlink(path);
      } catch {
        // already gone
      }
    },
  };
}
