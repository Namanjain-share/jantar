/**
 * Account Auto (U3, spec 4.5.4) and security rule L6: Auto never returns a
 * held account (a kept one, one on a hold list, or one flagged held) and
 * picks the one with the most 5-hour room; a manual pick of a held account
 * needs confirmHeld (the service test covers the start body). The kept
 * accounts here are a synthetic settings accounts.kept (LK1).
 *
 * v0.4: LL4 (a resume pinned to a profile's account leaves every other
 * account unpickable, with the reason; Auto never picks a kept account) and
 * LL6's pure half (single mode: Auto is account 0 with no hold or usage
 * logic). launcher.test.ts covers both through the service.
 */
import { describe, expect, it } from 'vitest';
import { SettingsSchema, type Account } from '@jantar/protocol';
import {
  SINGLE_ACCOUNT,
  SINGLE_REASON,
  accountRows,
  autoSkip,
  effective5h,
  groupAccount,
  isHeld,
  noRoomReason,
  notSelectable,
  pickAuto,
  pickSingle,
  pinRows,
  pinnedReason,
  singleRows,
  usageLine,
  type AccountInputs,
} from '../../src/launcher/account.js';
import { keptAccounts } from '../../src/core/kept-accounts.js';
import { T0, account, session } from './helpers.js';

const NOW = Date.parse(T0);

function inputs(accounts: Account[], over: Partial<AccountInputs> = {}): AccountInputs {
  return {
    accounts,
    sessions: [],
    nowMs: NOW,
    hold: new Set([1, 2, 5]),
    kept: new Set(),
    ceiling: 97,
    weeklyCeiling: 95,
    burnPerMin: 1,
    bookings: new Map(),
    busy: new Set(),
    timeZone: 'UTC',
    ...over,
  };
}

