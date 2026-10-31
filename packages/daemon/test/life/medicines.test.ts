/**
 * Medicines (v0.4 spec 1.4, 4.5): the write rules (times sorted and unique,
 * the start day, history from today), the day checklist (pending today,
 * overdue past the grace, missed on a past day, an off day absent), doses
 * (one row per slot, Taken takes pills and Skip, Undo or a switch gives
 * them back, never below 0, Took it at and backdating, nothing after now
 * nor before the day before), supply and the 30-day adherence (a schedule
 * or times edit leaves past days as they were, and a times edit after
 * today's dose was taken asks for no second one), Stop (the day of a Stop
 * keeps only the doses up to it, on the list and in adherence) and Delete, and the
 * routes: ids-only replies, fixed sentences, an audit of the target id
 * only, and replies that match the protocol. Synthetic medicines only
 * (Testamol, Placebin, Examplex).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { instantAt, shiftDay, weekdayOf } from '@jantar/life-core';
import { EXAMPLEX, LIFE_MARKER, PLACEBIN, doseBody, medBody } from '@jantar/fixtures';
import { IdReplySchema, LIFE_LIMITS, MedicinesResponseSchema, OkReplySchema, SettingsSchema, type MedicineBody, type MedsDayItem } from '@jantar/protocol';
import type { Actor, LifeResult, LifeService, MedicinesModule } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { createTestContext, createTestLifeCore, type TestLifeCore } from '../../src/core/testing.js';
import { MED_SENTENCES, buildMedicinesModule } from '../../src/life/medicines/module.js';
import { getMed } from '../../src/life/medicines/repo.js';
import { h, makeApi, makeFakes, pairCookie, type TestApi } from '../api/fakes.js';

const TZ = 'Asia/Kolkata';
const DAY = '2026-10-30';
const PHONE: Actor = { kind: 'device', deviceId: 'dev-phone', scopes: ['read', 'control'] };
const at = (day: string, hhmm: string) => instantAt(day, hhmm, TZ);

let core: TestLifeCore | undefined;
let api: TestApi | undefined;
afterEach(async () => {
  core?.close();
  core = undefined;
  await api?.close();
  api = undefined;
});

function setup(start: Date = at(DAY, '07:00')): { core: TestLifeCore; meds: MedicinesModule } {
  const clock = new FakeClock(start.toISOString());
  core = createTestLifeCore({ clock, tz: TZ, settings: { medicines: true } });
  const ctx = createTestContext({ clock });
  const f = makeFakes(ctx);
  return { core, meds: buildMedicinesModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy }) };
}

function ok<T>(r: LifeResult<T>): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return r.value;
}

function refused<T>(r: LifeResult<T>): { code: string; reason: string } {
  if (r.ok) throw new Error('expected a refusal');
  return { code: r.code, reason: r.reason };
}

/** Every checklist item of a day, flat. */
function items(meds: MedicinesModule, day?: string): MedsDayItem[] {
  return ok(meds.get(day)).day.groups.flatMap((g) => g.items);
}

const view = (meds: MedicinesModule, id: string) => ok(meds.get()).medicines.find((m) => m.id === id);

