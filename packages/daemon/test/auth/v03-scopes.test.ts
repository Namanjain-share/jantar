import { describe, expect, it } from 'vitest';
import { ALL_SCOPES, DEFAULT_DEVICE_SCOPES, GRANTED_ON_THE_MAC, editScopes, hasScope } from '../../src/auth/scopes.js';
import { DeviceAuth } from '../../src/auth/devices.js';
import { FakeClock } from '../../src/core/clock.js';
import { createMemoryDb } from '../../src/core/memory-db.js';

describe('the launch scope (v0.3)', () => {
  it('sits between control and admin, and no default pairing has it', () => {
    expect(ALL_SCOPES).toEqual(['read', 'control', 'launch', 'admin']);
    expect(DEFAULT_DEVICE_SCOPES).toEqual(['read', 'control']);
    expect(GRANTED_ON_THE_MAC).toEqual(['launch', 'admin']);
    expect(hasScope(['admin'], 'launch')).toBe(true);
    expect(hasScope(['launch'], 'control')).toBe(true);
    expect(hasScope(['control'], 'launch')).toBe(false);
  });

  it('editScopes adds along the chain and removes everything above what goes', () => {
    expect(editScopes(['read', 'control'], ['launch'])).toEqual(['read', 'control', 'launch']);
    expect(editScopes(['read', 'control', 'launch', 'admin'], [], ['launch'])).toEqual(['read', 'control']);
    expect(editScopes(['read', 'control', 'launch'], [], ['control'])).toEqual(['read']);
    // read always stays: revoking is how a device loses everything.
    expect(editScopes(['read', 'control'], [], ['read'])).toEqual(['read']);
    expect(editScopes(['read'], ['admin'], ['launch'])).toEqual(['read', 'control']);
  });

  it('DeviceAuth.setScopes normalizes, and refuses unknown or revoked devices', () => {
    const clock = new FakeClock();
    const auth = new DeviceAuth({ db: createMemoryDb(), clock });
    const { device } = auth.issue({ name: 'Phone', scopes: ['read', 'control'] });
    expect(auth.setScopes(device.id, ['launch'])?.scopes).toEqual(['read', 'control', 'launch']);
    expect(auth.get(device.id)?.scopes).toEqual(['read', 'control', 'launch']);
    expect(auth.setScopes('nope', ['read'])).toBeNull();
    auth.revoke(device.id);
    expect(auth.setScopes(device.id, ['admin'])).toBeNull();
  });
});
