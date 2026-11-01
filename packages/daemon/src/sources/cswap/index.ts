/**
 * sources/cswap: account usage for display (read-only towards cswap).
 *
 * - Reads `sequence.json` and `cache/usage.json` (schema 2, identity-checked)
 *   whenever they change, and emits usage.updated / usage.threshold.
 * - Runs at most one `cswap list --json` poller, and only when
 *   settings.usage.poller allows it: "auto" (default) polls only while ccw's
 *   own bot is not running (that bot already polls and keeps the cache fresh),
 *   "on" always, "off" never. The child gets the daemon's env without
 *   CLAUDE_CONFIG_DIR / CLAUDE_SECURESTORAGE_CONFIG_DIR, which would make
 *   cswap treat a profile as the active login.
 * - Never reads `configs/` or `credentials/`, never touches tokens, the
 *   Keychain or the usage endpoint: cswap does all of that itself.
 */
import { EVENT, type Account, type AccountId } from '@jantar/protocol';
import type {
  CcwLegacySource,
  DaemonContext,
  Factories,
  TimerId,
  UsageSnapshot,
  UsageSource,
} from '../../contracts.js';
import { CSWAP_SCRUB_ENV, scrubEnv } from '../../core/exec.js';
import { SequenceReader } from '../lib/cswap-files.js';
import { fileSig, readJsonFile } from '../lib/fsx.js';
import { Serial } from '../lib/serial.js';
import { firstLine, isObj, str } from '../lib/values.js';
import { createDirsUsageSource } from './dirs.js';
import { createSingleUsageSource } from './single.js';
import { accountsFromCache, overlayCli, parseCliList, parseUsageCache, snapshotKey, type CliUsage } from './usage.js';

export interface CswapUsageOptions {
  /** How often the cache files are checked (default 5000 ms). */
  tickMs?: number;
  /** Re-read the cache at least this often even if unchanged, for reset rollovers (default 60 s). */
  rereadMs?: number;
  /** `cswap list --json` timeout (default 45 s). */
  cliTimeoutMs?: number;
  /** Minimum gap between two CLI runs, also for requestRefresh() (default 60 s). */
  minRefreshMs?: number;
  /** How long a CLI result is laid over the cache view (default: 2 × poll interval, at least 180 s). */
  cliTtlMs?: number;
}

type PollDecision = { ok: true } | { ok: false; reason: string };

export class CswapUsageSource implements UsageSource {
  private snap: UsageSnapshot | null = null;
  private publishedKey: string | null = null;
  private readonly pctSeen = new Map<string, number>();
  private readonly sequence: SequenceReader;
  private cacheSig: string | null = null;
  private lastReadAt = 0;
  private cli: { usage: CliUsage; at: number } | null = null;
  private lastRunAt: number | null = null;
  private running: Promise<void> | null = null;
  private refreshTimer: TimerId | undefined;
  private refreshAt: number | null = null;
  private tickTimer: TimerId | undefined;
  private botRunning: boolean | null = null;
  private ccwHold: AccountId[] | null = null;
  private started = false;
  private abort: AbortController | null = null;
  private readonly serial: Serial<void>;
  private readonly opts: Required<Omit<CswapUsageOptions, 'cliTtlMs'>> & { cliTtlMs?: number };

  constructor(
    private readonly ctx: DaemonContext,
    private readonly deps: { ccwLegacy: CcwLegacySource },
    opts: CswapUsageOptions = {},
  ) {
    this.opts = {
      tickMs: opts.tickMs ?? 5000,
      rereadMs: opts.rereadMs ?? 60_000,
      cliTimeoutMs: opts.cliTimeoutMs ?? 45_000,
      minRefreshMs: opts.minRefreshMs ?? 60_000,
      ...(opts.cliTtlMs !== undefined ? { cliTtlMs: opts.cliTtlMs } : {}),
    };
    this.sequence = new SequenceReader(ctx.paths.cswapSequence);
    this.serial = new Serial(() => this.tick());
  }