describe('create', () => {
  it('sorts and dedupes times, fills the start day, starts the history from it, and replies with the id only', () => {
    const { core, meds } = setup();
    const r = ok(meds.create(medBody({ times: ['21:00', '08:00', '21:00'] }), PHONE));
    expect(Object.keys(r)).toEqual(['id']);
    const med = getMed(core, r.id);
    expect(med?.times).toEqual(['08:00', '21:00']);
    expect(med?.schedule).toEqual({ freq: 'daily', startDay: DAY });
    expect(med?.history).toEqual([{ from: DAY, schedule: { freq: 'daily', startDay: DAY } }]);
    expect(med?.startedOn).toBe(DAY);
    expect(med?.pills).toEqual({ left: 10, perDose: 1 });
    expect(core.changedCount).toBe(1);
  });

  it('keeps a given start day, and weekdays sorted and unique', () => {
    const { core, meds } = setup();
    const { id } = ok(meds.create(medBody({ schedule: { freq: 'weekly', byWeekday: [5, 1, 5], startDay: '2026-10-01' } }), PHONE));
    expect(getMed(core, id)?.schedule).toEqual({ freq: 'weekly', byWeekday: [1, 5], startDay: '2026-10-01' });
    expect(getMed(core, id)?.history[0]?.from).toBe('2026-10-01');
  });

  it(`refuses the ${LIFE_LIMITS.medicines + 1}st with the fixed sentence`, () => {
    const { meds } = setup();
    for (let i = 0; i < LIFE_LIMITS.medicines; i++) ok(meds.create({ ...PLACEBIN, name: `Placebin ${i}` }, PHONE));
    expect(refused(meds.create(PLACEBIN, PHONE))).toEqual({ code: 'conflict', reason: 'You have 50 medicines. Delete one to add another.' });
  });
});

describe('the day checklist', () => {
  it('groups by morning and night; today an unlogged dose is pending, and overdue only after 60 minutes', () => {
    const { core, meds } = setup(at(DAY, '07:00'));
    const testamol = ok(meds.create(medBody(), PHONE)).id;
    const placebin = ok(meds.create(PLACEBIN, PHONE)).id;
    const day = ok(meds.get()).day;
    expect(day.day).toBe(DAY);
    expect(day.today).toBe(DAY);
    expect(day.groups.map((g) => g.period)).toEqual(['morning', 'night']);
    expect(day.groups[0]?.items.map((i) => [i.name, i.slot, i.status, i.overdue])).toEqual([
      ['Placebin', '08:00', 'pending', false],
      ['Testamol', '08:00', 'pending', false],
    ]);
    expect(day.groups[0]?.items[1]).toMatchObject({ medId: testamol, dose: '500 mg' });

    core.clock.set(at(DAY, '09:00').toISOString());
    expect(items(meds).find((i) => i.medId === placebin && i.slot === '08:00')?.overdue).toBe(false);
    core.clock.set(at(DAY, '09:01').toISOString());
    const now = items(meds);
    expect(now.find((i) => i.medId === placebin)).toMatchObject({ status: 'pending', overdue: true });
    expect(now.find((i) => i.medId === testamol && i.slot === '21:00')).toMatchObject({ status: 'pending', overdue: false });
  });

  it('a past day shows its unlogged doses as missed; a day after today is refused', () => {
    const { core, meds } = setup(at(DAY, '07:00'));
    ok(meds.create(medBody(), PHONE));
    core.clock.set(at(shiftDay(DAY, 1), '07:00').toISOString());
    expect(items(meds, DAY).map((i) => [i.slot, i.status, i.overdue])).toEqual([
      ['08:00', 'missed', false],
      ['21:00', 'missed', false],
    ]);
    expect(refused(meds.get(shiftDay(DAY, 2)))).toEqual({ code: 'invalid_request', reason: MED_SENTENCES.future });
  });

  it('leaves out a medicine on a day its schedule skips, and before it was added', () => {
    const { core, meds } = setup(at(DAY, '07:00'));
    ok(meds.create({ ...EXAMPLEX, schedule: { freq: 'weekly', byWeekday: [weekdayOf(DAY)] } }, PHONE));
    ok(meds.create({ ...PLACEBIN, schedule: { freq: 'interval', interval: 2 } }, PHONE));
    expect(items(meds).map((i) => i.name)).toEqual(['Examplex', 'Placebin']);
    core.clock.set(at(shiftDay(DAY, 1), '07:00').toISOString());
    expect(items(meds)).toEqual([]);
    core.clock.set(at(shiftDay(DAY, 2), '07:00').toISOString());
    expect(items(meds).map((i) => i.name)).toEqual(['Placebin']);
    expect(items(meds, shiftDay(DAY, -1))).toEqual([]);
  });

  it("is Today's part too", () => {
    const { meds } = setup();
    ok(meds.create(medBody(), PHONE));
    expect(meds.today(DAY).meds?.groups.flatMap((g) => g.items).map((i) => i.slot)).toEqual(['08:00', '21:00']);
  });
});

