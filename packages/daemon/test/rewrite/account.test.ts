/**
 * Which account a Rewrite run uses (U5, spec 4.3): the most 5-hour room,
 * never a kept account (a synthetic settings accounts.kept here) or a held
 * one, skipping full, stale, disabled and recently failed accounts, sticky
 * for a while. Rule R4; LK1's Rewrite half. pickRunAccount (v0.4) is the
 * same pick for Rewrite and Ask Claude, account 0 in single-account mode.
 */
import { describe, expect, it, vi } from 'vitest';
import { AccountChooser, PENALTY_MS, fiveHourPct, pickRewriteAccount, pickRunAccount, weeklyPct, whyNot, type PickInput } from '../../src/rewrite/account.js';
import { T0 } from '../api/fakes.js';
import { account, makeRig, start, untilState } from './helpers.js';

const NOW = Date.parse(T0);
const base = (over: Partial<PickInput> = {}): PickInput => ({
  accounts: [],
  hold: new Set(),
  kept: new Set(),
  ceilingPct: 85,
  weeklyCeiling: 95,
  nowMs: NOW,
  ...over,
});

describe('pickRewriteAccount', () => {
  it('R4: never a kept account, even when it has the most room and is not held', () => {
    const accounts = [account(3, 0), account(5, 0), account(4, 60)];
    const kept = new Set([3, 5]);
    expect(pickRewriteAccount(base({ accounts, kept }))).toBe(4);
    expect(whyNot(account(3, 0), base({ kept }))).toBe('kept for other work');
    // An empty kept list keeps nothing by itself.
    expect(pickRewriteAccount(base({ accounts }))).toBe(3);
  });

  it('R4: with the kept and held accounts out and every other account full, nothing qualifies (null)', () => {
    const accounts = [
      account(1, 0, { held: true }),
      account(2, 0),
      account(7, 0),
      account(3, 85),
      account(4, 99),
      account(5, 40, { windows: [{ kind: 'five_hour', pct: 40 }, { kind: 'seven_day', pct: 96 }] }),
    ];
    expect(pickRewriteAccount(base({ accounts, hold: new Set([2]), kept: new Set([7]) }))).toBeNull();
  });

  it('pickRunAccount: account 0 in single mode, with no usage or hold logic; the cswap pick otherwise', () => {
    const accounts = [account(3, 0), account(4, 99), account(7, 30)];
    const kept = new Set([3]);
    expect(pickRunAccount({ ...base({ accounts }), mode: 'single', kept })).toBe(0);
    expect(pickRunAccount({ ...base({ accounts: [] }), mode: 'single', kept: new Set() })).toBe(0);
    // Tried already by this job: no second run on the one login.
    expect(pickRunAccount({ ...base({ accounts, penalized: new Set([0]) }), mode: 'single', kept })).toBeNull();
    expect(pickRunAccount({ ...base({ accounts }), mode: 'cswap', kept })).toBe(7);
  });

  it('takes the most 5-hour room, then the most weekly room, then the lowest id', () => {
    const w = (five: number, week: number) => [
      { kind: 'five_hour', pct: five },
      { kind: 'seven_day', pct: week },
    ];
    expect(pickRewriteAccount(base({ accounts: [account(9, 40), account(7, 30), account(8, 31)] }))).toBe(7);
    expect(pickRewriteAccount(base({ accounts: [account(9, 30, { windows: w(30, 50) }), account(8, 30, { windows: w(30, 10) })] }))).toBe(8);
    expect(pickRewriteAccount(base({ accounts: [account(9, 30), account(8, 30)] }))).toBe(8);
  });

  it('skips held, excluded, disabled, not-ok, stale, full, weekly-full and penalised accounts', () => {
    const cases: [string, ReturnType<typeof account>, Partial<PickInput>?][] = [
      ['held', account(3, 0, { held: true })],
      ['held', account(3, 0), { hold: new Set([3]) }],
      ['disabled', account(3, 0, { disabled: true })],
      ['token_expired', account(3, 0, { usageStatus: 'token_expired' })],
      ['usage too old', account(3, 0, { fetchedAt: new Date(NOW - 16 * 60_000).toISOString() })],
      ['usage too old', account(3, 0, { fetchedAt: undefined, ageS: undefined })],
      ['past the 5-hour ceiling', account(3, 85)],
      ['past the weekly ceiling', account(3, 0, { windows: [{ kind: 'five_hour', pct: 0 }, { kind: 'scoped:opus', pct: 95 }] })],
      ['failed recently', account(3, 0), { penalized: new Set([3]) }],
    ];
    for (const [why, a, over] of cases) {
      const input = base({ accounts: [a], ...over });
      expect(whyNot(a, input), why).toBe(why);
      expect(pickRewriteAccount(input), why).toBeNull();
    }
    // Usage just inside 15 minutes still counts; ageS is used when there is no fetchedAt.
    expect(whyNot(account(3, 0, { fetchedAt: new Date(NOW - 14 * 60_000).toISOString() }), base())).toBeNull();
    expect(whyNot(account(3, 0, { fetchedAt: undefined, ageS: 600 }), base())).toBeNull();
  });

  it('reads a 5-hour window that has reset since the reading as empty', () => {
    const reset = account(3, 99, { windows: [{ kind: 'five_hour', pct: 99, resetsAt: new Date(NOW - 1000).toISOString() }] });
    expect(fiveHourPct(reset, NOW)).toBe(0);
    expect(pickRewriteAccount(base({ accounts: [reset] }))).toBe(3);
    expect(weeklyPct(account(3, 0))).toBe(20);
    expect(weeklyPct(account(3, 0, { windows: [] }))).toBe(0);
  });

  it('keeps the sticky account while it qualifies, even when another has more room', () => {
    const accounts = [account(7, 50), account(9, 10)];
    expect(pickRewriteAccount(base({ accounts, sticky: 7 }))).toBe(7);
    expect(pickRewriteAccount(base({ accounts: [account(7, 90), account(9, 10)], sticky: 7 }))).toBe(9);
  });
});

