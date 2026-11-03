/**
 * v0.11: every route this daemon serves: ROUTES (the owner's, in the
 * package index and his web bundle), v0.13 Work's (WORK_ROUTES, his too,
 * from the `@jantar/protocol/work` subpath, so they stay out of his main
 * bundle), plus People's two tables from the
 * `@jantar/protocol/people` subpath (her routes, PERSON_ROUTES, and his
 * People routes, PEOPLE_ROUTES), kept out of the index so neither ever
 * lands in the owner's main bundle. The pipeline registers ALL_ROUTES, and
 * the isolation suites iterate it, so a route added to any table joins
 * every matrix the day it lands (spec 9.7.2).
 */
import { ROUTES, type RouteDef, type RouteName } from '@jantar/protocol';
import { PEOPLE_ROUTES, PERSON_PREFIX, PERSON_ROUTES, type PeopleRouteName, type PersonRouteName } from '@jantar/protocol/people';
import { WORK_ROUTES, type WorkRouteName } from '@jantar/protocol/work';

export type AnyRouteName = RouteName | WorkRouteName | PeopleRouteName | PersonRouteName;

export const ALL_ROUTES: Readonly<Record<AnyRouteName, RouteDef>> = { ...ROUTES, ...WORK_ROUTES, ...PEOPLE_ROUTES, ...PERSON_ROUTES };

/** One of her routes: scope `person`, under PERSON_PREFIX. */
export function isPersonRouteDef(def: Pick<RouteDef, 'scope'>): boolean {
  return def.scope === 'person';
}

/** One of his People routes (`/v1/people`, `/v1/people/*`). */
export function isPeopleRoutePath(path: string): boolean {
  return path === '/v1/people' || path.startsWith('/v1/people/');
}

export { PERSON_PREFIX };
