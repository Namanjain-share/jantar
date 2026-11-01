/**
 * Which account a new session starts on (U3, spec 4.5.4): Auto picks the
 * account with the most 5-hour room.
 *
 *   usable(a)      = selectable, not held, not starting another launch, a
 *                    5-hour reading below the ceiling and a 7-day reading
 *                    below the weekly ceiling
 *   held           = the kept accounts (settings accounts.kept, always) ∪
 *                    settings.autoswitch.hold ∪ ccw's switch.json hold
 *                    ∪ the account's own flag
 *   effective5h(a) = (resets within 15 min ? 0 : 5-hour %)
 *                    + bookings(a) × burn_default × 30
 *   Auto           = argmin over usable by (effective5h, 7-day %, live sessions, id)
 *
 * Bookings are launches to the account in the last 30 min that did not fail,
 * so three quick starts spread out instead of piling onto one account. A
 * held account is never Auto's pick; a manual pick of one needs confirmHeld.
 *
 * v0.4:
 * - Single-account mode (one Claude login, no cswap): Auto is account 0 with
 *   no hold, usage, booking or busy logic, and the picker has that one row.
 * - Resume: a conversation kept in one profile's own projects dir can only
 *   be resumed on that account, so a resume pins it; every other account
 *   says "This conversation is on 03" and cannot be picked.
 *
 * v0.6, config dirs (accountsMode "dirs", a paired server without cswap,
 * spec 5; the inputs say so with `mode`): nothing reads usage there, so an
 * account is usable unless it is disabled, and Auto is ~/.claude (account
 * 0) unless it is kept (or held), else the lowest-numbered account that is
 * not. Auto never moves past its pick because the pick is starting another
 * session: it says so, as on the Mac.
 *
 * Pure functions: the service gathers the inputs.
 */
import type { Account, AccountId, AccountsMode, LaunchAccount, Session } from '@jantar/protocol';
import { acct, dur, hhmm } from '../notify/format.js';
import { SINGLE_ACCOUNT } from '../rewrite/account.js';

export { SINGLE_ACCOUNT };

/** An account whose 5-hour window resets this soon counts as empty. */
export const RESET_SOON_MS = 15 * 60_000;
/** Each booking stands for this many minutes of a typical session's burn. */
export const BOOKING_MIN = 30;

export interface AccountInputs {
  accounts: readonly Account[];
  sessions: readonly Session[];
  nowMs: number;
  /** settings.autoswitch.hold ∪ ccw's hold (Account.held is added on top). */
  hold: ReadonlySet<number>;
  /** The kept accounts (core/kept-accounts.ts keptAccounts): held whatever the hold lists say. Required, so no call site can drop the guard. */
  kept: ReadonlySet<number>;
  /** 5-hour and weekly ceilings in force (ccw's while it runs, else settings.autoswitch). */
  ceiling: number;
  weeklyCeiling: number;
  /** settings.autoswitch.burn_default: %/min of a 5-hour window per session. */
  burnPerMin: number;
  /** Launches per account in the last 30 min that did not fail. */
  bookings: ReadonlyMap<number, number>;
  /** Accounts with a launch still starting: one launch per account at a time. */
  busy: ReadonlySet<number>;
  /** IANA zone for "14:20" (the Mac's own when omitted). */
  timeZone?: string | undefined;
  /** v0.6: ctx.accountsMode(); "dirs" switches to the config-dir rules (no usage). Absent: cswap's rules. */
  mode?: AccountsMode | undefined;
}

export interface AutoPick {
  pick: AccountId | null;
  reason: string;
}

const STATUS_WHY: Readonly<Record<string, string>> = {
  api_key: 'api key',
  token_expired: 'token expired',
  relogin_required: 'needs a re-login',
  unavailable: 'usage unavailable',
};

export function fiveHour(a: Account) {
  return a.windows.find((w) => w.kind === 'five_hour');
}

export function sevenDay(a: Account) {
  return a.windows.find((w) => w.kind === 'seven_day');
}

/** Held: never Auto's pick, and a manual pick needs confirmHeld. The kept accounts are held whatever the lists say. */
export function isHeld(a: Account, inp: Pick<AccountInputs, 'hold' | 'kept'>): boolean {
  return a.held || inp.hold.has(a.id) || inp.kept.has(a.id);
}

/** Why the account cannot be started on at all (a manual pick is refused), or null. Config dirs read no usage: only disabled counts. */
export function notSelectable(a: Account, inp?: Pick<AccountInputs, 'mode'>): string | null {
  if (a.disabled) return 'disabled';
  if (a.usageStatus === 'ok' || inp?.mode === 'dirs') return null;
  return STATUS_WHY[a.usageStatus] ?? a.usageStatus.replace(/_/gu, ' ');
}

