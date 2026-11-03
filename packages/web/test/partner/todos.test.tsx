/**
 * v0.11 People: her to-dos keep the promises his Assign sheet and her join
 * page make (spec 2.5, 3.1, 4.4), against a fake client with synthetic data.
 *
 * - "You see both on the item": an open item he assigned says "asks for a
 *   short report" and "Sam asked to know by 08:45"; once done, her report.
 * - A tick on an item that asks for a report opens the report sheet (Save
 *   note, or Done without a note), on To-do and on Today alike.
 * - The To-do page's Undo is the shared 5-second toast: it closes itself.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { presetAgreement } from '@jantar/protocol/people-core';
import type { PersonMe, PersonOwnToday, PersonTodo } from '@jantar/protocol/people';
import type { PersonApi } from '../../src/partner/api.js';
import { TodoRow, todoSubline } from '../../src/partner/screens/TodoRow.js';
import { Todos } from '../../src/partner/screens/Todos.js';
import { Today } from '../../src/partner/screens/Today.js';

const DAY = '2026-11-03';
const AT = '2026-11-03T08:00:00.000Z';
const ASHA = '01JASHAAAAAAAAAAAAAAAAAAAA';
const CV = '01JTODOAAAAAAAAAAAAAAAAAA1';

function me(): PersonMe {
  return {
    person: { id: ASHA, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, prefs: {} as PersonMe['person']['prefs'] },
    owner: { name: 'Sam' },
    peopleOn: true,
    agreement: { ...presetAgreement('everything', 'P2'), version: 1 } as PersonMe['agreement'],
    pending: null,
    ownerDevices: [],
    built: 'P2',
    lifeBroken: false,
  } as PersonMe;
}

const todo = (over: Partial<PersonTodo> = {}): PersonTodo => ({
  id: CV,
  title: 'Send CV',
  priority: 'normal',
  by: '',
  ask: 'report',
  followUp: '08:45',
  due: { day: '2026-11-04' },
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

function fakeApi(over: Partial<PersonApi> = {}): PersonApi {
  const base: Partial<PersonApi> = {};
  return new Proxy(base as PersonApi, {
    get: (_t, k: string) => (k in over ? (over as Record<string, unknown>)[k] : (base as Record<string, unknown>)[k] ?? ((base as Record<string, unknown>)[k] = vi.fn(async () => ({})))),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('her to-do row says what he asked', () => {
  it('an open item shows "asks for a short report" and when he asked to know by; a done one shows her report instead', () => {
    expect(todoSubline(todo(), 'Sam')).toBe('Wed 4 Nov · From Sam · asks for a short report · Sam asked to know by 08:45');
    expect(todoSubline(todo({ doneAt: AT, report: 'Sent to two places' }), 'Sam')).toBe('Wed 4 Nov · From Sam · "Sent to two places"');
    expect(todoSubline(todo({ ask: 'none', followUp: undefined, by: ASHA }), 'Sam')).toBe('Wed 4 Nov');
    render(
      <ul>
        <TodoRow t={todo()} owner="Sam" onDone={() => {}} />
      </ul>,
    );
    expect(screen.getByText(/Sam asked to know by 08:45/)).toBeTruthy();
    expect(screen.getByText(/asks for a short report/)).toBeTruthy();
  });

  it('a tick on an item asking for a report opens the sheet: Save note sends it, Done without a note sends none; other ticks are one tap', () => {
    const onDone = vi.fn();
    const r = render(
      <ul>
        <TodoRow t={todo()} owner="Sam" onDone={onDone} />
      </ul>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Done: Send CV' }));
    expect(onDone).not.toHaveBeenCalled();
    const sheet = screen.getByRole('dialog', { name: 'Done: Send CV' });
    const save = within(sheet).getByRole('button', { name: 'Save note' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText('A short note for Sam (optional)'), { target: { value: ' Sent to two places ' } });
    fireEvent.click(save);
    expect(onDone).toHaveBeenLastCalledWith(true, 'Sent to two places');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done: Send CV' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Done without a note' }));
    expect(onDone).toHaveBeenLastCalledWith(true, undefined);
    r.rerender(
      <ul>
        <TodoRow t={todo({ ask: 'none' })} owner="Sam" onDone={onDone} />
      </ul>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Done: Send CV' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onDone).toHaveBeenLastCalledWith(true);
  });
});

describe('her To-do page', () => {
  it('sends her report with the tick, and its Undo is the shared 5-second toast', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const done = vi.fn(async () => undefined);
    const api = fakeApi({ todos: vi.fn(async () => ({ today: DAY, todos: [todo()] })), done });
    render(<Todos me={me()} api={api} tick={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Done: Send CV' }));
    const sheet = screen.getByRole('dialog', { name: 'Done: Send CV' });
    fireEvent.change(within(sheet).getByLabelText('A short note for Sam (optional)'), { target: { value: 'Sent' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(done).toHaveBeenCalledWith(CV, true, 'Sent'));
    expect((await screen.findByRole('status')).textContent).toContain('Done: Send CV');
    // Undo works while it shows...
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(done).toHaveBeenLastCalledWith(CV, false));
    // ...and a later tick's toast closes itself after 5 seconds.
    fireEvent.click(screen.getByRole('button', { name: 'Done: Send CV' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Done without a note' }));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(5_100);
    });
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});

describe('her Today', () => {
  it('a to-do there asking for a report opens the same sheet, then shows Undo', async () => {
    const done = vi.fn(async () => undefined);
    const t: PersonOwnToday = {
      day: DAY,
      today: DAY,
      meds: null,
      todos: [todo()],
      overdue: 0,
      plan: { day: DAY, plan: null, now: null, next: null, late: [], focus: null, slots: {}, counts: { done: 0, total: 0 } },
      status: null,
      review: null,
      sleep: { open: null, showStart: false, askWake: null },
      sharingCheckin: false,
      alertsUnseen: 0,
      prompt: 'What went well today?',
    };
    const api = fakeApi({ today: vi.fn(async () => t), done });
    render(<Today me={me()} api={api} reload={() => {}} tick={0} />);
    expect(await screen.findByText(/Sam asked to know by 08:45/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done: Send CV' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Done: Send CV' })).getByRole('button', { name: 'Done without a note' }));
    await waitFor(() => expect(done).toHaveBeenCalledWith(CV, true, undefined));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeTruthy();
  });
});

describe('her To-do: add with a day and time, and each item\'s sheet (spec 3.3)', () => {
  const MINE = '01JTODOAAAAAAAAAAAAAAAAAA2';
  const hers = (over: Partial<PersonTodo> = {}) => todo({ id: MINE, title: 'Call the bank', by: ASHA, ask: 'none', followUp: undefined, due: { day: DAY, time: '10:00' }, ...over });

  it('adds a to-do with a day and a time (her own reminder); the time waits for a day', async () => {
    const createTodo = vi.fn(async () => ({ id: MINE }));
    const api = fakeApi({ todos: vi.fn(async () => ({ today: DAY, todos: [] })), createTodo });
    render(<Todos me={me()} api={api} tick={0} />);
    const time = (await screen.findByLabelText('Time: a reminder (optional)')) as HTMLInputElement;
    expect(time.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('New to-do'), { target: { value: ' Call the bank ' } });
    fireEvent.change(screen.getByLabelText('Day (optional)'), { target: { value: '2026-11-05' } });
    expect(time.disabled).toBe(false);
    fireEvent.change(time, { target: { value: '09:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(createTodo).toHaveBeenCalledWith({ title: 'Call the bank', due: { day: '2026-11-05', time: '09:30' } }));
    fireEvent.change(screen.getByLabelText('New to-do'), { target: { value: 'Someday' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(createTodo).toHaveBeenLastCalledWith({ title: 'Someday' }));
  });

  it('his item: Snooze, Skip with a reason chip (and Undo), Ask to change; no Edit or Delete', async () => {
    const snooze = vi.fn(async () => undefined);
    const skip = vi.fn(async () => undefined);
    const ask = vi.fn(async () => undefined);
    const done = vi.fn(async () => undefined);
    const api = fakeApi({ todos: vi.fn(async () => ({ today: DAY, todos: [todo({ ask: 'none' })] })), snooze, skip, ask, done });
    render(<Todos me={me()} api={api} tick={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More for Send CV' }));
    let sheet = screen.getByRole('dialog', { name: 'Send CV' });
    expect(within(sheet).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(sheet).queryByRole('button', { name: 'Delete' })).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Tomorrow' }));
    await waitFor(() => expect(snooze).toHaveBeenCalledWith(CV, 'tomorrow'));
    // His can't be moved back by her: no Undo for a snooze of his.
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'More for Send CV' }));
    sheet = screen.getByRole('dialog', { name: 'Send CV' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Skip' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Not feeling well' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Skip it' }));
    await waitFor(() => expect(skip).toHaveBeenCalledWith(CV, 'Not feeling well'));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(done).toHaveBeenCalledWith(CV, false));

    fireEvent.click(screen.getByRole('button', { name: 'More for Send CV' }));
    sheet = screen.getByRole('dialog', { name: 'Send CV' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Ask to change' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Move it later' }));
    fireEvent.change(within(sheet).getByLabelText('A note for Sam (optional)'), { target: { value: 'after lunch' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send to Sam' }));
    await waitFor(() => expect(ask).toHaveBeenCalledWith(CV, 'Move it later. after lunch'));
  });

  it('Skip says Sam sees the reason while he sees her to-dos, and nothing of the kind while that is off (review 4)', async () => {
    const api = fakeApi({ todos: vi.fn(async () => ({ today: DAY, todos: [todo({ ask: 'none' })] })) });
    const r = render(<Todos me={me()} api={api} tick={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More for Send CV' }));
    let sheet = screen.getByRole('dialog', { name: 'Send CV' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Skip' }));
    expect(within(sheet).getByText('Sam sees the reason you pick or write.')).toBeTruthy();
    r.unmount();

    const off = me();
    off.agreement = { ...(off.agreement as NonNullable<PersonMe['agreement']>), see: { ...(off.agreement as NonNullable<PersonMe['agreement']>).see, todos: false } };
    render(<Todos me={off} api={api} tick={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More for Send CV' }));
    sheet = screen.getByRole('dialog', { name: 'Send CV' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Skip' }));
    expect(within(sheet).queryByText(/sees the reason/)).toBeNull();
  });

  it('no Snooze on an item he marked "no snooze"', async () => {
    const api = fakeApi({ todos: vi.fn(async () => ({ today: DAY, todos: [todo({ snoozable: false })] })) });
    render(<Todos me={me()} api={api} tick={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More for Send CV' }));
    const sheet = screen.getByRole('dialog', { name: 'Send CV' });
    expect(within(sheet).queryByRole('group', { name: 'Snooze' })).toBeNull();
    expect(within(sheet).getByText('Sam marked this "no snooze".')).toBeTruthy();
  });

  it('hers: Edit (title, day, time), Snooze with Undo back to its day, and Delete on a second tap', async () => {
    const updateTodo = vi.fn(async () => undefined);
    const snooze = vi.fn(async () => undefined);
    const deleteTodo = vi.fn(async () => undefined);
    const api = fakeApi({ todos: vi.fn(async () => ({ today: DAY, todos: [hers()] })), updateTodo, snooze, deleteTodo });
    render(<Todos me={me()} api={api} tick={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More for Call the bank' }));
    let sheet = screen.getByRole('dialog', { name: 'Call the bank' });
    expect(within(sheet).queryByRole('button', { name: 'Ask to change' })).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(sheet).getByLabelText('To-do'), { target: { value: 'Call the bank about the card' } });
    fireEvent.change(within(sheet).getByLabelText('Time (optional)'), { target: { value: '11:15' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateTodo).toHaveBeenCalledWith(MINE, { title: 'Call the bank about the card', due: { day: DAY, time: '11:15' } }));

    fireEvent.click(screen.getByRole('button', { name: 'More for Call the bank' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Later 1 h' }));
    await waitFor(() => expect(snooze).toHaveBeenCalledWith(MINE, '1h'));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(updateTodo).toHaveBeenLastCalledWith(MINE, { due: { day: DAY, time: '10:00' } }));

    fireEvent.click(screen.getByRole('button', { name: 'More for Call the bank' }));
    sheet = screen.getByRole('dialog', { name: 'Call the bank' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));
    expect(deleteTodo).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Tap again to delete it for good' }));
    await waitFor(() => expect(deleteTodo).toHaveBeenCalledWith(MINE));
  });

  it('a skipped item says so with its reason; Today\'s rows open the same sheet', async () => {
    expect(todoSubline(todo({ doneAt: AT, skipped: { at: AT, reason: 'Plans changed' }, ask: 'none', followUp: undefined }), 'Sam')).toBe('Wed 4 Nov · From Sam · skipped: Plans changed');
    const t: PersonOwnToday = {
      day: DAY,
      today: DAY,
      meds: null,
      todos: [todo({ ask: 'none' })],
      overdue: 0,
      plan: { day: DAY, plan: null, now: null, next: null, late: [], focus: null, slots: {}, counts: { done: 0, total: 0 } },
      status: null,
      review: null,
      sleep: { open: null, showStart: false, askWake: null },
      sharingCheckin: false,
      alertsUnseen: 0,
      prompt: 'What went well today?',
    };
    const snooze = vi.fn(async () => undefined);
    render(<Today me={me()} api={fakeApi({ today: vi.fn(async () => t), snooze })} reload={() => {}} tick={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More for Send CV' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Send CV' })).getByRole('button', { name: 'Tonight' }));
    await waitFor(() => expect(snooze).toHaveBeenCalledWith(CV, 'tonight'));
  });
});
