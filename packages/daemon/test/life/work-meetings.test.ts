/**
 * v0.13 Work, P2 (W15): meetings linked to clients, in Work (work_log rows
 * with a meeting id); Work never reads meetings.db, Meetings tells it.
 *
 * - a meeting in a project with a client is linked to that client
 *   automatically (at its start), and the client's touch follows;
 * - linking twice is a no-op; he links and unlinks by hand; an automatic
 *   link he unlinked never comes back (not even at a resync);
 * - when the project gains a client, its meetings are linked in the same
 *   save; when its client changes the automatic rows move (his stay);
 * - a deleted meeting's links go; a deleted project's automatic links go;
 * - the resync repairs what a missed call left;
 * - suggestions: the names in the meeting, matched by name; a client made
 *   from one is marked `from: 'meeting'` and linked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, TodosModule, WorkMeetingRef, WorkModule } from '../../src/contracts.js';
import { createTestContext, createTestLifeCore, type TestLifeCore } from '../../src/core/testing.js';
import { LIFE_MODULE_BUILDERS } from '../../src/life/index.js';
import { meetingPeople } from '../../src/meetings/common.js';
import { makeFakes } from '../api/fakes.js';

const PHONE: Actor = { kind: 'device', deviceId: 'd1', scopes: ['read', 'control'] };
const M1 = '01JZZZZZZZZZZZZZZZZZZZZZM1';
const M2 = '01JZZZZZZZZZZZZZZZZZZZZZM2';

let core: TestLifeCore;
let todos: TodosModule;
let work: WorkModule;
/** What Meetings would answer: every meeting with a project. */
let meetings: WorkMeetingRef[];

beforeEach(() => {
  core = createTestLifeCore({ tz: 'UTC', settings: { todos: true, work: true } });
  core.clock.set('2026-11-03T09:00:00.000Z');
  const ctx = createTestContext({ clock: core.clock });
  const f = makeFakes(ctx);
  meetings = [];
  const d = { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy, meetings: () => meetings.filter((m) => m.projectId !== null) };
  todos = LIFE_MODULE_BUILDERS.todos(core, d);
  work = LIFE_MODULE_BUILDERS.work(core, d, todos);
});
afterEach(() => core.close());

function ok<T>(r: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}
const client = (name: string) => ok(work.createClient({ name, kind: 'company' }, PHONE)).id;
const rows = () => core.db.prepare('SELECT meeting_id AS m, contact_id AS c, project_id AS p, json FROM work_log WHERE meeting_id IS NOT NULL ORDER BY meeting_id, contact_id').all() as { m: string; c: string; p: string | null; json: string }[];
const linked = (id: string) => ok(work.client(id, PHONE)).log.filter((r) => r.kind === 'meeting').map((r) => [r.meetingId, r.auto === true]);
/** A meeting given a project, as Meetings tells Work. */
function assign(id: string, projectId: string | null, startedAt = '2026-11-02T10:00:00.000Z'): void {
  meetings = [...meetings.filter((m) => m.id !== id), { id, projectId, startedAt }];
  work.meetingProject({ id, projectId, startedAt });
}

