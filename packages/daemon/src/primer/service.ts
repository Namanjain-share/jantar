/**
 * The primer (v0.4, docs/primer.md): when an account's 5-hour window has not
 * started, one tiny headless Claude run on it starts the clock now, so the
 * window resets sooner once the account is really used. Opt-in at the Mac
 * (settings accounts.prime, `jantar accounts prime on`), with cswap's
 * accounts only, and never while the legacy ccw tool primes them itself.
 *
 * It looks on every usage reading (usage.updated), on every settings change
 * and once a minute. A round primes the accounts due (rules.ts
 * whyNotPrime), one at a time and PRIME_GAP_MS apart, checking again before
 * each: a switch turned off, ccw taking over or an account held since stops
 * it. Each prime runs launch.preLaunchArgv's adopt first (as the shared
 * runner does), then `cswap run --share-history N -- -p ...` through
 * ctx.exec (argv only) in an empty 0700 folder, with the shared runner's
 * env. Exit 0 counts: the window has started; usage is refreshed.
 *
 * What it keeps, <home>/primer/primed.json (0600): when each account was
 * last primed (so a restart never primes one twice in 5 hours), when a
 * prime last failed (so a restart does not retry it inside PRIME_RETRY_MS)
 * and the last prime. No push: a log
 * line per prime, and `state.primer` (event primer.status) for the Accounts
 * screen's one line. The reply and cswap's error text are never logged.
 */
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Account, AccountId, PrimerStatus } from '@jantar/protocol';
import { writeFileAtomic } from '../config.js';
import type { CcwLegacySource, DaemonContext, Service, TimerId, Unsubscribe, UsageSource } from '../contracts.js';
import { Adopter } from '../rewrite/adopt.js';
import { readJsonFile } from '../sources/lib/fsx.js';
import {
  PRIME_GAP_MS,
  PRIME_MAX_BUFFER,
  PRIME_RETRY_MS,
  PRIME_TIMEOUT_MS,
  PRIME_WINDOW_MS,
  ccwPrimeConfig,
  primeArgv,
  primeEnv,
  whyNotPrime,
  type CcwPrime,
} from './rules.js';

export interface PrimerDeps {
  usage: UsageSource;
  ccwLegacy: CcwLegacySource;
}

export interface PrimerOptions {
  /** --read-only: never primes (a prime runs cswap). */
  readOnly?: boolean;
  /** How often it looks without a new reading (default one minute). */
  checkMs?: number;
  /** Between two primes (default PRIME_GAP_MS). */
  gapMs?: number;
}

const CHECK_MS = 60_000;

/** No ccw, or a ccw that neither primes nor holds anything. */
const NO_CCW: CcwPrime = { primes: false, hold: [] };

interface Plan {
  by: PrimerStatus['by'];
  /** The accounts due, lowest first (empty unless `by` is "jantar"). */
  due: AccountId[];
}

export class PrimerService implements Service {
  private current: PrimerStatus = { by: 'off', running: null, last: null };
  private readonly primed = new Map<AccountId, number>();
  private readonly failed = new Map<AccountId, number>();
  /** The last switch.json that parsed: a half-written one keeps it, as ccw does. */
  private ccwGood: CcwPrime | null = null;
  private round: Promise<void> | null = null;
  private timer: TimerId | undefined;
  private unsubs: Unsubscribe[] = [];
  private kill = new AbortController();
  private started = false;
  private readonly adopter: Adopter;
  private readonly checkMs: number;
  private readonly gapMs: number;

  constructor(
    private readonly ctx: DaemonContext,
    private readonly deps: PrimerDeps,
    private readonly opts: PrimerOptions = {},
  ) {
    this.adopter = new Adopter({ ...ctx, log: ctx.log.child({ part: 'primer' }) });
    this.checkMs = opts.checkMs ?? CHECK_MS;
    this.gapMs = opts.gapMs ?? PRIME_GAP_MS;
  }

