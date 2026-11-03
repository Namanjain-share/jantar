/**
 * v0.11 People (P1, owner Q2/O4, spec 3.5): her weight on both sides, with
 * synthetic people (Sam and Asha) and fake clients.
 *
 * - Hers: log today or an earlier day (never a later one), delete a day
 *   with a 5-second Undo that puts it back, and "Corrected by Sam (was
 *   72.4 kg)" on a weight he corrected.
 * - His (editHers.weight): Correct opens a sheet: Save correction sends
 *   only the new kilograms; Remove needs a second tap. Without
 *   editHers.weight there is no Correct. He never adds a weight for her.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PersonToday, PersonView, PersonWeightsResponse } from '@jantar/protocol/people';
import { presetAgreement } from '@jantar/protocol/people-core';
import type { PersonApi } from '../../src/partner/api.js';
import Health, { correctedLine } from '../../src/partner/screens/Health.js';
import { createRouter, memoryHistory } from '../../src/lib/router.js';
import { createAppStore } from '../../src/store.js';
import { AppProvider, createToastStore } from '../../src/ui/context.js';
import type { PeopleClient } from '../../src/ui/screens/people/client.js';
import { Partner } from '../../src/ui/screens/people/Partner.js';
import { fakeApi as ownerApi } from '../helpers.js';

const PID = '01JASHAAAAAAAAAAAAAAAAAAAA';
const DAY = '2026-11-03';

function fake<T extends object>(over: Partial<T> = {}): T {
  const base: Partial<T> = {};
  return new Proxy(base as T, {
    get: (_t, k: string) => (k in over ? (over as Record<string, unknown>)[k] : (base as Record<string, unknown>)[k] ?? ((base as Record<string, unknown>)[k] = vi.fn(async () => ({})))),
  });
}

const weights = (): PersonWeightsResponse => ({
  weights: [
    { day: DAY, kg: 71.9, correctedBy: '', was: 72.4 },
    { day: '2026-11-01', kg: 72.6 },
  ],
  latest: { day: DAY, kg: 71.9, correctedBy: '', was: 72.4 },
});

describe('her Health › Weight', () => {
  it('logs today or an earlier day, shows "Corrected by Sam (was 72.4 kg)", and deletes with an Undo', async () => {
    const setWeight = vi.fn(async () => undefined);
    const deleteWeight = vi.fn(async () => undefined);
    const api = fake<PersonApi>({ weights: vi.fn(async () => weights()), setWeight, deleteWeight });
    render(<Health api={api} owner="Sam" tab="weight" week={null} tick={0} />);
    expect(await screen.findByText('Corrected by Sam (was 72.4 kg)')).toBeTruthy();
    expect(correctedLine({ day: DAY, kg: 70 }, 'Sam')).toBeNull();
    const day = screen.getByLabelText('Day') as HTMLInputElement;
    expect(day.max).toBe(day.value);
    fireEvent.change(screen.getByLabelText('Weight in kg'), { target: { value: '72,1' } });
    fireEvent.change(day, { target: { value: '2026-10-30' } });
    fireEvent.click(screen.getByRole('button', { name: /^Log for / }));
    await waitFor(() => expect(setWeight).toHaveBeenCalledWith('2026-10-30', 72.1));
    expect(await screen.findByRole('button', { name: 'Log today' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Delete the weight for .*1 Nov/ }));
    await waitFor(() => expect(deleteWeight).toHaveBeenCalledWith('2026-11-01'));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(setWeight).toHaveBeenLastCalledWith('2026-11-01', 72.6));
  });
});

const person = (editWeight: boolean): PersonView => {
  const base = presetAgreement('everything');
  return { id: PID, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, invite: null, agreement: { ...base, editHers: { ...base.editHers, weight: editWeight }, version: 1 }, offer: null, pendingProposal: null } as PersonView;
};
const today = { day: DAY, name: 'Asha', state: 'active', todos: { locked: true }, meds: { locked: true }, weight: { locked: true }, food: null, plan: { locked: true }, status: { locked: true }, review: null, sleep: { locked: true }, concerns: [] } as unknown as PersonToday;

function Wrapped({ client: c }: { client: PeopleClient }) {
  const [deps] = useState(() => ({ store: createAppStore(), api: ownerApi(), router: createRouter(memoryHistory(`/people/${PID}`)), toasts: createToastStore() }));
  return (
    <AppProvider deps={deps}>
      <Partner pid={PID} client={c} tab="health" />
    </AppProvider>
  );
}

describe('his Partner › Health › Weight', () => {
  it('with editHers.weight: Correct sends the new kilograms; Remove needs a second tap', async () => {
    const weightUpdate = vi.fn(async () => undefined);
    const weightDelete = vi.fn(async () => undefined);
    const c = fake<PeopleClient>({
      list: vi.fn(async () => ({ enabled: true, people: [person(true)] })),
      today: vi.fn(async () => today),
      meds: vi.fn(async () => ({ level: 'adherence', pct: null, notLoggedToday: 0, concern: null })),
      weights: vi.fn(async () => weights()),
      sleep: vi.fn(async () => ({ from: '2026-11-02', to: '2026-11-08', nights: [], open: null, avgMinutes: null, trend: null }) as never),
      weightUpdate,
      weightDelete,
    });
    render(<Wrapped client={c} />);
    expect(await screen.findByText(/71.9 kg \(corrected by you, was 72.4 kg\)/)).toBeTruthy();
    const corrects = screen.getAllByRole('button', { name: /^Correct / });
    expect(corrects).toHaveLength(2);
    fireEvent.click(corrects[1]!);
    let sheet = screen.getByRole('dialog');
    const save = within(sheet).getByRole('button', { name: 'Save correction' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText('Kilograms'), { target: { value: '72.2' } });
    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() => expect(weightUpdate).toHaveBeenCalledWith(PID, '2026-11-01', 72.2));
    fireEvent.click(screen.getAllByRole('button', { name: /^Correct / })[0]!);
    sheet = screen.getByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove this weight' }));
    expect(weightDelete).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Tap again to remove it' }));
    });
    await waitFor(() => expect(weightDelete).toHaveBeenCalledWith(PID, DAY));
  });

  it('without editHers.weight: no Correct', async () => {
    const c = fake<PeopleClient>({
      list: vi.fn(async () => ({ enabled: true, people: [person(false)] })),
      today: vi.fn(async () => today),
      meds: vi.fn(async () => ({ level: 'adherence', pct: null, notLoggedToday: 0, concern: null })),
      weights: vi.fn(async () => weights()),
      sleep: vi.fn(async () => ({ from: '2026-11-02', to: '2026-11-08', nights: [], open: null, avgMinutes: null, trend: null }) as never),
    });
    render(<Wrapped client={c} />);
    expect(await screen.findByText(/72.6 kg/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Correct / })).toBeNull();
  });
});