describe('doses', () => {
  it('Taken takes the pills per dose and a second tap on the same slot stays one row with the same id', () => {
    const { core, meds } = setup(at(DAY, '08:05'));
    const id = ok(meds.create(medBody({ pills: { left: 10, perDose: 2 } }), PHONE)).id;
    const first = ok(meds.logDose(id, doseBody({ day: DAY, slot: '08:00' }), PHONE));
    const again = ok(meds.logDose(id, doseBody({ day: DAY, slot: '08:00' }), PHONE));
    expect(Object.keys(first)).toEqual(['id']);
    expect(again.id).toBe(first.id);
    expect(core.db.prepare('SELECT COUNT(*) AS n FROM doses').get()).toEqual({ n: 1 });
    expect(getMed(core, id)?.pills?.left).toBe(8);
    const item = items(meds).find((i) => i.slot === '08:00');
    expect(item).toMatchObject({ status: 'taken', doseId: first.id, at: at(DAY, '08:05').toISOString(), overdue: false });
    expect(item?.late).toBeUndefined();
  });

  it('switching Taken to Skip gives the pills back; Skip takes none; Undo of a Taken dose gives them back', () => {
    const { core, meds } = setup(at(DAY, '08:05'));
    const id = ok(meds.create(medBody(), PHONE)).id;
    const dose = ok(meds.logDose(id, doseBody({ status: 'taken' }), PHONE)).id;
    expect(getMed(core, id)?.pills?.left).toBe(9);
    ok(meds.logDose(id, doseBody({ status: 'skipped' }), PHONE));
    expect(getMed(core, id)?.pills?.left).toBe(10);
    expect(items(meds).find((i) => i.slot === '08:00')?.status).toBe('skipped');
    ok(meds.logDose(id, doseBody({ status: 'taken' }), PHONE));
    expect(getMed(core, id)?.pills?.left).toBe(9);
    ok(meds.undoDose(id, dose, PHONE));
    expect(getMed(core, id)?.pills?.left).toBe(10);
    expect(items(meds).find((i) => i.slot === '08:00')).toMatchObject({ status: 'pending' });
    expect(refused(meds.undoDose(id, dose, PHONE))).toEqual({ code: 'not_found', reason: MED_SENTENCES.doseNotFound });
  });

  it('never takes the count below zero', () => {
    const { core, meds } = setup(at(DAY, '22:00'));
    const id = ok(meds.create(medBody({ pills: { left: 1, perDose: 2 } }), PHONE)).id;
    ok(meds.logDose(id, doseBody({ slot: '08:00' }), PHONE));
    expect(getMed(core, id)?.pills?.left).toBe(0);
    ok(meds.logDose(id, doseBody({ slot: '21:00' }), PHONE));
    expect(getMed(core, id)?.pills?.left).toBe(0);
  });

  it('Took it at keeps the time it was taken and marks it late past the grace; a time after now is refused', () => {
    const { meds } = setup(at(DAY, '12:00'));
    const id = ok(meds.create(medBody(), PHONE)).id;
    ok(meds.logDose(id, doseBody({ at: at(DAY, '09:30').toISOString() }), PHONE));
    expect(items(meds).find((i) => i.slot === '08:00')).toMatchObject({ status: 'taken', late: true, at: at(DAY, '09:30').toISOString() });
    ok(meds.logDose(id, doseBody({ at: at(DAY, '08:45').toISOString() }), PHONE));
    expect(items(meds).find((i) => i.slot === '08:00')?.late).toBeUndefined();
    expect(refused(meds.logDose(id, doseBody({ slot: '21:00', at: at(DAY, '12:05').toISOString() }), PHONE))).toEqual({
      code: 'invalid_request',
      reason: MED_SENTENCES.atFuture,
    });
    // As far back as the day before the dose's own, and no further.
    ok(meds.logDose(id, doseBody({ at: at(shiftDay(DAY, -1), '00:00').toISOString() }), PHONE));
    expect(refused(meds.logDose(id, doseBody({ at: at(shiftDay(DAY, -2), '23:59').toISOString() }), PHONE))).toEqual({
      code: 'invalid_request',
      reason: MED_SENTENCES.atEarly,
    });
  });

  it("backdating: a Taken for last night's 21:00 turns yesterday's miss into taken (late when logged the next day)", () => {
    const { core, meds } = setup(at(DAY, '07:00'));
    const id = ok(meds.create(medBody(), PHONE)).id;
    const tomorrow = shiftDay(DAY, 1);
    core.clock.set(at(tomorrow, '07:30').toISOString());
    expect(items(meds, DAY).find((i) => i.slot === '21:00')?.status).toBe('missed');
    ok(meds.logDose(id, { day: DAY, slot: '21:00', status: 'taken' }, PHONE));
    expect(items(meds, DAY).find((i) => i.slot === '21:00')).toMatchObject({ status: 'taken', late: true });
    ok(meds.logDose(id, { day: DAY, slot: '21:00', status: 'taken', at: at(DAY, '21:10').toISOString() }, PHONE));
    expect(items(meds, DAY).find((i) => i.slot === '21:00')?.late).toBeUndefined();
  });

  it('refuses a day after today, a day before it was added, and a time it is not due', () => {
    const { core, meds } = setup(at(DAY, '07:00'));
    const id = ok(meds.create({ ...EXAMPLEX, schedule: { freq: 'weekly', byWeekday: [weekdayOf(DAY)] } }, PHONE)).id;
    expect(refused(meds.logDose(id, doseBody({ day: shiftDay(DAY, 1) }), PHONE)).reason).toBe(MED_SENTENCES.future);
    expect(refused(meds.logDose(id, doseBody({ day: shiftDay(DAY, -1) }), PHONE)).reason).toBe(MED_SENTENCES.beforeStart);
    expect(refused(meds.logDose(id, doseBody({ slot: '09:00' }), PHONE)).reason).toBe(MED_SENTENCES.notDue);
    core.clock.set(at(shiftDay(DAY, 1), '09:00').toISOString());
    expect(refused(meds.logDose(id, doseBody({ day: shiftDay(DAY, 1) }), PHONE)).reason).toBe(MED_SENTENCES.notDue);
    expect(refused(meds.logDose('01JFZ8X8Y3T0V5G9WQK2M4N6PR', doseBody(), PHONE))).toEqual({ code: 'not_found', reason: MED_SENTENCES.notFound });
  });
});

