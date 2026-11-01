/**
 * Medicines (`/meds`, v0.4 spec 5.4 and 5.10) against the fake API: the
 * <h1> in every state; the day by period with each dose state told apart
 * without colour (a due dose has Taken and Skip, an overdue one the ember
 * glyph, a later one "pending", a taken one a check and its time, a past
 * day "missed"); Taken and Skip write the dose and reload; the medicines
 * with their schedule and supply, the days left in ember only when low;
 * LW5, the push warning; the day stepper; ?med= opens a sheet; and the
 * empty, error, offline and failed-write states. Synthetic medicines only.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LifeStatus, MedicineView, MedicinesResponse, MedsDayItem } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import { NO_PUSH, NO_PUSH_DEVICES, NO_PUSH_SWITCH } from '../src/ui/screens/life/shared/PushWarning.js';
import { EMPTY, NO_CONTROL, OFFLINE, OFFLINE_WRITE } from '../src/ui/screens/life/shared/states.js';
import { NOTHING_DUE, NO_MEDS_TODAY, zoneNote } from '../src/ui/screens/life/meds/data.js';
import { fakeApi, preloadPlaces, renderApp, stateWith } from './helpers.js';

preloadPlaces('meds');

// The app's clock (helpers NOW) is 2026-01-15 10:05 UTC; the Life zone here is UTC.
const TODAY = '2026-01-15';
const YESTERDAY = '2026-01-14';
const TESTAMOL = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const PLACEBIN = '01JFZ8X8Y3T0V5G9WQK2M4N6PS';
const EXAMPLEX = '01JFZ8X8Y3T0V5G9WQK2M4N6PT';
const DOSE = '01JFZ8X8Y3T0V5G9WQK2M4N6PV';

function status(over: Partial<LifeStatus> = {}): LifeStatus {
  return {
    open: true,
    timezone: 'UTC',
    today: TODAY,
    currency: null,
    lockScreenDetails: false,
    modules: { todos: false, medicines: true, food: false, places: false, finance: false, posts: false },
    estimate: { available: false },
    backups: { last: null, count: 0 },
    push: { devices: 1, webpush: true },
    ...over,
  };
}

const item = (over: Partial<MedsDayItem> & Pick<MedsDayItem, 'medId' | 'name' | 'slot'>): MedsDayItem => ({ status: 'pending', overdue: false, ...over });

function med(over: Partial<MedicineView> & Pick<MedicineView, 'id' | 'name'>): MedicineView {
  return {
    times: ['08:00'],
    schedule: { freq: 'daily', startDay: '2026-01-01' },
    history: [],
    startedOn: '2026-01-01',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    supply: null,
    adherencePct: null,
    ...over,
  };
}

const MEDS: MedicineView[] = [
  med({
    id: TESTAMOL,
    name: 'Testamol',
    dose: '500 mg',
    times: ['08:00', '21:00'],
    pills: { left: 14, perDose: 1 },
    supply: { daysLeft: 7, runsOut: '2026-01-22', low: false },
    adherencePct: 93,
  }),
  med({ id: PLACEBIN, name: 'Placebin', dose: '10 mg', pills: { left: 3, perDose: 1 }, supply: { daysLeft: 3, runsOut: '2026-01-18', low: true }, adherencePct: 100 }),
  med({ id: EXAMPLEX, name: 'Examplex', dose: '1000 IU', times: ['10:00'], schedule: { freq: 'weekly', byWeekday: [1, 4], startDay: '2026-01-01' } }),
];

function today(over: Partial<{ items: MedsDayItem[]; meds: MedicineView[]; day: string }> = {}): MedicinesResponse {
  const items = over.items ?? [
    item({ medId: PLACEBIN, name: 'Placebin', dose: '10 mg', slot: '08:00', overdue: true }),
    item({ medId: TESTAMOL, name: 'Testamol', dose: '500 mg', slot: '08:00', status: 'taken', doseId: DOSE, at: '2026-01-15T09:12:00.000Z', late: true }),
    item({ medId: EXAMPLEX, name: 'Examplex', dose: '1000 IU', slot: '10:00' }),
    item({ medId: TESTAMOL, name: 'Testamol', dose: '500 mg', slot: '21:00' }),
  ];
  const morning = items.filter((i) => i.slot < '12:00');
  const night = items.filter((i) => i.slot >= '18:00');
  return {
    day: {
      day: over.day ?? TODAY,
      today: TODAY,
      groups: [...(morning.length ? [{ period: 'morning' as const, items: morning }] : []), ...(night.length ? [{ period: 'night' as const, items: night }] : [])],
    },
    medicines: over.meds ?? MEDS,
  };
}

function medsApi(resp: MedicinesResponse | ((day?: string) => Promise<MedicinesResponse>) = today(), st: LifeStatus = status()) {
  return fakeApi({
    lifeStatus: vi.fn(async () => st),
    medsGet: vi.fn(typeof resp === 'function' ? resp : async () => resp),
    doseLog: vi.fn(async () => ({ id: DOSE })),
    doseUndo: vi.fn(async () => ({ ok: true as const })),
  });
}

function open(api = medsApi(), path = '/meds', conn: 'live' | 'offline' = 'live') {
  return renderApp({ path, api, state: stateWith({ features: { life: true } }), status: conn });
}

const heading = () => screen.findByRole('heading', { level: 1, name: 'Medicines' });
const row = (key: string) => document.querySelector<HTMLElement>(`[data-dose="${key}"]`) as HTMLElement;

afterEach(() => vi.unstubAllGlobals());

describe('Medicines: the day', () => {
  it('keeps its <h1> while loading, then lists the day by period', async () => {
    let resolve: (r: MedicinesResponse) => void = () => undefined;
    const api = medsApi(() => new Promise<MedicinesResponse>((r) => (resolve = r)));
    open(api);
    await heading();
    // The h1 can paint a beat before the first load fires on a slow runner.
    await waitFor(() => expect(api.medsGet).toHaveBeenCalledWith(undefined));
    resolve(today());
    expect(await screen.findByRole('region', { name: 'Morning' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Night' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Morning' })).getAllByRole('listitem').map((li) => li.getAttribute('data-dose'))).toEqual([
      `${PLACEBIN}@08:00`,
      `${TESTAMOL}@08:00`,
      `${EXAMPLEX}@10:00`,
    ]);
  });

  it('tells every dose state apart without colour; ember only on the overdue one', async () => {
    open();
    await screen.findByRole('region', { name: 'Morning' });
    const overdue = row(`${PLACEBIN}@08:00`);
    expect(overdue.querySelector('[data-glyph="needs"]')).toBeTruthy();
    expect(within(overdue).getByRole('button', { name: 'Taken: Placebin 10 mg at 08:00' })).toBeTruthy();
    expect(within(overdue).getByText('08:00').className).toContain('text-signal-text');
    expect(within(overdue).getByRole('button', { name: /Placebin 10 mg at 08:00, overdue/ })).toBeTruthy();

    const taken = row(`${TESTAMOL}@08:00`);
    expect(taken.textContent).toContain('09:12');
    expect(taken.textContent).toContain('late');
    expect(within(taken).queryByRole('button', { name: /^Taken:/ })).toBeNull();
    expect(taken.querySelector('[data-glyph]')).toBeNull();

    const due = row(`${EXAMPLEX}@10:00`);
    expect(within(due).getByText('10:00').className).toContain('text-jup-text');
    expect(within(due).getByRole('button', { name: 'Skip: Examplex 1000 IU at 10:00' })).toBeTruthy();
    expect(due.querySelector('[data-glyph]')).toBeNull();

    const later = row(`${TESTAMOL}@21:00`);
    expect(within(later).getByText('pending')).toBeTruthy();
    expect(within(later).getByText('21:00').className).toContain('text-ink-3');
    expect(within(later).queryByRole('button', { name: /^Taken:/ })).toBeNull();

    // The one ember text in the list is the overdue time.
    const list = screen.getByRole('region', { name: 'Morning' }).parentElement as HTMLElement;
    expect([...list.querySelectorAll('[data-dose] .text-signal-text')].map((e) => e.textContent)).toEqual(['08:00']);
  });

  it('Taken and Skip write that dose for the day shown, with an Idempotency-Key, and reload', async () => {
    const api = medsApi();
    open(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Taken: Examplex 1000 IU at 10:00' }));
    await waitFor(() => expect(api.doseLog).toHaveBeenCalledWith(EXAMPLEX, { day: TODAY, slot: '10:00', status: 'taken' }, expect.any(String)));
    await waitFor(() => expect(api.medsGet).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Skip: Placebin 10 mg at 08:00' }));
    await waitFor(() => expect(api.doseLog).toHaveBeenLastCalledWith(PLACEBIN, { day: TODAY, slot: '08:00', status: 'skipped' }, expect.any(String)));
  });

  it('a failed write says Not saved with the reason, and the list stays', async () => {
    const api = medsApi();
    api.doseLog.mockRejectedValueOnce(new ApiError('invalid_request', 'That medicine has no dose at that time on that day.', 400));
    open(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Taken: Examplex 1000 IU at 10:00' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Not saved.');
    expect(alert.className).toContain('text-signal-text');
    expect(row(`${EXAMPLEX}@10:00`)).toBeTruthy();
  });

  it('a past day shows its misses with no buttons, still tappable to log; the stepper moves by day and stops at today', async () => {
    const missed = (day: string) =>
      today({
        day,
        items: [item({ medId: TESTAMOL, name: 'Testamol', dose: '500 mg', slot: '08:00', status: 'missed' }), item({ medId: TESTAMOL, name: 'Testamol', dose: '500 mg', slot: '21:00', status: 'missed' })],
      });
    const api = medsApi(async (day?: string) => (day && day < TODAY ? missed(day) : today()));
    const { router } = open(api, `/meds?day=${YESTERDAY}`);
    await screen.findByRole('region', { name: 'Morning' });
    expect(api.medsGet).toHaveBeenCalledWith(YESTERDAY);
    expect(within(row(`${TESTAMOL}@08:00`)).getByText('missed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Taken:/ })).toBeNull();
    expect(screen.getByText('Wed 14 Jan')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Today' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Testamol 500 mg at 21:00, missed/ }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Taken' }));
    // Forgot to log it last night: Taken records its own time, so it is not marked late.
    await waitFor(() =>
      expect(api.doseLog).toHaveBeenCalledWith(TESTAMOL, { day: YESTERDAY, slot: '21:00', status: 'taken', at: '2026-01-14T21:00:00.000Z' }, expect.any(String)),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Previous day' }));
    expect(router.getState().route).toEqual({ name: 'meds', day: '2026-01-13' });
    expect(await screen.findByText('Tue 13 Jan')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }));
    expect(router.getState().route).toEqual({ name: 'meds', day: YESTERDAY });
    await screen.findByText('Wed 14 Jan');
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }));
    expect(router.getState().route).toEqual({ name: 'meds' });
    expect(await screen.findByText('Thu 15 Jan')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Next day' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says so when nothing is due on a day', async () => {
    open(medsApi(today({ items: [] })));
    expect(await screen.findByText(NO_MEDS_TODAY)).toBeTruthy();
    const past = medsApi(today({ items: [], day: YESTERDAY }));
    open(past, `/meds?day=${YESTERDAY}`);
    expect(await screen.findByText(NOTHING_DUE)).toBeTruthy();
  });
});

describe('Medicines: your medicines', () => {
  it('shows times and schedule in mono and the supply line; the days left in ember only when low; the Life zone under the list', async () => {
    open();
    const list = await screen.findByRole('region', { name: 'Your medicines' });
    const testamol = list.querySelector<HTMLElement>(`[data-med="${TESTAMOL}"]`) as HTMLElement;
    expect(testamol.textContent).toContain('Testamol 500 mg');
    expect(testamol.textContent).toContain('08:00, 21:00 · every day');
    expect(testamol.textContent).toContain('14 left · runs out 22 Jan · 93% in 30 days');
    expect(testamol.querySelector('.text-signal-text')).toBeNull();

    const placebin = list.querySelector<HTMLElement>(`[data-med="${PLACEBIN}"]`) as HTMLElement;
    expect(placebin.hasAttribute('data-low')).toBe(true);
    expect(within(placebin).getByText('3 days left').className).toContain('text-signal-text');
    expect(placebin.textContent).toContain('3 left · 3 days left · 100% in 30 days');

    const examplex = list.querySelector<HTMLElement>(`[data-med="${EXAMPLEX}"]`) as HTMLElement;
    expect(examplex.textContent).toContain('10:00 · Mon, Thu');
    expect(screen.getByText(zoneNote('UTC'))).toBeTruthy();
  });

  it('a stopped medicine says when it stopped, with no supply line', async () => {
    const stopped = med({ id: PLACEBIN, name: 'Placebin', stoppedOn: '2026-01-14', pills: { left: 3, perDose: 1 }, supply: { daysLeft: null, runsOut: null, low: false } });
    open(medsApi(today({ meds: [MEDS[0] as MedicineView, stopped] })));
    const row = (await screen.findByRole('region', { name: 'Your medicines' })).querySelector<HTMLElement>(`[data-med="${PLACEBIN}"]`) as HTMLElement;
    expect(row.textContent).toContain('Stopped Wed 14 Jan');
    expect(row.hasAttribute('data-low')).toBe(false);
    expect(row.querySelector('.text-signal-text')).toBeNull();
  });

  it('?med=<id> (a refill push) opens that medicine', async () => {
    open(medsApi(), `/meds?med=${PLACEBIN}`);
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('heading', { name: 'Change medicine' })).toBeTruthy();
    expect((within(sheet).getByLabelText('Name') as HTMLInputElement).value).toBe('Placebin');
  });

  it('with no medicines yet: one sentence and Add medicine', async () => {
    open(medsApi(today({ items: [], meds: [] })));
    expect(await screen.findByText(EMPTY.medicines)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add medicine' }));
    expect(within(await screen.findByRole('dialog')).getByRole('heading', { name: 'Add medicine' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Your medicines' })).toBeNull();
  });
});

describe('LW5: the push warning on Medicines', () => {
  it('shows with no device or with Web Push off, and not when a device would ring', async () => {
    const a = open(medsApi(today(), status({ push: { devices: 0, webpush: true } })));
    expect(await screen.findByText(NO_PUSH)).toBeTruthy();
    expect(screen.getByText(NO_PUSH_DEVICES)).toBeTruthy();
    a.unmount();
    const b = open(medsApi(today(), status({ push: { devices: 2, webpush: false } })));
    expect(await screen.findByText(NO_PUSH_SWITCH)).toBeTruthy();
    b.unmount();
    open(medsApi(today(), status()));
    await screen.findByRole('region', { name: 'Morning' });
    expect(screen.queryByText(NO_PUSH)).toBeNull();
  });
});

describe('Medicines: states', () => {
  it('a switch off, a broken life.db and no control scope keep the <h1> and say so', async () => {
    const off = medsApi(() => Promise.reject(new ApiError('forbidden', 'Medicines are off. Turn them on at your Mac: jantar life on medicines', 403)));
    const a = open(off);
    await heading();
    expect((await screen.findByText('jantar life on medicines')).tagName).toBe('CODE');
    a.unmount();
    const broken = medsApi(() => Promise.reject(new ApiError('life_unavailable', 'Life data could not be opened. The file is untouched. Restore a backup at your Mac: jantar life restore <file>', 503)));
    const b = open(broken);
    expect((await screen.findByText('jantar life restore <file>')).tagName).toBe('CODE');
    await heading();
    b.unmount();
    open(medsApi(() => Promise.reject(new ApiError('forbidden', 'this device does not have the control scope', 403))));
    expect(await screen.findByText(NO_CONTROL)).toBeTruthy();
    await heading();
  });

  it('any other failure offers Try again, which loads again', async () => {
    const api = medsApi();
    api.medsGet.mockRejectedValueOnce(new ApiError('internal', '', 500));
    open(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Morning' })).toBeTruthy();
  });

  it('offline with nothing loaded says the Mac is out of reach; with a list, writes are off and say why', async () => {
    const a = open(medsApi(() => Promise.reject(new ApiError('network', 'offline', 0))), '/meds', 'offline');
    expect(await screen.findByText(OFFLINE)).toBeTruthy();
    await heading();
    a.unmount();
    open(medsApi(), '/meds', 'offline');
    const taken = await screen.findByRole('button', { name: 'Taken: Examplex 1000 IU at 10:00' });
    expect((taken as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(OFFLINE_WRITE)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add medicine' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
