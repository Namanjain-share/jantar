/**
 * v0.11 People: her food log (scope `person`, area food), thin handlers over
 * life/people/food.ts with her as the caller. Every one answers the one
 * "food log is off" 404 while her food module is off (O6); `space` is
 * daemon-set (strict bodies carry none). Only she writes her food log.
 */
import type { FoodPatch, FoodTargetsBody } from '@jantar/protocol';
import type { PersonFoodBody } from '@jantar/protocol/people';
import { ApiError } from '../../errors.js';
import { lifeValue, needActor, type Call, type RouteTable } from '../../route-kit.js';
import type { ApiServices } from '../../services.js';
import { her } from './account.js';

type Id = { id: string };
const OK = { ok: true as const };

function food(s: ApiServices) {
  const f = s.deps.life.people.food;
  if (!f) throw new ApiError('unavailable', 'Life is not open right now. Try again in a moment.');
  return f;
}

export const PERSON_FOOD_ROUTE_IMPLS: RouteTable = {
  personFoodDay: {
    handle: (c: Call<Record<string, string>, { day?: string }>, s) => lifeValue(food(s).herDay(her(c.auth).personId, c.query.day)),
  },
  personFoodAdd: {
    handle: (c: Call<Record<string, string>, unknown, PersonFoodBody>, s) => lifeValue(food(s).herAdd(her(c.auth).personId, c.body, needActor(c.auth))),
  },
  personFoodUpdate: {
    handle: (c: Call<Id, unknown, FoodPatch>, s) => (lifeValue(food(s).herUpdate(her(c.auth).personId, c.params.id, c.body, needActor(c.auth))), OK),
  },
  personFoodDelete: {
    handle: (c: Call<Id>, s) => (lifeValue(food(s).herDelete(her(c.auth).personId, c.params.id, needActor(c.auth))), OK),
  },
  personFoodTargets: {
    handle: (c: Call<Record<string, string>, unknown, FoodTargetsBody>, s) => (lifeValue(food(s).herTargets(her(c.auth).personId, c.body, needActor(c.auth))), OK),
  },
};
