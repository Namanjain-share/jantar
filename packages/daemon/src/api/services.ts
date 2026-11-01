/**
 * State shared by the TCP listener and the control socket: device auth,
 * pairing, Origin policy, rate limits, idempotency, audit, open WebSockets,
 * the pane lookup cache and the web app hash; v0.5's extension keys and
 * their limits; v0.5.3's folder-todo limit.
 */
import { DEFAULT_HOST, UPLOADS_IN_FLIGHT, V042_LIMITS, type Pane, type Session } from '@jantar/protocol';
import type { DaemonContext, Logger, PaneTarget, Parts, TerminalBackend, TimerId, UploadStore } from '../contracts.js';
import { DeviceAuth } from '../auth/devices.js';
import { ExtensionAuth } from '../auth/extensions.js';
import { OriginPolicy } from '../auth/origin.js';
import { PairingService } from '../auth/pairing.js';
import { SlidingWindowBudget, SlidingWindowLimiter } from '../auth/rate-limit.js';
import { Auditor } from './audit.js';
import { IdempotencyCache } from './idempotency.js';
import { computeWebHash, webIndexExists } from './static.js';
import type { DaemonMode } from '../modes.js';
import { UploadStore as FileUploadStore } from '../uploads/store.js';

/** v0.5.3 `panes`: daemon.ts's one PaneLookup, shared with the notification router (else the API builds its own). */
export type ApiDeps = Omit<Parts, 'api' | 'notifications'> & { panes?: PaneLookup };

/**
 * Audit rows one device may add per window for refused or failed writes and
 * for read-scope writes (push subscriptions). Past that its rows are dropped
 * (with one warning per window), so a paired device cannot flood the audit
 * log and push the real entries out.
 */
export const AUDIT_NOISE_PER_ACTOR = 30;
export const AUDIT_NOISE_WINDOW_MS = 10 * 60_000;

/**
 * v0.3 per-device limits (key them by `actorName(auth)`). The routes that
 * own them apply them; parts keep their own finer limits (per pane, per
 * account, in flight).
 */
export const V03_LIMITS = {
  /** Rewrite starts. */
  rewrite: { limit: 6, windowMs: 60_000 },
  /** File requests of any kind. */
  files: { limit: 300, windowMs: 5 * 60_000 },
  /** Bytes served by files/raw. */
  rawBytes: { limit: 200 * 1024 * 1024, windowMs: 10 * 60_000 },
  /**
   * Launch start attempts, refusals included (a held account's 409, no room).
   * Accepted starts are capped by the launcher (settings.launch.rate,
   * perTenMin 4 per device), so this only bounds tries.
   */
  launch: { limit: 12, windowMs: 10 * 60_000 },
  folderCreate: { limit: 10, windowMs: 60 * 60_000 },
  /**
   * Folder browser reads and start sheet previews: each scans a directory or
   * asks ccw's plan. Room for a sheet asked again on every pick and name.
   */
  folders: { limit: 120, windowMs: 60_000 },
  keys: { limit: 30, windowMs: 60_000 },
  screenshot: { limit: 10, windowMs: 60_000 },
  screenshotSelect: { limit: 2, windowMs: 60_000 },
} as const;

/** v0.4 per-device limits (key them by `actorName(auth)`). `launchHistory` shares V03_LIMITS.folders. */
export const V04_LIMITS = {
  /** Every Life write (a dose, a meal, an expense, ...). */
  lifeWrite: { limit: 240, windowMs: 60_000 },
  /** Ask Claude runs, a minute and a day. */
  estimate: { limit: 10, windowMs: 60_000 },
  estimateDay: { limit: 100, windowMs: 24 * 60 * 60_000 },
  /** Intel captures, from a device or the CLI. */
  intelCapture: { limit: 30, windowMs: 60_000 },
} as const;

/**
 * v0.5 limits per extension (key them by `actorName(auth)`). Phone writes on
 * Meetings share V04_LIMITS.lifeWrite (the pipeline counts them).
 */
