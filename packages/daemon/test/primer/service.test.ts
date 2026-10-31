/**
 * The primer service (docs/primer.md) on a temp state dir, a fake clock and
 * a fake cswap (createFakeExec: nothing real runs): off until the Mac turns
 * it on; cswap mode only; which accounts it primes; one at a time, a few
 * seconds apart; once per 5 hours per account across a restart; 30 minutes
 * after a failure; ccw priming itself; adopt first; stop mid-run; the
 * status in state.primer, the log lines, and no push. Synthetic accounts.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsSchema, type Account, type AccountsMode, type PrimerStatus } from '@jantar/protocol';
import type { CcwLegacySource, ExecResult, UsageSnapshot, UsageSource } from '../../src/contracts.js';
import { createFakeExec, createTestContext, type ExecCall, type TestContext } from '../../src/core/testing.js';
import { PRIME_RETRY_MS, PRIME_WINDOW_MS, PrimerService, createPrimer, type PrimerOptions } from '../../src/primer/index.js';

const HOUR = 3_600_000;
const GAP = 5_000;

class Usage implements UsageSource {
  snap: UsageSnapshot | null = null;
  refreshes: string[] = [];
  async start() {}
  async stop() {}
  async read() {
    return this.snap;
  }
  latest() {
    return this.snap;
  }
  requestRefresh(reason: string) {
    this.refreshes.push(reason);
    return { queued: true, nextAllowedAt: null };
  }
  isPolling() {
    return false;
  }
}

/** Only present() is read: the primer reads ccw's switch.json itself (for "prime"). */
class Ccw {
  isPresent = false;
  present() {
    return this.isPresent;
  }
}

type Answer = Partial<ExecResult> | Promise<Partial<ExecResult>>;

interface Rig {
  ctx: TestContext;
  exec: ReturnType<typeof createFakeExec>;
  usage: Usage;
  ccw: Ccw;
  primer: PrimerService;
  userHome: string;
  /** `cswap run ...` calls. */
  runs(): ExecCall[];
  setAccounts(accounts: Account[]): void;
  setSettings(patch: Record<string, unknown>): Promise<void>;
  writeSwitch(json: unknown): void;
  status(): PrimerStatus | undefined;
  restart(opts?: PrimerOptions): Promise<void>;
}

const rigs: Rig[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const r of rigs.splice(0)) await r.primer.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh reading: usage ok, fetched a minute ago, the 5-hour window `five` (null: none started). */
function account(ctx: TestContext, id: number, five: { pct: number; resetsInMs: number } | null = null, over: Partial<Account> = {}): Account {
  const now = ctx.clock.now();
  return {
    id,
    emailMasked: `a${id}***@example.com`,
    isDefaultLogin: false,
    disabled: false,
    held: false,
    usageStatus: 'ok',
    fetchedAt: new Date(now - 60_000).toISOString(),
    windows: [
      five ? { kind: 'five_hour', pct: five.pct, resetsAt: new Date(now + five.resetsInMs).toISOString() } : { kind: 'five_hour', pct: 0 },
      { kind: 'seven_day', pct: 20 },
    ],
    ...over,
  };
}

