/**
 * v0.12 People (P1): her medicines on both sides (spec 3.4, 4.2; 9.7.4),
 * with synthetic people (Sam and Asha) and fake clients.
 *
 * - Her Health › Medicines: today's doses with Taken and Skip (each one
 *   call, then a 5-second Undo that removes that dose), "added by Sam" on
 *   one he added, Add a medicine.
 * - Her Today: the day's doses with the same buttons.
 * - His Partner › Health: at `full` each medicine with Edit and Stop only
 *   where he may (his additions with assign.meds, hers with editHers.meds),
 *   Add only with assign.meds; at `adherence` no name; off a locked tile.
 *   No dose control on his side at all.
 * - His Today line and card: a count of doses not logged, never a name.
 * - Her mirror of medicines renders the same component.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { MedsDay } from '@jantar/protocol';
import type { OwnerMedsView, PersonMe, PersonMedicineView, PersonOwnToday, PersonToday, PersonView } from '@jantar/protocol/people';
import { presetAgreement } from '@jantar/protocol/people-core';
import type { PersonApi } from '../../src/partner/api.js';
import Health from '../../src/partner/screens/Health.js';
import { Today } from '../../src/partner/screens/Today.js';
import { MedsRead, doseWords } from '../../src/people-shared/MedsRead.js';
import { isDue } from '../../src/ui/screens/life/meds/data.js';
import { createRouter, memoryHistory } from '../../src/lib/router.js';
import { createAppStore } from '../../src/store.js';
import { AppProvider, createToastStore } from '../../src/ui/context.js';
import type { PeopleClient } from '../../src/ui/screens/people/client.js';
import { peopleLine } from '../../src/ui/screens/people/PeopleCard.js';
import { Partner, medPatchOf, medsLine } from '../../src/ui/screens/people/Partner.js';
import { fakeApi as ownerApi } from '../helpers.js';

const PID = '01JASHAAAAAAAAAAAAAAAAAAAA';
const DAY = '2026-11-03';
const AT = '2026-11-03T08:00:00.000Z';
const HIS = '01JMEDAAAAAAAAAAAAAAAAAAA1';
const HERS = '01JMEDAAAAAAAAAAAAAAAAAAA2';
const DOSE = '01JDOSEAAAAAAAAAAAAAAAAAAA';

function fake<T extends object>(over: Partial<T> = {}): T {
  const base: Partial<T> = {};
  return new Proxy(base as T, {
    get: (_t, k: string) => (k in over ? (over as Record<string, unknown>)[k] : (base as Record<string, unknown>)[k] ?? ((base as Record<string, unknown>)[k] = vi.fn(async () => ({})))),
  });
}

const medView = (id: string, name: string, by: string, over: Partial<PersonMedicineView> = {}): PersonMedicineView => ({
  id,
  name,
  dose: '1 tablet',
  times: ['08:00'],
  schedule: { freq: 'daily', startDay: DAY },
  history: [{ from: DAY, schedule: { freq: 'daily', startDay: DAY } }],
  startedOn: DAY,
  createdAt: AT,
  updatedAt: AT,
  supply: null,
  adherencePct: 90,
  by,
  ...over,
});

const day = (items: MedsDay['groups'][number]['items']): MedsDay => ({ day: DAY, today: DAY, groups: items.length ? [{ period: 'morning', items }] : [] });
const pending = (medId: string, name: string, over = {}) => ({ medId, name, dose: '1 tablet', slot: '08:00', status: 'pending' as const, overdue: false, ...over });

describe('her Health › Medicines', () => {
  it('Taken and Skip are one call each, then Undo removes that dose; "added by Sam" on his', async () => {
    const meds = vi.fn(async () => ({ day: day([pending(HIS, 'Vitamin D'), pending(HERS, 'Iron')]), medicines: [medView(HIS, 'Vitamin D', ''), medView(HERS, 'Iron', PID)] }));
    const doseLog = vi.fn(async () => ({ id: DOSE }));
    const doseDelete = vi.fn(async () => undefined);
    const api = fake<PersonApi>({ meds, doseLog, doseDelete });
    render(<Health api={api} owner="Sam" tab="meds" week={null} tick={0} />);
    expect((await screen.findAllByText(/Vitamin D/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/added by Sam/).length).toBeGreaterThan(0);
    const taken = screen.getAllByRole('button', { name: 'Taken' });
    expect(taken).toHaveLength(2);
    await act(async () => {
      fireEvent.click(taken[0] as HTMLElement);
    });
    await waitFor(() => expect(doseLog).toHaveBeenCalledWith(HIS, { day: DAY, slot: '08:00', status: 'taken' }));
    const toast = await screen.findByRole('status');
    expect(toast.textContent).toMatch(/Taken: Vitamin D 08:00/);
    await act(async () => {
      fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    });
    await waitFor(() => expect(doseDelete).toHaveBeenCalledWith(HIS, DOSE));
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Skip' })[1] as HTMLElement);
    });
    await waitFor(() => expect(doseLog).toHaveBeenCalledWith(HERS, { day: DAY, slot: '08:00', status: 'skipped' }));
  });

  it('a logged dose shows what was logged and Undo; Add a medicine sends a daily medicine', async () => {
    const meds = vi.fn(async () => ({ day: day([pending(HERS, 'Iron', { status: 'taken', doseId: DOSE, at: AT })]), medicines: [medView(HERS, 'Iron', PID)] }));
    const doseDelete = vi.fn(async () => undefined);
    const medCreate = vi.fn(async () => ({ id: HIS }));
    const api = fake<PersonApi>({ meds, doseDelete, medCreate });
    render(<Health api={api} owner="Sam" tab="meds" week={null} tick={0} />);
    expect(await screen.findByText(/^Taken \d\d:\d\d$/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    });
    await waitFor(() => expect(doseDelete).toHaveBeenCalledWith(HERS, DOSE));
    fireEvent.click(screen.getByRole('button', { name: 'Add a medicine' }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Magnesium' } });
    fireEvent.change(within(sheet).getByLabelText(/Times/), { target: { value: '8:00, 21:00' } });
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(medCreate).toHaveBeenCalledWith({ name: 'Magnesium', times: ['08:00', '21:00'], schedule: { freq: 'daily' } }));
  });
});

describe('her Today', () => {
  it("shows today's doses with Taken and Skip", async () => {
    const t: PersonOwnToday = {
      day: DAY,
      today: DAY,
      meds: day([pending(HERS, 'Iron')]),
      todos: [],
      overdue: 0,
      plan: { day: DAY, plan: null, now: null, next: null, late: [], focus: null, slots: {}, counts: { done: 0, total: 0 } },
      status: null,
      review: null,
      sleep: { open: null, showStart: false, askWake: null },
      sharingCheckin: false,
      alertsUnseen: 0,
      prompt: 'What went well today?',
    };
    const doseLog = vi.fn(async () => ({ id: DOSE }));
    const api = fake<PersonApi>({ today: vi.fn(async () => t), doseLog });
    const me = { person: { id: PID, name: 'Asha', state: 'active', modules: { food: false } }, owner: { name: 'Sam' }, peopleOn: true, agreement: null, pending: null, ownerDevices: [], built: 'P4' } as unknown as PersonMe;
    render(<Today me={me} api={api} reload={() => {}} tick={0} />);
    const section = await screen.findByRole('region', { name: 'Medicines' });
    expect(section.textContent).toMatch(/08:00Iron · 1 tablet/);
    expect(screen.queryByText('Nothing planned or due right now.')).toBeNull();
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Taken' }));
    });
    await waitFor(() => expect(doseLog).toHaveBeenCalledWith(HERS, { day: DAY, slot: '08:00', status: 'taken' }));
  });
});

const person = (over: Partial<ReturnType<typeof presetAgreement>> = {}): PersonView => {
  const base = presetAgreement('everything');
  const agreement = { ...base, ...over, version: 1 };
  return { id: PID, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, invite: null, agreement, offer: null, pendingProposal: null } as PersonView;
};
const full = (): OwnerMedsView => ({ level: 'full', day: day([pending(HIS, 'Vitamin D'), pending(HERS, 'Iron', { overdue: true })]), medicines: [medView(HIS, 'Vitamin D', ''), medView(HERS, 'Iron', PID, { editedBy: '' })], concern: null });
const week = { from: '2026-11-02', to: '2026-11-08', nights: [], open: null, avgMinutes: null, trend: null } as never;
const todayOf = (meds: PersonToday['meds']): PersonToday =>
  ({ day: DAY, name: 'Asha', state: 'active', todos: { locked: true }, meds, weight: { locked: true }, food: null, plan: { locked: true }, status: { locked: true }, review: null, sleep: { locked: true }, concerns: [] }) as PersonToday;

function Wrapped({ client: c }: { client: PeopleClient }) {
  const [deps] = useState(() => ({ store: createAppStore(), api: ownerApi(), router: createRouter(memoryHistory(`/people/${PID}`)), toasts: createToastStore() }));
  return (
    <AppProvider deps={deps}>
      <Partner pid={PID} client={c} tab="health" />
    </AppProvider>
  );
}

describe('his Partner › Health', () => {
  it('full: names, Edit and Stop only where he may, Add only with assign.meds, and no dose control', async () => {
    for (const [editHers, assign, edits] of [
      [true, true, 2],
      [false, true, 1],
    ] as const) {
      const base = presetAgreement('everything');
      const c = fake<PeopleClient>({
        list: vi.fn(async () => ({ enabled: true, people: [person({ editHers: { ...base.editHers, meds: editHers }, assign: { ...base.assign, meds: assign } })] })),
        today: vi.fn(async () => todayOf(full())),
        meds: vi.fn(async () => full()),
        weights: vi.fn(async () => ({ weights: [], latest: null })),
        sleep: vi.fn(async () => week),
      });
      const r = render(<Wrapped client={c} />);
      const meds = await screen.findByRole('region', { name: 'Medicines' });
      expect(meds.textContent).toMatch(/Vitamin D/);
      expect(meds.textContent).toMatch(/added by you/);
      expect(meds.textContent).toMatch(/Asha's own · edited by you/);
      expect(within(meds).getAllByRole('button', { name: 'Edit' })).toHaveLength(edits);
      expect(within(meds).getAllByRole('button', { name: 'Stop' })).toHaveLength(edits);
      expect(screen.getByRole('button', { name: 'Add a medicine for Asha' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Taken' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
      r.unmount();
    }
  });

  it('his edit sends a patch; his add sends a daily medicine for her', async () => {
    const medUpdate = vi.fn(async () => undefined);
    const medAssign = vi.fn(async () => ({ id: HIS }));
    const c = fake<PeopleClient>({
      list: vi.fn(async () => ({ enabled: true, people: [person()] })),
      today: vi.fn(async () => todayOf(full())),
      meds: vi.fn(async () => full()),
      weights: vi.fn(async () => ({ weights: [], latest: null })),
      sleep: vi.fn(async () => week),
      medUpdate,
      medAssign,
    });
    render(<Wrapped client={c} />);
    const meds = await screen.findByRole('region', { name: 'Medicines' });
    fireEvent.click(within(meds).getAllByRole('button', { name: 'Edit' })[1] as HTMLElement);
    const sheet = await screen.findByRole('dialog');
    fireEvent.change(within(sheet).getByLabelText(/Times/), { target: { value: '08:30' } });
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    });
    // Only what he changed: nothing he didn't touch (her notes among them) is written over.
    await waitFor(() => expect(medUpdate).toHaveBeenCalledWith(PID, HERS, { times: ['08:30'] }));
  });

  it('his edit patch is only what changed: notes he read stay unless he edits them, and clearing a field sends null', () => {
    const m = { name: 'Iron', dose: '1 tablet', times: ['08:00'], notes: 'HER-NOTE' };
    expect(medPatchOf(m, { name: 'Iron', dose: '1 tablet', times: ['08:00'], notes: 'HER-NOTE' })).toEqual({});
    expect(medPatchOf(m, { name: ' Iron ', dose: '1 tablet', times: ['08:00', '20:00'], notes: 'HER-NOTE' })).toEqual({ times: ['08:00', '20:00'] });
    expect(medPatchOf(m, { name: 'Iron', dose: '', times: ['08:00'], notes: '' })).toEqual({ dose: null, notes: null });
    // A medicine whose notes he can't read (none in his view) gets no notes key from an untouched field.
    expect(medPatchOf({ name: 'Iron', times: ['08:00'] }, { name: 'Iron', dose: '', times: ['08:00'], notes: '' })).toEqual({});
  });

  it('adherence names nothing and offers no edit; off is a locked tile', async () => {
    const adh: OwnerMedsView = { level: 'adherence', pct: 92, notLoggedToday: 1, concern: 'Doses not logged 2 days running. Worth checking in.' };
    const base = presetAgreement('everything');
    const c = fake<PeopleClient>({
      list: vi.fn(async () => ({ enabled: true, people: [person({ see: { ...base.see, meds: 'adherence' }, assign: { ...base.assign, meds: false }, editHers: { ...base.editHers, meds: false } })] })),
      today: vi.fn(async () => todayOf(adh)),
      meds: vi.fn(async () => adh),
      weights: vi.fn(async () => ({ weights: [], latest: null })),
      sleep: vi.fn(async () => week),
    });
    const r = render(<Wrapped client={c} />);
    const meds = await screen.findByRole('region', { name: 'Medicines' });
    expect(meds.textContent).toMatch(/92% of doses logged/);
    expect(meds.textContent).toMatch(/1 dose not logged today/);
    expect(meds.textContent).toMatch(/Doses not logged 2 days running/);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add a medicine/ })).toBeNull();
    r.unmount();
    const off = fake<PeopleClient>({
      list: vi.fn(async () => ({ enabled: true, people: [person({ see: { ...base.see, meds: 'off' }, assign: { ...base.assign, meds: false }, editHers: { ...base.editHers, meds: false } })] })),
      today: vi.fn(async () => todayOf({ locked: true })),
      weights: vi.fn(async () => ({ weights: [], latest: null })),
      sleep: vi.fn(async () => week),
    });
    render(<Wrapped client={off} />);
    expect(await screen.findByText('Medicines: Asha keeps this private')).toBeTruthy();
  });
});

describe('his Today line and card, and her mirror', () => {
  it('a count of doses not logged, never a name', () => {
    expect(medsLine(full())).toBe('Doses: 0 of 2 logged · 1 not logged');
    expect(medsLine({ level: 'adherence', pct: 80, notLoggedToday: 2, concern: null })).toBe('Medicines: 2 doses not logged today');
    expect(peopleLine(todayOf(full()))).toBe('Asha · 1 dose not logged');
    expect(peopleLine(todayOf({ level: 'adherence', pct: 80, notLoggedToday: 0, concern: 'Doses not logged 2 days running. Worth checking in.' }))).toBe('Asha · Doses not logged 2 days running');
    expect(peopleLine(todayOf({ locked: true }))).toBe('Asha');
  });

  it('a time gone by before she added the medicine: her row says so, and his own Life list never calls it due', () => {
    const early = pending(HERS, 'Inhaler', { slot: '07:00', beforeAdded: true as const });
    expect(doseWords(early)).toBe('Added after this time');
    expect(isDue(early, DAY, { day: DAY, hhmm: '08:30' } as never)).toBe(false);
    expect(isDue(pending(HIS, 'Vitamin D'), DAY, { day: DAY, hhmm: '08:30' } as never)).toBe(true);
  });

  it('her mirror renders the same view, with Sam as the one who added', () => {
    render(<MedsRead view={full()} owner="Sam" name="you" />);
    expect(screen.getByText(/added by Sam/)).toBeTruthy();
    expect(screen.getByText(/yours · edited by Sam/)).toBeTruthy();
    expect(screen.getByText('Not logged yet')).toBeTruthy();
  });

  it('the mirror shows the notes he reads, and "Taken" with no time (his view has no log time)', () => {
    const v: OwnerMedsView = {
      level: 'full',
      day: day([{ medId: HERS, name: 'Iron', dose: '1 tablet', slot: '08:00', status: 'taken', overdue: false }]),
      medicines: [{ id: HERS, name: 'Iron', dose: '1 tablet', times: ['08:00'], schedule: { freq: 'daily', startDay: DAY }, notes: 'With food', startedOn: DAY, adherencePct: 100, by: PID }],
      concern: null,
    };
    render(<MedsRead view={v} owner="Sam" name="you" />);
    expect(screen.getByText('Notes: With food')).toBeTruthy();
    expect(screen.getByText('Taken')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d\d:\d\d \(late\)|Taken \d/);
  });
});
