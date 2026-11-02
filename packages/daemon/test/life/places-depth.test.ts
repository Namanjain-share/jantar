/**
 * v0.10 Cafés depth (spec 0.10 A4), the module and its routes:
 *
 * - create and patch: stars, sub-ratings (merged per key, null clears one),
 *   price, would go again, tags (fixed keys from labels, no duplicates,
 *   order kept, a whole list), dishes (a whole list; an unrated dish never
 *   counts for best);
 * - the list: every sort with its ties, every filter alone and together,
 *   the tag and area counts over the segment;
 * - visits: the first marks the café tried in the same transaction; today
 *   or earlier; the cap; the summary (count, newest day, mean spend); pages
 *   with `before`; a café's delete takes its visits in one transaction; a
 *   bad visit row is left out and logged by id only;
 * - routes: ids-only replies, audit rows with the target id only, the reads
 *   on ctl.sock and no write there, and LIFE_MARKER (in a name, an area,
 *   notes, a dish's notes, a tag, a visit's notes and what was had) in no
 *   event, audit row or log line.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LIFE_MARKER, placeBody, visitBody } from '@jantar/fixtures';
import {
  LIFE_LIMITS,
  PLACE_VISITS_PAGE,
  PlaceDetailSchema,
  PlacesQuerySchema,
  PlacesResponseSchema,
  type Place,
  type PlaceBody,
  type PlacesQuery,
  type PlacesQueryInput,
} from '@jantar/protocol';
import type { Actor, LifeService, PlacesModule } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { createTestContext, createTestLifeCore, type TestContext, type TestLifeCore } from '../../src/core/testing.js';
import { PLACES_SENTENCES, buildPlacesModule } from '../../src/life/places/module.js';
import { h, makeApi, makeFakes, pairCookie, type TestApi } from '../api/fakes.js';
import { V04_ON } from '../api/v04-helpers.js';

const PHONE: Actor = { kind: 'device', deviceId: 'dev-phone', scopes: ['read', 'control'] };
// 06:00 UTC on 30 Oct: the Life zone's today is 2026-10-30.
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
  core = createTestLifeCore({ clock: new FakeClock(NOW), tz: 'UTC', settings: { places: true } });
  const ctx = createTestContext({ clock: core.clock });
  const f = makeFakes(ctx);
  return { core, ctx, places: buildPlacesModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy }) };
}

function value<T>(r: { ok: true; value: T } | { ok: false; code: string; reason: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return r.value;
}

const q = (over: PlacesQueryInput = {}): PlacesQuery => PlacesQuerySchema.parse(over);
const names = (places: Place[]) => places.map((p) => p.name);
const add = (places: PlacesModule, body: PlaceBody) => value(places.create(body, PHONE)).id;
const one = (places: PlacesModule, id: string) => value(places.get(id)).place;

describe('a café: create and patch', () => {
  it('keeps stars, the sub-ratings that are set, price, would go again and tags as keys; an empty ratings object is left out', () => {
    const { places } = rig();
    const id = add(places, {
      name: 'Example Café',
      stars: 4,
      ratings: { food: 5, work: 3 },
      price: 2,
      again: 'maybe',
      tags: ['Wi-Fi', 'Sockets', 'wifi', 'Board games', 'board GAMES', 'Laptop-friendly'],
    });
    expect(one(places, id)).toMatchObject({ stars: 4, ratings: { food: 5, work: 3 }, price: 2, again: 'maybe', tags: ['wifi', 'sockets', 'Board games', 'laptops'] });
    const bare = add(places, { name: 'Plain Place', ratings: {} });
    expect(one(places, bare)).not.toHaveProperty('ratings');
    expect(one(places, bare)).not.toHaveProperty('stars');
    expect(one(places, bare).tags).toEqual([]);
  });

  it('a patch: null clears stars, price and again; ratings merge per key and null clears one; tags replace the list', () => {
    const { core, places } = rig();
    const id = add(places, placeBody());
    core.clock.advance(60_000);
    value(places.update(id, { ratings: { drinks: 5, work: null, service: 2 } }, PHONE));
    expect(one(places, id).ratings).toEqual({ food: 5, drinks: 5, service: 2 });
    value(places.update(id, { stars: null, price: null, again: null }, PHONE));
    const p = one(places, id);
    expect(p).not.toHaveProperty('stars');
    expect(p).not.toHaveProperty('price');
    expect(p).not.toHaveProperty('again');
    expect(p.ratings).toEqual({ food: 5, drinks: 5, service: 2 });
    expect(p.updatedAt).toBe('2026-10-30T06:01:00.000Z');
    value(places.update(id, { tags: ['Quiet', 'quiet', 'Open late'] }, PHONE));
    expect(one(places, id).tags).toEqual(['quiet', 'late']);
    value(places.update(id, { ratings: { food: null, drinks: null, service: null } }, PHONE));
    expect(one(places, id)).not.toHaveProperty('ratings');
    // Absent keys keep what was there.
    value(places.update(id, { name: 'Renamed' }, PHONE));
    expect(one(places, id)).toMatchObject({ name: 'Renamed', tags: ['quiet', 'late'], area: 'Example Area' });
  });

  it('dishes replace wholesale; an unrated dish is kept but never counts for best; empty dish notes are left out', () => {
    const { core, places } = rig();
    const id = add(places, { name: 'Example Café', dishes: [{ name: 'Sample Bun', rating: 2 }] });
    value(places.update(id, { dishes: [{ name: 'Must try', price: 25000 }, { name: 'Flat white', rating: 4, again: false, notes: '   ' }] }, PHONE));
    const p = one(places, id);
    expect(p.dishes).toEqual([
      { name: 'Must try', price: 25000 },
      { name: 'Flat white', rating: 4, again: false },
    ]);
    expect(p.best).toBe(4);
    expect(core.db.prepare('SELECT best FROM places WHERE id = ?').get(id)).toEqual({ best: 4 });
    value(places.update(id, { dishes: [{ name: 'Must try' }] }, PHONE));
    expect(one(places, id).best).toBeNull();
  });

  it('never stores the visits summary in the json', () => {
    const { core, places } = rig();
    const id = add(places, placeBody());
    value(places.visitAdd(id, visitBody(), PHONE));
    value(places.update(id, { stars: 5 }, PHONE));
    const json = JSON.parse((core.db.prepare('SELECT json FROM places WHERE id = ?').get(id) as { json: string }).json) as Record<string, unknown>;
    expect(json).not.toHaveProperty('visits');
    expect(json).toMatchObject({ stars: 5, tags: ['wifi', 'sockets', 'Sample tag'] });
  });
});

describe('the list: sorts', () => {
  /** Six cafés with every field the sorts read, visits included. */
  function seeded() {
    const r = rig();
    const { core, places } = r;
    const ids = {
      alpha: add(places, { name: 'Alpha', stars: 3, price: 3, tags: ['wifi'], ratings: { work: 4 } }),
      bravo: add(places, { name: 'bravo', ratings: { food: 5, drinks: 4 }, price: 1, tags: ['wifi', 'sockets', 'quiet'] }),
      charlie: add(places, { name: 'Charlie', dishes: [{ name: 'Dish', rating: 5 }], tags: ['sockets'], ratings: { work: 4 } }),
      delta: add(places, { name: 'Delta' }),
      echo: add(places, { name: 'Echo', stars: 5, price: 2, ratings: { work: 2 }, tags: ['wifi', 'sockets', 'quiet', 'laptops'] }),
      foxtrot: add(places, { name: 'Foxtrot', stars: 3, price: 1 }),
    };
    core.clock.advance(60_000);
    value(places.update(ids.delta, { notes: 'touched last' }, PHONE));
    value(places.visitAdd(ids.alpha, { day: '2026-10-20' }, PHONE));
    value(places.visitAdd(ids.alpha, { day: '2026-10-21' }, PHONE));
    value(places.visitAdd(ids.alpha, { day: '2026-10-22' }, PHONE));
    value(places.visitAdd(ids.charlie, { day: '2026-10-28' }, PHONE));
    value(places.visitAdd(ids.foxtrot, { day: '2026-10-28' }, PHONE));
    return { ...r, ids };
  }

  it('best: the score (stars, else the sub-ratings mean, else the best dish), none last, ties by name', () => {
    const { places } = seeded();
    // Echo 5 (stars); bravo 4.5 (the mean of 5 and 4); Charlie 4 (its work rating comes before its 5-star dish);
    // Alpha and Foxtrot tie at 3 (stars): by name; Delta has no score.
    expect(names(value(places.list(q())).places)).toEqual(['Echo', 'bravo', 'Charlie', 'Alpha', 'Foxtrot', 'Delta']);
  });

  it('recent: the newest visit first (ties by name), then cafés with none by when they changed', () => {
    const { places } = seeded();
    // Charlie and Foxtrot both on the 28th (tie: name); Alpha the 22nd; then no visits: Delta changed last, then the rest by updatedAt (all equal: name).
    expect(names(value(places.list(q({ sort: 'recent' }))).places)).toEqual(['Charlie', 'Foxtrot', 'Alpha', 'Delta', 'bravo', 'Echo']);
  });

  it('visits: the most visited first, ties by name', () => {
    const { places } = seeded();
    expect(names(value(places.list(q({ sort: 'visits' }))).places)).toEqual(['Alpha', 'Charlie', 'Foxtrot', 'bravo', 'Delta', 'Echo']);
  });

  it('name: A to Z in any case', () => {
    const { places } = seeded();
    expect(names(value(places.list(q({ sort: 'name' }))).places)).toEqual(['Alpha', 'bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']);
  });

  it('price: the cheapest first, unknown last, ties by name', () => {
    const { places } = seeded();
    expect(names(value(places.list(q({ sort: 'price' }))).places)).toEqual(['bravo', 'Foxtrot', 'Echo', 'Alpha', 'Charlie', 'Delta']);
  });

  it('work: the work rating first (none last), then how many work tags, then the name', () => {
    const { places } = seeded();
    // Alpha and Charlie at work 4 with one work tag each: name. Echo 2. Then no rating: bravo (3 tags), then the rest by name.
    expect(names(value(places.list(q({ sort: 'work' }))).places)).toEqual(['Alpha', 'Charlie', 'Echo', 'bravo', 'Delta', 'Foxtrot']);
  });

  it('with no v0.10 field, best is the old order: the best dish, no rating last, then name', () => {
    const { places } = rig();
    add(places, { name: 'Bravo', dishes: [{ name: 'Dish', rating: 3 }] });
    add(places, { name: 'Unrated' });
    add(places, { name: 'charlie', dishes: [{ name: 'Dish', rating: 5 }] });
    add(places, { name: 'Alpha', dishes: [{ name: 'Dish', rating: 3 }] });
    expect(names(value(places.list(q())).places)).toEqual(['charlie', 'Alpha', 'Bravo', 'Unrated']);
  });
});

