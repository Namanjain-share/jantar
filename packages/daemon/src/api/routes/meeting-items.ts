/**
 * A meeting's summary and action items on the phone (spec 4.9, 4.10), each
 * a call on `s.deps.meetings.summaries` (meetings/summary.ts):
 * meetingSummarize (Summarize, or Try again: the summary is queued and the
 * reply is `{ ok }`; refused under --read-only by the pipeline),
 * meetingItemTodo (the reply is the new todo's id; 403 while Todos are off,
 * 409 "Already in todos.") and meetingItemUntodo (a todo already gone is
 * fine). Device routes only, never on ctl.sock.
 *
 * The pipeline has already checked control scope, the Meetings switch and a
 * broken meetings.db, parsed `:id` and `:n`, and counted every write against
 * s.lifeWriteLimiter. `lifeValue` turns the module's answer into the value
 * or the API error with its fixed sentence; writes audit the meeting's id
 * and nothing else (`lifeAudit`).
 */
import type { MeetingItemParams } from '@jantar/protocol';
import type { MeetingsResult } from '../../contracts.js';
import { lifeAudit, lifeValue, needActor, type Call, type RouteTable } from '../route-kit.js';

type Id = { id: string };

/** A write that answers `{ ok: true }`: the module's refusal as the API error, else ok. */
function okOf(r: MeetingsResult): { ok: true } {
  lifeValue(r);
  return { ok: true };
}

export const MEETING_ITEMS_ROUTE_IMPLS: RouteTable = {
  meetingSummarize: {
    handle: (c: Call<Id>, s) => okOf(s.deps.meetings.summaries.request(c.params.id, needActor(c.auth))),
    audit: lifeAudit,
  },
  meetingItemTodo: {
    handle: (c: Call<MeetingItemParams>, s) => lifeValue(s.deps.meetings.summaries.addTodo(c.params.id, c.params.n, needActor(c.auth))),
    audit: lifeAudit,
  },
  meetingItemUntodo: {
    handle: (c: Call<MeetingItemParams>, s) => okOf(s.deps.meetings.summaries.removeTodo(c.params.id, c.params.n, needActor(c.auth))),
    audit: lifeAudit,
  },
};