  /** <home>/primer: primed.json and the empty work/ folder each run starts in. */
  get dir(): string {
    return join(this.ctx.paths.home, 'primer');
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.kill = new AbortController();
    await this.load();
    const plan = await this.plan().catch(() => null);
    this.setStatus({ by: plan?.by ?? 'off' }, true);
    this.unsubs.push(
      this.ctx.store.subscribe((ev) => {
        if (ev.type === 'usage.updated') void this.check();
      }),
      this.ctx.settings.subscribe(() => void this.check()),
    );
    this.timer = this.ctx.clock.setInterval(() => void this.check(), this.checkMs);
    void this.check();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.ctx.clock.clearInterval(this.timer);
    this.timer = undefined;
    for (const u of this.unsubs.splice(0)) u();
    this.kill.abort();
    this.adopter.stop();
    await this.round;
  }

  /** Who primes, the account being primed, and Jantar's last prime. */
  status(): PrimerStatus {
    return { ...this.current };
  }

  /**
   * Look now: prime every account due, one at a time. While a round runs it
   * answers that round (a round checks again before each prime).
   */
  check(): Promise<void> {
    if (!this.started) return Promise.resolve();
    this.round ??= this.runRound()
      .catch((e) => this.ctx.log.error('primer: a round failed', { error: String(e) }))
      .finally(() => {
        this.round = null;
      });
    return this.round;
  }

  // ---------------------------------------------------------------- a round

  private async runRound(): Promise<void> {
    let plan = await this.plan();
    if (!plan) return;
    this.setStatus({ by: plan.by });
    for (const [i, account] of plan.due.entries()) {
      if (i > 0) {
        try {
          await this.ctx.clock.sleep(this.gapMs, this.kill.signal);
        } catch {
          return; // stopping
        }
        // Turned off, ccw took over, held or primed since: the same rules again, on the newest reading.
        plan = await this.plan();
        if (!plan || !this.started) return;
        this.setStatus({ by: plan.by });
      }
      if (plan.by !== 'jantar') return;
      if (plan.due.includes(account)) await this.primeOne(account);
    }
  }

  /** Who primes, and the accounts due; null when ccw's switch.json cannot be read (its hold list is unknown). */
  private async plan(): Promise<Plan | null> {
    const s = this.ctx.settings.get();
    const ccw = await this.ccw();
    if (!ccw) return null;
    const jantar = s.accounts.prime && !this.opts.readOnly && this.ctx.accountsMode() === 'cswap' && this.ctx.bins.cswap !== null;
    const by: PrimerStatus['by'] = ccw.primes ? 'ccw' : jantar ? 'jantar' : 'off';
    if (by !== 'jantar') return { by, due: [] };
    const input = {
      nowMs: this.ctx.clock.now(),
      hold: new Set<AccountId>([...s.autoswitch.hold, ...ccw.hold]),
      kept: new Set<AccountId>(s.accounts.kept),
      primeKept: s.accounts.primeKept,
      weeklyCeiling: s.autoswitch.weekly_ceiling,
      primed: this.primed,
      failed: this.failed,
    };
    const due = this.accounts()
      .filter((a) => whyNotPrime(a, input) === null)
      .map((a) => a.id)
      .sort((a, b) => a - b);
    return { by, due };
  }

  private accounts(): Account[] {
    return this.deps.usage.latest()?.accounts ?? Object.values(this.ctx.store.getState().accounts);
  }

  /** ccw's switch.json while ccw is installed; the last good copy while it will not parse. */
  private async ccw(): Promise<CcwPrime | null> {
    if (!this.deps.ccwLegacy.present()) {
      this.ccwGood = null;
      return NO_CCW;
    }
    const r = await readJsonFile(this.ctx.paths.ccwSwitchJson);
    if (r.ok) {
      const cfg = ccwPrimeConfig(r.value);
      if (cfg) this.ccwGood = cfg;
      return this.ccwGood;
    }
    if (r.reason === 'missing') {
      this.ccwGood = null;
      return NO_CCW;
    }
    return this.ccwGood;
  }

  // ---------------------------------------------------------------- one prime

