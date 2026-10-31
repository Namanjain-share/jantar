/**
 * Where the start sheet's pickers begin (U7): the phone's own picks, then
 * this actor's last start, then launch.defaultFlags.
 */
import { describe, expect, it } from 'vitest';
import { V03_LAUNCH_FLAGS, type LaunchFlags } from '@jantar/protocol';
import { startingFlags } from '../../src/launcher/flags.js';

const LAST: LaunchFlags = { permission: 'plan', chrome: false, effort: 'high', model: 'opus' };

describe('startingFlags', () => {
  it('a first start begins at launch.defaultFlags (here v0.3 defaults, as a config migrated from v0.3 keeps them)', () => {
    expect(startingFlags({}, null, V03_LAUNCH_FLAGS)).toEqual({ permission: 'skip', chrome: true, effort: 'ultracode', model: 'default' });
  });

  it("then this actor's last flags", () => {
    expect(startingFlags({}, LAST, V03_LAUNCH_FLAGS)).toEqual(LAST);
  });

  it('and the picks the sheet already changed win, one by one', () => {
    expect(startingFlags({ chrome: true, model: 'default' }, LAST, V03_LAUNCH_FLAGS)).toEqual({ ...LAST, chrome: true, model: 'default' });
    expect(startingFlags({ permission: 'manual' }, null, V03_LAUNCH_FLAGS)).toEqual({ ...V03_LAUNCH_FLAGS, permission: 'manual' });
  });

  it('a stored row that no longer parses falls back to the defaults', () => {
    const odd = { permission: 'profile-x', chrome: true, effort: 'low', model: 'default' } as unknown as LaunchFlags;
    expect(startingFlags({}, odd, V03_LAUNCH_FLAGS)).toEqual(V03_LAUNCH_FLAGS);
  });
});