  // ---------------------------------------------------------------- Service

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.abort = new AbortController();
    await this.tickOnce();
    if (!this.started) return;
    this.tickTimer = this.ctx.clock.setInterval(() => {
      this.tickOnce().catch((e) => this.ctx.log.error('usage tick failed', { error: String(e) }));
    }, this.opts.tickMs);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.ctx.clock.clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    this.ctx.clock.clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.refreshAt = null;
    this.abort?.abort();
    await this.serial.idle();
    await this.running?.catch(() => undefined);
  }

  // ---------------------------------------------------------------- UsageSource

  async read(): Promise<UsageSnapshot | null> {
    const seq = await this.sequence.read();
    const now = this.ctx.clock.now();
    const held = this.heldSet();
    const cache = await readJsonFile(this.ctx.paths.cswapUsageCache);
    const rows = cache.ok ? parseUsageCache(cache.value) : null;
    let accounts: Account[] = seq ? accountsFromCache(seq, rows, now, held) : [];
    let active: AccountId | null = seq?.active ?? null;
    let source: UsageSnapshot['source'] = 'cache';
    const cli = this.cli && now - this.cli.at <= this.cliTtl() ? this.cli.usage : null;
    if (cli) {
      accounts = seq ? overlayCli(accounts, cli) : [...cli.accounts.values()].map((c) => c.account);
      active = cli.active ?? active;
      source = 'cli';
    }
    if (!seq && !cli) return null;
    for (const a of accounts) a.held = held.has(a.id);
    const fetched = accounts.map((a) => (a.fetchedAt ? Date.parse(a.fetchedAt) : NaN)).filter(Number.isFinite);
    return {
      accounts,
      activeAccount: active,
      fetchedAt: new Date(fetched.length ? Math.max(...fetched) : now).toISOString(),
      source,
    };
  }

  latest(): UsageSnapshot | null {
    return this.snap;
  }

  requestRefresh(reason: string): { queued: boolean; reason?: string; nextAllowedAt: string | null } {
    const now = this.ctx.clock.now();
    const allowed = this.pollDecision();
    if (!allowed.ok) {
      void this.tickOnce(true).catch(() => undefined); // the cache may still have news
      return { queued: false, reason: allowed.reason, nextAllowedAt: null };
    }
    this.ctx.log.debug('usage refresh requested', { reason });
    if (this.running) return { queued: true, reason: 'already running', nextAllowedAt: this.iso(this.nextAllowed(now)) };
    const next = this.nextAllowed(now);
    if (now >= next) {
      void this.runCli();
      return { queued: true, nextAllowedAt: this.iso(now + this.opts.minRefreshMs) };
    }
    if (this.refreshAt === null) {
      this.refreshAt = next;
      this.refreshTimer = this.ctx.clock.setTimeout(() => {
        this.refreshTimer = undefined;
        this.refreshAt = null;
        if (this.started && this.pollDecision().ok) void this.runCli();
      }, next - now);
    }
    return { queued: true, reason: 'debounced', nextAllowedAt: this.iso(this.refreshAt) };
  }

  isPolling(): boolean {
    return this.started && this.pollDecision().ok;
  }

  // ---------------------------------------------------------------- internals

  /** One tick: refresh ccw facts, publish cache changes, start a CLI poll when due. */
  tickOnce(force = false): Promise<void> {
    if (force) this.lastReadAt = 0;
    return this.serial.run();
  }

  private async tick(): Promise<void> {
    await this.refreshCcwFacts();
    const now = this.ctx.clock.now();
    const sigs = [await fileSig(this.ctx.paths.cswapSequence), await fileSig(this.ctx.paths.cswapUsageCache)]
      .map((s) => s?.sig ?? '-')
      .join('|');
    if (sigs !== this.cacheSig || now - this.lastReadAt >= this.opts.rereadMs || this.lastReadAt === 0) {
      this.cacheSig = sigs;
      this.lastReadAt = now;
      await this.publish(await this.read());
    }
    if (this.started && !this.running && this.pollDecision().ok) {
      const interval = this.ctx.settings.get().usage.interval_s * 1000;
      if (this.lastRunAt === null || now - this.lastRunAt >= interval) void this.runCli();
    }
  }

  private async refreshCcwFacts(): Promise<void> {
    try {
      const present = this.deps.ccwLegacy.present();
      this.botRunning = present ? await this.deps.ccwLegacy.botRunning() : false;
      const sw = present ? await this.deps.ccwLegacy.switchConfig() : null;
      this.ccwHold = sw ? sw.hold : null;
    } catch (e) {
      this.ctx.log.warn('could not read ccw state', { error: String(e) });
    }
  }

  /** ccw's hold list while ccw is around (it owns autoswitch then), else ours. */
  private heldSet(): Set<number> {
    return new Set(this.ccwHold ?? this.ctx.settings.get().autoswitch.hold);
  }

  private pollDecision(): PollDecision {
    if (!this.ctx.bins.cswap) return { ok: false, reason: 'cswap not found' };
    const mode = this.ctx.settings.get().usage.poller;
    if (mode === 'off') return { ok: false, reason: 'usage poller is off' };
    if (mode === 'auto') {
      if (this.botRunning === null) return { ok: false, reason: 'checking whether ccw is running' };
      if (this.botRunning) return { ok: false, reason: "ccw's bot keeps cswap's usage fresh" };
    }
    return { ok: true };
  }

  private nextAllowed(now: number): number {
    return this.lastRunAt === null ? now : this.lastRunAt + this.opts.minRefreshMs;
  }

  private cliTtl(): number {
    return this.opts.cliTtlMs ?? Math.max(180_000, 2 * this.ctx.settings.get().usage.interval_s * 1000);
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  /** The single poller: never two `cswap list` at once. */
  private runCli(): Promise<void> {
    if (this.running) return this.running;
    const cswap = this.ctx.bins.cswap;
    if (!cswap) return Promise.resolve();
    this.lastRunAt = this.ctx.clock.now();
    const run = (async () => {
      const opts: { env: Record<string, string | undefined>; timeoutMs: number; signal?: AbortSignal; maxBuffer: number } = {
        env: scrubEnv(this.ctx.env, CSWAP_SCRUB_ENV),
        timeoutMs: this.opts.cliTimeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      };
      if (this.abort) opts.signal = this.abort.signal;
      const res = await this.ctx.exec(cswap, ['list', '--json'], opts);
      this.lastRunAt = this.ctx.clock.now();
      if (!this.started) return;
      let json: unknown = null;
      try {
        json = JSON.parse(res.stdout);
      } catch {
        json = null;
      }
      const usage = res.code === 0 ? parseCliList(json, this.ctx.clock.now(), this.heldSet()) : null;
      if (!usage) {
        const err = isObj(json) && isObj(json.error) ? str(json.error.message) : undefined;
        this.ctx.log.warn('cswap list failed; keeping the last good reading', {
          code: res.code,
          timedOut: res.timedOut,
          spawnError: res.spawnError,
          error: firstLine(err ?? res.stderr).slice(0, 200),
        });
        return;
      }
      this.cli = { usage, at: this.ctx.clock.now() };
      await this.publish(await this.read());
    })().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private async publish(snap: UsageSnapshot | null): Promise<void> {
    if (!snap) return;
    const first = this.snap === null;
    this.snap = snap;
    const key = snapshotKey(snap.accounts, snap.activeAccount);
    if (key === this.publishedKey) return;
    this.publishedKey = key;
    try {
      this.ctx.store.emit({
        type: EVENT.USAGE_UPDATED,
        data: { accounts: snap.accounts, activeAccount: snap.activeAccount, fetchedAt: snap.fetchedAt, source: snap.source },
      });
    } catch (e) {
      this.ctx.log.error('could not publish usage', { error: String(e) });
    }
    this.checkThresholds(snap, first);
  }

  /** usage.threshold when a window crosses a threshold upwards between two readings (ccw check_usage). */
  private checkThresholds(snap: UsageSnapshot, first: boolean): void {
    const thresholds = [...this.ctx.settings.get().usage.thresholds].sort((a, b) => a - b);
    for (const a of snap.accounts) {
      for (const w of a.windows) {
        const k = `${a.id}|${w.kind}`;
        const before = this.pctSeen.get(k);
        this.pctSeen.set(k, w.pct);
        if (first || before === undefined) continue;
        const crossed = thresholds.filter((t) => before < t && t <= w.pct);
        const top = crossed.at(-1);
        if (top === undefined) continue;
        try {
          this.ctx.store.emit({
            type: EVENT.USAGE_THRESHOLD,
            account: a.id,
            data: { window: w.kind, pct: w.pct, threshold: top },
          });
        } catch (e) {
          this.ctx.log.error('could not publish usage threshold', { error: String(e) });
        }
      }
    }
  }
}

/**
 * Factories['usage']: cswap's accounts, or, on a Mac with one Claude login
 * (accountsMode "single", spec 4.11), the one account 0 and no cswap at all.
 * v0.6: on a node without cswap (accountsMode "dirs"), its config dirs.
 */
export const createUsageSource: Factories['usage'] = (ctx, deps) => {
  switch (ctx.accountsMode()) {
    case 'single':
      return createSingleUsageSource(ctx);
    case 'dirs':
      return createDirsUsageSource(ctx);
    case 'cswap':
      return new CswapUsageSource(ctx, deps);
  }
};

export function createCswapUsageSource(
  ctx: DaemonContext,
  deps: { ccwLegacy: CcwLegacySource },
  opts: CswapUsageOptions = {},
): CswapUsageSource {
  return new CswapUsageSource(ctx, deps, opts);
}

export * from './dirs.js';
export * from './single.js';
export * from './usage.js';
