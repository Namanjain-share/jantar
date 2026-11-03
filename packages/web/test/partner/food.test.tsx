/**
 * v0.11 People: her food log on her app and his Partner screen (spec 3.5),
 * with synthetic Sam and Asha and fake clients.
 *
 * - Her Health has a Food tab only while her food module is on; `?tab=food`
 *   with it off shows Medicines. The tab logs what she ate (calories
 *   optional), edits, deletes with Undo, one-tap saved foods, her own target,
 *   and says in one line what Sam sees of it.
 * - Her Today: the quick add while the module is on (Undo takes the item
 *   back), nothing while it is off.
 * - Her mirror of his food view draws the same component his screen does.
 * - His Health: her food log at his level (full: items and calories; counts:
 *   how many meals, naming nothing), a locked tile while his level is off,
 *   and no food at all while her module is off. His Today tile follows.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { FoodDay } from '@jantar/protocol';
import { presetAgreement } from '@jantar/protocol/people-core';
import type { OwnerFoodView, PersonMe, PersonOwnToday, PersonToday, PersonView } from '@jantar/protocol/people';
import type { PersonApi } from '../../src/partner/api.js';
import { parsePersonRoute } from '../../src/partner/router.js';
import Health from '../../src/partner/screens/Health.js';
import Mirror from '../../src/partner/screens/Mirror.js';
import { foodSeesLine, kcalOf } from '../../src/partner/screens/FoodAdd.js';
import { Today } from '../../src/partner/screens/Today.js';
import { foodTodayLine } from '../../src/people-shared/FoodRead.js';
import { createRouter, memoryHistory } from '../../src/lib/router.js';
import { createAppStore } from '../../src/store.js';
import { AppProvider, createToastStore } from '../../src/ui/context.js';
import type { PeopleClient } from '../../src/ui/screens/people/client.js';
import { Partner } from '../../src/ui/screens/people/Partner.js';
import { fakeApi as fakeOwnerApi } from '../helpers.js';

const DAY = '2026-11-03';
const AT = '2026-11-03T08:00:00.000Z';
const ASHA = '01JASHAAAAAAAAAAAAAAAAAAAA';
const POHA = '01JF00DAAAAAAAAAAAAAAAAAA1';
const TEA = '01JF00DAAAAAAAAAAAAAAAAAA2';
const DAL = '01JSAVEDAAAAAAAAAAAAAAAAA1';

function fake<T extends object>(over: Partial<T> = {}): T {
  const base: Partial<T> = {};
  return new Proxy(base as T, {
    get: (_t, k: string) => (k in over ? (over as Record<string, unknown>)[k] : (base as Record<string, unknown>)[k] ?? ((base as Record<string, unknown>)[k] = vi.fn(async () => ({})))),
  });
}

function me(food = true, see: 'off' | 'counts' | 'full' = 'full'): PersonMe {
  const a = presetAgreement('everything', 'P3');
  return {
    person: { id: ASHA, name: 'Asha', color: 'teal', state: 'active', modules: { food }, prefs: {} as PersonMe['person']['prefs'] },
    owner: { name: 'Sam' },
    peopleOn: true,
    agreement: { ...a, see: { ...a.see, food: see }, version: 1 } as PersonMe['agreement'],
    pending: null,
    ownerDevices: [],
    built: 'P3',
    lifeBroken: false,
  } as PersonMe;
}

const foodDay = (over: Partial<FoodDay> = {}): FoodDay => ({
  day: DAY,
  today: DAY,
  target: 1800,
  kcal: 320,
  entries: [
    { id: POHA, day: DAY, at: AT, name: 'Poha', kcal: 320, createdAt: AT, updatedAt: AT },
    { id: TEA, day: DAY, at: AT, name: 'Green tea', kcal: 0, createdAt: AT, updatedAt: AT },
  ],
  saved: [{ id: DAL, name: 'Dal', kcal: 250, uses: 3 }],
  weight: { latest: null, change7: null, change30: null, goalKg: null, recent: [] },
  ...over,
});

const ownToday = (food: PersonOwnToday['food']): PersonOwnToday => ({
  day: DAY,
  today: DAY,
  meds: null,
  todos: [],
  overdue: 0,
  plan: { day: DAY, plan: null, now: null, next: null, late: [], focus: null, slots: {}, counts: { done: 0, total: 0 } },
  status: null,
  review: null,
  sleep: { open: null, showStart: false, askWake: null },
  sharingCheckin: false,
  alertsUnseen: 0,
  prompt: 'What went well today?',
  food,
});

describe('her food log (Health › Food)', () => {
  it('routes: ?tab=food&day= parses; Health shows Food only while her food module is on', async () => {
    expect(parsePersonRoute('/p/health', `?tab=food&day=${DAY}`)).toEqual({ name: 'health', tab: 'food', week: null, day: DAY });
    const api = fake<PersonApi>({ meds: vi.fn(async () => ({ day: { day: DAY, groups: [] }, medicines: [] })) as never, food: vi.fn(async () => foodDay()) });
    const off = render(<Health api={api} owner="Sam" tab="food" week={null} food={{ on: false, level: 'off' }} tick={0} />);
    expect(screen.queryByRole('tab', { name: 'Food' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Medicines', selected: true })).toBeTruthy();
    expect(api.food).not.toHaveBeenCalled();
    off.unmount();
    render(<Health api={api} owner="Sam" tab="food" week={null} food={{ on: true, level: 'full' }} tick={0} />);
    expect(screen.getByRole('tab', { name: 'Food', selected: true })).toBeTruthy();
    expect(await screen.findByText('320 of 1800 kcal · 2 meals')).toBeTruthy();
    expect(screen.getByText('Sam sees what you log here, with the calories.')).toBeTruthy();
    // An item logged without calories shows no number.
    const tea = screen.getByText('Green tea').closest('li') as HTMLElement;
    expect(tea.textContent).not.toMatch(/kcal/);
  });

  it('logs what she ate (calories optional), one-tap saved foods, edits, deletes with Undo, and sets her own target', async () => {
    const foodAdd = vi.fn(async () => ({ id: 'NEW' }));
    const foodUpdate = vi.fn(async () => undefined);
    const foodDelete = vi.fn(async () => undefined);
    const foodTargets = vi.fn(async () => undefined);
    const api = fake<PersonApi>({ food: vi.fn(async () => foodDay()), foodAdd, foodUpdate, foodDelete, foodTargets });
    render(<Health api={api} owner="Sam" tab="food" week={null} food={{ on: true, level: 'counts' }} chat tick={0} />);
    expect(await screen.findByText('Sam sees only how many meals you log, never what.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('What did you eat?'), { target: { value: 'Banana' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log' }));
    await waitFor(() => expect(foodAdd).toHaveBeenCalledWith({ day: DAY, name: 'Banana' }));
    fireEvent.change(screen.getByLabelText('What did you eat?'), { target: { value: 'Rice' } });
    fireEvent.change(screen.getByLabelText('Calories (optional)'), { target: { value: 'lots' } });
    expect((screen.getByRole('button', { name: 'Log' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Calories (optional)'), { target: { value: '200' } });
    fireEvent.click(screen.getByLabelText('Keep for one tap'));
    fireEvent.click(screen.getByRole('button', { name: 'Log' }));
    await waitFor(() => expect(foodAdd).toHaveBeenCalledWith({ day: DAY, name: 'Rice', kcal: 200, save: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Dal · 250' }));
    await waitFor(() => expect(foodAdd).toHaveBeenCalledWith({ day: DAY, savedId: DAL }));
    // Edit: calories emptied is none (0).
    fireEvent.click(screen.getByRole('button', { name: 'Edit Poha' }));
    const sheet = screen.getByRole('dialog', { name: 'Edit Poha' });
    fireEvent.change(within(sheet).getByLabelText('Calories (optional)'), { target: { value: '' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(foodUpdate).toHaveBeenCalledWith(POHA, { name: 'Poha', kcal: 0 }));
    // Delete, then Undo logs it again.
    fireEvent.click(screen.getByRole('button', { name: 'Delete Poha' }));
    await waitFor(() => expect(foodDelete).toHaveBeenCalledWith(POHA));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(foodAdd).toHaveBeenCalledWith({ day: DAY, name: 'Poha', kcal: 320 }));
    // Her target is hers.
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    const t = screen.getByRole('dialog', { name: 'Daily target' });
    fireEvent.change(within(t).getByLabelText('Calories a day (800 to 6,000)'), { target: { value: '1600' } });
    fireEvent.click(within(t).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(foodTargets).toHaveBeenCalledWith({ kcalTarget: 1600 }));
    // A photo of a meal goes through her Chat.
    expect(screen.getByRole('link', { name: 'Send it in Chat' }).getAttribute('href')).toBe('/p/chat');
  });

  it('the words: what Sam sees at each level; calories are a whole number or empty', () => {
    expect(foodSeesLine('Sam', 'full')).toBe('Sam sees what you log here, with the calories.');
    expect(foodSeesLine('Sam', 'counts')).toBe('Sam sees only how many meals you log, never what.');
    expect(foodSeesLine('Sam', 'off')).toBe('Sam sees none of your food log.');
    expect([kcalOf(''), kcalOf(' 450 '), kcalOf('4.5'), kcalOf('-1'), kcalOf('10001')]).toEqual([undefined, 450, null, null, null]);
  });
});

describe('her Today: the food quick add', () => {
  it('logs from Today with Undo while her food module is on, and says what Sam sees', async () => {
    const foodAdd = vi.fn(async () => ({ id: POHA }));
    const foodDelete = vi.fn(async () => undefined);
    const api = fake<PersonApi>({ today: vi.fn(async () => ownToday({ meals: 1, kcal: 320, target: 1800 })), foodAdd, foodDelete });
    render(<Today me={me(true, 'counts')} api={api} reload={() => {}} tick={0} />);
    const card = await screen.findByRole('region', { name: 'Food' });
    expect(within(card).getByText(/320 of 1800 kcal · 1 meal/)).toBeTruthy();
    expect(within(card).getByText('Sam sees only how many meals you log, never what.')).toBeTruthy();
    expect(within(card).queryByLabelText('Keep for one tap')).toBeNull();
    fireEvent.change(within(card).getByLabelText('What did you eat?'), { target: { value: 'Poha' } });
    fireEvent.change(within(card).getByLabelText('Calories (optional)'), { target: { value: '320' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Log' }));
    await waitFor(() => expect(foodAdd).toHaveBeenCalledWith({ day: DAY, name: 'Poha', kcal: 320 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(foodDelete).toHaveBeenCalledWith(POHA));
  });

  it('shows no food while her food module is off', async () => {
    const api = fake<PersonApi>({ today: vi.fn(async () => ownToday(null)) });
    render(<Today me={me(false, 'off')} api={api} reload={() => {}} tick={0} />);
    expect(await screen.findByText('Write in your journal · check in')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Food' })).toBeNull();
    expect(screen.queryByLabelText('What did you eat?')).toBeNull();
  });
});

const fullView: OwnerFoodView = {
  level: 'full',
  day: DAY,
  today: DAY,
  target: 1800,
  kcal: 320,
  items: [
    { id: POHA, name: 'Poha', kcal: 320 },
    { id: TEA, name: 'Green tea', kcal: 0 },
  ],
  days: [
    { day: DAY, meals: 2, kcal: 320 },
    { day: '2026-11-02', meals: 0, kcal: 0 },
  ],
};
const countsView: OwnerFoodView = { level: 'counts', day: DAY, today: DAY, meals: 2, days: [{ day: DAY, meals: 2 }] };

describe('her mirror of his food view', () => {
  it('draws exactly his view: full names items, counts names nothing', async () => {
    const r = render(<Mirror me={me()} api={fake<PersonApi>({ mirror: vi.fn(async () => fullView) })} area="food" />);
    expect(await screen.findByText('What Sam sees of your food log')).toBeTruthy();
    expect(await screen.findByText('Today: 320 of 1800 kcal · 2 meals')).toBeTruthy();
    expect(screen.getByText('Poha')).toBeTruthy();
    r.unmount();
    render(<Mirror me={me(true, 'counts')} api={fake<PersonApi>({ mirror: vi.fn(async () => countsView) })} area="food" />);
    expect(await screen.findByText('Today: 2 meals logged')).toBeTruthy();
    expect(screen.queryByText('Poha')).toBeNull();
    expect(screen.getByText('Only how many meals are shared, never what or how much.')).toBeTruthy();
    expect(parsePersonRoute('/p/me', '?tab=sharing&see=food')).toEqual({ name: 'me', tab: 'sharing', see: 'food' });
  });
});

const PID = ASHA;
const person = (see: 'off' | 'counts' | 'full', food = true): PersonView => {
  const a = presetAgreement('everything', 'P3');
  // Only food (and to-dos) shared, so his Health loads nothing else.
  const agreement = { ...a, see: { ...a.see, meds: 'off', weight: false, sleep: false, food: see }, assign: { ...a.assign, meds: false }, editHers: { ...a.editHers, meds: false, weight: false }, version: 1 };
  return { id: PID, name: 'Asha', color: 'teal', state: 'active', modules: { food }, invite: null, agreement, offer: null, pendingProposal: null } as PersonView;
};
const hisToday = (food: PersonToday['food']): PersonToday => ({
  day: DAY,
  name: 'Asha',
  state: 'active',
  todos: { locked: true },
  meds: null,
  weight: { locked: true },
  food,
  plan: { locked: true },
  status: { locked: true },
  review: null,
  sleep: { locked: true },
  concerns: [],
});

function Wrapped({ client: c, tab }: { client: PeopleClient; tab?: string }) {
  const [deps] = useState(() => ({ store: createAppStore(), api: fakeOwnerApi(), router: createRouter(memoryHistory(`/people/${PID}`)), toasts: createToastStore() }));
  return (
    <AppProvider deps={deps}>
      <Partner pid={PID} client={c} {...(tab ? { tab } : {})} />
    </AppProvider>
  );
}

describe('his Partner screen: her food log at his level', () => {
  it('full: Health lists what she ate with calories, and steps back a day; Today has the day line', async () => {
    const food = vi.fn(async () => fullView);
    const c = fake<PeopleClient>({ list: vi.fn(async () => ({ enabled: true, people: [person('full')] })) as never, today: vi.fn(async () => hisToday({ level: 'full', meals: 2, kcal: 320, target: 1800 })), food });
    const r = render(<Wrapped client={c} tab="health" />);
    expect(await screen.findByText('Today: 320 of 1800 kcal · 2 meals')).toBeTruthy();
    expect(screen.getByText('Poha')).toBeTruthy();
    expect(screen.getByText('320 kcal')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '‹ Day before' }));
    await waitFor(() => expect(food).toHaveBeenLastCalledWith(PID, '2026-11-02'));
    r.unmount();
    render(<Wrapped client={c} />);
    expect(await screen.findByText('Food: 2 meals · 320 of 1800 kcal')).toBeTruthy();
  });

  it('counts: how many meals, naming nothing; off: a locked tile; her module off: no food at all', async () => {
    const counts = fake<PeopleClient>({ list: vi.fn(async () => ({ enabled: true, people: [person('counts')] })) as never, today: vi.fn(async () => hisToday({ level: 'counts', meals: 2 })), food: vi.fn(async () => countsView) });
    const r1 = render(<Wrapped client={counts} tab="health" />);
    expect(await screen.findByText('Today: 2 meals logged')).toBeTruthy();
    expect(screen.queryByText('Poha')).toBeNull();
    r1.unmount();
    const food = vi.fn(async () => fullView);
    const off = fake<PeopleClient>({ list: vi.fn(async () => ({ enabled: true, people: [person('off')] })) as never, today: vi.fn(async () => hisToday({ locked: true })), food });
    const r2 = render(<Wrapped client={off} tab="health" />);
    expect(await screen.findByRole('heading', { name: 'Food' })).toBeTruthy();
    expect(screen.getByText('Food: Asha keeps this private')).toBeTruthy();
    expect(food).not.toHaveBeenCalled();
    r2.unmount();
    const none = fake<PeopleClient>({ list: vi.fn(async () => ({ enabled: true, people: [person('off', false)] })) as never, today: vi.fn(async () => hisToday(null)), food });
    render(<Wrapped client={none} tab="health" />);
    expect(await screen.findByRole('heading', { name: 'Sleep' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Food' })).toBeNull();
    expect(food).not.toHaveBeenCalled();
  });

  it('his Today line at each level', () => {
    expect(foodTodayLine({ level: 'full', meals: 3, kcal: 1240, target: 1800 })).toBe('Food: 3 meals · 1240 of 1800 kcal');
    expect(foodTodayLine({ level: 'counts', meals: 1 })).toBe('Food: 1 meal logged');
    expect(foodTodayLine({ level: 'counts', meals: 0 })).toBe('Food: nothing logged yet');
  });
});
