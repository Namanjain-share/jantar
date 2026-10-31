/**
 * Weight, with food (spec 4.6, WP-FF): one weight a day in kg with one
 * decimal (kg x 10 in the table), logging again that day replaces it, never
 * a day after today; the summary's latest, change over 7 and 30 days
 * (against the newest weight on or before that day), the newest 30 and the
 * goal; the cap; and the routes (`PUT`/`DELETE /v1/weights/:day`), with no
 * weight in events, audit or logs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MARKER_KG, weightBody } from '@jantar/fixtures';
import { shiftDay } from '@jantar/life-core';
import { FoodDaySchema, LIFE_LIMITS } from '@jantar/protocol';
import type { Actor, FoodModule, LifeService } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { createTestContext, createTestLifeCore, type TestLifeCore } from '../../src/core/testing.js';
import { FOOD_SENTENCES, buildFoodModule } from '../../src/life/food/module.js';
import { WEIGHT_SENTENCES, kg10Of } from '../../src/life/food/weight.js';
import { h, makeApi, makeFakes, pairCookie, type TestApi } from '../api/fakes.js';
import { V04_ON } from '../api/v04-helpers.js';

const PHONE: Actor = { kind: 'device', deviceId: 'dev-phone', scopes: ['read', 'control'] };
/** 11:30 in Asia/Kolkata on 2026-10-30. */
const NOW = '2026-10-30T06:00:00.000Z';
const TODAY = '2026-10-30';

let core: TestLifeCore | undefined;
let api: TestApi | undefined;
afterEach(async () => {
  core?.close();
  core = undefined;
  await api?.close();
  api = undefined;
});

function rig(): { core: TestLifeCore; food: FoodModule } {
  core = createTestLifeCore({ clock: new FakeClock(NOW), tz: 'Asia/Kolkata', settings: { food: true } });
  const ctx = createTestContext({ clock: core.clock });
  const f = makeFakes(ctx);
  return { core, food: buildFoodModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy }) };
}

function weight(food: FoodModule) {
  const r = food.day();
  if (!r.ok) throw new Error(r.reason);
  return r.value.weight;
}

const ago = (n: number) => shiftDay(TODAY, -n);

describe('logging a weight', () => {
  it('one per day: logging again that day replaces it; kept as kg x 10, so one decimal is exact', () => {
    const { core, food } = rig();
    expect(food.setWeight(TODAY, { kg: 72.4 }, PHONE)).toEqual({ ok: true, value: true });
    expect(food.setWeight(TODAY, { kg: 72.0 }, PHONE)).toEqual({ ok: true, value: true });
    expect(weight(food).recent).toEqual([{ day: TODAY, kg: 72 }]);
    expect(core.db.prepare('SELECT day, kg10, at FROM weights').all()).toEqual([{ day: TODAY, kg10: 720, at: NOW }]);
    expect(core.changedCount).toBe(2);
  });

  it('rounds to one decimal', () => {
    const { food } = rig();
    value(food.setWeight(ago(2), { kg: 72.44 }, PHONE));
    value(food.setWeight(ago(1), { kg: 72.46 }, PHONE));
    value(food.setWeight(TODAY, { kg: 70.04999 }, PHONE));
    expect(weight(food).recent.map((w) => w.kg)).toEqual([70, 72.5, 72.4]);
    expect(kg10Of(72.44)).toBe(724);
  });

  it('today and earlier only; a date that does not exist is refused', () => {
    const { core, food } = rig();
    expect(food.setWeight(shiftDay(TODAY, 1), { kg: 72 }, PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: WEIGHT_SENTENCES.future });
    expect(food.setWeight('2026-02-30', { kg: 72 }, PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: FOOD_SENTENCES.noDay });
    expect(food.setWeight(TODAY, { kg: 19.9 }, PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: WEIGHT_SENTENCES.range });
    expect(food.setWeight('2025-01-01', { kg: 80 }, PHONE).ok).toBe(true);
    expect(core.changedCount).toBe(1);
  });

  it("deletes a day's weight; a day with none is not_found", () => {
    const { food } = rig();
    value(food.setWeight(TODAY, { kg: 72 }, PHONE));
    expect(food.removeWeight(TODAY, PHONE)).toEqual({ ok: true, value: true });
    expect(weight(food).latest).toBeNull();
    expect(food.removeWeight(TODAY, PHONE)).toEqual({ ok: false, code: 'not_found', reason: WEIGHT_SENTENCES.none });
  });

  it(`caps the log at ${LIFE_LIMITS.weights}: a new day is refused, a logged day can still change`, () => {
    const { core, food } = rig();
    const db = core.db;
    db.tx(() => {
      for (let i = 1; i <= LIFE_LIMITS.weights; i++) db.prepare('INSERT INTO weights (day, kg10, at) VALUES (?, 700, ?)').run(ago(i), NOW);
    });
    expect(food.setWeight(TODAY, { kg: 72 }, PHONE)).toEqual({ ok: false, code: 'conflict', reason: WEIGHT_SENTENCES.full });
    expect(food.setWeight(ago(1), { kg: 72 }, PHONE).ok).toBe(true);
  });
});

