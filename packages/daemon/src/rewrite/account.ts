/**
 * Which account a Rewrite run uses (U5; spec 4.3 "Account"), and Ask Claude's
 * too (v0.4, `pickRunAccount`).
 *
 * The account with the most 5-hour room among those that qualify: not held
 * (autoswitch, ccw or rewrite.excludeAccounts), never a kept account
 * (settings accounts.kept), enabled,
 * usage "ok" and no older than 15 min, under rewrite.ceilingPct of its
 * 5-hour window and under the weekly ceiling, and not in a penalty (10 min
 * after a startup or auth failure there). The last pick is kept for
 * rewrite.stickyMin while it still qualifies, so the prompt cache stays warm.
 * No account qualifies: null, and the job fails with `no_account` ("Send
 * what I said" stays one tap away). With one Claude login (accounts mode
 * "single") there is no choice to make: the run is account 0.
 */
import type { Account, AccountId, AccountsMode } from '@jantar/protocol';

/** The one account of single-account mode (sessions on any config dir are account 0). */
export const SINGLE_ACCOUNT: AccountId = 0;

/** Usage older than this is not trusted to show room. */
export const USAGE_MAX_AGE_MS = 15 * 60_000;

/** An account that failed to start or log in is skipped this long. */
export const PENALTY_MS = 10 * 60_000;

export interface PickInput {
  accounts: readonly Account[];
  /** Hold lists merged: autoswitch.hold, ccw's hold, rewrite.excludeAccounts. */
  hold: ReadonlySet<AccountId>;
  /** The kept accounts (settings accounts.kept): never used, whatever the hold lists say. Required, so no call site can drop the guard. */
  kept: ReadonlySet<AccountId>;
  /** rewrite.ceilingPct: 5-hour % at or above which an account is full. */
  ceilingPct: number;
  /** autoswitch.weekly_ceiling. */
  weeklyCeiling: number;
  nowMs: number;
  /** Accounts in a penalty right now. */
  penalized?: ReadonlySet<AccountId>;
  /** The kept pick, if its time is not up. */
  sticky?: AccountId | null;
}

/** 5-hour use in %; 0 once the window has reset since the reading. */
export function fiveHourPct(a: Account, nowMs: number): number {
  const w = a.windows.find((x) => x.kind === 'five_hour');
  if (!w) return 0;
  if (w.resetsAt && Date.parse(w.resetsAt) <= nowMs) return 0;
  return w.pct;
}

/** The fullest weekly window (seven_day and any per-model one), as ccw's planner reads it. */
export function weeklyPct(a: Account): number {
  return Math.max(0, ...a.windows.filter((w) => w.kind !== 'five_hour').map((w) => w.pct));
}

function ageMs(a: Account, nowMs: number): number {
  if (a.fetchedAt) return Math.max(0, nowMs - Date.parse(a.fetchedAt));
  return a.ageS === undefined ? Infinity : a.ageS * 1000;
}

/** Why an account cannot take a rewrite now, or null when it can. */
export function whyNot(a: Account, input: Omit<PickInput, 'accounts' | 'sticky'>): string | null {
  if (input.kept.has(a.id)) return 'kept for other work';
  if (a.held || input.hold.has(a.id)) return 'held';
  if (a.disabled) return 'disabled';
  if (a.usageStatus !== 'ok') return a.usageStatus;
  if (!(ageMs(a, input.nowMs) <= USAGE_MAX_AGE_MS)) return 'usage too old';
  if (fiveHourPct(a, input.nowMs) >= input.ceilingPct) return 'past the 5-hour ceiling';
  if (weeklyPct(a) >= input.weeklyCeiling) return 'past the weekly ceiling';
  if (input.penalized?.has(a.id)) return 'failed recently';
  return null;
}

/** The kept account while it still qualifies, else the most room (5-hour %, then weekly %, then id), else null. */
export function pickRewriteAccount(input: PickInput): AccountId | null {
  const ok = input.accounts.filter((a) => whyNot(a, input) === null);
  if (input.sticky !== undefined && input.sticky !== null && ok.some((a) => a.id === input.sticky)) return input.sticky;
  const best = ok
    .map((a) => ({ id: a.id, five: fiveHourPct(a, input.nowMs), week: weeklyPct(a) }))
    .sort((x, y) => x.five - y.five || x.week - y.week || x.id - y.id)[0];
  return best?.id ?? null;
}

/**
 * The account for one headless run (Rewrite, Ask Claude). single: account 0,
 * with no usage or hold logic (null only when 0 is already in `penalized`,
 * i.e. tried by this job). cswap: pickRewriteAccount with `kept` refused as
 * "kept for other work".
 */
export function pickRunAccount(input: PickInput & { mode: AccountsMode }): AccountId | null {
  if (input.mode === 'single') return input.penalized?.has(SINGLE_ACCOUNT) ? null : SINGLE_ACCOUNT;
  return pickRewriteAccount(input);
}

/** Sticky pick and penalties, in memory for the daemon's life. */
export class AccountChooser {
  private sticky: { id: AccountId; since: number } | null = null;
  private readonly penalties = new Map<AccountId, number>();

  constructor(private readonly penaltyMs = PENALTY_MS) {}

  /** Pick for one run; `skip` leaves out accounts already tried by this job. `mode` default cswap. */
  pick(base: Omit<PickInput, 'penalized' | 'sticky'> & { mode?: AccountsMode }, stickyMs: number, skip: ReadonlySet<AccountId> = new Set()): AccountId | null {
    const penalized = new Set(skip);
    for (const [id, until] of this.penalties) {
      if (until > base.nowMs) penalized.add(id);
      else this.penalties.delete(id);
    }
    const stuck = this.sticky && base.nowMs - this.sticky.since < stickyMs ? this.sticky.id : null;
    const id = pickRunAccount({ ...base, penalized, sticky: stuck, mode: base.mode ?? 'cswap' });
    if (id !== null && id !== stuck) this.sticky = { id, since: base.nowMs };
    return id;
  }

  /** A startup or auth failure on `id`: skip it for a while and stop keeping it. */
  penalize(id: AccountId, nowMs: number): void {
    this.penalties.set(id, nowMs + this.penaltyMs);
    if (this.sticky?.id === id) this.sticky = null;
  }
}
