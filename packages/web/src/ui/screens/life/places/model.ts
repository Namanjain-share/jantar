/**
 * What the Cafés screens share (v0.10, spec 0.10 A7): the list query from
 * the address, the labels of the sorts, sub-ratings and tags, a price level
 * in the Life currency's symbol (or a word with none set), and "12 Oct".
 * Every v0.10 field may be missing from a 0.9 daemon's answer.
 */
import { PLACE_PRICE_WORDS, PLACE_RATING_KEYS, PLACE_RATING_LABELS, PLACE_TAGS, PLACE_WORK_TAGS, placeTagLabel, type Place, type PlacesQueryInput } from '@jantar/protocol';
import { currencySymbol } from '../../../../lib/money.js';
import type { PlacesFilter, PlacesSortKey, PlacesView } from '../../../../lib/router.js';

export const SORT_LABELS: Record<PlacesSortKey, string> = {
  best: 'Best',
  recent: 'Recent',
  visits: 'Most visited',
  name: 'Name',
  price: 'Price',
  work: 'Work',
};
export const SORTS = Object.keys(SORT_LABELS) as PlacesSortKey[];

export const RATING_KEYS = PLACE_RATING_KEYS;
export const RATING_LABELS = PLACE_RATING_LABELS;
export const tagLabel = placeTagLabel;
export const WORK_TAGS: readonly string[] = PLACE_WORK_TAGS;
export const FIXED_TAGS: readonly string[] = PLACE_TAGS;

/** The daemon's list query for the address's view. */
export function placesQuery(filter: PlacesFilter, v: PlacesView): PlacesQueryInput {
  const q: PlacesQueryInput = {};
  if (filter !== 'all') q.filter = filter;
  if (v.sort && v.sort !== 'best') q.sort = v.sort;
  if (v.tags) q.tags = v.tags;
  if (v.price) q.price = v.price as PlacesQueryInput['price'];
  if (v.stars) q.stars = v.stars as PlacesQueryInput['stars'];
  if (v.again) q.again = '1';
  if (v.area) q.area = v.area;
  if (v.q) q.q = v.q;
  return q;
}

/** The tags of a view's comma list. */
export function tagsOf(tags: string | undefined): string[] {
  return (tags ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

/** How many filters the Filters button counts (tags one each; search and sort are not filters). */
export function filterCount(v: PlacesView): number {
  return tagsOf(v.tags).length + (v.price ? 1 : 0) + (v.stars ? 1 : 0) + (v.again ? 1 : 0) + (v.area ? 1 : 0);
}

/** "₹₹" for level 2 in the Life currency, or "Mid" with none set. */
export function priceLabel(level: number, currency: string | null): string {
  const symbol = currencySymbol(currency);
  return symbol ? symbol.repeat(level) : (PLACE_PRICE_WORDS[level - 1] ?? '');
}

/** "12 Oct" from a day key. */
export function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** A café's tags (none from a 0.9 daemon). */
export const tagsOn = (p: Pick<Place, 'tags'>): readonly string[] => p.tags ?? [];
/** A café's visit count (0 from a 0.9 daemon). */
export const visitsOn = (p: Pick<Place, 'visits'>): number => p.visits?.count ?? 0;

/** The first `n` tags' labels and how many more there are: "Wi-Fi Sockets +2". */
export function tagsLine(tags: readonly string[], n = 2): string {
  const shown = tags.slice(0, n).map(placeTagLabel).join(' ');
  return tags.length > n ? `${shown} +${tags.length - n}` : shown;
}

/** "Would go again", "Maybe again", "Not again". */
export const AGAIN_LABEL = { yes: 'would go again', maybe: 'maybe again', no: 'not again' } as const;
