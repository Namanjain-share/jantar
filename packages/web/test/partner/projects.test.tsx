/**
 * v0.11 People: her projects (spec 1.3.1 `/p/todos?tab=todos|reminders|projects`,
 * 3.3) and his side of them, with synthetic Sam and Asha and fake clients.
 *
 * - Routes: `?tab=` picks the tab; `?project=<id>` opens one project's page.
 * - Projects tab: New project, the active ones with their counts, the
 *   archived ones apart, and "Sam sees your projects" while he sees her
 *   to-dos.
 * - A project's page: its to-dos, Add into it, Rename, Archive and Bring
 *   back, Delete on a second tap (its to-dos stay).
 * - To-dos: Add can put a new one in a project, a row names its project,
 *   Edit moves one between projects; Reminders shows the timed ones.
 * - His To-do tab filters by her projects and names each item's project;
 *   his Assign sheet puts a new to-do in one of hers, and his edit moves one.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectView } from '@jantar/protocol';
import { presetAgreement } from '@jantar/protocol/people-core';
import type { PersonMe, PersonToday, PersonTodo, PersonView } from '@jantar/protocol/people';
import type { PersonApi } from '../../src/partner/api.js';
import { parsePersonRoute } from '../../src/partner/router.js';
import { Todos, projectCounts } from '../../src/partner/screens/Todos.js';
import { todoSubline } from '../../src/partner/screens/TodoRow.js';
import { createRouter, memoryHistory } from '../../src/lib/router.js';
import { createAppStore } from '../../src/store.js';
import { AppProvider, createToastStore } from '../../src/ui/context.js';
import type { PeopleClient } from '../../src/ui/screens/people/client.js';
import { Partner } from '../../src/ui/screens/people/Partner.js';
import { fakeApi as fakeOwnerApi } from '../helpers.js';

const DAY = '2026-11-03';
const AT = '2026-11-03T08:00:00.000Z';
const ASHA = '01JASHAAAAAAAAAAAAAAAAAAAA';
const GARDEN = '01JPR0JAAAAAAAAAAAAAAAAAA1';
const STUDY = '01JPR0JAAAAAAAAAAAAAAAAAA2';
const OLD = '01JPR0JAAAAAAAAAAAAAAAAAA3';
const SEEDS = '01JT0D0AAAAAAAAAAAAAAAAAA1';
const BANK = '01JT0D0AAAAAAAAAAAAAAAAAA2';

function fake<T extends object>(over: Partial<T> = {}): T {
  const base: Partial<T> = {};
  return new Proxy(base as T, {
    get: (_t, k: string) => (k in over ? (over as Record<string, unknown>)[k] : (base as Record<string, unknown>)[k] ?? ((base as Record<string, unknown>)[k] = vi.fn(async () => ({})))),
  });
}

function me(seeTodos = true): PersonMe {
  const a = presetAgreement('everything', 'P3');
  return {
    person: { id: ASHA, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, prefs: {} as PersonMe['person']['prefs'] },
    owner: { name: 'Sam' },
    peopleOn: true,
    agreement: { ...a, see: { ...a.see, todos: seeTodos }, version: 1 } as PersonMe['agreement'],
    pending: null,
    ownerDevices: [],
    built: 'P3',
    lifeBroken: false,
  } as PersonMe;
}

const project = (id: string, name: string, over: Partial<ProjectView> = {}): ProjectView => ({ id, name, status: 'active', createdAt: AT, updatedAt: AT, open: 0, overdue: 0, ...over });
const PROJECTS = [project(GARDEN, 'Garden', { emoji: '🌱', open: 1 }), project(STUDY, 'Study', { open: 0 }), project(OLD, 'Old flat', { status: 'done' })];
const todo = (id: string, title: string, over: Partial<PersonTodo> = {}): PersonTodo => ({ id, title, priority: 'normal', by: ASHA, createdAt: AT, updatedAt: AT, ...over });
const TODOS = [todo(SEEDS, 'Buy seeds', { projectId: GARDEN }), todo(BANK, 'Call the bank', { due: { day: DAY, time: '10:00' } })];

function herApi(over: Partial<PersonApi> = {}): PersonApi {
  return fake<PersonApi>({
    todos: vi.fn(async (_done?: boolean, p?: string) => ({ today: DAY, todos: p ? TODOS.filter((t) => t.projectId === p) : TODOS })),
    projects: vi.fn(async () => ({ projects: PROJECTS })),
    ...over,
  });
}

describe('her To-do routes', () => {
  it('?tab= picks the tab; ?project= opens a project of hers; anything else is To-dos', () => {
    expect(parsePersonRoute('/p/todos', '')).toEqual({ name: 'todos', tab: 'todos', project: null });
    expect(parsePersonRoute('/p/todos', '?tab=reminders')).toEqual({ name: 'todos', tab: 'reminders', project: null });
    expect(parsePersonRoute('/p/todos', '?tab=projects')).toEqual({ name: 'todos', tab: 'projects', project: null });
    expect(parsePersonRoute('/p/todos', `?project=${GARDEN}`)).toEqual({ name: 'todos', tab: 'projects', project: GARDEN });
    expect(parsePersonRoute('/p/todos', '?tab=evil&project=__proto__')).toEqual({ name: 'todos', tab: 'todos', project: null });
  });
});

describe('her Projects tab', () => {
  it('lists the active ones with their counts and the archived apart; New project; says Sam sees them', async () => {
    const projectCreate = vi.fn(async () => ({ id: 'NEW' }));
    const api = herApi({ projectCreate });
    render(<Todos me={me()} api={api} tab="projects" tick={0} />);
    const active = await screen.findByRole('link', { name: /Garden/ });
    expect(active.textContent).toBe('🌱 Garden1 open');
    expect(active.getAttribute('href')).toBe(`/p/todos?project=${GARDEN}`);
    expect(screen.getByRole('link', { name: /Study/ }).textContent).toMatch(/Nothing open/);
    const archived = screen.getByRole('heading', { name: 'Archived' }).nextElementSibling as HTMLElement;
    expect(within(archived).getByText('Old flat')).toBeTruthy();
    expect(screen.getByText('Sam sees your projects with your to-dos: each name and how many of its to-dos are open, never its notes or due day.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('New project'), { target: { value: 'Move house' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(projectCreate).toHaveBeenCalledWith({ name: 'Move house' }));
  });

  it('says nothing about Sam while he does not see her to-dos', async () => {
    render(<Todos me={me(false)} api={herApi()} tab="projects" tick={0} />);
    expect(await screen.findByRole('link', { name: /Garden/ })).toBeTruthy();
    expect(screen.queryByText(/Sam sees your projects/)).toBeNull();
    expect(projectCounts({ open: 2, overdue: 1 })).toBe('2 open · 1 overdue');
  });
});

describe("a project's page", () => {
  it('shows its to-dos; Add puts one in it; Rename, Archive and Delete (a second tap, its to-dos stay)', async () => {
    const createTodo = vi.fn(async () => ({ id: 'NEW' }));
    const projectUpdate = vi.fn(async () => undefined);
    const projectDelete = vi.fn(async () => undefined);
    const api = herApi({ createTodo, projectUpdate, projectDelete });
    render(<Todos me={me()} api={api} tab="projects" project={GARDEN} tick={0} />);
    expect(await screen.findByRole('heading', { name: '🌱 Garden' })).toBeTruthy();
    expect(api.todos).toHaveBeenCalledWith(false, GARDEN);
    expect(await screen.findByText('Buy seeds')).toBeTruthy();
    // On its own page a row doesn't repeat the project's name.
    expect(screen.queryByText(/in 🌱 Garden/)).toBeNull();
    fireEvent.change(screen.getByLabelText('New to-do'), { target: { value: 'Pots' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(createTodo).toHaveBeenCalledWith({ title: 'Pots', projectId: GARDEN }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const sheet = screen.getByRole('dialog', { name: 'Rename project' });
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Balcony' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(projectUpdate).toHaveBeenCalledWith(GARDEN, { name: 'Balcony' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(projectUpdate).toHaveBeenCalledWith(GARDEN, { status: 'done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    expect(projectDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Tap again: its to-dos stay, with no project' }));
    await waitFor(() => expect(projectDelete).toHaveBeenCalledWith(GARDEN));
  });

  it('an archived one says so and can be brought back; one that is gone says so', async () => {
    const projectUpdate = vi.fn(async () => undefined);
    const r = render(<Todos me={me()} api={herApi({ projectUpdate })} tab="projects" project={OLD} tick={0} />);
    expect(await screen.findByText(/^Archived · /)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bring back' }));
    await waitFor(() => expect(projectUpdate).toHaveBeenCalledWith(OLD, { status: 'active' }));
    r.unmount();
    render(<Todos me={me()} api={herApi()} tab="projects" project="01JG0NEAAAAAAAAAAAAAAAAAAA" tick={0} />);
    expect(await screen.findByText("This project isn't here any more.")).toBeTruthy();
  });
});

describe('her To-dos and Reminders with projects', () => {
  it('Add can put a new one in a project; a row names its project; Edit moves it; Reminders shows the timed ones', async () => {
    const createTodo = vi.fn(async () => ({ id: 'NEW' }));
    const updateTodo = vi.fn(async () => undefined);
    const api = herApi({ createTodo, updateTodo });
    const r = render(<Todos me={me()} api={api} tick={0} />);
    expect(await screen.findByText(/in 🌱 Garden/)).toBeTruthy();
    // Only active projects are offered.
    const pick = screen.getByLabelText('Project (optional)') as HTMLSelectElement;
    expect([...pick.options].map((o) => o.textContent)).toEqual(['None', '🌱 Garden', 'Study']);
    // Review 5, UX 3: a 60-character project name never widens her Add row (or her Edit sheet) past her screen.
    const fits = (el: HTMLElement) => ['w-full', 'min-w-0', 'max-w-full'].every((c) => el.classList.contains(c)) && ['min-w-0', 'max-w-full'].every((c) => el.parentElement?.classList.contains(c));
    expect(fits(pick)).toBe(true);
    fireEvent.change(screen.getByLabelText('New to-do'), { target: { value: 'Read chapter 3' } });
    fireEvent.change(pick, { target: { value: STUDY } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(createTodo).toHaveBeenCalledWith({ title: 'Read chapter 3', projectId: STUDY }));
    // Edit: move Buy seeds to Study; a save that keeps the project sends none.
    fireEvent.click(screen.getByRole('button', { name: 'More for Buy seeds' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Buy seeds' })).getByRole('button', { name: 'Edit' }));
    const sheet = screen.getByRole('dialog', { name: 'Buy seeds' });
    expect(fits(within(sheet).getByLabelText('Project'))).toBe(true);
    fireEvent.change(within(sheet).getByLabelText('Project'), { target: { value: STUDY } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateTodo).toHaveBeenCalledWith(SEEDS, { title: 'Buy seeds', due: null, projectId: STUDY }));
    fireEvent.click(screen.getByRole('button', { name: 'More for Call the bank' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Call the bank' })).getByRole('button', { name: 'Edit' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Call the bank' })).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateTodo).toHaveBeenLastCalledWith(BANK, { title: 'Call the bank', due: { day: DAY, time: '10:00' } }));
    r.unmount();
    render(<Todos me={me()} api={herApi()} tab="reminders" tick={0} />);
    expect(await screen.findByText('Call the bank')).toBeTruthy();
    expect(screen.queryByText('Buy seeds')).toBeNull();
    expect(todoSubline(TODOS[0] as PersonTodo, 'Sam', 'Garden')).toBe('in Garden');
  });
});

const person = (): PersonView => ({ id: ASHA, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, invite: null, agreement: { ...presetAgreement('everything', 'P3'), version: 1 }, offer: null, pendingProposal: null }) as PersonView;
const hisToday = (): PersonToday => ({
  day: DAY,
  name: 'Asha',
  state: 'active',
  todos: { open: 2, overdue: 0, due: [] },
  meds: null,
  weight: { locked: true },
  food: null,
  plan: { locked: true },
  status: { locked: true },
  review: null,
  sleep: { locked: true },
  concerns: [],
});

function Wrapped({ client: c, tab }: { client: PeopleClient; tab?: string }) {
  const [deps] = useState(() => ({ store: createAppStore(), api: fakeOwnerApi(), router: createRouter(memoryHistory(`/people/${ASHA}`)), toasts: createToastStore() }));
  return (
    <AppProvider deps={deps}>
      <Partner pid={ASHA} client={c} {...(tab ? { tab } : {})} />
    </AppProvider>
  );
}

describe('his side of her projects', () => {
  it('his To-do tab filters by her projects and names each item\'s; his edit of hers moves it between them', async () => {
    const updateTodo = vi.fn(async () => undefined);
    const c = fake<PeopleClient>({
      list: vi.fn(async () => ({ enabled: true, people: [person()] })) as never,
      today: vi.fn(async () => hisToday()),
      todos: vi.fn(async (_pid: string, done?: boolean) => ({ today: DAY, todos: done ? [] : TODOS, projects: PROJECTS })),
      updateTodo,
    });
    render(<Wrapped client={c} tab="todos" />);
    expect(await screen.findByText(/in 🌱 Garden/)).toBeTruthy();
    const chips = screen.getByRole('group', { name: "Asha's projects" });
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['All', '🌱 Garden · 1', 'Study · 0']);
    // Review 5, UX 3 and 4: each chip wraps a long name with its count, and is at least 44 by 44 ("All" too).
    for (const b of within(chips).getAllByRole('button')) {
      expect(b.className, b.textContent ?? '').not.toMatch(/whitespace-nowrap|(^|\s)h-\d/);
      for (const c of ['min-h-44', 'min-w-44', 'max-w-full', '[overflow-wrap:anywhere]']) expect(b.classList.contains(c), `${b.textContent} ${c}`).toBe(true);
    }
    fireEvent.click(within(chips).getByRole('button', { name: '🌱 Garden · 1' }));
    expect(screen.getByRole('heading', { name: 'Open in 🌱 Garden' })).toBeTruthy();
    expect(screen.queryByText('Call the bank')).toBeNull();
    // Everything has editHers.todos: he edits her Buy seeds and moves it to Study.
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
    const sheet = await screen.findByRole('dialog', { name: 'Edit: Buy seeds' });
    fireEvent.change(within(sheet).getByLabelText("Asha's project (optional)"), { target: { value: STUDY } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateTodo).toHaveBeenCalledWith(ASHA, SEEDS, expect.objectContaining({ projectId: STUDY })));
  });

  it("his Assign sheet puts a new to-do in one of her projects (active ones only) and says where", async () => {
    const assignTodo = vi.fn(async () => ({ id: 'NEW' }));
    const c = fake<PeopleClient>({
      list: vi.fn(async () => ({ enabled: true, people: [person()] })) as never,
      today: vi.fn(async () => hisToday()),
      todos: vi.fn(async () => ({ today: DAY, todos: TODOS, projects: PROJECTS })),
      assignTodo,
    });
    render(<Wrapped client={c} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Assign' }));
    const sheet = await screen.findByRole('dialog', { name: 'Assign to Asha' });
    const pick = (await within(sheet).findByLabelText("Asha's project (optional)")) as HTMLSelectElement;
    expect([...pick.options].map((o) => o.textContent)).toEqual(['None', '🌱 Garden', 'Study']);
    expect(['w-full', 'min-w-0', 'max-w-full'].every((c) => pick.classList.contains(c))).toBe(true);
    fireEvent.change(within(sheet).getByLabelText('To-do'), { target: { value: 'Water the basil' } });
    fireEvent.change(pick, { target: { value: GARDEN } });
    expect(within(sheet).getByText(/Asha sees it at once in 🌱 Garden, marked "From you"/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Assign to Asha' }));
    await waitFor(() => expect(assignTodo).toHaveBeenCalledWith(ASHA, { title: 'Water the basil', projectId: GARDEN, ask: 'none' }));
  });
});
