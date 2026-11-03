/**
 * Synthetic cafés for the Cafés web tests (v0.10): made-up names, areas and
 * links only. `render` serves the list (filtered by nothing: the fake
 * returns what it is given) and each café's detail from the same places.
 */
import { vi } from 'vitest';
import type { LifeStatus, Place, PlaceDetail, PlaceVisit, PlacesResponse } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import { fakeApi, iso, renderApp, stateWith } from './helpers.js';
import type { Layout } from '../src/ui/shell/layout.js';

export const DAY = '2026-01-15';
export const id = (n: number) => `01JFZ8X8Y3T0V5G9WQK2M4N${String(n).padStart(3, '0')}`;
export const vid = (n: number) => `01JFZ8X8Y3T0V5G9WQK2M5V${String(n).padStart(3, '0')}`;
const NO_VISITS = { count: 0, last: null, avgSpend: null };

export function place(n: number, over: Partial<Place> = {}): Place {
  return { id: id(n), name: `Example Café ${n}`, tried: true, dishes: [], best: null, tags: [], visits: { ...NO_VISITS }, createdAt: iso(0), updatedAt: iso(0), ...over };
}

export function visit(n: number, placeN: number, over: Partial<PlaceVisit> = {}): PlaceVisit {
  return { id: vid(n), placeId: id(placeN), day: DAY, createdAt: iso(0), updatedAt: iso(0), ...over };
}

export const PLACES: Place[] = [
  place(1, {
    area: 'Old Town',
    link: 'https://maps.example.com/cafe-1',
    dishes: [
      { name: 'Sample Dosa', rating: 5, price: 18000, again: true },
      { name: 'Sample Coffee', rating: 3 },
    ],
    best: 5,
    stars: 4,
    price: 2,
    again: 'yes',
    ratings: { food: 5, work: 3 },
    tags: ['wifi', 'sockets', 'quiet', 'Board games'],
    notes: 'Go before noon.',
    visits: { count: 3, last: '2026-01-12', avgSpend: 45000 },
  }),
  place(2, { tried: false, dishes: [{ name: 'Sample Toast', rating: 3 }], best: 3, price: 1 }),
  place(3, { name: '<img src=x onerror="window.__pwned=1">', link: 'javascript:alert(1)' as string, again: 'no' }),
];

export function status(over: Partial<LifeStatus> = {}): LifeStatus {
  return {
    open: true,
    timezone: 'UTC',
    today: DAY,
    currency: 'INR',
    lockScreenDetails: false,
    modules: { todos: false, medicines: false, food: false, places: true, finance: false, posts: false },
    estimate: { available: false },
    backups: { last: null, count: 0 },
    push: { devices: 1, webpush: true },
    ...over,
  };
}

/** The list reply for `places` (tags and areas counted over them). */
export function listOf(places: Place[]): PlacesResponse {
  const tags = new Map<string, number>();
  const areas = new Map<string, number>();
  for (const p of places) {
    for (const t of p.tags ?? []) tags.set(t, (tags.get(t) ?? 0) + 1);
    if (p.area) areas.set(p.area, (areas.get(p.area) ?? 0) + 1);
  }
  return { places, tags: [...tags].map(([tag, n]) => ({ tag, n })), areas: [...areas].map(([area, n]) => ({ area, n })) };
}

export interface RenderOpts {
  places?: Place[];
  /** Each café's visits, by its number in `id(n)`. */
  visits?: Record<string, PlaceVisit[]>;
  list?: (q?: unknown) => Promise<unknown>;
  status?: LifeStatus;
  path?: string;
  api?: Parameters<typeof fakeApi>[0];
  conn?: 'live' | 'offline';
  /** 0.12: a window's layout (a wide one splits the list and the café). */
  layout?: Layout;
}

export function render(opts: RenderOpts = {}) {
  const places = opts.places ?? PLACES;
  const placeGet = vi.fn(async (pid: string, before?: string): Promise<PlaceDetail> => {
    const p = places.find((x) => x.id === pid);
    if (!p) throw new ApiError('not_found', 'That café is gone.', 404);
    const all = opts.visits?.[pid] ?? [];
    const from = before ? all.findIndex((v) => v.id === before) + 1 : 0;
    const page = all.slice(from, from + 2);
    return { place: p, visits: page, more: from + 2 < all.length };
  });
  const api = fakeApi({
    lifeStatus: vi.fn(async () => opts.status ?? status()),
    placesList: vi.fn((opts.list ?? (async () => listOf(places))) as never),
    placeGet,
    ...opts.api,
  });
  return renderApp({ path: opts.path ?? '/places', api, state: stateWith({ features: { life: true } }), ...(opts.conn ? { status: opts.conn } : {}), ...(opts.layout ? { layout: opts.layout } : {}) });
}
