/**
 * Single-account mode in the sources (spec 4.11, O5): with one Claude login
 * the usage source is one account 0 named "Claude" that never runs cswap,
 * and every session, on any config dir, is account 0. Cswap mode is v0.3's.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIVE_SIDS, makeFakeHome, type FakeHome } from '@jantar/fixtures';
import { EVENT, defaultSettings } from '@jantar/protocol';
import type { CcwLegacySource, DaemonContext } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { createExecFile } from '../../src/core/exec.js';
import { createFakeExec, createTestContext, type TestContext } from '../../src/core/testing.js';
import { SINGLE_ACCOUNT } from '../../src/rewrite/account.js';
import { PINNED_KV_KEY, createClaudeFilesSource } from '../../src/sources/claude-files/index.js';
import {
  CswapUsageSource,
  SINGLE_ACCOUNT_LABEL,
  SINGLE_NO_USAGE,
  SingleUsageSource,
  createSingleUsageSource,
  createUsageSource,
  singleAccount,
} from '../../src/sources/cswap/index.js';
import { SID, record } from './helpers.js';

const SLOW = { watch: false, pollMs: 1e9 } as const;

/** A ccw that is not there: single-account Macs usually have none. */
const noCcw: CcwLegacySource = {
  start: async () => {},
  stop: async () => {},
  present: () => false,
  botRunning: async () => false,
  moves: async () => [],
  moveFor: async () => null,
  moveLocked: async () => false,
  burn: async () => [],
  plan: async () => ({ source: 'none', next: null, accounts: [], updatedAt: null }),
  switchConfig: async () => null,
};

/** A test context on the fake home, in the given accounts mode, with the real exec (the fake bins log every call). */
function contextOn(home: FakeHome, accountsMode: 'single' | 'cswap'): TestContext {
  return createTestContext({
    userHome: home.home,
    home: home.jantarHome,
    env: home.env,
    proc: home.probe,
    exec: createExecFile(),
    clock: new FakeClock(home.now),
    settings: defaultSettings(),
    bins: { ps: home.bins.ps, lsof: home.bins.lsof, cswap: home.bins.cswap, osascript: home.bins.osascript },
    accountsMode,
  });
}

describe('single-account usage source', () => {
  it('is one account 0 named Claude, with no usage reading and nothing held', async () => {
    const ctx = createTestContext({ accountsMode: 'single', clock: new FakeClock(Date.parse('2026-01-15T10:00:00.000Z')) });
    const src = createSingleUsageSource(ctx);
    expect(singleAccount()).toEqual({
      id: 0,
      alias: 'Claude',
      emailMasked: '',
      isDefaultLogin: true,
      disabled: false,
      held: false,
      usageStatus: 'unknown',
      windows: [],
    });
    expect(SINGLE_ACCOUNT_LABEL).toBe('Claude');
    expect(singleAccount().id).toBe(SINGLE_ACCOUNT);
    expect(await src.read()).toEqual({ accounts: [singleAccount()], activeAccount: 0, fetchedAt: '2026-01-15T10:00:00.000Z', source: 'cache' });
  });

  it('publishes the account once at start, so state has exactly account 0', async () => {
    const exec = createFakeExec();
    const ctx = createTestContext({ accountsMode: 'single', exec });
    const events = record(ctx);
    const src = new SingleUsageSource(ctx);
    expect(src.latest()).toBeNull();
    await src.start();
    await src.start();
    const updated = events.of(EVENT.USAGE_UPDATED);
    expect(updated).toHaveLength(1);
    expect(updated[0]?.data.accounts).toEqual([singleAccount()]);
    expect(updated[0]?.data.activeAccount).toBe(0);
    expect(Object.keys(ctx.store.getState().accounts)).toEqual(['0']);
    expect(ctx.store.getState().accounts['0']).toMatchObject({ alias: 'Claude', usageStatus: 'unknown', held: false });
    expect(src.latest()?.accounts).toEqual([singleAccount()]);
    await src.stop();
    expect(exec.calls).toEqual([]);
  });

  it('refuses a usage refresh with the reason and never polls', async () => {
    const exec = createFakeExec();
    const ctx = createTestContext({ accountsMode: 'single', exec });
    const src = createSingleUsageSource(ctx);
    await src.start();
    expect(src.requestRefresh('phone')).toEqual({ queued: false, reason: SINGLE_NO_USAGE, nextAllowedAt: null });
    expect(src.isPolling()).toBe(false);
    ctx.clock.advance(60 * 60_000);
    expect(exec.calls).toEqual([]);
    await src.stop();
  });

  it('the usage factory picks it in single mode and cswap in cswap mode', () => {
    const single = createUsageSource(createTestContext({ accountsMode: 'single' }), { ccwLegacy: noCcw });
    expect(single).toBeInstanceOf(SingleUsageSource);
    const cswap = createUsageSource(createTestContext({ accountsMode: 'cswap' }), { ccwLegacy: noCcw });
    expect(cswap).toBeInstanceOf(CswapUsageSource);
    // Every v0.3 test context is cswap mode unless it says otherwise.
    expect(createUsageSource(createTestContext(), { ccwLegacy: noCcw })).toBeInstanceOf(CswapUsageSource);
  });
});

