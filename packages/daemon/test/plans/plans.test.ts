/**
 * v0.12 People (P2): her day plan (spec 3.1, 3.2, 3.6, 3.7, 4.3, 4.4).
 *
 * - His put carries `srev`; her ticks never bump it; a stale put is 409
 *   `stale`. Status fields in his body are ignored (strict schema).
 * - Her steps survive his put without `editHers.plan`; with it, his edit
 *   says "Edited by" and her Activity keeps the old and new values.
 * - Rough day: her open steps are excused, her status turns Low, today's
 *   rings stop, he can't add to today (tomorrow is fine), and his push waits
 *   10 s behind her Undo.
 * - Templates: the 00:05 apply only on a matching weekday with no plan.
 * - Check-betweens: a slot is tickable from its time until the next one.
 * - The ring table (§3.6): a step ring is `standard` (dropped in quiet
 *   hours, never rung later), rings in the same minute merge, the plan push
 *   is skipped near the first step, changes coalesce over 2 minutes.
 * - Focus (C32): his nudge on the focus step is refused, his normal alert is
 *   held, and done releases it as one summary.
 * - Follow-ups are re-checked when they fire (C7).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersonActivityResponse, PlanView, PersonAlert } from '@jantar/protocol/people';
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

const TODAY = '2026-11-03';
const TOMORROW = '2026-11-04';
const planUrl = (day = TODAY) => `/v1/people/${f.asha.id}/plans/${day}`;
const herPlan = async (day = TODAY) => (await k.her('GET', `/v1/p/plans/${day}`)).json() as PlanView;

async function put(body: object, day = TODAY) {
  return k.him('PUT', planUrl(day), { between: [], ...body });
}

describe('his plan and srev', () => {
  it('a put creates srev 1; her ticks keep it; a stale put is 409; status fields in his body are refused', async () => {
    const r = await put({ srev: 0, steps: [{ title: 'Mock', at: '08:00' }, { title: 'Analysis', minutes: 45, ask: 'report' }, { title: 'Interview prep', at: '11:00', ask: 'ack' }] });
    expect(r.statusCode, r.body).toBe(200);
    const v = r.json() as PlanView;
    expect(v.plan?.srev).toBe(1);
    expect(v.plan?.steps.map((s) => [s.title, s.by, s.status])).toEqual([
      ['Mock', '', 'todo'],
      ['Analysis', '', 'todo'],
      ['Interview prep', '', 'todo'],
    ]);
    const [mock, analysis] = v.plan?.steps ?? [];
    expect((await k.her('POST', `/v1/p/plans/${TODAY}/steps/${mock?.id}/state`, { to: 'done' })).statusCode).toBe(200);
    expect((await k.her('POST', `/v1/p/plans/${TODAY}/steps/${analysis?.id}/state`, { to: 'doing' })).statusCode).toBe(200);
    expect((await herPlan()).plan?.srev).toBe(1);
    // His editor started at 0: stale.
    const stale = await put({ srev: 0, steps: [{ title: 'Other' }] });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.message).toMatch(/changed since you opened it/);
    // He can't send her state: the body is strict.
    expect((await put({ srev: 1, steps: [{ id: mock?.id, title: 'Mock', status: 'todo' }] })).statusCode).toBe(400);
    // Status always comes from the stored step.
    const again = await put({ srev: 1, steps: [{ id: mock?.id, title: 'Mock', at: '08:30' }, { id: analysis?.id, title: 'Analysis' }] });
    expect(again.statusCode, again.body).toBe(200);
    const after = (again.json() as PlanView).plan?.steps ?? [];
    expect(after.map((s) => [s.title, s.status, s.at])).toEqual([
      ['Mock', 'done', '08:30'],
      ['Analysis', 'doing', undefined],
    ]);
    // Removing a step she already did is allowed, and Activity says so.
    await put({ srev: 2, steps: [{ id: analysis?.id, title: 'Analysis' }] });
    const act = (await k.her('GET', '/v1/p/activity')).json() as PersonActivityResponse;
    expect(act.activity.find((a) => a.action === 'step.removed')).toMatchObject({ title: 'Mock', fields: ['was done'] });
  });

  it('her steps survive his put without editHers.plan; with it his edit says "Edited by" and keeps old and new', async () => {
    await put({ srev: 0, steps: [{ title: 'Walk' }] });
    const add = await k.her('POST', `/v1/p/plans/${TODAY}/steps`, { title: 'Call Mum', at: '18:00' });
    expect(add.statusCode, add.body).toBe(201);
    const hers = (add.json() as { id: string }).id;
    const srev = (await herPlan()).plan?.srev as number;
    expect(srev).toBe(2);
    // editHers.plan on (this offer): his edit of her step is marked, and Activity keeps the values.
    const walk = (await herPlan()).plan?.steps.find((s) => s.title === 'Walk');
    const e = await put({ srev, steps: [{ id: walk?.id, title: 'Walk' }, { id: hers, title: 'Call Mum', at: '18:30' }] });
    expect(e.statusCode, e.body).toBe(200);
    expect((await herPlan()).plan?.steps.find((s) => s.id === hers)).toMatchObject({ by: f.asha.id, at: '18:30', editedBy: '' });
    const act = (await k.her('GET', '/v1/p/activity')).json() as PersonActivityResponse;
    expect(act.activity.find((a) => a.action === 'step.edited')?.changes).toEqual([{ field: 'at', from: '18:00', to: '18:30' }]);
    // Without it, her step comes through his put unchanged, even when his body leaves it out.
    await k.her('POST', '/v1/p/agreement/narrow', { editHers: { plan: false } });
    const cur = (await herPlan()).plan?.srev as number;
    const r = await put({ srev: cur, steps: [{ id: hers, title: 'Renamed by him' }, { title: 'New one' }] });
    expect(r.statusCode, r.body).toBe(200);
    const steps = (await herPlan()).plan?.steps ?? [];
    expect(steps.find((s) => s.id === hers)).toMatchObject({ title: 'Call Mum', at: '18:30' });
    expect(steps.map((s) => s.title)).toEqual(['Call Mum', 'New one']);
    // Her side: she edits and deletes hers; his only take ring and focus (C32).
    const his = steps.find((s) => s.title === 'New one');
    expect((await k.her('PATCH', `/v1/p/plans/${TODAY}/steps/${his?.id}`, { title: 'Mine now' })).statusCode).toBe(409);
    expect((await k.her('PATCH', `/v1/p/plans/${TODAY}/steps/${his?.id}`, { ring: false, focus: true })).statusCode).toBe(200);
    expect((await herPlan()).plan?.steps.find((s) => s.id === his?.id)).toMatchObject({ title: 'New one', mutedByHer: true, focusByHer: true, ring: true, focus: false });
    expect((await k.her('DELETE', `/v1/p/plans/${TODAY}/steps/${his?.id}`)).statusCode).toBe(409);
    expect((await k.her('DELETE', `/v1/p/plans/${TODAY}/steps/${hers}`)).statusCode).toBe(200);
  });

  it('assign.plan off: his writes are 404; see.plan off: his reads too; paused: 409 on writes, reads answer', async () => {
    await k.her('POST', '/v1/p/pause', {});
    const p = await put({ srev: 0, steps: [{ title: 'Wait' }] });
    expect(p.statusCode).toBe(409);
    expect((await k.him('GET', planUrl())).statusCode).toBe(200);
    await k.her('POST', '/v1/p/resume', {});
    await k.her('POST', '/v1/p/agreement/narrow', { assign: { plan: false } });
    expect((await put({ srev: 0, steps: [{ title: 'Nope' }] })).statusCode).toBe(404);
    expect((await k.him('GET', `/v1/people/${f.asha.id}/templates`)).statusCode).toBe(404);
    await k.her('POST', '/v1/p/agreement/narrow', { see: { plan: false } });
    const off = await k.him('GET', planUrl());
    const unknown = await k.him('GET', `/v1/people/01JZZZZZZZZZZZZZZZZZZZZZZZ/plans/${TODAY}`);
    expect([off.statusCode, off.body]).toEqual([unknown.statusCode, unknown.body]);
    const today = (await k.him('GET', `/v1/people/${f.asha.id}/today`)).json();
    expect(today.plan).toEqual({ locked: true });
    expect(today.status).toEqual({ locked: true });
    expect(today.review).toBeNull();
  });
});

describe('spec 8.5: his writes that answer her plan are reads too', () => {
  const marks = async () => ((await k.her('GET', '/v1/p/activity')).json() as PersonActivityResponse).activity.filter((a) => a.action === 'view' && a.ref === 'plan');

  it('a PUT (changed or not) and a template apply each leave a view mark; his own step edits are on her record', async () => {
    const first = await put({ srev: 0, steps: [{ title: 'Walk', at: '10:00' }, { title: 'Call mum', at: '11:30', ask: 'checkin' }], send: 'quiet' });
    expect(first.statusCode).toBe(200);
    expect(await marks()).toHaveLength(1);
    const [walk, call] = (first.json() as PlanView).plan?.steps ?? [];
    // A new hour: she reports, checks in and adds her own step.
    await k.at(`${TODAY}T12:10:00.000Z`);
    await k.her('POST', `/v1/p/plans/${TODAY}/steps/${walk?.id}/state`, { to: 'done', report: 'CANARY-HER-REPORT' });
    await k.her('POST', `/v1/p/plans/${TODAY}/steps/${call?.id}/checkin`, { mood: 1, energy: 1, line: 'CANARY-HER-CHECKIN', need: 'CANARY-HER-NEED' });
    await k.her('POST', `/v1/p/plans/${TODAY}/steps`, { title: 'CANARY-HER-OWN-STEP' });
    const cur = await herPlan();
    const same = cur.plan?.steps.map((x) => ({ id: x.id, title: x.title, ...(x.at ? { at: x.at } : {}), ask: x.ask, ring: x.ring, focus: x.focus }));
    const again = await put({ srev: cur.plan?.srev, steps: same, send: 'quiet' });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.body).toMatch(/CANARY-HER-REPORT/);
    expect(await marks()).toHaveLength(2);
    // Template apply answers the plan too.
    await k.at(`${TODAY}T13:10:00.000Z`);
    const tid = ((await k.him('POST', `/v1/people/${f.asha.id}/templates`, { name: 'Extra', steps: [{ title: 'Stretch' }] })).json() as { id: string }).id;
    const ap = await k.him('POST', `${planUrl()}/apply`, { templateId: tid, mode: 'append', srev: (await herPlan()).plan?.srev });
    expect(ap.statusCode, ap.body).toBe(200);
    expect(await marks()).toHaveLength(3);
    // His time change on his own step: "Sam changed the time of 'Walk'" with old and new.
    const v = await herPlan();
    const steps = v.plan?.steps.map((x) => ({ id: x.id, title: x.title, ...(x.at ? { at: x.title === 'Walk' ? '10:30' : x.at } : {}), ask: x.ask, ring: x.ring, focus: x.focus }));
    expect((await put({ srev: v.plan?.srev, steps, send: 'quiet' })).statusCode).toBe(200);
    const act = ((await k.her('GET', '/v1/p/activity')).json() as PersonActivityResponse).activity;
    expect(act.find((a) => a.action === 'step.edited')).toMatchObject({ actor: 'owner', title: 'Walk', changes: [{ field: 'at', from: '10:00', to: '10:30' }] });
    // Refused writes (stale) answer no plan and mark nothing new.
    const stale = await put({ srev: 0, steps: [{ title: 'x' }] });
    expect(stale.statusCode).toBe(409);
    expect(stale.body).not.toMatch(/CANARY/);
  });
});

describe("his save says when she gets it", () => {
  it('a plan for tomorrow answers when its push is lined up; a sent one answers none', async () => {
    const r = await put({ srev: 0, steps: [{ title: 'Run' }] }, TOMORROW);
    expect(r.statusCode).toBe(200);
    const v = r.json() as PlanView;
    expect(v.plan?.sentAt).toBeUndefined();
    const prefs = ((await k.her('GET', '/v1/p/me')).json() as { person: { prefs: { planPushAt: string } } }).person.prefs;
    expect(v.sendsAt).toBe(`${TOMORROW}T${prefs.planPushAt}:00.000Z`);
    // The GET (his view, her mirror) never carries it.
    expect((await k.him('GET', planUrl(TOMORROW))).json()).not.toHaveProperty('sendsAt');
    await k.at(`${TOMORROW}T${prefs.planPushAt}:30.000Z`);
    await eventually(async () => expect((await herPlan(TOMORROW)).plan?.sentAt).toBeDefined());
    const again = await put({ srev: (await herPlan(TOMORROW)).plan?.srev, steps: [{ title: 'Run' }, { title: 'Swim' }] }, TOMORROW);
    expect((again.json() as PlanView).sendsAt).toBeUndefined();
  });
});

describe('Now and Next follow his order', () => {
  it('an untimed step never jumps ahead of the timed step he planned before it', async () => {
    const r = await put({ srev: 0, steps: [{ title: 'Mock', at: '10:00' }, { title: 'Analysis' }, { title: 'Interview prep', at: '14:00' }], send: 'quiet' });
    const ids = Object.fromEntries(((r.json() as PlanView).plan?.steps ?? []).map((s) => [s.title, s.id]));
    // 09:00, before the first timed step: no Now, and Next is the first step in his order.
    let v = await herPlan();
    expect([v.now, v.next]).toEqual([null, ids.Mock]);
    // 10:05: Mock is due, Analysis follows it.
    await k.at(`${TODAY}T10:05:00.000Z`);
    v = await herPlan();
    expect([v.now, v.next]).toEqual([ids.Mock, ids.Analysis]);
    // Mock done: Analysis (no time of its own) is Now, before Interview prep's time.
    await k.her('POST', `/v1/p/plans/${TODAY}/steps/${ids.Mock}/state`, { to: 'done' });
    v = await herPlan();
    expect([v.now, v.next]).toEqual([ids.Analysis, ids['Interview prep']]);
    // An untimed first step is due at once.
    const first = await put({ srev: 0, steps: [{ title: 'Read' }, { title: 'Lunch', at: '13:00' }] }, '2026-11-05');
    expect(first.statusCode).toBe(200);
    await k.at('2026-11-05T09:00:00.000Z');
    v = await herPlan('2026-11-05');
    expect([v.now, v.next]).toEqual([(first.json() as PlanView).plan?.steps[0]?.id, (first.json() as PlanView).plan?.steps[1]?.id]);
  });
});

describe('rough day (spec 3.7, C35)', () => {
  it('excuses her open steps, sets Low, holds his adds to today, and reaches him after 10 s unless undone', async () => {
    await k.subscribeAll();
    await put({ srev: 0, steps: [{ title: 'Mock' }, { title: 'Analysis', at: '15:00' }], send: 'quiet' });
    const [mock] = (await herPlan()).plan?.steps ?? [];
    await k.her('POST', `/v1/p/plans/${TODAY}/steps/${mock?.id}/state`, { to: 'done' });
    expect((await k.her('POST', `/v1/p/plans/${TODAY}/rough`, { note: 'Headache' })).statusCode).toBe(200);
    let v = await herPlan();
    expect(v.plan?.steps.map((s) => s.status)).toEqual(['done', 'excused']);
    expect(((await k.her('GET', '/v1/p/today')).json() as { status: { level: string } }).status.level).toBe('low');
    // He can't add to today; tomorrow is fine.
    const blocked = await put({ srev: v.plan?.srev as number, steps: [{ id: mock?.id, title: 'Mock' }, { title: 'More' }] });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toMatch(/rough day/);
    expect((await put({ srev: 0, steps: [{ title: 'Tomorrow' }], send: 'quiet' }, TOMORROW)).statusCode).toBe(200);
    // An Undo within 10 s: nothing reaches him.
    await k.advance(5_000);
    expect((await k.her('DELETE', `/v1/p/plans/${TODAY}/rough`)).statusCode).toBe(200);
    v = await herPlan();
    expect(v.plan?.steps.map((s) => s.status)).toEqual(['done', 'todo']);
    expect(((await k.her('GET', '/v1/p/today')).json() as { status: unknown }).status).toBeNull();
    await k.advance(20_000);
    expect(k.to(EP.sam)).toEqual([]);
    // Again, and this time it stands: one push to him, none to her.
    await k.her('POST', `/v1/p/plans/${TODAY}/rough`, {});
    await k.advance(11_000);
    await eventually(() => expect(k.to(EP.sam)).toHaveLength(1));
    expect(k.to(EP.sam)[0]?.body).toBe('Asha marked today a rough day.');
    expect(k.to(EP.asha)).toEqual([]);
    // He can't undo it (no route), and she can't mark another day rough.
    expect((await k.her('POST', `/v1/p/plans/${TOMORROW}/rough`, {})).statusCode).toBe(409);
  });

  it('a rough day narrowed away from him (see.plan off) sends nothing (C7)', async () => {
    await k.subscribeAll();
    await k.her('POST', `/v1/p/plans/${TODAY}/rough`, {});
    await k.her('POST', '/v1/p/agreement/narrow', { see: { plan: false } });
    await k.advance(15_000);
    expect(k.to(EP.sam).filter((p) => /rough day/.test(p.body))).toEqual([]);
  });
});

describe('templates and the 00:05 apply', () => {
  it('applies the weekday template at 00:05 only when the day has no plan; the push goes at her plan time', async () => {
    await k.subscribeAll();
    const t = await k.him('POST', `/v1/people/${f.asha.id}/templates`, {
      name: 'Interview day',
      weekdays: [3, 4],
      steps: [{ title: 'Mock', at: '08:00' }, { title: 'Prep' }],
      between: [{ title: 'Check applications', every: 120, from: '10:00', to: '18:00' }],
    });
    expect(t.statusCode, t.body).toBe(201);
    // Thursday already has a plan: nothing is applied there.
    await put({ srev: 0, steps: [{ title: 'Already planned' }], send: 'quiet' }, '2026-11-05');
    await k.at('2026-11-04T00:06:00.000Z');
    const wed = await herPlan(TOMORROW);
    expect(wed.plan?.templateName).toBe('Interview day');
    expect(wed.plan?.steps.map((s) => s.title)).toEqual(['Mock', 'Prep']);
    expect(wed.plan?.between.map((b) => b.title)).toEqual(['Check applications']);
    // The plan push: at 07:00 (her plan time), not at 00:05.
    expect(k.to(EP.asha)).toEqual([]);
    await k.at('2026-11-04T07:01:00.000Z');
    await eventually(() => expect(k.to(EP.asha).some((p) => /Your plan for today: 2 steps/.test(p.body))).toBe(true));
    const act = (await k.her('GET', '/v1/p/activity')).json() as PersonActivityResponse;
    expect(act.activity.some((a) => a.action === 'template.applied' && a.title === 'Interview day')).toBe(true);
    await k.at('2026-11-05T00:06:00.000Z');
    expect((await herPlan('2026-11-05')).plan?.steps.map((s) => s.title)).toEqual(['Already planned']);
  });

  it('apply (replace or append) needs a fresh srev; 20 templates at most', async () => {
    const tid = ((await k.him('POST', `/v1/people/${f.asha.id}/templates`, { name: 'Rest day', steps: [{ title: 'Sleep in' }] })).json() as { id: string }).id;
    await put({ srev: 0, steps: [{ title: 'Keep me' }], send: 'quiet' });
    expect((await k.him('POST', `${planUrl()}/apply`, { templateId: tid, mode: 'append', srev: 0 })).statusCode).toBe(409);
    const ap = await k.him('POST', `${planUrl()}/apply`, { templateId: tid, mode: 'append', srev: 1 });
    expect(ap.statusCode, ap.body).toBe(200);
    expect((ap.json() as PlanView).plan?.steps.map((s) => s.title)).toEqual(['Keep me', 'Sleep in']);
    const rp = await k.him('POST', `${planUrl()}/apply`, { templateId: tid, mode: 'replace', srev: 2 });
    expect((rp.json() as PlanView).plan?.steps.map((s) => s.title)).toEqual(['Sleep in']);
    for (let i = 1; i < 20; i += 1) expect((await k.him('POST', `/v1/people/${f.asha.id}/templates`, { name: `T${i}`, steps: [] })).statusCode).toBe(201);
    expect((await k.him('POST', `/v1/people/${f.asha.id}/templates`, { name: 'One too many', steps: [] })).statusCode).toBe(409);
  });
});

describe('check-betweens', () => {
  it('a slot is tickable from its time until the next; later slots are not', async () => {
    await put({ srev: 0, steps: [], between: [{ title: 'Check applications', every: 120, from: '10:00', to: '18:00' }], send: 'quiet' });
    let v = await herPlan();
    const bid = v.plan?.between[0]?.id as string;
    expect(v.slots[bid]?.map((s) => s.state)).toEqual(['later', 'later', 'later', 'later', 'later']);
    expect((await k.her('POST', `/v1/p/plans/${TODAY}/between/${bid}/tick`, { slot: '10:00', done: true })).statusCode).toBe(409);
    await k.at(`${TODAY}T10:05:00.000Z`);
    expect((await k.her('POST', `/v1/p/plans/${TODAY}/between/${bid}/tick`, { slot: '10:00', done: true })).statusCode).toBe(200);
    expect((await k.her('POST', `/v1/p/plans/${TODAY}/between/${bid}/tick`, { slot: '12:00', done: true })).statusCode).toBe(409);
    v = await herPlan();
    expect(v.slots[bid]?.map((s) => s.state)).toEqual(['done', 'later', 'later', 'later', 'later']);
    await k.at(`${TODAY}T12:30:00.000Z`);
    v = await herPlan();
    expect(v.slots[bid]?.map((s) => s.state)).toEqual(['done', 'open', 'later', 'later', 'later']);
    // Ticks are state, not structure.
    expect(v.plan?.srev).toBe(1);
  });
});

describe('the ring table (spec 3.6) and the plan push', () => {
  it('a step rings at its time (merged per minute), is dropped in her quiet hours, and never rings late', async () => {
    await k.subscribeAll();
    await put({ srev: 0, steps: [{ title: 'Stretch', at: '09:30' }, { title: 'Water', at: '09:30' }, { title: 'Call', at: '10:30' }, { title: 'Late one', at: '11:30', ring: false }], send: 'quiet' });
    await k.at(`${TODAY}T09:31:00.000Z`);
    await eventually(() => expect(k.to(EP.asha)).toHaveLength(1));
    const ring = k.to(EP.asha)[0];
    expect(ring?.body).toBe('09:30 · Stretch + Water');
    expect(ring?.url).toMatch(/^\/p\?step=/);
    expect(k.to(EP.sam)).toEqual([]);
    // Quiet hours 10:00–11:00: the 10:30 ring is dropped, and doesn't come back after.
    await k.her('PATCH', '/v1/p/prefs', { quiet: { from: '10:00', to: '11:00' } });
    k.clearPushes();
    await k.at(`${TODAY}T12:00:00.000Z`);
    expect(k.to(EP.asha)).toEqual([]);
    // Her own switch: rings.steps off stops step rings.
    await put({ srev: 1, steps: [{ title: 'Later', at: '13:00' }], send: 'quiet' }).then(async () => {
      const cur = (await herPlan()).plan?.srev as number;
      await put({ srev: cur, steps: [{ title: 'Later', at: '13:00' }], send: 'quiet' });
    });
    await k.her('PATCH', '/v1/p/prefs', { rings: { steps: false } });
    await k.at(`${TODAY}T13:05:00.000Z`);
    expect(k.to(EP.asha)).toEqual([]);
  });

  it('a plan for today after her plan time goes at once; a first step within 15 min carries the plan instead', async () => {
    await k.subscribeAll();
    const r = await put({ srev: 0, steps: [{ title: 'A' }, { title: 'B' }] });
    expect(r.statusCode).toBe(200);
    await k.advance(1_000);
    await eventually(() => expect(k.to(EP.asha)).toHaveLength(1));
    expect(k.to(EP.asha)[0]).toMatchObject({ title: 'From Sam', body: 'Your plan for today: 2 steps.' });
    expect(k.to(EP.sam)).toEqual([]);
    k.clearPushes();
    // Tomorrow: the push would be 07:00, and the first step rings at 07:10: one push, the step's, carrying the plan.
    await put({ srev: 0, steps: [{ title: 'Run', at: '07:10' }, { title: 'Breakfast' }] }, TOMORROW);
    await k.at('2026-11-04T07:11:00.000Z');
    await eventually(() => expect(k.to(EP.asha).length).toBeGreaterThan(0));
    // (Today's evening review prompt rang at 21:00 on the way: today had a plan.)
    const mine = k.to(EP.asha).map((p) => p.body);
    expect(mine).toEqual(['How did today go? 0 done · 2 open', "07:10 · Run · Today's plan: 2 steps."]);
  });

  it('his changes to a sent plan are pushed once per 2 minutes, and reset her Got it', async () => {
    await k.subscribeAll();
    await put({ srev: 0, steps: [{ title: 'A' }, { title: 'B' }] });
    await k.advance(1_000);
    await eventually(() => expect(k.to(EP.asha)).toHaveLength(1));
    expect((await k.her('POST', `/v1/p/plans/${TODAY}/ack`)).statusCode).toBe(200);
    expect((await herPlan()).plan?.ackAt).toBeDefined();
    k.clearPushes();
    const [a, b] = (await herPlan()).plan?.steps ?? [];
    await put({ srev: 1, steps: [{ id: b?.id, title: 'B' }, { id: a?.id, title: 'A' }] });
    await k.advance(30_000);
    await put({ srev: 2, steps: [{ id: b?.id, title: 'B' }, { id: a?.id, title: 'A' }, { title: 'C' }] });
    expect((await herPlan()).plan?.ackAt).toBeUndefined();
    await k.advance(60_000);
    expect(k.to(EP.asha)).toEqual([]);
    await k.advance(60_000);
    await eventually(() => expect(k.to(EP.asha)).toHaveLength(1));
    expect(k.to(EP.asha)[0]?.body).toBe("Sam changed today's plan: 2 steps moved, 1 added.");
    await k.advance(10 * 60_000);
    expect(k.to(EP.asha)).toHaveLength(1);
  });
});

describe('focus (C32) and nudges', () => {
  it('while a focus step is doing, his nudge on it is refused and his normal alert is held; done releases one summary', async () => {
    await k.subscribeAll();
    await put({ srev: 0, steps: [{ title: 'Interview', minutes: 60, focus: true }, { title: 'Prep' }], send: 'quiet' });
    const [iv, prep] = (await herPlan()).plan?.steps ?? [];
    await k.her('POST', `/v1/p/plans/${TODAY}/steps/${iv?.id}/state`, { to: 'doing' });
    const v = await herPlan();
    expect(v.focus).toMatchObject({ stepId: iv?.id, title: 'Interview', until: `${TODAY}T10:30:00.000Z` });
    const nudge = await k.him('POST', '/v1/people/alerts', { to: f.asha.id, kind: 'nudge', ref: { type: 'step', id: iv?.id, day: TODAY } });
    expect(nudge.statusCode).toBe(409);
    expect(nudge.json().error.message).toBe('Asha is in focus until about 10:30.');
    const sheet = ((await k.him('GET', `/v1/people/alerts?with=${f.asha.id}`)).json() as { sheet: { hold: string } }).sheet;
    expect(sheet.hold).toBe('Asha is in Interview (focus) until about 10:30. Only Urgent goes through.');
    const sent = await k.him('POST', '/v1/people/alerts', { to: f.asha.id, kind: 'check_in' });
    expect(sent.json()).toMatchObject({ delivery: 'held_focus' });
    const other = await k.him('POST', '/v1/people/alerts', { to: f.asha.id, kind: 'nudge', ref: { type: 'step', id: prep?.id, day: TODAY } });
    expect(other.json()).toMatchObject({ delivery: 'held_focus' });
    expect(k.to(EP.asha)).toEqual([]);
    await k.her('POST', `/v1/p/plans/${TODAY}/steps/${iv?.id}/state`, { to: 'done' });
    await k.advance(1_000);
    await eventually(() => expect(k.to(EP.asha)).toHaveLength(1));
    expect(k.to(EP.asha)[0]?.body).toBe('2 alerts from Sam while you were focusing.');
    const list = ((await k.her('GET', '/v1/p/alerts')).json() as { alerts: PersonAlert[] }).alerts;
    expect(list.map((a) => a.delivery)).toEqual(['released', 'released']);
  });

  it('focus ends on its own after the step length plus 30 minutes', async () => {
    await k.subscribeAll();
    await put({ srev: 0, steps: [{ title: 'Exam', minutes: 30, focus: true }], send: 'quiet' });
    const [exam] = (await herPlan()).plan?.steps ?? [];
    await k.her('POST', `/v1/p/plans/${TODAY}/steps/${exam?.id}/state`, { to: 'doing' });
    await k.him('POST', '/v1/people/alerts', { to: f.asha.id, kind: 'thinking_of_you' });
    await k.advance(59 * 60_000);
    expect(k.to(EP.asha)).toEqual([]);
    await k.advance(2 * 60_000);
    await eventually(() => expect(k.to(EP.asha)).toHaveLength(1));
    expect(k.to(EP.asha)[0]?.body).toBe('1 alert from Sam while you were focusing.');
  });
});

describe('follow-ups (spec 4.4, C7)', () => {
  it("reach him when the step is still open, never her, and only while he still sees the area", async () => {
    await k.subscribeAll();
    await put({ srev: 0, steps: [{ title: 'Send the form', followUp: '09:30' }, { title: 'Done early', followUp: '09:40' }, { title: 'Hidden', followUp: '10:00' }], send: 'quiet' });
    const steps = (await herPlan()).plan?.steps ?? [];
    await k.her('POST', `/v1/p/plans/${TODAY}/steps/${steps[1]?.id}/state`, { to: 'done' });
    await k.at(`${TODAY}T09:45:00.000Z`);
    await eventually(() => expect(k.to(EP.sam)).toHaveLength(1));
    expect(k.to(EP.sam)[0]?.body).toBe('Asha: an item isn\'t done yet.');
    expect(k.to(EP.sam)[0]?.url).toBe(`/people/${f.asha.id}?tab=today&day=${TODAY}`);
    expect(k.to(EP.asha)).toEqual([]);
    // She narrows the plan away from him: the 10:00 follow-up sends nothing.
    await k.her('POST', '/v1/p/agreement/narrow', { see: { plan: false } });
    await k.at(`${TODAY}T10:30:00.000Z`);
    expect(k.to(EP.sam).filter((p) => /isn't done yet/.test(p.body))).toHaveLength(1);
  });

  it('a follow-up on an assigned to-do is re-checked too', async () => {
    await k.subscribeAll();
    const id = ((await k.him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'Pay rent', due: { day: TODAY }, followUp: '13:00' })).json() as { id: string }).id;
    await k.her('POST', `/v1/p/todos/${id}/done`, { done: true });
    await k.at(`${TODAY}T13:30:00.000Z`);
    expect(k.to(EP.sam)).toEqual([]);
    await k.him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'Book tickets', due: { day: TODAY }, followUp: '14:00' });
    await k.at(`${TODAY}T14:10:00.000Z`);
    await eventually(() => expect(k.to(EP.sam)).toHaveLength(1));
    expect(k.to(EP.sam)[0]?.url).toBe(`/people/${f.asha.id}?tab=todos&day=${TODAY}`);
  });

  it('is one push at that time: still open 45 minutes on, he gets no second one (a to-do and a step)', async () => {
    await k.subscribeAll();
    await k.him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'Renew the form', due: { day: TODAY }, followUp: '10:45' });
    await put({ srev: 0, steps: [{ title: 'Call the bank', followUp: '10:50' }], send: 'quiet' });
    // Walk the clock a few minutes at a time, so every 15-minute recheck gets its sweep.
    for (let m = 40; m <= 60 + 45; m += 5) await k.at(`${TODAY}T${String(10 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00.000Z`);
    await eventually(() => expect(k.to(EP.sam).filter((p) => /isn't done yet/.test(p.body))).toHaveLength(2));
    await k.at(`${TODAY}T12:30:00.000Z`);
    const followUps = k.to(EP.sam).filter((p) => /isn't done yet/.test(p.body));
    expect(followUps.map((p) => p.url)).toEqual([`/people/${f.asha.id}?tab=todos&day=${TODAY}`, `/people/${f.asha.id}?tab=today&day=${TODAY}`]);
    expect(k.to(EP.asha).filter((p) => /isn't done yet/.test(p.body))).toEqual([]);
  });

  it('skipped in his quiet hours, it goes once when they end, then never again', async () => {
    await k.subscribeAll();
    expect((await k.him('PATCH', '/v1/people/prefs', { quiet: { from: '10:00', to: '11:00' } })).statusCode).toBe(200);
    await k.him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'Pay the fee', due: { day: TODAY }, followUp: '10:15' });
    for (let m = 10; m <= 60 + 50; m += 5) await k.at(`${TODAY}T${String(10 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00.000Z`);
    await eventually(() => expect(k.to(EP.sam).filter((p) => /isn't done yet/.test(p.body))).toHaveLength(1));
    await k.at(`${TODAY}T13:00:00.000Z`);
    expect(k.to(EP.sam).filter((p) => /isn't done yet/.test(p.body))).toHaveLength(1);
  });
});

describe('her steps: ack, check-in, ask, carry', () => {
  it('Got it and Ask only on his steps; a check-in only on a check-in step; carry moves her own open step', async () => {
    await k.subscribeAll();
    await put({ srev: 0, steps: [{ title: 'Night check-in', ask: 'checkin' }, { title: 'Plain' }], send: 'quiet' });
    const mine = ((await k.her('POST', `/v1/p/plans/${TODAY}/steps`, { title: 'Read' })).json() as { id: string }).id;
    const [ci, plain] = (await herPlan()).plan?.steps ?? [];
    expect((await k.her('POST', `/v1/p/plans/${TODAY}/steps/${ci?.id}/ack`)).statusCode).toBe(200);
    expect((await k.her('POST', `/v1/p/plans/${TODAY}/steps/${mine}/ack`)).statusCode).toBe(409);
    expect((await k.her('POST', `/v1/p/plans/${TODAY}/steps/${plain?.id}/checkin`, { mood: 3, energy: 3 })).statusCode).toBe(409);
    expect((await k.her('POST', `/v1/p/plans/${TODAY}/steps/${ci?.id}/checkin`, { mood: 4, energy: 2, line: 'Tired but fine' })).statusCode).toBe(200);
    const ask = await k.her('POST', `/v1/p/plans/${TODAY}/steps/${plain?.id}/ask`, { note: 'Can this be tomorrow?' });
    expect(ask.statusCode, ask.body).toBe(200);
    await eventually(() => expect(k.to(EP.sam)).toHaveLength(1));
    expect(k.to(EP.sam)[0]?.body).toBe('Alert from Asha');
    expect((await k.her('POST', `/v1/p/plans/${TODAY}/steps/${mine}/ask`, { note: 'x' })).statusCode).toBe(409);
    // Carry: hers only, to a later day; his are 404 for her carry.
    expect((await k.her('POST', `/v1/p/plans/${TODAY}/steps/${plain?.id}/carry`, { to: TOMORROW })).statusCode).toBe(404);
    expect((await k.her('POST', `/v1/p/plans/${TODAY}/steps/${mine}/carry`, { to: TODAY })).statusCode).toBe(400);
    expect((await k.her('POST', `/v1/p/plans/${TODAY}/steps/${mine}/carry`, { to: TOMORROW })).statusCode).toBe(200);
    expect((await herPlan()).plan?.steps.find((s) => s.id === mine)?.carriedTo).toBe(TOMORROW);
    const t = await herPlan(TOMORROW);
    expect(t.plan?.steps.map((s) => [s.title, s.carriedFrom])).toEqual([['Read', { day: TODAY, stepId: mine }]]);
    // A carried step can't be ticked here.
    expect((await k.her('POST', `/v1/p/plans/${TODAY}/steps/${mine}/state`, { to: 'done' })).statusCode).toBe(409);
  });

  it('30 steps at most', async () => {
    const steps = Array.from({ length: 30 }, (_, i) => ({ title: `S${i}` }));
    expect((await put({ srev: 0, steps, send: 'quiet' })).statusCode).toBe(200);
    expect((await k.her('POST', `/v1/p/plans/${TODAY}/steps`, { title: 'One more' })).statusCode).toBe(409);
    expect((await put({ srev: 1, steps: [...steps, { title: 'x' }] })).statusCode).toBe(400);
  });
});
