import type { AccountId, Settings } from '@jantar/protocol';

/**
 * The accounts kept for other work (settings accounts.kept, Mac only):
 * neither Auto on the start sheet nor Rewrite nor Ask Claude ever picks one.
 * The launcher holds them on top of settings.autoswitch.hold, ccw's live
 * switch.json hold and an account's own flag, so the rule stands when ccw is
 * gone or its hold list can't be read. A manual pick on the start sheet still
 * works, behind confirmHeld, like any held account. Empty by default: the
 * list is the user's to set at the Mac (`jantar accounts`).
 */
export function keptAccounts(settings: Pick<Settings, 'accounts'>): ReadonlySet<AccountId> {
  return new Set(settings.accounts.kept);
}
