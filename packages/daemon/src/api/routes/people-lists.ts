/**
 * v0.11 People (P4, spec 5.3): the lists he shares with her, through his
 * People routes (life/lists over her shared space), and "Assign to {her}":
 * an assigned to-do in her space with the item's title (assign.todos; it
 * arrives "From {owner}" and applies at once), the item marked handed. No
 * link between the two rows (C6). A person he can't reach answers the one
 * not_found.
 */
import type { SharedItemBody, SharedItemPatch, SharedListKind } from '@jantar/protocol/people';
import { ApiError } from '../errors.js';
import { lifeValue, needActor, type Call, type RouteTable } from '../route-kit.js';
import type { ApiServices } from '../services.js';
import { NO_PERSON } from './people.js';

const OK = { ok: true as const };
type Pid = { pid: string };
type PidId = { pid: string; id: string };
type PidItem = { pid: string; id: string; itemId: string };

/** Her shared space, while he can reach her (active or paused). */
function spaceOf(s: ApiServices, pid: string): string {
  const people = s.deps.life.people;
  const reach = people.ownerReach(pid);
  const space = people.person(pid)?.sharedSpace;
  if ((reach !== 'active' && reach !== 'paused') || !space) throw new ApiError('not_found', NO_PERSON);
  return space;
}

function lists(s: ApiServices) {
  const l = s.deps.life.people.lists;
  if (!l) throw new ApiError('unavailable', 'Life is not open right now. Try again in a moment.');
  return l;
}

export const PEOPLE_LIST_ROUTE_IMPLS: RouteTable = {
  personOwnerLists: {
    handle: (c: Call<Pid>, s) => lifeValue(lists(s).lists(spaceOf(s, c.params.pid))),
  },
  personOwnerListCreate: {
    handle: (c: Call<Pid, unknown, { name: string; kind: SharedListKind }>, s) => lifeValue(lists(s).createList(spaceOf(s, c.params.pid), '', c.body)),
    audit: (_c, out) => ({ target: (out.body as { id?: string } | null)?.id ?? 'list', params: {} }),
  },
  personOwnerListUpdate: {
    handle: (c: Call<PidId, unknown, { name: string }>, s) => (lifeValue(lists(s).renameList(spaceOf(s, c.params.pid), '', c.params.id, c.body.name)), OK),
    audit: (c: Call<PidId>) => ({ target: c.params.id }),
  },
  personOwnerListDelete: {
    handle: (c: Call<PidId>, s) => (lifeValue(lists(s).deleteList(spaceOf(s, c.params.pid), '', c.params.id)), OK),
    audit: (c: Call<PidId>) => ({ target: c.params.id }),
  },
  personOwnerListItems: {
    handle: (c: Call<PidId>, s) => lifeValue(lists(s).items(spaceOf(s, c.params.pid), c.params.id)),
  },
  personOwnerListItemAdd: {
    handle: (c: Call<PidId, unknown, SharedItemBody>, s) => lifeValue(lists(s).addItem(spaceOf(s, c.params.pid), '', c.params.id, c.body)),
    audit: (_c, out) => ({ target: (out.body as { id?: string } | null)?.id ?? 'item', params: {} }),
  },
  personOwnerListItemUpdate: {
    handle: (c: Call<PidItem, unknown, SharedItemPatch>, s) => (lifeValue(lists(s).updateItem(spaceOf(s, c.params.pid), '', c.params.id, c.params.itemId, c.body)), OK),
    audit: (c: Call<PidItem>) => ({ target: c.params.itemId }),
  },
  personOwnerListItemDelete: {
    handle: (c: Call<PidItem>, s) => (lifeValue(lists(s).deleteItem(spaceOf(s, c.params.pid), '', c.params.id, c.params.itemId)), OK),
    audit: (c: Call<PidItem>) => ({ target: c.params.itemId }),
  },
  personOwnerListItemTick: {
    handle: (c: Call<PidItem, unknown, { done: boolean }>, s) => (lifeValue(lists(s).tick(spaceOf(s, c.params.pid), '', c.params.id, c.params.itemId, c.body.done)), OK),
    audit: (c: Call<PidItem>) => ({ target: c.params.itemId }),
  },
  personOwnerListItemAssign: {
    handle: (c: Call<PidItem>, s) => {
      const { pid, id, itemId } = c.params;
      const space = spaceOf(s, pid);
      const l = lists(s);
      const found = lifeValue(l.items(space, id)).items.find((x) => x.id === itemId);
      if (!found) throw new ApiError('not_found', 'That item is gone.');
      const sp = s.deps.life.people.space;
      if (!sp) throw new ApiError('unavailable', 'Life is not open right now. Try again in a moment.');
      // Her to-do first (assign.todos, her pause and caps apply), then the item is marked handed.
      const made = lifeValue(sp.assign(pid, { title: found.title.slice(0, 200), ...(found.notes ? { notes: found.notes } : {}) }, needActor(c.auth)));
      lifeValue(l.handOn(space, id, itemId, pid));
      return made;
    },
    audit: (c: Call<PidItem>) => ({ target: c.params.itemId }),
  },
};
