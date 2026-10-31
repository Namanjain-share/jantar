/**
 * Today (v0.4 spec 5.2, 5.10; gate LW5) against the fake API: every
 * section shows only while its module is on, and only with something in it
 * (FOOD and CLAUDE always); every state renders with the <h1>; Done on a
 * due todo offers a 5 s Undo; `?dose=` opens WP-MD's DoseSheet for that
 * dose; the push warning shows when no device would get a medicine ping.
 *
 * WP-MD's MedsToday and DoseSheet are stand-ins here, so the test pins
 * what Today hands them whatever WP-MD's real ones render.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Bill, LifeStatus, MedsDay, Today, Todo } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import { formatAmount } from '../src/lib/money.js';
import { NO_PUSH, NO_PUSH_DEVICES, NO_PUSH_SWITCH } from '../src/ui/screens/life/shared/PushWarning.js';
import { lifeClockAt } from '../src/ui/screens/life/today/parts.js';
import { fakeApi, iso, pending, renderApp, session, stateWith } from './helpers.js';

const seen = vi.hoisted(() => ({ meds: [] as unknown[], dose: [] as unknown[] }));

vi.mock('../src/ui/screens/life/meds/MedsToday.js', async () => {
  const { createElement } = await import('react');
  return {
    MedsToday: (p: { data: MedsDay; onChanged: () => void }) => {
      seen.meds.push(p.data);
      return createElement('button', { 'data-testid': 'meds-today', onClick: p.onChanged }, `meds ${p.data.day}`);
    },
  };
});
vi.mock('../src/ui/screens/life/meds/DoseSheet.js', async () => {
  const { createElement } = await import('react');
  return {
    DoseSheet: (p: { medId: string; slot: string; day: string; onClose: () => void }) => {
      seen.dose.push({ medId: p.medId, slot: p.slot, day: p.day });
      return createElement('button', { 'data-testid': 'dose-sheet', onClick: p.onClose }, `dose ${p.medId} ${p.slot} ${p.day}`);
    },
  };
});

const DAY = '2026-01-15';
const id = (n: number) => `01JFZ8X8Y3T0V5G9WQK2M4N${String(n).padStart(3, '0')}`;

function status(over: Partial<LifeStatus> = {}): LifeStatus {
  return {
    open: true,
    timezone: 'UTC',
    today: DAY,
    currency: 'INR',
    lockScreenDetails: false,
    modules: { todos: true, medicines: true, food: true, places: false, finance: true },
    estimate: { available: false },
    backups: { last: null, count: 0 },
    push: { devices: 1, webpush: true },
    ...over,
  };
}

function todo(n: number, over: Partial<Todo> = {}): Todo {
  return { id: id(n), title: `Example todo ${n}`, priority: 'normal', createdAt: iso(0), updatedAt: iso(0), ...over };
}

function bill(n: number, over: Partial<Bill> = {}): Bill {
  return { id: id(n), name: `Example Stream ${n}`, amount: 64_900, category: 'Bills', repeat: 'monthly', nextDue: '2026-01-17', createdAt: iso(0), updatedAt: iso(0), ...over };
}

const meds: MedsDay = {
  day: DAY,
  today: DAY,
  groups: [{ period: 'morning', items: [{ medId: id(90), name: 'Testamol', dose: '500 mg', slot: '08:00', status: 'pending', overdue: true }] }],
};

function today(over: Partial<Today> = {}): Today {
  return {
    day: DAY,
    meds,
    todos: { overdue: [todo(1, { due: { day: '2026-01-14' } })], today: [todo(2, { due: { day: DAY, time: '18:00' } })] },
    food: { kcal: 1240, target: 2000, weight: { day: '2026-01-14', kg: 72.4 } },
    bills: [bill(3)],
    ...over,
  };
}

function render(opts: { today?: Today | (() => Promise<Today>); status?: LifeStatus; path?: string; state?: Parameters<typeof stateWith>[0]; api?: Parameters<typeof fakeApi>[0]; conn?: 'live' | 'offline' } = {}) {
  const t = opts.today ?? today();
  const api = fakeApi({
    lifeStatus: vi.fn(async () => opts.status ?? status()),
    lifeToday: typeof t === 'function' ? vi.fn(t) : vi.fn(async () => t),
    ...opts.api,
  });
  return renderApp({ path: opts.path ?? '/today', api, state: stateWith({ features: { life: true }, ...opts.state }), ...(opts.conn ? { status: opts.conn } : {}) });
}

const heading = () => screen.findByRole('heading', { level: 1, name: 'Today' });
const section = (name: string) => screen.findByRole('region', { name });

describe('Today: states', () => {
  it('shows its title while loading and after a failure, with Try again', async () => {
    let fail!: (e: unknown) => void;
    render({ today: () => new Promise<Today>((_, rej) => (fail = rej)) });
    await heading();
    // The <h1> can paint before the effect that calls the loader has run.
    await waitFor(() => expect(fail).toBeTypeOf('function'));
    // The skeleton, and after 150 ms its caption.
    expect(await screen.findByText('Asking the Mac…')).toBeTruthy();
    await act(async () => fail(new ApiError('internal', 'Something broke on the Mac.', 500)));
    expect(await screen.findByText('Something broke on the Mac.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Today' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('says Life is broken with the restore command in mono, and no retry', async () => {
    render({ today: async () => Promise.reject(new ApiError('life_unavailable', 'Life data could not be opened. The file is untouched. Restore a backup at your Mac: jantar life restore <file>', 503)) });
    expect((await screen.findByText('jantar life restore <file>')).tagName).toBe('CODE');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await heading();
  });

  it('says so when this device has no control scope', async () => {
    render({ today: async () => Promise.reject(new ApiError('forbidden', 'this device does not have the control scope', 403)) });
    expect(await screen.findByText(/Life needs control access/)).toBeTruthy();
  });

  it('shows the day in mono beside the title', async () => {
    render();
    await heading();
    expect((await screen.findByText('Thu 15 Jan')).className).toContain('type-mono');
  });
});

describe('Today: the push warning (LW5)', () => {
  it('shows with no device subscribed while medicines are on', async () => {
    render({ status: status({ push: { devices: 0, webpush: true } }) });
    expect(await screen.findByText(NO_PUSH)).toBeTruthy();
    expect(screen.getByText(NO_PUSH_DEVICES)).toBeTruthy();
  });

  it('shows with Web Push switched off at the Mac', async () => {
    render({ status: status({ push: { devices: 3, webpush: false } }) });
    expect(await screen.findByText(NO_PUSH_SWITCH)).toBeTruthy();
  });

  it('does not show when a device would ring, or while medicines are off', async () => {
    const a = render();
    await screen.findByText('Example todo 1');
    expect(screen.queryByText(NO_PUSH)).toBeNull();
    a.unmount();
    render({ status: status({ push: { devices: 0, webpush: true }, modules: { todos: true, medicines: false, food: false, places: false, finance: false } }), today: today({ meds: undefined }) });
    await screen.findByText('Example todo 1');
    expect(screen.queryByText(NO_PUSH)).toBeNull();
  });
});

describe('Today: sections', () => {
  it('hands the day checklist to MedsToday, which reloads Today after a dose', async () => {
    const { api } = render();
    fireEvent.click(await screen.findByTestId('meds-today'));
    expect(seen.meds.at(-1)).toEqual(meds);
    await waitFor(() => expect(api.lifeToday).toHaveBeenCalledTimes(2));
  });

  it('says "No medicines today." when none is due, and "Nothing due today." with no todos', async () => {
    render({ today: today({ meds: { day: DAY, today: DAY, groups: [] }, todos: { overdue: [], today: [] } }) });
    expect(await screen.findByText('No medicines today.')).toBeTruthy();
    expect(screen.getByText('Nothing due today.')).toBeTruthy();
  });

  it('lists overdue todos first (ember) then today, with the time in mustard', async () => {
    render();
    const due = await section('Due');
    const items = within(due).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-todo'))).toEqual([id(1), id(2)]);
    const late = within(items[0]!).getByText('overdue 1d');
    expect(late.className).toContain('text-signal-text');
    expect(within(items[1]!).getByText('18:00').className).toContain('text-jup-text');
    expect(within(items[1]!).queryByText(/overdue/)).toBeNull();
  });

  it("turns one of today's todos overdue once its time has passed, without a reload", async () => {
    // The reply came before 10:00; the clock now says 10:05.
    render({ today: today({ todos: { overdue: [], today: [todo(4, { due: { day: DAY, time: '10:00' } })] } }) });
    const due = await section('Due');
    expect(within(due).getByText('overdue').className).toContain('text-signal-text');
  });

  it("edits a todo's project from the Mac's list, whatever the chips' cache holds", async () => {
    const P = { id: id(60), name: 'Example project 60', status: 'active' as const, open: 1, overdue: 0, createdAt: iso(0), updatedAt: iso(0) };
    const projectsList = vi.fn(async () => ({ projects: [P] }));
    render({ today: today({ todos: { overdue: [], today: [todo(6, { due: { day: DAY }, projectId: P.id })] } }), api: { projectsList } });
    fireEvent.click(await screen.findByText('Example todo 6'));
    const sheet = await screen.findByRole('dialog', { name: 'Edit todo' });
    await waitFor(() => expect((within(sheet).getByLabelText('Project') as HTMLSelectElement).value).toBe(P.id));
    expect(projectsList).toHaveBeenCalled();
  });

  it('marks a todo done with a 5 s Undo that puts it back', async () => {
    const todoDone = vi.fn(async () => ({ ok: true as const }));
    render({ api: { todoDone } });
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done: Example todo 2' }));
    await waitFor(() => expect(todoDone).toHaveBeenCalledWith(id(2), true));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(todoDone).toHaveBeenCalledWith(id(2), false));
  });

  it('undoes a repeating todo by putting its old due day back', async () => {
    const todoDone = vi.fn(async () => ({ ok: true as const }));
    const todoUpdate = vi.fn(async () => ({ ok: true as const }));
    const rep = todo(5, { due: { day: DAY, time: '09:00' }, repeat: { freq: 'daily' } });
    render({ today: today({ todos: { overdue: [rep], today: [] } }), api: { todoDone, todoUpdate } });
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done: Example todo 5' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(todoUpdate).toHaveBeenCalledWith(id(5), { due: { day: DAY, time: '09:00' } }));
    expect(todoDone).toHaveBeenCalledTimes(1);
  });

  it('shows a failed Done as Not saved', async () => {
    const todoDone = vi.fn(async (): Promise<never> => {
      throw new ApiError('not_found', 'That todo is gone.', 404);
    });
    render({ api: { todoDone } });
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done: Example todo 2' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Not saved. That todo is gone.');
  });

  it('lists bills due soon in the currency, and leaves BILLS out with none', async () => {
    const a = render();
    const bills = await section('Bills');
    expect(within(bills).getByText('Example Stream 3')).toBeTruthy();
    expect(within(bills).getByText(formatAmount(64_900, 'INR'))).toBeTruthy();
    a.unmount();
    render({ today: today({ bills: [] }) });
    await screen.findByText('Example todo 1');
    expect(screen.queryByRole('region', { name: 'Bills' })).toBeNull();
  });

  it('opens a bill in Finance', async () => {
    const { router } = render();
    fireEvent.click(await screen.findByText('Example Stream 3'));
    expect(router.getState().route).toEqual({ name: 'money', bill: id(3) });
  });

  it('shows calories against the target and the latest weight, and + opens the add sheet', async () => {
    render();
    const food = await section('Food');
    expect(within(food).getByText('1,240 / 2,000 kcal')).toBeTruthy();
    expect(within(food).getByText('72.4 kg · Wed 14 Jan')).toBeTruthy();
    fireEvent.click(within(food).getByRole('button', { name: 'Add food' }));
    expect(await screen.findByRole('dialog', { name: 'Add food' })).toBeTruthy();
  });

  it('leaves out the sections of modules that are off', async () => {
    render({
      status: status({ modules: { todos: false, medicines: false, food: false, places: true, finance: false } }),
      today: { day: DAY },
    });
    await heading();
    await screen.findByRole('region', { name: 'Claude' });
    for (const name of ['Medicines', 'Due', 'Bills', 'Food']) expect(screen.queryByRole('region', { name })).toBeNull();
  });

  it('says how many sessions need you, and the row opens the Board', async () => {
    const sessions = [session('a', { status: 'waiting' }), session('b', { status: 'idle' }), session('c')];
    const { router } = render({ state: { sessions, pending: [pending('c')] } });
    const claude = await section('Claude');
    const link = within(claude).getByRole('link', { name: /2 sessions need you/ });
    fireEvent.click(link);
    expect(router.getState().route).toEqual({ name: 'board' });
  });

  it('says no session needs you when none does', async () => {
    render({ state: { sessions: [session('a', { status: 'idle' })] } });
    expect(await screen.findByText('No session needs you')).toBeTruthy();
  });

  it('lists the modules that are on, and the shelf while it is on', async () => {
    render({ state: { features: { life: true, intel: true } } });
    const life = await section('Life');
    await waitFor(() => expect(within(life).getAllByRole('link').map((l) => l.textContent)).toEqual(['Todos', 'Medicines', 'Food', 'Finance', 'Intel']));
  });
});

describe('Today: a medicine push (?dose=)', () => {
  it('opens the dose sheet for that medicine, slot and today', async () => {
    const { router } = render({ path: `/today?dose=${id(90)}@0800` });
    const sheet = await screen.findByTestId('dose-sheet');
    expect(seen.dose.at(-1)).toEqual({ medId: id(90), slot: '08:00', day: DAY });
    fireEvent.click(sheet);
    expect(router.getState().route).toEqual({ name: 'today' });
    expect(screen.queryByTestId('dose-sheet')).toBeNull();
  });

  it("opened after midnight, a late dose's sheet is for last night, not today", async () => {
    // 10:05 UTC is 00:05 on the 16th in Pacific/Kiritimati (UTC+14).
    const next = '2026-01-16';
    render({ path: `/today?dose=${id(90)}@2300`, status: status({ timezone: 'Pacific/Kiritimati', today: next }), today: today({ day: next, meds: { ...meds, day: next, today: next } }) });
    await screen.findByTestId('dose-sheet');
    expect(seen.dose.at(-1)).toEqual({ medId: id(90), slot: '23:00', day: DAY });
  });

  it('opens no sheet for a key that is not a dose', async () => {
    render({ path: `/today?dose=nope@0800` });
    await section('Medicines');
    expect(screen.queryByTestId('dose-sheet')).toBeNull();
  });
});

describe('the Life clock', () => {
  const at = (s: string) => Date.parse(s);

  it("takes the daemon's day while the Life zone is unknown", () => {
    expect(lifeClockAt(at('2026-01-16T00:01:00Z'), null, DAY).day).toBe(DAY);
  });

  it('moves to the new day past midnight on a screen left open', () => {
    expect(lifeClockAt(at('2026-01-16T00:01:00Z'), status(), DAY)).toEqual({ day: '2026-01-16', hhmm: '00:01' });
    expect(lifeClockAt(at('2026-01-16T00:01:00Z'), status({ timezone: 'Asia/Kolkata' }), DAY)).toEqual({ day: '2026-01-16', hhmm: '05:31' });
  });

  it("keeps the daemon's day when the phone's clock is a little behind it", () => {
    expect(lifeClockAt(at('2026-01-15T23:59:50Z'), status(), '2026-01-16')).toEqual({ day: '2026-01-16', hhmm: '23:59' });
  });
});

describe('Today: offline', () => {
  it('keeps the last list and turns Done and add off', async () => {
    render({ conn: 'offline' });
    const done = (await screen.findByRole('button', { name: 'Mark done: Example todo 1' })) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Add food' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Offline: changes need your Mac')).toBeTruthy();
  });
});
