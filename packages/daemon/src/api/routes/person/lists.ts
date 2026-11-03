/**
 * v0.11 People (P4, spec 5.2, 5.3): her shared cafés and lists (scope
 * `person`), thin handlers over the Places module in her shared space
 * (`places.inShared(space, pid)`) and life/lists. She reads and writes her
 * own shared space only; `space` and `by` are daemon-set. Shared lists are
 * both people's: no agreement area gates them.
 */
import type { PlaceBody, PlaceGetQuery, PlacePatch, PlaceVisitBody, PlaceVisitPatch, PlacesQuery } from '@jantar/protocol';
import type { SharedItemBody, SharedItemPatch, SharedListKind } from '@jantar/protocol/people';
import { ApiError } from '../../errors.js';
import { lifeValue, needActor, type Call, type RouteTable } from '../../route-kit.js';
import type { ApiServices } from '../../services.js';
import { her } from './account.js';

const OK = { ok: true as const };
const CLOSED = 'Life is not open right now. Try again in a moment.';
type Id = { id: string };
type Visit = { id: string; visitId: string };
type Item = { id: string; itemId: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mine(c: Call<any, any, any>, s: ApiServices): { pid: string; space: string } {
  const pid = her(c.auth).personId;
  const space = s.deps.life.people.person(pid)?.sharedSpace;
  if (!space) throw new ApiError('not_found', 'not found');
  return { pid, space };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function places(c: Call<any, any, any>, s: ApiServices) {
  const { pid, space } = mine(c, s);
  return s.deps.life.places.inShared(space, pid);
}

function lists(s: ApiServices) {
  const l = s.deps.life.people.lists;
  if (!l) throw new ApiError('unavailable', CLOSED);
  return l;
}

export const PERSON_LIST_ROUTE_IMPLS: RouteTable = {
  personPlaces: {
    handle: (c: Call<Record<string, string>, PlacesQuery>, s) => lifeValue(places(c, s).list(c.query)),
  },
  personPlaceGet: {
    handle: (c: Call<Id, PlaceGetQuery>, s) => lifeValue(places(c, s).get(c.params.id, c.query?.before)),
  },
  personPlaceCreate: {
    handle: (c: Call<Record<string, string>, unknown, PlaceBody>, s) => lifeValue(places(c, s).create(c.body, needActor(c.auth))),
  },
  personPlaceUpdate: {
    handle: (c: Call<Id, unknown, PlacePatch>, s) => (lifeValue(places(c, s).update(c.params.id, c.body, needActor(c.auth))), OK),
  },
  personPlaceDelete: {
    handle: (c: Call<Id>, s) => (lifeValue(places(c, s).remove(c.params.id, needActor(c.auth))), OK),
  },
  personVisitCreate: {
    handle: (c: Call<Id, unknown, PlaceVisitBody>, s) => lifeValue(places(c, s).visitAdd(c.params.id, c.body, needActor(c.auth))),
  },
  personVisitUpdate: {
    handle: (c: Call<Visit, unknown, PlaceVisitPatch>, s) => (lifeValue(places(c, s).visitUpdate(c.params.id, c.params.visitId, c.body, needActor(c.auth))), OK),
  },
  personVisitDelete: {
    handle: (c: Call<Visit>, s) => (lifeValue(places(c, s).visitRemove(c.params.id, c.params.visitId, needActor(c.auth))), OK),
  },
  personLists: {
    handle: (c: Call, s) => lifeValue(lists(s).lists(mine(c, s).space)),
  },
  personListCreate: {
    handle: (c: Call<Record<string, string>, unknown, { name: string; kind: SharedListKind }>, s) => {
      const m = mine(c, s);
      return lifeValue(lists(s).createList(m.space, m.pid, c.body));
    },
  },
  personListUpdate: {
    handle: (c: Call<Id, unknown, { name: string }>, s) => {
      const m = mine(c, s);
      return (lifeValue(lists(s).renameList(m.space, m.pid, c.params.id, c.body.name)), OK);
    },
  },
  personListDelete: {
    handle: (c: Call<Id>, s) => {
      const m = mine(c, s);
      return (lifeValue(lists(s).deleteList(m.space, m.pid, c.params.id)), OK);
    },
  },
  personListItems: {
    handle: (c: Call<Id>, s) => lifeValue(lists(s).items(mine(c, s).space, c.params.id)),
  },
  personListItemAdd: {
    handle: (c: Call<Id, unknown, SharedItemBody>, s) => {
      const m = mine(c, s);
      return lifeValue(lists(s).addItem(m.space, m.pid, c.params.id, c.body));
    },
  },
  personListItemUpdate: {
    handle: (c: Call<Item, unknown, SharedItemPatch>, s) => {
      const m = mine(c, s);
      return (lifeValue(lists(s).updateItem(m.space, m.pid, c.params.id, c.params.itemId, c.body)), OK);
    },
  },
  personListItemDelete: {
    handle: (c: Call<Item>, s) => {
      const m = mine(c, s);
      return (lifeValue(lists(s).deleteItem(m.space, m.pid, c.params.id, c.params.itemId)), OK);
    },
  },
  personListItemTick: {
    handle: (c: Call<Item, unknown, { done: boolean }>, s) => {
      const m = mine(c, s);
      return (lifeValue(lists(s).tick(m.space, m.pid, c.params.id, c.params.itemId, c.body.done)), OK);
    },
  },
};
