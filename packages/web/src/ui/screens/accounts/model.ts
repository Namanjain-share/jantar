/**
 * What the Accounts screen draws, derived once from state, /v1/plan and the
 * current time (direction.md 5.3, dir-k.html). Pure, so it is easy to test:
 * every number here comes from state; nothing is invented.
 *
 * "Full" means the autoswitch ceiling, the % of a 5-hour window autoswitch
 * treats as full, which is also what ccw's `fullInMin` counts down to.
 *
 * v0.6 (Fleet): `buildRows` takes the machine (`node`, absent for the Mac)
 * and reads only its accounts and sessions: every server has its own
 * account 0, so a server's session never counts on the Mac's account.
 */
import {
  accountsOf,
  boardOrder,
  machineOf,
  type Account,
  type AccountProjection,
  type Move,
  type PlanResponse,
  type Session,
  type State,
  type UsageWindow,
} from '@jantar/protocol';
import { accountId, accountName, usageStatusText } from '../../../lib/format.js';
import type { TagTone } from '../../kit/Tag.js';
import { dur, hhmm } from './time.js';

const MIN = 60_000;

/** The runway axis runs from now to now + 6 h, so any 5-hour window fits. */
export const SPAN_MIN = 360;

/**
 * The name of the legacy autoswitch tool v0.1 reads its plan from. It stays
 * "ccw" whatever this product is called (brand.ts), so it is not PRODUCT_NAME.
 */
export const LEGACY_TOOL = 'ccw';

export type SortKey = 'id' | 'headroom';

export interface Flag {
  text: string;
  tone: TagTone;
}

export interface AccountRow {
  account: Account;
  id: number;
  /** "03" */
  tag: string;
  /** The alias, else the masked email. */
  alias: string;
  /** "03 work", for accessible names. */
  name: string;
  /** usageStatus is ok, so the numbers are current. */
  ok: boolean;
  /** 5-hour % (rounded); 0 with no window open; null with no reading. */
  h5: number | null;
  /** The 5-hour reset, when a window is open. */
  resetAt: number | null;
  /** When it reaches the ceiling at this pace, if that is before the reset. */
  fullAt: number | null;
  /** Burn in % of the window per hour; null when unknown or idle. */
  burnPerHour: number | null;
  d7: number | null;
  d7ResetAt: number | null;
  /** Model-scoped weekly windows ("scoped:Opus"). */
  scoped: UsageWindow[];
  /** At or past the ceiling. */
  past: boolean;
  /** Sessions on this account, in board order. */
  sessions: Session[];
  /** Moves leaving this account. */
  moves: Move[];
  flags: Flag[];
}

function projectionFor(a: Account, plan: PlanResponse | null): AccountProjection | undefined {
  if (a.projection) return a.projection;
  const p = plan?.accounts.find((x) => x.id === a.id);
  return p ? { burnPctPerMin: p.burnPctPerMin, fullInMin: p.fullInMin, ridesReset: p.ridesReset, usable: p.usable } : undefined;
}