describe('supply and adherence', () => {
  it('projects the days left from the count and the schedule, and is low at 7 days or under', () => {
    const { meds } = setup();
    const daily = ok(meds.create(medBody({ pills: { left: 30, perDose: 1 } }), PHONE)).id;
    const weekly = ok(meds.create({ ...EXAMPLEX, pills: { left: 2, perDose: 1 } }, PHONE)).id;
    const none = ok(meds.create(PLACEBIN, PHONE)).id;
    expect(view(meds, daily)?.supply).toEqual({ daysLeft: 15, runsOut: shiftDay(DAY, 15), low: false });
    expect(view(meds, weekly)?.supply).toEqual({ daysLeft: 14, runsOut: shiftDay(DAY, 14), low: false });
    expect(view(meds, none)?.supply).toBeNull();
    ok(meds.update(daily, { pills: { left: 14 } }, PHONE));
    expect(view(meds, daily)?.supply).toMatchObject({ daysLeft: 7, low: true });
  });

  it('is the share of due doses taken over the last 30 days, skips left out, 0 to 100', () => {
    const { core, meds } = setup(at(DAY, '07:00'));
    const id = ok(meds.create({ ...PLACEBIN, pills: { left: 100, perDose: 1 } }, PHONE)).id;
    expect(view(meds, id)?.adherencePct).toBeNull();
    // Day 1 taken, day 2 skipped, day 3 missed, day 4 taken; asked on day 5 before 08:00.
    const days = [0, 1, 2, 3, 4].map((n) => shiftDay(DAY, n));
    core.clock.set(at(days[4]!, '07:00').toISOString());
    ok(meds.logDose(id, { day: days[0]!, slot: '08:00', status: 'taken' }, PHONE));
    ok(meds.logDose(id, { day: days[1]!, slot: '08:00', status: 'skipped' }, PHONE));
    ok(meds.logDose(id, { day: days[3]!, slot: '08:00', status: 'taken' }, PHONE));
    expect(view(meds, id)?.adherencePct).toBe(67);
  });

  it('a schedule edit applies from today and leaves past adherence as it was', () => {
    const { core, meds } = setup(at(DAY, '07:00'));
    const id = ok(meds.create(PLACEBIN, PHONE)).id;
    for (let n = 0; n < 6; n++) {
      const day = shiftDay(DAY, n);
      core.clock.set(at(day, '09:00').toISOString());
      if (n % 2 === 0) ok(meds.logDose(id, { day, slot: '08:00', status: 'taken' }, PHONE));
    }
    const today = shiftDay(DAY, 6);
    core.clock.set(at(today, '07:00').toISOString());
    const before = view(meds, id)?.adherencePct;
    expect(before).toBe(50);
    // Weekly on the first day's weekday: judged by it, the past would read one taken and no miss (100%).
    ok(meds.update(id, { schedule: { freq: 'weekly', byWeekday: [weekdayOf(shiftDay(today, 1))] } }, PHONE));
    expect(view(meds, id)?.adherencePct).toBe(before);
    expect(getMed(core, id)?.history.map((e) => e.from)).toEqual([DAY, today]);
    expect(items(meds, shiftDay(DAY, 1)).map((i) => i.status)).toEqual(['missed']);
    expect(items(meds)).toEqual([]);
  });

  it('a times edit applies from today too: a past day keeps the time it had, and adding a time adds no past miss', () => {
    const { core, meds } = setup(at(DAY, '07:00'));
    const id = ok(meds.create(PLACEBIN, PHONE)).id;
    core.clock.set(at(DAY, '09:00').toISOString());
    ok(meds.logDose(id, doseBody({ day: DAY, slot: '08:00' }), PHONE));
    const tomorrow = shiftDay(DAY, 1);
    core.clock.set(at(tomorrow, '07:00').toISOString());
    expect(view(meds, id)?.adherencePct).toBe(100);
    ok(meds.update(id, { times: ['09:00', '21:00'] }, PHONE));
    expect(view(meds, id)?.adherencePct).toBe(100);
    expect(items(meds, DAY).map((i) => [i.slot, i.status])).toEqual([['08:00', 'taken']]);
    expect(items(meds).map((i) => i.slot)).toEqual(['09:00', '21:00']);
  });

  it('moving a time after today\'s dose was taken asks for no second dose today: today keeps the taken one, where Undo reaches it', () => {
    const { core, meds } = setup(at(DAY, '08:30'));
    const id = ok(meds.create(PLACEBIN, PHONE)).id;
    const dose = ok(meds.logDose(id, doseBody({ slot: '08:00' }), PHONE)).id;
    ok(meds.update(id, { times: ['21:00'] }, PHONE));
    const list = items(meds);
    expect(list.map((i) => [i.slot, i.status])).toEqual([['08:00', 'taken']]);
    expect(list[0]?.doseId).toBe(dose);
    expect(refused(meds.logDose(id, doseBody({ slot: '21:00' }), PHONE)).reason).toBe(MED_SENTENCES.notDue);
    expect(getMed(core, id)?.timesHistory).toEqual([
      { from: DAY, times: ['08:00'] },
      { from: shiftDay(DAY, 1), times: ['21:00'] },
    ]);
    ok(meds.logDose(id, doseBody({ slot: '08:00', status: 'skipped' }), PHONE));
    ok(meds.undoDose(id, dose, PHONE));
    expect(items(meds).map((i) => [i.slot, i.status])).toEqual([['08:00', 'pending']]);
    ok(meds.logDose(id, doseBody({ slot: '08:00' }), PHONE));

    const tomorrow = shiftDay(DAY, 1);
    core.clock.set(at(tomorrow, '07:00').toISOString());
    expect(items(meds).map((i) => i.slot)).toEqual(['21:00']);
    expect(items(meds, DAY).map((i) => [i.slot, i.status])).toEqual([['08:00', 'taken']]);
    expect(view(meds, id)?.adherencePct).toBe(100);
  });

  it('a times edit counts today when it adds a time, moves one not yet taken, or follows a skip', () => {
    const { core, meds } = setup(at(DAY, '08:30'));
    const slots = (id: string) => items(meds).filter((i) => i.medId === id).map((i) => [i.slot, i.status]);
    // Twice a day, 08:00 taken: 21:00 moved to 22:00 and a new 14:00 both count tonight.
    const twice = ok(meds.create(medBody({ pills: { left: 60, perDose: 1 } }), PHONE)).id;
    ok(meds.logDose(twice, doseBody({ slot: '08:00' }), PHONE));
    ok(meds.update(twice, { times: ['08:00', '14:00', '22:00'] }, PHONE));
    expect(slots(twice)).toEqual([
      ['08:00', 'taken'],
      ['14:00', 'pending'],
      ['22:00', 'pending'],
    ]);
    expect(getMed(core, twice)?.timesHistory).toEqual([{ from: DAY, times: ['08:00', '14:00', '22:00'] }]);
    // Nothing logged yet: the move holds today.
    const fresh = ok(meds.create(PLACEBIN, PHONE)).id;
    ok(meds.update(fresh, { times: ['21:00'] }, PHONE));
    expect(slots(fresh)).toEqual([['21:00', 'pending']]);
    // This morning's dose skipped: tonight's is still owed.
    const skipped = ok(meds.create(PLACEBIN, PHONE)).id;
    ok(meds.logDose(skipped, doseBody({ slot: '08:00', status: 'skipped' }), PHONE));
    ok(meds.update(skipped, { times: ['21:00'] }, PHONE));
    expect(slots(skipped)).toEqual([
      ['08:00', 'skipped'],
      ['21:00', 'pending'],
    ]);
  });
});