export const V05_LIMITS = {
  /** Every request to an `extension` route (the gate counts it). */
  extRequest: { limit: 300, windowMs: 60_000 },
  /** Screenshot bytes, decoded, per extension per 24 hours (the screenshot route takes them). */
  extShotBytes: { limit: 1024 ** 3, windowMs: 24 * 60 * 60_000 },
} as const;

export type V05Limits = { [K in keyof typeof V05_LIMITS]: { limit: number; windowMs: number } };

/**
 * v0.5.3 limits (key them by `actorName(auth)`; every ctl.sock peer is the
 * one actor `cli`). Folder todos come from Claude sessions through `jantar
 * mcp`: a session in bypass mode approves its own MCP writes, and each timed
 * todo pings the phone. The pipeline's Life write limit applies on top.
 */
export const V053_LIMITS = {
  folderTodo: { limit: 20, windowMs: 60 * 60_000 },
} as const;

export interface ApiOptions {
  /** TCP port (default settings.remote.port). 0 picks a free port (tests). */
  port?: number;
  /** Bind address. Non-loopback addresses are refused unless remote.mode is "lan". */
  host?: string;
  /** Control socket path (default paths.ctlSock); false disables it. */
  ctlSocket?: string | false;
  /** Built web app (default paths.webDist); null disables static serving. */
  webDist?: string | null;
  /** Send the device cookie with `Secure` (default true; see SECURITY.md about Safari and http://127.0.0.1). */
  cookieSecure?: boolean;
  /** Pairing claims allowed per caller per minute (default 8). */
  claimsPerMinute?: number;
  /**
   * How the daemon runs (daemon.ts). With `readOnly`, the routes in
   * READ_ONLY_REFUSED answer 403 before their handler runs. Default: not
   * read-only, Terminal.app.
   */
  mode?: DaemonMode;
  /** v0.5 (tests only): lower the extension's request and screenshot-byte limits. */
  v05Limits?: Partial<V05Limits>;
  /** v0.4.2: where uploads go (tests pass a fake). Default: uploads/store.ts on paths.uploadsDir. */
  uploads?: UploadStore;
  /**
   * How long a read waits for the terminal to find a session's tab (default
   * PANE_LOOKUP_TIMEOUT_MS). Tests only: the end-to-end tests' osascript and
   * ps are node scripts, far slower to start than the real ones on a busy CI runner.
   */
  paneLookupTimeoutMs?: number;
}

/**
 * v0.4.2: uploads in flight per device (UPLOADS_IN_FLIGHT). Taken before a
 * body is read and released once per request (api/app.ts), so one phone
 * can't make the daemon hold many 20 MiB bodies at once.
 */
export class InFlight {
  private readonly counts = new Map<string, number>();

  constructor(private readonly max: number) {}

  /** Count one more for `key`, or false when it already has `max`. */
  take(key: string): boolean {
    const n = this.counts.get(key) ?? 0;
    if (n >= this.max) return false;
    this.counts.set(key, n + 1);
    return true;
  }

  release(key: string): void {
    const n = (this.counts.get(key) ?? 0) - 1;
    if (n > 0) this.counts.set(key, n);
    else this.counts.delete(key);
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}

/** Minimal WebSocket surface the event stream uses (the `ws` package's socket fits). */
export interface WsLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: 'message', fn: (data: unknown) => void): unknown;
  on(event: 'close' | 'pong', fn: () => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
}

export const WS_OPEN = 1;

/** Open event-stream sockets by device (so a revoke closes them at once). */
export class SocketRegistry {
  private readonly byDevice = new Map<string, Set<WsLike>>();
  private readonly all = new Set<WsLike>();

  add(socket: WsLike, deviceId: string | null): void {
    this.all.add(socket);
    if (!deviceId) return;
    let set = this.byDevice.get(deviceId);
    if (!set) this.byDevice.set(deviceId, (set = new Set()));
    set.add(socket);
  }

