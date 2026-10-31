/**
 * The scaffold's promise to every builder: a synthetic HOME plus fake
 * binaries that work with the daemon's real config and exec code.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIVE_SIDS, formatLstartLocal, makeFakeHome, type FakeHome } from '@jantar/fixtures';
import { defaultSettings } from '@jantar/protocol';
import { ensureStateDirs, resolveBins, resolvePaths } from '../src/config.js';
import { CSWAP_SCRUB_ENV, cLocale, createExecFile, scrubEnv } from '../src/core/index.js';
import { createTestContext } from '../src/core/testing.js';

describe('fake home + daemon config', () => {
  let home: FakeHome;
  beforeAll(async () => {
    home = await makeFakeHome();
  });
  afterAll(async () => {
    await home.cleanup();
  });

  it('resolves every path inside the fake home', async () => {
    const paths = resolvePaths({ env: home.env });
    expect(paths.home).toBe(home.jantarHome);
    expect(paths.claudeHome).toBe(home.paths.claudeHome);
    expect(paths.claudeSettings).toBe(home.paths.claudeSettings);
    expect(paths.cswapProfiles).toBe(home.paths.cswapProfiles);
    expect(paths.cswapSequence).toBe(home.paths.sequenceJson);
    expect(paths.cswapUsageCache).toBe(home.paths.usageJson);
    await ensureStateDirs(paths);
  });

  it('finds the fake binaries on the fake PATH', async () => {
    const bins = await resolveBins({ settings: defaultSettings(), env: home.env, userHome: home.home });
    expect(bins.cswap).toBe(home.bins.cswap);
    expect(bins.osascript).toBe(home.bins.osascript);
    expect(bins.ps).toBe(home.bins.ps);
    expect(bins.lsof).toBe(home.bins.lsof);
  });

  it('runs fake cswap and ps through the real exec with a scrubbed env', async () => {
    const exec = createExecFile();
    const env = scrubEnv({ ...home.env, CLAUDE_CONFIG_DIR: '/should/not/leak' }, CSWAP_SCRUB_ENV);
    const list = await exec(home.bins.cswap, ['list', '--json'], { env, timeoutMs: 10_000 });
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout).accounts).toHaveLength(4);
    const calls = await home.calls('cswap');
    expect(calls.at(-1)?.env.CLAUDE_CONFIG_DIR).toBeUndefined();

    const live = home.session(DEFAULT_LIVE_SIDS[0]);
    const ps = await exec(home.bins.ps, ['-o', 'lstart=', '-p', String(live.pid)], { env: cLocale(home.env) });
    expect(ps.stdout.trim()).toBe(formatLstartLocal(live.startMs));
    expect((await home.calls('ps')).at(-1)?.env.LC_ALL).toBe('C');
  });

  it('plugs into createTestContext', () => {
    const ctx = createTestContext({ userHome: home.home, home: home.jantarHome, proc: home.probe, env: home.env });
    expect(ctx.paths.cswapProfiles).toBe(home.paths.cswapProfiles);
    expect(ctx.proc.isAlive(41001)).toBe(true);
    expect(ctx.proc.isAlive(41006)).toBe(false);
  });
});
