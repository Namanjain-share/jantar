/**
 * Action items to todos (spec 4.10; MS8; WP-SU) and the three phone routes
 * of api/routes/meeting-items.ts:
 *
 * - Auto: after a done summary, only with the toggle on, Todos on and the
 *   meeting's project still in Life: one todo per item, in order, as the
 *   system, each id kept on its item; a refused create stops the rest
 *   quietly and the summary is still done.
 * - Add (a tap): the meeting's project when it is still there, the device
 *   as actor, `{ id }` of the todo; a second Add is 409 "Already in todos.";
 *   with Todos off 403 with the Todos sentence.
 * - Remove: deletes the todo (one already gone is fine) and clears todoId.
 * - MP3's phone-edit part: a tap is one event, Life's own.
 * - An item is text: a title that reads as a command or markup is stored
 *   as it is, and nothing but the one claude run is started.
 * - The routes: Summarize, Add and Remove over the pipeline, their replies,
 *   errors and audit rows (the meeting's id only), never on ctl.sock; 503
 *   with meetings.db closed meanwhile.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEETING_MARKER, MEETING_T0, transcriptLines } from '@jantar/fixtures';
import type { ActionItem, MeetingSummary, ProjectView } from '@jantar/protocol';
import type { Actor, MeetingSummaries, MeetingsService, TodosModule } from '../../src/contracts.js';
import { SYSTEM_ACTOR } from '../../src/core/actor.js';
import { FakeClock } from '../../src/core/clock.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { TEST_BINS, createFakeExec, createTestMeetingsCore, type ExecCall, type TestMeetingsCore } from '../../src/core/testing.js';
import { ITEM_SENTENCES, MEETINGS_CLOSED, NO_MEETING, SUMMARY_SENTENCES, TODOS_OFF, buildSummaries } from '../../src/meetings/summary.js';
import { HOST, h, makeApi, pairCookie, type TestApi } from '../api/fakes.js';
import { V05_ON } from '../api/v05-helpers.js';

const PHONE: Actor = { kind: 'device', deviceId: 'dev-phone', scopes: ['read', 'control'] };
const NOW = '2026-10-30T11:00:00.000Z';
const EXT = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const PROJECT = '01JFZ8X8Y3T0V5G9WQK2M4N6PS';
const GONE = '01JFZ8X8Y3T0V5G9WQK2M4N6PT';
const NOTES = 'From the meeting "Weekly sync" on Fri 30 Oct 2026.';
const WAIT = { timeout: 15_000, interval: 10 };

const CLAUDE_JSON = (result: string) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, session_id: 'synthetic', usage: { input_tokens: 10, output_tokens: 10 } });
const ANSWER = {
  summary: 'The team moved the launch to Friday.',
  decisions: ['Launch moves to Friday.'],
  actionItems: [{ title: 'Send the revised quote', owner: 'Sam' }, { title: 'Book the review room', owner: 'You' }, { title: 'Update the site copy' }],
};

let core: TestMeetingsCore | undefined;
let summaries: MeetingSummaries | undefined;
let api: TestApi | undefined;
const temps: string[] = [];
afterEach(async () => {
  summaries?.stop();
  summaries = undefined;
  await api?.close();
  api = undefined;
  core?.close();
  core = undefined;
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(id: string, name: string): ProjectView {
  return { id, name, status: 'active', createdAt: NOW, updatedAt: NOW, open: 0, overdue: 0 };
}

/** The summaries over the fake todos module, on a fake exec whose claude runs wait for `answer` (stop() ends them). */
function rig(opts: { todos?: boolean; projects?: ProjectView[] } = {}) {
  const state = mkdtempSync(join(tmpdir(), 'jantar-summary-items-'));
  temps.push(state);
  const held: { call: ExecCall; answer(stdout: string): void }[] = [];
  const exec = createFakeExec((call) => {
    if (call.file !== TEST_BINS.claude) return undefined;
    return new Promise((resolve) => {
      call.opts.signal?.addEventListener('abort', () => resolve({ code: null, signal: 'SIGTERM' }), { once: true });
      held.push({ call, answer: (stdout) => resolve({ stdout }) });
    });
  });
  core = createTestMeetingsCore({
    clock: new FakeClock(NOW),
    settings: { life: { todos: opts.todos ?? true } },
    projects: opts.projects ?? [project(PROJECT, 'Acme site')],
    ctx: { home: state, exec, accountsMode: 'single' },
  });
  summaries = buildSummaries(core);
  return { core, summaries, held, exec };
}