describe('the weight summary', () => {
  it('latest, change over 7 and 30 days, newest first (74.0 a month ago, 73.0 a week ago, 72.4 today)', () => {
    const { food } = rig();
    value(food.setWeight(ago(30), { kg: 74 }, PHONE));
    value(food.setWeight(ago(7), { kg: 73 }, PHONE));
    value(food.setWeight(TODAY, { kg: 72.4 }, PHONE));
    expect(weight(food)).toEqual({
      latest: { day: TODAY, kg: 72.4 },
      change7: -0.6,
      change30: -1.6,
      goalKg: null,
      recent: [
        { day: TODAY, kg: 72.4 },
        { day: ago(7), kg: 73 },
        { day: ago(30), kg: 74 },
      ],
    });
  });

  it('compares with the newest weight on or before 7 (30) days before the latest, across gaps', () => {
    const { food } = rig();
    value(food.setWeight(ago(45), { kg: 76.3 }, PHONE));
    value(food.setWeight(ago(10), { kg: 74.1 }, PHONE));
    value(food.setWeight(ago(3), { kg: 73.5 }, PHONE));
    value(food.setWeight(ago(1), { kg: 73.2 }, PHONE));
    // Latest is yesterday's: 7 days before it is ago(8), whose newest is ago(10); 30 before is ago(31) -> ago(45).
    expect(weight(food)).toMatchObject({ latest: { day: ago(1), kg: 73.2 }, change7: -0.9, change30: -3.1 });
  });

  it('a change is null until a weight that old exists; no weights at all is all null', () => {
    const { food } = rig();
    expect(weight(food)).toEqual({ latest: null, change7: null, change30: null, goalKg: null, recent: [] });
    value(food.setWeight(ago(6), { kg: 75 }, PHONE));
    value(food.setWeight(TODAY, { kg: 74 }, PHONE));
    expect(weight(food)).toMatchObject({ latest: { kg: 74 }, change7: null, change30: null });
    value(food.setWeight(ago(7), { kg: 75.5 }, PHONE));
    expect(weight(food)).toMatchObject({ change7: -1.5, change30: null });
  });

  it('a later weight that went up gives a positive change', () => {
    const { food } = rig();
    value(food.setWeight(ago(7), { kg: 70 }, PHONE));
    value(food.setWeight(TODAY, { kg: 70.7 }, PHONE));
    expect(weight(food).change7).toBe(0.7);
  });

  it('keeps the newest 30 in `recent`', () => {
    const { food } = rig();
    for (let i = 0; i < 35; i++) value(food.setWeight(ago(i), { kg: 70 + i / 10 }, PHONE));
    const { recent, latest } = weight(food);
    expect(recent).toHaveLength(30);
    expect(recent[0]).toEqual({ day: TODAY, kg: 70 });
    expect(recent.at(-1)?.day).toBe(ago(29));
    expect(latest).toEqual(recent[0]);
    expect(FoodDaySchema.shape.weight.parse(weight(food))).toBeTruthy();
  });

  it('shows the goal set with the targets', () => {
    const { food } = rig();
    value(food.setTargets({ goalKg: 70 }, PHONE));
    value(food.setWeight(TODAY, { kg: 72.4 }, PHONE));
    expect(weight(food)).toMatchObject({ goalKg: 70, latest: { kg: 72.4 } });
    expect(food.today(TODAY)).toMatchObject({ food: { weight: { day: TODAY, kg: 72.4 } } });
  });
});

