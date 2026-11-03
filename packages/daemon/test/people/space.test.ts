/**
 * v0.12 People (P1): her to-dos, reminders and weights, as each side reads
 * and writes them (spec 3.3, 3.5, 8.2, 8.4).
 *
 * - M5: his reads × the agreement: an area that is off is the unknown-pid
 *   404 (Today shows a locked tile), an allowed read writes one view mark
 *   per area per hour, a refused one none, and narrowing applies before
 *   the next read.
 * - M6: his writes × assign, editHers and authorship; weight is correct-
 *   or-delete only, never create (D22); a paused person holds his writes;
 *   a body carrying `by`, `space` or an author is a 400 (strict schemas).
 * - The assigned-item rules (spec 3.3): her 409 `assigned`, ack and ask on
 *   his items only, no snooze when he said so, skip with a reason, "Edited
 *   by" and Activity with old and new values when he edits hers.
 * - M3 / T5: Bea never reaches a row of Asha's, nor the reverse; his own
 *   /v1/todos never lists hers, nor hers his.
 * - T10 / M21: his view of each area deep-equals her mirror of it, for
 *   every built area at each level, active and paused.
 * - Her reminder rings her devices only, with a /p URL (C4: the system
 *   sweep reads her space).
 * - T14: no owner route can mark her items done, snooze, skip, ack or log
 *   a weight for her.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonActivityResponse, PersonTodo } from '@jantar/protocol/people';
import { PEOPLE_ROUTES } from '@jantar/protocol/people';
import { OWNER_HOST, OWNER_ORIGIN, credHeaders, makeFixture, onHer, type Cred, type Fixture } from './isolation-fixture.js';

let f: Fixture;
beforeEach(async () => {
  f = await makeFixture();
}, 60_000);
afterEach(async () => {
  await f?.close();
});

const him = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: object, cred: Cred = f.owner.control) =>
  f.api.tcp.inject({ method, url, headers: { host: OWNER_HOST, origin: OWNER_ORIGIN, ...credHeaders(cred) }, ...(payload ? { payload } : {}) });
const herCall = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: object, who: Cred = f.asha.full) => onHer(f.api, method, url, who, payload);

async function activity(): Promise<PersonActivityResponse> {
  return (await herCall('GET', '/v1/p/activity')).json() as PersonActivityResponse;
}

describe('her to-dos and his assign', () => {
  it('he assigns; she sees "From Sam" (by ""), can do it, ack it and ask, but not edit or delete it', async () => {
    const a = await him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'Call the bank', ask: 'ack', snoozable: false });
    expect(a.statusCode, a.body).toBe(201);
    const id = (a.json() as { id: string }).id;
    const list = (await herCall('GET', '/v1/p/todos')).json() as { todos: PersonTodo[] };
    expect(list.todos.find((t) => t.id === id)).toMatchObject({ title: 'Call the bank', by: '', ask: 'ack', snoozable: false });
    expect((await herCall('PATCH', `/v1/p/todos/${id}`, { title: 'Mine now' })).statusCode).toBe(409);
    expect((await herCall('DELETE', `/v1/p/todos/${id}`)).statusCode).toBe(409);
    expect((await herCall('POST', `/v1/p/todos/${id}/snooze`, { preset: '1h' })).statusCode).toBe(409);
    expect((await herCall('POST', `/v1/p/todos/${id}/ack`)).statusCode).toBe(200);
    expect((await herCall('POST', `/v1/p/todos/${id}/ask`, { note: 'Can we move it to Friday?' })).statusCode).toBe(200);
    const seen = (await him('GET', `/v1/people/${f.asha.id}/todos`)).json() as { todos: PersonTodo[] };
    expect(seen.todos.find((t) => t.id === id)).toMatchObject({ ackAt: expect.any(String), askedChange: { note: 'Can we move it to Friday?' } });
    expect((await herCall('POST', `/v1/p/todos/${id}/done`, { done: true, report: 'Done, all sorted' })).statusCode).toBe(200);
    const done = (await herCall('GET', '/v1/p/todos?done=1')).json() as { todos: PersonTodo[] };
    expect(done.todos.find((t) => t.id === id)).toMatchObject({ doneAt: expect.any(String), report: 'Done, all sorted' });
    const rows = (await activity()).activity;
    expect(rows.some((r) => r.action === 'todo.added' && r.title === 'Call the bank' && r.actor === 'owner')).toBe(true);
  });

  it('her own: she edits and deletes; he edits only with editHers.todos, marking "Edited by" with old and new values', async () => {
    const c = await herCall('POST', '/v1/p/todos', { title: 'Water the plants', due: { day: '2026-11-04' } });
    expect(c.statusCode, c.body).toBe(201);
    const id = (c.json() as { id: string }).id;
    expect((await herCall('PATCH', `/v1/p/todos/${id}`, { title: 'Water the ferns' })).statusCode).toBe(200);
    expect((await herCall('POST', `/v1/p/todos/${id}/ack`)).statusCode).toBe(409);
    const e = await him('PATCH', `/v1/people/${f.asha.id}/todos/${id}`, { due: { day: '2026-11-05' } });
    expect(e.statusCode, e.body).toBe(200);
    const t = ((await herCall('GET', '/v1/p/todos')).json() as { todos: PersonTodo[] }).todos.find((x) => x.id === id);
    expect(t).toMatchObject({ by: f.asha.id, editedBy: '', due: { day: '2026-11-05' } });
    const edit = (await activity()).activity.find((r) => r.action === 'todo.edited');
    expect(edit?.changes).toEqual([{ field: 'due', from: '{"day":"2026-11-04"}', to: '{"day":"2026-11-05"}' }]);
    // Without editHers.todos her rows are out of his reach (as if they didn't exist); his own stay his.
    await herCall('POST', '/v1/p/agreement/narrow', { editHers: { todos: false } });
    expect((await him('PATCH', `/v1/people/${f.asha.id}/todos/${id}`, { title: 'x' })).statusCode).toBe(404);
    expect((await him('DELETE', `/v1/people/${f.asha.id}/todos/${id}`)).statusCode).toBe(404);
    const mine = (await him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'Book the dentist' })).json() as { id: string };
    expect((await him('PATCH', `/v1/people/${f.asha.id}/todos/${mine.id}`, { title: 'Book the dentist (Tue)' })).statusCode).toBe(200);
    expect((await him('DELETE', `/v1/people/${f.asha.id}/todos/${mine.id}`)).statusCode).toBe(200);
    expect((await herCall('DELETE', `/v1/p/todos/${id}`)).statusCode).toBe(200);
  });

  it('skip with a reason leaves the open list and keeps the reason', async () => {
    const id = ((await him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'Gym' })).json() as { id: string }).id;
    expect((await herCall('POST', `/v1/p/todos/${id}/skip`, { reason: 'Not feeling well' })).statusCode).toBe(200);
    const open = ((await herCall('GET', '/v1/p/todos')).json() as { todos: PersonTodo[] }).todos;
    expect(open.find((t) => t.id === id)).toBeUndefined();
    const done = ((await herCall('GET', '/v1/p/todos?done=1')).json() as { todos: PersonTodo[] }).todos;
    expect(done.find((t) => t.id === id)?.skipped).toMatchObject({ reason: 'Not feeling well' });
  });

  it('paused holds his writes (409), not his reads; with assign off, his assign is 404', async () => {
    await herCall('POST', '/v1/p/pause', {});
    const r = await him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'Wait' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(/has paused/);
    expect((await him('GET', `/v1/people/${f.asha.id}/todos`)).statusCode).toBe(200);
    await herCall('POST', '/v1/p/resume', {});
    await herCall('POST', '/v1/p/agreement/narrow', { assign: { todos: false } });
    expect((await him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'Nope' })).statusCode).toBe(404);
  });

  it('bodies that name an author or a space are refused (strict schemas)', async () => {
    for (const extra of [{ by: '' }, { space: '' }, { by_person: 'x' }, { editedBy: '' }, { person: 'x' }]) {
      expect((await him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'T', ...extra })).statusCode, JSON.stringify(extra)).toBe(400);
      expect((await herCall('POST', '/v1/p/todos', { title: 'T', ...extra })).statusCode, JSON.stringify(extra)).toBe(400);
    }
  });
});

describe('M3 / T5: spaces stay apart', () => {
  it("Bea never reaches Asha's rows, nor the reverse; his own list holds neither; theirs hold none of his", async () => {
    const ashas = ((await herCall('POST', '/v1/p/todos', { title: 'CANARY-asha' })).json() as { id: string }).id;
    const beas = ((await herCall('POST', '/v1/p/todos', { title: 'CANARY-bea' }, f.bea.full)).json() as { id: string }).id;
    const his = ((await him('POST', '/v1/todos', { title: 'CANARY-sam' })).json() as { id: string }).id;
    for (const [who, other] of [
      [f.bea.full, ashas],
      [f.asha.full, beas],
      [f.asha.full, his],
    ] as const) {
      for (const [m, url, body] of [
        ['PATCH', `/v1/p/todos/${other}`, { title: 'x' }],
        ['DELETE', `/v1/p/todos/${other}`, undefined],
        ['POST', `/v1/p/todos/${other}/done`, { done: true }],
        ['POST', `/v1/p/todos/${other}/ack`, undefined],
      ] as const) {
        const r = await herCall(m, url, body, who);
        expect(r.statusCode, `${m} ${url}`).toBe(404);
      }
    }
    const asha = JSON.stringify((await herCall('GET', '/v1/p/todos')).json());
    const bea = JSON.stringify((await herCall('GET', '/v1/p/todos', undefined, f.bea.full)).json());
    const sam = JSON.stringify((await him('GET', '/v1/todos')).json());
    expect(asha).toContain('CANARY-asha');
    expect(asha).not.toMatch(/CANARY-bea|CANARY-sam/);
    expect(bea).not.toMatch(/CANARY-asha|CANARY-sam/);
    expect(sam).not.toMatch(/CANARY-asha|CANARY-bea/);
    // His view of Bea's space never holds Asha's rows, and a row of Asha's under Bea's pid is 404.
    expect((await him('PATCH', `/v1/people/${f.bea.id}/todos/${ashas}`, { title: 'x' })).statusCode).toBe(404);
  });
});

describe('M5: his reads × the agreement', () => {
  it('off is 404 (Today: a locked tile); allowed reads mark her record once an hour; refused ones mark nothing', async () => {
    await herCall('POST', '/v1/p/todos', { title: 'Something' });
    expect((await him('GET', `/v1/people/${f.asha.id}/todos`)).statusCode).toBe(200);
    expect((await him('GET', `/v1/people/${f.asha.id}/todos`)).statusCode).toBe(200);
    let marks = (await activity()).activity.filter((r) => r.action === 'view');
    expect(marks.map((r) => r.area)).toEqual(['todos']);
    f.api.ctx.clock.advance(3600_000);
    await him('GET', `/v1/people/${f.asha.id}/todos`);
    marks = (await activity()).activity.filter((r) => r.action === 'view');
    expect(marks).toHaveLength(2);
    await herCall('POST', '/v1/p/agreement/narrow', { see: { todos: false, weight: false } });
    const off = await him('GET', `/v1/people/${f.asha.id}/todos`);
    const unknown = await him('GET', `/v1/people/01JZZZZZZZZZZZZZZZZZZZZZZZ/todos`);
    expect([off.statusCode, off.body]).toEqual([unknown.statusCode, unknown.body]);
    expect((await him('GET', `/v1/people/${f.asha.id}/weights`)).statusCode).toBe(404);
    const today = (await him('GET', `/v1/people/${f.asha.id}/today`)).json();
    expect(today.todos).toEqual({ locked: true });
    expect(today.weight).toEqual({ locked: true });
    expect((await activity()).activity.filter((r) => r.action === 'view')).toHaveLength(3);
  });

  it('ending, left and forgotten people are the unknown-pid answer for every read', async () => {
    const unknown = await him('GET', `/v1/people/01JZZZZZZZZZZZZZZZZZZZZZZZ/today`);
    for (const pid of [f.dev.id, f.eli.id, f.fay.id, f.gus.id]) {
      for (const area of ['today', 'todos', 'weights']) {
        const r = await him('GET', `/v1/people/${pid}/${area}`);
        expect([r.statusCode, r.body], `${pid} ${area}`).toEqual([unknown.statusCode, unknown.body]);
      }
    }
  });
});

describe('weights (D22)', () => {
  it('she logs; he corrects or deletes only a day she logged, never creates one', async () => {
    expect((await herCall('PUT', '/v1/p/weights/2026-11-02', { kg: 61.4 })).statusCode).toBe(200);
    expect((await him('PATCH', `/v1/people/${f.asha.id}/weights/2026-11-03`, { kg: 60 })).statusCode).toBe(404);
    expect((await him('PATCH', `/v1/people/${f.asha.id}/weights/2026-11-02`, { kg: 61.2 })).statusCode).toBe(200);
    const w = (await him('GET', `/v1/people/${f.asha.id}/weights`)).json() as { latest: { kg: number } };
    expect(w.latest.kg).toBe(61.2);
    const row = (await activity()).activity.find((r) => r.action === 'weight.corrected');
    expect(row?.changes).toEqual([{ field: 'kg', from: '61.4', to: '61.2' }]);
    // There is no route of his that sets a weight for her (no PUT at all).
    expect((await him('PUT', `/v1/people/${f.asha.id}/weights/2026-11-03`, { kg: 60 })).statusCode).toBe(404);
    await herCall('POST', '/v1/p/agreement/narrow', { editHers: { weight: false } });
    expect((await him('DELETE', `/v1/people/${f.asha.id}/weights/2026-11-02`)).statusCode).toBe(404);
    // His own weights are apart from hers.
    expect(((await him('GET', '/v1/food')).json() as { weight: { recent: unknown[] } }).weight.recent).toEqual([]);
  });
});

describe('T10 / M21: his view equals her mirror', () => {
  it('for every built area at each level, active and paused', async () => {
    await herCall('POST', '/v1/p/todos', { title: 'Mirror me', due: { day: '2026-11-03', time: '23:00' } });
    await him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'From him' });
    await herCall('PUT', '/v1/p/weights/2026-11-03', { kg: 60.5 });
    const pairs = async () => {
      for (const [area, path] of [
        ['today', 'today'],
        ['todos', 'todos'],
        ['weight', 'weights'],
      ] as const) {
        const mirror = (await herCall('GET', `/v1/p/mirror/${area}`)).json() as object;
        const his = await him('GET', `/v1/people/${f.asha.id}/${path}`);
        if ('locked' in mirror && area !== 'today') expect(his.statusCode, area).toBe(404);
        else expect(his.json(), area).toEqual(mirror);
      }
    };
    await pairs();
    await herCall('POST', '/v1/p/pause', {});
    await pairs();
    await herCall('POST', '/v1/p/resume', {});
    await herCall('POST', '/v1/p/agreement/narrow', { see: { todos: false } });
    await pairs();
    await herCall('POST', '/v1/p/agreement/narrow', { see: { weight: false } });
    await pairs();
    // P3: her chat is an area now; with no Chat part on this fixture it reads locked on her mirror and 404 for him.
    expect((await herCall('GET', '/v1/p/mirror/chat')).statusCode).toBe(200);
    expect((await him('GET', `/v1/people/${f.asha.id}/chat`)).statusCode).toBe(404);
  });
});

describe('her reminder rings her devices', () => {
  it('a timed to-do of hers rings her push list only, with a /p URL', async () => {
    await onHer(f.api, 'POST', '/v1/p/push/subscribe', f.asha.full, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/asha', keys: { p256dh: 'p', auth: 'a' } } });
    await f.api.tcp.inject({
      method: 'POST',
      url: '/v1/push/subscribe',
      headers: { host: OWNER_HOST, origin: OWNER_ORIGIN, ...credHeaders(f.owner.control) },
      payload: { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/sam', keys: { p256dh: 'p', auth: 'a' } } },
    });
    const id = ((await herCall('POST', '/v1/p/todos', { title: 'Take the bins out', due: { day: '2026-11-03', time: '09:30' } })).json() as { id: string }).id;
    f.api.fakes.pushed.length = 0;
    f.api.ctx.clock.advance(31 * 60_000);
    await vi.waitFor(() => expect(f.api.fakes.pushed.some((p) => p.endpoint.endsWith('/asha'))).toBe(true), { timeout: 3000 });
    const mine = f.api.fakes.pushed.filter((p) => p.endpoint.endsWith('/asha')).map((p) => JSON.parse(p.payload) as { url: string; title: string });
    expect(mine[0]?.url).toBe(`/p/todos?id=${id}`);
    expect(f.api.fakes.pushed.some((p) => p.endpoint.endsWith('/sam'))).toBe(false);
  });
});

describe('T14: never in her name', () => {
  it('no owner route marks her items done, snoozes, skips, acks, asks or sets a weight for her', () => {
    const verbs = Object.values(PEOPLE_ROUTES).map((d) => `${d.method} ${d.path}`);
    for (const deny of [/\/done$/, /\/snooze$/, /\/skip$/, /\/ack$/, /\/ask$/, /\/doses/, /^PUT .*\/weights/, /^POST .*\/weights/, /\/pause$/, /\/resume$/, /\/agreement\/(accept|decline|narrow)$/, /\/status$/]) {
      expect(verbs.filter((v) => deny.test(v)), String(deny)).toEqual([]);
    }
  });
});
