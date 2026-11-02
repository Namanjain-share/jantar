/**
 * v0.10 Cafés depth, the protocol's part (spec 0.10 A1, A3): a café's own
 * stars, six sub-ratings, a price level, would go again and tags (fixed
 * keys plus custom ones, at most 20); dishes with an optional rating, a
 * price, order again and notes; visits. Stored shapes are tolerant (a key a
 * later build adds never hides a café) while bodies stay strict. The list
 * query's sorts and filters, the score, tag keys, and the route table: the
 * reads on ctl.sock, every write the phone's, ids-only replies. Synthetic
 * values only.
 */
import { describe, expect, it } from 'vitest';
import {
  DishBodySchema,
  DishSchema,
  IdReplySchema,
  LIFE_LIMITS,
  OkReplySchema,
  PLACE_RATING_KEYS,
  PLACE_RATING_LABELS,
  PLACE_TAGS,
  PLACE_TAGS_MAX,
  PLACE_TAG_LABELS,
  PLACE_WORK_TAGS,
  PlaceBodySchema,
  PlaceDetailSchema,
  PlaceGetQuerySchema,
  PlacePatchSchema,
  PlaceSchema,
  PlaceVisitBodySchema,
  PlaceVisitPatchSchema,
  PlaceVisitSchema,
  PlacesQuerySchema,
  PlacesResponseSchema,
  ROUTES,
  normalizePlaceTags,
  placeScore,
  placeTagKey,
  placeTagLabel,
  type RouteDef,
  type RouteName,
} from '../src/index.js';

const ID = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const ID2 = '01JFZ8X8Y3T0V5G9WQK2M4N6PS';
const AT = '2026-11-02T10:00:00.000Z';
const ok = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) => schema.safeParse(v).success;

/** A café as a 0.9 daemon stored it: no new field at all. */
const OLD_PLACE = { id: ID, name: 'Example Café', tried: true, dishes: [{ name: 'Sample Dosa', rating: 5 }], best: 5, createdAt: AT, updatedAt: AT };

describe('constants', () => {
  it('six sub-ratings, 21 fixed tags (work first) each with a label, 20 a café, 10,000 visits', () => {
    expect(PLACE_RATING_KEYS).toEqual(['food', 'drinks', 'ambience', 'service', 'value', 'work']);
    expect(Object.keys(PLACE_RATING_LABELS)).toEqual([...PLACE_RATING_KEYS]);
    expect(PLACE_RATING_LABELS.drinks).toBe('Coffee & drinks');
    expect(PLACE_TAGS).toHaveLength(21);
    expect(PLACE_TAGS.slice(0, 5)).toEqual([...PLACE_WORK_TAGS]);
    expect(Object.keys(PLACE_TAG_LABELS)).toEqual([...PLACE_TAGS]);
    expect(PLACE_TAGS_MAX).toBe(20);
    expect(LIFE_LIMITS.placeVisits).toBe(10_000);
    expect(LIFE_LIMITS.places).toBe(1_000);
  });
});