describe('single-account mode on a Mac that still has cswap files (JANTAR_ACCOUNTS=single)', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome();
  });
  afterEach(async () => {
    await home.cleanup();
  });

  it('runs no cswap command and shows none of its accounts', async () => {
    const ctx = contextOn(home, 'single');
    ctx.settings.get().usage.poller = 'on';
    const src = createUsageSource(ctx, { ccwLegacy: noCcw });
    await src.start();
    ctx.clock.advance(10 * 60_000);
    expect(src.requestRefresh('test').queued).toBe(false);
    await src.stop();
    expect(await home.calls('cswap')).toEqual([]);
    expect(Object.keys(ctx.store.getState().accounts)).toEqual(['0']);
  });

  it('tags every session as account 0, the default login and each profile alike, and pins nothing', async () => {
    const ctx = contextOn(home, 'single');
    const src = createClaudeFilesSource(ctx, SLOW);
    const recs = await src.scan();
    expect(recs.map((r) => r.sid)).toEqual([...DEFAULT_LIVE_SIDS].sort());
    expect(new Set(recs.map((r) => r.account))).toEqual(new Set([0]));
    // The config dirs are still the real ones (transcripts are read from there).
    expect(recs.find((r) => r.sid === SID.idle)?.configDir).toBe(home.configDirFor(2));
    expect(ctx.db.kv.get(PINNED_KV_KEY)).toBeUndefined();

    expect(src.accountForConfigDir(home.paths.claudeHome)).toBe(0);
    expect(src.accountForConfigDir(home.configDirFor(3))).toBe(0);
    expect(src.accountForConfigDir(join(home.home, '.claude-work'))).toBe(0);
    expect(src.accountForConfigDir('')).toBeNull();
  });

  it('emits sessions on account 0 into state', async () => {
    const ctx = contextOn(home, 'single');
    const src = createClaudeFilesSource(ctx, SLOW);
    await src.start();
    try {
      const sessions = Object.values(ctx.store.getState().sessions);
      expect(sessions.length).toBe(DEFAULT_LIVE_SIDS.length);
      for (const s of sessions) expect(s.account).toBe(0);
    } finally {
      await src.stop();
    }
  });

  it('cswap mode keeps v0.3: profiles map by name and the default login to the active account', async () => {
    const ctx: DaemonContext = contextOn(home, 'cswap');
    const src = createClaudeFilesSource(ctx, SLOW);
    const recs = await src.scan();
    const bySid = Object.fromEntries(recs.map((r) => [r.sid, r.account]));
    expect(bySid[SID.busy]).toBe(1);
    expect(bySid[SID.idle]).toBe(2);
    expect(src.accountForConfigDir(join(home.home, '.claude-work'))).toBeNull();
  });
});
