/**
 * v0.6 Fleet, lane L2: the start sheet's account on a server whose accounts
 * are config dirs (launcher/account.ts with `mode: 'dirs'`, spec 5).
 *
 * - Auto is ~/.claude (account 0) unless it is kept (or held, or disabled),
 *   else the lowest-numbered account that is not; with every account kept,
 *   no pick and the reason. Never past a pick that is starting another
 *   session (one launch per account at a time).
 * - No usage numbers: an account is usable unless disabled, a manual pick
 *   is never "unknown", and the picker rows carry no usage.
 * - Absent `mode`, every rule is cswap's as before.
 */
import { describe, expect, it } from 'vitest';
import type { Account } from '@jantar/protocol';
import {
  DIRS_ALL_KEPT,
  DIRS_DEFAULT_REASON,
  DIRS_NO_USAGE,
  accountRows,
  autoSkip,
  dirsRows,
  notSelectable,
  pickAuto,
  pickDirs,
  usageLine,
  type AccountInputs,
} from '../../src/launcher/account.js';
import { dirAccount } from '../../src/sources/cswap/dirs.js';

const NOW = Date.UTC(2026, 10, 1, 10, 0, 0);

const roster = (): Account[] => [
  dirAccount({ id: 0, alias: 'claude', dir: '/home/sam/.claude' }),
  dirAccount({ id: 1, alias: 'work', dir: '/home/sam/.claude-work' }),
  dirAccount({ id: 2, alias: 'ops', dir: '/home/sam/.claude-ops' }),
];

function inputs(over: Partial<AccountInputs> = {}): AccountInputs {
  return {
    accounts: roster(),
    sessions: [],
    nowMs: NOW,
    hold: new Set(),
    kept: new Set(),
    ceiling: 97,
    weeklyCeiling: 95,
    burnPerMin: 1,
    bookings: new Map(),
    busy: new Set(),
    timeZone: 'UTC',
    mode: 'dirs',
    ...over,
  };
}

describe('Auto in dirs mode', () => {
  it('is ~/.claude, whatever the order of the roster', () => {
    expect(pickAuto(inputs())).toEqual({ pick: 0, reason: DIRS_DEFAULT_REASON });
    expect(pickAuto(inputs({ accounts: roster().reverse() }))).toEqual({ pick: 0, reason: 'the default login (~/.claude)' });
  });

  it('a kept ~/.claude: the lowest-numbered account that is not kept', () => {
    expect(pickAuto(inputs({ kept: new Set([0]) }))).toEqual({ pick: 1, reason: 'the first account not kept (work)' });
    expect(pickAuto(inputs({ kept: new Set([0, 1]) })).pick).toBe(2);
    // held on a hold list, or disabled, counts the same
    expect(pickAuto(inputs({ hold: new Set([0]) })).pick).toBe(1);
    expect(pickAuto(inputs({ accounts: [{ ...roster()[0] as Account, disabled: true }, ...roster().slice(1)] })).pick).toBe(1);
  });

  it('every account kept: no pick, and the sentence', () => {
    expect(pickAuto(inputs({ kept: new Set([0, 1, 2]) }))).toEqual({ pick: null, reason: DIRS_ALL_KEPT });
    expect(DIRS_ALL_KEPT).toBe('Every account on this machine is kept or held: pick one');
  });

  it('never moves past its pick when that one is starting another session', () => {
    expect(pickAuto(inputs({ busy: new Set([0]) }))).toEqual({ pick: null, reason: 'A session is already starting on 00. Try again once it is ready.' });
    expect(pickAuto(inputs({ busy: new Set([1]) })).pick).toBe(0);
  });

  it('pickDirs is what pickAuto runs in dirs mode', () => {
    expect(pickDirs(inputs({ kept: new Set([0]) }))).toEqual(pickAuto(inputs({ kept: new Set([0]) })));
  });
});

describe('no usage numbers in dirs mode', () => {
  it('an account is usable unless disabled; a manual pick is never "unknown"', () => {
    const [plain] = roster() as [Account];
    expect(notSelectable(plain, { mode: 'dirs' })).toBeNull();
    expect(notSelectable({ ...plain, disabled: true }, { mode: 'dirs' })).toBe('disabled');
    expect(autoSkip(plain, inputs())).toBeNull();
    expect(autoSkip(plain, inputs({ kept: new Set([0]) }))).toBe('held');
    expect(usageLine(plain, inputs())).toBe(DIRS_NO_USAGE);
  });

  it('the picker: every account selectable, held when kept, no usage fields', () => {
    const rows = accountRows(inputs({ kept: new Set([1]) }));
    expect(rows).toEqual(dirsRows(inputs({ kept: new Set([1]) })));
    expect(rows).toEqual([
      { id: 0, label: 'claude', live: 0, selectable: true, held: false },
      { id: 1, label: 'work', live: 0, selectable: true, held: true },
      { id: 2, label: 'ops', live: 0, selectable: true, held: false },
    ]);
  });

  it('without mode the same accounts follow cswap\'s rules (no usage reading: not selectable, no Auto)', () => {
    const cswap = inputs({ mode: undefined });
    expect(notSelectable(roster()[0] as Account)).toBe('unknown');
    expect(pickAuto(cswap).pick).toBeNull();
    expect(accountRows(cswap).every((r) => !r.selectable)).toBe(true);
  });
});
