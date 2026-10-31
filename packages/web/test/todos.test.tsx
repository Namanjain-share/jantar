/**
 * Todos and projects (v0.4 spec 4.4, 5.3, 5.10) against the fake API: the
 * rails, the rows and their meta line, Done with Undo, the ··· menu (the
 * snooze presets, Edit, Delete with no confirm: held back under a 5 s Undo
 * that puts the row back exactly), the todo sheet (create, edit, what a
 * PATCH sends, a failed save that keeps its values and its key), the Done
 * list, a push's `?id=`, the Projects tab, the project screen and sheet,
 * and every state with the <h1>. The Reminders view has its own file.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LifeStatus, ProjectView, Todo, TodosResponse } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import { FLASH_MS } from '../src/ui/screens/life/todos/Todos.js';
import { fakeApi, iso, preloadPlaces, renderApp, session, stateWith } from './helpers.js';

preloadPlaces('todos');

const DAY = '2026-01-15';
const id = (n: number) => `01JFZ8X8Y3T0V5G9WQK2M4N${String(n).padStart(3, '0')}`;

afterEach(() => vi.useRealTimers());

const status: LifeStatus = {
  open: true,
  timezone: 'UTC',
  today: DAY,
  currency: null,
  lockScreenDetails: false,
  modules: { todos: true, medicines: false, food: false, places: false, finance: false },
  estimate: { available: false },
  backups: { last: null, count: 0 },
  push: { devices: 1, webpush: true },
};

function todo(n: number, over: Partial<Todo> = {}): Todo {
  return { id: id(n), title: `Example todo ${n}`, priority: 'normal', createdAt: iso(n), updatedAt: iso(n), ...over };
}

function project(n: number, over: Partial<ProjectView> = {}): ProjectView {
  return { id: id(n), name: `Example project ${n}`, status: 'active', open: 0, overdue: 0, createdAt: iso(0), updatedAt: iso(0), ...over };
}

const P1 = project(50, { emoji: '🛠', open: 4, overdue: 1, due: '2026-01-10', folder: '/synthetic/home/work/alpha' });
const P2 = project(51, { status: 'paused', due: '2026-02-01' });

// In the daemon's order: due day, then time, undated last. NOW is 10:05 UTC.
const OPEN: Todo[] = [
  todo(1, { due: { day: '2026-01-13' }, projectId: P1.id }),
  todo(3, { due: { day: DAY, time: '09:00' } }),
  todo(2, { due: { day: DAY, time: '18:00' }, priority: 'high' }),
  todo(4, { due: { day: '2026-01-20' }, repeat: { freq: 'weekly', byWeekday: [2] } }),
  todo(5),
];

function render(opts: { path?: string; todos?: Todo[]; list?: () => Promise<TodosResponse>; projects?: ProjectView[]; api?: Parameters<typeof fakeApi>[0]; conn?: 'live' | 'offline'; sessions?: ReturnType<typeof session>[] } = {}) {
  const list = opts.todos ?? OPEN;
  const api = fakeApi({
    lifeStatus: vi.fn(async () => status),
    todosList: vi.fn(opts.list ?? (async (q?: { project?: string; done?: boolean }) => ({ today: DAY, todos: q?.done ? [todo(9, { doneAt: iso(1) })] : q?.project ? list.filter((t) => t.projectId === q.project) : list }))),
    projectsList: vi.fn(async () => ({ projects: opts.projects ?? [P1, P2] })),
    ...opts.api,
  });
  return renderApp({ path: opts.path ?? '/todos', api, state: stateWith({ features: { life: true }, sessions: opts.sessions ?? [] }), ...(opts.conn ? { status: opts.conn } : {}) });
}

const heading = (name = 'Todos') => screen.findByRole('heading', { level: 1, name });
const rail = (name: string) => screen.findByRole('region', { name });
const row = (n: number) => document.querySelector(`[data-todo="${id(n)}"]`) as HTMLElement;
const dialog = (name: string) => screen.findByRole('dialog', { name });

async function menu(title: string, item: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${title}` }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}

describe('Todos: states', () => {
  it('shows its title while loading and with an error', async () => {
    let fail!: (e: unknown) => void;
    render({ list: () => new Promise((_, rej) => (fail = rej)) });
    await heading();
    // The <h1> can paint before the effect that calls the loader has run.
    await waitFor(() => expect(fail).toBeTypeOf('function'));
    await act(async () => fail(new ApiError('forbidden', 'Todos are off. Turn them on at your Mac: jantar life on todos', 403)));
    expect((await screen.findByText('jantar life on todos')).tagName).toBe('CODE');
    expect(screen.getByRole('heading', { level: 1, name: 'Todos' })).toBeTruthy();
  });

  it('keeps the last list when a reload fails, with the sentence above it', async () => {
    let n = 0;
    const list = async (): Promise<TodosResponse> => {
      n += 1;
      if (n === 1) return { today: DAY, todos: OPEN };
      throw new ApiError('life_unavailable', 'Life data could not be opened. The file is untouched. Restore a backup at your Mac: jantar life restore <file>', 503);
    };
    render({ list, api: { todoDone: vi.fn(async () => ({ ok: true as const })) } });
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done: Example todo 5' }));
    expect((await screen.findByText('jantar life restore <file>')).tagName).toBe('CODE');
    expect(screen.getByText('Example todo 1')).toBeTruthy();
  });

  it('says "No todos yet." with an add button when there are none', async () => {
    render({ todos: [] });
    expect(await screen.findByText('No todos yet.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Add todo' })).toHaveLength(2);
  });

  it('offline: keeps the list and turns add and Done off', async () => {
    render({ conn: 'offline' });
    await screen.findByText('Example todo 1');
    expect((screen.getByRole('button', { name: 'Add todo' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Mark done: Example todo 1' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Offline: changes need your Mac')).toBeTruthy();
  });
});

describe('Todos: the list', () => {
  it('sorts open todos under Overdue, Today, Upcoming and No date', async () => {
    render();
    const names = async (r: string) => within(await rail(r)).getAllByRole('listitem').map((li) => li.getAttribute('data-todo'));
    expect(await names('Overdue')).toEqual([id(1), id(3)]);
    expect(await names('Today')).toEqual([id(2)]);
    expect(await names('Upcoming')).toEqual([id(4)]);
    expect(await names('No date')).toEqual([id(5)]);
    // The rail's count is ink: the ember is on each overdue row, never twice.
    const head = within(await rail('Overdue')).getByRole('heading', { level: 2 });
    expect(head.querySelector('.text-signal-text')).toBeNull();
  });

  it('writes the meta line: project, day (not under Today), time in mustard, repeat; overdue in ember', async () => {
    render();
    await screen.findByText('Example todo 1');
    expect(within(row(1)).getByText('🛠 Example project 50')).toBeTruthy();
    expect(within(row(1)).getByText('Tue 13 Jan')).toBeTruthy();
    expect(within(row(1)).getByText('overdue 2d').className).toContain('text-signal-text');
    expect(within(row(3)).getByText('overdue').className).toContain('text-signal-text');
    // Tab to an overdue row's title says it is overdue: the ember words describe the title button.
    const late = within(row(1)).getByText('overdue 2d');
    expect(within(row(1)).getByRole('button', { name: /^Example todo 1/ }).getAttribute('aria-describedby')).toBe(late.id);
    expect(within(row(2)).getByRole('button', { name: /^Example todo 2/ }).getAttribute('aria-describedby')).toBeNull();
    expect(within(row(2)).queryByText('Today')).toBeNull();
    expect(within(row(2)).getByText('18:00').className).toContain('text-jup-text');
    // The high tag leads the meta line, never standing between a wrapped title and the rest.
    expect(within(row(2)).getByText('high').closest('.type-mono')?.textContent).toMatch(/^high/);
    expect(within(row(4)).getByText('repeats')).toBeTruthy();
    expect(within(row(4)).queryByText(/overdue/)).toBeNull();
    // Only the overdue words are ember.
    expect(row(2).querySelector('.text-signal-text')).toBeNull();
  });

  it('keeps a row with no meta line 44 px tall on touch', async () => {
    render();
    const title = await screen.findByText('Example todo 5');
    expect(within(row(5)).queryByText('·')).toBeNull();
    expect((title.closest('button') as HTMLElement).className).toContain('coarse:min-h-44');
  });

  it('marks a todo done, and Undo sends done: false', async () => {
    const todoDone = vi.fn(async () => ({ ok: true as const }));
    const { api } = render({ api: { todoDone } });
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done: Example todo 5' }));
    await waitFor(() => expect(todoDone).toHaveBeenCalledWith(id(5), true));
    await waitFor(() => expect(api.todosList).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Done: Example todo 5')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(todoDone).toHaveBeenLastCalledWith(id(5), false));
  });

  it('drops the Undo line after 5 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render({ api: { todoDone: vi.fn(async () => ({ ok: true as const })) } });
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done: Example todo 5' }));
    await screen.findByRole('button', { name: 'Undo' });
    await act(async () => vi.advanceTimersByTime(5_100));
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('snoozes from the ··· menu', async () => {
    const todoSnooze = vi.fn(async () => ({ ok: true as const }));
    render({ api: { todoSnooze } });
    await menu('Example todo 4', 'Tomorrow');
    await waitFor(() => expect(todoSnooze).toHaveBeenCalledWith(id(4), 'tomorrow'));
    await menu('Example todo 4', 'Later 1 h');
    await waitFor(() => expect(todoSnooze).toHaveBeenCalledWith(id(4), '1h'));
  });

  it('offers every snooze preset, Edit and Delete', async () => {
    render();
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Example todo 1' }));
    await screen.findByRole('menuitem', { name: 'Tonight' });
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Later 1 h', 'Tonight', 'Tomorrow', 'Next week', 'Edit', 'Delete']);
  });

  it('opens the menu with a long press (or a right click)', async () => {
    render();
    const title = await screen.findByText('Example todo 4');
    fireEvent.contextMenu(title.closest('button') as HTMLElement);
    expect(await screen.findByRole('menuitem', { name: 'Next week' })).toBeTruthy();
  });

  it('Delete asks nothing: the row goes at once, and the delete is sent when its 5 s Undo goes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const todoDelete = vi.fn(async () => ({ ok: true as const }));
    const { api } = render({ api: { todoDelete } });
    await menu('Example todo 5', 'Delete');
    expect(screen.queryByText('Example todo 5')).toBeNull();
    expect(screen.queryByRole('region', { name: 'No date' })).toBeNull();
    expect(screen.getByText('Deleted: Example todo 5')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => vi.advanceTimersByTime(4_900));
    expect(todoDelete).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(200));
    expect(todoDelete).toHaveBeenCalledWith(id(5));
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    await waitFor(() => expect(api.todosList).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Example todo 5')).toBeNull();
  });

  it('Undo after Delete puts the row back exactly where it was, and nothing is sent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const todoDelete = vi.fn(async () => ({ ok: true as const }));
    render({ api: { todoDelete } });
    const names = async (r: string) => within(await rail(r)).getAllByRole('listitem').map((li) => li.getAttribute('data-todo'));
    await menu('Example todo 3', 'Delete');
    expect(await names('Overdue')).toEqual([id(1)]);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await names('Overdue')).toEqual([id(1), id(3)]);
    expect(within(row(3)).getByText('09:00')).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(todoDelete).not.toHaveBeenCalled();
  });

  it('a second Delete sends the first at once; a delete that fails brings its row back with Not saved', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const todoDelete = vi.fn(async (tid: string) => {
      if (tid === id(4)) throw new ApiError('life_unavailable', 'Life data could not be opened.', 503);
      return { ok: true as const };
    });
    render({ api: { todoDelete } });
    await menu('Example todo 4', 'Delete');
    await menu('Example todo 5', 'Delete');
    expect(todoDelete.mock.calls).toEqual([[id(4)]]);
    expect(await screen.findByText('Example todo 4')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Not saved.');
    expect(screen.queryByText('Example todo 5')).toBeNull();
    expect(screen.getByText('Deleted: Example todo 5')).toBeTruthy();
  });

  it('a held delete is sent when the screen closes, or when the app goes to the background', async () => {
    const todoDelete = vi.fn(async () => ({ ok: true as const }));
    const { router } = render({ api: { todoDelete } });
    await menu('Example todo 5', 'Delete');
    act(() => router.getState().navigate('/'));
    await waitFor(() => expect(todoDelete).toHaveBeenCalledWith(id(5)));

    act(() => router.getState().navigate('/todos'));
    await menu('Example todo 4', 'Delete');
    expect(todoDelete).toHaveBeenCalledTimes(1);
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    state.mockRestore();
    await waitFor(() => expect(todoDelete).toHaveBeenLastCalledWith(id(4)));
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('lists the newest done todos when Done opens, and the check makes one not done', async () => {
    const todoDone = vi.fn(async () => ({ ok: true as const }));
    const { api } = render({ api: { todoDone } });
    const toggle = await screen.findByRole('button', { name: 'Done' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(api.todosList).not.toHaveBeenCalledWith({ done: true });
    fireEvent.click(toggle);
    await waitFor(() => expect(api.todosList).toHaveBeenCalledWith({ done: true }));
    const done = await screen.findByRole('list', { name: 'Done' });
    expect(within(done).getByText('Example todo 9').className).toContain('text-ink-3');
    fireEvent.click(within(done).getByRole('button', { name: 'Mark not done: Example todo 9' }));
    await waitFor(() => expect(todoDone).toHaveBeenCalledWith(id(9), false));
  });
});

describe('Todos: the todo sheet', () => {
  it('adds a todo with a due day and time, carrying an Idempotency-Key', async () => {
    const todoCreate = vi.fn(async () => ({ id: id(70) }));
    render({ api: { todoCreate } });
    await screen.findByText('Example todo 1');
    fireEvent.click(screen.getByRole('button', { name: 'Add todo' }));
    const sheet = await dialog('New todo');
    fireEvent.change(within(sheet).getByLabelText('Title'), { target: { value: '  Call the example office ' } });
    fireEvent.change(within(sheet).getByLabelText('Due day'), { target: { value: '2026-01-16' } });
    fireEvent.change(within(sheet).getByLabelText('Due time'), { target: { value: '11:30' } });
    fireEvent.change(within(sheet).getByLabelText('Project'), { target: { value: P1.id } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'High' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add todo' }));
    await waitFor(() => expect(todoCreate).toHaveBeenCalledTimes(1));
    expect(todoCreate).toHaveBeenCalledWith({ title: 'Call the example office', priority: 'high', due: { day: '2026-01-16', time: '11:30' }, projectId: P1.id }, expect.any(String));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New todo' })).toBeNull());
  });

  it('offers Repeat only with a date, and sends it', async () => {
    const todoCreate = vi.fn(async () => ({ id: id(70) }));
    render({ api: { todoCreate } });
    await screen.findByText('Example todo 1');
    fireEvent.click(screen.getByRole('button', { name: 'Add todo' }));
    const sheet = await dialog('New todo');
    expect(within(sheet).queryByRole('group', { name: 'Repeat' })).toBeNull();
    expect((within(sheet).getByLabelText('Due time') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText('Title'), { target: { value: 'Water the plants' } });
    fireEvent.change(within(sheet).getByLabelText('Due day'), { target: { value: DAY } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Every day' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add todo' }));
    await waitFor(() => expect(todoCreate).toHaveBeenCalledWith({ title: 'Water the plants', priority: 'normal', due: { day: DAY }, repeat: { freq: 'daily' } }, expect.any(String)));
  });

  it('edits only what changed', async () => {
    const todoUpdate = vi.fn(async () => ({ ok: true as const }));
    render({ api: { todoUpdate } });
    fireEvent.click(await screen.findByText('Example todo 1'));
    const sheet = await dialog('Edit todo');
    expect((within(sheet).getByLabelText('Title') as HTMLInputElement).value).toBe('Example todo 1');
    fireEvent.click(within(sheet).getByRole('button', { name: 'High' }));
    fireEvent.change(within(sheet).getByLabelText('Project'), { target: { value: '' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(todoUpdate).toHaveBeenCalledWith(id(1), { priority: 'high', projectId: null }, expect.any(String)));
  });

  it('clearing the date of a repeating todo clears its repeat too', async () => {
    const todoUpdate = vi.fn(async () => ({ ok: true as const }));
    render({ api: { todoUpdate } });
    await menu('Example todo 4', 'Edit');
    const sheet = await dialog('Edit todo');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Clear' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(todoUpdate).toHaveBeenCalledWith(id(4), { due: null, repeat: null }, expect.any(String)));
  });

  it('a failed save keeps the sheet and its values, and retries with the same key', async () => {
    const todoCreate = vi
      .fn<(body: unknown, key?: string) => Promise<{ id: string }>>()
      .mockRejectedValueOnce(new ApiError('network', 'offline', 0))
      .mockRejectedValueOnce(new ApiError('conflict', 'You have 5,000 open todos. Finish or delete some first.', 409))
      .mockResolvedValue({ id: id(70) });
    render({ api: { todoCreate } });
    await screen.findByText('Example todo 1');
    fireEvent.click(screen.getByRole('button', { name: 'Add todo' }));
    const sheet = await dialog('New todo');
    fireEvent.change(within(sheet).getByLabelText('Title'), { target: { value: 'Example errand' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add todo' }));
    expect((await within(sheet).findByRole('alert')).textContent).toMatch(/^Not saved\. Could not reach the Mac/);
    expect((within(sheet).getByLabelText('Title') as HTMLInputElement).value).toBe('Example errand');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add todo' }));
    expect((await within(sheet).findByText(/5,000 open todos/)).className).toContain('text-signal-text');
    const [k1, k2] = todoCreate.mock.calls.map((c) => c[1]);
    expect(k1).toBeTruthy();
    expect(k2).toBe(k1);
    fireEvent.change(within(sheet).getByLabelText('Title'), { target: { value: 'Example errand, renamed' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add todo' }));
    await waitFor(() => expect(todoCreate).toHaveBeenCalledTimes(3));
    expect(todoCreate.mock.calls[2]?.[1]).not.toBe(k1);
  });
});

describe('Todos: a push (?id=)', () => {
  it('opens Reminders for a todo with a time and highlights it for 2 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render({ path: `/todos?id=${id(2)}` });
    await screen.findByText('Example todo 2');
    expect(screen.getByRole('button', { name: 'Reminders' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(row(2).getAttribute('data-highlight')).toBe('true'));
    expect(row(2).className).toContain('bg-select');
    await act(async () => vi.advanceTimersByTime(FLASH_MS + 100));
    expect(row(2).getAttribute('data-highlight')).toBeNull();
  });

  it('stays on Todos for a todo with no time', async () => {
    render({ path: `/todos?id=${id(5)}` });
    await screen.findByText('Example todo 5');
    expect(screen.getByRole('button', { name: 'Todos' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(row(5).getAttribute('data-highlight')).toBe('true'));
  });

  it('stays on Reminders once the todo it opened is done, and after Undo', async () => {
    let open = OPEN;
    const todoDone = vi.fn(async (tid: string, done: boolean) => {
      open = done ? OPEN.filter((t) => t.id !== tid) : OPEN;
      return { ok: true as const };
    });
    const { router } = render({ path: `/todos?id=${id(2)}`, list: async () => ({ today: DAY, todos: open }), api: { todoDone } });
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done: Example todo 2' }));
    await waitFor(() => expect(screen.queryByText('Example todo 2')).toBeNull());
    expect(screen.getByText('Done: Example todo 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reminders' }).getAttribute('aria-pressed')).toBe('true');
    expect(router.getState().route).toEqual({ name: 'todos', tab: 'reminders', id: id(2) });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Example todo 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reminders' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('stays on Reminders once the todo it opened is deleted', async () => {
    let open = OPEN;
    const todoDelete = vi.fn(async (tid: string) => {
      open = OPEN.filter((t) => t.id !== tid);
      return { ok: true as const };
    });
    render({ path: `/todos?id=${id(3)}`, list: async () => ({ today: DAY, todos: open }), api: { todoDelete } });
    await menu('Example todo 3', 'Delete');
    await waitFor(() => expect(screen.queryByText('Example todo 3')).toBeNull());
    expect(screen.getByRole('button', { name: 'Reminders' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Todos: projects', () => {
  it('lists projects with their counts, the overdue ones in ember, and live sessions', async () => {
    const sessions = [session('a', { cwd: '/synthetic/home/work/alpha/app' }), session('b', { cwd: '/synthetic/home/work/alpha', status: 'ended' })];
    render({ path: '/todos?tab=projects', sessions });
    const list = await screen.findByRole('list', { name: 'Projects' });
    const p1 = within(list).getByText('🛠 Example project 50').closest('a') as HTMLElement;
    expect(within(p1).getByText('active')).toBeTruthy();
    expect(within(p1).getByText('4 open')).toBeTruthy();
    expect(within(p1).getByText('1 overdue').className).toContain('text-signal-text');
    expect(within(p1).getByText('due 10 Jan').className).toContain('text-signal-text');
    expect(within(p1).getByText('1 live session')).toBeTruthy();
    const p2 = within(list).getByText('Example project 51').closest('a') as HTMLElement;
    expect(within(p2).getByText('due 1 Feb').className).not.toContain('text-signal-text');
    expect(p2.querySelector('.text-signal-text')).toBeNull();
  });

  it('says "No projects yet." with none', async () => {
    render({ path: '/todos?tab=projects', projects: [] });
    expect(await screen.findByText('No projects yet.')).toBeTruthy();
  });

  it('switches tabs through the route', async () => {
    const { router } = render();
    await screen.findByText('Example todo 1');
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    expect(router.getState().route).toEqual({ name: 'todos', tab: 'projects' });
    expect(await screen.findByRole('list', { name: 'Projects' })).toBeTruthy();
  });

  it('adds a project linked to a session folder', async () => {
    const projectCreate = vi.fn(async () => ({ id: id(80) }));
    render({ path: '/todos?tab=projects', api: { projectCreate }, sessions: [session('a', { cwd: '/synthetic/home/work/beta' })] });
    await screen.findByRole('list', { name: 'Projects' });
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
    const sheet = await dialog('New project');
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Example site' } });
    fireEvent.change(within(sheet).getByLabelText('Emoji'), { target: { value: '🌐' } });
    fireEvent.change(within(sheet).getByLabelText('Folder'), { target: { value: '/synthetic/home/work/beta' } });
    fireEvent.change(within(sheet).getByLabelText('Due'), { target: { value: '2026-03-01' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add project' }));
    await waitFor(() =>
      expect(projectCreate).toHaveBeenCalledWith({ name: 'Example site', status: 'active', emoji: '🌐', due: '2026-03-01', folder: '/synthetic/home/work/beta' }, expect.any(String)),
    );
  });

  it('opens a project: status, due, folder, live sessions, its todos and notes', async () => {
    const projectUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessions = [session('a', { cwd: '/synthetic/home/work/alpha/app', folder: 'app', name: 'fix login' })];
    const { router, api } = render({ path: `/todos?project=${P1.id}`, api: { projectUpdate }, sessions, projects: [{ ...P1, notes: 'Line one\nLine two' }, P2] });
    await heading('🛠 Example project 50');
    expect(screen.getByText('Sat 10 Jan')).toBeTruthy();
    expect(screen.getByText('/synthetic/home/work/alpha')).toBeTruthy();
    const live = await rail('Live sessions');
    fireEvent.click(within(live).getByText('fix login'));
    expect(router.getState().route).toEqual({ name: 'session', sid: 'a' });
    act(() => router.getState().back());
    await heading('🛠 Example project 50');
    expect(api.todosList).toHaveBeenCalledWith({ project: P1.id });
    expect(await screen.findByText('Example todo 1')).toBeTruthy();
    expect(screen.getByText(/Line one/).className).toContain('whitespace-pre-wrap');
    fireEvent.click(screen.getByRole('button', { name: 'Paused' }));
    await waitFor(() => expect(projectUpdate).toHaveBeenCalledWith(P1.id, { status: 'paused' }, expect.any(String)));
  });

  it('adds a todo inside the project, and deletes the project after asking', async () => {
    const todoCreate = vi.fn(async () => ({ id: id(71) }));
    const projectDelete = vi.fn(async () => ({ ok: true as const }));
    const { router } = render({ path: `/todos?project=${P2.id}`, api: { todoCreate, projectDelete } });
    await heading('Example project 51');
    fireEvent.click(screen.getByRole('button', { name: 'Add todo' }));
    const sheet = await dialog('New todo');
    fireEvent.change(within(sheet).getByLabelText('Title'), { target: { value: 'Draft the example' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add todo' }));
    await waitFor(() => expect(todoCreate).toHaveBeenCalledWith({ title: 'Draft the example', priority: 'normal', projectId: P2.id }, expect.any(String)));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New todo' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const edit = await dialog('Edit project');
    fireEvent.click(within(edit).getByRole('button', { name: 'Delete' }));
    expect(projectDelete).not.toHaveBeenCalled();
    fireEvent.click(within(edit).getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(projectDelete).toHaveBeenCalledWith(P2.id, expect.any(String)));
    await waitFor(() => expect(router.getState().route).toEqual({ name: 'todos', tab: 'projects' }));
  });

  it('offline: the status control is off and sends nothing', async () => {
    const projectUpdate = vi.fn(async () => ({ ok: true as const }));
    render({ path: `/todos?project=${P1.id}`, api: { projectUpdate }, conn: 'offline' });
    await heading('🛠 Example project 50');
    const paused = screen.getByRole('button', { name: 'Paused' });
    expect((paused.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    fireEvent.click(paused);
    await act(async () => undefined);
    expect(projectUpdate).not.toHaveBeenCalled();
    expect(screen.getByText('Offline: changes need your Mac')).toBeTruthy();
  });

  it('says a project that is not there is gone', async () => {
    render({ path: `/todos?project=${id(99)}` });
    expect(await screen.findByText('This project is gone.')).toBeTruthy();
    await heading('Project');
  });
});
