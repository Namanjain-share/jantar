/**
 * The API server: the TCP listener (loopback unless remote.mode is "lan")
 * and the CLI's control socket, sharing one ApiServices. v0.4.2: it also
 * sweeps old uploads (ApiServices.uploads) at start and every
 * UPLOAD_SWEEP_EVERY_MS while it runs.
 */
import { chmod, lstat, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { DEFAULT_HOST, settingsFeatures, type Features } from '@jantar/protocol';
import type { FastifyInstance } from 'fastify';
import type { ApiServer, DaemonContext, TimerId, Unsubscribe } from '../contracts.js';
import { socketPathOk } from '../config.js';
import { buildApp } from './app.js';
import { CLOSE_SHUTDOWN } from './events-ws.js';
import { ApiServices, type ApiDeps, type ApiOptions } from './services.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** v0.4.2: how often old uploads are swept while the daemon runs (they are kept UPLOAD_KEEP_MS). */
export const UPLOAD_SWEEP_EVERY_MS = 6 * 60 * 60_000;

/** The address to bind: loopback unless remote.mode is "lan" (development only). */
export function bindHost(ctx: Pick<DaemonContext, 'settings' | 'log'>, requested?: string): string {
  const remote = ctx.settings.get().remote;
  const host = requested ?? remote.host ?? DEFAULT_HOST;
  if (LOOPBACK_HOSTS.has(host)) return host;
  if (remote.mode === 'lan') {
    ctx.log.warn('binding beyond loopback over plain http (remote.mode = "lan", development only)', { host });
    return host;
  }
  ctx.log.warn('refusing a non-loopback bind address; using 127.0.0.1 (use Tailscale Serve for remote access)', { host });
  return DEFAULT_HOST;
}

/** Is something already answering on this Unix socket? */
function socketInUse(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = connect({ path });
    const done = (v: boolean) => {
      c.removeAllListeners();
      c.destroy();
      resolve(v);
    };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
    c.setTimeout(1000, () => done(false));
  });
}

/** Remove a stale socket file left by a crash. Refuses to touch anything that is not a socket. */
async function clearStaleSocket(path: string): Promise<void> {
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (!st.isSocket()) throw new Error(`${path} exists and is not a socket; not touching it`);
  if (await socketInUse(path)) throw new Error(`another jantard is already listening on ${path}`);
  await unlink(path);
}

export class ApiServerImpl implements ApiServer {
  readonly services: ApiServices;
  private tcp: FastifyInstance | null = null;
  private ctl: FastifyInstance | null = null;
  private addr: { host: string; port: number } | null = null;
  private unsubSettings: Unsubscribe | null = null;
  private sweepTimer: TimerId | undefined;

  constructor(
    private readonly ctx: DaemonContext,
    deps: ApiDeps,
    private readonly opts: ApiOptions = {},
  ) {
    this.services = new ApiServices(ctx, deps, opts);
  }

  address(): { host: string; port: number } | null {
    return this.addr;
  }

  /** The TCP app (tests use `inject`). */
  tcpApp(): FastifyInstance | null {
    return this.tcp;
  }

  async start(): Promise<void> {
    if (this.tcp) return;
    const s = this.services;
    const log = s.log;
    this.emitVersion();
    await this.sweepUploads();
    this.sweepTimer ??= this.ctx.clock.setInterval(() => void this.sweepUploads(), UPLOAD_SWEEP_EVERY_MS);
    // Feature switches ride on daemon.version: re-send it when one changes.
    this.unsubSettings ??= this.ctx.settings.subscribe(() => this.emitVersion());

    const tcp = await buildApp(s, 'tcp');
    const host = bindHost(this.ctx, this.opts.host);
    const port = this.opts.port ?? this.ctx.settings.get().remote.port;
    try {
      await tcp.listen({ host, port, listenTextResolver: () => '' });
    } catch (e) {
      await tcp.close();
      throw e;
    }
    this.tcp = tcp;
    const a = tcp.server.address();
    if (a && typeof a === 'object') {
      this.addr = { host: a.address, port: a.port };
      s.boundPort = a.port;
    }
    log.info('api listening', { host: this.addr?.host, port: this.addr?.port, web: s.webAvailable });

    const sock = this.opts.ctlSocket === undefined ? this.ctx.paths.ctlSock : this.opts.ctlSocket;
    if (sock) {
      if (!socketPathOk(sock)) {
        log.error('control socket path is too long for macOS (104 bytes); the CLI will not reach the daemon', { path: sock });
      } else {
        try {
          await clearStaleSocket(sock);
          const ctl = await buildApp(s, 'ctl', { address: () => this.addr });
          await ctl.listen({ path: sock, listenTextResolver: () => '' });
          await chmod(sock, 0o600);
          this.ctl = ctl;
          s.ctlSocketPath = sock;
          log.info('control socket listening', { path: sock });
        } catch (e) {
          await this.stop();
          throw e;
        }
      }
    }
  }

  async stop(): Promise<void> {
    const s = this.services;
    this.unsubSettings?.();
    this.unsubSettings = null;
    this.ctx.clock.clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    s.sockets.closeAll(CLOSE_SHUTDOWN, 'daemon stopping');
    const ctl = this.ctl;
    const tcp = this.tcp;
    this.ctl = null;
    this.tcp = null;
    this.addr = null;
    if (ctl) {
      await ctl.close().catch((e: unknown) => s.log.warn('control socket close failed', { error: String(e) }));
      if (s.ctlSocketPath) {
        await unlink(s.ctlSocketPath).catch(() => undefined);
        s.ctlSocketPath = null;
      }
    }
    if (tcp) await tcp.close().catch((e: unknown) => s.log.warn('api close failed', { error: String(e) }));
  }

  /** Delete old uploads; never fails the caller. Logs a count only. */
  private async sweepUploads(): Promise<void> {
    try {
      const removed = await this.services.uploads.sweep();
      if (removed > 0) this.services.log.info('old uploads removed', { count: removed });
    } catch (e) {
      // The code only: a message can name a file.
      this.services.log.warn('upload sweep failed', { code: (e as NodeJS.ErrnoException | null)?.code ?? 'error' });
    }
  }

  /** daemon.version: lets clients see the protocol, the web app hash, the feature switches and the accounts mode in state. */
  private emitVersion(): void {
    const { ctx } = this;
    const cur = ctx.store.getState().daemon;
    const features = settingsFeatures(ctx.settings.get());
    const accountsMode = ctx.accountsMode();
    const next = { protocol: ctx.version.protocol, daemonVersion: ctx.version.daemon, webHash: this.services.webHash, features, accountsMode };
    if (
      cur &&
      cur.protocol === next.protocol &&
      cur.daemonVersion === next.daemonVersion &&
      cur.webHash === next.webHash &&
      cur.accountsMode === accountsMode &&
      sameFeatures(cur.features, features)
    ) {
      return;
    }
    try {
      ctx.store.emit({ type: 'daemon.version', data: next });
    } catch (e) {
      this.services.log.warn('cannot emit daemon.version', { error: String(e) });
    }
  }
}

function sameFeatures(a: Features | undefined, b: Features): boolean {
  return !!a && (Object.keys(b) as (keyof Features)[]).every((k) => a[k] === b[k]);
}
