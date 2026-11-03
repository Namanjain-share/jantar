/**
 * 0.12: v0.11 People's rows on his Today in the wide layouts, with a
 * synthetic person (Asha) and a fake People client.
 *
 * - On a phone, and in a pane under 640, the rows sit on top of Today's
 *   list, as in 0.11.
 * - From 640 they are the Accountability partner card, first by default,
 *   with its link to People; Edit cards lists it (and moves and hides it)
 *   only while People is on.
 * - Nobody sharing: no card and no rows.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LifeStatus, Today } from '@jantar/protocol';
import type { PersonToday, PersonView } from '@jantar/protocol/people';
import { presetAgreement } from '@jantar/protocol/people-core';
import type { PeopleClient } from '../../src/ui/screens/people/client.js';
import { fakeApi, measureAs, preloadPlaces, renderApp, stateWith } from '../helpers.js';

preloadPlaces('today');

const PID = '01JASHAAAAAAAAAAAAAAAAAAAA';
const DAY = '2026-01-15';

const fake = vi.hoisted(() => ({ people: [] as unknown[] }));

vi.mock('../../src/ui/screens/people/client.js', async (orig) => {
  const real = await orig<typeof import('../../src/ui/screens/people/client.js')>();
  const c = {
    list: async () => ({ enabled: true, people: fake.people }),
    today: async (): Promise<PersonToday> => ({
      day: DAY,
      name: 'Asha',
      state: 'active',
      todos: { open: 0, overdue: 0, due: [] },
      meds: null,
      weight: { latest: null },
      food: null,
      plan: { locked: true },
      status: { level: 'low', line: 'long day', at: '2026-01-15T08:00:00.000Z', until: '2026-01-15T20:00:00.000Z' },
      review: null,
      sleep: { open: null },
      concerns: [],
    }),
  } as unknown as PeopleClient;
  return { ...real, peopleClient: () => c };
});

const asha = (): PersonView =>
  ({ id: PID, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, invite: null, agreement: { ...presetAgreement('everything', 'P2'), version: 1 }, offer: null, pendingProposal: null }) as PersonView;

const status = (): LifeStatus => ({
  open: true,
  timezone: 'UTC',
  today: DAY,
  currency: 'INR',
  lockScreenDetails: false,
  modules: { todos: true, medicines: false, food: false, places: false, finance: false, posts: false },
  estimate: { available: false },
  backups: { last: null, count: 0 },
  push: { devices: 1, webpush: true },
});

const today = (): Today => ({ day: DAY, todos: { overdue: [], today: [] } });

function render(features: { people: boolean }) {
  const api = fakeApi({ lifeStatus: vi.fn(async () => status()), lifeToday: vi.fn(async () => today()) });
  return renderApp({ path: '/today', api, state: stateWith({ features: { life: true, ...features } }) });
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  fake.people = [];
});

describe('his Today with someone sharing', () => {
  it('a phone: her row on top of the list, a tap opens her Today tab', async () => {
    fake.people = [asha()];
    render({ people: true });
    const rows = await screen.findByRole('list', { name: 'Accountability partner' });
    expect(within(rows).getByRole('button').textContent).toBe('Accountability partner Asha · Low');
    expect(document.querySelector('[data-card]')).toBeNull();
  });

  it('from 640: the Accountability partner card, first, with its link to People', async () => {
    measureAs(1352);
    fake.people = [asha()];
    render({ people: true });
    const card = await screen.findByRole('region', { name: 'Accountability partner' });
    expect(card.getAttribute('data-card')).toBe('people');
    expect(within(card).getByRole('button', { name: /Asha · Low/ })).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Open Accountability partner' }).getAttribute('href')).toBe('/people');
    await screen.findByRole('region', { name: 'Due' });
    expect(document.querySelectorAll('[data-card]')[0]?.getAttribute('data-card')).toBe('people');
    // Not also on top of the cards.
    expect(screen.getAllByRole('list', { name: 'Accountability partner' })).toHaveLength(1);
  });

  it('Edit cards lists it while People is on, and hides it like any card', async () => {
    measureAs(1352);
    fake.people = [asha()];
    render({ people: true });
    await screen.findByRole('region', { name: 'Accountability partner' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit cards' }));
    const edit = screen.getByRole('region', { name: 'Edit cards' });
    expect(within(edit).getAllByRole('button', { name: /^Move / })[0]!.getAttribute('aria-label')).toBe('Move Accountability partner');
    fireEvent.click(within(edit).getByRole('switch', { name: 'Accountability partner' }));
    fireEvent.click(within(edit).getByRole('button', { name: 'Done' }));
    await screen.findByRole('region', { name: 'Due' });
    expect(screen.queryByRole('region', { name: 'Accountability partner' })).toBeNull();
  });

  it('People off: no card, no rows, and Edit cards does not list it', async () => {
    measureAs(1352);
    render({ people: false });
    await screen.findByRole('region', { name: 'Due' });
    expect(screen.queryByRole('region', { name: 'Accountability partner' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit cards' }));
    const edit = screen.getByRole('region', { name: 'Edit cards' });
    await waitFor(() => expect(within(edit).queryByRole('button', { name: 'Move Accountability partner' })).toBeNull());
  });
});