  remove(socket: WsLike, deviceId: string | null): void {
    this.all.delete(socket);
    if (!deviceId) return;
    const set = this.byDevice.get(deviceId);
    set?.delete(socket);
    if (set && set.size === 0) this.byDevice.delete(deviceId);
  }

  closeDevice(deviceId: string, code: number, reason: string): number {
    const set = this.byDevice.get(deviceId);
    if (!set) return 0;
    const n = set.size;
    for (const s of [...set]) s.close(code, reason);
    return n;
  }

  closeAll(code: number, reason: string): void {
    for (const s of [...this.all]) s.close(code, reason);
  }

  count(): number {
    return this.all.size;
  }
}

/** How long a read waits for Terminal to find a session's tab before it says Terminal did not answer in time. */
export const PANE_LOOKUP_TIMEOUT_MS = 4000;

/**
 * Finds a session's terminal pane, cached briefly per session: the
 * Terminal.app lookup runs osascript, which is too slow to repeat on every
 * request. One lookup runs per session at a time, and callers meanwhile wait
 * on it. A caller waits at most `timeoutMs` and then hears 'timeout'; the
 * lookup runs on, and its answer is cached whenever it comes, so a slow
 * Terminal is never remembered as "no tab".
 */
export class PaneLookup {
  private readonly cache = new Map<string, { pane: Pane | null; at: number }>();
  private readonly running = new Map<string, Promise<Pane | null>>();

  constructor(
    private readonly terminal: TerminalBackend,
    private readonly ctx: Pick<DaemonContext, 'clock' | 'log'>,
    private readonly ttlMs = 5000,
    private readonly timeoutMs = PANE_LOOKUP_TIMEOUT_MS,
  ) {}

  /** The session's pane, null when the terminal has no tab for it, or 'timeout' when it did not answer in time. */
  async find(session: Session): Promise<Pane | null | 'timeout'> {
    const hit = this.cache.get(session.sid);
    if (hit && this.ctx.clock.now() - hit.at < this.ttlMs) return hit.pane;
    const lookup = this.running.get(session.sid) ?? this.lookup(session);
    let timer: TimerId | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = this.ctx.clock.setTimeout(() => resolve('timeout'), this.timeoutMs);
    });
    try {
      return await Promise.race([lookup, timeout]);
    } finally {
      this.ctx.clock.clearTimeout(timer);
    }
  }

  forget(sid: string): void {
    this.cache.delete(sid);
  }

  /** Ask the terminal once; the answer is cached when it comes, even after every caller stopped waiting. */
  private lookup(session: Session): Promise<Pane | null> {
    const target: PaneTarget = { pid: session.pid, sid: session.sid };
    if (session.tty) target.tty = session.tty;
    const run = Promise.resolve()
      .then(() => this.terminal.findPane(target))
      .catch((e: unknown) => {
        this.ctx.log.warn('pane lookup failed', { sid: session.sid, error: String(e) });
        return null;
      })
      .then((pane) => {
        this.running.delete(session.sid);
        this.cache.set(session.sid, { pane, at: this.ctx.clock.now() });
        if (this.cache.size > 500) {
          const first = this.cache.keys().next().value;
          if (first !== undefined) this.cache.delete(first);
        }
        return pane;
      });
    this.running.set(session.sid, run);
    return run;
  }
}

