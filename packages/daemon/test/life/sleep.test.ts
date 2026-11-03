/**
 * v0.12 People (P2): her sleep log (spec 3.12, O10).
 *
 * - The night key's 12:00 boundary; manual nights; one open night at a time
 *   (409 `open`), "Woke up" with none open (409 `none_open`); "Going to
 *   sleep" at most 12 h back; double taps are harmless (client ids).
 * - An open night closes 20 h after bedtime with no wake time invented.
 * - "Hold alerts while I sleep": his normal alert is held while a night is
 *   open, Woke up releases one summary; with the switch off nothing is held.
 * - The week: averages, the "short" label under 6 h, a trend only when both
 *   weeks have 4 nights.
 * - He reads the same week (see.sleep), never writes a night (D22), and
 *   with see.sleep off his read is the unknown-person 404.
 * - Notes never reach a push, the audit, the logs or Activity (O15).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersonActivityResponse, PersonOwnToday, SleepWeek } from '@jantar/protocol/people';
import { makeFixture, type Fixture } from '../people/isolation-fixture.js';
import { EP, kit } from '../people/p2-kit.js';

let f: Fixture;
const k = kit(() => f);
beforeEach(async () => {
  f = await makeFixture();
}, 60_000);
afterEach(async () => {
  await f?.close();
});

// The fixture's clock: Tue 2026-11-03 09:00 UTC (the Life zone is UTC).
const week = async (q = '') => (await k.her('GET', `/v1/p/sleep${q}`)).json() as SleepWeek;
const put = (night: string, body: object) => k.her('PUT', `/v1/p/sleep/${night}`, body);
let n = 0;
const cid = () => `client-${(n += 1).toString().padStart(4, '0')}`;

describe('nights', () => {
  it('a bedtime before 12:00 belongs to the day before; manual nights derive minutes and "short"', async () => {
    expect((await put('2026-11-02', { bedAt: '2026-11-02T23:30:00.000Z', wakeAt: '2026-11-03T07:00:00.000Z', quality: 4 })).statusCode).toBe(200);
    // 01:00 on the 2nd belongs to the night of the 1st.
    const wrong = await put('2026-11-02', { bedAt: '2026-11-02T01:00:00.000Z', wakeAt: '2026-11-02T06:00:00.000Z' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.message).toMatch(/belongs to another night/);
    expect((await put('2026-11-01', { bedAt: '2026-11-02T01:00:00.000Z', wakeAt: '2026-11-02T06:00:00.000Z' })).statusCode).toBe(200);
    const w = await week();
    expect(w.from).toBe('2026-11-02');
    expect(w.nights.map((x) => [x.night, x.minutes, x.short, x.bedHm, x.wakeHm])).toEqual([['2026-11-02', 450, false, '23:30', '07:00']]);
    const last = await week('?week=2026-10-26');
    expect(last.nights.map((x) => [x.night, x.minutes, x.short])).toEqual([['2026-11-01', 300, true]]);
    // Wake before bed, or more than 20 h later, is refused.
    expect((await put('2026-11-02', { bedAt: '2026-11-02T23:30:00.000Z', wakeAt: '2026-11-02T22:00:00.000Z' })).statusCode).toBe(400);
    expect((await put('2026-10-30', { bedAt: '2026-10-30T20:00:00.000Z', wakeAt: '2026-10-31T17:00:00.000Z' })).statusCode).toBe(400);
    // She deletes any night.
    expect((await k.her('DELETE', '/v1/p/sleep/2026-11-01')).statusCode).toBe(200);
    expect((await k.her('DELETE', '/v1/p/sleep/2026-11-01')).statusCode).toBe(404);
  });

  it('one open night at a time; Woke up with none open is 409; at most 12 h back; double taps are harmless', async () => {
    await k.at('2026-11-03T22:40:00.000Z');
    expect((await k.her('POST', '/v1/p/sleep/start', { at: '2026-11-03T08:00:00.000Z', clientId: cid() })).statusCode).toBe(400);
    const id = cid();
    const s = await k.her('POST', '/v1/p/sleep/start', { clientId: id });
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json().night).toBe('2026-11-03');
    expect((await k.her('POST', '/v1/p/sleep/start', { clientId: id })).statusCode).toBe(200);
    const again = await k.her('POST', '/v1/p/sleep/start', { clientId: cid() });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toMatch(/already open/);
    expect((await week()).open).toEqual({ since: '2026-11-03T22:40:00.000Z', night: '2026-11-03' });
    const today = (await k.her('GET', '/v1/p/today')).json() as PersonOwnToday;
    expect(today.sleep).toMatchObject({ open: { since: '2026-11-03T22:40:00.000Z' }, showStart: false });
    await k.at('2026-11-04T06:45:00.000Z');
    const wakeId = cid();
    expect((await k.her('POST', '/v1/p/sleep/wake', { quality: 4, notes: 'CANARY-SLEEP-NOTE', clientId: wakeId })).statusCode).toBe(200);
    expect((await k.her('POST', '/v1/p/sleep/wake', { clientId: wakeId })).statusCode).toBe(200);
    const none = await k.her('POST', '/v1/p/sleep/wake', { clientId: cid() });
    expect(none.statusCode).toBe(409);
    expect(none.json().error.message).toMatch(/No night is open/);
    const night = (await week()).nights.find((x) => x.night === '2026-11-03');
    expect(night).toMatchObject({ minutes: 485, quality: 4, notes: 'CANARY-SLEEP-NOTE', source: 'buttons' });
    // Her notes are hers: never in the audit, the logs or Activity.
    const act = (await k.her('GET', '/v1/p/activity')).json() as PersonActivityResponse;
    for (const t of [JSON.stringify(f.api.ctx.db.audit.list({ limit: 1000 })), JSON.stringify(f.api.ctx.log.records), JSON.stringify(act)]) expect(t).not.toMatch(/CANARY-SLEEP/);
  });

  it('an open night closes 20 h after bedtime with no wake time invented; the next morning asks', async () => {
    await k.at('2026-11-03T23:00:00.000Z');
    await k.her('POST', '/v1/p/sleep/start', { clientId: cid() });
    await k.at('2026-11-04T19:01:00.000Z');
    const w = await week();
    expect(w.open).toBeNull();
    const night = w.nights.find((x) => x.night === '2026-11-03');
    expect(night).toMatchObject({ noWake: true });
    expect(night?.wakeAt).toBeUndefined();
    expect(night?.minutes).toBeUndefined();
    // That day the card asks "When did you wake up?"; a day later it has gone.
    expect(((await k.her('GET', '/v1/p/today')).json() as PersonOwnToday).sleep.askWake).toBe('2026-11-03');
    await k.at('2026-11-05T08:00:00.000Z');
    expect(((await k.her('GET', '/v1/p/today')).json() as PersonOwnToday).sleep.askWake).toBeNull();
  });
});

describe('Hold alerts while I sleep (O10)', () => {
  it('holds his normal alert while a night is open; Woke up releases one summary; Urgent still rings', async () => {
    await k.subscribeAll();
    await k.at('2026-11-03T23:00:00.000Z');
    await k.her('POST', '/v1/p/sleep/start', { clientId: cid() });
    const r = await k.him('POST', '/v1/people/alerts', { to: f.asha.id, kind: 'good_night' });
    expect(r.json().delivery).toBe('held_sleep');
    const sheet = ((await k.him('GET', `/v1/people/alerts?with=${f.asha.id}`)).json() as { sheet: { hold: string } }).sheet;
    expect(sheet.hold).toBe('Asha is asleep (since 23:00). Only Urgent goes through.');
    expect((await k.him('POST', '/v1/people/alerts', { to: f.asha.id, kind: 'urgent' })).json().delivery).toBe('sent');
    expect(k.to(EP.asha)).toHaveLength(1);
    k.clearPushes();
    await k.at('2026-11-04T06:30:00.000Z');
    expect(k.to(EP.asha)).toEqual([]);
    await k.her('POST', '/v1/p/sleep/wake', { clientId: cid() });
    await k.advance(2_000);
    expect(k.to(EP.asha).map((p) => p.body)).toEqual(['1 alert from Sam while you were asleep.']);
    // He gets no push when she goes to sleep or wakes up.
    expect(k.to(EP.sam)).toEqual([]);
  });

  it('with the switch off an open night holds nothing; with see.sleep off he reads "quiet time"', async () => {
    await k.at('2026-11-03T23:00:00.000Z');
    await k.her('POST', '/v1/p/sleep/start', { clientId: cid() });
    await k.her('POST', '/v1/p/agreement/narrow', { see: { sleep: false } });
    const sheet = ((await k.him('GET', `/v1/people/alerts?with=${f.asha.id}`)).json() as { sheet: { hold: string } }).sheet;
    expect(sheet.hold).toBe('Asha has quiet time on. Only Urgent goes through.');
    expect((await k.him('POST', '/v1/people/alerts', { to: f.asha.id, kind: 'check_in' })).json().delivery).toBe('held_quiet');
    expect((await k.her('PATCH', '/v1/p/prefs', { sleepHolds: false })).statusCode).toBe(200);
    expect((await k.him('POST', '/v1/people/alerts', { to: f.asha.id, kind: 'call_me' })).json().delivery).toBe('sent');
  });
});

describe('the week and his view', () => {
  it('averages, spread and a trend only when both weeks have four nights', async () => {
    // Last week (26 Oct – 1 Nov): four 6 h nights. This week: three 8 h nights so far, then a fourth.
    for (const d of ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29']) {
      const next = `2026-10-${String(Number(d.slice(8)) + 1).padStart(2, '0')}`;
      await put(d, { bedAt: `${d}T23:00:00.000Z`, wakeAt: `${next}T05:00:00.000Z` });
    }
    await put('2026-10-30', { bedAt: '2026-10-30T22:00:00.000Z', wakeAt: '2026-10-31T06:00:00.000Z' });
    await put('2026-10-31', { bedAt: '2026-10-31T22:00:00.000Z', wakeAt: '2026-11-01T06:00:00.000Z' });
    await put('2026-11-01', { bedAt: '2026-11-01T22:00:00.000Z', wakeAt: '2026-11-02T06:00:00.000Z' });
    const last = await week('?week=2026-10-26');
    expect(last.nights).toHaveLength(7);
    expect(last.trend).toBeNull();
    await put('2026-11-02', { bedAt: '2026-11-02T22:00:00.000Z', wakeAt: '2026-11-03T06:00:00.000Z' });
    const w = await week();
    expect(w.avgMinutes).toBe(480);
    expect(w.trend).toBeNull();
    // A wider range answers too, up to 92 nights.
    expect((await week('?from=2026-10-26&to=2026-11-02')).nights).toHaveLength(8);
    expect((await k.her('GET', '/v1/p/sleep?from=2026-01-01&to=2026-11-02')).statusCode).toBe(400);
  });

  it('he reads the same week (see.sleep), never writes a night, and off is the unknown-person 404', async () => {
    await put('2026-11-02', { bedAt: '2026-11-02T23:30:00.000Z', wakeAt: '2026-11-03T07:00:00.000Z' });
    const his = await k.him('GET', `/v1/people/${f.asha.id}/sleep`);
    expect(his.statusCode).toBe(200);
    expect(his.json()).toEqual(await week());
    expect((await k.her('GET', '/v1/p/mirror/sleep')).json()).toEqual(his.json());
    for (const [m, url] of [
      ['PUT', `/v1/people/${f.asha.id}/sleep/2026-11-02`],
      ['DELETE', `/v1/people/${f.asha.id}/sleep/2026-11-02`],
      ['POST', `/v1/people/${f.asha.id}/sleep/start`],
    ] as const) {
      expect((await k.him(m, url, m === 'DELETE' ? undefined : { bedAt: '2026-11-02T23:00:00.000Z', clientId: 'xxxxxxxxxx' })).statusCode, url).toBe(404);
    }
    await k.her('POST', '/v1/p/agreement/narrow', { see: { sleep: false } });
    const off = await k.him('GET', `/v1/people/${f.asha.id}/sleep`);
    const unknown = await k.him('GET', '/v1/people/01JZZZZZZZZZZZZZZZZZZZZZZZ/sleep');
    expect([off.statusCode, off.body]).toEqual([unknown.statusCode, unknown.body]);
    expect((await k.her('GET', '/v1/p/mirror/sleep')).json()).toEqual({ locked: true });
    // Bea (Standard: sleep off) never sees Asha's nights, and Asha's never reach Bea's routes.
    expect(((await k.her('GET', '/v1/p/sleep', undefined, f.bea.full)).json() as SleepWeek).nights).toEqual([]);
  });
});
