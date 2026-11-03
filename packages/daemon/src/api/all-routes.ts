/**
 * v0.11: every route this daemon serves: ROUTES (the owner's, in the
 * package index and his web bundle) plus People's two tables from the
 * `@jantar/protocol/people` subpath (her routes, PERSON_ROUTES, and his
 * People routes, PEOPLE_ROUTES), kept out of the index so neither ever
 * lands in the owner's main bundle. The pipeline registers ALL_ROUTES, and
 * the isolation suites iterate it, so a route added to any table joins
 * every matrix the day it lands (spec 9.7.2).
 */
import { ROUTES, type RouteDef, type RouteName } from '@jantar/protocol';
import { PEOPLE_ROUTES, PERSON_PREFIX, PERSON_ROUTES, type PeopleRouteName, type PersonRouteName } from '@jantar/protocol/people';

export type AnyRouteName = RouteName | PeopleRouteName | PersonRouteName;

export const ALL_ROUTES: Readonly<Record<AnyRouteName, RouteDef>> = { ...ROUTES, ...PEOPLE_ROUTES, ...PERSON_ROUTES };

/** One of her routes: scope `person`, under PERSON_PREFIX. */
export function isPersonRouteDef(def: Pick<RouteDef, 'scope'>): boolean {
  return def.scope === 'person';
}

/** One of his People routes (`/v1/people`, `/v1/people/*`). */
export function isPeopleRoutePath(path: string): boolean {
  return path === '/v1/people' || path.startsWith('/v1/people/');
}

export { PERSON_PREFIX };