describe('AccountChooser', () => {
  const STICKY = 30 * 60_000;

  it('sticks to its pick for stickyMin, then picks again', () => {
    const c = new AccountChooser();
    const at = (min: number) => {
      const nowMs = NOW + min * 60_000;
      const fetchedAt = new Date(nowMs).toISOString();
      return base({ accounts: [account(7, 40, { fetchedAt }), account(9, 5, { fetchedAt })], nowMs });
    };
    expect(c.pick(base({ accounts: [account(7, 10), account(9, 50)] }), STICKY)).toBe(7);
    // 9 now has more room, but 7 still qualifies and its time is not up.
    expect(c.pick(at(29), STICKY)).toBe(7);
    expect(c.pick(at(31), STICKY)).toBe(9);
  });

  it('a penalised account sits out PENALTY_MS (10 min), then comes back', () => {
    const c = new AccountChooser();
    const accounts = [account(7, 10), account(9, 50)];
    expect(c.pick(base({ accounts }), STICKY)).toBe(7);
    c.penalize(7, NOW);
    expect(PENALTY_MS).toBe(10 * 60_000);
    expect(c.pick(base({ accounts, nowMs: NOW + 9 * 60_000 }), STICKY)).toBe(9);
    expect(c.pick(base({ accounts, nowMs: NOW + 11 * 60_000 }), 0)).toBe(7);
  });

  it('skips accounts the job already tried', () => {
    const c = new AccountChooser();
    expect(c.pick(base({ accounts: [account(7, 10), account(9, 50)] }), STICKY, new Set([7]))).toBe(9);
    expect(c.pick(base({ accounts: [account(7, 10)] }), STICKY, new Set([7]))).toBeNull();
  });
});

describe('the service picks with the settings and ccw', () => {
  it('R4: the kept and held accounts out, the rest full: the job fails with no_account and nothing runs', async () => {
    const rig = makeRig({
      accounts: [account(1, 0, { held: true }), account(3, 0), account(5, 0), account(7, 90), account(9, 86)],
      settings: { rewrite: { enabled: true }, autoswitch: { hold: [1] }, accounts: { kept: [3, 5] } },
    });
    const page = vi.spyOn(rig.transcripts, 'page');
    try {
      const job = await start(rig, 'fix the flaky test');
      const d = await untilState(rig, job.id, ['failed']);
      // Nothing is read for a context no run would get.
      expect(page).not.toHaveBeenCalled();
      expect(d.job).toMatchObject({ failure: 'no_account', reason: 'No account has room for the prompt writer. Send what you said, or edit it.' });
      expect(d.job.account).toBeUndefined();
      expect(d.input).toBe('fix the flaky test');
      expect(rig.exec.calls).toHaveLength(0);
    } finally {
      await rig.close();
    }
  });

  it('rewrite.excludeAccounts, autoswitch.hold and ccw hold lists are all honoured', async () => {
    const rig = makeRig({
      accounts: [account(3, 5), account(4, 10), account(5, 15), account(7, 60)],
      settings: { rewrite: { enabled: true, excludeAccounts: [3] }, autoswitch: { hold: [4] } },
    });
    rig.ccw.isPresent = true;
    Object.assign(rig.ccw, { switchConfig: async () => ({ on: true, dryRun: false, hold: [5], groups: [] }) });
    try {
      const job = await start(rig, 'fix the flaky test');
      const d = await untilState(rig, job.id, ['ready']);
      expect(d.job.account).toBe(7);
      expect(rig.exec.calls[0]?.args.slice(0, 3)).toEqual(['run', '--share-history', '7']);
    } finally {
      await rig.close();
    }
  });

  it('rewrite.ceilingPct sets where an account counts as full', async () => {
    const rig = makeRig({ accounts: [account(7, 60)], settings: { rewrite: { enabled: true, ceilingPct: 50 } } });
    try {
      const job = await start(rig, 'fix the flaky test');
      expect((await untilState(rig, job.id, ['failed'])).job.failure).toBe('no_account');
    } finally {
      await rig.close();
    }
  });
});