/** An ended meeting with 20 lines; its id. */
function meeting(c: TestMeetingsCore, opts: { projectId?: string | null; autoTodos?: boolean; summary?: MeetingSummary; name?: string } = {}): string {
  const id = c.newId();
  const start = new Date(MEETING_T0).toISOString();
  c.meetings.create({
    id,
    extId: EXT,
    clientId: randomUUID(),
    startedAt: start,
    endedAt: new Date(MEETING_T0 + 3_600_000).toISOString(),
    lastAt: start,
    projectId: opts.projectId === undefined ? PROJECT : opts.projectId,
    record: {
      name: opts.name ?? 'Weekly sync',
      site: 'meet',
      autoTodos: opts.autoTodos ?? false,
      notes: true,
      summary: opts.summary ?? { state: 'none', decisions: [], items: [] },
    },
  });
  c.meetings.upsertLines(id, transcriptLines(20));
  return id;
}

/** A done summary with these items. */
const done = (items: ActionItem[]): MeetingSummary => ({ state: 'done', text: 'The team moved the launch to Friday.', decisions: [], items, at: NOW });
const ITEMS: ActionItem[] = [{ title: 'Send the revised quote', owner: 'Sam' }, { title: 'Book the review room' }];

const itemsOf = (c: TestMeetingsCore, id: string) => c.meetings.get(id)?.record.summary.items;

/** Life's todos tick on every write that goes through (`life.changed {}`, the meetings' own event): counted with core.ticks here. */
function lifeTicks(c: TestMeetingsCore): void {
  const todos = c.life.todos as TodosModule;
  const { createTodo, removeTodo } = todos;
  todos.createTodo = (body, actor) => {
    const r = createTodo(body, actor);
    if (r.ok) c.changed();
    return r;
  };
  todos.removeTodo = (todoId, actor) => {
    const r = removeTodo(todoId, actor);
    if (r.ok) c.changed();
    return r;
  };
}

/** The summaries over `c` with meetings.db open while `open()` says so (the shell closes it when Meetings turn off). */
const gated = (c: TestMeetingsCore, open: () => boolean) => buildSummaries(Object.assign(Object.create(c) as TestMeetingsCore, { store: () => (open() ? c.meetings : null) }));

/** Run one summary through the queue with ANSWER; the record once it is done. */
async function summarize(r: ReturnType<typeof rig>, id: string) {
  r.summaries.enqueue(id);
  await vi.waitFor(() => expect(r.held.length).toBeGreaterThan(0), WAIT);
  r.held.at(-1)!.answer(CLAUDE_JSON(JSON.stringify(ANSWER)));
  await vi.waitFor(() => expect(r.core.meetings.get(id)?.record.summary.state).toBe('done'), WAIT);
  return r.core.meetings.get(id)!.record.summary;
}

