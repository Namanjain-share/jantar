/**
 * v0.11 People (P2): her status (spec 3.7).
 *
 * - Okay, Low or Need space, with a short line; it ends after 12 h unless
 *   she says otherwise, and Okay with no line clears it.
 * - He reads it on his Today while see.plan is on (a locked tile when off),
 *   and her mirror shows the same.
 * - Need space holds his normal alerts until it ends or she clears it;
 *   Urgent still follows her quiet-hours rule; clearing it releases one
 *   summary.
 * - No owner route sets it (T14).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PEOPLE_ROUTES, type PersonOwnToday, type PersonToday } from '@jantar/protocol/people';
import { makeFixture, type Fixture } from './isolation-fixture.js';
import { EP, kit } from './p2-kit.js';

let f: Fixture;
const k = kit(() => f);
beforeEach(async () => {
  f = await makeFixture();
}, 60_000);
afterEach(async () => {
  await f?.close();
});

const setStatus = (body: object) => k.her('PUT', '/v1/p/status', body);
const hisToday = async () => (await k.him('GET', `/v1/people/${f.asha.id}/today`)).json() as PersonToday;
const herToday = async () => (await k.her('GET', '/v1/p/today')).json() as PersonOwnToday;

describe('her status', () => {
  it('sets Low with a line, shows on his Today and her mirror, and ends after 12 h', async () => {
    const r = await setStatus({ level: 'low', line: 'long day' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().status).toMatchObject({ level: 'low', line: 'long day' });
    expect((await hisToday()).status).toMatchObject({ level: 'low', line: 'long day' });
    expect((await herToday()).status).toMatchObject({ level: 'low' });
    const mirror = (await k.her('GET', '/v1/p/mirror/today')).json() as PersonToday;
    expect(mirror.status).toEqual((await hisToday()).status);
    await k.advance(12 * 3_600_000 + 1_000);
    expect((await hisToday()).status).toBeNull();
    expect((await herToday()).status).toBeNull();
  });

  it('Okay with no line clears it; a line over 60 characters or hours over 24 are refused', async () => {
    await setStatus({ level: 'need_space', hours: 2 });
    expect((await herToday()).status?.level).toBe('need_space');
    expect((await setStatus({ level: 'ok' })).json().status).toBeNull();
    expect((await herToday()).status).toBeNull();
    expect((await setStatus({ level: 'low', line: 'x'.repeat(61) })).statusCode).toBe(400);
    expect((await setStatus({ level: 'low', hours: 25 })).statusCode).toBe(400);
    expect((await setStatus({ level: 'busy' })).statusCode).toBe(400);
  });

  it('is a locked tile on his Today with see.plan off', async () => {
    await setStatus({ level: 'low' });
    await k.her('POST', '/v1/p/agreement/narrow', { see: { plan: false } });
    expect((await hisToday()).status).toEqual({ locked: true });
  });

  it('Need space holds his normal alerts (Urgent still goes through) and clearing it sends one summary', async () => {
    await k.subscribeAll();
    await setStatus({ level: 'need_space', line: 'quiet evening' });
    const r = await k.him('POST', '/v1/people/alerts', { to: f.asha.id, kind: 'check_in' });
    expect(r.json()).toMatchObject({ delivery: 'held_space' });
    const sheet = ((await k.him('GET', `/v1/people/alerts?with=${f.asha.id}`)).json() as { sheet: { hold: string | null } }).sheet;
    expect(sheet.hold).toMatch(/asked for space until/);
    const u = await k.him('POST', '/v1/people/alerts', { to: f.asha.id, kind: 'urgent' });
    expect(u.json()).toMatchObject({ delivery: 'sent' });
    expect(k.to(EP.asha)).toHaveLength(1);
    k.clearPushes();
    await setStatus({ level: 'ok' });
    await k.advance(2_000);
    const pushes = k.to(EP.asha);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.body).toMatch(/^1 alert from Sam while you had asked for space\.$/);
    // Nothing went to Bea.
    expect(k.to(EP.bea)).toEqual([]);
  });

  it('no owner route sets her status (T14)', () => {
    for (const [key, def] of Object.entries(PEOPLE_ROUTES)) {
      if (def.method === 'GET') continue;
      expect(`${def.method} ${def.path}`, key).not.toMatch(/status|rough/);
    }
  });
});