/** Why Auto passes the account over, or null when it is usable. */
export function autoSkip(a: Account, inp: AccountInputs): string | null {
  const why = notSelectable(a, inp);
  if (why) return why;
  if (isHeld(a, inp)) return 'held';
  if (inp.busy.has(a.id)) return 'starting another session';
  if (inp.mode === 'dirs') return null;
  const five = fiveHour(a);
  if (!five) return 'no usage reading';
  if (five.pct >= inp.ceiling) return 'past the ceiling';
  if ((sevenDay(a)?.pct ?? 0) >= inp.weeklyCeiling) return 'past the weekly ceiling';
  return null;
}

/** The 5-hour % Auto ranks by: 0 when the window resets within 15 min, plus the bookings. */
export function effective5h(a: Account, inp: AccountInputs): number {
  const five = fiveHour(a);
  const reset = five?.resetsAt ? Date.parse(five.resetsAt) : NaN;
  const soon = Number.isFinite(reset) && reset - inp.nowMs <= RESET_SOON_MS;
  const base = soon ? 0 : (five?.pct ?? 0);
  return base + (inp.bookings.get(a.id) ?? 0) * inp.burnPerMin * BOOKING_MIN;
}

export function liveOn(id: AccountId, sessions: readonly Session[]): number {
  return sessions.filter((s) => s.account === id && s.status !== 'ended').length;
}

/** "5h 12% · resets in 3h40 · 14:20" (as much of it as is known). */
export function usageLine(a: Account, inp: Pick<AccountInputs, 'nowMs' | 'timeZone' | 'mode'>): string {
  if (inp.mode === 'dirs') return DIRS_NO_USAGE;
  const five = fiveHour(a);
  if (!five) return 'no usage reading';
  const parts = [`5h ${Math.round(five.pct)}%`];
  const reset = five.resetsAt ? Date.parse(five.resetsAt) : NaN;
  if (Number.isFinite(reset) && five.resetsAt && reset > inp.nowMs) {
    parts.push(`resets in ${dur(reset - inp.nowMs)}`, hhmm(five.resetsAt, inp.timeZone));
  }
  return parts.join(' · ');
}

/** Auto: the usable account with the most room, or null with the sentence for the sheet. */
export function pickAuto(inp: AccountInputs): AutoPick {
  if (inp.mode === 'dirs') return pickDirs(inp);
  const usable = inp.accounts.filter((a) => autoSkip(a, inp) === null);
  if (usable.length === 0) return { pick: null, reason: noRoomReason(inp) };
  const ranked = usable
    .map((a) => ({ a, e: effective5h(a, inp), w: sevenDay(a)?.pct ?? 0, live: liveOn(a.id, inp.sessions) }))
    .sort((x, y) => x.e - y.e || x.w - y.w || x.live - y.live || x.a.id - y.a.id);
  const best = (ranked[0] as (typeof ranked)[number]).a;
  return { pick: best.id, reason: `most room · ${usageLine(best, inp)}` };
}

/**
 * Why Auto has no pick. Accounts with room that are only waiting for another
 * launch to get ready say so; otherwise "No account has room until 14:20 (03
 * resets)", from the earliest reset among accounts Auto could use.
 */
export function noRoomReason(inp: AccountInputs): string {
  const starting = inp.accounts.filter((a) => inp.busy.has(a.id) && autoSkip(a, { ...inp, busy: new Set() }) === null).map((a) => acct(a.id));
  if (starting.length === 1) return `A session is already starting on ${starting[0]}, the only account with room. Try again once it is ready.`;
  if (starting.length > 1) return `A session is already starting on each account with room (${starting.join(', ')}). Try again once one is ready.`;
  let soonest: { at: number; iso: string; id: AccountId } | null = null;
  for (const a of inp.accounts) {
    if (notSelectable(a) || isHeld(a, inp)) continue;
    const iso = fiveHour(a)?.resetsAt;
    const at = iso ? Date.parse(iso) : NaN;
    if (!iso || !Number.isFinite(at) || at <= inp.nowMs) continue;
    if (!soonest || at < soonest.at) soonest = { at, iso, id: a.id };
  }
  if (!soonest) return 'No account has room right now';
  return `No account has room until ${hhmm(soonest.iso, inp.timeZone)} (${acct(soonest.id)} resets)`;
}

