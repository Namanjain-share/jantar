/**
 * The hooks socket: a Unix stream socket (0600 in a 0700 dir; never TCP).
 * v0.6: on Windows a named pipe instead (config.ts pipePath): no file, so no
 * dir, mode, stale file or unlink. The default pipe DACL gives the owner,
 * admins and SYSTEM full control and everyone else read only, so no other
 * user can send an event to the daemon's pipe. It does not stop another user
 * from creating a pipe of that name first (pipe names are machine-wide and
 * this one is the hash of a path), so on a pipe the daemon proves itself:
 * it writes a fresh random key to `keyFile` (<state dir>/run/hooks.key, in
 * the user's profile, which no other user can read), the client's first line
 * is `{"v":1,"hello":<nonce>}`, the daemon answers `{"v":1,"mac":<hookProof>}`
 * and only then does the client send the event or trust a reply. Not closed
 * by this: another user may hold read-only connections open (each takes a
 * slot until the first-line timeout), so the cards can be starved and fail
 * open; and a state dir outside the profile leaves the key as readable as
 * that folder.
 * One event per connection, written by the client as one JSON line.
 *
 * - Async events: the client writes and half-closes; the daemon never replies.
 * - Blocking events: the client writes and keeps its side open. The daemon
 *   answers with one line and closes. End-of-file from the client before that
 *   means the hook process is gone (Claude stopped it: the terminal answered).
 * - Lines over 2 MiB are dropped. A connection that sends no line within a
 *   few seconds is closed.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from '../contracts.js';
import { isPipePath, socketPathOk, writeFileAtomic } from '../config.js';

export const MAX_HOOK_LINE_BYTES = 2 * 1024 * 1024;

/** v0.6, Windows: the hooks key's file name in the run dir (<state dir>/run/hooks.key). */
export const HOOKS_KEY_FILE = 'hooks.key';

/**
 * v0.6, Windows: the daemon's answer to a client's nonce, the hex HMAC-SHA256
 * of `jantar-hooks-v1 <nonce>` under the key. The hook client
 * (packages/hook/bin/jantar-hook.mjs) repeats this line.
 */
export function hookProof(key: Buffer, nonce: string): string {
  return createHmac('sha256', key).update(`jantar-hooks-v1 ${nonce}`).digest('hex');
}

/** The reply line to a client's hello, or null when the line is no hello. */
function proofReply(key: Buffer, line: string): string | null {
  let hello: unknown;
  try {
    hello = JSON.parse(line);
  } catch {
    return null;
  }
  const h = hello as { v?: unknown; hello?: unknown } | null;
  if (!h || typeof h !== 'object' || h.v !== 1 || typeof h.hello !== 'string' || !/^[0-9a-f]{32,128}$/.test(h.hello)) return null;
  return `${JSON.stringify({ v: 1, mac: hookProof(key, h.hello) })}\n`;
}

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
  /**
   * v0.6, a pipe only: where this daemon writes its fresh hooks key once it
   * listens (<state dir>/run/hooks.key). Every connection must then open
   * with the client's hello, which the daemon answers with its proof (see
   * the header). Without it a pipe takes events as a socket does, and the
   * hook client, finding no key, sends none. A socket path ignores it.
   */
  keyFile?: string;
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
  const pipe = isPipePath(path);

  if (!pipe) {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await clearStale(path);
  }
  // A new key each start; written once the pipe is ours, so a refused second daemon leaves the first one's key alone.
  const key = pipe && opts.keyFile ? randomBytes(32) : null;

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

    // v0.6, a pipe with a key: the first line is the client's hello, answered before the event line.
    let proven = key === null;
    const prove = (hello: Buffer, rest: Buffer) => {
      const reply = key ? proofReply(key, hello.toString('utf8')) : null;
      if (!reply) {
        log.debug('hooks socket: no hello on the pipe, closing');
        socket.destroy();
        return;
      }
      proven = true;
      chunks = [];
      size = 0;
      socket.write(reply);
      if (rest.length > 0) onData(rest);
    };

    const onData = (c: Buffer) => {
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
      if (!proven) return prove(Buffer.concat(chunks), c.subarray(nl + 1));
      deliver(Buffer.concat(chunks));
    };
    socket.on('data', onData);

    socket.on('end', () => {
      // Lenient: an async client that half-closed without a trailing newline.
      if (!haveLine && size > 0 && proven) deliver(Buffer.concat(chunks));
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
    const onError = (e: NodeJS.ErrnoException) =>
      // A pipe has no stale file to probe: a second daemon on it fails here.
      reject(
        pipe && e.code === 'EADDRINUSE'
          ? new Error(`another process is already listening on ${path}: another jantard on this state dir, or a process (perhaps another user's) posing as one`)
          : e,
      );
    server.once('error', onError);
    server.listen(path, () => {
      server.off('error', onError);
      resolve();
    });
  });
  server.on('error', (e) => log.error('hooks socket error', { error: e.message }));
  if (key && opts.keyFile) {
    try {
      await mkdir(dirname(opts.keyFile), { recursive: true, mode: 0o700 });
      await writeFileAtomic(opts.keyFile, key.toString('hex'));
    } catch (e) {
      // The hook client then finds no key (or an old one) and sends nothing: Claude's own dialogs stay in charge.
      log.error('hooks socket: the hooks key was not written; no hook will reach the daemon', { error: String(e) });
    }
  }
  let ino = 0;
  if (!pipe) {
    await chmod(path, 0o600);
    ino = (await lstat(path)).ino;
  }

  return {
    path,
    connections: () => conns.size,
    async close() {
      for (const c of conns) c.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (pipe) return;
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
