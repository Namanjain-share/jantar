/**
 * v0.11 People (P4, spec 5; 9.7.4): her shared cafés and lists, and his
 * Lists tab, against fake clients with synthetic people (Sam and Asha).
 *
 * - Her cafés: "Added by", "Edited by", Delete only on her own visits, and
 *   the Confirm "Delete Blue Door for both of you?".
 * - Her lists: "Ticked by Sam · HH:MM" and a tick that calls the route.
 * - His Lists tab: Assign to Asha only with assign.todos; Share on his own
 *   cafés; hostile café and item text stays text (M24).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Place, PlaceDetail } from '@jantar/protocol';
import { presetAgreement } from '@jantar/protocol/people-core';
import type { PersonMe, PersonView, SharedItemsResponse } from '@jantar/protocol/people';
import type { PersonApi } from '../../src/partner/api.js';
import Lists from '../../src/partner/screens/Lists.js';
import { createRouter, memoryHistory } from '../../src/lib/router.js';
import { createAppStore } from '../../src/store.js';
import { AppProvider, createToastStore } from '../../src/ui/context.js';
import type { PeopleClient } from '../../src/ui/screens/people/client.js';
import { Partner } from '../../src/ui/screens/people/Partner.js';
import { fakeApi as ownerFakeApi } from '../helpers.js';

const ASHA = '01JASHAAAAAAAAAAAAAAAAAAAA';
const SID = 's:01JSPACEAAAAAAAAAAAAAAAAAA';
const AT = '2026-11-03T12:20:00.000Z';
const CAFE = '01JCAFEAAAAAAAAAAAAAAAAAAA';
const LIST = '01JLISTAAAAAAAAAAAAAAAAAAA';

function me(): PersonMe {
  return {
    person: { id: ASHA, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, prefs: {} as PersonMe['person']['prefs'] },
    owner: { name: 'Sam' },
    peopleOn: true,
    agreement: { ...presetAgreement('everything', 'P4'), version: 1 },
    pending: null,
    ownerDevices: [],
    built: 'P4',
    lifeBroken: false,
  } as PersonMe;
}

function proxy<T extends object>(over: Partial<T>): T {
  const base: Partial<T> = {};
  return new Proxy(base as T, {
    get: (_t, k: string) => (k in over ? (over as Record<string, unknown>)[k] : (base as Record<string, unknown>)[k] ?? ((base as Record<string, unknown>)[k] = vi.fn(async () => ({})))),
  });
}

const place = (over: Partial<Place> = {}): Place => ({ id: CAFE, name: 'Blue Door', tried: true, dishes: [], best: null, tags: [], visits: { count: 2, last: '2026-11-03', avgSpend: null }, createdAt: AT, updatedAt: AT, space: SID, by: '', ...over });

describe('her shared cafés', () => {
  it('shows who added and edited it; Delete only on her own visit; the delete is a Confirm for both', async () => {
    const detail: PlaceDetail = {
      place: place({ editedBy: ASHA, editedAt: AT }),
      visits: [
        { id: '01JVISITAAAAAAAAAAAAAAAAA1', placeId: CAFE, day: '2026-11-03', by: ASHA, notes: 'mine', createdAt: AT, updatedAt: AT },
        { id: '01JVISITAAAAAAAAAAAAAAAAA2', placeId: CAFE, day: '2026-11-02', by: '', notes: 'his', createdAt: AT, updatedAt: AT },
      ],
      more: false,
    };
    const placeDelete = vi.fn(async () => {});
    render(<Lists me={me()} api={proxy<PersonApi>({ place: vi.fn(async () => detail), placeDelete })} tab="cafes" id={CAFE} list={null} tick={0} />);
    expect(await screen.findByText(/Added by Sam · Edited by you · Tue 3 Nov/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Delete café' }));
    expect(await screen.findByText('Delete Blue Door for both of you?')).toBeTruthy();
  });
});

describe('her shared lists', () => {
  it('says who ticked an item, and a tick calls the route', async () => {
    const r: SharedItemsResponse = {
      list: { id: LIST, name: 'Weekly shop', kind: 'shopping', open: 1, done: 1, createdAt: AT, updatedAt: AT },
      items: [
        { id: '01JITEMAAAAAAAAAAAAAAAAAA1', title: 'Eggs', by: ASHA, createdAt: AT, updatedAt: AT },
        { id: '01JITEMAAAAAAAAAAAAAAAAAA2', title: 'Oat milk', by: '', doneAt: AT, doneBy: '', createdAt: AT, updatedAt: AT },
      ],
    };
    const listItemTick = vi.fn(async () => {});
    render(<Lists me={me()} api={proxy<PersonApi>({ listItems: vi.fn(async () => r), listItemTick })} tab="lists" id={null} list={LIST} tick={0} />);
    expect(await screen.findByText(/^Ticked by Sam · \d\d:\d\d$/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Eggs/ })[0] as HTMLElement);
    await waitFor(() => expect(listItemTick).toHaveBeenCalledWith(LIST, '01JITEMAAAAAAAAAAAAAAAAAA1', true));
  });
});

const TODAY = { day: '2026-11-03', name: 'Asha', state: 'active', todos: { locked: true }, meds: null, weight: { locked: true }, food: null, plan: { locked: true }, status: { locked: true }, review: null, sleep: { locked: true }, concerns: [] } as never;
const person = (assign: boolean): PersonView =>
  ({ id: ASHA, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, invite: null, agreement: { ...presetAgreement('everything', 'P4'), assign: { ...presetAgreement('everything', 'P4').assign, todos: assign }, version: 1 }, offer: null, pendingProposal: null, sharedSpace: SID }) as PersonView;

function Wrapped({ client, id, places }: { client: PeopleClient; id?: string; places: (q: { space?: string }) => Promise<unknown> }) {
  const [deps] = useState(() => ({ store: createAppStore(), api: ownerFakeApi({ placesList: vi.fn(places) as never }), router: createRouter(memoryHistory(`/people/${ASHA}`)), toasts: createToastStore() }));
  return (
    <AppProvider deps={deps}>
      <Partner pid={ASHA} client={client} tab="lists" {...(id ? { id } : {})} />
    </AppProvider>
  );
}

describe('his Lists tab', () => {
  it('Assign to Asha only with assign.todos; hostile text stays text', async () => {
    const items: SharedItemsResponse = {
      list: { id: LIST, name: 'Errands', kind: 'plain', open: 1, done: 0, createdAt: AT, updatedAt: AT },
      items: [{ id: '01JITEMAAAAAAAAAAAAAAAAAA1', title: '<img src=x onerror="window.__z=1">Return the book', by: ASHA, createdAt: AT, updatedAt: AT }],
    };
    for (const [assign, shown] of [
      [true, true],
      [false, false],
    ] as const) {
      const c = proxy<PeopleClient>({ list: vi.fn(async () => ({ enabled: true, people: [person(assign)] })), today: vi.fn(async () => TODAY), lists: vi.fn(async () => ({ space: SID, lists: [] })), listItems: vi.fn(async () => items) });
      const r = render(<Wrapped client={c} id={LIST} places={async () => ({ places: [], tags: [], areas: [] })} />);
      expect(await screen.findByText(/Return the book/)).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Assign to Asha' }) !== null).toBe(shown));
      expect(r.container.querySelector('img')).toBeNull();
      expect((window as unknown as { __z?: number }).__z).toBeUndefined();
      r.unmount();
    }
  });

  it('his own cafés have Share; a shared one he added has Just me', async () => {
    const places = async (q: { space?: string }) => ({
      places: q.space === 'shared' ? [place({ id: '01JCAFEAAAAAAAAAAAAAAAAAA1', name: 'Blue Door' })] : [place({ id: '01JCAFEAAAAAAAAAAAAAAAAAA2', name: 'Just Mine Cafe', space: undefined, by: undefined } as Partial<Place>)],
      tags: [],
      areas: [],
    });
    const c = proxy<PeopleClient>({ list: vi.fn(async () => ({ enabled: true, people: [person(true)] })), today: vi.fn(async () => TODAY), lists: vi.fn(async () => ({ space: SID, lists: [] })) });
    render(<Wrapped client={c} places={places} />);
    expect(await screen.findByText('Just Mine Cafe')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Just me' })).toBeTruthy();
  });
});
