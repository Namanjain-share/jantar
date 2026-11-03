/**
 * Cafés (spec 4.7; WP-FF): your own list of places and their dishes.
 * v0.10 (spec 0.10 A4): a café's own stars, six optional sub-ratings, a
 * price level, would go again, tags (fixed keys plus custom ones), dishes
 * with an optional rating, a price, order again and notes, and visits.
 * No map. The link is https only (the schema) and never requested.
 *
 * - `best` is the highest rated dish (an unrated one never counts),
 *   recomputed on every write. The list filters (tried or want, every tag,
 *   price at most, score at least, would go again, area, a search) and
 *   then sorts (best, recent, visits, name, price, work) here, so the
 *   phone, the CLI and Chat share one implementation; every sort ends with
 *   the name, then the id, so the order never wobbles. The score is the
 *   café's stars, else its sub-ratings' mean to the nearest half, else its
 *   best dish (`placeScore`).
 * - A patch's null clears stars, price, again, area, link and notes;
 *   ratings merge per key (null clears that key); tags and dishes replace
 *   wholesale. Tags are stored as fixed keys where they name one, without
 *   duplicates, in the order given.
 * - Visits: today or earlier in the Life zone; the first one marks the café
 *   tried, in the same transaction; deleting a café deletes its visits in
 *   one transaction. At most LIFE_LIMITS.placeVisits across every café.
 *
 * v0.11 People (P4, spec 5.2): the owner's module reads his own cafés and
 * every space he shares (a Shared chip and `?space=` filter on his list);
 * `inShared(space, by)` is a member's module over one shared space. On a
 * shared café either person edits, rates and changes dishes (last edit
 * wins, "Edited by"); each logs and changes only their own visits (C39); a
 * delete by either tells the other (core.shared). He can share a café of his
 * and move one he added back to just him; one she added stays shared.
 *
 * Empty optional text (an area or notes of only spaces) is left out rather
 * than stored. Caps answer conflict with a fixed sentence; every write ends
 * with `core.changed()`; replies carry ids only. No pings, no part of Today.
 */
import {
  LIFE_LIMITS,
  PLACE_RATING_KEYS,
  PLACE_TAGS,
  PLACE_VISITS_PAGE,
  PLACE_WORK_TAGS,
  PlaceSchema,
  PlaceVisitSchema,
  normalizePlaceTags,
  placeScore,
  placeTagKey,
  placeTagLabel,
  type Dish,
  type GoAgain,
  type Place,
  type PlaceBody,
  type PlacePatch,
  type PlaceRatings,
  type PlaceVisit,
  type PlaceVisitBody,
  type PlaceVisitPatch,
  type PlacesQuery,
  type PlacesResponse,
  type PlacesSort,
} from '@jantar/protocol';
import type { Actor, LifeCore, LifeModuleDeps, LifeResult, PlacesModule } from '../../contracts.js';
import { PlacesRepo } from './repo.js';

export const PLACES_SENTENCES = {
  none: 'That café is gone.',
  full: `You have ${LIFE_LIMITS.places.toLocaleString('en')} cafés. Delete one to add another.`,
  invalid: 'That café is not valid.',
  visitNone: 'That visit is gone.',
  visitsFull: `You have ${LIFE_LIMITS.placeVisits.toLocaleString('en')} café visits. Delete one to add another.`,
  visitFuture: 'A visit can be today or earlier.',
  // v0.11 People (P4)
  noSpace: 'No such shared list.',
  stayShared: 'They added this café, so it stays shared.',
  memberShared: 'Cafés you add here are shared.',
  notYourVisit: 'Only the person who logged a visit can change or delete it.',
} as const;

/** The highest rating among the rated dishes, or null when none is rated. */
export function bestOf(dishes: readonly Dish[]): number | null {
  const rated = dishes.flatMap((d) => (d.rating === undefined ? [] : [d.rating]));
  return rated.length === 0 ? null : Math.max(...rated);
}

const byName = (a: Place, b: Place): number => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Higher first, none (undefined or null) last. */
function desc(a: number | null | undefined, b: number | null | undefined): number {
  const x = a ?? Number.NEGATIVE_INFINITY;
  const y = b ?? Number.NEGATIVE_INFINITY;
  return x === y ? 0 : y > x ? 1 : -1;
}

