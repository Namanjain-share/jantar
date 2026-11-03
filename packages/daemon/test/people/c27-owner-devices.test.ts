/**
 * v0.11 People, C27 (spec 8.5, no stealth devices): when one of his devices
 * can newly open her space (paired with control, or raised to control), the
 * Activity of each person sharing (active or paused) gets a row naming it;
 * a read-only pairing writes none, nor does anyone ending or gone. A device
 * added and later revoked still leaves its row. Synthetic people only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersonActivityResponse, PersonMe } from '@jantar/protocol/people';
import { pairCookie } from '../api/fakes.js';
import { makeFixture, onHer, type Fixture } from './isolation-fixture.js';

let f: Fixture;
beforeEach(async () => {
  f = await makeFixture();
}, 60_000);
afterEach(async () => {
  await f?.close();
});

const rows = async (cred: Fixture['asha']['full']) => ((await onHer(f.api, 'GET', '/v1/p/activity', cred)).json() as PersonActivityResponse).activity.filter((r) => r.action === 'owner.device');

describe('C27: his new devices are in her Activity', () => {
  it('a control pairing writes a row for each person sharing; read-only writes none', async () => {
    const before = (await rows(f.asha.full)).length;
    await pairCookie(f.api, ['read'], 'Sam watch');
    expect(await rows(f.asha.full)).toHaveLength(before);
    const tablet = await pairCookie(f.api, ['read', 'control'], 'Sam tablet');
    const asha = await rows(f.asha.full);
    expect(asha).toHaveLength(before + 1);
    expect(asha[0]).toMatchObject({ actor: 'owner', action: 'owner.device', device: 'Sam tablet' });
    // Bea shares too; Cara is paused and still told.
    expect((await rows(f.bea.full)).some((r) => r.device === 'Sam tablet')).toBe(true);
    expect((await rows(f.cara.full)).some((r) => r.device === 'Sam tablet')).toBe(true);
    // Her Sharing lists it live.
    const me = (await onHer(f.api, 'GET', '/v1/p/me', f.asha.full)).json() as PersonMe;
    expect(me.ownerDevices.map((d) => d.name)).toContain('Sam tablet');
    // Revoked later, the row stays.
    expect((await f.api.ctl.inject({ method: 'DELETE', url: `/v1/devices/${tablet.deviceId}` })).statusCode).toBe(200);
    expect((await rows(f.asha.full)).some((r) => r.device === 'Sam tablet')).toBe(true);
  });

  it('raising a read-only device to control writes the row then, once', async () => {
    const watch = await pairCookie(f.api, ['read'], 'Sam watch');
    const before = (await rows(f.asha.full)).length;
    const r = await f.api.ctl.inject({ method: 'POST', url: `/v1/devices/${watch.deviceId}/scopes`, payload: { add: ['control'] } });
    expect(r.statusCode, r.body).toBe(200);
    expect(await rows(f.asha.full)).toHaveLength(before + 1);
    // Adding launch to a device that already has control is no new reach.
    expect((await f.api.ctl.inject({ method: 'POST', url: `/v1/devices/${watch.deviceId}/scopes`, payload: { add: ['launch'] } })).statusCode).toBe(200);
    expect(await rows(f.asha.full)).toHaveLength(before + 1);
  });
});
