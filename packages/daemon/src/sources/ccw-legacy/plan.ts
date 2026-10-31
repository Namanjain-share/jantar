/**
 * A read-only projection of ccw's Planner (ccw `Planner`, ported): how long
 * each account lasts at the burn ccw has learned for its sessions, and which
 * account ccw would move a typical new session onto next.
 *
 * It computes nothing ccw stores: burn rates come from ccw's burn.json and
 * active.json as they are; usage comes from cswap (via usage.updated). This
 * is the "next ->" and "full in" view while ccw still owns autoswitch; the
 * native planner inside Jantar is later work.
 */
import type { Account, AccountId, Move, Session } from '@jantar/protocol';
import type { BurnEntry, CcwSwitchConfig } from './files.js';

/** A session that worked this recently counts as burning (ccw ACTIVE_FOR). */
const ACTIVE_FOR_MS = 600_000;
/** Rates measured in the last 6 h make the "typical" rate. */
const TYPICAL_SPAN_MS = 6 * 3600_000;

export interface PlanInput {
  nowMs: number;
  accounts: readonly Account[];
  sessions: readonly Session[];
  moves: readonly Move[];
  burn: readonly BurnEntry[];
  active: ReadonlyMap<string, number>;
  cfg: CcwSwitchConfig;
}

export interface PlanAccount {
  id: AccountId;
  burnPctPerMin: number;
  fullInMin?: number;
  ridesReset: boolean;
  usable: boolean;
}

export interface PlanOutput {
  next: AccountId | null;
  accounts: PlanAccount[];
}

/** ccw group_key: sessions in one configured group (matched by folder or name) share a key. */
export function groupKey(folder: string, name: string | undefined, groups: readonly string[][]): string | null {
  const names = new Set([folder.toLowerCase(), (name ?? '').toLowerCase()].filter(Boolean));
  for (let i = 0; i < groups.length; i++) {
    if ((groups[i] ?? []).some((x) => names.has(x.toLowerCase()))) return `group ${i}`;
  }
  return null;
}

export function computePlan(input: PlanInput): PlanOutput {
  const { nowMs, cfg } = input;
  const accts = new Map(input.accounts.map((a) => [a.id, a]));
  const rates = new Map(input.burn.map((b) => [b.sid, b]));

  const typical = (): number => {
    const recent = input.burn
      .filter((b) => nowMs - b.updatedMs < TYPICAL_SPAN_MS && b.pctPerMin > 0.05)
      .map((b) => b.pctPerMin)
      .sort((a, b) => a - b);
    return recent.length ? (recent[Math.floor(recent.length / 2)] as number) : cfg.burnDefault;
  };
  const rate = (sid: string): number => rates.get(sid)?.pctPerMin ?? typical();
  const working = (sid: string): boolean => nowMs - (input.active.get(sid) ?? 0) < ACTIVE_FOR_MS;

  const group = new Map<string, string>();
  const on = new Map<AccountId, Map<string, number>>();
  const onOf = (n: AccountId) => {
    let m = on.get(n);
    if (!m) on.set(n, (m = new Map()));
    return m;
  };
  for (const s of input.sessions) {
    group.set(s.sid, groupKey(s.folder, s.name, cfg.groups) ?? s.sid);
    if (s.account === null || s.entrypoint !== 'cli') continue;
    onOf(s.account).set(s.sid, s.status === 'working' || working(s.sid) ? rate(s.sid) : 0);
  }

  const fiveHour = (a: Account) => a.windows.find((w) => w.kind === 'five_hour');
  const ageMin = (a: Account): number => {
    if (a.fetchedAt) return Math.max(0, (nowMs - Date.parse(a.fetchedAt)) / 60_000);
    return (a.ageS ?? 0) / 60;
  };
  const resetIn = (n: AccountId): number | null => {
    const a = accts.get(n);
    const r = a && fiveHour(a)?.resetsAt;
    if (!r) return null;
    const t = Date.parse(r);
    return t > nowMs ? (t - nowMs) / 60_000 : null;
  };
  const burnOn = (n: AccountId, extra = 0): number => [...(on.get(n)?.values() ?? [])].reduce((x, y) => x + y, 0) + extra;
  const project = (n: AccountId): number => {
    const a = accts.get(n);
    if (!a || resetIn(n) === null) return 0; // no window yet, or it reset after the reading
    return Math.min(100, (fiveHour(a)?.pct ?? 0) + burnOn(n) * ageMin(a));
  };
  // 5-hour use now, fixed before moves are counted (as ccw does)
  const used = new Map([...accts.keys()].map((n) => [n, project(n)]));

  for (const m of input.moves) {
    if (!group.has(m.sid)) group.set(m.sid, groupKey(m.folder ?? '', m.name, cfg.groups) ?? m.sid);
    if (m.step === 'stuck') continue;
    on.get(m.from)?.delete(m.sid); // parked ones burn nothing; moving ones count where they're headed
    if (m.step !== 'parked' && m.to !== undefined) onOf(m.to).set(m.sid, rate(m.sid));
  }

  const fullIn = (n: AccountId, extra = 0): number => {
    const burn = burnOn(n, extra);
    return burn <= 0 ? Infinity : Math.max(0, (cfg.ceiling - (used.get(n) ?? 0)) / burn);
  };
  const windowLeft = (n: AccountId): number => resetIn(n) ?? 300;
  const rides = (n: AccountId, extra = 0): boolean => windowLeft(n) <= fullIn(n, extra);
  const run = (n: AccountId, extra: number): number => {
    const full = fullIn(n, extra);
    const t = windowLeft(n);
    return t <= full ? t + Math.min(300, cfg.ceiling / burnOn(n, extra)) : full;
  };
  const weeklyPct = (a: Account): number =>
    Math.max(0, ...a.windows.filter((w) => w.kind !== 'five_hour').map((w) => w.pct));
  const usable = (n: AccountId): boolean => {
    const a = accts.get(n);
    return !!a && !cfg.hold.includes(n) && a.usageStatus === 'ok' && a.windows.length > 0 && weeklyPct(a) < cfg.weeklyCeiling;
  };
  const shared = (n: AccountId, key: string | null): boolean =>
    [...(on.get(n)?.keys() ?? [])].some((sid) => (group.get(sid) ?? sid) !== key);

  // plan(None): where a typical new session would go
  const x = Math.max(typical(), 0.5);
  const need = Math.min(cfg.minRunMin, Math.max(5, (cfg.ceiling / x - cfg.leadMin) / 2));
  let best: { rank: [number, number, number, number]; n: AccountId } | null = null;
  for (const n of accts.keys()) {
    if (!usable(n)) continue;
    const r = rides(n, x);
    const runMin = run(n, x) - (r ? 0 : cfg.leadMin);
    if (runMin < need) continue;
    const t = resetIn(n);
    const rank: [number, number, number, number] = [shared(n, null) ? 1 : 0, r ? 0 : 1, t ?? Infinity, -runMin];
    if (!best || lexLess(rank, best.rank)) best = { rank, n };
  }

  const accounts: PlanAccount[] = [...accts.keys()]
    .sort((a, b) => a - b)
    .map((n) => {
      const full = fullIn(n);
      const p: PlanAccount = {
        id: n,
        burnPctPerMin: Math.round(burnOn(n) * 1000) / 1000,
        ridesReset: rides(n),
        usable: usable(n),
      };
      if (Number.isFinite(full)) p.fullInMin = Math.round(full * 10) / 10;
      return p;
    });
  return { next: best?.n ?? null, accounts };
}

function lexLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x !== y) return x < y;
  }
  return false;
}