  private async primeOne(account: AccountId): Promise<void> {
    this.setStatus({ running: account });
    const why = await this.run(account).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    if (why === 'stopped') {
      this.setStatus({ running: null });
      return;
    }
    const at = this.ctx.clock.now();
    if (why === null) {
      this.primed.set(account, at);
      this.ctx.log.info('primer: primed an account; its 5-hour window starts now', { account, resetsAbout: this.ctx.clock.iso(at + PRIME_WINDOW_MS) });
      this.deps.usage.requestRefresh('primer');
    } else {
      this.failed.set(account, at);
      this.ctx.log.warn('primer: prime failed; that account is tried again in 30 min', { account, why });
    }
    this.setStatus({ running: null, last: { account, at: this.ctx.clock.iso(at), ok: why === null } });
    await this.save();
  }

  /** null when the window started; else why not, in fixed words ("stopped" when the daemon stops). */
  private async run(account: AccountId): Promise<string | null> {
    const signal = this.kill.signal;
    const cswap = this.ctx.bins.cswap;
    if (!cswap) return 'no cswap';
    if (!(await this.adopter.adopt(account, signal))) return signal.aborted ? 'stopped' : 'adopt failed';
    const cwd = join(this.dir, 'work');
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    await chmod(cwd, 0o700);
    const res = await this.ctx.exec(cswap, primeArgv(account), {
      cwd,
      env: primeEnv(this.ctx.env, this.ctx.bins.claude),
      timeoutMs: PRIME_TIMEOUT_MS,
      maxBuffer: PRIME_MAX_BUFFER,
      signal,
    });
    if (signal.aborted) return 'stopped';
    if (res.spawnError) return 'cswap could not start';
    if (res.timedOut) return 'no reply within 2 min';
    if (res.code !== 0) return res.code === null ? `killed (${res.signal ?? 'signal'})` : `exited ${res.code}`;
    return null;
  }

  // ---------------------------------------------------------------- status and primed.json

  private setStatus(patch: Partial<PrimerStatus>, force = false): void {
    const next = { ...this.current, ...patch };
    if (!force && JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    try {
      this.ctx.store.emit({ type: 'primer.status', data: { status: { ...next } } });
    } catch (e) {
      this.ctx.log.error('primer: could not publish its status', { error: String(e) });
    }
  }

  private get file(): string {
    return join(this.dir, 'primed.json');
  }

  /** primed.json: `{ primed: { "<account>": <epoch ms> }, failed: { ... }, last: { account, at, ok } | null }`. Anything else is ignored. */
  private async load(): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      return; // none yet, or unreadable: nothing primed
    }
    if (!isObj(raw)) return;
    for (const [field, into] of [
      [raw.primed, this.primed],
      [raw.failed, this.failed],
    ] as const) {
      if (!isObj(field)) continue;
      for (const [k, t] of Object.entries(field)) {
        const id = Number(k);
        if (Number.isInteger(id) && id >= 0 && typeof t === 'number' && Number.isFinite(t)) into.set(id, t);
      }
    }
    const last = raw.last;
    if (isObj(last) && Number.isInteger(last.account) && (last.account as number) >= 0 && typeof last.at === 'string' && Number.isFinite(Date.parse(last.at)) && typeof last.ok === 'boolean') {
      this.current = { ...this.current, last: { account: last.account as number, at: last.at, ok: last.ok } };
    }
  }

  /** Write primed.json (0600 in a 0700 folder), leaving out primes older than PRIME_WINDOW_MS and failures older than PRIME_RETRY_MS. */
  private async save(): Promise<void> {
    const nowMs = this.ctx.clock.now();
    const primed: Record<string, number> = {};
    for (const [id, t] of this.primed) if (nowMs - t < PRIME_WINDOW_MS) primed[String(id)] = t;
    const failed: Record<string, number> = {};
    for (const [id, t] of this.failed) if (nowMs - t < PRIME_RETRY_MS) failed[String(id)] = t;
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.file, `${JSON.stringify({ primed, failed, last: this.current.last })}\n`);
    } catch (e) {
      this.ctx.log.warn('primer: could not save primed.json', { error: String(e) });
    }
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
