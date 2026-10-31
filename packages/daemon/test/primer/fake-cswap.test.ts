/**
 * The primer against the fixtures' fake cswap and claude, spawned for real
 * through createExecFile on a synthetic HOME (makeFakeHome): `cswap run
 * --share-history N -- -p ...` hands over to the fake claude with the
 * account's config dir, which finds claude only because the run puts it
 * first on PATH. The daemon's own env carries a Claude session's and a
 * login's variables; none reaches claude. Nothing real runs.
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import { SettingsSchema, type Account } from '@jantar/protocol';
import type { CcwLegacySource, UsageSnapshot, UsageSource } from '../../src/contracts.js';
import { createExecFile } from '../../src/core/index.js';
import { createTestContext } from '../../src/core/testing.js';
import { createPrimer, primeArgv, type PrimerService } from '../../src/primer/index.js';

const ACCOUNT = 3;

function usageWith(accounts: Account[], at: string): UsageSource {
  const snap: UsageSnapshot = { accounts, activeAccount: 1, fetchedAt: at, source: 'cache' };
  return {
    start: async () => undefined,
    stop: async () => undefined,
    read: async () => snap,
    latest: () => snap,
    requestRefresh: () => ({ queued: true, nextAllowedAt: null }),
    isPolling: () => false,
  };
}

describe('a prime through the fake cswap and claude', () => {
  let home: FakeHome;
  let primer: PrimerService | null = null;

  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
  });
  afterEach(async () => {
    await primer?.stop();
    primer = null;
    await home.cleanup();
  });

  function start(bins: { claude: string | null }) {
    const ctx = createTestContext({
      userHome: home.home,
      home: home.jantarHome,
      exec: createExecFile(),
      bins: { cswap: home.bins.cswap, ...bins },
      settings: SettingsSchema.parse({ accounts: { prime: true } }),
      // launchd's PATH (no claude on it), and the variables of a Claude session the daemon may have been started from.
      env: {
        HOME: home.home,
        PATH: '/usr/bin:/bin',
        LC_ALL: 'C',
        TZ: 'UTC',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_SESSION_ID: 'synthetic-session',
        CLAUDE_CONFIG_DIR: join(home.home, '.claude'),
        ANTHROPIC_API_KEY: 'synthetic-key',
      },
    });
    ctx.clock.set(home.now);
    const account: Account = {
      id: ACCOUNT,
      emailMasked: 'c***@example.com',
      isDefaultLogin: false,
      disabled: false,
      held: false,
      usageStatus: 'ok',
      fetchedAt: ctx.clock.iso(home.now - 60_000),
      windows: [{ kind: 'five_hour', pct: 0 }],
    };
    primer = createPrimer(ctx, { usage: usageWith([account], ctx.clock.iso()), ccwLegacy: { present: () => false } as unknown as CcwLegacySource });
    return { ctx, primer };
  }

  it('starts the window: cswap hands the run to claude on that account, in the empty folder, with a clean env', async () => {
    const { ctx, primer } = start({ claude: home.bins.claude });
    await primer.start();
    await primer.check();
    expect(primer.status()).toMatchObject({ by: 'jantar', running: null, last: { account: ACCOUNT, ok: true } });

    const work = realpathSync(join(home.jantarHome, 'primer', 'work'));
    const [cswap] = await home.calls('cswap');
    expect(cswap?.args).toEqual(primeArgv(ACCOUNT));
    expect(cswap?.cwd).toBe(work);

    const runs = await home.calls('claude');
    expect(runs).toHaveLength(1);
    const run = runs[0] as (typeof runs)[number] & { account: number | null; via: string };
    expect(run.args).toEqual(['-p', 'Reply with only: ok', '--model', 'haiku', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--setting-sources', 'local', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--max-turns', '1']);
    expect(run.account).toBe(ACCOUNT);
    expect(run.via).toBe('cswap');
    expect(run.cwd).toBe(work);
    expect(run.stdin).toBe('');
    // cswap set the account's own config dir; the daemon's was never passed on.
    expect(run.env.CLAUDE_CONFIG_DIR).toBe(home.configDirFor(ACCOUNT));
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'ANTHROPIC_API_KEY']) expect(run.envKeys, k).not.toContain(k);
    expect(run.env.JANTAR_SKIP_HOOKS).toBe('1');
    expect(ctx.log.records.filter((r) => r.level === 'warn')).toEqual([]);
  });

  it('fails without claude first on PATH (cswap looks it up there), and when claude fails', async () => {
    const { ctx, primer } = start({ claude: null });
    await primer.start();
    await primer.check();
    expect(await home.calls('claude')).toEqual([]);
    expect(primer.status().last).toMatchObject({ account: ACCOUNT, ok: false });
    expect(ctx.log.records.find((r) => r.level === 'warn')?.fields).toEqual({ account: ACCOUNT, why: 'exited 1' });
  });

  it('a claude that fails to log in is a failed prime', async () => {
    await home.setRules('claude', [{ match: {}, stdout: 'Invalid API key · Please run /login\n', code: 1 }]);
    const { primer } = start({ claude: home.bins.claude });
    await primer.start();
    await primer.check();
    expect(await home.calls('claude')).toHaveLength(1);
    expect(primer.status().last).toMatchObject({ account: ACCOUNT, ok: false });
  });
});
