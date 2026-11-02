/**
 * v0.12 People: the owner's reads and writes in her space (spec 9.3.4),
 * every one through the agreement. A read goes through `ownerViewOf`, the
 * one read path into her space, which writes a view mark; an area that is
 * off, a person he can't reach and a row he may not see all answer the one
 * not_found (only Today shows a locked tile). His writes follow the rules in
 * life/people/space.ts (assign, editHers, paused, never in her name).
 */
import type { TodosQuery, WeightBody } from '@jantar/protocol';
import type { AssignTodoBody, AssignTodoPatch } from '@jantar/protocol/people';
import { ApiError } from '../errors.js';
import { lifeValue, needActor, type Call, type RouteTable } from '../route-kit.js';
import type { ApiServices } from '../services.js';
import { NO_PERSON } from './people.js';

type Pid = { pid: string };
type PidId = { pid: string; id: string };
type PidDay = { pid: string; day: string };
const OK = { ok: true as const };

function services(s: ApiServices) {
  const { space, views } = s.deps.life.people;
  if (!space || !views) throw new ApiError('unavailable', 'Life is not open right now. Try again in a moment.');
  return { space, views };
}

/** His read of one area: the view, or the unknown-pid answer (off areas too, but Today's tiles). */
function read(s: ApiServices, pid: string, area: 'today' | 'todos' | 'weight', opts: { day?: string; done?: boolean } = {}) {
  const v = services(s).views.ownerViewOf(pid, area, opts);
  if (v === null || (area !== 'today' && 'locked' in v)) throw new ApiError('not_found', NO_PERSON);
  return v;
}

export const PEOPLE_LIFE_ROUTE_IMPLS: RouteTable = {
  personOwnerToday: {
    handle: (c: Call<Pid, { day?: string }>, s) => read(s, c.params.pid, 'today', c.query.day ? { day: c.query.day } : {}),
  },
  personOwnerTodos: {
    handle: (c: Call<Pid, TodosQuery>, s) => read(s, c.params.pid, 'todos', { done: c.query.done }),
  },
  personAssign: {
    handle: (c: Call<Pid, unknown, AssignTodoBody>, s) => lifeValue(services(s).space.assign(c.params.pid, c.body, needActor(c.auth))),
    audit: (_c, out) => ({ target: (out.body as { id?: string } | null)?.id }),
  },
  personOwnerTodoUpdate: {
    handle: (c: Call<PidId, unknown, AssignTodoPatch>, s) => (lifeValue(services(s).space.ownerUpdate(c.params.pid, c.params.id, c.body, needActor(c.auth))), OK),
    audit: (c: Call<PidId>) => ({ target: c.params.id }),
  },
  personOwnerTodoDelete: {
    handle: (c: Call<PidId>, s) => (lifeValue(services(s).space.ownerDelete(c.params.pid, c.params.id, needActor(c.auth))), OK),
    audit: (c: Call<PidId>) => ({ target: c.params.id }),
  },
  personOwnerWeights: {
    handle: (c: Call<Pid>, s) => read(s, c.params.pid, 'weight'),
  },
  personOwnerWeightUpdate: {
    handle: (c: Call<PidDay, unknown, WeightBody>, s) => (lifeValue(services(s).space.ownerWeightCorrect(c.params.pid, c.params.day, c.body)), OK),
    audit: (c: Call<PidDay>) => ({ target: c.params.day }),
  },
  personOwnerWeightDelete: {
    handle: (c: Call<PidDay>, s) => (lifeValue(services(s).space.ownerWeightDelete(c.params.pid, c.params.day)), OK),
    audit: (c: Call<PidDay>) => ({ target: c.params.day }),
  },
};
