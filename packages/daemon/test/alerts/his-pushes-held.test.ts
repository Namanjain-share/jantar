/**
 * v0.11 People: every push his actions send her goes through her resolver
 * (spec 6.3, 3.6, 1.2; review 4, findings 1 and 2).
 *
 * - His timed to-do is `important` (spec 3.6 ring table: "His reminders and
 *   todos assigned with a time | important | held, released in the summary
 *   | held"): in her quiet hours and while she is paused it doesn't ring,
 *   and her one summary counts it. Her own reminders still ring (critical).
 * - The notices of his changes (an item he assigns, a weight he corrects,
 *   a medicine he adds, a list he deletes, his ask for more) are held in
 *   her quiet hours and counted as updates in the same summary.
 * - While she is paused his ask for more is refused (409), as his other
 *   writes are, and a list he deletes tells her only in the summary.
 * Synthetic people only (Sam, Asha).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFixture, type Fixture } from '../people/isolation-fixture.js';
import { EP, eventually, kit } from '../people/p2-kit.js';

let f: Fixture;
const k = kit(() => f);
beforeEach(async () => {
  f = await makeFixture();
}, 60_000);
afterEach(async () => {
  await f?.close();
});

const admin = () => f.owner.admin;
const herPushes = () => k.to(EP.asha).map((p) => `${p.title} | ${p.body}`);

describe('his timed to-dos ring by her state (spec 3.6)', () => {
  it('held in her quiet hours and while paused, counted in her summary; her own still ring; outside them his rings', async () => {
    await k.subscribeAll();
    expect((await k.her('PATCH', '/v1/p/prefs', { quiet: { from: '22:00', to: '07:00' } })).statusCode).toBe(200);
    await k.at('2026-11-03T20:00:00.000Z');
    const his = await k.him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'Sam: lights off', due: { day: '2026-11-04', time: '02:45' } }, admin());
    expect(his.statusCode, his.body).toBe(201);
    const mine = await k.her('POST', '/v1/p/todos', { title: 'Asha: night pill reminder', due: { day: '2026-11-04', time: '02:50' } });
    expect(mine.statusCode, mine.body).toBe(201);
    k.clearPushes();

    await k.at('2026-11-04T02:46:00.000Z');
    await k.at('2026-11-04T02:51:00.000Z');
    await eventually(() => expect(herPushes()).toEqual(['Todo due | Asha: night pill reminder · 02:50']));
    // When the hours end: one line, the held ring counted, never the ring itself.
    await k.at('2026-11-04T07:00:02.000Z');
    await eventually(() => expect(herPushes()).toHaveLength(2));
    expect(herPushes()[1]).toBe('Accountability partner | A reminder from Sam while you were in quiet hours.');

    // Paused, outside quiet hours: held, and released when she resumes.
    const plumber = await k.him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'Sam: call the plumber', due: { day: '2026-11-04', time: '10:15' } }, admin());
    expect(plumber.statusCode, plumber.body).toBe(201);
    expect((await k.her('POST', '/v1/p/pause', {})).statusCode).toBe(200);
    k.clearPushes();
    await k.at('2026-11-04T10:16:00.000Z');
    expect(herPushes()).toEqual([]);
    expect((await k.her('POST', '/v1/p/resume', {})).statusCode).toBe(200);
    await eventually(() => expect(herPushes()).toEqual(['Accountability partner | A reminder from Sam while you were paused.']));

    // Nothing holds her now: his timed to-do rings as before.
    const later = await k.him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'Sam: water the plants', due: { day: '2026-11-04', time: '12:00' } }, admin());
    expect(later.statusCode, later.body).toBe(201);
    k.clearPushes();
    await k.at('2026-11-04T12:00:30.000Z');
    await eventually(() => expect(herPushes()).toEqual(['Todo due | Sam: water the plants · 12:00']));
  });
});

describe('the notices of his changes go through her resolver (spec 6.3)', () => {
  it('in her quiet hours: his assign, weight correction, medicine and ask for more wait, then one summary', async () => {
    await k.subscribeAll();
    expect((await k.her('PATCH', '/v1/p/prefs', { quiet: { from: '22:00', to: '07:00' } })).statusCode).toBe(200);
    expect((await k.her('PUT', '/v1/p/weights/2026-11-03', { kg: 61.4 })).statusCode).toBe(200);
    expect((await k.her('POST', '/v1/p/agreement/narrow', { see: { sleep: false } })).statusCode).toBe(200);
    await k.at('2026-11-04T02:30:00.000Z');
    k.clearPushes();

    const alert = await k.him('POST', '/v1/people/alerts', { to: f.asha.id, kind: 'check_in' });
    expect(alert.json()).toMatchObject({ delivery: 'held_quiet' });
    const assign = await k.him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'Take the bins out', due: { day: '2026-11-04', time: '08:00' }, repeat: { freq: 'weekly' } }, admin());
    expect(assign.statusCode, assign.body).toBe(201);
    const weight = await k.him('PATCH', `/v1/people/${f.asha.id}/weights/2026-11-03`, { kg: 60.9 }, admin());
    expect(weight.statusCode, weight.body).toBe(200);
    const med = await k.him('POST', `/v1/people/${f.asha.id}/medicines`, { name: 'Iron', times: ['20:00'], schedule: { freq: 'daily' } }, admin());
    expect(med.statusCode, med.body).toBe(201);
    const ask = await k.him('POST', `/v1/people/${f.asha.id}/agreement`, { see: { sleep: true } }, admin());
    expect(ask.statusCode, ask.body).toBe(200);
    expect(herPushes()).toEqual([]);

    await k.at('2026-11-04T07:00:02.000Z');
    await eventually(() => expect(herPushes()).toHaveLength(1));
    expect(herPushes()[0]).toBe('Accountability partner | 1 alert and 4 updates from Sam while you were in quiet hours.');
    // Nothing is re-sent one by one.
    await k.advance(3 * 3_600_000);
    expect(herPushes().filter((p) => !p.startsWith('Todo due'))).toHaveLength(1);
  });

  it('outside her quiet hours, the same notice pushes at once', async () => {
    await k.subscribeAll();
    const assign = await k.him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'Take the bins out' }, admin());
    expect(assign.statusCode, assign.body).toBe(201);
    await eventually(() => expect(herPushes()).toEqual(['From Sam | Sam added "Take the bins out"']));
  });

  it('while paused: his ask for more is refused, and a list he deletes tells her only when she resumes', async () => {
    await k.subscribeAll();
    expect((await k.her('POST', '/v1/p/agreement/narrow', { see: { sleep: false } })).statusCode).toBe(200);
    const made = await k.him('POST', `/v1/people/${f.asha.id}/lists`, { name: 'Weekend errands', kind: 'plain' }, admin());
    expect(made.statusCode, made.body).toBe(201);
    const id = (made.json() as { id: string }).id;
    expect((await k.her('POST', '/v1/p/pause', {})).statusCode).toBe(200);
    k.clearPushes();

    const ask = await k.him('POST', `/v1/people/${f.asha.id}/agreement`, { see: { sleep: true }, note: 'Please?' }, admin());
    expect(ask.statusCode).toBe(409);
    expect(ask.json().error.message).toBe('Asha has paused. Ask again once sharing resumes.');
    expect(((await k.her('GET', '/v1/p/me')).json() as { pending: unknown }).pending).toBeNull();

    const del = await k.him('DELETE', `/v1/people/${f.asha.id}/lists/${id}`, undefined, admin());
    expect(del.statusCode, del.body).toBe(200);
    expect(herPushes()).toEqual([]);
    expect((await k.her('POST', '/v1/p/resume', {})).statusCode).toBe(200);
    await eventually(() => expect(herPushes()).toEqual(['Accountability partner | An update from Sam while you were paused.']));
  });
});
