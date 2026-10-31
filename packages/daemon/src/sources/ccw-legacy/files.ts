/**
 * The legacy ccw tool's file formats (~/.config/ccw), parsed read-only.
 *
 *   switch.json          autoswitch config (on, dry_run, hold, ceilings, groups, prompts)
 *   switch/<sid>.json    a move in progress, parked or stuck
 *   switch/<sid>.lock    flock held by the ccw process running that move
 *   switch/burn.json     sid -> [avg %/min, updated (epoch s), latest %/min]  (older entries: 2 fields)
 *   active.json          sid -> when it last worked (epoch s)
 *
 * Nothing here writes to ccw's files: ccw rewrites them itself.
 */
import { MoveSchema, MoveStepSchema, type Move, type MoveStep } from '@jantar/protocol';
import { bool, int, isObj, nonEmpty, num, str, toIso } from '../lib/values.js';

/** Steps during which ccw is typing into the session. */
export const ACTIVE_MOVE_STEPS: readonly MoveStep[] = ['saving', 'restarting', 'continuing'];

const STEP_WORDS: Record<string, string> = {
  saving: 'saving its workflows',
  restarting: 'restarting',
  continuing: 'sending continue',
};

export interface RawMove {
  sid: string;
  step: string;
  sinceMs: number;
  ownerPid?: number;
}

/** A move file's essentials, even when it doesn't fit our schema (used for "is it busy?"). */
export function parseRawMove(raw: unknown): RawMove | null {
  if (!isObj(raw)) return null;
  const sid = nonEmpty(raw.sid);
  const step = nonEmpty(raw.step);
  const since = num(raw.since);
  if (!sid || !step || since === undefined) return null; // not a move (a stray or hand-made file)
  const m: RawMove = { sid, step, sinceMs: since > 1e11 ? since : since * 1000 };
  const owner = int(raw.owner) ?? int(raw.ownerPid);
  if (owner !== undefined && owner > 0) m.ownerPid = owner;
  return m;
}

/**
 * A ccw move file as our Move. A move whose ccw process is gone partway is
 * shown the way ccw itself would show it: stuck, orphan (ccw's own move_state
 * would rewrite the file so; we only read). Null if it doesn't fit.
 */
export function parseMove(raw: unknown, isAlive: (pid: number) => boolean): Move | null {
  const r = parseRawMove(raw);
  if (!r || !isObj(raw)) return null;
  const stepParsed = MoveStepSchema.safeParse(r.step);
  if (!stepParsed.success) return null;
  const from = int(raw.from);
  if (from === undefined || from < 0) return null;
  const since = toIso(r.sinceMs);
  if (!since) return null;
  const m: Move = { sid: r.sid, from, step: stepParsed.data, why: str(raw.why) ?? '', since };
  const to = int(raw.to);
  if (to !== undefined && to >= 0) m.to = to;
  if (r.ownerPid !== undefined) m.ownerPid = r.ownerPid;
  const wakeAt = toIso(raw.wake_at ?? raw.wakeAt);
  if (wakeAt) m.wakeAt = wakeAt;
  const at = toIso(raw.at);
  if (at) m.at = at;
  for (const [src, dst] of [
    ['ran_out', 'ranOut'],
    ['retry', 'retry'],
    ['orphan', 'orphan'],
  ] as const) {
    const v = bool(raw[src] ?? raw[dst]);
    if (v !== undefined) m[dst] = v;
  }
  const name = nonEmpty(raw.name);
  if (name) m.name = name;
  const folder = nonEmpty(raw.folder);
  if (folder) m.folder = folder;
  // ccw treats a move without an owner pid as alive (alive(None) is True there)
  if (ACTIVE_MOVE_STEPS.includes(m.step) && m.ownerPid !== undefined && !isAlive(m.ownerPid)) {
    m.why = `the ccw moving it stopped while ${STEP_WORDS[m.step] ?? m.step}`;
    m.step = 'stuck';
    m.orphan = true;
  }
  const checked = MoveSchema.safeParse(m);
  return checked.success ? checked.data : null;
}

export interface BurnEntry {
  sid: string;
  /** ccw's Burn.value(): the higher of average and latest, capped at 20 %/min. */
  pctPerMin: number;
  updatedMs: number;
}

/** burn.json: `{sid: [avg, updated, latest]}`; entries from before `latest` existed have two fields. */
export function parseBurn(raw: unknown): BurnEntry[] {
  if (!isObj(raw)) return [];
  const out: BurnEntry[] = [];
  for (const [sid, hit] of Object.entries(raw)) {
    if (!Array.isArray(hit) || hit.length < 2) continue;
    const avg = num(hit[0]);
    const updated = num(hit[1]);
    if (avg === undefined || updated === undefined) continue;
    const latest = hit.length > 2 ? num(hit[2]) : undefined;
    const value = Math.min(20, latest !== undefined ? Math.max(avg, latest) : avg);
    const updatedMs = updated > 1e11 ? updated : updated * 1000;
    out.push({ sid, pctPerMin: Math.max(0, value), updatedMs });
  }
  return out.sort((a, b) => a.sid.localeCompare(b.sid));
}

/** active.json: sid -> when it last worked (epoch ms). */
export function parseActive(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!isObj(raw)) return out;
  for (const [sid, t] of Object.entries(raw)) {
    const v = num(t);
    if (v !== undefined) out.set(sid, v > 1e11 ? v : v * 1000);
  }
  return out;
}

/** ccw's switch.json, with ccw's own behaviour for missing keys (except the hold list, which is personal). */
export interface CcwSwitchConfig {
  on: boolean;
  dryRun: boolean;
  hold: number[];
  groups: string[][];
  ceiling: number;
  leadMin: number;
  parkLeadMin: number;
  minRunMin: number;
  weeklyCeiling: number;
  burnDefault: number;
}

export function parseSwitchConfig(raw: unknown): CcwSwitchConfig | null {
  if (!isObj(raw)) return null;
  const n = (v: unknown, d: number) => num(v) ?? d;
  const hold = Array.isArray(raw.hold) ? raw.hold.filter((x): x is number => Number.isInteger(x) && (x as number) >= 0) : [];
  const groups = Array.isArray(raw.groups)
    ? raw.groups
        .filter((g): g is unknown[] => Array.isArray(g))
        .map((g) => g.filter((x): x is string => typeof x === 'string' && x.trim() !== ''))
        .filter((g) => g.length > 0)
    : [];
  return {
    on: bool(raw.on) ?? true, // ccw's default when the key is missing
    dryRun: bool(raw.dry_run) ?? false,
    hold,
    groups,
    ceiling: n(raw.ceiling, 97),
    leadMin: n(raw.lead_min, 10),
    parkLeadMin: n(raw.park_lead_min, 5),
    minRunMin: n(raw.min_run_min, 20),
    weeklyCeiling: n(raw.weekly_ceiling, 95),
    burnDefault: n(raw.burn_default, 1.0),
  };
}

