/**
 * Building Account objects from cswap's files and from `cswap list --json`.
 * Pure functions (no I/O).
 *
 * cache/usage.json (schemaVersion 2) rows are keyed by slot and guarded by
 * (email, organizationUuid): a row whose identity does not match the slot in
 * sequence.json belongs to an account that used to be in that slot and is
 * ignored, as cswap itself does. The trust rule mirrors cswap's read model
 * (usage_store.entries): fresh for 300 s; up to 3600 s while cswap is backing
 * off or has scheduled the next poll; after a 429 until the soonest window
 * resets (at most 7200 s).
 *
 * Addresses never leave this module unmasked: Account carries `emailMasked`.
 */
import { maskEmail, type Account, type AccountId, type UsageWindow } from '@jantar/protocol';
import type { SequenceInfo } from '../lib/cswap-files.js';
import { isObj, num, str, toEpochMs, type Obj } from '../lib/values.js';

export const USAGE_SCHEMA_VERSION = 2;
const STALE_OK_S = 300;
const TRUST_MAX_AGE_S = 3600;
const RATE_LIMIT_TRUST_MAX_AGE_S = 7200;

/** Rows of cache/usage.json by slot, or null when the file is not schema 2. */
export function parseUsageCache(raw: unknown): Map<number, Obj> | null {
  if (!isObj(raw) || raw.schemaVersion !== USAGE_SCHEMA_VERSION || !isObj(raw.accounts)) return null;
  const rows = new Map<number, Obj>();
  for (const [k, v] of Object.entries(raw.accounts)) {
    const id = Number(k);
    if (Number.isInteger(id) && id >= 0 && isObj(v)) rows.set(id, v);
  }
  return rows;
}

/** One usage window; a window whose reset time has passed counts as 0% (ccw `windows()`). */
function makeWindow(kind: string, pct: unknown, resetsAt: unknown, nowMs: number): UsageWindow | null {
  const p = num(pct);
  if (p === undefined) return null;
  const resetMs = toEpochMs(resetsAt);
  if (resetMs !== undefined && resetMs <= nowMs) return { kind, pct: 0 };
  const w: UsageWindow = { kind, pct: p };
  if (resetMs !== undefined) w.resetsAt = new Date(resetMs).toISOString();
  return w;
}

/** Windows from a cache row's `lastGood` (snake_case, as cswap stores the API reading). */
export function windowsFromLastGood(lastGood: unknown, nowMs: number): UsageWindow[] {
  if (!isObj(lastGood)) return [];
  const out: UsageWindow[] = [];
  const add = (w: UsageWindow | null) => w && out.push(w);
  if (isObj(lastGood.five_hour)) add(makeWindow('five_hour', lastGood.five_hour.pct, lastGood.five_hour.resets_at, nowMs));
  if (isObj(lastGood.seven_day)) add(makeWindow('seven_day', lastGood.seven_day.pct, lastGood.seven_day.resets_at, nowMs));
  if (Array.isArray(lastGood.scoped)) {
    for (const s of lastGood.scoped) {
      if (isObj(s) && str(s.name)) add(makeWindow(`scoped:${s.name as string}`, s.pct, s.resets_at, nowMs));
    }
  }
  return out;
}

/** Windows from `cswap list --json` (camelCase). */
export function windowsFromCli(usage: unknown, nowMs: number): UsageWindow[] {
  if (!isObj(usage)) return [];
  const out: UsageWindow[] = [];
  const add = (w: UsageWindow | null) => w && out.push(w);
  if (isObj(usage.fiveHour)) add(makeWindow('five_hour', usage.fiveHour.pct, usage.fiveHour.resetsAt, nowMs));
  if (isObj(usage.sevenDay)) add(makeWindow('seven_day', usage.sevenDay.pct, usage.sevenDay.resetsAt, nowMs));
  if (Array.isArray(usage.scoped)) {
    for (const s of usage.scoped) {
      if (isObj(s) && str(s.name)) add(makeWindow(`scoped:${s.name as string}`, s.pct, s.resetsAt, nowMs));
    }
  }
  return out;
}

function earliestReset(lastGood: unknown): number | undefined {
  if (!isObj(lastGood)) return undefined;
  const times: number[] = [];
  for (const w of [lastGood.five_hour, lastGood.seven_day, ...(Array.isArray(lastGood.scoped) ? lastGood.scoped : [])]) {
    if (isObj(w)) {
      const t = toEpochMs(w.resets_at);
      if (t !== undefined) times.push(t);
    }
  }
  return times.length ? Math.min(...times) : undefined;
}

/** Whether cswap would treat a cache row's last-good reading as current (see module comment). */
export function cacheRowTrusted(row: Obj, nowMs: number): boolean {
  const fetchedS = num(row.fetchedAt);
  if (fetchedS === undefined || !isObj(row.lastGood)) return false;
  const nowS = nowMs / 1000;
  const ageS = nowS - fetchedS;
  if (ageS < 0) return true;
  if (ageS <= STALE_OK_S) return true;
  let withinCeiling: boolean;
  if (row.lastError === 'http-429') {
    const ceiling = nowS + (RATE_LIMIT_TRUST_MAX_AGE_S - ageS);
    const soonestMs = earliestReset(row.lastGood);
    withinCeiling = nowS < (soonestMs !== undefined ? Math.min(soonestMs / 1000, ceiling) : ceiling);
  } else {
    withinCeiling = ageS <= TRUST_MAX_AGE_S;
  }
  if (!withinCeiling) return false;
  const failures = num(row.consecutiveFailures) ?? 0;
  const nextPollAt = num(row.nextPollAt);
  const claimUntil = num(row.claimUntil);
  return failures > 0 || (nextPollAt !== undefined && nowS < nextPollAt) || (claimUntil !== undefined && nowS < claimUntil);
}