describe('the list: filters and counts', () => {
  function seeded() {
    const r = rig();
    const { places } = r;
    add(places, { name: 'Sample Dosa House', area: 'Market Street', tried: true, stars: 5, price: 1, again: 'yes', tags: ['wifi', 'sockets', 'veg'], dishes: [{ name: 'Ghee roast dosa', rating: 5 }] });
    add(places, { name: 'Example Café', area: 'Old Town', tried: true, stars: 4, price: 2, again: 'yes', tags: ['wifi', 'quiet'], notes: 'Cardamom buns on Sundays' });
    add(places, { name: 'Placeholder Pizza', area: 'old town', tried: true, stars: 3, price: 3, again: 'no', tags: ['groups', 'Late night'] });
    add(places, { name: 'Fixture Bakery', area: 'Hill Lane', tried: false, tags: ['breakfast', 'wifi'] });
    add(places, { name: 'Mock Ramen', tried: false, price: 2 });
    return r;
  }
  const list = (places: PlacesModule, over: PlacesQueryInput) => names(value(places.list(q(over))).places);

  it('every tag must be there (keys, labels or custom, any case)', () => {
    const { places } = seeded();
    expect(list(places, { tags: 'wifi' })).toEqual(['Sample Dosa House', 'Example Café', 'Fixture Bakery']);
    expect(list(places, { tags: 'Wi-Fi,quiet' })).toEqual(['Example Café']);
    expect(list(places, { tags: 'late night' })).toEqual(['Placeholder Pizza']);
    expect(list(places, { tags: ' , wifi ,, ' })).toEqual(['Sample Dosa House', 'Example Café', 'Fixture Bakery']);
    expect(list(places, { tags: 'rooftop' })).toEqual([]);
  });

  it('price at most (no price is left out); score at least (no score is left out); would go again (yes only)', () => {
    const { places } = seeded();
    expect(list(places, { price: '2' })).toEqual(['Sample Dosa House', 'Example Café', 'Mock Ramen']);
    expect(list(places, { price: '1' })).toEqual(['Sample Dosa House']);
    expect(list(places, { stars: '4' })).toEqual(['Sample Dosa House', 'Example Café']);
    expect(list(places, { stars: '1' })).toEqual(['Sample Dosa House', 'Example Café', 'Placeholder Pizza']);
    expect(list(places, { again: '1' })).toEqual(['Sample Dosa House', 'Example Café']);
    expect(list(places, { again: '0' })).toHaveLength(5);
  });

  it('area exactly, any case; the search in names, areas, dishes, tag keys and labels, and notes', () => {
    const { places } = seeded();
    expect(list(places, { area: 'OLD TOWN' })).toEqual(['Example Café', 'Placeholder Pizza']);
    expect(list(places, { area: 'Old' })).toEqual([]);
    expect(list(places, { q: 'dosa' })).toEqual(['Sample Dosa House']);
    expect(list(places, { q: 'GHEE' })).toEqual(['Sample Dosa House']);
    expect(list(places, { q: 'hill' })).toEqual(['Fixture Bakery']);
    expect(list(places, { q: 'cardamom' })).toEqual(['Example Café']);
    expect(list(places, { q: 'veg options' })).toEqual(['Sample Dosa House']);
    expect(list(places, { q: 'wi-fi' })).toEqual(['Sample Dosa House', 'Example Café', 'Fixture Bakery']);
  });

  it('every filter together, inside the tried or want segment', () => {
    const { places } = seeded();
    expect(list(places, { filter: 'tried', tags: 'wifi', price: '2', stars: '4', again: '1', area: 'old town', q: 'café' })).toEqual(['Example Café']);
    expect(list(places, { filter: 'want', tags: 'wifi' })).toEqual(['Fixture Bakery']);
    expect(list(places, { filter: 'want', price: '2' })).toEqual(['Mock Ramen']);
  });

  it('tag and area counts cover the segment before tags and the search narrow it', () => {
    const { places } = seeded();
    const all = value(places.list(q({ tags: 'quiet', q: 'example' })));
    expect(names(all.places)).toEqual(['Example Café']);
    expect(all.tags).toEqual([
      { tag: 'wifi', n: 3 },
      { tag: 'sockets', n: 1 },
      { tag: 'quiet', n: 1 },
      { tag: 'groups', n: 1 },
      { tag: 'veg', n: 1 },
      { tag: 'breakfast', n: 1 },
      { tag: 'Late night', n: 1 },
    ]);
    expect(all.areas).toEqual([
      { area: 'Old Town', n: 2 },
      { area: 'Hill Lane', n: 1 },
      { area: 'Market Street', n: 1 },
    ]);
    const want = value(places.list(q({ filter: 'want' })));
    expect(want.tags).toEqual([
      { tag: 'wifi', n: 1 },
      { tag: 'breakfast', n: 1 },
    ]);
    expect(want.areas).toEqual([{ area: 'Hill Lane', n: 1 }]);
    expect(PlacesResponseSchema.parse(all)).toEqual(all);
  });
});

