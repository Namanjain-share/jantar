/**
 * The primer's rules (docs/primer.md), as the live ccw tool has them: the
 * run's argv (always --share-history) and env, which window counts as free,
 * the weekly ceiling, every reason an account is skipped, and what ccw's
 * switch.json says. Synthetic account numbers only.
 */
import { describe, expect, it } from 'vitest';
import type { Account } from '@jantar/protocol';
import { rewriteArgv } from '../../src/rewrite/run.js';
import {
  PRIME_RETRY_MS,
  PRIME_STALE_MS,
  PRIME_WINDOW_MS,
  ccwPrimeConfig,
  primeArgv,
  primeEnv,
  usageAgeMs,
  weeklyPct,
  whyNotPrime,
  windowFree,
  type PrimeInput,
} from '../../src/primer/index.js';

const NOW = Date.parse('2026-01-15T10:00:00.000Z');
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const HOUR = 3_600_000;

function acct(id: number, over: Partial<Account> = {}): Account {
  return {
    id,
    emailMasked: `a${id}***@example.com`,
    isDefaultLogin: false,
    disabled: false,
    held: false,
    usageStatus: 'ok',
    fetchedAt: iso(-60_000),
    windows: [
      { kind: 'five_hour', pct: 0 },
      { kind: 'seven_day', pct: 20, resetsAt: iso(48 * HOUR) },
    ],
    ...over,
  };
}

const input = (over: Partial<PrimeInput> = {}): PrimeInput => ({
  nowMs: NOW,
  hold: new Set(),
  kept: new Set(),
  primeKept: false,
  weeklyCeiling: 95,
  primed: new Map(),
  failed: new Map(),
  ...over,
});

