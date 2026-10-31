/**
 * Food and calories (spec 4.6, WP-FF): entries with kcal only, saved foods
 * for one tap, the daily total against a target, targets in life.db's meta
 * (kept across a reopen), caps, Food's part of Today, and the routes (ids
 * only in write replies, target-only audit rows, nothing on ctl.sock, no
 * Life text in events, audit or logs). Weight has its own file, Ask Claude
 * food-estimate.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LIFE_MARKER, foodBody } from '@jantar/fixtures';
import { shiftDay } from '@jantar/life-core';
import { FoodDaySchema, KCAL_TARGET_DEFAULT, LIFE_LIMITS, LifeIdSchema } from '@jantar/protocol';
import type { Actor, FoodModule, LifeCore, LifeService } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { createTestContext, createTestLifeCore, type TestLifeCore } from '../../src/core/testing.js';
import { openLifeDb } from '../../src/life/db.js';
import { FOOD_SENTENCES, SAVED_SHOWN, buildFoodModule } from '../../src/life/food/module.js';
import { h, makeApi, makeFakes, pairCookie, type TestApi } from '../api/fakes.js';
import { V04_ON } from '../api/v04-helpers.js';

const PHONE: Actor = { kind: 'device', deviceId: 'dev-phone', scopes: ['read', 'control'] };
/** 11:30 in Asia/Kolkata on 2026-10-30 (fixtures' LIFE_DAY). */
const NOW = '2026-10-30T06:00:00.000Z';
const TODAY = '2026-10-30';
const TZ = 'Asia/Kolkata';

let core: TestLifeCore | undefined;
let api: TestApi | undefined;
afterEach(async () => {
  core?.close();
  core = undefined;
  await api?.close();
  api = undefined;
});