describe('Auto: the most 5-hour room', () => {
  it('picks the lowest 5-hour %, with the reason in mono-ready words', () => {
    const r = pickAuto(inputs([account(3, 60), account(4, 40), account(7, 12), account(9, 30)]));
    expect(r.pick).toBe(7);
    expect(r.reason).toBe('most room · 5h 12% · resets in 3h40 · 13:40');
  });

  it('L6: never a held account, even when it has the most room', () => {
    const all = [account(1, 0), account(2, 0), account(5, 0), account(7, 80)];
    expect(pickAuto(inputs(all)).pick).toBe(7);
    // Held by ccw's switch.json, by settings, or on the account itself: all the same.
    expect(pickAuto(inputs([account(1, 0, { held: true }), account(7, 50)], { hold: new Set() })).pick).toBe(7);
  });

  it('LK1: the kept accounts stay held with an empty hold list (no ccw, or its switch.json unread)', () => {
    const all = [account(1, 2), account(2, 3), account(5, 4), account(7, 50)];
    const kept = keptAccounts(SettingsSchema.parse({ accounts: { kept: [1, 2, 5] } }));
    const empty = inputs(all, { hold: new Set(), kept });
    expect(pickAuto(empty).pick).toBe(7);
    for (const id of kept) {
      const a = all.find((x) => x.id === id) as Account;
      expect(isHeld(a, empty), String(id)).toBe(true);
      expect(autoSkip(a, empty)).toBe('held');
    }
    expect(accountRows(empty).filter((r) => r.held).map((r) => r.id)).toEqual([1, 2, 5]);
    // An empty accounts.kept holds nothing by itself: nothing in the code keeps an account.
    const none = inputs(all, { hold: new Set(), kept: keptAccounts(SettingsSchema.parse({})) });
    expect(pickAuto(none).pick).toBe(1);
    expect(accountRows(none).filter((r) => r.held)).toEqual([]);
  });

  it('L6: with the held accounts out and every other account full, Auto has nothing', () => {
    const all = [account(1, 0), account(2, 0), account(5, 0), account(7, 98), account(8, 50, { sevenPct: 96 })];
    const r = pickAuto(inputs(all));
    expect(r.pick).toBeNull();
    expect(r.reason).toBe('No account has room until 13:40 (07 resets)');
  });

  it('skips disabled, logged-out, api-key and unread accounts', () => {
    const all = [
      account(3, 1, { disabled: true }),
      account(4, 1, { usageStatus: 'token_expired' }),
      account(5, 1, { usageStatus: 'api_key' }),
      { ...account(8, 1), windows: [] },
      account(9, 70),
    ];
    const inp = inputs(all);
    expect(pickAuto(inp).pick).toBe(9);
    expect(all.map((a) => autoSkip(a, inp))).toEqual(['disabled', 'token expired', 'api key', 'no usage reading', null]);
  });

  it('an account resetting within 15 minutes counts as empty', () => {
    const soon = account(4, 90, { resetsAt: '2026-01-15T10:09:00.000Z' });
    const inp = inputs([soon, account(7, 12)]);
    expect(effective5h(soon, inp)).toBe(0);
    expect(pickAuto(inp)).toEqual({ pick: 4, reason: 'most room · 5h 90% · resets in 9m · 10:09' });
  });

  it('bookings: launches in the last 30 min count as a typical session each, so quick starts spread out', () => {
    const all = [account(4, 20), account(7, 12)];
    expect(pickAuto(inputs(all)).pick).toBe(7);
    // One booking on 07 = 1 %/min x 30 min: 12 + 30 = 42 > 20.
    expect(pickAuto(inputs(all, { bookings: new Map([[7, 1]]) })).pick).toBe(4);
  });

  it('one launch per account at a time: an account still starting one is passed over', () => {
    const all = [account(4, 20), account(7, 12)];
    expect(pickAuto(inputs(all, { busy: new Set([7]) })).pick).toBe(4);
    expect(pickAuto(inputs([account(7, 12)], { busy: new Set([7]) })).pick).toBeNull();
  });

  it('with room only on accounts busy with another launch, says that instead of "no room"', () => {
    expect(pickAuto(inputs([account(7, 12), account(9, 99)], { busy: new Set([7]) }))).toEqual({
      pick: null,
      reason: 'A session is already starting on 07, the only account with room. Try again once it is ready.',
    });
    expect(pickAuto(inputs([account(4, 20), account(7, 12), account(1, 0)], { busy: new Set([4, 7, 1]) })).reason).toBe(
      'A session is already starting on each account with room (04, 07). Try again once one is ready.',
    );
    // A busy account past the ceiling has no room either way.
    expect(pickAuto(inputs([account(7, 98)], { busy: new Set([7]) })).reason).toBe('No account has room until 13:40 (07 resets)');
  });

  it('ties go to the lower 7-day %, then fewer live sessions, then the lower id', () => {
    expect(pickAuto(inputs([account(4, 10, { sevenPct: 50 }), account(7, 10, { sevenPct: 30 })])).pick).toBe(7);
    const live = [session({ sid: 's1', account: 4 }), session({ sid: 's2', account: 4 })];
    expect(pickAuto(inputs([account(4, 10), account(7, 10)], { sessions: live })).pick).toBe(7);
    expect(pickAuto(inputs([account(7, 10), account(4, 10)])).pick).toBe(4);
  });

  it('uses the ceilings in force', () => {
    expect(pickAuto(inputs([account(7, 90)], { ceiling: 85 })).pick).toBeNull();
    expect(pickAuto(inputs([account(7, 90)], { ceiling: 97 })).pick).toBe(7);
  });

  it('with nothing that will ever reset, says so plainly', () => {
    expect(noRoomReason(inputs([]))).toBe('No account has room right now');
  });
});