function baseAccount(id: AccountId, email: string, alias: string | undefined, active: AccountId | null, disabled: boolean, held: ReadonlySet<number>): Account {
  const a: Account = {
    id,
    emailMasked: maskEmail(email),
    isDefaultLogin: active === id,
    disabled,
    held: held.has(id),
    usageStatus: 'unavailable',
    windows: [],
  };
  if (alias) a.alias = alias;
  return a;
}

function setFetched(a: Account, fetchedMs: number | undefined, nowMs: number): void {
  if (fetchedMs === undefined) return;
  a.fetchedAt = new Date(fetchedMs).toISOString();
  a.ageS = Math.max(0, Math.round((nowMs - fetchedMs) / 1000));
}

/** Accounts from sequence.json + cache/usage.json (`rows` null = no usable cache). */
export function accountsFromCache(
  seq: SequenceInfo,
  rows: ReadonlyMap<number, Obj> | null,
  nowMs: number,
  held: ReadonlySet<number>,
): Account[] {
  const out: Account[] = [];
  for (const id of seq.order) {
    const s = seq.accounts.get(id);
    if (!s) continue;
    const a = baseAccount(id, s.email, s.alias, seq.active, s.disabled, held);
    if (s.kind === 'api_key') {
      a.usageStatus = 'api_key';
      out.push(a);
      continue;
    }
    const row = rows?.get(id);
    const matches = row !== undefined && row.email === s.email && (str(row.organizationUuid) ?? '') === s.organizationUuid;
    if (row && matches) {
      a.windows = windowsFromLastGood(row.lastGood, nowMs);
      setFetched(a, toEpochMs(row.fetchedAt), nowMs);
      if ((num(row.authDeadStrikes) ?? 0) >= 1) a.usageStatus = 'relogin_required';
      else a.usageStatus = cacheRowTrusted(row, nowMs) ? 'ok' : 'unavailable';
    }
    out.push(a);
  }
  return out;
}

export interface CliUsage {
  active: AccountId | null;
  accounts: Map<AccountId, { account: Account; fetchedMs?: number }>;
}

/** Parse `cswap list --json`; null when it is an error or not the expected shape. */
export function parseCliList(raw: unknown, nowMs: number, held: ReadonlySet<number>): CliUsage | null {
  if (!isObj(raw) || isObj(raw.error) || !Array.isArray(raw.accounts)) return null;
  const activeRaw = num(raw.activeAccountNumber);
  const active = activeRaw !== undefined && Number.isInteger(activeRaw) ? activeRaw : null;
  const accounts = new Map<AccountId, { account: Account; fetchedMs?: number }>();
  for (const row of raw.accounts) {
    if (!isObj(row)) continue;
    const id = num(row.number);
    if (id === undefined || !Number.isInteger(id) || id < 0) continue;
    const a = baseAccount(id, str(row.email) ?? '', str(row.alias) || undefined, active, row.disabled === true, held);
    a.isDefaultLogin = row.active === true || active === id;
    a.usageStatus = str(row.usageStatus) ?? 'unavailable';
    const usage = isObj(row.usage) ? row.usage : isObj(row.lastGoodUsage) ? row.lastGoodUsage : null;
    a.windows = windowsFromCli(usage, nowMs);
    const fetchedMs = toEpochMs(isObj(row.usage) ? row.usageFetchedAt : row.lastGoodFetchedAt);
    setFetched(a, fetchedMs, nowMs);
    accounts.set(id, fetchedMs !== undefined ? { account: a, fetchedMs } : { account: a });
  }
  return { active, accounts };
}

/**
 * The cache view with a recent CLI result laid over it: cswap's own
 * usageStatus (it knows about expired tokens, Keychain trouble, ...) and,
 * per account, whichever reading is newer.
 */
export function overlayCli(cache: Account[], cli: CliUsage): Account[] {
  const out: Account[] = [];
  const seen = new Set<AccountId>();
  for (const a of cache) {
    seen.add(a.id);
    const c = cli.accounts.get(a.id);
    if (!c || c.account.emailMasked !== a.emailMasked) {
      out.push(a);
      continue;
    }
    const cacheMs = a.fetchedAt ? Date.parse(a.fetchedAt) : -Infinity;
    const cliNewer = (c.fetchedMs ?? -Infinity) >= cacheMs;
    const merged: Account = { ...(cliNewer ? c.account : a), usageStatus: c.account.usageStatus };
    merged.held = a.held;
    merged.disabled = a.disabled || c.account.disabled;
    out.push(merged);
  }
  for (const [id, c] of cli.accounts) if (!seen.has(id)) out.push(c.account);
  return out;
}

/** The comparable part of a snapshot (ages change every second and are left out). */
export function snapshotKey(accounts: readonly Account[], active: AccountId | null): string {
  return JSON.stringify({
    active,
    accounts: accounts.map((a) => {
      const { ageS: _ageS, ...rest } = a;
      return rest;
    }),
  });
}
