/**
 * v0.11 People: her projects (spec 1.3.1 `/p/todos?tab=projects`, 3.3), on
 * the isolation fixture (Sam; Asha on Everything; Bea on Standard).
 *
 * - Hers to make, rename, archive and bring back, or delete (its to-dos stay,
 *   with no project); a project groups her to-dos (`?project=`). She can't
 *   link one to a folder on his Mac.
 * - C6 / isolation: no row points across spaces. Her to-do can't name his
 *   project or Bea's; his Assign can't name his own project or Bea's; her
 *   credential never reaches his projects, Bea's never Asha's.
 * - His view at his to-dos level: her projects with their counts on his To-do
 *   tab while see.todos is on, the unknown-pid 404 when she turns it off; her
 *   mirror deep-equals it.
 * - His Assign into one of her projects (assign.todos) and his move of a
 *   to-do of hers between them (editHers.todos): her Activity names the
 *   project, never an id.
 * - M11: her project writes tick his screens only while he sees her to-dos.
 * - T11: her export holds her projects.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectView } from '@jantar/protocol';
import type { OwnerTodosView, PersonActivityResponse, PersonTodo } from '@jantar/protocol/people';
import { DAY, OWNER_HOST, OWNER_ORIGIN, credHeaders, makeFixture, onHer, type Cred, type Fixture } from './isolation-fixture.js';

let f: Fixture;
beforeEach(async () => {
  f = await makeFixture();
}, 60_000);
afterEach(async () => {
  await f?.close();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
const him = (method: Method, url: string, payload?: object, cred: Cred = f.owner.control) =>
  f.api.tcp.inject({ method, url, headers: { host: OWNER_HOST, origin: OWNER_ORIGIN, ...credHeaders(cred) }, ...(payload ? { payload } : {}) });
const herCall = (method: Method, url: string, payload?: object, who: Cred = f.asha.full) => onHer(f.api, method, url, who, payload);
const idOf = (r: { json(): unknown }) => (r.json() as { id: string }).id;
const herProjects = async (who: Cred = f.asha.full) => ((await herCall('GET', '/v1/p/projects', undefined, who)).json() as { projects: ProjectView[] }).projects;
const herTodos = async (q = '', who: Cred = f.asha.full) => ((await herCall('GET', `/v1/p/todos${q}`, undefined, who)).json() as { todos: PersonTodo[] }).todos;
const activity = async () => ((await herCall('GET', '/v1/p/activity')).json() as PersonActivityResponse).activity;

describe('her projects', () => {
  it('she makes, renames, archives and brings back a project; it groups her to-dos; deleting it keeps them', async () => {
    const garden = idOf(await herCall('POST', '/v1/p/projects', { name: 'Garden', emoji: '🌱' }));
    const study = idOf(await herCall('POST', '/v1/p/projects', { name: 'Study' }));
    const seeds = await herCall('POST', '/v1/p/todos', { title: 'Buy seeds', projectId: garden });
    expect(seeds.statusCode, seeds.body).toBe(201);
    await herCall('POST', '/v1/p/todos', { title: 'Read chapter 3', projectId: study, due: { day: DAY } });
    await herCall('POST', '/v1/p/todos', { title: 'Call the bank' });
    expect((await herTodos(`?project=${garden}`)).map((t) => t.title)).toEqual(['Buy seeds']);
    expect((await herTodos('?project=none')).map((t) => t.title)).toEqual(['Call the bank']);
    expect((await herProjects()).map((p) => [p.name, p.open])).toEqual([
      ['Garden', 1],
      ['Study', 1],
    ]);
    // Rename and archive ("done"), then bring it back; an archived project sorts after the active ones.
    expect((await herCall('PATCH', `/v1/p/projects/${garden}`, { name: 'Balcony garden' })).statusCode).toBe(200);
    expect((await herCall('PATCH', `/v1/p/projects/${garden}`, { status: 'done' })).statusCode).toBe(200);
    expect((await herProjects()).map((p) => [p.name, p.status])).toEqual([
      ['Study', 'active'],
      ['Balcony garden', 'done'],
    ]);
    expect((await herCall('PATCH', `/v1/p/projects/${garden}`, { status: 'active' })).statusCode).toBe(200);
    // Move a to-do of hers to another project of hers, then out of any.
    expect((await herCall('PATCH', `/v1/p/todos/${idOf(seeds)}`, { projectId: study })).statusCode).toBe(200);
    expect((await herTodos(`?project=${study}`)).map((t) => t.title).sort()).toEqual(['Buy seeds', 'Read chapter 3']);
    expect((await herCall('PATCH', `/v1/p/todos/${idOf(seeds)}`, { projectId: null })).statusCode).toBe(200);
    // Delete: the project goes, its to-dos stay with no project.
    expect((await herCall('DELETE', `/v1/p/projects/${study}`)).statusCode).toBe(200);
    expect((await herProjects()).map((p) => p.name)).toEqual(['Balcony garden']);
    const left = await herTodos();
    expect(left.find((t) => t.title === 'Read chapter 3')?.projectId).toBeUndefined();
    // Her own project writes are hers: no Activity row (C8).
    expect((await activity()).filter((r) => r.area === 'todos')).toEqual([]);
  });

  it('a body naming a folder, an author or a space is refused', async () => {
    for (const extra of [{ folder: '/opt/garden' }, { by: '' }, { space: '' }]) {
      expect((await herCall('POST', '/v1/p/projects', { name: 'X', ...extra })).statusCode, JSON.stringify(extra)).toBe(400);
    }
    const id = idOf(await herCall('POST', '/v1/p/projects', { name: 'Mine' }));
    expect((await herCall('PATCH', `/v1/p/projects/${id}`, { folder: '/opt' })).statusCode).toBe(400);
  });
});

describe('C6 and isolation: no row points across spaces', () => {
  it("her to-do can't name his project or Bea's; his and Bea's projects are out of her reach", async () => {
    const his = idOf(await him('POST', '/v1/projects', { name: 'His launch' }));
    const beas = idOf(await herCall('POST', '/v1/p/projects', { name: "Bea's" }, f.bea.full));
    for (const projectId of [his, beas]) {
      const r = await herCall('POST', '/v1/p/todos', { title: 'Sneak in', projectId });
      expect(r.statusCode, r.body).toBe(400);
      expect((await herCall('PATCH', `/v1/p/projects/${projectId}`, { name: 'Taken' })).statusCode).toBe(404);
      expect((await herCall('DELETE', `/v1/p/projects/${projectId}`)).statusCode).toBe(404);
    }
    expect((await herTodos()).map((t) => t.title)).not.toContain('Sneak in');
    expect((await herProjects()).map((p) => p.name)).toEqual([]);
    // His own list never holds hers; his project and Bea's keep their names.
    await herCall('POST', '/v1/p/projects', { name: 'Asha only' });
    const mine = ((await him('GET', '/v1/projects')).json() as { projects: ProjectView[] }).projects.map((p) => p.name);
    expect(mine).toEqual(['His launch']);
    expect((await herProjects(f.bea.full)).map((p) => p.name)).toEqual(["Bea's"]);
  });

  it("his Assign can't name his own project or Bea's; nothing lands", async () => {
    const his = idOf(await him('POST', '/v1/projects', { name: 'His launch' }));
    const beas = idOf(await herCall('POST', '/v1/p/projects', { name: "Bea's" }, f.bea.full));
    for (const projectId of [his, beas]) {
      const r = await him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'Crossed', projectId });
      expect(r.statusCode, r.body).toBe(400);
    }
    expect((await herTodos()).map((t) => t.title)).not.toContain('Crossed');
    expect((await activity()).filter((r) => r.action === 'todo.added')).toEqual([]);
  });
});

describe('his view at his to-dos level', () => {
  it('his To-do tab carries her projects and counts; her mirror deep-equals it; off is the unknown-pid 404', async () => {
    const garden = idOf(await herCall('POST', '/v1/p/projects', { name: 'Garden' }));
    await herCall('POST', '/v1/p/todos', { title: 'Buy seeds', projectId: garden });
    const r = await him('GET', `/v1/people/${f.asha.id}/todos`);
    expect(r.statusCode).toBe(200);
    const v = r.json() as OwnerTodosView;
    expect(v.projects.map((p) => [p.name, p.open])).toEqual([['Garden', 1]]);
    expect(v.todos.find((t) => t.title === 'Buy seeds')?.projectId).toBe(garden);
    expect((await herCall('GET', '/v1/p/mirror/todos')).json()).toEqual(v);
    // His read is one view mark on her to-dos.
    expect((await activity()).filter((x) => x.action === 'view' && x.area === 'todos')).toHaveLength(1);
    expect((await herCall('POST', '/v1/p/agreement/narrow', { see: { todos: false } })).statusCode).toBe(200);
    expect((await him('GET', `/v1/people/${f.asha.id}/todos`)).statusCode).toBe(404);
    expect((await him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'Late', projectId: garden })).statusCode).toBe(404);
  });
});

describe('review 5, B2: he gets of her projects only what her join page names', () => {
  it("his view and her mirror carry a project's name, emoji, status and counts, never its notes, due day or times", async () => {
    const garden = idOf(await herCall('POST', '/v1/p/projects', { name: 'Garden', notes: 'Private: plan for the move in March', due: '2026-12-01', emoji: '🌱' }));
    f.api.ctx.clock.set('2026-11-03T21:47:00.000Z');
    expect((await herCall('PATCH', `/v1/p/projects/${garden}`, { name: 'Garden 2', status: 'done' })).statusCode).toBe(200);
    // Her own list keeps everything she wrote.
    expect((await herProjects()).find((p) => p.id === garden)).toMatchObject({ notes: 'Private: plan for the move in March', due: '2026-12-01' });
    const r = await him('GET', `/v1/people/${f.asha.id}/todos`);
    expect(r.statusCode).toBe(200);
    const v = r.json() as OwnerTodosView;
    expect(v.projects.find((p) => p.id === garden)).toEqual({ id: garden, name: 'Garden 2', emoji: '🌱', status: 'done', open: 0, overdue: 0 });
    expect(r.body).not.toContain('Private: plan');
    expect(r.body).not.toContain('2026-12-01');
    expect(r.body).not.toContain('21:47');
    expect((await herCall('GET', '/v1/p/mirror/todos')).json()).toEqual(v);
  });
});

describe('his Assign into one of her projects', () => {
  it('lands in it; her Activity and her push name the project, never an id', async () => {
    const garden = idOf(await herCall('POST', '/v1/p/projects', { name: 'Garden' }));
    const r = await him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'Water the basil', projectId: garden, due: { day: DAY } });
    expect(r.statusCode, r.body).toBe(201);
    const t = (await herTodos(`?project=${garden}`)).find((x) => x.title === 'Water the basil');
    expect(t?.by).toBe('');
    const row = (await activity()).find((x) => x.action === 'todo.added');
    expect(row).toMatchObject({ actor: 'owner', title: 'Water the basil', changes: [{ field: 'project', to: 'Garden' }] });
    expect(JSON.stringify(row)).not.toContain(garden);
  });

  it('his move of a to-do of hers between her projects (editHers.todos) is an Activity row with both names', async () => {
    const garden = idOf(await herCall('POST', '/v1/p/projects', { name: 'Garden' }));
    const study = idOf(await herCall('POST', '/v1/p/projects', { name: 'Study' }));
    const id = idOf(await herCall('POST', '/v1/p/todos', { title: 'Buy seeds', projectId: garden }));
    expect((await him('PATCH', `/v1/people/${f.asha.id}/todos/${id}`, { projectId: study })).statusCode).toBe(200);
    const row = (await activity()).find((x) => x.action === 'todo.edited');
    expect(row?.changes).toEqual([{ field: 'project', from: 'Garden', to: 'Study' }]);
    // Bea agreed to Standard (no editHers.todos): her own to-do is out of his reach, so he can't move it.
    const beaProject = idOf(await herCall('POST', '/v1/p/projects', { name: 'Hers' }, f.bea.full));
    const beaTodo = idOf(await herCall('POST', '/v1/p/todos', { title: "Bea's own" }, f.bea.full));
    expect((await him('PATCH', `/v1/people/${f.bea.id}/todos/${beaTodo}`, { projectId: beaProject })).statusCode).toBe(404);
    // His Assign into her project is in his Standard rights (assign.todos).
    expect((await him('POST', `/v1/people/${f.bea.id}/todos`, { title: 'From Sam', projectId: beaProject })).statusCode).toBe(201);
  });
});

describe('M11: her project writes reach his screens only while he sees her to-dos', () => {
  it('ticks his devices with see.todos on, never with it off', async () => {
    let his = 0;
    const was = f.life.people.ownerChanged;
    f.life.people.ownerChanged = () => {
      his += 1;
      was();
    };
    const id = idOf(await herCall('POST', '/v1/p/projects', { name: 'Seen' }));
    await herCall('PATCH', `/v1/p/projects/${id}`, { status: 'done' });
    await herCall('DELETE', `/v1/p/projects/${id}`);
    expect(his).toBe(3);
    await herCall('POST', '/v1/p/agreement/narrow', { see: { todos: false } });
    his = 0;
    await herCall('POST', '/v1/p/projects', { name: 'Unseen' });
    expect(his).toBe(0);
  });
});

describe('T11: her export', () => {
  it('holds her projects, never his', async () => {
    await herCall('POST', '/v1/p/projects', { name: 'Garden' });
    await him('POST', '/v1/projects', { name: 'His launch' });
    const x = (await herCall('GET', '/v1/p/export?format=json')).json() as { projects: { name: string }[] };
    expect(x.projects.map((p) => p.name)).toEqual(['Garden']);
    const html = (await herCall('GET', '/v1/p/export')).body;
    expect(html).toContain('Garden');
    expect(html).not.toContain('His launch');
  });
});
