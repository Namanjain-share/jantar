/**
 * The per-run MCP server Chat's run talks to (spec 0.10 B6.3, B6.5).
 *
 * The daemon listens on <runDir>/chat-<rid>.sock (0600, made under a 0077
 * umask, unlinked when the run ends). Claude Code starts assets/chat/
 * bridge.mjs as the run's one MCP server, which connects here and sends the
 * run's token as its first line. Exactly one connection is taken: its first
 * line must be `{"token":"<token>"}` (constant-time compare), else it is
 * closed and the turn fails `not_isolated`; any later connection is closed.
 *
 * Then it speaks MCP JSON-RPC (mcp/rpc.ts: initialize, ping, tools/list,
 * tools/call). initialize, ping and tools/list are answered at once; every
 * tools/call is held until the run's `system`/`init` line has been checked
 * (`release()`), or answered with an error when the run is aborted
 * (`abort()`, which also fails every later call), or when no init line came
 * within the hold time.
 *
 * A tool not in this turn's list is -32602 (and counts as refused). Nothing
 * here logs a line, an argument or a result.
 */
import { timingSafeEqual } from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import net from 'node:net';
import { MCP_LINE_MAX, createRpcServer, rpcError, rpcResult, type RpcId } from '../mcp/rpc.js';
import type { Clock, TimerId } from '../contracts.js';
import { listed, type ChatTool, type TurnTools } from './tools.js';

/** A call waits this long for the init line; then the run is aborted as not isolated. */
export const CHAT_HOLD_MS = 10_000;

export type DispatcherFailure = 'not_isolated';

export interface DispatcherOptions {
  path: string;
  token: string;
  tools: TurnTools;
  /** This turn's tools, as tools/list lists them. */
  list: readonly ChatTool[];
  clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>;
  version: string;
  holdMs?: number;
  /** The run must stop: a wrong token, or a call held past the hold time. */
  onFail(why: DispatcherFailure): void;
}

const tokenOk = (line: string, token: string): boolean => {
  let sent: unknown;
  try {
    sent = JSON.parse(line);
  } catch {
    return false;
  }
  const got = typeof sent === 'object' && sent !== null && typeof (sent as { token?: unknown }).token === 'string' ? (sent as { token: string }).token : '';
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

export class Dispatcher {
  private server: net.Server | null = null;
  private conn: net.Socket | null = null;
  private state: 'held' | 'released' | 'aborted' = 'held';
  private readonly waiting = new Set<(go: boolean) => void>();
  private holdTimer: TimerId | undefined;
  /** Connections refused (a second one, or one with a wrong token). */
  refusedConnections = 0;

  constructor(private readonly o: DispatcherOptions) {}

  /** Listen on the socket path (0600). */
  async listen(): Promise<void> {
    // A longer path would be cut short by the kernel and bind somewhere else.
    if (Buffer.byteLength(this.o.path) > 103) throw Object.assign(new Error('socket path too long'), { code: 'ENAMETOOLONG' });
    await rm(this.o.path, { force: true });
    const server = net.createServer((c) => this.accept(c));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // The socket is made under a 0077 umask, so it is 0600 from the start (the chmod below is a second belt).
      const prev = process.umask(0o077);
      try {
        server.listen(this.o.path, () => {
          server.off('error', reject);
          resolve();
        });
      } finally {
        process.umask(prev);
      }
    });
    await chmod(this.o.path, 0o600);
  }

  /** The init line passed: held calls run. */
  release(): void {
    if (this.state !== 'held') return;
    this.state = 'released';
    this.o.clock.clearTimeout(this.holdTimer);
    for (const w of [...this.waiting]) w(true);
    this.waiting.clear();
  }

  /** The run is stopped: every held call answers with an error, the connection closes. */
  abort(): void {
    if (this.state === 'aborted') return;
    this.state = 'aborted';
    this.o.clock.clearTimeout(this.holdTimer);
    for (const w of [...this.waiting]) w(false);
    this.waiting.clear();
    // The connection stays until close(): the held calls' errors still go out on it.
  }

  get released(): boolean {
    return this.state === 'released';
  }

  async close(): Promise<void> {
    this.abort();
    this.conn?.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(this.o.path, { force: true });
  }

  private accept(c: net.Socket): void {
    if (this.conn || this.state === 'aborted') {
      this.refusedConnections += 1;
      c.destroy();
      return;
    }
    this.conn = c;
    c.setEncoding('utf8');
    let rest = '';
    let authed = false;
    const rpc = createRpcServer({
      serverInfo: { name: 'jantar', title: 'Jantar', version: this.o.version },
      tools: () => this.o.list.map(listed),
      call: (id, params) => this.call(id, params),
    });
    const write = (out: string[]) => {
      for (const o of out) if (!c.destroyed) c.write(`${o}\n`);
    };
    c.on('data', (chunk: string) => {
      rest += chunk;
      if (rest.length > MCP_LINE_MAX + 16 && !rest.includes('\n')) {
        rest = '';
        if (!authed) return this.badToken(c);
        write([rpcError(null, -32600, 'Message too large (at most 1 MiB)')]);
        return;
      }
      let at = rest.indexOf('\n');
      while (at >= 0) {
        const line = rest.slice(0, at);
        rest = rest.slice(at + 1);
        at = rest.indexOf('\n');
        if (!authed) {
          if (!tokenOk(line, this.o.token)) return this.badToken(c);
          authed = true;
          continue;
        }
        void rpc.onLine(line).then(write, () => write([rpcError(null, -32603, 'Internal error')]));
      }
    });
    c.on('error', () => c.destroy());
  }

  private badToken(c: net.Socket): void {
    this.refusedConnections += 1;
    c.destroy();
    this.o.onFail('not_isolated');
  }

  private async call(id: RpcId, params: Record<string, unknown>): Promise<string> {
    const name = params.name;
    if (typeof name !== 'string' || !this.o.tools.has(name)) {
      this.o.tools.refuseUnknown();
      return rpcError(id, -32602, 'Not a tool of this turn.');
    }
    const args = params.arguments ?? {};
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return rpcError(id, -32602, 'arguments must be an object');
    if (!(await this.held())) return rpcError(id, -32000, 'Chat stopped this run.');
    const a = await this.o.tools.call(name, args as Record<string, unknown>);
    return rpcResult(id, { content: [{ type: 'text', text: a.text }], ...(a.isError ? { isError: true } : {}) });
  }

  /** True once the init line passed; false when the run was aborted first. */
  private held(): Promise<boolean> {
    if (this.state === 'released') return Promise.resolve(true);
    if (this.state === 'aborted') return Promise.resolve(false);
    if (this.holdTimer === undefined) {
      this.holdTimer = this.o.clock.setTimeout(() => {
        if (this.state !== 'held') return;
        this.o.onFail('not_isolated');
        this.abort();
      }, this.o.holdMs ?? CHAT_HOLD_MS);
    }
    return new Promise((resolve) => this.waiting.add(resolve));
  }
}
