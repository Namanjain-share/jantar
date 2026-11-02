/**
 * Cafés (feature `places`, WP-FF). Device routes, except that v0.10's
 * reads (the list and one café) are on ctl.sock too, for `jantar place`;
 * every write stays the phone's. Each calls `s.deps.life.places`
 * (life/places/module.ts).
 *
 * The pipeline has already checked control scope, the switch and a broken
 * life.db, validated the strict bodies and counted every write against
 * s.lifeWriteLimiter. Write replies carry ids only (`lifeValue` turns a
 * LifeResult into the value or the API error); writes audit their target id
 * and nothing else (`lifeAudit`).
 */
import type { PlaceBody, PlaceGetQuery, PlacePatch, PlaceVisitBody, PlaceVisitPatch, PlacesQuery } from '@jantar/protocol';
import type { LifeResult } from '../../contracts.js';
import { lifeAudit, lifeValue, needActor, type Call, type RouteTable } from '../route-kit.js';

type Id = { id: string };
type VisitIds = { id: string; visitId: string };

/** A write that answers `{ ok: true }`: the module's refusal as the API error, else ok. */
function okOf(r: LifeResult): { ok: true } {
  lifeValue(r);
  return { ok: true };
}

export const PLACES_ROUTE_IMPLS: RouteTable = {
  placesList: {
    handle: (c: Call<unknown, PlacesQuery>, s) => lifeValue(s.deps.life.places.list(c.query)),
  },
  placeGet: {
    handle: (c: Call<Id, PlaceGetQuery>, s) => lifeValue(s.deps.life.places.get(c.params.id, c.query.before)),
  },
  placeCreate: {
    handle: (c: Call<unknown, unknown, PlaceBody>, s) => lifeValue(s.deps.life.places.create(c.body, needActor(c.auth))),
    audit: lifeAudit,
  },
  placeUpdate: {
    handle: (c: Call<Id, unknown, PlacePatch>, s) => okOf(s.deps.life.places.update(c.params.id, c.body, needActor(c.auth))),
    audit: lifeAudit,
  },
  placeDelete: {
    handle: (c: Call<Id>, s) => okOf(s.deps.life.places.remove(c.params.id, needActor(c.auth))),
    audit: lifeAudit,
  },
  // v0.10: a café's visits. The audit row's target is the café's id.
  placeVisitAdd: {
    handle: (c: Call<Id, unknown, PlaceVisitBody>, s) => lifeValue(s.deps.life.places.visitAdd(c.params.id, c.body, needActor(c.auth))),
    audit: lifeAudit,
  },
  placeVisitUpdate: {
    handle: (c: Call<VisitIds, unknown, PlaceVisitPatch>, s) => okOf(s.deps.life.places.visitUpdate(c.params.id, c.params.visitId, c.body, needActor(c.auth))),
    audit: lifeAudit,
  },
  placeVisitDelete: {
    handle: (c: Call<VisitIds>, s) => okOf(s.deps.life.places.visitRemove(c.params.id, c.params.visitId, needActor(c.auth))),
    audit: lifeAudit,
  },
};