describe('weight routes', () => {
  it('PUT and DELETE /v1/weights/:day answer ok; a future day is 400; the weight is in no event, audit row or log', async () => {
    let built: TestLifeCore | undefined;
    api = await makeApi({
      ctx: { settings: V04_ON, clock: new FakeClock(NOW) },
      deps: (ctx, f) => {
        built = createTestLifeCore({ clock: ctx.clock, tz: 'Asia/Kolkata', settings: { food: true } });
        const food = buildFoodModule(built, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
        return { life: notBuilt<LifeService>('Life', { start: async () => {}, stop: async () => {}, broken: () => null, food }) };
      },
    });
    core = built;
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const put = await api.tcp.inject({ method: 'PUT', url: `/v1/weights/${TODAY}`, headers: h(cookie), payload: weightBody({}, { marked: true }) });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ ok: true });
    const goal = await api.tcp.inject({ method: 'PUT', url: '/v1/food/targets', headers: h(cookie), payload: { goalKg: MARKER_KG } });
    expect(goal.statusCode).toBe(200);
    const day = FoodDaySchema.parse((await api.tcp.inject({ method: 'GET', url: '/v1/food', headers: h(cookie) })).json());
    expect(day.weight).toMatchObject({ latest: { day: TODAY, kg: MARKER_KG }, goalKg: MARKER_KG });

    const future = await api.tcp.inject({ method: 'PUT', url: `/v1/weights/${shiftDay(TODAY, 1)}`, headers: h(cookie), payload: weightBody() });
    expect(future.statusCode).toBe(400);
    expect(future.json().error.message).toBe(WEIGHT_SENTENCES.future);
    const tooLight = await api.tcp.inject({ method: 'PUT', url: `/v1/weights/${TODAY}`, headers: h(cookie), payload: { kg: 12 } });
    expect(tooLight.statusCode).toBe(400);

    const del = await api.tcp.inject({ method: 'DELETE', url: `/v1/weights/${TODAY}`, headers: h(cookie) });
    expect(del.json()).toEqual({ ok: true });
    const again = await api.tcp.inject({ method: 'DELETE', url: `/v1/weights/${TODAY}`, headers: h(cookie) });
    expect(again.statusCode).toBe(404);

    const audit = api.ctx.db.audit.list().filter((a) => a.action.startsWith('weight'));
    // The 400 for a bad body is the pipeline's own refusal, before the handler: it names the path's day too.
    expect(audit.map((a) => [a.action, a.target ?? null, a.result])).toEqual([
      ['weightSet', TODAY, 'ok'],
      ['weightSet', shiftDay(TODAY, 1), 'refused'],
      ['weightSet', TODAY, 'refused'],
      ['weightDelete', TODAY, 'ok'],
      ['weightDelete', TODAY, 'refused'],
    ]);
    const r = api.ctx.store.replay(0);
    const logged = JSON.stringify([r.kind === 'events' ? r.events : [], api.ctx.db.audit.list(), api.ctx.log.records]);
    expect(logged).not.toContain(String(MARKER_KG));
    expect(logged).not.toContain(String(kg10Of(MARKER_KG)));
  });
});

function value<T>(r: { ok: true; value: T } | { ok: false; code: string; reason: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return r.value;
}