describe('edit, stop and delete', () => {
  it('null clears dose, notes and the pill count; a refill keeps perDose; the same days without a start day is no change', () => {
    const { core, meds } = setup();
    const id = ok(meds.create(medBody({ pills: { left: 10, perDose: 2 } }), PHONE)).id;
    ok(meds.update(id, { pills: { left: 40 } }, PHONE));
    expect(getMed(core, id)?.pills).toEqual({ left: 40, perDose: 2 });
    ok(meds.update(id, { schedule: { freq: 'daily' }, name: 'Testamol XR' }, PHONE));
    expect(getMed(core, id)?.history).toHaveLength(1);
    expect(getMed(core, id)?.name).toBe('Testamol XR');
    ok(meds.update(id, { dose: null, notes: null, pills: null }, PHONE));
    const med = getMed(core, id);
    expect(med?.dose).toBeUndefined();
    expect(med?.notes).toBeUndefined();
    expect(med?.pills).toBeUndefined();
    expect(refused(meds.update('01JFZ8X8Y3T0V5G9WQK2M4N6PR', { name: 'x' }, PHONE)).code).toBe('not_found');
  });

  it('Stop sets today, lists it last, refuses edits, keeps its history and ends its days after today', () => {
    const { core, meds } = setup(at(DAY, '07:00'));
    const id = ok(meds.create({ ...medBody(), name: 'Alpha' } as MedicineBody, PHONE)).id;
    ok(meds.create(PLACEBIN, PHONE));
    ok(meds.stopTaking(id, PHONE));
    ok(meds.stopTaking(id, PHONE));
    expect(getMed(core, id)?.stoppedOn).toBe(DAY);
    expect(ok(meds.get()).medicines.map((m) => [m.name, m.stoppedOn ?? null])).toEqual([
      ['Placebin', null],
      ['Alpha', DAY],
    ]);
    expect(refused(meds.update(id, { name: 'Beta' }, PHONE))).toEqual({ code: 'conflict', reason: MED_SENTENCES.stopped });
    core.clock.set(at(shiftDay(DAY, 1), '07:00').toISOString());
    expect(items(meds).map((i) => i.name)).toEqual(['Placebin']);
    expect(refused(meds.logDose(id, doseBody({ day: shiftDay(DAY, 1) }), PHONE)).reason).toBe(MED_SENTENCES.afterStop);
    // Stopped at 07:00: neither of that day's doses (08:00, 21:00) was ever due.
    expect(items(meds, DAY).filter((i) => i.medId === id)).toEqual([]);
    expect(ok(meds.get()).medicines.find((m) => m.id === id)).not.toHaveProperty('stopTime');
  });

  it("Stop drops today's later doses from the list; the earlier one stays to log, and one already logged stays", () => {
    const { core, meds } = setup(at(DAY, '07:00'));
    const id = ok(meds.create(medBody({ times: ['08:00', '14:00', '21:00'] }), PHONE)).id;
    core.clock.set(at(DAY, '13:00').toISOString());
    ok(meds.logDose(id, doseBody({ day: DAY, slot: '14:00' }), PHONE));
    core.clock.set(at(DAY, '13:30').toISOString());
    ok(meds.stopTaking(id, PHONE));
    expect(getMed(core, id)?.stopTime).toBe('13:30');
    expect(items(meds).map((i) => [i.slot, i.status, i.overdue])).toEqual([
      ['08:00', 'pending', true],
      ['14:00', 'taken', false],
    ]);
    // 08:00 can still be logged; 21:00 was never due, so it can't be.
    ok(meds.logDose(id, doseBody({ day: DAY, slot: '08:00' }), PHONE));
    expect(refused(meds.logDose(id, doseBody({ day: DAY, slot: '21:00' }), PHONE)).reason).toBe(MED_SENTENCES.notDue);
    // The 14:00 taken early can still be undone.
    const early = items(meds).find((i) => i.slot === '14:00');
    ok(meds.undoDose(id, early?.doseId ?? '', PHONE));
    expect(items(meds).map((i) => i.slot)).toEqual(['08:00']);
  });

  it('the day of a Stop counts only the doses up to it: tomorrow it shows no miss after it, and adherence agrees', () => {
    const { core, meds } = setup(at(DAY, '07:00'));
    const id = ok(meds.create(medBody(), PHONE)).id;
    core.clock.set(at(DAY, '09:00').toISOString());
    ok(meds.logDose(id, doseBody({ day: DAY, slot: '08:00' }), PHONE));
    core.clock.set(at(DAY, '12:00').toISOString());
    ok(meds.stopTaking(id, PHONE));
    core.clock.set(at(shiftDay(DAY, 1), '09:00').toISOString());
    expect(items(meds, DAY).map((i) => [i.slot, i.status])).toEqual([['08:00', 'taken']]);
    // One dose due on the day of the Stop, and it was taken: 100, not 50.
    expect(view(meds, id)?.adherencePct).toBe(100);
  });

  it('Delete takes its doses too', () => {
    const { core, meds } = setup(at(DAY, '09:00'));
    const id = ok(meds.create(medBody(), PHONE)).id;
    ok(meds.logDose(id, doseBody(), PHONE));
    ok(meds.remove(id, PHONE));
    expect(getMed(core, id)).toBeNull();
    expect(core.db.prepare('SELECT COUNT(*) AS n FROM doses').get()).toEqual({ n: 0 });
    expect(refused(meds.remove(id, PHONE)).code).toBe('not_found');
  });
});

