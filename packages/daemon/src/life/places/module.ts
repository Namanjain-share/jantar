/**
 * Cafés (spec 4.7; WP-FF): your own list of places and their dishes, each
 * dish rated 1 to 5. A place's `best` is its highest dish rating,
 * recomputed on every write; the list is always best first (places with no
 * rated dish last), then by name, and filters on tried or want to try.
 * No map, no visits, no other sort. `link` is https only (the schema); the
 * daemon never requests it.
 *
 * Empty optional text (an area or notes of only spaces) is left out rather
 * than stored. Caps answer conflict with a fixed sentence; every write ends
 * with `core.changed()`; replies carry ids only. No pings, no part of Today.
 */
import { LIFE_LIMITS, PlaceSchema, type Dish, type Place, type PlaceBody, type PlacePatch, type PlacesQuery } from '@jantar/protocol';
import type { Actor, LifeCore, LifeModuleDeps, LifeResult, PlacesModule } from '../../contracts.js';
import { PlacesRepo } from './repo.js';

export const PLACES_SENTENCES = {
  none: 'That café is gone.',
  full: `You have ${LIFE_LIMITS.places.toLocaleString('en')} cafés. Delete one to add another.`,
  invalid: 'That café is not valid.',
} as const;

/** The highest dish rating, or null with no dishes. */
export function bestOf(dishes: readonly Dish[]): number | null {
  return dishes.length === 0 ? null : Math.max(...dishes.map((d) => d.rating));
}

/** Best first (no rating last), then by name, then by id so the order never wobbles. */
export function byBest(a: Place, b: Place): number {
  const best = (b.best ?? 0) - (a.best ?? 0);
  if (best !== 0) return best;
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Optional text with its spaces trimmed, or undefined when nothing is left. */
function text(v: string | null | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function fail(code: 'invalid_request' | 'not_found' | 'conflict', reason: string): LifeResult<never> {
  return { ok: false, code, reason };
}

/** A place with its optional fields set only when they hold something (`area: undefined` is never stored). */
function shape(p: Omit<Place, 'area' | 'link' | 'notes' | 'best'> & { area?: string | undefined; link?: string | undefined; notes?: string | undefined }): Place {
  const out: Place = { id: p.id, name: p.name.trim(), tried: p.tried, dishes: p.dishes, best: bestOf(p.dishes), createdAt: p.createdAt, updatedAt: p.updatedAt };
  const area = text(p.area);
  const notes = text(p.notes);
  if (area !== undefined) out.area = area;
  if (p.link !== undefined) out.link = p.link;
  if (notes !== undefined) out.notes = notes;
  return out;
}

export function buildPlacesModule(core: LifeCore, deps: LifeModuleDeps): PlacesModule {
  const repo = new PlacesRepo(core, deps.ctx.log.child({ part: 'life', module: 'places' }));

  const save = (p: Place): LifeResult => {
    if (!PlaceSchema.safeParse(p).success) return fail('invalid_request', PLACES_SENTENCES.invalid);
    repo.put(p);
    core.changed();
    return { ok: true, value: true };
  };

  return {
    name: 'places',

    list(filter: PlacesQuery['filter']) {
      const places = repo.all().filter((p) => filter === 'all' || (filter === 'tried' ? p.tried : !p.tried));
      return { ok: true, value: { places: places.sort(byBest) } };
    },

    create(body: PlaceBody, _actor: Actor) {
      if (repo.count() >= LIFE_LIMITS.places) return fail('conflict', PLACES_SENTENCES.full);
      const now = core.now().toISOString();
      const place = shape({ ...body, id: core.newId(), tried: body.tried ?? false, dishes: body.dishes ?? [], createdAt: now, updatedAt: now });
      const r = save(place);
      return r.ok ? { ok: true, value: { id: place.id } } : r;
    },

    update(id: string, patch: PlacePatch, _actor: Actor) {
      const p = repo.get(id);
      if (!p) return fail('not_found', PLACES_SENTENCES.none);
      // null clears area, link and notes; dishes replace the list wholesale.
      const pick = <K extends 'area' | 'link' | 'notes'>(k: K): string | undefined => (patch[k] === undefined ? p[k] : (patch[k] ?? undefined));
      return save(
        shape({
          ...p,
          name: patch.name ?? p.name,
          area: pick('area'),
          link: pick('link'),
          notes: pick('notes'),
          tried: patch.tried ?? p.tried,
          dishes: patch.dishes ?? p.dishes,
          updatedAt: core.now().toISOString(),
        }),
      );
    },

    remove(id: string, _actor: Actor) {
      if (!repo.delete(id)) return fail('not_found', PLACES_SENTENCES.none);
      core.changed();
      return { ok: true, value: true };
    },

    today() {
      return {};
    },
  };
}
