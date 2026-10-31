/**
 * sources/cswap/single: the usage source on a Mac with one Claude login and
 * no cswap (accountsMode "single", spec 4.11).
 *
 * - The roster is one account, id 0 (SINGLE_ACCOUNT, the account Rewrite and
 *   Ask Claude run on), named "Claude", with usageStatus "unknown" and no
 *   windows: without cswap nothing reads usage, so nothing is invented.
 * - It emits that roster once at start (usage.updated), so the Board,
 *   Accounts and the launcher see the account like any other.
 * - It never runs a command: no `cswap`, no poller, and a refresh is refused
 *   with the reason.
 */
import { EVENT, type Account } from '@jantar/protocol';
import type { DaemonContext, UsageSnapshot, UsageSource } from '../../contracts.js';
import { SINGLE_ACCOUNT } from '../../rewrite/account.js';

/** What the one account is called wherever an account is named. */
export const SINGLE_ACCOUNT_LABEL = 'Claude';

/** Why a usage refresh does nothing in single-account mode. */
export const SINGLE_NO_USAGE = 'one Claude login: usage needs cswap';

/** The one account of a single-account Mac. */
export function singleAccount(): Account {
  return {
    id: SINGLE_ACCOUNT,
    alias: SINGLE_ACCOUNT_LABEL,
    emailMasked: '',
    isDefaultLogin: true,
    disabled: false,
    held: false,
    usageStatus: 'unknown',
    windows: [],
  };
}

export class SingleUsageSource implements UsageSource {
  private snap: UsageSnapshot | null = null;
  private started = false;

  constructor(private readonly ctx: DaemonContext) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const snap = await this.read();
    this.snap = snap;
    try {
      this.ctx.store.emit({
        type: EVENT.USAGE_UPDATED,
        data: { accounts: snap.accounts, activeAccount: snap.activeAccount, fetchedAt: snap.fetchedAt, source: snap.source },
      });
    } catch (e) {
      this.ctx.log.error('could not publish the single account', { error: String(e) });
    }
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async read(): Promise<UsageSnapshot> {
    return {
      accounts: [singleAccount()],
      activeAccount: SINGLE_ACCOUNT,
      fetchedAt: new Date(this.ctx.clock.now()).toISOString(),
      source: 'cache',
    };
  }

  latest(): UsageSnapshot | null {
    return this.snap;
  }

  requestRefresh(_reason: string): { queued: boolean; reason?: string; nextAllowedAt: string | null } {
    return { queued: false, reason: SINGLE_NO_USAGE, nextAllowedAt: null };
  }

  isPolling(): boolean {
    return false;
  }
}

export function createSingleUsageSource(ctx: DaemonContext): SingleUsageSource {
  return new SingleUsageSource(ctx);
}
