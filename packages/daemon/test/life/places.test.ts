/**
 * Cafés (spec 4.7, WP-FF): a place's best is its highest dish rating,
 * recomputed on every write; the list is best first (no rating last), then
 * by name, filtered on tried or want to try; dishes replace wholesale, null
 * clears area, link and notes; links are https only; the cap; and the routes
 * (ids only in write replies, target-only audit rows, nothing on ctl.sock,
 * no Life text in events, audit or logs).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LIFE_MARKER, placeBody } from '@jantar/fixtures';
import { LIFE_LIMITS, PlacesResponseSchema, type Place } from '@jantar/protocol';
import type { Actor, LifeService, PlacesModule } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { createTestContext, createTestLifeCore, type TestContext, type TestLifeCore } from '../../src/core/testing.js';
import { PLACES_SENTENCES, bestOf, buildPlacesModule } from '../../src/life/places/module.js';
import { h, makeApi, makeFakes, pairCookie, type TestApi } from '../api/fakes.js';
import { V04_ON } from '../api/v04-helpers.js';

const PHONE: Actor = { kind: 'device', deviceId: 'dev-phone', scopes: ['read', 'control'] };
const NOW = '2026-10-30T06:00:00.000Z';
const GHOST = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';

let core: TestLifeCore | undefined;
let api: TestApi | undefined;
afterEach(async () => {
  core?.close();
  core = undefined;
  await api?.close();
  api = undefined;
});

function rig(): { core: TestLifeCore; places: PlacesModule; ctx: TestContext } {
  core = createTestLifeCore({ clock: new FakeClock(NOW), settings: { places: true } });
  const ctx = createTestContext({ clock: core.clock });
  const f = makeFakes(ctx);
  return { core, ctx, places: buildPlacesModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy }) };
}

function value<T>(r: { ok: true; value: T } | { ok: false; code: string; reason: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return r.value;
}

const names = (places: Place[]) => places.map((p) => p.name);

describe('cafés', () => {
  it('adds a place with its dishes; best is the highest rating; tried defaults to false and dishes to none', () => {
    const { core, places } = rig();
    const { id } = value(places.create(placeBody(), PHONE));
    const bare = value(places.create({ name: '  Plain Place ' }, PHONE));
    const list = value(places.list('all')).places;
    expect(PlacesResponseSchema.parse({ places: list }).places).toEqual(list);
    expect(list.find((p) => p.id === id)).toEqual({
      id,
      name: 'Example Café',
      area: 'Example Area',
      link: 'https://maps.example.com/example-cafe',
      notes: 'Synthetic café notes',
      tried: true,
      dishes: [
        { name: 'Sample Dosa', rating: 5 },
        { name: 'Sample Coffee', rating: 3 },
      ],
      best: 5,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(list.find((p) => p.id === bare.id)).toEqual({ id: bare.id, name: 'Plain Place', tried: false, dishes: [], best: null, createdAt: NOW, updatedAt: NOW });
    expect(core.changedCount).toBe(2);
  });

  it('lists best first, a place with no rated dish last, then by name', () => {
    const { places } = rig();
    value(places.create({ name: 'Bravo', dishes: [{ name: 'Dish', rating: 3 }] }, PHONE));
    value(places.create({ name: 'Unrated' }, PHONE));
    value(places.create({ name: 'charlie', dishes: [{ name: 'Dish', rating: 5 }] }, PHONE));
    value(places.create({ name: 'Alpha', dishes: [{ name: 'Dish', rating: 3 }] }, PHONE));
    value(places.create({ name: 'Able', dishes: [{ name: 'A', rating: 1 }, { name: 'B', rating: 5 }] }, PHONE));
    expect(names(value(places.list('all')).places)).toEqual(['Able', 'charlie', 'Alpha', 'Bravo', 'Unrated']);
  });

  it('filters on tried and want to try, keeping the order', () => {
    const { places } = rig();
    value(places.create({ name: 'Tried Low', tried: true, dishes: [{ name: 'Dish', rating: 2 }] }, PHONE));
    value(places.create({ name: 'Want High', tried: false, dishes: [{ name: 'Dish', rating: 4 }] }, PHONE));
    value(places.create({ name: 'Tried High', tried: true, dishes: [{ name: 'Dish', rating: 5 }] }, PHONE));
    value(places.create({ name: 'Want None' }, PHONE));
    expect(names(value(places.list('tried')).places)).toEqual(['Tried High', 'Tried Low']);
    expect(names(value(places.list('want')).places)).toEqual(['Want High', 'Want None']);
    expect(value(places.list('all')).places).toHaveLength(4);
  });

  it('a change recomputes best; dishes replace the list; null clears area, link and notes; absent keeps them', () => {
    const { core, places } = rig();
    const { id } = value(places.create(placeBody(), PHONE));
    core.clock.advance(60_000);
    expect(places.update(id, { dishes: [{ name: 'Sample Vada', rating: 2 }] }, PHONE)).toEqual({ ok: true, value: true });
    let p = value(places.list('all')).places[0] as Place;
    expect(p).toMatchObject({ dishes: [{ name: 'Sample Vada', rating: 2 }], best: 2, area: 'Example Area', updatedAt: '2026-10-30T06:01:00.000Z', createdAt: NOW });
    expect(core.db.prepare('SELECT best FROM places WHERE id = ?').get(id)).toEqual({ best: 2 });
    value(places.update(id, { area: null, link: null, notes: null, tried: false, name: 'Renamed' }, PHONE));
    p = value(places.list('all')).places[0] as Place;
    expect(p).toMatchObject({ name: 'Renamed', tried: false });
    expect(p).not.toHaveProperty('area');
    expect(p).not.toHaveProperty('link');
    expect(p).not.toHaveProperty('notes');
    value(places.update(id, { dishes: [], area: '   ' }, PHONE));
    p = value(places.list('all')).places[0] as Place;
    expect(p).toMatchObject({ dishes: [], best: null });
    expect(p).not.toHaveProperty('area');
  });

  it('deletes a place; an unknown one is not_found with a fixed sentence', () => {
    const { places } = rig();
    const { id } = value(places.create(placeBody(), PHONE));
    expect(places.remove(id, PHONE)).toEqual({ ok: true, value: true });
    expect(value(places.list('all')).places).toEqual([]);
    expect(places.remove(id, PHONE)).toEqual({ ok: false, code: 'not_found', reason: PLACES_SENTENCES.none });
    expect(places.update(GHOST, { tried: true }, PHONE)).toEqual({ ok: false, code: 'not_found', reason: PLACES_SENTENCES.none });
  });

  it(`caps the list at ${LIFE_LIMITS.places} with a fixed sentence`, () => {
    const { core, places } = rig();
    const db = core.db;
    db.tx(() => {
      for (let i = 0; i < LIFE_LIMITS.places; i++) {
        const id = core.newId();
        db.prepare('INSERT INTO places (id, best, updated_at, json) VALUES (?, NULL, ?, ?)').run(
          id,
          NOW,
          JSON.stringify({ id, name: `Place ${i}`, tried: false, dishes: [], best: null, createdAt: NOW, updatedAt: NOW }),
        );
      }
    });
    expect(places.create({ name: 'One more' }, PHONE)).toEqual({ ok: false, code: 'conflict', reason: PLACES_SENTENCES.full });
  });

  it('a row that fails its check is left out and logged by id only', () => {
    const { core, ctx, places } = rig();
    value(places.create({ name: 'Good' }, PHONE));
    core.db.prepare('INSERT INTO places (id, best, updated_at, json) VALUES (?, NULL, ?, ?)').run('BROKEN', NOW, `{"name":"${LIFE_MARKER}"`);
    expect(names(value(places.list('all')).places)).toEqual(['Good']);
    expect(ctx.log.records.map((r) => r.fields)).toEqual([expect.objectContaining({ table: 'places', id: 'BROKEN' })]);
    expect(JSON.stringify(ctx.log.records)).not.toContain(LIFE_MARKER);
  });

  it('bestOf: the highest rating, null with no dishes; Cafés has no part of Today', () => {
    expect(bestOf([])).toBeNull();
    expect(bestOf([{ name: 'A', rating: 2 }, { name: 'B', rating: 4 }])).toBe(4);
    expect(rig().places.today('2026-10-30')).toEqual({});
  });
});

describe('places routes', () => {
  async function placesApi() {
    let built: TestLifeCore | undefined;
    api = await makeApi({
      ctx: { settings: V04_ON, clock: new FakeClock(NOW) },
      deps: (ctx, f) => {
        built = createTestLifeCore({ clock: ctx.clock, settings: { places: true } });
        const places = buildPlacesModule(built, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
        return { life: notBuilt<LifeService>('Life', { start: async () => {}, stop: async () => {}, broken: () => null, places }) };
      },
    });
    core = built;
    const { cookie } = await pairCookie(api, ['read', 'control']);
    return { api, cookie };
  }

  it('write replies are ids or ok; the list reads back best first; audit rows hold the target id; no text anywhere', async () => {
    const { api, cookie } = await placesApi();
    const add = await api.tcp.inject({ method: 'POST', url: '/v1/places', headers: h(cookie), payload: placeBody({}, { marked: true }) });
    expect(add.statusCode).toBe(200);
    const { id } = add.json() as { id: string };
    expect(add.json()).toEqual({ id });
    const other = await api.tcp.inject({ method: 'POST', url: '/v1/places', headers: h(cookie), payload: { name: 'Want Place', tried: false, dishes: [{ name: 'Dish', rating: 4 }] } });
    const patch = await api.tcp.inject({ method: 'PATCH', url: `/v1/places/${id}`, headers: h(cookie), payload: { notes: `more ${LIFE_MARKER}` } });
    expect(patch.json()).toEqual({ ok: true });
    const tried = await api.tcp.inject({ method: 'GET', url: '/v1/places?filter=tried', headers: h(cookie) });
    expect(PlacesResponseSchema.parse(tried.json()).places.map((p) => p.id)).toEqual([id]);
    const all = PlacesResponseSchema.parse((await api.tcp.inject({ method: 'GET', url: '/v1/places', headers: h(cookie) })).json());
    expect(all.places.map((p) => p.id)).toEqual([id, (other.json() as { id: string }).id]);
    const del = await api.tcp.inject({ method: 'DELETE', url: `/v1/places/${id}`, headers: h(cookie) });
    expect(del.json()).toEqual({ ok: true });
    const audit = api.ctx.db.audit.list().filter((a) => a.action.startsWith('place'));
    expect(audit.map((a) => [a.action, a.target])).toEqual([
      ['placeCreate', id],
      ['placeCreate', (other.json() as { id: string }).id],
      ['placeUpdate', id],
      ['placeDelete', id],
    ]);
    for (const a of audit) expect(a.params).toEqual({});
    const r = api.ctx.store.replay(0);
    expect(JSON.stringify([r.kind === 'events' ? r.events : [], api.ctx.db.audit.list(), api.ctx.log.records])).not.toContain(LIFE_MARKER);
  });

  it('a link that is not https is 400; an unknown place 404; a bad filter 400; not on ctl.sock', async () => {
    const { api, cookie } = await placesApi();
    for (const link of ['http://maps.example.com/x', 'javascript:alert(1)', '/relative']) {
      const res = await api.tcp.inject({ method: 'POST', url: '/v1/places', headers: h(cookie), payload: placeBody({ link }) });
      expect(res.statusCode, link).toBe(400);
    }
    const ghost = await api.tcp.inject({ method: 'PATCH', url: `/v1/places/${GHOST}`, headers: h(cookie), payload: { tried: true } });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().error).toEqual({ code: 'not_found', message: PLACES_SENTENCES.none });
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/places?filter=best', headers: h(cookie) })).statusCode).toBe(400);
    expect((await api.ctl.inject({ method: 'GET', url: '/v1/places' })).statusCode).toBe(404);
  });
});