export class ApiServices {
  readonly devices: DeviceAuth;
  /** v0.5: the paired Chrome extension's keys. */
  readonly extensions: ExtensionAuth;
  readonly pairing: PairingService;
  readonly origin: OriginPolicy;
  readonly claimLimiter: SlidingWindowLimiter;
  readonly claimDeviceLimiter: SlidingWindowLimiter;
  /** Caps audit rows for failed claims, so a flood cannot push real entries out. */
  readonly claimFailAudit: SlidingWindowLimiter;
  /** Caps a device's low-value audit rows (see AUDIT_NOISE_PER_ACTOR). */
  readonly auditNoise: SlidingWindowLimiter;
  private readonly auditNoiseWarned: SlidingWindowLimiter;
  readonly idem: IdempotencyCache;
  readonly auditor: Auditor;
  /** v0.3 limits per device (V03_LIMITS). */
  readonly rewriteLimiter: SlidingWindowLimiter;
  readonly filesLimiter: SlidingWindowLimiter;
  readonly rawBytesBudget: SlidingWindowBudget;
  readonly launchLimiter: SlidingWindowLimiter;
  readonly folderCreateLimiter: SlidingWindowLimiter;
  readonly foldersLimiter: SlidingWindowLimiter;
  readonly keysLimiter: SlidingWindowLimiter;
  readonly screenshotLimiter: SlidingWindowLimiter;
  readonly screenshotSelectLimiter: SlidingWindowLimiter;
  /** v0.4 limits per device (V04_LIMITS). */
  readonly lifeWriteLimiter: SlidingWindowLimiter;
  readonly estimateLimiter: SlidingWindowLimiter;
  readonly estimateDayBudget: SlidingWindowLimiter;
  readonly intelCaptureLimiter: SlidingWindowLimiter;
  /** v0.4.2 (V042_LIMITS): dialog answers and keypad sends together, per device. */
  readonly dialogLimiter: SlidingWindowLimiter;
  /** v0.4.2: upload bytes per device, taken by Content-Length before a body is read. */
  readonly uploadBytesBudget: SlidingWindowBudget;
  /** v0.4.2: uploads per device, counted before a body is read. */
  readonly uploadLimiter: SlidingWindowLimiter;
  /** v0.4.2: uploads in flight per device. */
  readonly uploadsInFlight = new InFlight(UPLOADS_IN_FLIGHT);
  /** v0.4.2: files from the phone (uploads/store.ts). */
  readonly uploads: UploadStore;
  /** v0.4.2: raw bodies read so far. A refused upload never gets here (the tests check). */
  rawBodiesRead = 0;
  /** v0.5 limits per extension (V05_LIMITS). */
  readonly extRequestLimiter: SlidingWindowLimiter;
  readonly extShotBytes: SlidingWindowBudget;
  /** v0.5.3 (V053_LIMITS): todos added by folder (folderTodoCreate). */
  readonly folderTodoLimiter: SlidingWindowLimiter;
  readonly sockets = new SocketRegistry();
  readonly panes: PaneLookup;
  readonly log: Logger;
  readonly webDist: string | null;
  readonly webHash: string | null;
  readonly webAvailable: boolean;
  readonly cookieSecure: boolean;
  readonly mode: DaemonMode;
  readonly startedAt: string;
  /** The TCP port actually bound (set by the server after listen). */
  boundPort: number;
  ctlSocketPath: string | null = null;

