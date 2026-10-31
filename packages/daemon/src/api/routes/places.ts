/**
 * Cafés (feature `places`, WP-FF). Device routes only, never on ctl.sock.
 * Each calls `s.deps.life.places` (life/places/module.ts).
 *
 * The pipeline has already checked control scope, the switch and a broken
 * life.db, validated the strict bodies and counted every write against
 * s.lifeWriteLimiter. Write replies carry ids only (`lifeValue` turns a
 * LifeResult into the value or the API error); writes audit their target id
 * and nothing else (`lifeAudit`).
 */
import type { PlaceBody, PlacePatch, PlacesQuery } from '@jantar/protocol';
import type { LifeResult } from '../../contracts.js';
import { lifeAudit, lifeValue, needActor, type Call, type RouteTable } from '../route-kit.js';

type Id = { id: string };

/** A write that answers `{ ok: true }`: the module's refusal as the API error, else ok. */
function okOf(r: LifeResult): { ok: true } {
  lifeValue(r);
  return { ok: true };
}

export const PLACES_ROUTE_IMPLS: RouteTable = {
  placesList: {
    handle: (c: Call<unknown, PlacesQuery>, s) => lifeValue(s.deps.life.places.list(c.query.filter)),
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
};