describe('the run', () => {
  it('is `cswap run --share-history N -- -p ...` on Haiku with no tools, no MCP, nothing saved, no user settings or hooks', () => {
    expect(primeArgv(4)).toEqual([
      'run', '--share-history', '4', '--',
      '-p', 'Reply with only: ok',
      '--model', 'haiku',
      '--no-session-persistence',
      '--tools', '',
      '--strict-mcp-config',
      '--setting-sources', 'local',
      '--settings', '{"disableAllHooks":true}',
      '--disable-slash-commands',
      '--max-turns', '1',
    ]);
    // The same isolation as every headless run, word for word.
    const shared = rewriteArgv({ account: 4, model: 'haiku', fallbackModel: 'haiku', effort: 'low', systemPromptFile: '/x' });
    for (const [flag, value] of [['--setting-sources', 'local'], ['--settings', '{"disableAllHooks":true}'], ['--max-turns', '1']]) {
      expect(shared[shared.indexOf(flag as string) + 1]).toBe(value);
    }
    expect(shared).toContain('--disable-slash-commands');
    // Never a plain `cswap run N`: it would unlink the profile's shared history.
    for (const n of [0, 3, 12]) expect(primeArgv(n).slice(0, 3)).toEqual(['run', '--share-history', String(n)]);
  });

  it("has claude first on PATH, and no Claude session's or login's variables", () => {
    const env = primeEnv(
      {
        HOME: '/synthetic/home',
        PATH: '/usr/bin:/fake/bin:/bin',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_SESSION_ID: 'synthetic-session',
        CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-token',
        CLAUDE_CONFIG_DIR: '/synthetic/home/.claude-swap-backup/sessions/9-x',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/synthetic/elsewhere',
        ANTHROPIC_API_KEY: 'synthetic-key',
        ANTHROPIC_AUTH_TOKEN: 'synthetic-auth',
      },
      '/fake/bin/claude',
    );
    expect(env.PATH).toBe('/fake/bin:/usr/bin:/bin');
    expect(env.HOME).toBe('/synthetic/home');
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
      expect(env, k).not.toHaveProperty(k);
    }
    // The shared runner's switches: Jantar's own hooks stay quiet, no CLAUDE.md or memory.
    expect(env).toMatchObject({ JANTAR_SKIP_HOOKS: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    // No claude resolved: PATH is left as it is.
    expect(primeEnv({ PATH: '/usr/bin' }, null).PATH).toBe('/usr/bin');
  });
});

describe('windows and readings', () => {
  it('a window is free when none was read, none started, or the one read has reset', () => {
    expect(windowFree(acct(4, { windows: [] }), NOW)).toBe(true);
    expect(windowFree(acct(4), NOW)).toBe(true);
    expect(windowFree(acct(4, { windows: [{ kind: 'five_hour', pct: 30, resetsAt: iso(-1) }] }), NOW)).toBe(true);
    expect(windowFree(acct(4, { windows: [{ kind: 'five_hour', pct: 30, resetsAt: iso(0) }] }), NOW)).toBe(true);
    expect(windowFree(acct(4, { windows: [{ kind: 'five_hour', pct: 1, resetsAt: iso(60_000) }] }), NOW)).toBe(false);
    // A weekly window running says nothing about the 5-hour one.
    expect(windowFree(acct(4, { windows: [{ kind: 'seven_day', pct: 40, resetsAt: iso(HOUR) }] }), NOW)).toBe(true);
  });

  it('the weekly use is the fullest weekly window, 0 once it has reset', () => {
    const a = acct(4, {
      windows: [
        { kind: 'five_hour', pct: 99, resetsAt: iso(HOUR) },
        { kind: 'seven_day', pct: 40, resetsAt: iso(HOUR) },
        { kind: 'scoped:opus', pct: 70, resetsAt: iso(HOUR) },
      ],
    });
    expect(weeklyPct(a, NOW)).toBe(70);
    expect(weeklyPct(a, NOW + 2 * HOUR)).toBe(0);
    expect(weeklyPct(acct(4, { windows: [{ kind: 'seven_day', pct: 30 }] }), NOW)).toBe(30);
    expect(weeklyPct(acct(4, { windows: [] }), NOW)).toBe(0);
  });

  it("a reading's age comes from its fetch time; none is too old", () => {
    expect(usageAgeMs(acct(4), NOW)).toBe(60_000);
    const { fetchedAt: _none, ...noTime } = acct(4);
    expect(usageAgeMs(noTime, NOW)).toBe(Infinity);
  });
});

describe('who is primed', () => {
  it('an ok, fresh account with no 5-hour window running', () => {
    expect(whyNotPrime(acct(4), input())).toBeNull();
  });

  it('never a kept or held account, unless primeKept', () => {
    expect(whyNotPrime(acct(4), input({ kept: new Set([4]) }))).toBe('kept for other work');
    expect(whyNotPrime(acct(4), input({ hold: new Set([4]) }))).toBe('held');
    expect(whyNotPrime(acct(4, { held: true }), input())).toBe('held');
    const all = input({ primeKept: true, kept: new Set([4]), hold: new Set([4]) });
    expect(whyNotPrime(acct(4, { held: true }), all)).toBeNull();
  });

  it('skips usage that is not ok, stale readings and disabled accounts', () => {
    expect(whyNotPrime(acct(4, { usageStatus: 'relogin_required' }), input())).toBe('usage not ok');
    expect(whyNotPrime(acct(4, { usageStatus: 'api_key' }), input())).toBe('usage not ok');
    expect(whyNotPrime(acct(4, { fetchedAt: iso(-PRIME_STALE_MS) }), input())).toBeNull();
    expect(whyNotPrime(acct(4, { fetchedAt: iso(-PRIME_STALE_MS - 1) }), input())).toBe('usage too old');
    const { fetchedAt: _none, ...noTime } = acct(4);
    expect(whyNotPrime(noTime, input())).toBe('usage too old');
    expect(whyNotPrime(acct(4, { disabled: true }), input())).toBe('disabled');
  });

  it('skips a running window and an account at or over the weekly ceiling', () => {
    expect(whyNotPrime(acct(4, { windows: [{ kind: 'five_hour', pct: 0, resetsAt: iso(HOUR) }] }), input())).toBe('its 5-hour window is running');
    const weekly = (pct: number) => acct(4, { windows: [{ kind: 'five_hour', pct: 0 }, { kind: 'seven_day', pct }] });
    expect(whyNotPrime(weekly(94.9), input())).toBeNull();
    expect(whyNotPrime(weekly(95), input())).toBe('at the weekly ceiling');
    expect(whyNotPrime(weekly(80), input({ weeklyCeiling: 80 }))).toBe('at the weekly ceiling');
  });

  it('once per 5 hours per account, and not for 30 minutes after a failure', () => {
    expect(whyNotPrime(acct(4), input({ primed: new Map([[4, NOW - PRIME_WINDOW_MS + 1]]) }))).toBe('primed in the last 5 hours');
    expect(whyNotPrime(acct(4), input({ primed: new Map([[4, NOW - PRIME_WINDOW_MS]]) }))).toBeNull();
    expect(whyNotPrime(acct(4), input({ primed: new Map([[7, NOW]]) }))).toBeNull();
    expect(whyNotPrime(acct(4), input({ failed: new Map([[4, NOW - PRIME_RETRY_MS + 1]]) }))).toBe('failed in the last 30 minutes');
    expect(whyNotPrime(acct(4), input({ failed: new Map([[4, NOW - PRIME_RETRY_MS]]) }))).toBeNull();
  });
});

describe("ccw's switch.json", () => {
  it('ccw primes with "prime": true, or no "prime" key (its default), while its autoswitch is on and not a dry run', () => {
    expect(ccwPrimeConfig({ prime: true })).toEqual({ primes: true, hold: [] });
    expect(ccwPrimeConfig({ prime: true, on: true, dry_run: false, hold: [3, 8] })).toEqual({ primes: true, hold: [3, 8] });
    expect(ccwPrimeConfig({ prime: true, on: false })?.primes).toBe(false);
    expect(ccwPrimeConfig({ prime: true, dry_run: true })?.primes).toBe(false);
    expect(ccwPrimeConfig({ prime: false })?.primes).toBe(false);
    expect(ccwPrimeConfig({ prime: 'yes' })?.primes).toBe(false);
    // ccw loads switch.json over defaults that have "prime": true, so a file without the key primes.
    expect(ccwPrimeConfig({ on: true, hold: [7] })).toEqual({ primes: true, hold: [7] });
    expect(ccwPrimeConfig({})).toEqual({ primes: true, hold: [] });
    expect(ccwPrimeConfig({ hold: [7], dry_run: true })?.primes).toBe(false);
  });

  it('is null when it is not a JSON object', () => {
    for (const raw of [null, [], 'prime', 3]) expect(ccwPrimeConfig(raw)).toBeNull();
  });
});