  constructor(
    readonly ctx: DaemonContext,
    readonly deps: ApiDeps,
    readonly opts: ApiOptions = {},
  ) {
    this.log = ctx.log.child({ part: 'api' });
    this.devices = new DeviceAuth({ db: ctx.db, clock: ctx.clock, log: this.log });
    this.extensions = new ExtensionAuth({ db: ctx.db, clock: ctx.clock, log: this.log });
    this.pairing = new PairingService({ clock: ctx.clock, devices: this.devices, extensions: this.extensions, log: this.log });
    this.boundPort = opts.port || ctx.settings.get().remote.port;
    this.origin = new OriginPolicy({ settings: () => ctx.settings.get(), port: () => this.boundPort });
    const perMinute = opts.claimsPerMinute ?? 8;
    this.claimLimiter = new SlidingWindowLimiter({ limit: perMinute, windowMs: 60_000, clock: ctx.clock });
    this.claimDeviceLimiter = new SlidingWindowLimiter({ limit: perMinute, windowMs: 60_000, clock: ctx.clock });
    this.claimFailAudit = new SlidingWindowLimiter({ limit: 30, windowMs: 10 * 60_000, clock: ctx.clock, maxKeys: 1 });
    this.auditNoise = new SlidingWindowLimiter({ limit: AUDIT_NOISE_PER_ACTOR, windowMs: AUDIT_NOISE_WINDOW_MS, clock: ctx.clock });
    this.auditNoiseWarned = new SlidingWindowLimiter({ limit: 1, windowMs: AUDIT_NOISE_WINDOW_MS, clock: ctx.clock });
    this.idem = new IdempotencyCache(ctx.clock);
    this.auditor = new Auditor(ctx.db, ctx.clock, this.log);
    const per = (l: { limit: number; windowMs: number }) => new SlidingWindowLimiter({ ...l, clock: ctx.clock });
    this.rewriteLimiter = per(V03_LIMITS.rewrite);
    this.filesLimiter = per(V03_LIMITS.files);
    this.rawBytesBudget = new SlidingWindowBudget({ ...V03_LIMITS.rawBytes, clock: ctx.clock });
    this.launchLimiter = per(V03_LIMITS.launch);
    this.folderCreateLimiter = per(V03_LIMITS.folderCreate);
    this.foldersLimiter = per(V03_LIMITS.folders);
    this.keysLimiter = per(V03_LIMITS.keys);
    this.screenshotLimiter = per(V03_LIMITS.screenshot);
    this.screenshotSelectLimiter = per(V03_LIMITS.screenshotSelect);
    this.lifeWriteLimiter = per(V04_LIMITS.lifeWrite);
    this.estimateLimiter = per(V04_LIMITS.estimate);
    this.estimateDayBudget = per(V04_LIMITS.estimateDay);
    this.intelCaptureLimiter = per(V04_LIMITS.intelCapture);
    this.dialogLimiter = per(V042_LIMITS.dialog);
    this.uploadBytesBudget = new SlidingWindowBudget({ ...V042_LIMITS.uploadBytes, clock: ctx.clock });
    this.uploadLimiter = per(V042_LIMITS.uploads);
    this.uploads = opts.uploads ?? new FileUploadStore(ctx);
    const v05 = { ...V05_LIMITS, ...opts.v05Limits };
    this.extRequestLimiter = per(v05.extRequest);
    this.extShotBytes = new SlidingWindowBudget({ ...v05.extShotBytes, clock: ctx.clock });
    this.folderTodoLimiter = per(V053_LIMITS.folderTodo);
    this.panes = deps.panes ?? new PaneLookup(deps.terminal, ctx, undefined, opts.paneLookupTimeoutMs);
    this.webDist = opts.webDist === undefined ? ctx.paths.webDist : opts.webDist;
    this.webAvailable = !!this.webDist && webIndexExists(this.webDist);
    this.webHash = this.webAvailable && this.webDist ? computeWebHash(this.webDist) : null;
    this.cookieSecure = opts.cookieSecure ?? true;
    this.mode = opts.mode ?? { readOnly: false, terminal: 'terminal-app' };
    this.startedAt = ctx.clock.iso();
  }

  /** True while `actor` may still add a low-value audit row in this window. */
  noiseAuditAllowed(actor: string): boolean {
    const r = this.auditNoise.hit(actor);
    if (r.ok) return true;
    if (this.auditNoiseWarned.hit(actor).ok) {
      this.log.warn('audit rows dropped for a noisy device', { actor, retryAfterMs: r.retryAfterMs });
    }
    return false;
  }

  /** Base of pairing links: remote.publicUrl when set, else the loopback URL. */
  publicBase(): string {
    const remote = this.ctx.settings.get().remote;
    if (remote.publicUrl) return remote.publicUrl.replace(/\/+$/, '');
    return `http://${DEFAULT_HOST}:${this.boundPort}`;
  }

  cookieOptions(): {
    httpOnly: true;
    secure: boolean;
    sameSite: 'strict';
    path: '/';
    maxAge: number;
  } {
    return { httpOnly: true, secure: this.cookieSecure, sameSite: 'strict', path: '/', maxAge: this.devices.cookieMaxAgeS() };
  }
}