describe('a café body', () => {
  it('takes stars 1 to 5, each sub-rating 1 to 5, a price level 1 to 4, yes/maybe/no and tags', () => {
    const body = {
      name: 'Example Café',
      stars: 4,
      ratings: { food: 5, drinks: 4, ambience: 3, service: 4, value: 2, work: 5 },
      price: 2,
      again: 'yes',
      tags: ['wifi', 'sockets', 'Sample custom'],
    };
    expect(PlaceBodySchema.parse(body)).toEqual(body);
    for (const stars of [0, 6, 4.5]) expect(ok(PlaceBodySchema, { ...body, stars }), `stars ${stars}`).toBe(false);
    for (const price of [0, 5, 1.5]) expect(ok(PlaceBodySchema, { ...body, price }), `price ${price}`).toBe(false);
    expect(ok(PlaceBodySchema, { ...body, ratings: { food: 6 } })).toBe(false);
    expect(ok(PlaceBodySchema, { ...body, ratings: { food: 0 } })).toBe(false);
    expect(ok(PlaceBodySchema, { ...body, again: 'often' })).toBe(false);
  });

  it(`takes at most ${PLACE_TAGS_MAX} tags, each 1 to 24 characters with no control character`, () => {
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `tag ${i}`);
    expect(ok(PlaceBodySchema, { name: 'Example Café', tags: tags(20) })).toBe(true);
    expect(ok(PlaceBodySchema, { name: 'Example Café', tags: tags(21) })).toBe(false);
    for (const tag of ['', '   ', 'x'.repeat(25), 'bad\u0007tag', 'line\nbreak', 'del\u007f']) {
      expect(ok(PlaceBodySchema, { name: 'Example Café', tags: [tag] }), JSON.stringify(tag)).toBe(false);
    }
    expect(PlaceBodySchema.parse({ name: 'Example Café', tags: ['  Quiet corner  '] }).tags).toEqual(['Quiet corner']);
  });

  it('a dish needs no rating (listed before it is tried) and takes a price, order again and notes', () => {
    expect(ok(PlaceBodySchema, { name: 'Example Café', dishes: [{ name: 'Sample Bun' }] })).toBe(true);
    const dish = { name: 'Sample Bun', rating: 4, price: 18000, again: true, notes: 'Warm is best' };
    expect(DishBodySchema.parse(dish)).toEqual(dish);
    expect(ok(DishBodySchema, { ...dish, rating: 6 })).toBe(false);
    expect(ok(DishBodySchema, { ...dish, price: 0 })).toBe(false);
    expect(ok(DishBodySchema, { ...dish, price: 1.5 })).toBe(false);
    expect(ok(DishBodySchema, { ...dish, notes: 'x'.repeat(201) })).toBe(false);
    expect(ok(DishBodySchema, { ...dish, name: '' })).toBe(false);
    expect(ok(PlaceBodySchema, { name: 'Example Café', dishes: Array(31).fill({ name: 'Sample Bun' }) })).toBe(false);
  });

  it('bodies are strict: an unknown key is refused at the top, in a dish and in the ratings', () => {
    expect(ok(PlaceBodySchema, { name: 'Example Café', colour: 'red' })).toBe(false);
    expect(ok(PlaceBodySchema, { name: 'Example Café', visits: { count: 1 } })).toBe(false);
    expect(ok(PlaceBodySchema, { name: 'Example Café', dishes: [{ name: 'Sample Bun', spicy: true }] })).toBe(false);
    expect(ok(PlaceBodySchema, { name: 'Example Café', ratings: { music: 4 } })).toBe(false);
    expect(ok(PlacePatchSchema, { colour: 'red' })).toBe(false);
    expect(ok(PlacePatchSchema, { ratings: { music: 4 } })).toBe(false);
    expect(ok(PlacePatchSchema, { dishes: [{ name: 'Sample Bun', spicy: true }] })).toBe(false);
  });
});

describe('a café patch', () => {
  it('null clears stars, price, again and each sub-rating; tags and dishes are whole lists', () => {
    expect(PlacePatchSchema.parse({ stars: null, price: null, again: null, ratings: { food: null, work: 4 } })).toEqual({
      stars: null,
      price: null,
      again: null,
      ratings: { food: null, work: 4 },
    });
    expect(ok(PlacePatchSchema, { tags: [] })).toBe(true);
    expect(ok(PlacePatchSchema, { tags: null })).toBe(false);
    expect(ok(PlacePatchSchema, { dishes: [{ name: 'Sample Bun' }] })).toBe(true);
    expect(ok(PlacePatchSchema, { stars: 0 })).toBe(false);
    expect(ok(PlacePatchSchema, { price: 5 })).toBe(false);
  });
});

describe('stored shapes are tolerant', () => {
  it('a 0.9 café reads with no tags and an empty visits summary', () => {
    expect(PlaceSchema.parse(OLD_PLACE)).toEqual({ ...OLD_PLACE, tags: [], visits: { count: 0, last: null, avgSpend: null } });
  });

  it('a key a later build adds is dropped, never a refusal (the café, its dish and its ratings)', () => {
    const later = {
      ...OLD_PLACE,
      stars: 4,
      ratings: { food: 5, music: 3 },
      dishes: [{ name: 'Sample Dosa', rating: 5, spicy: true }],
      someday: 'x',
    };
    const p = PlaceSchema.parse(later);
    expect(p).not.toHaveProperty('someday');
    expect(p.ratings).toEqual({ food: 5 });
    expect(p.dishes).toEqual([{ name: 'Sample Dosa', rating: 5 }]);
    expect(DishSchema.parse({ name: 'Sample Bun', spicy: true })).toEqual({ name: 'Sample Bun' });
    expect(PlaceVisitSchema.parse({ id: ID2, placeId: ID, day: '2026-11-01', mood: 'x', createdAt: AT, updatedAt: AT })).not.toHaveProperty('mood');
  });

  it('best may be null with dishes (none rated)', () => {
    expect(ok(PlaceSchema, { ...OLD_PLACE, dishes: [{ name: 'Sample Bun' }], best: null })).toBe(true);
  });
});

