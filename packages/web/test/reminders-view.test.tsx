/**
 * The Reminders view (v0.4 spec 1.2, 5.3): a reminder is a todo with a
 * time. The tab lists the open todos that have one, by when they ring,
 * with an alarm and the time in mustard, the repeat icon on repeating ones
 * and overdue ones in ember; + opens the todo sheet with the time first,
 * at the next full hour on the Life clock. Same rows and actions.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LifeStatus, Todo } from '@jantar/protocol';
import { nextFullHour, remindersOf } from '../src/ui/screens/life/todos/model.js';
import { clockIn } from '../src/ui/screens/life/today/parts.js';
import { fakeApi, iso, renderApp, stateWith } from './helpers.js';

const DAY = '2026-01-15';
const id = (n: number) => `01JFZ8X8Y3T0V5G9WQK2M4N${String(n).padStart(3, '0')}`;

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
  return { id: id(n), title: `Example reminder ${n}`, priority: 'normal', createdAt: iso(n), updatedAt: iso(n), ...over };
}

// NOW is 2026-01-15 10:05 UTC.
const TODOS: Todo[] = [
  todo(1, { due: { day: '2026-01-14', time: '21:00' } }),
  todo(2, { due: { day: DAY } }),
  todo(3, { due: { day: '2026-01-16', time: '08:00' }, repeat: { freq: 'daily' } }),
  todo(4, { due: { day: DAY, time: '17:30' } }),
  todo(5),
];

function render(todos: Todo[] = TODOS, api: Parameters<typeof fakeApi>[0] = {}) {
  return renderApp({
    path: '/todos?tab=reminders',
    api: fakeApi({ lifeStatus: vi.fn(async () => status), todosList: vi.fn(async () => ({ today: DAY, todos })), projectsList: vi.fn(async () => ({ projects: [] })), ...api }),
    state: stateWith({ features: { life: true } }),
  });
}

const row = (n: number) => document.querySelector(`[data-todo="${id(n)}"]`) as HTMLElement;

describe('Reminders', () => {
  it('lists only open todos with a time, in the order they ring', async () => {
    render();
    const list = await screen.findByRole('list', { name: 'Reminders' });
    expect(within(list).getAllByRole('listitem').map((li) => li.getAttribute('data-todo'))).toEqual([id(1), id(4), id(3)]);
    expect(screen.queryByText('Example reminder 2')).toBeNull();
    expect(screen.queryByText('Example reminder 5')).toBeNull();
  });

  it('shows the alarm and the time in mustard, the day, the repeat icon, and overdue ones in ember', async () => {
    render();
    await screen.findByRole('list', { name: 'Reminders' });
    const time = within(row(4)).getByText('17:30');
    expect(time.className).toContain('text-jup-text');
    expect(time.querySelector('svg')).toBeTruthy();
    expect(within(row(4)).getByText('Today')).toBeTruthy();
    expect(within(row(3)).getByText('Tomorrow')).toBeTruthy();
    expect(within(row(3)).getByText('repeats')).toBeTruthy();
    expect(within(row(1)).getByText('overdue 1d').className).toContain('text-signal-text');
    expect(row(4).querySelector('.text-signal-text')).toBeNull();
  });

  it('has the same actions as the Todos tab', async () => {
    const todoSnooze = vi.fn(async () => ({ ok: true as const }));
    const todoDone = vi.fn(async () => ({ ok: true as const }));
    render(TODOS, { todoSnooze, todoDone });
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Example reminder 4' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Tonight' }));
    await waitFor(() => expect(todoSnooze).toHaveBeenCalledWith(id(4), 'tonight'));
    fireEvent.click(screen.getByRole('button', { name: 'Mark done: Example reminder 1' }));
    await waitFor(() => expect(todoDone).toHaveBeenCalledWith(id(1), true));
  });

  it('says what a reminder is when there are none', async () => {
    render([todo(2, { due: { day: DAY } })]);
    expect(await screen.findByText('No reminders yet. A todo with a time is a reminder.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Add reminder' })).toHaveLength(2);
  });

  it('+ starts a reminder with the time first, at the next full hour', async () => {
    const todoCreate = vi.fn(async () => ({ id: id(60) }));
    render(TODOS, { todoCreate });
    await screen.findByRole('list', { name: 'Reminders' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add reminder' })[0]!);
    const sheet = await screen.findByRole('dialog', { name: 'New reminder' });
    const day = within(sheet).getByLabelText('Due day') as HTMLInputElement;
    const time = within(sheet).getByLabelText('Due time') as HTMLInputElement;
    expect(day.value).toBe(DAY);
    expect(time.value).toBe('11:00');
    // The time comes before the title.
    expect(time.compareDocumentPosition(within(sheet).getByLabelText('Title')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(within(sheet).getByLabelText('Title'), { target: { value: 'Take the example out' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add reminder' }));
    await waitFor(() => expect(todoCreate).toHaveBeenCalledWith({ title: 'Take the example out', priority: 'normal', due: { day: DAY, time: '11:00' } }, expect.any(String)));
  });
});

describe('the Reminders model', () => {
  it('orders by day and time and leaves out done and untimed todos', () => {
    const done = todo(9, { due: { day: DAY, time: '06:00' }, doneAt: iso(1) });
    expect(remindersOf([...TODOS, done]).map((t) => t.id)).toEqual([id(1), id(4), id(3)]);
  });

  it('takes the next full hour, rolling past midnight', () => {
    expect(nextFullHour({ day: DAY, hhmm: '10:05' })).toEqual({ day: DAY, time: '11:00' });
    expect(nextFullHour({ day: DAY, hhmm: '09:00' })).toEqual({ day: DAY, time: '10:00' });
    expect(nextFullHour({ day: '2026-01-31', hhmm: '23:30' })).toEqual({ day: '2026-02-01', time: '00:00' });
  });

  it('reads the Life clock in the Life zone', () => {
    const t = Date.parse('2026-01-15T20:00:00Z');
    expect(clockIn(t, 'UTC')).toEqual({ day: '2026-01-15', hhmm: '20:00' });
    expect(clockIn(t, 'Asia/Kolkata')).toEqual({ day: '2026-01-16', hhmm: '01:30' });
    expect(clockIn(t, 'America/New_York')).toEqual({ day: '2026-01-15', hhmm: '15:00' });
  });
});