function moduleOn(c: LifeCore): FoodModule {
  const ctx = createTestContext({ clock: (c as TestLifeCore).clock });
  const f = makeFakes(ctx);
  return buildFoodModule(c, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
}

function rig(): { core: TestLifeCore; food: FoodModule } {
  core = createTestLifeCore({ clock: new FakeClock(NOW), tz: TZ, settings: { food: true } });
  return { core, food: moduleOn(core) };
}

function value<T>(r: { ok: true; value: T } | { ok: false; code: string; reason: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return r.value;
}

describe('entries', () => {
  it('logs a food with its kcal: an id back, the day lists it with now as its time, the total and the default target', () => {
    const { core, food } = rig();
    const { id } = value(food.add(foodBody({ name: 'Roti', kcal: 120 }), PHONE));
    expect(LifeIdSchema.safeParse(id).success).toBe(true);
    value(food.add(foodBody({ name: 'Dal', kcal: 180 }), PHONE));
    const day = value(food.day());
    expect(FoodDaySchema.parse(day)).toEqual(day);
    expect(day).toMatchObject({ day: TODAY, today: TODAY, target: KCAL_TARGET_DEFAULT, kcal: 300 });
    expect(day.entries.map((e) => [e.name, e.kcal])).toEqual([
      ['Roti', 120],
      ['Dal', 180],
    ]);
    expect(day.entries[0]).toMatchObject({ id, day: TODAY, at: NOW, createdAt: NOW, updatedAt: NOW });
    expect(core.changedCount).toBe(2);
  });

  it('an entry for another day gets 12:00 that day in the Life zone, and stays on that day', () => {
    const { food } = rig();
    value(food.add(foodBody({ day: '2026-10-28', name: 'Poha', kcal: 250 }), PHONE));
    expect(value(food.day('2026-10-28')).entries[0]?.at).toBe('2026-10-28T06:30:00.000Z');
    expect(value(food.day()).entries).toEqual([]);
    expect(value(food.day('2026-10-28')).kcal).toBe(250);
  });

  it('changes and deletes an entry; an unknown one is not_found with a fixed sentence', () => {
    const { core, food } = rig();
    const { id } = value(food.add(foodBody(), PHONE));
    core.clock.advance(60_000);
    expect(food.update(id, { name: '  Paratha ', kcal: 260 }, PHONE)).toEqual({ ok: true, value: true });
    expect(value(food.day()).entries[0]).toMatchObject({ name: 'Paratha', kcal: 260, createdAt: NOW, updatedAt: '2026-10-30T06:01:00.000Z' });
    expect(food.remove(id, PHONE)).toEqual({ ok: true, value: true });
    expect(value(food.day()).entries).toEqual([]);
    const ghost = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
    expect(food.update(ghost, { kcal: 1 }, PHONE)).toEqual({ ok: false, code: 'not_found', reason: FOOD_SENTENCES.noEntry });
    expect(food.remove(ghost, PHONE)).toEqual({ ok: false, code: 'not_found', reason: FOOD_SENTENCES.noEntry });
  });

  it('refuses a date that does not exist', () => {
    const { food } = rig();
    expect(food.add(foodBody({ day: '2026-02-31' }), PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: FOOD_SENTENCES.noDay });
    expect(food.day('2026-02-30')).toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it(`caps a day at ${LIFE_LIMITS.foodPerDay} entries with a fixed sentence; other days are not counted`, () => {
    const { core, food } = rig();
    for (let i = 0; i < LIFE_LIMITS.foodPerDay; i++) value(food.add(foodBody({ kcal: 1 }), PHONE));
    const before = core.changedCount;
    expect(food.add(foodBody(), PHONE)).toEqual({ ok: false, code: 'conflict', reason: FOOD_SENTENCES.dayFull });
    expect(core.changedCount).toBe(before);
    expect(food.add(foodBody({ day: '2026-10-29' }), PHONE).ok).toBe(true);
  });
});

describe('saved foods', () => {
  it('save: true keeps it for one tap; the same name in any case is the same saved food, used again with the new kcal', () => {
    const { food } = rig();
    value(food.add({ ...foodBody({ name: 'Masala Dosa', kcal: 350 }), save: true }, PHONE));
    let saved = value(food.day()).saved;
    expect(saved).toEqual([{ id: expect.any(String), name: 'Masala Dosa', kcal: 350, uses: 1 }]);
    value(food.add({ ...foodBody({ name: ' masala dosa ', kcal: 380 }), save: true }, PHONE));
    saved = value(food.day()).saved;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'masala dosa', kcal: 380, uses: 2 });
    // Without save nothing is kept.
    value(food.add(foodBody({ name: 'Chai', kcal: 90 }), PHONE));
    expect(value(food.day()).saved).toHaveLength(1);
  });

  it('a saved food re-added by id becomes a new entry with its name and kcal, and counts a use', () => {
    const { core, food } = rig();
    value(food.add({ ...foodBody({ name: 'Idli', kcal: 140 }), save: true }, PHONE));
    const savedId = value(food.day()).saved[0]?.id as string;
    core.clock.advance(3_600_000);
    const { id } = value(food.add({ day: TODAY, savedId }, PHONE));
    const day = value(food.day());
    expect(day.entries.find((e) => e.id === id)).toMatchObject({ name: 'Idli', kcal: 140, at: '2026-10-30T07:00:00.000Z' });
    expect(day.saved[0]).toMatchObject({ id: savedId, uses: 2 });
    expect(day.kcal).toBe(280);
  });

  it('an unknown saved food is not_found and adds nothing', () => {
    const { core, food } = rig();
    expect(food.add({ day: TODAY, savedId: '01JFZ8X8Y3T0V5G9WQK2M4N6PR' }, PHONE)).toEqual({ ok: false, code: 'not_found', reason: FOOD_SENTENCES.noSaved });
    expect(value(food.day()).entries).toEqual([]);
    expect(core.changedCount).toBe(0);
  });

  it(`lists the ${SAVED_SHOWN} most used, most recently used first among equals`, () => {
    const { core, food } = rig();
    for (let i = 0; i < SAVED_SHOWN + 2; i++) {
      core.clock.advance(1000);
      value(food.add({ ...foodBody({ name: `Food ${i}`, kcal: 10 + i }), save: true }, PHONE));
    }
    const twice = value(food.day()).saved.find((s) => s.name === 'Food 3')?.id as string;
    core.clock.advance(1000);
    value(food.add({ day: TODAY, savedId: twice }, PHONE));
    const saved = value(food.day()).saved;
    expect(saved).toHaveLength(SAVED_SHOWN);
    expect(saved[0]).toMatchObject({ name: 'Food 3', uses: 2 });
    // Then by last use: the newest saves first, the two oldest left out.
    expect(saved[1]?.name).toBe(`Food ${SAVED_SHOWN + 1}`);
    expect(saved.map((s) => s.name)).not.toContain('Food 0');
    expect(saved.map((s) => s.name)).not.toContain('Food 1');
  });

  it('forgets a saved food; its entries stay', () => {
    const { food } = rig();
    value(food.add({ ...foodBody({ name: 'Upma', kcal: 200 }), save: true }, PHONE));
    const savedId = value(food.day()).saved[0]?.id as string;
    expect(food.removeSaved(savedId, PHONE)).toEqual({ ok: true, value: true });
    expect(value(food.day())).toMatchObject({ saved: [], kcal: 200 });
    expect(food.removeSaved(savedId, PHONE)).toEqual({ ok: false, code: 'not_found', reason: FOOD_SENTENCES.noSaved });
  });

  it(`caps saved foods at ${LIFE_LIMITS.savedFoods}: a new one is refused (and its entry with it), a known one still saves`, () => {
    const { core, food } = rig();
    const db = core.db;
    db.tx(() => {
      for (let i = 0; i < LIFE_LIMITS.savedFoods; i++) {
        const id = core.newId();
        db.prepare('INSERT INTO foods_saved (id, name_key, uses, last_used, json) VALUES (?, ?, 1, ?, ?)').run(id, `food ${i}`, NOW, JSON.stringify({ id, name: `Food ${i}`, kcal: 10 }));
      }
    });
    expect(food.add({ ...foodBody({ name: 'One more' }), save: true }, PHONE)).toEqual({ ok: false, code: 'conflict', reason: FOOD_SENTENCES.savedFull });
    expect(value(food.day()).entries).toEqual([]);
    expect(food.add({ ...foodBody({ name: 'Food 7' }), save: true }, PHONE).ok).toBe(true);
  });
});

describe('targets', () => {
  it('the calorie target and goal weight live in meta: default 2000 and none, set, and a null goal clears', () => {
    const { core, food } = rig();
    expect(value(food.day())).toMatchObject({ target: 2000, weight: { goalKg: null } });
    expect(food.setTargets({ kcalTarget: 1800, goalKg: 70 }, PHONE)).toEqual({ ok: true, value: true });
    expect(value(food.day())).toMatchObject({ target: 1800, weight: { goalKg: 70 } });
    expect(core.db.meta('kcal_target')).toBe('1800');
    expect(core.db.meta('goal_kg10')).toBe('700');
    value(food.setTargets({ goalKg: 68.45 }, PHONE));
    expect(value(food.day())).toMatchObject({ target: 1800, weight: { goalKg: 68.5 } });
    value(food.setTargets({ goalKg: null }, PHONE));
    expect(value(food.day())).toMatchObject({ target: 1800, weight: { goalKg: null } });
    expect(core.changedCount).toBe(3);
  });

  it('persist across a reopen of life.db', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccw-food-'));
    try {
      const file = join(dir, 'life.db');
      const open = () => {
        const r = openLifeDb(file);
        if (!r.ok) throw new Error(r.code);
        return r.db;
      };
      const clock = new FakeClock(NOW);
      core = createTestLifeCore({ clock, tz: TZ, settings: { food: true } });
      // The same core over the file: `db` is read on every call, as after a restore.
      let db = open();
      const fileCore = Object.defineProperty({ ...core }, 'db', { get: () => db }) as TestLifeCore;
      const food = moduleOn(fileCore);
      value(food.setTargets({ kcalTarget: 1800, goalKg: 70 }, PHONE));
      value(food.add(foodBody({ kcal: 420 }), PHONE));
      db.close();
      db = open();
      expect(value(food.day())).toMatchObject({ target: 1800, kcal: 420, weight: { goalKg: 70 } });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GET /v1/food at size (spec 9.6)', () => {
  it('a day with 10,000 entries and 1,000 weights in the file reads in 30 ms or less', () => {
    const { core, food } = rig();
    const db = core.db;
    db.tx(() => {
      for (let i = 0; i < 10_000; i++) {
        const id = core.newId();
        const day = i < 50 ? TODAY : `2026-0${1 + (i % 9)}-1${i % 10}`;
        db.prepare('INSERT INTO food (id, day, at, json) VALUES (?, ?, ?, ?)').run(id, day, NOW, JSON.stringify({ id, day, at: NOW, name: `Food ${i}`, kcal: 100, createdAt: NOW, updatedAt: NOW }));
      }
      for (let i = 0; i < 1_000; i++) db.prepare('INSERT INTO weights (day, kg10, at) VALUES (?, 700, ?)').run(shiftDay(TODAY, -i), NOW);
    });
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      expect(value(food.day()).entries).toHaveLength(50);
      times.push(performance.now() - t0);
    }
    expect(times.sort((a, b) => a - b)[2]).toBeLessThanOrEqual(30);
  });
});

describe("Food's part of Today", () => {
  it("is the day's kcal, the target and the latest weight", () => {
    const { food } = rig();
    expect(food.today(TODAY)).toEqual({ food: { kcal: 0, target: 2000, weight: null } });
    value(food.add(foodBody({ kcal: 240 }), PHONE));
    value(food.add(foodBody({ kcal: 180 }), PHONE));
    value(food.setTargets({ kcalTarget: 1800 }, PHONE));
    value(food.setWeight('2026-10-29', { kg: 72.4 }, PHONE));
    expect(food.today(TODAY)).toEqual({ food: { kcal: 420, target: 1800, weight: { day: '2026-10-29', kg: 72.4 } } });
    expect(food.today('2026-10-29')).toMatchObject({ food: { kcal: 0 } });
  });

  it('has no lifecycle start and its stop does not throw', () => {
    const { food } = rig();
    expect(food.start).toBeUndefined();
    expect(() => food.stop?.()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Routes

/** A Life part with only the food module built (the rest answer 501). */
function lifeWith(parts: Partial<LifeService>): LifeService {
  return notBuilt<LifeService>('Life', { start: async () => {}, stop: async () => {}, broken: () => null, ...parts });
}

async function foodApi(): Promise<{ api: TestApi; core: TestLifeCore; cookie: string }> {
  let built: TestLifeCore | undefined;
  api = await makeApi({
    ctx: { settings: V04_ON, clock: new FakeClock(NOW) },
    deps: (ctx, f) => {
      built = createTestLifeCore({ clock: ctx.clock, tz: TZ, settings: { food: true } });
      return { life: lifeWith({ food: buildFoodModule(built, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy }) }) };
    },
  });
  core = built as TestLifeCore;
  const { cookie } = await pairCookie(api, ['read', 'control']);
  return { api, core, cookie };
}

/** Everything that must never carry Life text: events, audit rows, log lines. */
function everythingLogged(a: TestApi): string {
  const r = a.ctx.store.replay(0);
  const events = r.kind === 'events' ? r.events : [];
  return JSON.stringify([events, a.ctx.db.audit.list(), a.ctx.log.records]);
}

describe('food routes', () => {
  it('a write answers its id or ok only; the day reads back; audit rows hold the target id and no text', async () => {
    const { api, cookie } = await foodApi();
    const add = await api.tcp.inject({ method: 'POST', url: '/v1/food', headers: h(cookie), payload: { ...foodBody({}, { marked: true }), save: true } });
    expect(add.statusCode).toBe(200);
    const id = (add.json() as { id: string }).id;
    expect(add.json()).toEqual({ id });
    const day = await api.tcp.inject({ method: 'GET', url: `/v1/food?day=${TODAY}`, headers: h(cookie) });
    expect(day.statusCode).toBe(200);
    const parsed = FoodDaySchema.parse(day.json());
    expect(parsed.entries.map((e) => e.id)).toEqual([id]);
    const savedId = parsed.saved[0]?.id as string;

    const writes = [
      { method: 'PATCH', url: `/v1/food/${id}`, payload: { kcal: 130, name: `Roti ${LIFE_MARKER}` } },
      { method: 'PUT', url: '/v1/food/targets', payload: { kcalTarget: 1800, goalKg: 70 } },
      { method: 'DELETE', url: `/v1/food/saved/${savedId}` },
      { method: 'DELETE', url: `/v1/food/${id}` },
    ] as const;
    for (const w of writes) {
      const res = await api.tcp.inject({ method: w.method, url: w.url, headers: h(cookie), ...('payload' in w ? { payload: w.payload } : {}) });
      expect(res.statusCode, w.url).toBe(200);
      expect(res.json(), w.url).toEqual({ ok: true });
    }
    const audit = api.ctx.db.audit.list().filter((a) => a.action.startsWith('food'));
    expect(audit.map((a) => [a.action, a.target ?? null])).toEqual([
      ['foodAdd', id],
      ['foodUpdate', id],
      ['foodTargets', null],
      ['foodSavedDelete', savedId],
      ['foodDelete', id],
    ]);
    for (const a of audit) expect(a.params).toEqual({});
    expect(everythingLogged(api)).not.toContain(LIFE_MARKER);
  });

  it('an unknown entry is 404 with the fixed sentence; a bad body is 400', async () => {
    const { api, cookie } = await foodApi();
    const ghost = await api.tcp.inject({ method: 'DELETE', url: '/v1/food/01JFZ8X8Y3T0V5G9WQK2M4N6PR', headers: h(cookie) });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().error).toEqual({ code: 'not_found', message: FOOD_SENTENCES.noEntry });
    const negative = await api.tcp.inject({ method: 'POST', url: '/v1/food', headers: h(cookie), payload: foodBody({ kcal: -5 }) });
    expect(negative.statusCode).toBe(400);
    const both = await api.tcp.inject({ method: 'POST', url: '/v1/food', headers: h(cookie), payload: { ...foodBody(), savedId: '01JFZ8X8Y3T0V5G9WQK2M4N6PR' } });
    expect(both.statusCode).toBe(400);
    const noTarget = await api.tcp.inject({ method: 'PUT', url: '/v1/food/targets', headers: h(cookie), payload: {} });
    expect(noTarget.statusCode).toBe(400);
  });

  it('are not served on ctl.sock', async () => {
    const { api } = await foodApi();
    expect((await api.ctl.inject({ method: 'GET', url: '/v1/food' })).statusCode).toBe(404);
    expect((await api.ctl.inject({ method: 'POST', url: '/v1/food', payload: foodBody() })).statusCode).toBe(404);
  });

  it('answer 501 while the Life part has no food module (an inert stand-in)', async () => {
    api = await makeApi({ ctx: { settings: V04_ON } });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const res = await api.tcp.inject({ method: 'GET', url: '/v1/food', headers: h(cookie) });
    expect(res.statusCode).toBe(501);
  });
});