const parse = (iso: string | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export function buildRows(state: State, plan: PlanResponse | null, ceiling: number, now: number, node?: string): AccountRow[] {
  const order = boardOrder(state).filter((s) => s.node === node);
  // Moves and the plan are the Mac's own (the legacy ccw tool runs there).
  const moves = node === undefined ? Object.values(state.moves) : [];
  const active = node === undefined ? state.activeAccount : (machineOf(state, node)?.activeAccount ?? null);
  return Object.values(accountsOf(state, node))
    .sort((a, b) => a.id - b.id)
    .map((a) => {
      const ok = a.usageStatus === 'ok';
      const five = a.windows.find((w) => w.kind === 'five_hour');
      const week = a.windows.find((w) => w.kind === 'seven_day');
      const reset = parse(five?.resetsAt);
      const open = five !== undefined && (reset === null || reset > now);
      const h5 = five ? (open ? Math.round(Math.max(0, five.pct)) : 0) : ok ? 0 : null;
      const resetAt = open && reset !== null ? reset : null;

      const proj = projectionFor(a, plan);
      let fullAt: number | null = null;
      if (resetAt !== null && ok) {
        if (proj && !proj.ridesReset && proj.fullInMin !== undefined) fullAt = now + Math.max(0, proj.fullInMin) * MIN;
        else if (!proj && five?.willLastToReset !== true) fullAt = parse(five?.projectedExhaustionAt);
        if (fullAt !== null && fullAt >= resetAt) fullAt = null;
      }
      const burn = proj && proj.burnPctPerMin > 0 ? proj.burnPctPerMin * 60 : null;

      const flags: Flag[] = [];
      if (plan?.next === a.id) flags.push({ text: 'next →', tone: 'next' });
      if (!ok) flags.push({ text: usageStatusText(a.usageStatus), tone: 'warn' });
      if (a.held) flags.push({ text: 'held', tone: 'plain' });
      if (a.isDefaultLogin || active === a.id) flags.push({ text: 'default login', tone: 'plain' });
      if (a.disabled) flags.push({ text: 'disabled', tone: 'plain' });

      return {
        account: a,
        id: a.id,
        tag: accountId(a.id),
        alias: a.alias ?? a.emailMasked,
        name: accountName(a.id, a),
        ok,
        h5,
        resetAt,
        fullAt,
        burnPerHour: burn,
        d7: week ? Math.round(Math.max(0, week.pct)) : null,
        d7ResetAt: parse(week?.resetsAt),
        scoped: a.windows.filter((w) => w.kind.startsWith('scoped:')),
        past: ok && h5 !== null && h5 >= ceiling,
        sessions: order.filter((s) => s.account === a.id),
        moves: moves.filter((m) => m.from === a.id),
        flags,
      };
    });
}

/** Headroom under the ceiling; accounts with no current reading go last. */
function headroom(r: AccountRow, ceiling: number): number {
  return r.ok && r.h5 !== null ? ceiling - r.h5 : Number.NEGATIVE_INFINITY;
}

export function sortRows(rows: AccountRow[], key: SortKey, ceiling: number): AccountRow[] {
  if (key === 'id') return rows;
  return [...rows].sort((a, b) => headroom(b, ceiling) - headroom(a, ceiling) || a.id - b.id);
}

/** The one display line (direction.md 5.3, dir-k.html). */
export function displayLine(rows: AccountRow[]): string {
  const past = rows.filter((r) => r.past).length;
  if (past) return `${past} ${past === 1 ? 'account' : 'accounts'} past the ceiling`;
  const dead = rows.filter((r) => r.fullAt !== null).length;
  if (dead) return dead === 1 ? '1 account runs out before its reset' : `${dead} accounts run out before their reset`;
  if (!rows.some((r) => r.ok && r.h5 !== null)) return 'No usage reading yet';
  return 'All accounts under the ceiling';
}

/** "+30%/h": no decimals at 10 or above, one below (dropped when whole). */
export function burnText(perHour: number | null): string {
  if (perHour === null || !Number.isFinite(perHour)) return '–';
  if (perHour >= 10) return `+${Math.round(perHour)}%/h`;
  return `+${perHour.toFixed(1).replace(/\.0$/, '')}%/h`;
}

/** "in 2h22" until the reset. */
export function resetIn(r: AccountRow, now: number): string {
  return r.resetAt === null ? '' : `in ${dur(r.resetAt - now)}`;
}

/** A sentence as parts; `strong` parts are the numbers to read first. */
export type Part = { text: string; strong?: boolean };

const STEP_WORD: Record<Move['step'], string> = {
  saving: 'saving',
  restarting: 'restarting',
  continuing: 'continuing',
  parked: 'parked',
  stuck: 'stuck',
};

export function moveStepWord(m: Move): string {
  return STEP_WORD[m.step];
}

export function moveWho(m: Move, state: State): { folder: string; name: string } {
  const s = state.sessions[m.sid];
  return { folder: m.folder ?? s?.folder ?? m.sid.slice(0, 8), name: m.name ?? s?.name?.trim() ?? '' };
}

/**
 * The expanded row: what the runway means, in words.
 *   "At +36%/h it is full at ~14:16, 1h54 before the 16:10 reset."
 */
export function runwaySentence(r: AccountRow, state: State, ceiling: number, now: number): Part[] {
  const out: Part[] = [];
  const at = r.burnPerHour !== null ? `At ${burnText(r.burnPerHour)} ` : '';
  if (!r.ok) {
    out.push({
      text:
        r.account.usageStatus === 'token_expired'
          ? 'The login token expired, so these numbers can be stale. Log in again to refresh them.'
          : `cswap reports "${usageStatusText(r.account.usageStatus)}", so these numbers can be stale.`,
    });
  } else if (r.resetAt === null) {
    out.push({ text: 'No 5-hour window is open on this account.' });
  } else {
    if (r.past) out.push({ text: `It is past the ${ceiling}% ceiling. ` });
    if (r.fullAt !== null) {
      out.push({ text: `${at ? at + 'it is' : 'It is'} full at ` });
      out.push({ text: `~${hhmm(r.fullAt)}`, strong: true });
      out.push({ text: ', ' });
      out.push({ text: dur(r.resetAt - r.fullAt), strong: true });
      out.push({ text: ` before the ${hhmm(r.resetAt)} reset.` });
    } else if (!r.past) {
      out.push({ text: `${at ? at + 'it lasts' : 'It lasts'} to the ${hhmm(r.resetAt)} reset.` });
    }
  }
  for (const m of r.moves) {
    const who = moveWho(m, state);
    out.push({ text: ' Autoswitch is moving ' });
    out.push({ text: [who.folder, who.name].filter(Boolean).join(' · '), strong: true });
    out.push({ text: m.to !== undefined ? ` to ${accountId(m.to)} (${moveStepWord(m)}).` : ` (${moveStepWord(m)}).` });
  }
  if (r.account.held) out.push({ text: ' Held: autoswitch moves nothing onto or off it.' });
  return out;
}