describe('W15: a meeting in a client project is linked to that client', () => {
  it('automatically, at its start; the touch follows; twice is a no-op', () => {
    const acme = client('Acme Studio');
    const p = ok(todos.createProject({ name: 'Site', clientId: acme }, PHONE)).id;
    assign(M1, p);
    assign(M1, p);
    expect(linked(acme)).toEqual([[M1, true]]);
    expect(ok(work.client(acme, PHONE)).contact.lastTouchAt).toBe('2026-11-02T10:00:00.000Z');
    expect(rows()).toHaveLength(1);
    // A project with no client links nothing; moving the meeting there unlinks it.
    const other = ok(todos.createProject({ name: 'Internal' }, PHONE)).id;
    assign(M1, other);
    expect(linked(acme)).toEqual([]);
    expect(ok(work.client(acme, PHONE)).contact.lastTouchAt).toBeUndefined();
  });

  it('he links and unlinks by hand; an automatic link he unlinked never comes back', () => {
    const acme = client('Acme Studio');
    const globex = client('Globex');
    const p = ok(todos.createProject({ name: 'Site', clientId: acme }, PHONE)).id;
    assign(M1, p);
    ok(work.setMeetingClients({ id: M1, projectId: p, startedAt: '2026-11-02T10:00:00.000Z' }, [globex], PHONE));
    expect(linked(acme)).toEqual([]);
    expect(linked(globex)).toEqual([[M1, false]]);
    // The resync and a new assignment leave his ruling as it is.
    work.resyncMeetings(meetings);
    assign(M1, p);
    expect(linked(acme)).toEqual([]);
    // Linking it again by hand makes it his.
    ok(work.setMeetingClients({ id: M1, projectId: p, startedAt: '2026-11-02T10:00:00.000Z' }, [acme, globex], PHONE));
    expect(linked(acme)).toEqual([[M1, false]]);
    expect(work.setMeetingClients({ id: M1, projectId: p, startedAt: 'x' }, ['01JZZZZZZZZZZZZZZZZZZZZZZX'], PHONE)).toMatchObject({ ok: false, reason: "That client doesn't exist any more." });
  });

  it("a project gaining a client links its meetings in the same save; a change of client moves only the automatic rows", () => {
    const acme = client('Acme Studio');
    const globex = client('Globex');
    const p = ok(todos.createProject({ name: 'Site' }, PHONE)).id;
    assign(M1, p);
    assign(M2, p, '2026-11-01T10:00:00.000Z');
    expect(rows()).toEqual([]);
    ok(todos.updateProject(p, { clientId: acme }, PHONE));
    expect(linked(acme).sort()).toEqual([
      [M1, true],
      [M2, true],
    ]);
    // He links Initech to M2 by hand (the meeting page sends the whole set: Acme stays automatic), then the
    // project moves to Globex: the automatic rows move, his stays.
    const initech = client('Initech');
    ok(work.setMeetingClients({ id: M2, projectId: p, startedAt: '2026-11-01T10:00:00.000Z' }, [acme, initech], PHONE));
    ok(todos.updateProject(p, { clientId: globex }, PHONE));
    expect(linked(globex).sort()).toEqual([
      [M1, true],
      [M2, true],
    ]);
    expect(linked(acme)).toEqual([]);
    expect(linked(initech)).toEqual([[M2, false]]);
    ok(todos.updateProject(p, { clientId: null }, PHONE));
    expect(linked(globex)).toEqual([]);
    expect(linked(initech)).toEqual([[M2, false]]);
  });

  it("a deleted meeting's links go; a deleted project's automatic links go, his stay", () => {
    const acme = client('Acme Studio');
    const p = ok(todos.createProject({ name: 'Site', clientId: acme }, PHONE)).id;
    assign(M1, p);
    assign(M2, p);
    work.forgetMeeting(M1);
    expect(linked(acme)).toEqual([[M2, true]]);
    const globex = client('Globex');
    ok(work.setMeetingClients({ id: M2, projectId: p, startedAt: '2026-11-02T10:00:00.000Z' }, [acme, globex], PHONE));
    ok(todos.removeProject(p, PHONE));
    // Acme's link came from the project: it goes; Globex's is his: it stays, with no project.
    expect(rows().map((r) => [r.m, r.c === globex ? 'globex' : 'other', r.p])).toEqual([[M2, 'globex', null]]);
  });

  it('the resync repairs a missed link and drops one whose meeting lost its project', () => {
    const acme = client('Acme Studio');
    const p = ok(todos.createProject({ name: 'Site', clientId: acme }, PHONE)).id;
    meetings = [{ id: M1, projectId: p, startedAt: '2026-11-02T10:00:00.000Z' }];
    expect(linked(acme)).toEqual([]);
    work.resyncMeetings(meetings);
    expect(linked(acme)).toEqual([[M1, true]]);
    work.resyncMeetings([]);
    expect(linked(acme)).toEqual([]);
  });
});

describe('suggestions from a meeting', () => {
  it("splits a meeting's people", () => {
    expect(meetingPeople('Riya Sharma, Sam Lee and Priya; Dev & Ops')).toEqual(['Riya Sharma', 'Sam Lee', 'Priya', 'Dev', 'Ops']);
    expect(meetingPeople(undefined)).toEqual([]);
  });

  it("names its people, matched by name; the project's client; what is linked now", () => {
    const acme = client('Acme Studio');
    const riya = ok(work.createClient({ name: 'Riya Sharma' }, PHONE)).id;
    const p = ok(todos.createProject({ name: 'Site', clientId: acme }, PHONE)).id;
    assign(M1, p);
    const s = ok(work.meetingSuggest({ id: M1, projectId: p, startedAt: '2026-11-02T10:00:00.000Z', people: ['Dr. Riya Sharma', 'Sam Lee'] }, PHONE));
    expect(s).toEqual({
      linked: [{ id: acme, name: 'Acme Studio', auto: true }],
      auto: { id: acme, name: 'Acme Studio' },
      people: [
        { index: 0, text: 'Dr. Riya Sharma', match: { id: riya, name: 'Riya Sharma' } },
        { index: 1, text: 'Sam Lee' },
      ],
    });
  });

  it("a client made from a meeting's name is marked as the meeting's words and linked", () => {
    const m = { id: M1, projectId: null, startedAt: '2026-11-02T10:00:00.000Z', people: ['Sam Lee'] };
    const made = ok(work.meetingClientNew(m, { person: 0 }, PHONE));
    const h = ok(work.client(made.id, PHONE));
    expect(h.contact).toMatchObject({ name: 'Sam Lee', from: 'meeting', state: 'lead' });
    expect(h.log.map((r) => [r.kind, r.meetingId])).toEqual([['meeting', M1]]);
    expect(work.meetingClientNew(m, { person: 3 }, PHONE)).toMatchObject({ ok: false, reason: 'That meeting has no such name.' });
  });
});
