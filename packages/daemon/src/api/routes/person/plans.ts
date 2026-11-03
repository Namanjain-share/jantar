/**
 * v0.12 People (P2): her day plan, evening review and status (scope
 * `person`), thin handlers over life/plans and life/people with her as the
 * caller. Every call works in her own space; `by` is daemon-set.
 */
import type {
  PersonStatusBody,
  ReviewSendBody,
  SharingCheckinBody,
  StepBody,
  StepCheckinBody,
  StepPatch,
  StepStateBody,
} from '@jantar/protocol/people';
import { ApiError } from '../../errors.js';
import { actorName } from '../../request.js';
import { lifeValue, type Call, type RouteTable } from '../../route-kit.js';
import type { ApiServices } from '../../services.js';
import { her } from './account.js';

type Day = { day: string };
type Step = { day: string; stepId: string };
const OK = { ok: true as const };

function plans(s: ApiServices) {
  const p = s.deps.life.people.plans;
  if (!p || !s.deps.life.people.openCore()) throw new ApiError('unavailable', 'Life is not open right now. Try again in a moment.');
  return p;
}

export const PERSON_PLAN_ROUTE_IMPLS: RouteTable = {
  personStatus: {
    handle: (c: Call<Record<string, string>, unknown, PersonStatusBody>, s) => lifeValue(s.deps.life.people.setStatus(her(c.auth).personId, c.body)),
  },
  personSharingCheckin: {
    handle: (c: Call<Record<string, string>, unknown, SharingCheckinBody>, s) => (lifeValue(s.deps.life.people.sharingCheckin(her(c.auth).personId, c.body, actorName(c.auth))), OK),
  },
  personPlanGet: {
    handle: (c: Call<Day>, s) => plans(s).herView(her(c.auth).personId, c.params.day),
  },
  personPlanAck: {
    handle: (c: Call<Day>, s) => (lifeValue(plans(s).ack(her(c.auth).personId, c.params.day)), OK),
  },
  personStepAdd: {
    handle: (c: Call<Day, unknown, StepBody>, s) => lifeValue(plans(s).addStep(her(c.auth).personId, c.params.day, c.body)),
  },
  personStepUpdate: {
    handle: (c: Call<Step, unknown, StepPatch>, s) => (lifeValue(plans(s).updateStep(her(c.auth).personId, c.params.day, c.params.stepId, c.body)), OK),
  },
  personStepDelete: {
    handle: (c: Call<Step>, s) => (lifeValue(plans(s).deleteStep(her(c.auth).personId, c.params.day, c.params.stepId)), OK),
  },
  personStepState: {
    handle: (c: Call<Step, unknown, StepStateBody>, s) => (lifeValue(plans(s).setState(her(c.auth).personId, c.params.day, c.params.stepId, c.body)), OK),
  },
  personStepAck: {
    handle: (c: Call<Step>, s) => (lifeValue(plans(s).ackStep(her(c.auth).personId, c.params.day, c.params.stepId)), OK),
  },
  personStepCheckin: {
    handle: (c: Call<Step, unknown, StepCheckinBody>, s) => (lifeValue(plans(s).checkin(her(c.auth).personId, c.params.day, c.params.stepId, c.body)), OK),
  },
  personStepAsk: {
    handle: (c: Call<Step, unknown, { note: string }>, s) => (lifeValue(plans(s).ask(her(c.auth).personId, c.params.day, c.params.stepId, c.body.note)), OK),
  },
  personStepCarry: {
    handle: (c: Call<Step, unknown, { to: string }>, s) => (lifeValue(plans(s).carry(her(c.auth).personId, c.params.day, c.params.stepId, c.body.to)), OK),
  },
  personBetweenTick: {
    handle: (c: Call<{ day: string; bid: string }, unknown, { slot: string; done: boolean }>, s) =>
      (lifeValue(plans(s).tick(her(c.auth).personId, c.params.day, c.params.bid, c.body.slot, c.body.done)), OK),
  },
  personRoughDay: {
    handle: (c: Call<Day, unknown, { note?: string }>, s) => (lifeValue(plans(s).rough(her(c.auth).personId, c.params.day, c.body.note)), OK),
  },
  personRoughDayUndo: {
    handle: (c: Call<Day>, s) => (lifeValue(plans(s).roughUndo(her(c.auth).personId, c.params.day)), OK),
  },
  personReviewGet: {
    handle: (c: Call<Day>, s) => plans(s).reviewView(her(c.auth).personId, c.params.day, 'full', { todos: true }),
  },
  personReviewSend: {
    handle: (c: Call<Day, unknown, ReviewSendBody>, s) => (lifeValue(plans(s).reviewSend(her(c.auth).personId, c.params.day, c.body)), OK),
  },
};
