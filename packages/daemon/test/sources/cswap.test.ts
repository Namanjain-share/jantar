import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECRET_MARKER, cswapListJson, defaultAccounts, makeFakeHome, usageCacheJson } from '@jantar/fixtures';
import { defaultSettings, type PlanResponse } from '@jantar/protocol';
import type { CcwLegacySource, ExecFile } from '../../src/contracts.js';
import { cacheRowTrusted, createCswapUsageSource, createUsageSource, parseCliList } from '../../src/sources/cswap/index.js';
import { fsx } from '../../src/sources/lib/fsx.js';
import { sourceEnv, type SourceEnv } from './helpers.js';

function fakeCcw(over: { present?: boolean; bot?: boolean; hold?: number[] | null } = {}): CcwLegacySource & { botCalls: number } {
  const o = { present: false, bot: false, hold: null as number[] | null, ...over };
  const none: PlanResponse = { source: 'none', next: null, accounts: [], updatedAt: null };
  const ccw = {
    botCalls: 0,
    start: async () => {},
    stop: async () => {},
    present: () => o.present,
    botRunning: async () => {
      ccw.botCalls += 1;
      return o.bot;
    },
    moves: async () => [],
    moveFor: async () => null,
    moveLocked: async () => false,
    burn: async () => [],
    plan: async () => none,
    switchConfig: async () => (o.hold ? { on: false, dryRun: true, hold: o.hold, groups: [] } : null),
  };
  return ccw;
}

const auto = () => {
  const s = defaultSettings();
  s.usage.poller = 'auto';
  return s;
};