describe('the account picker rows', () => {
  it('every account by id, with its readings, live count, held tag and why it cannot be picked', () => {
    const rows = accountRows(
      inputs([account(7, 12, { alias: 'work' }), account(2, 3), account(4, 1, { usageStatus: 'relogin_required' })], {
        sessions: [session({ sid: 'a', account: 7 }), session({ sid: 'b', account: 7, status: 'ended' })],
      }),
    );
    expect(rows).toEqual([
      { id: 2, label: '02', live: 0, selectable: true, held: true, fiveHourPct: 3, sevenDayPct: 20, resetsAt: '2026-01-15T13:40:00.000Z' },
      { id: 4, label: '04', live: 0, selectable: false, held: false, fiveHourPct: 1, sevenDayPct: 20, resetsAt: '2026-01-15T13:40:00.000Z', why: 'needs a re-login' },
      { id: 7, label: 'work', live: 1, selectable: true, held: false, fiveHourPct: 12, sevenDayPct: 20, resetsAt: '2026-01-15T13:40:00.000Z' },
    ]);
  });

  it('notSelectable names the reason in the picker words', () => {
    expect(notSelectable(account(1, 0))).toBeNull();
    expect(notSelectable(account(1, 0, { usageStatus: 'some_new_state' }))).toBe('some new state');
    expect(usageLine({ ...account(1, 0), windows: [] }, inputs([]))).toBe('no usage reading');
  });
});

describe('ccw groups', () => {
  it("finds the account a folder's group lives on", () => {
    const groups = [['web', 'api'], ['infra']];
    const sessions = [session({ sid: 'w', folder: 'web', account: 4 }), session({ sid: 'x', folder: 'other', account: 9 })];
    expect(groupAccount('api', 'api', groups, sessions)).toEqual({ label: 'web+api', account: 4 });
    expect(groupAccount('API', undefined, groups, sessions)).toEqual({ label: 'web+api', account: 4 });
    expect(groupAccount('infra', undefined, groups, sessions)).toBeNull();
    expect(groupAccount('lone', undefined, groups, sessions)).toBeNull();
  });
});

describe('v0.4: a resume pins its account (LL4)', () => {
  it('every other account says where the conversation is and cannot be picked; the pinned row is unchanged', () => {
    const inp = inputs([account(3, 60), account(4, 40), account(7, 12, { alias: 'work' })], { hold: new Set() });
    const rows = accountRows(inp);
    const pinned = pinRows(rows, 4);
    expect(pinnedReason(4)).toBe('This conversation is on 04');
    expect(pinned.find((r) => r.id === 4)).toEqual(rows.find((r) => r.id === 4));
    expect(pinned.filter((r) => r.id !== 4).map((r) => [r.id, r.selectable, r.why])).toEqual([
      [3, false, 'This conversation is on 04'],
      [7, false, 'This conversation is on 04'],
    ]);
    // A pin never makes a held account look free.
    const held = pinRows(accountRows(inputs([account(1, 2), account(7, 12)], { kept: new Set([1]) })), 1);
    expect(held.find((r) => r.id === 1)).toMatchObject({ selectable: true, held: true });
  });

  it('LL4: Auto never picks an account in accounts.kept, however much room it has', () => {
    const kept = keptAccounts(SettingsSchema.parse({ accounts: { kept: [3, 9] } }));
    const all = [account(3, 0), account(9, 1), account(4, 70), account(7, 50)];
    const inp = inputs(all, { hold: new Set(), kept });
    expect(pickAuto(inp).pick).toBe(7);
    expect(autoSkip(account(3, 0), inp)).toBe('held');
    // With only kept accounts left, Auto has nothing; it never falls back to one.
    expect(pickAuto(inputs([account(3, 0), account(9, 1)], { hold: new Set(), kept })).pick).toBeNull();
  });
});

describe('v0.4: single-account mode (LL6)', () => {
  it('Auto is account 0 with the one-login reason, and the picker has that one row, never held', () => {
    expect(SINGLE_ACCOUNT).toBe(0);
    expect(pickSingle()).toEqual({ pick: 0, reason: SINGLE_REASON });
    const sessions = [session({ sid: 'a', account: 0 }), session({ sid: 'b', account: 0, status: 'ended' }), session({ sid: 'c', account: 7 })];
    expect(singleRows(sessions)).toEqual([{ id: 0, label: 'Claude', live: 1, selectable: true, held: false }]);
  });
});