describe('routes', () => {
  async function routeApi() {
    const clock = new FakeClock(at(DAY, '09:00').toISOString());
    api = await makeApi({
      ctx: { clock, settings: SettingsSchema.parse({ life: { medicines: true } }) },
      deps: (ctx, f) => {
        core = createTestLifeCore({ clock, tz: TZ, settings: { medicines: true } });
        const medicines = buildMedicinesModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
        return { life: notBuilt<LifeService>('Life', { start: async () => {}, stop: async () => {}, broken: () => null, medicines }) };
      },
    });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    return { a: api, headers: h(cookie) };
  }

  it('answer every route with the protocol shapes; writes reply with ids only and audit the target id only', async () => {
    const { a, headers } = await routeApi();
    const created = await a.tcp.inject({ method: 'POST', url: '/v1/medicines', headers, payload: medBody({}, { marked: true }) });
    expect(created.statusCode, created.body).toBe(200);
    const { id } = IdReplySchema.parse(created.json());
    expect(Object.keys(created.json())).toEqual(['id']);

    const got = await a.tcp.inject({ method: 'GET', url: `/v1/medicines?day=${DAY}`, headers });
    expect(got.statusCode).toBe(200);
    const body = MedicinesResponseSchema.parse(got.json());
    expect(body.medicines[0]?.id).toBe(id);
    expect(JSON.stringify(got.json())).not.toContain('timesHistory');

    const logged = await a.tcp.inject({ method: 'POST', url: `/v1/medicines/${id}/doses`, headers, payload: doseBody() });
    expect(logged.statusCode, logged.body).toBe(200);
    const dose = IdReplySchema.parse(logged.json()).id;
    for (const [method, url, payload] of [
      ['PATCH', `/v1/medicines/${id}`, { notes: `${LIFE_MARKER} later` }],
      ['DELETE', `/v1/medicines/${id}/doses/${dose}`, undefined],
      ['POST', `/v1/medicines/${id}/stop`, undefined],
      ['DELETE', `/v1/medicines/${id}`, undefined],
    ] as const) {
      const res = await a.tcp.inject({ method, url, headers, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url} ${res.body}`).toBe(200);
      expect(OkReplySchema.parse(res.json())).toEqual({ ok: true });
    }

    const audit = a.ctx.db.audit.list().filter((r) => ['medCreate', 'medUpdate', 'doseLog', 'doseUndo', 'medStop', 'medDelete'].includes(r.action));
    expect(audit.map((r) => r.action).sort()).toEqual(['doseLog', 'doseUndo', 'medCreate', 'medDelete', 'medStop', 'medUpdate']);
    for (const r of audit) expect(r.target, r.action).toBe(id);
    expect(JSON.stringify(audit)).not.toContain(LIFE_MARKER);
    expect(JSON.stringify(audit)).not.toContain('Testamol');
  });

  it('turn refusals into their errors with the fixed sentence', async () => {
    const { a, headers } = await routeApi();
    const future = await a.tcp.inject({ method: 'GET', url: `/v1/medicines?day=${shiftDay(DAY, 1)}`, headers });
    expect(future.statusCode).toBe(400);
    expect(future.json().error).toEqual({ code: 'invalid_request', message: MED_SENTENCES.future });
    const missing = await a.tcp.inject({ method: 'POST', url: '/v1/medicines/01JFZ8X8Y3T0V5G9WQK2M4N6PR/stop', headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe(MED_SENTENCES.notFound);
    const { id } = IdReplySchema.parse((await a.tcp.inject({ method: 'POST', url: '/v1/medicines', headers, payload: medBody() })).json());
    const notDue = await a.tcp.inject({ method: 'POST', url: `/v1/medicines/${id}/doses`, headers, payload: doseBody({ slot: '12:00' }) });
    expect(notDue.statusCode).toBe(400);
    expect(notDue.json().error.message).toBe(MED_SENTENCES.notDue);
    await a.tcp.inject({ method: 'POST', url: `/v1/medicines/${id}/stop`, headers });
    const stopped = await a.tcp.inject({ method: 'PATCH', url: `/v1/medicines/${id}`, headers, payload: { name: 'Placebin' } });
    expect(stopped.statusCode).toBe(409);
    expect(stopped.json().error.message).toBe(MED_SENTENCES.stopped);
  });

  it('are not on ctl.sock', async () => {
    const { a } = await routeApi();
    expect((await a.ctl.inject({ method: 'GET', url: '/v1/medicines' })).statusCode).toBe(404);
  });
});
