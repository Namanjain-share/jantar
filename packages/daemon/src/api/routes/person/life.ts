/**
 * v0.11 People: her to-dos, reminders, projects, medicines and doses,
 * weights, Today and mirror (scope `person`), thin handlers over
 * life/people/space.ts, meds.ts and views.ts with her as the caller. Every
 * call works in her own space only; `space` and `by` are daemon-set (no body
 * carries them: strict schemas).
 */
import type { DoseBody, MedicineBody, MedicinePatch, ProjectBody, ProjectPatch, SnoozeBody, TodoBody, TodoPatch, TodosQuery, WeightBody } from '@jantar/protocol';
import type { Area, PersonTodoDoneBody } from '@jantar/protocol/people';
import { ApiError } from '../../errors.js';
import { lifeValue, needActor, type Call, type RouteTable } from '../../route-kit.js';
import type { ApiServices } from '../../services.js';
import { her } from './account.js';

type Id = { id: string };
const OK = { ok: true as const };

function space(s: ApiServices) {
  const sp = s.deps.life.people.space;
  if (!sp) throw new ApiError('unavailable', 'Life is not open right now. Try again in a moment.');
  return sp;
}

function meds(s: ApiServices) {
  const m = s.deps.life.people.meds;
  if (!m) throw new ApiError('unavailable', 'Life is not open right now. Try again in a moment.');
  return m;
}

function views(s: ApiServices) {
  const v = s.deps.life.people.views;
  if (!v) throw new ApiError('unavailable', 'Life is not open right now. Try again in a moment.');
  return v;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function todos(c: Call<any, any, any>, s: ApiServices) {
  return s.deps.life.todos.inSpace(her(c.auth).personId);
}

export const PERSON_LIFE_ROUTE_IMPLS: RouteTable = {
  personToday: {
    handle: (c: Call<Record<string, string>, { day?: string }>, s) => views(s).herToday(her(c.auth).personId, c.query.day),
  },
  personMirror: {
    handle: (c: Call<{ area: Area }, { day?: string }>, s) => {
      const v = views(s).mirror(her(c.auth).personId, c.params.area, { day: c.query.day });
      if (v === null) throw new ApiError('not_found', 'not found');
      return v;
    },
  },
  personTodos: {
    handle: (c: Call<Record<string, string>, TodosQuery>, s) => lifeValue(space(s).herList(her(c.auth).personId, c.query)),
  },
  personTodoCreate: {
    handle: (c: Call<Record<string, string>, unknown, TodoBody>, s) => lifeValue(space(s).herCreate(her(c.auth).personId, c.body, needActor(c.auth))),
  },
  personTodoUpdate: {
    handle: (c: Call<Id, unknown, TodoPatch>, s) => (lifeValue(space(s).herUpdate(her(c.auth).personId, c.params.id, c.body, needActor(c.auth))), OK),
  },
  personTodoDelete: {
    handle: (c: Call<Id>, s) => (lifeValue(space(s).herDelete(her(c.auth).personId, c.params.id, needActor(c.auth))), OK),
  },
  personTodoDone: {
    handle: (c: Call<Id, unknown, PersonTodoDoneBody>, s) => (lifeValue(space(s).herDone(her(c.auth).personId, c.params.id, c.body.done, c.body.report, needActor(c.auth))), OK),
  },
  personTodoSnooze: {
    handle: (c: Call<Id, unknown, SnoozeBody>, s) => (lifeValue(space(s).herSnooze(her(c.auth).personId, c.params.id, c.body.preset, needActor(c.auth))), OK),
  },
  personTodoSkip: {
    handle: (c: Call<Id, unknown, { reason?: string }>, s) => (lifeValue(space(s).herSkip(her(c.auth).personId, c.params.id, c.body.reason, needActor(c.auth))), OK),
  },
  personTodoAck: {
    handle: (c: Call<Id>, s) => (lifeValue(space(s).herAck(her(c.auth).personId, c.params.id)), OK),
  },
  personTodoAsk: {
    handle: (c: Call<Id, unknown, { note: string }>, s) => (lifeValue(space(s).herAsk(her(c.auth).personId, c.params.id, c.body.note)), OK),
  },
  personProjects: {
    handle: (c: Call, s) => lifeValue(todos(c, s).listProjects()),
  },
  personProjectCreate: {
    handle: (c: Call<Record<string, string>, unknown, ProjectBody>, s) => lifeValue(space(s).herProjectCreate(her(c.auth).personId, c.body, needActor(c.auth))),
  },
  personProjectUpdate: {
    handle: (c: Call<Id, unknown, ProjectPatch>, s) => (lifeValue(space(s).herProjectUpdate(her(c.auth).personId, c.params.id, c.body, needActor(c.auth))), OK),
  },
  personProjectDelete: {
    handle: (c: Call<Id>, s) => (lifeValue(space(s).herProjectDelete(her(c.auth).personId, c.params.id, needActor(c.auth))), OK),
  },
  // Her medicines and doses (spec 3.4): any of hers, his additions included; only she logs doses.
  personMeds: {
    handle: (c: Call<Record<string, string>, { day?: string }>, s) => lifeValue(meds(s).herList(her(c.auth).personId, c.query.day)),
  },
  personMedCreate: {
    handle: (c: Call<Record<string, string>, unknown, MedicineBody>, s) => lifeValue(meds(s).herCreate(her(c.auth).personId, c.body, needActor(c.auth))),
  },
  personMedUpdate: {
    handle: (c: Call<Id, unknown, MedicinePatch>, s) => (lifeValue(meds(s).herUpdate(her(c.auth).personId, c.params.id, c.body, needActor(c.auth))), OK),
  },
  personMedStop: {
    handle: (c: Call<Id>, s) => (lifeValue(meds(s).herStop(her(c.auth).personId, c.params.id, needActor(c.auth))), OK),
  },
  personDoseLog: {
    handle: (c: Call<Id, unknown, DoseBody>, s) => lifeValue(meds(s).herDoseLog(her(c.auth).personId, c.params.id, c.body, needActor(c.auth))),
  },
  personDoseDelete: {
    handle: (c: Call<{ id: string; doseId: string }>, s) => (lifeValue(meds(s).herDoseUndo(her(c.auth).personId, c.params.id, c.params.doseId, needActor(c.auth))), OK),
  },
  personWeights: {
    handle: (c: Call, s) => space(s).weights(her(c.auth).personId),
  },
  personWeightSet: {
    handle: (c: Call<{ day: string }, unknown, WeightBody>, s) => (lifeValue(space(s).herWeightSet(her(c.auth).personId, c.params.day, c.body)), OK),
  },
  personWeightDelete: {
    handle: (c: Call<{ day: string }>, s) => (lifeValue(space(s).herWeightDelete(her(c.auth).personId, c.params.day)), OK),
  },
};