async function makeRig(
  opts: {
    settings?: Record<string, unknown>;
    answer?: (call: ExecCall) => Answer;
    other?: (call: ExecCall) => Answer | undefined;
    mode?: AccountsMode;
    primer?: PrimerOptions;
    userHome?: string;
    env?: Record<string, string | undefined>;
    accounts?: (ctx: TestContext) => Account[];
  } = {},
): Promise<Rig> {
  const userHome = opts.userHome ?? mkdtempSync(join(tmpdir(), 'jantar-primer-'));
  if (!opts.userHome) dirs.push(userHome);
  const exec = createFakeExec((call) => {
    if (call.file === '/fake/bin/cswap' && call.args[0] === 'run') return (opts.answer ?? (() => ({ stdout: 'ok\n' })))(call);
    return opts.other?.(call);
  });
  const settings = SettingsSchema.parse(opts.settings ?? { accounts: { prime: true } });
  const ctx = createTestContext({
    userHome,
    home: join(userHome, '.jantar'),
    exec,
    settings,
    accountsMode: opts.mode ?? 'cswap',
    env: opts.env ?? { HOME: userHome, PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' },
  });
  const usage = new Usage();
  const ccw = new Ccw();
  const setAccounts = (accounts: Account[]) => {
    usage.snap = { accounts, activeAccount: null, fetchedAt: ctx.clock.iso(), source: 'cache' };
    ctx.store.emit({ type: 'usage.updated', data: { accounts, activeAccount: null, fetchedAt: ctx.clock.iso(), source: 'cache' } });
  };
  setAccounts(opts.accounts?.(ctx) ?? []);
  const build = (o?: PrimerOptions) => createPrimer(ctx, { usage, ccwLegacy: ccw as unknown as CcwLegacySource }, { gapMs: GAP, ...opts.primer, ...o });
  const rig: Rig = {
    ctx,
    exec,
    usage,
    ccw,
    primer: build(),
    userHome,
    runs: () => exec.calls.filter((c) => c.file === '/fake/bin/cswap'),
    setAccounts,
    async setSettings(patch) {
      const r = await ctx.settings.patch(patch);
      if (!r.ok) throw new Error(r.error);
    },
    writeSwitch(json) {
      mkdirSync(ctx.paths.ccwDir, { recursive: true });
      writeFileSync(ctx.paths.ccwSwitchJson, typeof json === 'string' ? json : JSON.stringify(json));
      ccw.isPresent = true;
    },
    status: () => ctx.store.getState().primer,
    async restart(o) {
      await rig.primer.stop();
      rig.primer = build(o);
      await rig.primer.start();
      await rig.primer.check();
    },
  };
  rigs.push(rig);
  return rig;
}

/** Let real I/O (primed.json, the work folder) and promise callbacks run until `cond` holds. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Wait until the round sleeps between two primes (the minute timer is the other pending one), then pass the gap. */
async function gap(rig: Rig): Promise<void> {
  await until(() => rig.ctx.clock.pending() >= 2, 'the gap between two primes');
  await rig.ctx.clock.tick(GAP);
}

/** Every event type emitted so far. */
function eventTypes(rig: Rig): string[] {
  const r = rig.ctx.store.replay(0);
  return r.kind === 'events' ? r.events.map((e) => e.type) : [];
}

/** Start, and wait for the first round to end. */
async function started(rig: Rig): Promise<void> {
  await rig.primer.start();
  await rig.primer.check();
}

const primedFile = (rig: Rig) => join(rig.ctx.paths.home, 'primer', 'primed.json');

describe('the switch', () => {
  it('is off by default: nothing runs, and the state says nobody primes', async () => {
    const rig = await makeRig({ settings: {}, accounts: (ctx) => [account(ctx, 4)] });
    await started(rig);
    expect(rig.runs()).toEqual([]);
    expect(rig.status()).toEqual({ by: 'off', running: null, last: null });
  });

  it('turned on at the Mac, it primes at once (settings change)', async () => {
    const rig = await makeRig({ settings: {}, accounts: (ctx) => [account(ctx, 4)] });
    await started(rig);
    await rig.setSettings({ accounts: { prime: true } });
    await rig.primer.check();
    expect(rig.runs().map((c) => c.args[2])).toEqual(['4']);
    expect(rig.status()).toMatchObject({ by: 'jantar', running: null, last: { account: 4, ok: true } });
  });

  it('never with one Claude login', async () => {
    const rig = await makeRig({ mode: 'single', accounts: (ctx) => [account(ctx, 0)] });
    await started(rig);
    expect(rig.exec.calls).toEqual([]);
    expect(rig.status()?.by).toBe('off');
  });

  it('never under --read-only (a prime runs cswap)', async () => {
    const rig = await makeRig({ primer: { readOnly: true }, accounts: (ctx) => [account(ctx, 4)] });
    await started(rig);
    expect(rig.exec.calls).toEqual([]);
    expect(rig.status()?.by).toBe('off');
  });
});

describe('a prime', () => {
  it('runs `cswap run --share-history N -- -p ...` in an empty 0700 folder, with the shared runner env', async () => {
    const rig = await makeRig({
      env: { HOME: '/synthetic/home', PATH: '/usr/bin:/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'synthetic', CLAUDE_CONFIG_DIR: '/synthetic/cfg', ANTHROPIC_API_KEY: 'synthetic-key' },
      accounts: (ctx) => [account(ctx, 4)],
    });
    await started(rig);
    const [call] = rig.runs();
    expect(call?.file).toBe('/fake/bin/cswap');
    expect(call?.args).toEqual(['run', '--share-history', '4', '--', '-p', 'Reply with only: ok', '--model', 'haiku', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--setting-sources', 'local', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--max-turns', '1']);
    const work = join(rig.ctx.paths.home, 'primer', 'work');
    expect(call?.opts.cwd).toBe(work);
    expect(statSync(work).mode & 0o777).toBe(0o700);
    expect(readdirSync(work)).toEqual([]);
    expect(call?.opts.input).toBeUndefined();
    const env = call?.opts.env ?? {};
    expect(env.PATH).toBe('/fake/bin:/usr/bin:/bin');
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY']) expect(env, k).not.toHaveProperty(k);
    expect(env.JANTAR_SKIP_HOOKS).toBe('1');
    expect(call?.opts.timeoutMs).toBe(120_000);
    expect(call?.opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('logs one line, refreshes usage, saves primed.json (0600) and shows the last prime; no push', async () => {
    const rig = await makeRig({ accounts: (ctx) => [account(ctx, 4)] });
    await started(rig);
    const at = rig.ctx.clock.iso();
    expect(rig.status()).toEqual({ by: 'jantar', running: null, last: { account: 4, at, ok: true } });
    expect(rig.usage.refreshes).toEqual(['primer']);
    const lines = rig.ctx.log.records.filter((r) => r.msg.startsWith('primer:'));
    expect(lines).toEqual([{ level: 'info', msg: 'primer: primed an account; its 5-hour window starts now', fields: { account: 4, resetsAbout: rig.ctx.clock.iso(rig.ctx.clock.now() + PRIME_WINDOW_MS) } }]);
    expect(statSync(primedFile(rig)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(primedFile(rig), 'utf8'))).toEqual({ primed: { '4': rig.ctx.clock.now() }, failed: {}, last: { account: 4, at, ok: true } });
    // The only events are the usage reading and the primer's status: no alert, nothing pushed.
    expect(new Set(eventTypes(rig))).toEqual(new Set(['usage.updated', 'primer.status']));
  });

  it('shows the account while it runs', async () => {
    let finish: (r: Partial<ExecResult>) => void = () => undefined;
    const rig = await makeRig({ answer: () => new Promise((r) => (finish = r)), accounts: (ctx) => [account(ctx, 4)] });
    await rig.primer.start();
    await until(() => rig.runs().length === 1, 'the run');
    expect(rig.status()).toMatchObject({ by: 'jantar', running: 4, last: null });
    finish({ stdout: 'ok\n' });
    await rig.primer.check();
    expect(rig.status()).toMatchObject({ running: null, last: { account: 4, ok: true } });
  });
});

describe('which accounts', () => {
  it('only free ones: not running, kept, held, stale, not ok, disabled or at the weekly ceiling', async () => {
    const rig = await makeRig({
      settings: { accounts: { prime: true, kept: [6] }, autoswitch: { hold: [7] } },
      accounts: (ctx) => [
        account(ctx, 3, { pct: 12, resetsInMs: 2 * HOUR }),
        account(ctx, 4),
        account(ctx, 5, { pct: 40, resetsInMs: -60_000 }), // the window read has reset since
        account(ctx, 6),
        account(ctx, 7),
        account(ctx, 8, null, { held: true }),
        account(ctx, 9, null, { fetchedAt: new Date(ctx.clock.now() - 11 * 60_000).toISOString() }),
        account(ctx, 10, null, { usageStatus: 'token_expired' }),
        account(ctx, 11, null, { disabled: true }),
        account(ctx, 12, null, { windows: [{ kind: 'five_hour', pct: 0 }, { kind: 'seven_day', pct: 96 }] }),
      ],
    });
    await rig.primer.start();
    await gap(rig);
    await rig.primer.check();
    expect(rig.runs().map((c) => c.args[2])).toEqual(['4', '5']);
  });

  it('kept and held ones too with primeKept, ccw\'s hold list included', async () => {
    const rig = await makeRig({
      settings: { accounts: { prime: true, primeKept: true, kept: [6] }, autoswitch: { hold: [7] } },
      accounts: (ctx) => [account(ctx, 6), account(ctx, 7), account(ctx, 8)],
    });
    rig.writeSwitch({ prime: false, hold: [8] });
    await rig.primer.start();
    await gap(rig);
    await gap(rig);
    await rig.primer.check();
    expect(rig.runs().map((c) => c.args[2])).toEqual(['6', '7', '8']);
  });

  it("never an account on ccw's hold list without primeKept", async () => {
    const rig = await makeRig({ accounts: (ctx) => [account(ctx, 3), account(ctx, 8)] });
    rig.writeSwitch({ hold: [8], prime: false });
    await started(rig);
    expect(rig.runs().map((c) => c.args[2])).toEqual(['3']);
  });

  it("a ccw switch.json that will not parse, with no good copy before it: no prime (its hold list is unknown)", async () => {
    const rig = await makeRig({ accounts: (ctx) => [account(ctx, 3)] });
    rig.writeSwitch('{"prime": false, "hold": [3');
    await started(rig);
    expect(rig.runs()).toEqual([]);
    // Once it parses, the round goes ahead without account 3.
    rig.writeSwitch({ hold: [3], prime: false });
    await rig.primer.check();
    expect(rig.runs()).toEqual([]);
    rig.writeSwitch('{"prime": false, "hold": [');
    await rig.primer.check();
    expect(rig.runs()).toEqual([]);
  });
});

describe('one at a time', () => {
  it('a few seconds apart, never two at once', async () => {
    let busy = 0;
    let most = 0;
    const rig = await makeRig({
      answer: async () => {
        busy += 1;
        most = Math.max(most, busy);
        await new Promise((r) => setTimeout(r, 5));
        busy -= 1;
        return { stdout: 'ok\n' };
      },
      accounts: (ctx) => [account(ctx, 9), account(ctx, 3), account(ctx, 4)],
    });
    await rig.primer.start();
    await until(() => rig.ctx.clock.pending() >= 2, 'the first gap');
    // The second waits for the gap.
    expect(rig.runs()).toHaveLength(1);
    await rig.ctx.clock.tick(GAP - 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(rig.runs()).toHaveLength(1);
    await rig.ctx.clock.tick(1);
    await until(() => rig.runs().length === 2, 'the second run');
    await gap(rig);
    await rig.primer.check();
    expect(rig.runs().map((c) => c.args[2])).toEqual(['3', '4', '9']);
    expect(most).toBe(1);
  });

  it('turned off between two primes: the rest wait', async () => {
    const rig = await makeRig({ accounts: (ctx) => [account(ctx, 3), account(ctx, 4)] });
    await rig.primer.start();
    await until(() => rig.status()?.last?.account === 3, 'the first prime');
    await rig.setSettings({ accounts: { prime: false } });
    await gap(rig);
    await rig.primer.check();
    expect(rig.runs().map((c) => c.args[2])).toEqual(['3']);
    expect(rig.status()?.by).toBe('off');
  });

  it('kept since the round began: skipped', async () => {
    const rig = await makeRig({ accounts: (ctx) => [account(ctx, 3), account(ctx, 4)] });
    await rig.primer.start();
    await until(() => rig.status()?.last?.account === 3, 'the first prime');
    await rig.setSettings({ accounts: { kept: [4] } });
    await gap(rig);
    await rig.primer.check();
    expect(rig.runs().map((c) => c.args[2])).toEqual(['3']);
  });
});

describe('once per window, and a back-off', () => {
  it('a primed account is not primed again for 5 hours, across a restart', async () => {
    const rig = await makeRig({ accounts: (ctx) => [account(ctx, 4)] });
    await started(rig);
    expect(rig.runs()).toHaveLength(1);
    // The reading still shows no window (cswap has not read it again yet).
    rig.setAccounts([account(rig.ctx, 4)]);
    await rig.primer.check();
    expect(rig.runs()).toHaveLength(1);

    await rig.ctx.clock.tick(PRIME_WINDOW_MS - 60_000);
    await rig.restart();
    rig.setAccounts([account(rig.ctx, 4)]);
    await rig.primer.check();
    expect(rig.runs()).toHaveLength(1);
    // The last prime is still shown after the restart.
    expect(rig.status()?.last).toMatchObject({ account: 4, ok: true });

    await rig.ctx.clock.tick(60_000);
    rig.setAccounts([account(rig.ctx, 4)]);
    await rig.primer.check();
    expect(rig.runs()).toHaveLength(2);
  });

  it('a failed prime is not tried again inside its 30 minutes across a restart', async () => {
    let code = 1;
    const rig = await makeRig({ answer: () => ({ code }), accounts: (ctx) => [account(ctx, 4)] });
    await started(rig);
    expect(rig.runs()).toHaveLength(1);
    expect(JSON.parse(readFileSync(primedFile(rig), 'utf8')).failed).toEqual({ 4: rig.ctx.clock.now() });

    code = 0;
    await rig.ctx.clock.tick(PRIME_RETRY_MS - 60_000);
    await rig.restart();
    rig.setAccounts([account(rig.ctx, 4)]);
    await rig.primer.check();
    expect(rig.runs()).toHaveLength(1);

    await rig.ctx.clock.tick(60_000);
    rig.setAccounts([account(rig.ctx, 4)]);
    await rig.primer.check();
    expect(rig.runs()).toHaveLength(2);
    // Past its 30 minutes, the failure is no longer kept.
    expect(JSON.parse(readFileSync(primedFile(rig), 'utf8')).failed).toEqual({});
  });

  it('a failed prime is tried again after 30 minutes, and its error text is never logged', async () => {
    const ERR = 'SYNTHETIC-CSWAP-ERROR-TEXT a3***@example.com';
    let code = 1;
    const rig = await makeRig({ answer: () => ({ code, stderr: ERR }), accounts: (ctx) => [account(ctx, 4)] });
    await started(rig);
    expect(rig.status()).toMatchObject({ by: 'jantar', running: null, last: { account: 4, ok: false } });
    const warn = rig.ctx.log.records.find((r) => r.msg.startsWith('primer:'));
    expect(warn).toMatchObject({ level: 'warn', msg: 'primer: prime failed; that account is tried again in 30 min', fields: { account: 4, why: 'exited 1' } });
    expect(JSON.stringify(rig.ctx.log.records)).not.toContain('SYNTHETIC-CSWAP-ERROR-TEXT');
    expect(rig.usage.refreshes).toEqual([]);

    await rig.ctx.clock.tick(PRIME_RETRY_MS - 60_000);
    rig.setAccounts([account(rig.ctx, 4)]);
    await rig.primer.check();
    expect(rig.runs()).toHaveLength(1);

    code = 0;
    await rig.ctx.clock.tick(60_000);
    rig.setAccounts([account(rig.ctx, 4)]);
    await rig.primer.check();
    expect(rig.runs()).toHaveLength(2);
    expect(rig.status()?.last).toMatchObject({ account: 4, ok: true });
  });

  it('cswap that cannot start, or no reply in time, is a failed prime', async () => {
    let answer: Partial<ExecResult> = { code: null, spawnError: 'ENOENT' };
    const rig = await makeRig({ answer: () => answer, accounts: (ctx) => [account(ctx, 4), account(ctx, 5)] });
    await rig.primer.start();
    await until(() => rig.status()?.last?.account === 4, 'the first prime');
    answer = { code: null, signal: 'SIGTERM', timedOut: true };
    await gap(rig);
    await rig.primer.check();
    const why = rig.ctx.log.records.filter((r) => r.level === 'warn').map((r) => r.fields?.why);
    expect(why).toEqual(['cswap could not start', 'no reply within 2 min']);
    expect(rig.status()?.last).toMatchObject({ account: 5, ok: false });
  });
});

describe('ccw', () => {
  it('primes free windows itself ("prime": true): Jantar does not, and says so', async () => {
    const rig = await makeRig({ accounts: (ctx) => [account(ctx, 4)] });
    rig.writeSwitch({ prime: true, on: true, dry_run: false });
    await started(rig);
    expect(rig.runs()).toEqual([]);
    expect(rig.status()).toEqual({ by: 'ccw', running: null, last: null });
  });

  it("is shown even while Jantar's own switch is off", async () => {
    const rig = await makeRig({ settings: {}, accounts: (ctx) => [account(ctx, 4)] });
    rig.writeSwitch({ prime: true });
    await started(rig);
    expect(rig.status()?.by).toBe('ccw');
  });

  it('primes with no "prime" key in its switch.json (its own default): Jantar does not', async () => {
    const rig = await makeRig({ accounts: (ctx) => [account(ctx, 4)] });
    rig.writeSwitch({ on: true, hold: [7] });
    await started(rig);
    expect(rig.runs()).toEqual([]);
    expect(rig.status()?.by).toBe('ccw');
  });

  it('does not prime with its autoswitch off, in a dry run, or with "prime": false: Jantar does', async () => {
    for (const cfg of [{ prime: true, on: false }, { prime: true, dry_run: true }, { prime: false }, { on: true, prime: false }]) {
      const rig = await makeRig({ accounts: (ctx) => [account(ctx, 4)] });
      rig.writeSwitch(cfg);
      await started(rig);
      expect(rig.runs(), JSON.stringify(cfg)).toHaveLength(1);
      expect(rig.status()?.by).toBe('jantar');
    }
  });

  it('takes over between two primes: the rest are left to ccw', async () => {
    const rig = await makeRig({ accounts: (ctx) => [account(ctx, 3), account(ctx, 4)] });
    await rig.primer.start();
    await until(() => rig.status()?.last?.account === 3, 'the first prime');
    rig.writeSwitch({ prime: true });
    await gap(rig);
    await rig.primer.check();
    expect(rig.runs().map((c) => c.args[2])).toEqual(['3']);
    expect(rig.status()?.by).toBe('ccw');
  });
});

describe('adopt and stop', () => {
  it('runs launch.preLaunchArgv first; a failed adopt is a failed prime with no cswap run', async () => {
    let adoptCode = 0;
    const rig = await makeRig({
      settings: { accounts: { prime: true }, launch: { preLaunchArgv: ['/fake/bin/adopt', '{n}'] } },
      other: (call) => (call.file === '/fake/bin/adopt' ? { code: adoptCode } : undefined),
      accounts: (ctx) => [account(ctx, 4), account(ctx, 5)],
    });
    adoptCode = 0;
    await rig.primer.start();
    await until(() => rig.status()?.last?.account === 4, 'the first prime');
    expect(rig.exec.calls.map((c) => [c.file, c.args.slice(0, 3)])).toEqual([
      ['/fake/bin/adopt', ['4']],
      ['/fake/bin/cswap', ['run', '--share-history', '4']],
    ]);
    adoptCode = 3;
    await gap(rig);
    await rig.primer.check();
    expect(rig.runs().map((c) => c.args[2])).toEqual(['4']);
    expect(rig.status()?.last).toMatchObject({ account: 5, ok: false });
    expect(rig.ctx.log.records.find((r) => r.level === 'warn' && r.msg.startsWith('primer:'))?.fields).toEqual({ account: 5, why: 'adopt failed' });
  });

  it('stopping kills a running prime, which counts as neither a prime nor a failure', async () => {
    const rig = await makeRig({
      answer: (call) =>
        new Promise((resolve) => {
          call.opts.signal?.addEventListener('abort', () => resolve({ code: null, signal: 'SIGTERM' }), { once: true });
        }),
      accounts: (ctx) => [account(ctx, 4)],
    });
    await rig.primer.start();
    await until(() => rig.runs().length === 1, 'the run');
    await rig.primer.stop();
    expect(rig.runs()[0]?.opts.signal?.aborted).toBe(true);
    expect(rig.status()).toEqual({ by: 'jantar', running: null, last: null });
    expect(rig.ctx.log.records.filter((r) => r.level === 'warn')).toEqual([]);
    expect(() => readFileSync(primedFile(rig))).toThrow();
  });

  it('looks again once a minute without a new reading', async () => {
    const rig = await makeRig({ accounts: (ctx) => [account(ctx, 4, { pct: 3, resetsInMs: 30_000 })] });
    await started(rig);
    expect(rig.runs()).toEqual([]);
    // The window resets with no usage.updated (the reading did not change): the minute timer finds it free.
    await rig.ctx.clock.tick(60_000);
    await until(() => rig.runs().length === 1, 'the prime');
    await rig.primer.check();
    expect(rig.status()?.last).toMatchObject({ account: 4, ok: true });
  });
});