describe('visits', () => {
  it('a body: every field optional (day defaults to today on the Mac); spend in hundredths; at most 10 dishes had; notes 500', () => {
    expect(PlaceVisitBodySchema.parse({})).toEqual({});
    const body = { day: '2026-11-01', spend: 45000, stars: 4, had: ['Sample Bun', 'Flat white'], notes: 'Quiet before 11' };
    expect(PlaceVisitBodySchema.parse(body)).toEqual(body);
    expect(ok(PlaceVisitBodySchema, { day: '2026-13-01' })).toBe(false);
    expect(ok(PlaceVisitBodySchema, { spend: 0 })).toBe(false);
    expect(ok(PlaceVisitBodySchema, { spend: 450.5 })).toBe(false);
    expect(ok(PlaceVisitBodySchema, { stars: 6 })).toBe(false);
    expect(ok(PlaceVisitBodySchema, { had: Array(11).fill('Sample Bun') })).toBe(false);
    expect(ok(PlaceVisitBodySchema, { had: [''] })).toBe(false);
    expect(ok(PlaceVisitBodySchema, { notes: 'x'.repeat(501) })).toBe(false);
    expect(ok(PlaceVisitBodySchema, { mood: 'x' })).toBe(false);
  });

  it('a patch: null clears spend, stars, had and notes; never the day', () => {
    expect(PlaceVisitPatchSchema.parse({ spend: null, stars: null, had: null, notes: null })).toEqual({ spend: null, stars: null, had: null, notes: null });
    expect(ok(PlaceVisitPatchSchema, { day: null })).toBe(false);
    expect(ok(PlaceVisitPatchSchema, { placeId: ID })).toBe(false);
  });
});