const workTags = (p: Place): number => p.tags.filter((t) => (PLACE_WORK_TAGS as readonly string[]).includes(t)).length;

/** Each sort, then the name, then the id. */
const SORTS: Record<PlacesSort, (a: Place, b: Place) => number> = {
  best: (a, b) => desc(placeScore(a), placeScore(b)),
  recent: (a, b) => desc(a.visits.last ? Date.parse(a.visits.last) : null, b.visits.last ? Date.parse(b.visits.last) : null) || desc(Date.parse(a.updatedAt), Date.parse(b.updatedAt)),
  visits: (a, b) => desc(a.visits.count, b.visits.count),
  name: () => 0,
  price: (a, b) => (a.price ?? 5) - (b.price ?? 5),
  work: (a, b) => desc(a.ratings?.work, b.ratings?.work) || desc(workTags(a), workTags(b)),
};

/** Best first (by the score; none last), then by name, then by id. With no v0.10 field this is the best dish's order. */
export function byBest(a: Place, b: Place): number {
  return SORTS.best(a, b) || byName(a, b);
}

/** Optional text with its spaces trimmed, or undefined when nothing is left. */
function text(v: string | null | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function fail(code: 'invalid_request' | 'not_found' | 'conflict', reason: string): LifeResult<never> {
  return { ok: false, code, reason };
}

/** A dish from its named fields only, empty notes left out. */
function dishOf(d: Dish): Dish {
  const out: Dish = { name: d.name.trim() };
  if (d.rating !== undefined) out.rating = d.rating;
  if (d.price !== undefined) out.price = d.price;
  if (d.again !== undefined) out.again = d.again;
  const notes = text(d.notes);
  if (notes !== undefined) out.notes = notes;
  return out;
}

/** The sub-ratings that are set, or undefined when none is. */
function ratingsOf(r: PlaceRatings | undefined): PlaceRatings | undefined {
  if (!r) return undefined;
  const out: PlaceRatings = {};
  for (const k of PLACE_RATING_KEYS) {
    const v = r[k];
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

interface PlaceFields {
  id: string;
  name: string;
  area?: string | undefined;
  link?: string | undefined;
  notes?: string | undefined;
  tried: boolean;
  dishes: readonly Dish[];
  stars?: number | undefined;
  ratings?: PlaceRatings | undefined;
  price?: number | undefined;
  again?: GoAgain | undefined;
  tags?: readonly string[] | undefined;
  createdAt: string;
  updatedAt: string;
}

/** A place built from its named fields only, each optional one set only when it holds something (`area: undefined` is never stored). */
function shape(p: PlaceFields): Place {
  const dishes = p.dishes.map(dishOf);
  const out: Place = {
    id: p.id,
    name: p.name.trim(),
    tried: p.tried,
    dishes,
    best: bestOf(dishes),
    tags: normalizePlaceTags(p.tags ?? []),
    visits: { count: 0, last: null, avgSpend: null },
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
  const area = text(p.area);
  const notes = text(p.notes);
  const ratings = ratingsOf(p.ratings);
  if (area !== undefined) out.area = area;
  if (p.link !== undefined) out.link = p.link;
  if (notes !== undefined) out.notes = notes;
  if (p.stars !== undefined) out.stars = p.stars;
  if (ratings !== undefined) out.ratings = ratings;
  if (p.price !== undefined) out.price = p.price;
  if (p.again !== undefined) out.again = p.again;
  return out;
}

/** A visit from its named fields only, empty notes and an empty had left out. */
function visitShape(v: { id: string; placeId: string; day: string; spend?: number | undefined; stars?: number | undefined; had?: readonly string[] | undefined; notes?: string | undefined; createdAt: string; updatedAt: string }): PlaceVisit {
  const out: PlaceVisit = { id: v.id, placeId: v.placeId, day: v.day, createdAt: v.createdAt, updatedAt: v.updatedAt };
  if (v.spend !== undefined) out.spend = v.spend;
  if (v.stars !== undefined) out.stars = v.stars;
  const had = (v.had ?? []).map((h) => h.trim()).filter((h) => h !== '');
  if (had.length) out.had = had;
  const notes = text(v.notes);
  if (notes !== undefined) out.notes = notes;
  return out;
}

/** `patch[k]` when given (null clears it), else what `before` had. */
function patched<T>(given: T | null | undefined, before: T | undefined): T | undefined {
  return given === undefined ? before : (given ?? undefined);
}

/** Every text a search looks in: name, area, dish names, tags (keys and labels) and notes, folded. */
function haystack(p: Place): string {
  return [p.name, p.area ?? '', ...p.dishes.map((d) => d.name), ...p.tags, ...p.tags.map(placeTagLabel), p.notes ?? ''].join('\n').toLowerCase();
}

/** Counts of each tag over `places`, the most common first, then the fixed tags in their order, then custom ones by name. */
function tagCounts(places: readonly Place[]): PlacesResponse['tags'] {
  const n = new Map<string, number>();
  for (const p of places) for (const t of p.tags) n.set(t, (n.get(t) ?? 0) + 1);
  const fixed = (t: string) => {
    const i = (PLACE_TAGS as readonly string[]).indexOf(t);
    return i < 0 ? PLACE_TAGS.length : i;
  };
  return [...n]
    .map(([tag, count]) => ({ tag, n: count }))
    .sort((a, b) => b.n - a.n || fixed(a.tag) - fixed(b.tag) || a.tag.localeCompare(b.tag, 'en', { sensitivity: 'base' }));
}

/** Counts of each area over `places` (any case counts as one, shown as first seen), the most common first, then by name. */
function areaCounts(places: readonly Place[]): PlacesResponse['areas'] {
  const n = new Map<string, { area: string; n: number }>();
  for (const p of places) {
    if (!p.area) continue;
    const key = p.area.toLowerCase();
    const seen = n.get(key);
    if (seen) seen.n += 1;
    else n.set(key, { area: p.area, n: 1 });
  }
  return [...n.values()].sort((a, b) => b.n - a.n || a.area.localeCompare(b.area, 'en', { sensitivity: 'base' }));
}

/** The list query's filters after the segment: every tag, price at most, score at least, would go again, area, search. */
function matches(p: Place, q: PlacesQuery, tags: readonly string[]): boolean {
  if (tags.length) {
    const has = new Set(p.tags.map((t) => t.toLowerCase()));
    if (!tags.every((t) => has.has(t.toLowerCase()))) return false;
  }
  if (q.price !== undefined && (p.price === undefined || p.price > Number(q.price))) return false;
  if (q.stars !== undefined) {
    const score = placeScore(p);
    if (score === null || score < Number(q.stars)) return false;
  }
  if (q.again === true && p.again !== 'yes') return false;
  if (q.area !== undefined && q.area !== '' && p.area?.toLowerCase() !== q.area.toLowerCase()) return false;
  if (q.q !== undefined && q.q !== '' && !haystack(p).includes(q.q.toLowerCase())) return false;
  return true;
}

/** What a module reads and writes: the owner's own and shared spaces, or one shared space as a member. */
interface PlacesScope {
  read(): string[];
  /** Where a member's new café goes (the owner names it per café). */
  write: string;
  /** Who writes ('' the owner, or the member's id). */
  by: string;
  member: boolean;
}

/** Every shared space (the owner is a member of each). */
function sharedSpaces(core: LifeCore): string[] {
  try {
    return (core.db.prepare('SELECT id FROM shared_spaces ORDER BY id').all() as { id: string }[]).map((r) => r.id);
  } catch {
    return [];
  }
}

export function buildPlacesModule(core: LifeCore, deps: LifeModuleDeps): PlacesModule {
  const log = deps.ctx.log.child({ part: 'life', module: 'places' });
  return makePlaces(core, log, { read: () => ['', ...sharedSpaces(core)], write: '', by: '', member: false });
}

function makePlaces(core: LifeCore, log: LifeModuleDeps['ctx']['log'], scope: PlacesScope): PlacesModule {
  const repo = new PlacesRepo(core, log, scope);

  const valid = (p: Place): boolean => PlaceSchema.safeParse(p).success;
  const isShared = (space: string | undefined): space is string => space !== undefined && space !== '';
  const told = (space: string | undefined, kind: 'place' | 'visit', action: 'added' | 'changed' | 'deleted', title?: string) => {
    if (isShared(space)) core.shared?.({ space, by: scope.by, kind, action, ...(title ? { title } : {}) });
  };

  const save = (p: Place, space?: string): LifeResult => {
    if (!valid(p)) return fail('invalid_request', PLACES_SENTENCES.invalid);
    repo.put(p);
    core.changed();
    told(space, 'place', 'changed', p.name);
    return { ok: true, value: true };
  };

  /** "Edited by" on a shared café: whoever wrote last, and when. */
  const stamped = (p: Place, space: string | undefined, now: string): Place => {
    const { editedBy: _b, editedAt: _a, by: _by, space: _s, ...rest } = p;
    return isShared(space) ? { ...rest, editedBy: scope.by, editedAt: now } : rest;
  };

  return {
    name: 'places',

    inShared(space: string, by: string): PlacesModule {
      return makePlaces(core, log, { read: () => [space], write: space, by, member: true });
    },

    list(q: PlacesQuery) {
      const all = repo.all().filter((p) => scope.member || !q.space || q.space === 'all' || (q.space === 'shared' ? isShared(p.space) : !isShared(p.space)));
      const segment = all.filter((p) => q.filter === 'all' || (q.filter === 'tried' ? p.tried : !p.tried));
      const tags = normalizePlaceTags((q.tags ?? '').split(',').map(placeTagKey));
      const places = segment.filter((p) => matches(p, q, tags));
      const sort = SORTS[q.sort];
      places.sort((a, b) => sort(a, b) || byName(a, b));
      return { ok: true, value: { places, tags: tagCounts(segment), areas: areaCounts(segment) } };
    },

    get(id: string, before?: string) {
      const place = repo.get(id);
      if (!place) return fail('not_found', PLACES_SENTENCES.none);
      const page = repo.visits(id, before, PLACE_VISITS_PAGE);
      if (!page) return fail('not_found', PLACES_SENTENCES.visitNone);
      return { ok: true, value: { place, visits: page.visits, more: page.more } };
    },

    create(body: PlaceBody, _actor: Actor) {
      const { space: asked, ...fields } = body;
      const space = scope.member ? scope.write : (asked ?? '');
      if (!scope.read().includes(space)) return fail('invalid_request', PLACES_SENTENCES.noSpace);
      if (repo.count(space) >= LIFE_LIMITS.places) return fail('conflict', PLACES_SENTENCES.full);
      const now = core.now().toISOString();
      const place = shape({ ...fields, id: core.newId(), tried: fields.tried ?? false, dishes: fields.dishes ?? [], createdAt: now, updatedAt: now });
      if (!valid(place)) return fail('invalid_request', PLACES_SENTENCES.invalid);
      repo.insert(place, space, scope.by);
      core.changed();
      told(space, 'place', 'added', place.name);
      return { ok: true, value: { id: place.id } };
    },

    update(id: string, patch: PlacePatch, _actor: Actor) {
      const p = repo.get(id);
      if (!p) return fail('not_found', PLACES_SENTENCES.none);
      const from = p.space ?? '';
      let to = from;
      if (patch.space !== undefined && patch.space !== from) {
        // Share or unshare (spec 5.2): his own café to shared; back to him only when he added it.
        if (scope.member) return fail('invalid_request', PLACES_SENTENCES.memberShared);
        if (!scope.read().includes(patch.space)) return fail('invalid_request', PLACES_SENTENCES.noSpace);
        if (isShared(from) && patch.space === '' && p.by !== '') return fail('conflict', PLACES_SENTENCES.stayShared);
        if (repo.count(patch.space) >= LIFE_LIMITS.places) return fail('conflict', PLACES_SENTENCES.full);
        to = patch.space;
      }
      // ratings merge per key: a key given as null clears it, one left out keeps it.
      let ratings = p.ratings;
      if (patch.ratings) {
        const merged: Record<string, number | undefined> = { ...p.ratings };
        for (const k of PLACE_RATING_KEYS) {
          const v = patch.ratings[k];
          if (v !== undefined) merged[k] = v ?? undefined;
        }
        ratings = merged as PlaceRatings;
      }
      const now = core.now().toISOString();
      const next = stamped(
        shape({
          ...p,
          name: patch.name ?? p.name,
          area: patched(patch.area, p.area),
          link: patched(patch.link, p.link),
          notes: patched(patch.notes, p.notes),
          tried: patch.tried ?? p.tried,
          dishes: patch.dishes ?? p.dishes,
          stars: patched(patch.stars, p.stars),
          ratings,
          price: patched(patch.price, p.price),
          again: patched(patch.again, p.again),
          tags: patch.tags ?? p.tags,
          updatedAt: now,
        }),
        to,
        now,
      );
      if (to === from) return save(next, from);
      if (!valid(next)) return fail('invalid_request', PLACES_SENTENCES.invalid);
      core.db.tx(() => {
        repo.put(next);
        repo.move(id, from, to);
      });
      core.changed();
      told(isShared(to) ? to : from, 'place', 'changed', next.name);
      return { ok: true, value: true };
    },

    remove(id: string, _actor: Actor) {
      const p = repo.get(id);
      if (!p || !repo.deletePlaceAndVisits(id)) return fail('not_found', PLACES_SENTENCES.none);
      core.changed();
      told(p.space, 'place', 'deleted', p.name);
      return { ok: true, value: true };
    },

    visitAdd(placeId: string, body: PlaceVisitBody, _actor: Actor) {
      const place = repo.get(placeId);
      if (!place) return fail('not_found', PLACES_SENTENCES.none);
      const space = place.space ?? '';
      const day = body.day ?? core.today();
      if (day > core.today()) return fail('invalid_request', PLACES_SENTENCES.visitFuture);
      if (repo.visitCount(space) >= LIFE_LIMITS.placeVisits) return fail('conflict', PLACES_SENTENCES.visitsFull);
      const now = core.now().toISOString();
      const visit = visitShape({ ...body, id: core.newId(), placeId, day, createdAt: now, updatedAt: now });
      if (!PlaceVisitSchema.safeParse(visit).success) return fail('invalid_request', PLACES_SENTENCES.invalid);
      const tried = place.tried ? null : stamped(shape({ ...place, tried: true, updatedAt: now }), space, now);
      if (tried && !valid(tried)) return fail('invalid_request', PLACES_SENTENCES.invalid);
      core.db.tx(() => {
        repo.visitPut(visit, space, scope.by);
        if (tried) repo.put(tried);
      });
      core.changed();
      told(space, 'visit', 'added', place.name);
      return { ok: true, value: { id: visit.id } };
    },

    visitUpdate(placeId: string, visitId: string, patch: PlaceVisitPatch, _actor: Actor) {
      const place = repo.get(placeId);
      if (!place) return fail('not_found', PLACES_SENTENCES.none);
      const v = repo.visitGet(placeId, visitId);
      if (!v) return fail('not_found', PLACES_SENTENCES.visitNone);
      // C39: each person changes only their own visits.
      if (isShared(place.space) && (v.by ?? '') !== scope.by) return fail('conflict', PLACES_SENTENCES.notYourVisit);
      const day = patch.day ?? v.day;
      if (day > core.today()) return fail('invalid_request', PLACES_SENTENCES.visitFuture);
      const next = visitShape({
        ...v,
        day,
        spend: patched(patch.spend, v.spend),
        stars: patched(patch.stars, v.stars),
        had: patched(patch.had, v.had),
        notes: patched(patch.notes, v.notes),
        updatedAt: core.now().toISOString(),
      });
      if (!PlaceVisitSchema.safeParse(next).success) return fail('invalid_request', PLACES_SENTENCES.invalid);
      repo.visitPut(next, place.space ?? '', scope.by);
      core.changed();
      told(place.space, 'visit', 'changed', place.name);
      return { ok: true, value: true };
    },

    visitRemove(placeId: string, visitId: string, _actor: Actor) {
      const place = repo.get(placeId);
      if (!place) return fail('not_found', PLACES_SENTENCES.none);
      const v = repo.visitGet(placeId, visitId);
      if (!v) return fail('not_found', PLACES_SENTENCES.visitNone);
      if (isShared(place.space) && (v.by ?? '') !== scope.by) return fail('conflict', PLACES_SENTENCES.notYourVisit);
      if (!repo.visitDelete(placeId, visitId)) return fail('not_found', PLACES_SENTENCES.visitNone);
      core.changed();
      told(place.space, 'visit', 'changed', place.name);
      return { ok: true, value: true };
    },

    today() {
      return {};
    },
  };
}