describe('an action item is text, never something run', () => {
  it('a title that is a shell line, a jantar command or HTML is kept as that exact todo title; the one process is the claude run', async () => {
    const r = rig();
    const id = meeting(r.core, { autoTodos: true });
    const titles = ['`touch pwned` && echo $(id) > out.txt', 'jantar meetings unpair', '<img src=x onerror="alert(1)"> & </meeting>'];
    r.summaries.enqueue(id);
    await vi.waitFor(() => expect(r.held.length).toBe(1), WAIT);
    r.held[0]!.answer(CLAUDE_JSON(JSON.stringify({ summary: 'Hostile titles.', decisions: titles, actionItems: titles.map((title) => ({ title })) })));
    await vi.waitFor(() => expect(r.core.meetings.get(id)?.record.summary.state).toBe('done'), WAIT);
    expect(r.core.todos.created.map((c) => c.body.title)).toEqual(titles);
    expect(itemsOf(r.core, id)?.map((i) => i.title)).toEqual(titles);
    expect(r.exec.calls.map((c) => c.file)).toEqual([TEST_BINS.claude]);
  });
});

describe('MS8: action items go to todos by themselves only with the toggle on, Todos on and the project still there', () => {
  it('one todo per item, in order, as the system, each id kept on its item; one tick for the done summary', async () => {
    const r = rig();
    const id = meeting(r.core, { autoTodos: true });
    const summary = await summarize(r, id);
    expect(r.core.todos.created.map((c) => [c.body, c.actor])).toEqual(
      ANSWER.actionItems.map((i) => [{ title: i.title, projectId: PROJECT, notes: NOTES }, SYSTEM_ACTOR]),
    );
    expect(summary.items).toEqual(ANSWER.actionItems.map((i, n) => ({ ...i, todoId: r.core.todos.created[n]!.id })));
    expect(r.core.ticks).toBe(3); // queued, running, done
  });

  it.each([
    ['the toggle is off', { autoTodos: false }, {}],
    ['Todos are off', { autoTodos: true }, { todos: false }],
    ['the project was deleted', { autoTodos: true, projectId: GONE }, {}],
    ['the meeting has no project', { autoTodos: true, projectId: null }, {}],
  ] as const)('none when %s; the summary is still done with every item to add by hand', async (_why, m, o) => {
    const r = rig(o);
    const id = meeting(r.core, m);
    const summary = await summarize(r, id);
    expect(r.core.todos.created).toEqual([]);
    expect(summary.items).toEqual(ANSWER.actionItems);
  });

  it('a refused create (a cap, Life closed) stops the rest quietly: the first keeps its todo, the others stay for a tap', async () => {
    const r = rig();
    const todos = r.core.life.todos as TodosModule;
    const create = todos.createTodo;
    let n = 0;
    todos.createTodo = (body, actor) => (++n === 2 ? { ok: false, code: 'conflict', reason: 'You have 1,000 open todos. Finish or delete one to add another.' } : create(body, actor));
    const id = meeting(r.core, { autoTodos: true });
    const summary = await summarize(r, id);
    expect(summary.state).toBe('done');
    expect(r.core.todos.created).toHaveLength(1);
    expect(summary.items).toEqual([{ ...ANSWER.actionItems[0], todoId: r.core.todos.created[0]!.id }, ANSWER.actionItems[1], ANSWER.actionItems[2]]);
    expect(n).toBe(2);
    expect(r.core.ctx.log.records.find((l) => l.msg === 'meetings: action items stopped going to todos')?.fields).toMatchObject({ code: 'conflict', added: 1 });
  });

  it('a Life that throws never blocks the summary', async () => {
    const r = rig();
    (r.core.life.todos as TodosModule).createTodo = () => {
      throw new Error('life.db went away');
    };
    const id = meeting(r.core, { autoTodos: true });
    const summary = await summarize(r, id);
    expect(summary).toMatchObject({ state: 'done', items: ANSWER.actionItems });
  });
});