describe('the list query', () => {
  it('defaults to all, best first', () => {
    expect(PlacesQuerySchema.parse({})).toEqual({ filter: 'all', sort: 'best' });
  });

  it('parses every sort and filter from a query string', () => {
    expect(
      PlacesQuerySchema.parse({ filter: 'tried', sort: 'work', tags: 'wifi,sockets', price: '2', stars: '4', again: '1', area: ' Old Town ', q: ' dosa ' }),
    ).toEqual({ filter: 'tried', sort: 'work', tags: 'wifi,sockets', price: '2', stars: '4', again: true, area: 'Old Town', q: 'dosa' });
    for (const sort of ['best', 'recent', 'visits', 'name', 'price', 'work']) expect(ok(PlacesQuerySchema, { sort }), sort).toBe(true);
    for (const bad of [{ sort: 'rating' }, { price: '5' }, { stars: '0' }, { again: 'yes' }, { q: 'x'.repeat(81) }, { tags: 'x'.repeat(401) }, { filter: 'best' }]) {
      expect(ok(PlacesQuerySchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('the response carries tag and area counts; one café reads with a page of visits', () => {
    expect(ok(PlacesResponseSchema, { places: [OLD_PLACE], tags: [{ tag: 'wifi', n: 1 }], areas: [{ area: 'Old Town', n: 1 }] })).toBe(true);
    const visit = { id: ID2, placeId: ID, day: '2026-11-01', spend: 45000, createdAt: AT, updatedAt: AT };
    expect(ok(PlaceDetailSchema, { place: OLD_PLACE, visits: [visit], more: false })).toBe(true);
    expect(PlaceGetQuerySchema.parse({ before: ID2 })).toEqual({ before: ID2 });
    expect(ok(PlaceGetQuerySchema, { before: 'not-an-id' })).toBe(false);
  });
});

describe('tags and the score', () => {
  it('a fixed key or label in any case is stored as the key; a custom tag as typed (trimmed)', () => {
    expect(placeTagKey('Wi-Fi')).toBe('wifi');
    expect(placeTagKey('WIFI')).toBe('wifi');
    expect(placeTagKey(' laptop-friendly ')).toBe('laptops');
    expect(placeTagKey('Specialty Coffee')).toBe('specialty-coffee');
    expect(placeTagKey('  Board games ')).toBe('Board games');
    expect(placeTagLabel('wifi')).toBe('Wi-Fi');
    expect(placeTagLabel('Board games')).toBe('Board games');
  });

  it('normalising drops duplicates in any case and keeps the order given', () => {
    expect(normalizePlaceTags(['Quiet', 'wifi', 'Wi-Fi', 'board games', 'Board Games', 'quiet', 'Sockets'])).toEqual(['quiet', 'wifi', 'board games', 'sockets']);
    expect(normalizePlaceTags([])).toEqual([]);
  });

  it('the score: own stars, else the sub-ratings mean to the nearest half, else the best dish, else none', () => {
    expect(placeScore({ stars: 2, ratings: { food: 5 }, best: 5 })).toBe(2);
    expect(placeScore({ ratings: { food: 5, drinks: 4 }, best: 1 })).toBe(4.5);
    expect(placeScore({ ratings: { food: 5, drinks: 4, ambience: 4 } })).toBe(4.5);
    expect(placeScore({ ratings: { food: 4, drinks: 4, ambience: 3 } })).toBe(3.5);
    expect(placeScore({ ratings: { food: 3, drinks: 3, ambience: 4 } })).toBe(3.5);
    expect(placeScore({ ratings: { food: 3, drinks: 3, ambience: 3, service: 3, value: 4 } })).toBe(3);
    // 3.25 is half way: it rounds up.
    expect(placeScore({ ratings: { food: 3, drinks: 3, ambience: 3, service: 4 } })).toBe(3.5);
    expect(placeScore({ ratings: {}, best: 3 })).toBe(3);
    expect(placeScore({ best: null })).toBeNull();
    expect(placeScore({})).toBeNull();
  });
});

describe('v0.10 routes', () => {
  const routes = Object.entries(ROUTES) as [RouteName, RouteDef][];
  const v010 = routes.filter(([, r]) => r.phase === 'v0.10');

  it('four new café routes, at control scope behind the places switch', () => {
    // Chat's v0.10 routes have their own test (v010-chat.test.ts).
    const cafes = v010.filter(([n]) => n.startsWith('place'));
    expect(cafes.map(([n]) => n).sort()).toEqual(['placeGet', 'placeVisitAdd', 'placeVisitDelete', 'placeVisitUpdate']);
    for (const [name, r] of cafes) {
      expect(r.scope, name).toBe('control');
      expect(r.feature, name).toBe('places');
      expect(r.path.startsWith('/v1/places/:id'), name).toBe(true);
    }
    expect([ROUTES.placeGet.method, ROUTES.placeGet.path]).toEqual(['GET', '/v1/places/:id']);
    expect([ROUTES.placeVisitAdd.method, ROUTES.placeVisitAdd.path]).toEqual(['POST', '/v1/places/:id/visits']);
    expect([ROUTES.placeVisitUpdate.method, ROUTES.placeVisitUpdate.path]).toEqual(['PATCH', '/v1/places/:id/visits/:visitId']);
    expect([ROUTES.placeVisitDelete.method, ROUTES.placeVisitDelete.path]).toEqual(['DELETE', '/v1/places/:id/visits/:visitId']);
  });

  it('the list and one café are on ctl.sock (read only); every café write is not', () => {
    const cafe = routes.filter(([, r]) => r.feature === 'places');
    expect(cafe.filter(([, r]) => r.ctl).map(([n]) => n).sort()).toEqual(['placeGet', 'placesList']);
    for (const [name, r] of cafe) {
      expect(r.ctl, name).toBe(r.method === 'GET');
      expect(r.localOnly, name).toBeUndefined();
    }
  });

  it('write replies carry an id or ok only', () => {
    expect(ROUTES.placeVisitAdd.response).toBe(IdReplySchema);
    expect(ROUTES.placeVisitUpdate.response).toBe(OkReplySchema);
    expect(ROUTES.placeVisitDelete.response).toBe(OkReplySchema);
    expect(ROUTES.placeCreate.response).toBe(IdReplySchema);
    expect(ROUTES.placeUpdate.response).toBe(OkReplySchema);
    expect(ROUTES.placeDelete.response).toBe(OkReplySchema);
  });
});
