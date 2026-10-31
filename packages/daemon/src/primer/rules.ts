/**
 * The primer's rules (docs/primer.md), pure so each one is easy to test.
 * They are the live ccw tool's (its Switcher.prime, primable and prime_one,
 * window_free and prime_env), with Jantar's settings in place of
 * switch.json's:
 *
 * - an account is primed when no 5-hour window runs on it: none read, none
 *   started, or the one read has reset since;
 * - never a kept or held account (accounts.kept, autoswitch.hold, ccw's
 *   hold list, an account's own `held`), unless accounts.primeKept;
 * - only on a reading that is usage "ok" and at most PRIME_STALE_MS old,
 *   and never on an account at or over the weekly ceiling;
 * - at most once per PRIME_WINDOW_MS per account (persisted), and not for
 *   PRIME_RETRY_MS after a failed prime.
 *
 * The run is `cswap run --share-history N -- -p "Reply with only: ok"
 * --model haiku --no-session-persistence --tools "" --strict-mcp-config`
 * plus the shared runner's isolation (rewrite/run.ts): no user settings or
 * hooks (so no settings `env` or apiKeyHelper brings back a key primeEnv
 * removed), no slash commands, one turn. Always with --share-history,
 * because a plain `cswap run N` unlinks the profile's shared history.
 */
import type { Account, AccountId } from '@jantar/protocol';
import { rewriteEnv } from '../rewrite/run.js';
import { parseSwitchConfig } from '../sources/ccw-legacy/files.js';

/** A primed account is not primed again until its window can have reset. */
export const PRIME_WINDOW_MS = 5 * 60 * 60_000;
/** After a failed prime, that account is left alone this long. */
export const PRIME_RETRY_MS = 30 * 60_000;
/** Between two primes: one at a time, a few seconds apart. */
export const PRIME_GAP_MS = 5_000;
/** A reading older than this cannot say that no window runs. */
export const PRIME_STALE_MS = 10 * 60_000;
/** No reply within this long is a failed prime. */
export const PRIME_TIMEOUT_MS = 120_000;
/** Captured output per stream: the reply is "ok", anything longer is cut. */
export const PRIME_MAX_BUFFER = 64 * 1024;

export const PRIME_PROMPT = 'Reply with only: ok';
export const PRIME_MODEL = 'haiku';

/** The argv after `<bins.cswap>`: the smallest run that starts the account's 5-hour window. */
export function primeArgv(account: AccountId): string[] {
  return [
    'run', '--share-history', String(account), '--',
    '-p', PRIME_PROMPT,
    '--model', PRIME_MODEL,
    '--no-session-persistence',
    '--tools', '',
    '--strict-mcp-config',
    // As every headless run: the user's settings and hooks stay out, one turn.
    '--setting-sources', 'local',
    '--settings', '{"disableAllHooks":true}',
    '--disable-slash-commands',
    '--max-turns', '1',
  ];
}

/**
 * The run's environment: the shared runner's (rewrite/run.ts rewriteEnv:
 * the claude the daemon resolved first on PATH, no other account's config
 * dir, no API key or token, Jantar's hooks skipped), less a Claude
 * session's own variables (CLAUDECODE, CLAUDE_CODE_*) when the daemon was
 * started from inside one.
 */
export function primeEnv(env: Readonly<Record<string, string | undefined>>, claude: string | null): Record<string, string | undefined> {
  const own: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')) own[k] = v;
  return rewriteEnv(own, claude);
}

/** Whether no 5-hour window runs on `a`: none read, none started, or the one read has reset since. */
export function windowFree(a: Account, nowMs: number): boolean {
  const w = a.windows.find((x) => x.kind === 'five_hour');
  if (!w?.resetsAt) return true;
  const t = Date.parse(w.resetsAt);
  return !Number.isFinite(t) || t <= nowMs;
}

/** The fullest weekly window (seven_day and any per-model one); one whose reset has passed counts as 0. */
export function weeklyPct(a: Account, nowMs: number): number {
  let top = 0;
  for (const w of a.windows) {
    if (w.kind === 'five_hour') continue;
    const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    top = Math.max(top, Number.isFinite(reset) && reset <= nowMs ? 0 : w.pct);
  }
  return top;
}

/** How old `a`'s reading is; Infinity with no reading time. */
export function usageAgeMs(a: Account, nowMs: number): number {
  const t = a.fetchedAt ? Date.parse(a.fetchedAt) : NaN;
  return Number.isFinite(t) ? Math.max(0, nowMs - t) : Infinity;
}

export interface PrimeInput {
  nowMs: number;
  /** autoswitch.hold and ccw's hold list (an account's own `held` counts too). */
  hold: ReadonlySet<AccountId>;
  /** accounts.kept */
  kept: ReadonlySet<AccountId>;
  /** accounts.primeKept: kept and held accounts are primed too. */
  primeKept: boolean;
  /** autoswitch.weekly_ceiling */
  weeklyCeiling: number;
  /** Account -> when Jantar last primed it (epoch ms). */
  primed: ReadonlyMap<AccountId, number>;
  /** Account -> when its last prime failed (epoch ms). */
  failed: ReadonlyMap<AccountId, number>;
}

/** Why `a` is not primed now, or null when it is due. */
export function whyNotPrime(a: Account, i: PrimeInput): string | null {
  if (!i.primeKept && i.kept.has(a.id)) return 'kept for other work';
  if (!i.primeKept && (a.held || i.hold.has(a.id))) return 'held';
  if (a.disabled) return 'disabled';
  if (a.usageStatus !== 'ok') return 'usage not ok';
  if (!(usageAgeMs(a, i.nowMs) <= PRIME_STALE_MS)) return 'usage too old';
  if (!windowFree(a, i.nowMs)) return 'its 5-hour window is running';
  if (weeklyPct(a, i.nowMs) >= i.weeklyCeiling) return 'at the weekly ceiling';
  const primed = i.primed.get(a.id);
  if (primed !== undefined && i.nowMs - primed < PRIME_WINDOW_MS) return 'primed in the last 5 hours';
  const failed = i.failed.get(a.id);
  if (failed !== undefined && i.nowMs - failed < PRIME_RETRY_MS) return 'failed in the last 30 minutes';
  return null;
}

/** What the primer reads from ccw's switch.json. */
export interface CcwPrime {
  /**
   * ccw primes free windows itself: "prime" is true or missing (ccw's own
   * default), and its autoswitch is on and not a dry run (ccw only says
   * what it would prime otherwise). `"prime": false` hands priming to
   * Jantar. A ccw from before it could prime also has no "prime" key: then
   * nobody primes, the safe side of the guess (never both).
   */
  primes: boolean;
  hold: AccountId[];
}

/** ccw's switch.json as the primer reads it, or null when it is not a JSON object. */
export function ccwPrimeConfig(raw: unknown): CcwPrime | null {
  const cfg = parseSwitchConfig(raw);
  if (!cfg) return null;
  const p = (raw as Record<string, unknown>).prime;
  // As ccw reads it: SWITCH_DEFAULTS has "prime": True under the file's own keys.
  const prime = p === undefined || p === true;
  return { primes: prime && cfg.on && !cfg.dryRun, hold: [...cfg.hold] };
}
