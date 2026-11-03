/**
 * v0.12 People (P1): her medicines and doses, as each side reads and writes
 * them (spec 3.4, 8.2, 8.4, 9.7.3 people-medicines), on the isolation
 * fixture (Sam, Asha on Everything with food off, Bea on Standard).
 *
 * - His add (assign.meds) shows "by ''"; she edits or stops any of hers, his
 *   included, and he hears of a change to one he added; his edit of hers
 *   needs editHers.meds and sets "Edited by" with old and new values in her
 *   Activity; a time change moves her ping row at once.
 * - Only she logs and undoes a dose; he has no dose verb and never deletes.
 * - M5 / isolation: her credential never reaches his medicines, nor Bea's
 *   hers; his routes never exceed the agreement (adherence names nothing;
 *   off is the unknown-pid 404, a locked tile on Today and her mirror);
 *   a paused person holds his writes (409).
 * - T10 / M21: his view deep-equals her mirror at full, adherence and off,
 *   active and paused. Each allowed read of his is one view mark an hour.
 * - The two-day concern ("Doses not logged 2 days running") on his view,
 *   her mirror and his Today concern lines; the 21:00 summary's dose line.
 * - Her dose rings her devices only, sub `<pid>|HH:MM`, never merged with
 *   his at the same minute, and keeps ringing after a resync; nothing of hers
 *   rings while People is off (her to-do reminders included).
 * - T11: her export holds her medicines and doses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerMedsView, PersonActivityResponse, PersonMedicinesResponse, PersonToday } from '@jantar/protocol/people';
import type { LifeScheduler } from '../../src/life/scheduler.js';
import { DAY, OWNER_HOST, OWNER_ORIGIN, UNKNOWN_ULID, credHeaders, makeFixture, onHer, type Cred, type Fixture } from '../people/isolation-fixture.js';

let f: Fixture;
beforeEach(async () => {
  f = await makeFixture();
}, 60_000);
afterEach(async () => {
  await f?.close();
});

const him = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: object, cred: Cred = f.owner.control) =>
  f.api.tcp.inject({ method, url, headers: { host: OWNER_HOST, origin: OWNER_ORIGIN, ...credHeaders(cred) }, ...(payload ? { payload } : {}) });
const herCall = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: object, who: Cred = f.asha.full) => onHer(f.api, method, url, who, payload);
const NEXT_DAY = '2026-11-04';
const med = (name: string, times: string[] = ['20:00'], extra: object = {}) => ({ name, dose: '1 tablet', times, schedule: { freq: 'daily' }, ...extra });
const idOf = (r: { json(): unknown }) => (r.json() as { id: string }).id;
const activity = async () => ((await herCall('GET', '/v1/p/activity')).json() as PersonActivityResponse).activity;
const herMeds = async () => (await herCall('GET', '/v1/p/medicines')).json() as PersonMedicinesResponse;
const subscribe = async () => {
  await herCall('POST', '/v1/p/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/asha', keys: { p256dh: 'p', auth: 'a' } } });
  await him('POST', '/v1/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/sam', keys: { p256dh: 'p', auth: 'a' } } });
};
const pushes = (to: 'asha' | 'sam') =>
  f.api.fakes.pushed.filter((p) => p.endpoint.endsWith(`/${to}`)).map((p) => JSON.parse(p.payload) as { title: string; body: string; url: string });

describe('her medicines and his additions', () => {
  it('he adds one (by ""); she edits and stops it; he hears of her change; only she logs doses', async () => {
    await subscribe();
    f.api.fakes.pushed.length = 0;
    const a = await him('POST', `/v1/people/${f.asha.id}/medicines`, med('Vitamin D', ['09:30']));
    expect(a.statusCode, a.body).toBe(201);
    const id = idOf(a);
    expect((await herMeds()).medicines.find((m) => m.id === id)).toMatchObject({ name: 'Vitamin D', by: '' });
    expect((await activity()).find((r) => r.action === 'med.added')).toMatchObject({ actor: 'owner', title: 'Vitamin D', area: 'meds' });
    // Her push says who and where, never the medicine's name (a lock screen).
    await vi.waitFor(() => expect(pushes('asha')).toEqual([expect.objectContaining({ title: 'From Sam', body: 'Sam added a medicine for you', url: '/p/health?tab=meds' })]));
    expect(JSON.stringify(pushes('asha'))).not.toContain('Vitamin');
    // Her phone, her medicine: she edits the one he added, and he is told (see.meds full).
    f.api.fakes.pushed.length = 0;
    expect((await herCall('PATCH', `/v1/p/medicines/${id}`, { dose: '2 tablets' })).statusCode).toBe(200);
    await vi.waitFor(() => expect(pushes('sam')).toEqual([expect.objectContaining({ title: 'Asha changed a medicine you added', url: `/people/${f.asha.id}?tab=health` })]));
    // Only she logs a dose (and undoes it).
    const dose = await herCall('POST', `/v1/p/medicines/${id}/doses`, { day: '2026-11-03', slot: '09:30', status: 'taken' });
    expect(dose.statusCode, dose.body).toBe(201);
    const day = (await herMeds()).day.groups.flatMap((g) => g.items).find((i) => i.medId === id);
    expect(day).toMatchObject({ status: 'taken', doseId: idOf(dose) });
    expect((await herCall('DELETE', `/v1/p/medicines/${id}/doses/${idOf(dose)}`)).statusCode).toBe(200);
    expect((await herCall('POST', `/v1/p/medicines/${id}/stop`)).statusCode).toBe(200);
    expect((await herMeds()).medicines.find((m) => m.id === id)?.stoppedOn).toBe('2026-11-03');
  });

  it('his edit of hers needs editHers.meds, sets "Edited by", keeps old and new values, and moves her ping at once', async () => {
    const id = idOf(await herCall('POST', '/v1/p/medicines', med('Iron', ['09:00'])));
    expect((await herMeds()).medicines.find((m) => m.id === id)).toMatchObject({ by: f.asha.id });
    f.api.fakes.pushed.length = 0;
    const e = await him('PATCH', `/v1/people/${f.asha.id}/medicines/${id}`, { times: ['08:30'] });
    expect(e.statusCode, e.body).toBe(200);
    const m = (await herMeds()).medicines.find((x) => x.id === id);
    expect(m).toMatchObject({ by: f.asha.id, editedBy: '', times: ['08:30'] });
    expect(m?.editedAt).toEqual(expect.any(String));
    const edit = (await activity()).find((r) => r.action === 'med.edited');
    expect(edit).toMatchObject({ actor: 'owner', title: 'Iron', area: 'meds' });
    expect(edit?.changes).toEqual([{ field: 'times', from: '09:00', to: '08:30' }]);
    // Her ping row follows the new time (sub <pid>|HH:MM), ringing her devices.
    const rows = pingRows(id);
    expect(rows.map((r) => r.sub)).toEqual([`${f.asha.id}|08:30`]);
    expect(rows.every((r) => r.person === f.asha.id)).toBe(true);
    // Without editHers.meds her medicine is out of his reach (as if it didn't exist); his own stay his.
    await herCall('POST', '/v1/p/agreement/narrow', { editHers: { meds: false } });
    expect((await him('PATCH', `/v1/people/${f.asha.id}/medicines/${id}`, { dose: 'x' })).statusCode).toBe(404);
    expect((await him('POST', `/v1/people/${f.asha.id}/medicines/${id}/stop`)).statusCode).toBe(404);
    const mine = idOf(await him('POST', `/v1/people/${f.asha.id}/medicines`, med('Calcium')));
    expect((await him('PATCH', `/v1/people/${f.asha.id}/medicines/${mine}`, { dose: '2 tablets' })).statusCode).toBe(200);
    expect((await him('POST', `/v1/people/${f.asha.id}/medicines/${mine}/stop`)).statusCode).toBe(200);
    expect((await activity()).find((r) => r.action === 'med.stopped')).toMatchObject({ title: 'Calcium' });
  });

  it('paused holds his writes (409), not his reads; bodies naming an author or a space are refused', async () => {
    await herCall('POST', '/v1/p/pause', {});
    const r = await him('POST', `/v1/people/${f.asha.id}/medicines`, med('Wait'));
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(/has paused/);
    expect((await him('GET', `/v1/people/${f.asha.id}/medicines`)).statusCode).toBe(200);
    await herCall('POST', '/v1/p/resume', {});
    for (const extra of [{ by: '' }, { space: '' }, { editedBy: '' }, { person: 'x' }]) {
      expect((await him('POST', `/v1/people/${f.asha.id}/medicines`, med('T', ['20:00'], extra))).statusCode, JSON.stringify(extra)).toBe(400);
      expect((await herCall('POST', '/v1/p/medicines', med('T', ['20:00'], extra))).statusCode, JSON.stringify(extra)).toBe(400);
    }
  });
});

function pingRows(ref: string): { sub: string; person: string }[] {
  const core = f.life.people.openCore();
  if (!core) throw new Error('life.db is not open');
  return core.db.prepare("SELECT sub, person FROM pings WHERE kind = 'med' AND ref = ? ORDER BY sub").all(ref) as unknown as { sub: string; person: string }[];
}

describe('isolation: her credential, Bea, and his own medicines', () => {
  it("she never reaches his medicines, Bea never hers; his /v1/medicines lists none of hers", async () => {
    const his = idOf(await him('POST', '/v1/medicines', med('CANARY-sam-med')));
    const ashas = idOf(await herCall('POST', '/v1/p/medicines', med('CANARY-asha-med')));
    const beas = idOf(await herCall('POST', '/v1/p/medicines', med('CANARY-bea-med'), f.bea.full));
    for (const [who, other] of [
      [f.asha.full, his],
      [f.asha.full, beas],
      [f.bea.full, ashas],
    ] as const) {
      for (const [m, url, body] of [
        ['PATCH', `/v1/p/medicines/${other}`, { dose: 'x' }],
        ['POST', `/v1/p/medicines/${other}/stop`, undefined],
        ['POST', `/v1/p/medicines/${other}/doses`, { day: '2026-11-03', slot: '20:00', status: 'taken' }],
        ['DELETE', `/v1/p/medicines/${other}/doses/${UNKNOWN_ULID}`, undefined],
      ] as const) {
        const r = await herCall(m, url, body, who);
        expect(r.statusCode, `${who.name} ${m} ${url}`).toBe(404);
      }
    }
    const asha = JSON.stringify(await herMeds());
    const bea = JSON.stringify((await herCall('GET', '/v1/p/medicines', undefined, f.bea.full)).json());
    const sam = JSON.stringify((await him('GET', '/v1/medicines')).json());
    expect(asha).toContain('CANARY-asha-med');
    expect(asha).not.toMatch(/CANARY-sam-med|CANARY-bea-med/);
    expect(bea).not.toMatch(/CANARY-sam-med|CANARY-asha-med/);
    expect(sam).not.toMatch(/CANARY-asha-med|CANARY-bea-med/);
    // His own medicine's dose and stop stay his (his routes), and a row of Asha's under Bea's pid is 404.
    expect((await him('POST', `/v1/people/${f.bea.id}/medicines/${ashas}/stop`)).statusCode).toBe(404);
    expect((await him('PATCH', `/v1/medicines/${ashas}`, { dose: 'x' })).statusCode).toBe(404);
  });

  it("his routes never exceed the agreement: adherence names nothing; off is the unknown-pid 404", async () => {
    const id = idOf(await herCall('POST', '/v1/p/medicines', med('CANARY-name', ['20:00'], { dose: 'CANARY-dose' })));
    await herCall('POST', '/v1/p/agreement/narrow', { see: { meds: 'adherence' } });
    const v = await him('GET', `/v1/people/${f.asha.id}/medicines`);
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ level: 'adherence', notLoggedToday: 0, concern: null });
    expect(v.body).not.toMatch(/CANARY|20:00|Iron/);
    const t = (await him('GET', `/v1/people/${f.asha.id}/today`)).json() as PersonToday;
    expect(JSON.stringify(t.meds)).not.toMatch(/CANARY/);
    // No add or edit below full (assign.meds and editHers.meds need it).
    expect((await him('POST', `/v1/people/${f.asha.id}/medicines`, med('Nope'))).statusCode).toBe(404);
    expect((await him('PATCH', `/v1/people/${f.asha.id}/medicines/${id}`, { dose: 'x' })).statusCode).toBe(404);
    await herCall('POST', '/v1/p/agreement/narrow', { see: { meds: 'off' } });
    const off = await him('GET', `/v1/people/${f.asha.id}/medicines`);
    const unknown = await him('GET', `/v1/people/${UNKNOWN_ULID}/medicines`);
    expect([off.statusCode, off.body]).toEqual([unknown.statusCode, unknown.body]);
    expect(((await him('GET', `/v1/people/${f.asha.id}/today`)).json() as PersonToday).meds).toEqual({ locked: true });
    expect((await herCall('GET', '/v1/p/mirror/meds')).json()).toEqual({ locked: true });
    // Her own medicines are hers whatever he sees.
    expect((await herMeds()).medicines.map((m) => m.id)).toEqual([id]);
  });

  it('ending, left and forgotten people are the unknown-pid answer', async () => {
    const unknown = await him('GET', `/v1/people/${UNKNOWN_ULID}/medicines`);
    for (const pid of [f.dev.id, f.eli.id, f.fay.id, f.gus.id]) {
      const r = await him('GET', `/v1/people/${pid}/medicines`);
      expect([r.statusCode, r.body], pid).toEqual([unknown.statusCode, unknown.body]);
    }
  });
});

describe('T10 / M21 and view marks', () => {
  it('his view equals her mirror at full, adherence and off, active and paused; his reads mark her record once an hour', async () => {
    await herCall('POST', '/v1/p/medicines', med('Mirror me', ['08:00', '20:00']));
    await him('POST', `/v1/people/${f.asha.id}/medicines`, med('From him', ['09:00']));
    const pair = async () => {
      const mirror = (await herCall('GET', '/v1/p/mirror/meds')).json() as OwnerMedsView | { locked: true };
      const his = await him('GET', `/v1/people/${f.asha.id}/medicines`);
      if ('locked' in mirror) expect(his.statusCode).toBe(404);
      else expect(his.json()).toEqual(mirror);
      const today = (await him('GET', `/v1/people/${f.asha.id}/today`)).json() as PersonToday;
      expect(today).toEqual((await herCall('GET', '/v1/p/mirror/today')).json());
    };
    await pair();
    await herCall('POST', '/v1/p/pause', {});
    await pair();
    await herCall('POST', '/v1/p/resume', {});
    await herCall('POST', '/v1/p/agreement/narrow', { see: { meds: 'adherence' } });
    await pair();
    await herCall('POST', '/v1/p/agreement/narrow', { see: { meds: 'off' } });
    await pair();
    const marks = (await activity()).filter((r) => r.action === 'view' && r.area === 'meds');
    expect(marks).toHaveLength(1);
  });
});

describe('the two-day concern and his summary', () => {
  it('doses not logged two days running: on his view, her mirror and his Today; counts only in his summary', async () => {
    await herCall('POST', '/v1/p/medicines', med('Daily one', ['20:00']));
    let v = (await him('GET', `/v1/people/${f.asha.id}/medicines`)).json() as OwnerMedsView;
    expect(v.concern).toBeNull();
    // Wednesday 20:01: Tuesday's 20:00 went by, Wednesday's is a minute old: not a miss within its 60-minute grace.
    f.api.ctx.clock.set(`${NEXT_DAY}T20:01:00.000Z`);
    v = (await him('GET', `/v1/people/${f.asha.id}/medicines`)).json() as OwnerMedsView;
    expect(v.concern).toBeNull();
    expect(((await him('GET', `/v1/people/${f.asha.id}/today`)).json() as PersonToday).concerns).toEqual([]);
    expect(f.life.people.alerts?.summaryText() ?? '').not.toMatch(/dose|not logged/);
    f.api.ctx.clock.set(`${NEXT_DAY}T21:01:00.000Z`);
    v = (await him('GET', `/v1/people/${f.asha.id}/medicines`)).json() as OwnerMedsView;
    expect(v.concern).toBe('Doses not logged 2 days running. Worth checking in.');
    expect(((await herCall('GET', '/v1/p/mirror/meds')).json() as OwnerMedsView).concern).toBe(v.concern);
    const today = (await him('GET', `/v1/people/${f.asha.id}/today`)).json() as PersonToday;
    expect(today.concerns).toContain('Doses not logged 2 days running. Worth checking in.');
    const summary = f.life.people.alerts?.summaryText() ?? '';
    expect(summary).toContain('Asha');
    expect(summary).toContain('1 dose not logged');
    expect(summary).toContain('not logged 2 days running');
    expect(summary).not.toContain('Daily one');
    // At adherence the concern stays, and still names nothing.
    await herCall('POST', '/v1/p/agreement/narrow', { see: { meds: 'adherence' } });
    const adh = (await him('GET', `/v1/people/${f.asha.id}/medicines`)).json() as OwnerMedsView;
    expect(adh).toMatchObject({ level: 'adherence', notLoggedToday: 1, concern: v.concern });
    await herCall('POST', '/v1/p/agreement/narrow', { see: { meds: 'off' } });
    expect(f.life.people.alerts?.summaryText() ?? '').not.toMatch(/dose/);
  });

  it('a time already gone by when she added it is no dose not logged that day, on any line of his', async () => {
    // Tuesday 09:00: she adds one at 07:00 and 20:00, and logs Tuesday's 20:00.
    await herCall('POST', '/v1/p/agreement/narrow', { see: { meds: 'adherence' } });
    const id = idOf(await herCall('POST', '/v1/p/medicines', med('Inhaler', ['07:00', '20:00'])));
    f.api.ctx.clock.set(`${DAY}T09:01:00.000Z`);
    expect((await him('GET', `/v1/people/${f.asha.id}/medicines`)).json()).toEqual({ level: 'adherence', pct: null, notLoggedToday: 0, concern: null });
    expect(f.life.people.alerts?.summaryText() ?? '').not.toMatch(/dose|not logged/);
    // Her own list still has it, to log if she took it before adding it.
    expect((await herMeds()).day.groups.flatMap((g) => g.items).map((i) => [i.slot, i.status, i.overdue, i.beforeAdded])).toEqual([
      ['07:00', 'pending', false, true],
      ['20:00', 'pending', false, undefined],
    ]);
    f.api.ctx.clock.set(`${DAY}T20:05:00.000Z`);
    expect((await herCall('POST', `/v1/p/medicines/${id}/doses`, { day: DAY, slot: '20:00', status: 'taken' })).statusCode).toBe(201);
    // Wednesday 08:30: one dose not logged (07:00), on one day only. No concern.
    f.api.ctx.clock.set(`${NEXT_DAY}T08:30:00.000Z`);
    expect((await him('GET', `/v1/people/${f.asha.id}/medicines`)).json()).toEqual({ level: 'adherence', pct: 50, notLoggedToday: 1, concern: null });
    expect(((await him('GET', `/v1/people/${f.asha.id}/today`)).json() as PersonToday).concerns).toEqual([]);
  });
});

describe('her dose rings her devices', () => {
  it('her 09:30 and his 09:30 are two pushes, each to its own devices; hers opens her app; a resync keeps hers', async () => {
    await subscribe();
    const hers = idOf(await herCall('POST', '/v1/p/medicines', med('Hers', ['09:30'])));
    idOf(await him('POST', '/v1/medicines', med('His', ['09:30'])));
    (f.life.people.openCore()?.scheduler as LifeScheduler).resyncAll();
    expect(pingRows(hers).map((r) => [r.sub, r.person])).toEqual([[`${f.asha.id}|09:30`, f.asha.id]]);
    f.api.fakes.pushed.length = 0;
    f.api.ctx.clock.advance(31 * 60_000);
    await vi.waitFor(() => expect(f.api.fakes.pushed.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    const sent = f.api.fakes.pushed.map((p) => ({ endpoint: p.endpoint, ...(JSON.parse(p.payload) as { title: string; url: string }) }));
    const toHer = sent.filter((p) => p.endpoint.endsWith('/asha'));
    const toHim = sent.filter((p) => p.endpoint.endsWith('/sam'));
    expect(toHer).toEqual([expect.objectContaining({ title: 'Medicine due', url: `/p/health?tab=meds&dose=${hers}@0930` })]);
    expect(toHim).toEqual([expect.objectContaining({ title: 'Medicine due' })]);
    expect(toHim[0]?.url).toMatch(/^\/today\?dose=/);
  });

  it('nothing of hers rings while People is off: her dose and her to-do reminder wait', async () => {
    await subscribe();
    await herCall('POST', '/v1/p/medicines', med('Hers', ['09:30']));
    await herCall('POST', '/v1/p/todos', { title: 'Take the bins out', due: { day: '2026-11-03', time: '09:20' } });
    await f.api.ctl.inject({ method: 'POST', url: '/v1/people/switch', payload: { on: false } });
    f.api.fakes.pushed.length = 0;
    f.api.ctx.clock.advance(40 * 60_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(f.api.fakes.pushed.filter((p) => p.endpoint.endsWith('/asha'))).toEqual([]);
    // Back on: the rows were kept and catch up once (each marked late), still to her devices only.
    await f.api.ctl.inject({ method: 'POST', url: '/v1/people/switch', payload: { on: true } });
    f.api.ctx.clock.advance(31_000);
    await vi.waitFor(() => expect(f.api.fakes.pushed.filter((p) => p.endpoint.endsWith('/asha')).length).toBeGreaterThanOrEqual(1), { timeout: 3000 });
    expect(f.api.fakes.pushed.some((p) => p.endpoint.endsWith('/sam'))).toBe(false);
  });
});

describe('T11: her export holds her medicines and doses', () => {
  it('json export lists them; his medicine is not in it', async () => {
    const id = idOf(await herCall('POST', '/v1/p/medicines', med('Exported', ['08:00'])));
    await herCall('POST', `/v1/p/medicines/${id}/doses`, { day: '2026-11-03', slot: '08:00', status: 'taken' });
    await him('POST', '/v1/medicines', med('CANARY-his'));
    const r = await herCall('GET', '/v1/p/export?format=json');
    expect(r.statusCode).toBe(200);
    const data = r.json() as { medicines: { id: string; name: string }[]; doses: { medId: string; slot: string }[] };
    expect(data.medicines.map((m) => m.name)).toEqual(['Exported']);
    expect(data.doses).toEqual([expect.objectContaining({ medId: id, slot: '08:00' })]);
    expect(r.body).not.toContain('CANARY-his');
  });
});
