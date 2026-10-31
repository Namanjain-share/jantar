/**
 * Which program a shared headless run starts and on which account, for the
 * runs that are not Rewrite's own: Ask Claude (life/food/estimate.ts) and,
 * v0.5, the meeting summary (meetings/summary.ts). Rewrite keeps its own
 * AccountChooser (sticky, penalties); these runs pick once per run.
 *
 * The account: never a kept one (settings accounts.kept), never a held one
 * (autoswitch.hold, rewrite.excludeAccounts and ccw's live hold list while
 * ccw is around), within Rewrite's ceilings; the most room first
 * (pickRunAccount). With one Claude login it is account 0 and the run is
 * `claude -p` itself.
 */
import type { AccountId } from '@jantar/protocol';
import type { CcwLegacySource, DaemonContext, Logger, UsageSource } from '../contracts.js';
import { keptAccounts } from '../core/kept-accounts.js';
import { pickRunAccount } from './account.js';
import type { RunVia } from './run.js';

/** cswap (`run --share-history N -- -p`), or claude itself with one login; null when the program is not on this Mac. */
export function runVia(ctx: Pick<DaemonContext, 'accountsMode' | 'bins'>): RunVia | null {
  if (ctx.accountsMode() === 'single') return ctx.bins.claude ? { claude: ctx.bins.claude } : null;
  return ctx.bins.cswap ? { cswap: ctx.bins.cswap } : null;
}

export interface SharedRunDeps {
  usage: UsageSource;
  ccwLegacy: CcwLegacySource;
  /** Says so (fixed words, no account data) when ccw's hold list cannot be read. */
  log?: Logger;
}

/** The account for one shared run, or null when none has room. */
export async function pickSharedRunAccount(ctx: Pick<DaemonContext, 'settings' | 'accountsMode' | 'clock' | 'store'>, deps: SharedRunDeps): Promise<AccountId | null> {
  const s = ctx.settings.get();
  const mode = ctx.accountsMode();
  const base = { ceilingPct: s.rewrite.ceilingPct, weeklyCeiling: s.autoswitch.weekly_ceiling, nowMs: ctx.clock.now(), mode };
  if (mode === 'single') return pickRunAccount({ ...base, accounts: [], hold: new Set(), kept: new Set() });
  const hold = new Set<AccountId>([...s.autoswitch.hold, ...s.rewrite.excludeAccounts, ...(await ccwHold(deps))]);
  const accounts = deps.usage.latest()?.accounts ?? Object.values(ctx.store.getState().accounts);
  return pickRunAccount({ ...base, accounts, hold, kept: keptAccounts(s) });
}

/** ccw's hold list while ccw is around. */
async function ccwHold(deps: SharedRunDeps): Promise<AccountId[]> {
  try {
    if (!deps.ccwLegacy.present()) return [];
    return (await deps.ccwLegacy.switchConfig())?.hold ?? [];
  } catch {
    deps.log?.warn("could not read ccw's hold list");
    return [];
  }
}