describe('visits', () => {
  it('the first marks the café tried; the summary has the count, the newest day and the mean spend of visits with one', () => {
    const { core, places } = rig();
    const id = add(places, { name: 'Fixture Bakery' });
    const changed = core.changedCount;
    const v1 = value(places.visitAdd(id, { day: '2026-10-20', spend: 40000 }, PHONE)).id;
    expect(core.changedCount).toBe(changed + 1);
    expect(one(places, id)).toMatchObject({ tried: true, visits: { count: 1, last: '2026-10-20', avgSpend: 40000 } });
    value(places.visitAdd(id, { day: '2026-10-25', spend: 50001 }, PHONE));
    value(places.visitAdd(id, { day: '2026-10-22' }, PHONE));
    const p = one(places, id);
    expect(p.visits).toEqual({ count: 3, last: '2026-10-25', avgSpend: 45001 });
    expect(value(places.list(q())).places[0]?.visits).toEqual(p.visits);
    // A visit's day defaults to today in the Life zone.
    const today = value(places.visitAdd(id, {}, PHONE)).id;
    expect(value(places.get(id)).visits[0]).toMatchObject({ id: today, day: '2026-10-30' });
    expect(value(places.get(id)).visits.map((v) => v.day)).toEqual(['2026-10-30', '2026-10-25', '2026-10-22', '2026-10-20']);
    expect(value(places.get(id)).visits.at(-1)?.id).toBe(v1);
  });

  it('keeps every field; a patch changes the day and null clears spend, stars, had and notes', () => {
    const { places } = rig();
    const id = add(places, placeBody());
    const vid = value(places.visitAdd(id, visitBody(), PHONE)).id;
    expect(value(places.get(id)).visits[0]).toEqual({
      id: vid,
      placeId: id,
      day: '2026-10-30',
      spend: 45000,
      stars: 4,
      had: ['Sample Dosa'],
      notes: 'Synthetic visit notes',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(places.visitUpdate(id, vid, { day: '2026-10-01', spend: null, stars: null, had: null, notes: null }, PHONE)).toEqual({ ok: true, value: true });
    expect(value(places.get(id)).visits[0]).toEqual({ id: vid, placeId: id, day: '2026-10-01', createdAt: NOW, updatedAt: NOW });
    expect(one(places, id).visits).toEqual({ count: 1, last: '2026-10-01', avgSpend: null });
  });

  it('a future day is refused, adding and changing; a café that is gone or a visit of another café is not_found', () => {
    const { places } = rig();
    const id = add(places, { name: 'Example Café' });
    const other = add(places, { name: 'Other Café' });
    expect(places.visitAdd(id, { day: '2026-10-31' }, PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: PLACES_SENTENCES.visitFuture });
    const vid = value(places.visitAdd(id, {}, PHONE)).id;
    expect(places.visitUpdate(id, vid, { day: '2026-11-01' }, PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: PLACES_SENTENCES.visitFuture });
    expect(places.visitAdd(GHOST, {}, PHONE)).toEqual({ ok: false, code: 'not_found', reason: PLACES_SENTENCES.none });
    expect(places.visitUpdate(other, vid, { stars: 2 }, PHONE)).toEqual({ ok: false, code: 'not_found', reason: PLACES_SENTENCES.visitNone });
    expect(places.visitRemove(other, vid, PHONE)).toEqual({ ok: false, code: 'not_found', reason: PLACES_SENTENCES.visitNone });
    expect(places.visitUpdate(id, GHOST, { stars: 2 }, PHONE)).toEqual({ ok: false, code: 'not_found', reason: PLACES_SENTENCES.visitNone });
    expect(places.visitRemove(GHOST, vid, PHONE)).toEqual({ ok: false, code: 'not_found', reason: PLACES_SENTENCES.none });
    expect(places.visitRemove(id, vid, PHONE)).toEqual({ ok: true, value: true });
    expect(places.visitRemove(id, vid, PHONE)).toEqual({ ok: false, code: 'not_found', reason: PLACES_SENTENCES.visitNone });
    // Deleting a visit leaves the café tried.
    expect(one(places, id)).toMatchObject({ tried: true, visits: { count: 0, last: null, avgSpend: null } });
  });

  it(`caps every café's visits together at ${LIFE_LIMITS.placeVisits.toLocaleString('en')} with a fixed sentence`, () => {
    const { core, places } = rig();
    const id = add(places, { name: 'Example Café' });
    core.db.tx(() => {
      for (let i = 0; i < LIFE_LIMITS.placeVisits; i++) {
        const vid = core.newId();
        core.db.prepare('INSERT INTO place_visits (id, place_id, day, updated_at, json) VALUES (?, ?, ?, ?, ?)').run(vid, 'OTHER', '2026-10-01', NOW, JSON.stringify({ id: vid, placeId: GHOST, day: '2026-10-01', createdAt: NOW, updatedAt: NOW }));
      }
    });
    expect(places.visitAdd(id, {}, PHONE)).toEqual({ ok: false, code: 'conflict', reason: PLACES_SENTENCES.visitsFull });
    expect(PLACES_SENTENCES.visitsFull).toBe('You have 10,000 café visits. Delete one to add another.');
  });

  it(`one café reads with its newest ${PLACE_VISITS_PAGE} visits, then the older ones by ?before`, () => {
    const { core, places } = rig();
    const id = add(places, { name: 'Example Café', tried: true });
    // One visit a day from 1 April, the last on 22 October.
    const dayOf = (i: number) => new Date(Date.UTC(2026, 3, 1 + i)).toISOString().slice(0, 10);
    core.db.tx(() => {
      for (let i = 0; i < PLACE_VISITS_PAGE + 5; i++) value(places.visitAdd(id, { day: dayOf(i), notes: `Visit ${i}` }, PHONE));
    });
    const first = value(places.get(id));
    expect(PlaceDetailSchema.parse(first)).toEqual(first);
    expect(first.visits).toHaveLength(PLACE_VISITS_PAGE);
    expect(first.more).toBe(true);
    expect(first.visits[0]).toMatchObject({ day: '2026-10-22', notes: `Visit ${PLACE_VISITS_PAGE + 4}` });
    const last = first.visits.at(-1)?.id as string;
    const rest = value(places.get(id, last));
    expect(rest.more).toBe(false);
    expect(rest.visits.map((v) => v.notes)).toEqual(['Visit 4', 'Visit 3', 'Visit 2', 'Visit 1', 'Visit 0']);
    expect(places.get(id, GHOST)).toEqual({ ok: false, code: 'not_found', reason: PLACES_SENTENCES.visitNone });
    expect(places.get(GHOST)).toEqual({ ok: false, code: 'not_found', reason: PLACES_SENTENCES.none });
  });

  it("deleting a café deletes its visits, in one transaction; another café's are kept", () => {
    const { core, places } = rig();
    const id = add(places, { name: 'Example Café' });
    const other = add(places, { name: 'Other Café' });
    value(places.visitAdd(id, {}, PHONE));
    value(places.visitAdd(id, {}, PHONE));
    value(places.visitAdd(other, {}, PHONE));
    // A café that refuses to go: its visits stay too (rolled back together).
    core.db.raw.exec(`CREATE TRIGGER keep_place BEFORE DELETE ON places WHEN old.id = '${id}' BEGIN SELECT RAISE(ABORT, 'kept'); END`);
    expect(() => places.remove(id, PHONE)).toThrow(/kept/);
    expect((core.db.prepare('SELECT COUNT(*) AS n FROM place_visits WHERE place_id = ?').get(id) as { n: number }).n).toBe(2);
    core.db.raw.exec('DROP TRIGGER keep_place');
    expect(places.remove(id, PHONE)).toEqual({ ok: true, value: true });
    expect(core.db.prepare('SELECT place_id FROM place_visits').all()).toEqual([{ place_id: other }]);
  });

  it('a visit and the tried flag it sets are one transaction', () => {
    const { core, places } = rig();
    const id = add(places, { name: 'Example Café' });
    core.db.raw.exec('CREATE TRIGGER no_update BEFORE UPDATE ON places BEGIN SELECT RAISE(ABORT, "held"); END');
    expect(() => places.visitAdd(id, {}, PHONE)).toThrow(/held/);
    expect((core.db.prepare('SELECT COUNT(*) AS n FROM place_visits').get() as { n: number }).n).toBe(0);
    core.db.raw.exec('DROP TRIGGER no_update');
  });

  it('a visit row that fails its check is left out and logged by id only; the list still reads', () => {
    const { core, ctx, places } = rig();
    const id = add(places, { name: 'Example Café' });
    value(places.visitAdd(id, { day: '2026-10-02', spend: 30000 }, PHONE));
    core.db.prepare('INSERT INTO place_visits (id, place_id, day, updated_at, json) VALUES (?, ?, ?, ?, ?)').run('BROKEN', id, '2026-10-03', NOW, `{"notes":"${LIFE_MARKER}"`);
    expect(value(places.get(id)).visits.map((v) => v.day)).toEqual(['2026-10-02']);
    expect(value(places.list(q())).places[0]?.visits).toEqual({ count: 2, last: '2026-10-03', avgSpend: 30000 });
    expect(ctx.log.records.map((r) => r.fields)).toEqual([expect.objectContaining({ table: 'place_visits', id: 'BROKEN' })]);
    expect(JSON.stringify(ctx.log.records)).not.toContain(LIFE_MARKER);
  });
});

describe('café routes (v0.10)', () => {
  async function placesApi() {
    let built: TestLifeCore | undefined;
    api = await makeApi({
      ctx: { settings: V04_ON, clock: new FakeClock(NOW) },
      deps: (ctx, f) => {
        built = createTestLifeCore({ clock: ctx.clock, tz: 'UTC', settings: { places: true } });
        const places = buildPlacesModule(built, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
        return { life: notBuilt<LifeService>('Life', { start: async () => {}, stop: async () => {}, broken: () => null, places }) };
      },
    });
    core = built;
    const { cookie } = await pairCookie(api, ['read', 'control']);
    return { api, cookie };
  }

  it('ids-only replies; audit rows with the café id only; no Life text in events, audit rows or logs', async () => {
    const { api, cookie } = await placesApi();
    const post = (url: string, payload: object) => api.tcp.inject({ method: 'POST', url, headers: h(cookie), payload });
    const add = await post('/v1/places', placeBody({}, { marked: true }));
    const { id } = add.json() as { id: string };
    expect(add.json()).toEqual({ id });
    const visit = await post(`/v1/places/${id}/visits`, visitBody({ day: '2026-10-29' }, { marked: true }));
    expect(visit.statusCode).toBe(200);
    const vid = (visit.json() as { id: string }).id;
    expect(visit.json()).toEqual({ id: vid });
    const patch = await api.tcp.inject({ method: 'PATCH', url: `/v1/places/${id}/visits/${vid}`, headers: h(cookie), payload: { notes: `later ${LIFE_MARKER}`, had: [`Dish ${LIFE_MARKER}`] } });
    expect(patch.json()).toEqual({ ok: true });
    const edit = await api.tcp.inject({ method: 'PATCH', url: `/v1/places/${id}`, headers: h(cookie), payload: { tags: [`Tag ${LIFE_MARKER}`], ratings: { food: 2 } } });
    expect(edit.json()).toEqual({ ok: true });

    const detail = PlaceDetailSchema.parse((await api.tcp.inject({ method: 'GET', url: `/v1/places/${id}`, headers: h(cookie) })).json());
    expect(detail.place.tags).toEqual([`Tag ${LIFE_MARKER}`]);
    expect(detail.visits.map((v) => v.id)).toEqual([vid]);
    const list = PlacesResponseSchema.parse((await api.tcp.inject({ method: 'GET', url: '/v1/places?sort=visits&tags=Tag%20' + LIFE_MARKER, headers: h(cookie) })).json());
    expect(list.places.map((p) => [p.id, p.visits.count])).toEqual([[id, 1]]);

    const del = await api.tcp.inject({ method: 'DELETE', url: `/v1/places/${id}/visits/${vid}`, headers: h(cookie) });
    expect(del.json()).toEqual({ ok: true });
    const gone = await api.tcp.inject({ method: 'DELETE', url: `/v1/places/${id}`, headers: h(cookie) });
    expect(gone.json()).toEqual({ ok: true });

    const audit = api.ctx.db.audit.list().filter((a) => a.action.startsWith('place'));
    expect(audit.map((a) => [a.action, a.target])).toEqual([
      ['placeCreate', id],
      ['placeVisitAdd', id],
      ['placeVisitUpdate', id],
      ['placeUpdate', id],
      ['placeVisitDelete', id],
      ['placeDelete', id],
    ]);
    for (const a of audit) expect(a.params).toEqual({});
    const r = api.ctx.store.replay(0);
    expect(JSON.stringify([r.kind === 'events' ? r.events : [], api.ctx.db.audit.list(), api.ctx.log.records])).not.toContain(LIFE_MARKER);
  });

  it('the list and one café are read on ctl.sock; no café or visit write is', async () => {
    const { api, cookie } = await placesApi();
    const { id } = (await api.tcp.inject({ method: 'POST', url: '/v1/places', headers: h(cookie), payload: placeBody() })).json() as { id: string };
    const vid = ((await api.tcp.inject({ method: 'POST', url: `/v1/places/${id}/visits`, headers: h(cookie), payload: visitBody() })).json() as { id: string }).id;
    expect((await api.ctl.inject({ method: 'GET', url: '/v1/places?sort=name' })).statusCode).toBe(200);
    const one = await api.ctl.inject({ method: 'GET', url: `/v1/places/${id}` });
    expect(one.statusCode).toBe(200);
    expect(PlaceDetailSchema.parse(one.json()).visits.map((v) => v.id)).toEqual([vid]);
    for (const [method, url] of [
      ['POST', '/v1/places'],
      ['PATCH', `/v1/places/${id}`],
      ['DELETE', `/v1/places/${id}`],
      ['POST', `/v1/places/${id}/visits`],
      ['PATCH', `/v1/places/${id}/visits/${vid}`],
      ['DELETE', `/v1/places/${id}/visits/${vid}`],
    ] as const) {
      expect((await api.ctl.inject({ method, url, payload: {} })).statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('400 for a bad query, a future visit or an unknown key; 404 with the fixed sentences', async () => {
    const { api, cookie } = await placesApi();
    const { id } = (await api.tcp.inject({ method: 'POST', url: '/v1/places', headers: h(cookie), payload: { name: 'Example Café' } })).json() as { id: string };
    for (const query of ['sort=rating', 'price=5', 'stars=0', 'again=yes']) {
      expect((await api.tcp.inject({ method: 'GET', url: `/v1/places?${query}`, headers: h(cookie) })).statusCode, query).toBe(400);
    }
    const future = await api.tcp.inject({ method: 'POST', url: `/v1/places/${id}/visits`, headers: h(cookie), payload: { day: '2026-10-31' } });
    expect(future.statusCode).toBe(400);
    expect(future.json().error).toEqual({ code: 'invalid_request', message: PLACES_SENTENCES.visitFuture });
    expect((await api.tcp.inject({ method: 'POST', url: `/v1/places/${id}/visits`, headers: h(cookie), payload: { mood: 'x' } })).statusCode).toBe(400);
    expect((await api.tcp.inject({ method: 'POST', url: '/v1/places', headers: h(cookie), payload: { name: 'Example', tags: Array(21).fill('x') } })).statusCode).toBe(400);
    const ghost = await api.tcp.inject({ method: 'GET', url: `/v1/places/${GHOST}`, headers: h(cookie) });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().error).toEqual({ code: 'not_found', message: PLACES_SENTENCES.none });
    const noVisit = await api.tcp.inject({ method: 'DELETE', url: `/v1/places/${id}/visits/${GHOST}`, headers: h(cookie) });
    expect(noVisit.json().error).toEqual({ code: 'not_found', message: PLACES_SENTENCES.visitNone });
  });
});