describe('cswap: reading the cache', () => {
  let env: SourceEnv;
  beforeEach(async () => {
    env = await sourceEnv({ home: { sessions: [] } });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it('builds accounts from sequence.json and cache/usage.json', async () => {
    const snap = await createCswapUsageSource(env.ctx, { ccwLegacy: fakeCcw() }).read();
    expect(snap?.source).toBe('cache');
    expect(snap?.activeAccount).toBe(1);
    const a = Object.fromEntries((snap?.accounts ?? []).map((x) => [x.id, x]));
    expect(Object.keys(a)).toEqual(['1', '2', '3', '4']);
    expect(a[1]).toMatchObject({ emailMasked: 'a***@e***.com', isDefaultLogin: true, disabled: false, usageStatus: 'ok', ageS: 45 });
    expect(a[2]).toMatchObject({ alias: 'team-b', isDefaultLogin: false, usageStatus: 'ok' });
    expect(a[3]).toMatchObject({ disabled: true, usageStatus: 'relogin_required', windows: [] });
    // a 429 keeps the last good reading trusted until the soonest window resets
    expect(a[4]).toMatchObject({ usageStatus: 'ok' });
    expect(a[1]?.windows).toEqual([
      { kind: 'five_hour', pct: 42, resetsAt: new Date(env.home.now + 130 * 60_000).toISOString() },
      { kind: 'seven_day', pct: 18, resetsAt: expect.any(String) },
      { kind: 'scoped:Model-A', pct: 9, resetsAt: expect.any(String) },
    ]);
    expect(a[1]?.fetchedAt).toBe(new Date(env.home.now - 45_000).toISOString());
  });

  it('never exposes an address unmasked', async () => {
    const snap = await createCswapUsageSource(env.ctx, { ccwLegacy: fakeCcw() }).read();
    const text = JSON.stringify(snap);
    for (const acc of defaultAccounts()) expect(text).not.toContain(acc.email);
  });

  it('counts a window whose reset time has passed as 0%', async () => {
    env.ctx.clock.advance(13 * 60_000); // account 4's five-hour window resets 12 minutes after "now"
    const snap = await createCswapUsageSource(env.ctx, { ccwLegacy: fakeCcw() }).read();
    const four = snap?.accounts.find((x) => x.id === 4);
    expect(four?.windows[0]).toEqual({ kind: 'five_hour', pct: 0 });
    expect(four?.windows[1]?.pct).toBe(96);
  });

  it('ignores a cache row that belongs to whoever used to hold the slot', async () => {
    const cache = usageCacheJson(defaultAccounts(), env.home.now) as { accounts: Record<string, Record<string, unknown>> };
    (cache.accounts['2'] as Record<string, unknown>).email = 'someone-else@example.com';
    await writeFile(env.home.paths.usageJson, JSON.stringify(cache));
    const snap = await createCswapUsageSource(env.ctx, { ccwLegacy: fakeCcw() }).read();
    expect(snap?.accounts.find((x) => x.id === 2)).toMatchObject({ usageStatus: 'unavailable', windows: [] });
    expect(snap?.accounts.find((x) => x.id === 1)?.usageStatus).toBe('ok');
  });

  it('ignores a cache that is not schemaVersion 2, and returns null without sequence.json', async () => {
    await writeFile(env.home.paths.usageJson, JSON.stringify({ accounts: {} }));
    const snap = await createCswapUsageSource(env.ctx, { ccwLegacy: fakeCcw() }).read();
    expect(snap?.accounts.every((a) => a.windows.length === 0 && a.usageStatus === 'unavailable')).toBe(true);
    await writeFile(env.home.paths.sequenceJson, '');
    const src = createCswapUsageSource(env.ctx, { ccwLegacy: fakeCcw() });
    expect(await src.read()).toBeNull();
  });

  it('applies cswap’s trust rule to cache rows', () => {
    const now = Date.parse('2026-01-15T10:00:00Z');
    const lastGood = { five_hour: { pct: 10, resets_at: '2026-01-15T11:00:00Z' } };
    const row = (ageS: number, extra: Record<string, unknown> = {}) => ({ fetchedAt: now / 1000 - ageS, lastGood, ...extra });
    expect(cacheRowTrusted(row(100), now)).toBe(true);
    expect(cacheRowTrusted(row(900), now)).toBe(false);
    expect(cacheRowTrusted(row(900, { nextPollAt: now / 1000 + 60 }), now)).toBe(true);
    expect(cacheRowTrusted(row(4000, { consecutiveFailures: 3 }), now)).toBe(false);
    expect(cacheRowTrusted(row(4000, { lastError: 'http-429', consecutiveFailures: 1 }), now)).toBe(true);
    expect(cacheRowTrusted({ ...row(4000, { lastError: 'http-429', consecutiveFailures: 1 }), lastGood: { five_hour: { pct: 1, resets_at: '2026-01-15T09:00:00Z' } } }, now)).toBe(false);
    expect(cacheRowTrusted({ fetchedAt: now / 1000 }, now)).toBe(false);
  });

  it('marks held accounts from ccw’s hold list while ccw is around, else from our settings', async () => {
    await env.ctx.settings.patch({ autoswitch: { hold: [2] } });
    const ours = createCswapUsageSource(env.ctx, { ccwLegacy: fakeCcw() });
    await ours.start();
    expect(ours.latest()?.accounts.filter((a) => a.held).map((a) => a.id)).toEqual([2]);
    await ours.stop();
    const theirs = createCswapUsageSource(env.ctx, { ccwLegacy: fakeCcw({ present: true, bot: true, hold: [3] }) });
    await theirs.start();
    expect(theirs.latest()?.accounts.filter((a) => a.held).map((a) => a.id)).toEqual([3]);
    await theirs.stop();
  });

  it('never opens cswap configs or credentials', async () => {
    const seen: string[] = [];
    for (const m of ['readText', 'readFile', 'open'] as const) {
      const orig = fsx[m].bind(fsx) as (p: string) => Promise<unknown>;
      vi.spyOn(fsx, m).mockImplementation(((p: string) => {
        seen.push(p);
        return orig(p);
      }) as never);
    }
    const src = createCswapUsageSource(env.ctx, { ccwLegacy: fakeCcw() });
    await src.start();
    await src.stop();
    expect([...new Set(seen)].sort()).toEqual([env.home.paths.sequenceJson, env.home.paths.usageJson].sort());
    expect(JSON.stringify(env.ctx.store.getState())).not.toContain(SECRET_MARKER);
  });
});

describe('cswap: events', () => {
  let env: SourceEnv;
  beforeEach(async () => {
    env = await sourceEnv({ home: { sessions: [] } });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it('emits usage.updated on start and when the cache changes, not on every tick', async () => {
    const src = createCswapUsageSource(env.ctx, { ccwLegacy: fakeCcw() }, { tickMs: 1e9 });
    await src.start();
    expect(env.events.of('usage.updated')).toHaveLength(1);
    expect(Object.keys(env.ctx.store.getState().accounts)).toEqual(['1', '2', '3', '4']);
    expect(env.ctx.store.getState().usage.source).toBe('cache');
    env.ctx.clock.advance(10_000);
    await src.tickOnce();
    await src.tickOnce(true);
    expect(env.events.of('usage.updated')).toHaveLength(1); // ages changed, nothing else
    const accounts = defaultAccounts();
    (accounts[0] as { fiveHourPct: number }).fiveHourPct = 50;
    await writeFile(env.home.paths.usageJson, JSON.stringify(usageCacheJson(accounts, env.home.now)));
    await src.tickOnce();
    expect(env.events.of('usage.updated')).toHaveLength(2);
    await src.stop();
  });

  it('emits usage.threshold when a window crosses 80% or 95% between readings', async () => {
    const src = createCswapUsageSource(env.ctx, { ccwLegacy: fakeCcw() }, { tickMs: 1e9 });
    await src.start();
    expect(env.events.of('usage.threshold')).toEqual([]); // the first reading sets the baseline
    const accounts = defaultAccounts();
    (accounts[0] as { fiveHourPct: number }).fiveHourPct = 96; // 42 -> 96: crosses 80 and 95
    await writeFile(env.home.paths.usageJson, JSON.stringify(usageCacheJson(accounts, env.home.now)));
    await src.tickOnce();
    const t = env.events.of('usage.threshold');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ account: 1, data: { window: 'five_hour', pct: 96, threshold: 95 } });
    await src.stop();
  });

  it('works through the factory typed for the integration step', async () => {
    const src = createUsageSource(env.ctx, { ccwLegacy: fakeCcw() });
    await src.start();
    expect(src.latest()?.accounts).toHaveLength(4);
    await src.stop();
    expect(env.ctx.clock.pending()).toBe(0);
  });
});

describe('cswap: the single poller', () => {
  it('stays off while ccw’s bot is running (it keeps the cache fresh)', async () => {
    const env = await sourceEnv({ home: { sessions: [] }, settings: auto() });
    try {
      const src = createCswapUsageSource(env.ctx, { ccwLegacy: fakeCcw({ present: true, bot: true }) }, { tickMs: 1e9 });
      await src.start();
      expect(src.isPolling()).toBe(false);
      expect(src.requestRefresh('test')).toEqual({ queued: false, reason: "ccw's bot keeps cswap's usage fresh", nextAllowedAt: null });
      await src.stop();
      expect(await env.home.calls('cswap')).toEqual([]);
    } finally {
      await env.cleanup();
    }
  });

  it('runs `cswap list --json` with CLAUDE_CONFIG_DIR scrubbed when ccw is not running', async () => {
    const env = await sourceEnv({
      home: { sessions: [] },
      settings: auto(),
      env: { CLAUDE_CONFIG_DIR: '/should/not/leak', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/nor/this' },
    });
    try {
      const src = createCswapUsageSource(env.ctx, { ccwLegacy: fakeCcw() }, { tickMs: 1e9 });
      await src.start();
      expect(src.isPolling()).toBe(true);
      await vi.waitFor(() => expect(env.ctx.store.getState().usage.source).toBe('cli'), { timeout: 10_000 });
      const calls = await env.home.calls('cswap');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args).toEqual(['list', '--json']);
      expect(calls[0]?.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(calls[0]?.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
      // cswap's own usageStatus wins over the cache's approximation
      expect(src.latest()?.accounts.find((a) => a.id === 4)?.usageStatus).toBe('unavailable');
      await src.stop();
    } finally {
      await env.cleanup();
    }
  });

  it('never runs two at once, debounces refresh requests and keeps the last good reading on errors', async () => {
    const calls: string[][] = [];
    let release: (() => void) | null = null;
    let running = 0;
    let maxRunning = 0;
    let fail = false;
    let list = '';
    const exec: ExecFile = async (_file, args) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise<void>((r) => {
        release = r;
      });
      running -= 1;
      calls.push([...args]);
      const base = { signal: null, stderr: '', timedOut: false, truncated: false, durationMs: 1 };
      return fail
        ? { ...base, code: 1, stdout: '{"schemaVersion":1,"error":{"type":"X","message":"boom"}}' }
        : { ...base, code: 0, stdout: list };
    };
    const env = await sourceEnv({ home: { sessions: [] }, settings: auto(), exec });
    list = JSON.stringify(cswapListJson(defaultAccounts(), env.home.now));
    const releaseNow = () => (release as unknown as () => void)();
    try {
      const src = createCswapUsageSource(env.ctx, { ccwLegacy: fakeCcw() }, { tickMs: 1e9, minRefreshMs: 60_000 });
      await src.start(); // starts the first poll
      expect(src.requestRefresh('a')).toMatchObject({ queued: true, reason: 'already running' });
      expect(src.requestRefresh('b')).toMatchObject({ queued: true, reason: 'already running' });
      await vi.waitFor(() => expect(release).not.toBeNull());
      releaseNow();
      await vi.waitFor(() => expect(env.ctx.store.getState().usage.source).toBe('cli'));
      expect(maxRunning).toBe(1);
      expect(calls).toEqual([['list', '--json']]);

      release = null;
      const r = src.requestRefresh('c');
      expect(r).toMatchObject({ queued: true, reason: 'debounced', nextAllowedAt: new Date(env.ctx.clock.now() + 60_000).toISOString() });
      expect(src.requestRefresh('d').nextAllowedAt).toBe(r.nextAllowedAt);
      fail = true;
      env.ctx.clock.advance(60_000);
      await vi.waitFor(() => expect(release).not.toBeNull());
      releaseNow();
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      await vi.waitFor(() =>
        expect(env.ctx.log.records.some((x) => x.msg.startsWith('cswap list failed') && x.fields.error === 'boom')).toBe(true),
      );
      expect(maxRunning).toBe(1);
      expect(src.latest()?.source).toBe('cli'); // still the last good reading
      await src.stop();
    } finally {
      await env.cleanup();
    }
  });

  it('is off when settings say so, or when cswap is not installed', async () => {
    const off = defaultSettings();
    off.usage.poller = 'off';
    const env = await sourceEnv({ home: { sessions: [] }, settings: off });
    try {
      const src = createCswapUsageSource(env.ctx, { ccwLegacy: fakeCcw() }, { tickMs: 1e9 });
      await src.start();
      expect(src.requestRefresh('x')).toMatchObject({ queued: false, reason: 'usage poller is off' });
      await src.stop();
      const none = createCswapUsageSource({ ...env.ctx, bins: { ...env.ctx.bins, cswap: null } }, { ccwLegacy: fakeCcw() }, { tickMs: 1e9 });
      expect(none.requestRefresh('x')).toMatchObject({ queued: false, reason: 'cswap not found' });
      expect(await env.home.calls('cswap')).toEqual([]);
    } finally {
      await env.cleanup();
    }
  });

  it('parses the CLI shape, including lastGoodUsage for unavailable rows', () => {
    const now = Date.parse('2026-01-15T10:00:00Z');
    const cli = parseCliList(cswapListJson(defaultAccounts(), now), now, new Set());
    expect(cli?.active).toBe(1);
    expect(cli?.accounts.get(4)?.account).toMatchObject({ usageStatus: 'unavailable', windows: [{ kind: 'five_hour', pct: 97 }, expect.anything(), expect.anything()] });
    expect(cli?.accounts.get(3)?.account.windows).toEqual([]);
    expect(parseCliList({ schemaVersion: 1, error: { type: 'x', message: 'y' } }, now, new Set())).toBeNull();
  });

  it('reads the fixture cache file as JSON (sanity)', async () => {
    const home = await makeFakeHome({ sessions: [] });
    try {
      expect(JSON.parse(await readFile(home.paths.usageJson, 'utf8')).schemaVersion).toBe(2);
    } finally {
      await home.cleanup();
    }
  });
});