/** The account picker's rows, by id. */
export function accountRows(inp: AccountInputs): LaunchAccount[] {
  if (inp.mode === 'dirs') return dirsRows(inp);
  return [...inp.accounts]
    .sort((a, b) => a.id - b.id)
    .map((a) => {
      const five = fiveHour(a);
      const seven = sevenDay(a);
      const row: LaunchAccount = {
        id: a.id,
        label: a.alias?.trim() || acct(a.id),
        live: liveOn(a.id, inp.sessions),
        selectable: notSelectable(a) === null,
        held: isHeld(a, inp),
      };
      if (five) row.fiveHourPct = five.pct;
      if (seven) row.sevenDayPct = seven.pct;
      if (five?.resetsAt) row.resetsAt = five.resetsAt;
      const why = notSelectable(a);
      if (why) row.why = why;
      return row;
    });
}

/** The ccw group a folder (or session name) is in, and the account its live members are on. */
export function groupAccount(
  folderName: string,
  name: string | undefined,
  groups: readonly (readonly string[])[],
  sessions: readonly Session[],
): { label: string; account: AccountId } | null {
  const names = new Set([folderName.toLowerCase(), (name ?? '').toLowerCase()].filter(Boolean));
  const group = groups.find((g) => g.some((x) => names.has(x.toLowerCase())));
  if (!group) return null;
  const members = new Set(group.map((x) => x.toLowerCase()));
  const counts = new Map<AccountId, number>();
  for (const s of sessions) {
    if (s.account === null || s.status === 'ended') continue;
    if (!members.has(s.folder.toLowerCase()) && !members.has((s.name ?? '').toLowerCase())) continue;
    counts.set(s.account, (counts.get(s.account) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return top ? { label: group.join('+'), account: top[0] } : null;
}

// ---- v0.4 ------------------------------------------------------------------

/** Auto's reason in single mode (the CLI prints it; the phone hides the Account row). */
export const SINGLE_REASON = 'one Claude login';

/** Single mode: Auto is the one login, whatever the roster or its usage says. */
export function pickSingle(): AutoPick {
  return { pick: SINGLE_ACCOUNT, reason: SINGLE_REASON };
}

/** Single mode's picker: account 0, always selectable, never held. */
export function singleRows(sessions: readonly Session[]): LaunchAccount[] {
  return [{ id: SINGLE_ACCOUNT, label: 'Claude', live: liveOn(SINGLE_ACCOUNT, sessions), selectable: true, held: false }];
}

/** "This conversation is on 03": the account a resume is pinned to. */
export function pinnedReason(id: AccountId): string {
  return `This conversation is on ${acct(id)}`;
}

/** The picker's rows for a resume pinned to `id`: every other account cannot be picked, and says why. */
export function pinRows(rows: readonly LaunchAccount[], id: AccountId): LaunchAccount[] {
  return rows.map((r) => (r.id === id ? r : { ...r, selectable: false, why: pinnedReason(id) }));
}

// ---- v0.6: config dirs ------------------------------------------------------

/** What a config dir's usage reads as (nothing reads usage there). */
export const DIRS_NO_USAGE = 'no usage numbers here';
/** Auto's reason when it picks ~/.claude. */
export const DIRS_DEFAULT_REASON = 'the default login (~/.claude)';
/** Auto has no pick: every account is kept, held or disabled. */
export const DIRS_ALL_KEPT = 'Every account on this machine is kept or held: pick one';

/** Config dirs: ~/.claude (0) unless it is kept, held or disabled, else the lowest-numbered account that is not. */
export function pickDirs(inp: AccountInputs): AutoPick {
  const usable = [...inp.accounts].sort((a, b) => a.id - b.id).filter((a) => !a.disabled && !isHeld(a, inp));
  const first = usable[0];
  if (!first) return { pick: null, reason: DIRS_ALL_KEPT };
  if (inp.busy.has(first.id)) return { pick: null, reason: `A session is already starting on ${acct(first.id)}. Try again once it is ready.` };
  if (first.id === SINGLE_ACCOUNT) return { pick: first.id, reason: DIRS_DEFAULT_REASON };
  return { pick: first.id, reason: `the first account not kept (${first.alias?.trim() || acct(first.id)})` };
}

/** Config dirs' picker: every account selectable unless disabled, held when kept or held; no usage fields. */
export function dirsRows(inp: AccountInputs): LaunchAccount[] {
  return [...inp.accounts]
    .sort((a, b) => a.id - b.id)
    .map((a) => {
      const row: LaunchAccount = {
        id: a.id,
        label: a.alias?.trim() || acct(a.id),
        live: liveOn(a.id, inp.sessions),
        selectable: !a.disabled,
        held: isHeld(a, inp),
      };
      if (a.disabled) row.why = 'disabled';
      return row;
    });
}