describe('MS8: Add and Remove', () => {
  it("Add makes a todo in the meeting project as the device, keeps its id, and the tap is one event (Life's); a second Add is 409", () => {
    const { core, summaries } = rig();
    lifeTicks(core);
    const id = meeting(core, { summary: done(ITEMS) });
    const added = summaries.addTodo(id, 0, PHONE);
    expect(added).toEqual({ ok: true, value: { id: core.todos.created[0]!.id } });
    expect(core.todos.created.map((c) => [c.body, c.actor])).toEqual([[{ title: 'Send the revised quote', projectId: PROJECT, notes: NOTES }, PHONE]]);
    expect(itemsOf(core, id)).toEqual([{ ...ITEMS[0], todoId: core.todos.created[0]!.id }, ITEMS[1]]);
    expect(core.ticks).toBe(1);
    expect(summaries.addTodo(id, 0, PHONE)).toEqual({ ok: false, code: 'conflict', reason: ITEM_SENTENCES.already });
    expect(core.todos.created).toHaveLength(1);
    expect(core.ticks).toBe(1);
  });

  it('with the project gone (or none) the todo has no project', () => {
    const { core, summaries } = rig();
    const gone = meeting(core, { projectId: GONE, summary: done(ITEMS) });
    const none = meeting(core, { projectId: null, summary: done(ITEMS) });
    expect(summaries.addTodo(gone, 1, PHONE).ok).toBe(true);
    expect(summaries.addTodo(none, 1, PHONE).ok).toBe(true);
    expect(core.todos.created.map((c) => c.body)).toEqual([
      { title: 'Book the review room', notes: NOTES },
      { title: 'Book the review room', notes: NOTES },
    ]);
  });

  it('Remove deletes the todo as the device and clears todoId, one event a tap; a second Remove is fine and calls nothing', () => {
    const { core, summaries } = rig();
    lifeTicks(core);
    const id = meeting(core, { summary: done(ITEMS) });
    const { id: todoId } = (summaries.addTodo(id, 0, PHONE) as { ok: true; value: { id: string } }).value;
    expect(summaries.removeTodo(id, 0, PHONE)).toEqual({ ok: true, value: true });
    expect(core.todos.removed).toEqual([{ id: todoId, actor: PHONE }]);
    expect(itemsOf(core, id)).toEqual(ITEMS);
    expect(core.ticks).toBe(2);
    expect(summaries.removeTodo(id, 0, PHONE)).toEqual({ ok: true, value: true });
    expect(core.todos.removed).toHaveLength(1);
    expect(core.ticks).toBe(2);
    // Removed, it can be added again.
    expect(summaries.addTodo(id, 0, PHONE).ok).toBe(true);
  });

  it('a todo already deleted in Todos counts as removed (Life wrote nothing, so the meeting ticks); Life not answering keeps the id', () => {
    const { core, summaries } = rig();
    const todos = core.life.todos as TodosModule;
    const id = meeting(core, { summary: done([{ ...ITEMS[0]!, todoId: GONE }, { ...ITEMS[1]!, todoId: PROJECT }]) });
    todos.removeTodo = () => ({ ok: false, code: 'not_found', reason: 'No such todo.' });
    expect(summaries.removeTodo(id, 0, PHONE)).toEqual({ ok: true, value: true });
    expect(itemsOf(core, id)?.[0]).toEqual(ITEMS[0]);
    expect(core.ticks).toBe(1);
    todos.removeTodo = () => ({ ok: false, code: 'unavailable', reason: 'Life is not open right now. Try again in a moment.' });
    expect(summaries.removeTodo(id, 1, PHONE)).toEqual({ ok: false, code: 'unavailable', reason: 'Life is not open right now. Try again in a moment.' });
    expect(itemsOf(core, id)?.[1]).toEqual({ ...ITEMS[1], todoId: PROJECT });
    expect(core.ticks).toBe(1);
  });

  it('with Todos off Add and Remove are 403 with the Todos sentence, and nothing is called', () => {
    const { core, summaries } = rig({ todos: false });
    const id = meeting(core, { summary: done([ITEMS[0]!, { ...ITEMS[1]!, todoId: GONE }]) });
    expect(summaries.addTodo(id, 0, PHONE)).toEqual({ ok: false, code: 'forbidden', reason: TODOS_OFF });
    expect(summaries.removeTodo(id, 1, PHONE)).toEqual({ ok: false, code: 'forbidden', reason: TODOS_OFF });
    expect([core.todos.created, core.todos.removed]).toEqual([[], []]);
    expect(TODOS_OFF).toBe('Todos are off. Turn them on at your Mac: jantar life on todos');
  });

  it('a refused create (a cap) is passed on and changes nothing', () => {
    const { core, summaries } = rig();
    const id = meeting(core, { summary: done(ITEMS) });
    core.todos.createFails = { ok: false, code: 'conflict', reason: 'You have 1,000 open todos. Finish or delete one to add another.' };
    expect(summaries.addTodo(id, 0, PHONE)).toEqual(core.todos.createFails);
    expect(itemsOf(core, id)).toEqual(ITEMS);
    expect(core.ticks).toBe(0);
  });

  it('an unknown meeting, an item past the list or a summary not done is 404', () => {
    const { core, summaries } = rig();
    const id = meeting(core, { summary: done(ITEMS) });
    const failed = meeting(core, { summary: { state: 'failed', reason: SUMMARY_SENTENCES.failed, decisions: [], items: [] } });
    expect(summaries.addTodo(core.newId(), 0, PHONE)).toEqual({ ok: false, code: 'not_found', reason: NO_MEETING });
    expect(summaries.addTodo(id, 2, PHONE)).toEqual({ ok: false, code: 'not_found', reason: ITEM_SENTENCES.noItem });
    expect(summaries.addTodo(failed, 0, PHONE)).toEqual({ ok: false, code: 'not_found', reason: ITEM_SENTENCES.noItem });
    expect(summaries.removeTodo(id, 29, PHONE)).toEqual({ ok: false, code: 'not_found', reason: ITEM_SENTENCES.noItem });
    expect(core.todos.created).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The routes

/** The API with a meetings part whose summaries are the real ones over `rig()`'s core (meetings.db open while `open()` says so); a control device's cookie. */
async function itemsApi(opts: { todos?: boolean; open?: () => boolean } = {}) {
  const r = rig(opts);
  const s = opts.open ? gated(r.core, opts.open) : r.summaries;
  const meetings = notBuilt<MeetingsService>('Meetings', { start: async () => {}, stop: async () => {}, broken: () => null, summaries: s });
  api = await makeApi({ ctx: { settings: V05_ON }, deps: () => ({ meetings }) });
  const { cookie } = await pairCookie(api, ['read', 'control']);
  const call = (method: 'POST' | 'DELETE', url: string) => (api as TestApi).tcp.inject({ method, url, headers: h(cookie) });
  return { ...r, api, cookie, call };
}

describe('the routes', () => {
  it('Summarize queues and answers { ok }; a second is 409 while it is written', async () => {
    const { core, call, held } = await itemsApi();
    const id = meeting(core, { name: `Weekly sync ${MEETING_MARKER}` });
    const res = await call('POST', `/v1/meetings/${id}/summary`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(held).toHaveLength(1), WAIT);
    const again = await call('POST', `/v1/meetings/${id}/summary`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toEqual({ code: 'conflict', message: SUMMARY_SENTENCES.busy });
    const missing = await call('POST', `/v1/meetings/${core.newId()}/summary`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toEqual({ code: 'not_found', message: NO_MEETING });
  });

  it("Add answers the todo's id and 409 the second time; Remove answers { ok }; writes audit the meeting's id only", async () => {
    const { core, call, api } = await itemsApi();
    const id = meeting(core, { summary: done([{ title: `Send the quote ${MEETING_MARKER}` }]) });
    const add = await call('POST', `/v1/meetings/${id}/items/0/todo`);
    expect(add.statusCode).toBe(200);
    expect(add.json()).toEqual({ id: core.todos.created[0]!.id });
    const again = await call('POST', `/v1/meetings/${id}/items/0/todo`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toEqual({ code: 'conflict', message: ITEM_SENTENCES.already });
    const remove = await call('DELETE', `/v1/meetings/${id}/items/0/todo`);
    expect(remove.statusCode).toBe(200);
    expect(remove.json()).toEqual({ ok: true });
    expect(core.todos.removed.map((x) => x.id)).toEqual([core.todos.created[0]!.id]);
    const past = await call('DELETE', `/v1/meetings/${id}/items/1/todo`);
    expect(past.statusCode).toBe(404);
    expect(past.json().error).toEqual({ code: 'not_found', message: ITEM_SENTENCES.noItem });

    const rows = api.ctx.db.audit.list().filter((a) => a.action === 'meetingItemTodo' || a.action === 'meetingItemUntodo');
    // A device's refusals are audited too, by the same target.
    expect(rows.map((a) => [a.action, a.target, a.result, a.params])).toEqual([
      ['meetingItemTodo', id, 'ok', {}],
      ['meetingItemTodo', id, 'refused', {}],
      ['meetingItemUntodo', id, 'ok', {}],
      ['meetingItemUntodo', id, 'refused', {}],
    ]);
    expect(JSON.stringify([api.ctx.db.audit.list(), api.ctx.log.records, add.json(), remove.json()])).not.toContain(MEETING_MARKER);
  });

  it('Add with Todos off is 403 with the Todos sentence', async () => {
    const { core, call } = await itemsApi({ todos: false });
    const id = meeting(core, { summary: done(ITEMS) });
    const res = await call('POST', `/v1/meetings/${id}/items/0/todo`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toEqual({ code: 'forbidden', message: TODOS_OFF });
    expect(core.todos.created).toEqual([]);
  });

  it('meetings.db closed meanwhile: the three are 503 with the sentence and call nothing; a Life that throws on Add is the 500', async () => {
    let open = true;
    const { core, call } = await itemsApi({ open: () => open });
    const id = meeting(core, { summary: done([ITEMS[0]!, { ...ITEMS[1]!, todoId: GONE }]) });
    (core.life.todos as TodosModule).createTodo = () => {
      throw new Error('life.db went away');
    };
    // Life's own write routes answer a throw the same way; nothing is linked.
    expect((await call('POST', `/v1/meetings/${id}/items/0/todo`)).statusCode).toBe(500);
    expect(itemsOf(core, id)?.[0]).toEqual(ITEMS[0]);

    open = false;
    for (const [method, url] of [
      ['POST', `/v1/meetings/${id}/summary`],
      ['POST', `/v1/meetings/${id}/items/0/todo`],
      ['DELETE', `/v1/meetings/${id}/items/1/todo`],
    ] as const) {
      const res = await call(method, url);
      expect(res.statusCode, `${method} ${url}`).toBe(503);
      expect(res.json().error).toEqual({ code: 'unavailable', message: MEETINGS_CLOSED });
    }
    expect([core.todos.removed, core.ticks]).toEqual([[], 0]);
    expect(core.meetings.get(id)?.record.summary.state).toBe('done');
  });

  it('an item number past 29 is refused before the module; none of the three is served on ctl.sock', async () => {
    const { core, call, api } = await itemsApi();
    const id = meeting(core, { summary: done(ITEMS) });
    expect((await call('POST', `/v1/meetings/${id}/items/30/todo`)).statusCode).toBe(400);
    for (const [method, url] of [
      ['POST', `/v1/meetings/${id}/summary`],
      ['POST', `/v1/meetings/${id}/items/0/todo`],
      ['DELETE', `/v1/meetings/${id}/items/0/todo`],
    ] as const) {
      expect((await api.ctl.inject({ method, url, headers: { host: HOST } })).statusCode, `${method} ${url}`).toBe(404);
    }
    expect(core.todos.created).toEqual([]);
  });
});
