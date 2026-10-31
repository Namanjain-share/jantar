/**
 * LK1: the kept accounts are a setting (accounts.kept, Mac only), empty by
 * default, and nothing in the code keeps an account. The launcher holds
 * kept ∪ autoswitch.hold ∪ ccw's live hold ∪ an account's own flag; a hold
 * added to ccw's switch.json while the daemon runs holds at the next
 * preview, with no restart; Rewrite (and Ask Claude) refuse a kept account
 * as "kept for other work".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsSchema, defaultSettings } from '@jantar/protocol';
import { keptAccounts } from '../../src/core/kept-accounts.js';
import { isHeld } from '../../src/launcher/account.js';
import { pickRunAccount, whyNot } from '../../src/rewrite/account.js';
import { T0, account, makeRig, type Rig } from '../launcher/helpers.js';

const PHONE = { kind: 'device' as const, deviceId: 'phone', scopes: ['read', 'control', 'launch'] as const };

let rig: Rig | null = null;
afterEach(async () => {
  await rig?.close();
  rig = null;
});

describe('keptAccounts', () => {
  it('reads settings accounts.kept, and is empty by default', () => {
    expect([...keptAccounts(defaultSettings())]).toEqual([]);
    expect([...keptAccounts(SettingsSchema.parse({ accounts: { kept: [3, 5] } }))]).toEqual([3, 5]);
  });

  it('isHeld is the union of the kept accounts, the hold lists and the flag', () => {
    const kept = keptAccounts(SettingsSchema.parse({ accounts: { kept: [3] } }));
    const inp = { hold: new Set([4]), kept };
    expect(isHeld(account(3, 10), inp)).toBe(true);
    expect(isHeld(account(4, 10), inp)).toBe(true);
    expect(isHeld(account(6, 10, { held: true }), inp)).toBe(true);
    expect(isHeld(account(7, 10), inp)).toBe(false);
    // An empty kept list holds nothing by itself.
    expect(isHeld(account(3, 10), { hold: new Set(), kept: keptAccounts(defaultSettings()) })).toBe(false);
  });

  it("a hold added to ccw's switch.json while the daemon runs holds at the next preview, no restart", async () => {
    rig = await makeRig({ settings: { accounts: { kept: [] } } });
    const preview = async () => {
      const r = await rig!.launcher.preview({ root: 'r.work', path: 'alpha-app', account: 'auto' }, { ...PHONE, scopes: [...PHONE.scopes] });
      if (!r.ok) throw new Error(r.reason);
      return r.preview;
    };
    // Nothing kept and no ccw: the emptiest account (5, 1 %) is Auto's pick.
    expect((await preview()).account.pick).toBe(5);
    rig.ccw.isPresent = true;
    rig.ccw.hold = [5, 2, 1];
    expect((await preview()).account.pick).toBe(7);
    rig.ccw.hold = [];
    await rig.ctx.settings.patch({ accounts: { kept: [5, 2, 1] } });
    expect((await preview()).account.pick).toBe(7);
  });

  it('Rewrite and Ask Claude refuse a kept account as "kept for other work"', () => {
    const fresh = { fetchedAt: T0 };
    const base = { accounts: [account(3, 0, fresh), account(7, 30, fresh)], hold: new Set<number>(), ceilingPct: 85, weeklyCeiling: 95, nowMs: Date.parse(T0) };
    const kept = keptAccounts(SettingsSchema.parse({ accounts: { kept: [3] } }));
    expect(whyNot(account(3, 0), { ...base, kept })).toBe('kept for other work');
    expect(pickRunAccount({ ...base, mode: 'cswap', kept })).toBe(7);
  });
});
