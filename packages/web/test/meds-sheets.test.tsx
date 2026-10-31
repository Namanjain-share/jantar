/**
 * The medicine sheets and Today's MEDICINES section (v0.4 spec 5.2, 5.4):
 *
 * - DoseSheet: loads its day itself (a push opens it cold, for last night's
 *   dose after midnight); one large Taken, Skip, Took it at… (a time on that
 *   day in the Life zone, never after now) and Undo once logged; each writes
 *   and closes; a failure keeps it open with "Not saved."; offline turns its
 *   buttons off; a dose gone from the list says so.
 * - MedSheet: add sends exactly the form; Save waits for a name, a time and
 *   a day; a change sends only what changed; Refill adds to the count; Stop
 *   taking and Delete ask first; a stopped medicine offers Delete only.
 * - MedsToday: due doses with Taken and Skip, later ones pending, logged
 *   ones folded into one line that opens; a write calls onChanged.
 *
 * Synthetic medicines only.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { LifeStatus, MedicineView, MedicinesResponse, MedsDay, MedsDayItem } from '@jantar/protocol';
import { ApiError, type Api } from '../src/lib/api.js';
import { createRouter, memoryHistory } from '../src/lib/router.js';
import { createAppStore } from '../src/store.js';
import { AppProvider, createToastStore } from '../src/ui/context.js';
import { DoseSheet, NOT_ON_LIST, TIME_NOT_YET } from '../src/ui/screens/life/meds/DoseSheet.js';
import { DELETE_WARNING, REFILL_ASK, STOP_WARNING } from '../src/ui/screens/life/meds/MedSheet.js';
import { MedsToday } from '../src/ui/screens/life/meds/MedsToday.js';
import { NO_MEDS_TODAY, instantIn, lifeNow, parseDoseKey } from '../src/ui/screens/life/meds/data.js';
import { OFFLINE_WRITE } from '../src/ui/screens/life/shared/states.js';
import { NOW, fakeApi, renderApp, stateWith } from './helpers.js';

// NOW is 2026-01-15 10:05 UTC: 15:35 in Asia/Kolkata, the Life zone here.
const TZ = 'Asia/Kolkata';
const TODAY = '2026-01-15';
const TESTAMOL = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const PLACEBIN = '01JFZ8X8Y3T0V5G9WQK2M4N6PS';
const DOSE = '01JFZ8X8Y3T0V5G9WQK2M4N6PV';

const status = (over: Partial<LifeStatus> = {}): LifeStatus => ({
  open: true,
  timezone: TZ,
  today: TODAY,
  currency: null,
  lockScreenDetails: false,
  modules: { todos: false, medicines: true, food: false, places: false, finance: false },
  estimate: { available: false },
  backups: { last: null, count: 0 },
  push: { devices: 1, webpush: true },
  ...over,
});

const item = (over: Partial<MedsDayItem> & Pick<MedsDayItem, 'medId' | 'name' | 'slot'>): MedsDayItem => ({ status: 'pending', overdue: false, ...over });

const TESTAMOL_VIEW: MedicineView = {
  id: TESTAMOL,
  name: 'Testamol',
  dose: '500 mg',
  times: ['08:00', '21:00'],
  schedule: { freq: 'daily', startDay: '2026-01-01' },
  history: [],
  pills: { left: 14, perDose: 1 },
  notes: 'Synthetic medicine notes',
  startedOn: '2026-01-01',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  supply: { daysLeft: 7, runsOut: '2026-01-22', low: false },
  adherencePct: 93,
};

function dayOf(items: MedsDayItem[], day = TODAY): MedsDay {
  const morning = items.filter((i) => i.slot < '12:00');
  const night = items.filter((i) => i.slot >= '18:00');
  return { day, today: TODAY, groups: [...(morning.length ? [{ period: 'morning' as const, items: morning }] : []), ...(night.length ? [{ period: 'night' as const, items: night }] : [])] };
}

const ITEMS = [
  item({ medId: TESTAMOL, name: 'Testamol', dose: '500 mg', slot: '08:00' }),
  item({ medId: PLACEBIN, name: 'Placebin', dose: '10 mg', slot: '08:00', status: 'taken', doseId: DOSE, at: '2026-01-15T02:40:00.000Z' }),
  item({ medId: TESTAMOL, name: 'Testamol', dose: '500 mg', slot: '21:00' }),
];

function api(resp: MedicinesResponse = { day: dayOf(ITEMS), medicines: [TESTAMOL_VIEW] }) {
  return fakeApi({
    lifeStatus: vi.fn(async () => status()),
    medsGet: vi.fn(async () => resp),
    doseLog: vi.fn(async () => ({ id: DOSE })),
    doseUndo: vi.fn(async () => ({ ok: true as const })),
    medCreate: vi.fn(async () => ({ id: PLACEBIN })),
    medUpdate: vi.fn(async () => ({ ok: true as const })),
    medStop: vi.fn(async () => ({ ok: true as const })),
    medDelete: vi.fn(async () => ({ ok: true as const })),
  });
}

/** A screen part on its own, inside the app's provider. */
function mount(ui: ReactNode, a: Api, conn: 'live' | 'offline' = 'live', now = NOW) {
  const store = createAppStore(stateWith({ features: { life: true } }));
  store.getState().setConn({ status: conn, lastOkAt: now });
  const router = createRouter(memoryHistory('/today'));
  return render(<AppProvider deps={{ store, api: a, router, toasts: createToastStore(), now: () => now }}>{ui}</AppProvider>);
}

const dialog = () => screen.findByRole('dialog');
const gone = () => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

describe('DoseSheet', () => {
  it('opens cold on a push: loads its day, names the medicine and time; Taken writes now and closes', async () => {
    const a = api();
    const onClose = vi.fn();
    mount(<DoseSheet medId={TESTAMOL} slot="08:00" day={TODAY} onClose={onClose} />, a);
    const sheet = await dialog();
    expect(await within(sheet).findByRole('heading', { name: 'Testamol 500 mg' })).toBeTruthy();
    expect(a.medsGet).toHaveBeenCalledWith(TODAY);
    expect(sheet.textContent).toContain('08:00 · Thu 15 Jan');
    expect(sheet.textContent).toContain('Not logged yet');
    expect(within(sheet).queryByRole('button', { name: 'Undo' })).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Taken' }));
    await waitFor(() => expect(a.doseLog).toHaveBeenCalledWith(TESTAMOL, { day: TODAY, slot: '08:00', status: 'taken' }, expect.any(String)));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('Skip writes a skip', async () => {
    const a = api();
    mount(<DoseSheet medId={TESTAMOL} slot="08:00" day={TODAY} onClose={() => undefined} />, a);
    fireEvent.click(await within(await dialog()).findByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(a.doseLog).toHaveBeenCalledWith(TESTAMOL, { day: TODAY, slot: '08:00', status: 'skipped' }, expect.any(String)));
  });

  it('Took it at sends that time on that day in the Life zone; a time after now is refused', async () => {
    const a = api();
    mount(<DoseSheet medId={TESTAMOL} slot="08:00" day={TODAY} onClose={() => undefined} />, a);
    const sheet = await dialog();
    const time = (await within(sheet).findByLabelText('Took it at…')) as HTMLInputElement;
    expect(time.value).toBe('08:00');
    expect(time.max).toBe('15:35');
    const save = within(sheet).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    fireEvent.change(time, { target: { value: '16:10' } });
    expect(within(sheet).getByText(TIME_NOT_YET)).toBeTruthy();
    expect(save.disabled).toBe(true);
    fireEvent.change(time, { target: { value: '09:10' } });
    expect(within(sheet).queryByText(TIME_NOT_YET)).toBeNull();
    fireEvent.click(save);
    await waitFor(() => expect(a.doseLog).toHaveBeenCalledWith(TESTAMOL, { day: TODAY, slot: '08:00', status: 'taken', at: '2026-01-15T03:40:00.000Z' }, expect.any(String)));
  });

  it('a logged dose shows when it was taken and offers Undo, which sends its id', async () => {
    const a = api();
    mount(<DoseSheet medId={PLACEBIN} slot="08:00" day={TODAY} onClose={() => undefined} />, a);
    const sheet = await dialog();
    expect(await within(sheet).findByText(/Taken at 08:10/)).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: 'Taken' })).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(a.doseUndo).toHaveBeenCalledWith(PLACEBIN, DOSE, expect.any(String)));
  });

  it('a failed write stays open with Not saved; a retry keeps the same Idempotency-Key', async () => {
    const a = api();
    a.doseLog.mockRejectedValueOnce(new ApiError('network', 'offline', 0));
    const onClose = vi.fn();
    mount(<DoseSheet medId={TESTAMOL} slot="08:00" day={TODAY} onClose={onClose} />, a);
    const sheet = await dialog();
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Taken' }));
    expect((await within(sheet).findByRole('alert')).textContent).toContain('Not saved.');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Taken' }));
    await waitFor(() => expect(a.doseLog).toHaveBeenCalledTimes(2));
    expect(a.doseLog.mock.calls[0]?.[2]).toBe(a.doseLog.mock.calls[1]?.[2]);
  });

  it('offline: its buttons are off and say why', async () => {
    mount(<DoseSheet medId={TESTAMOL} slot="08:00" day={TODAY} onClose={() => undefined} />, api(), 'offline');
    const sheet = await dialog();
    expect(((await within(sheet).findByRole('button', { name: 'Taken' })) as HTMLButtonElement).disabled).toBe(true);
    expect(within(sheet).getByText(OFFLINE_WRITE)).toBeTruthy();
  });

  it('a dose no longer on that day says so, with Close', async () => {
    const onClose = vi.fn();
    mount(<DoseSheet medId={TESTAMOL} slot="12:00" day={TODAY} onClose={onClose} />, api());
    const sheet = await dialog();
    expect(await within(sheet).findByText(NOT_ON_LIST)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("a 23:00 push opened at 00:30 is last night's dose: it loads that day and logs it at its own time", async () => {
    const late = Date.parse('2026-01-15T19:00:00.000Z'); // 00:30 on the 16th in Asia/Kolkata
    const key = parseDoseKey(`${TESTAMOL}@2300`, lifeNow(late, TZ));
    expect(key).toEqual({ medId: TESTAMOL, slot: '23:00', day: TODAY });
    const { medId, slot, day } = key as NonNullable<typeof key>;
    const night = item({ medId: TESTAMOL, name: 'Testamol', dose: '500 mg', slot: '23:00', status: 'missed' });
    const a = api({ day: { day: TODAY, today: '2026-01-16', groups: [{ period: 'night', items: [night] }] }, medicines: [TESTAMOL_VIEW] });
    mount(<DoseSheet medId={medId} slot={slot} day={day} onClose={() => undefined} />, a, 'live', late);
    const sheet = await dialog();
    expect(a.medsGet).toHaveBeenCalledWith(TODAY);
    expect(sheet.textContent).toContain('23:00 · Thu 15 Jan');
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Taken' }));
    await waitFor(() => expect(a.doseLog).toHaveBeenCalledWith(TESTAMOL, { day: TODAY, slot: '23:00', status: 'taken', at: '2026-01-15T17:30:00.000Z' }, expect.any(String)));
  });

  it('reads a push key and puts a Life-zone time on the right instant', () => {
    const now = lifeNow(NOW, TZ); // 15:35
    expect(parseDoseKey(`${TESTAMOL}@0800`, now)).toEqual({ medId: TESTAMOL, slot: '08:00', day: TODAY });
    expect(parseDoseKey(`${TESTAMOL}@2100`, now)).toEqual({ medId: TESTAMOL, slot: '21:00', day: '2026-01-14' });
    expect(parseDoseKey('../x@0800', now)).toBeNull();
    expect(instantIn('2026-01-15', '08:00', 'Asia/Kolkata').toISOString()).toBe('2026-01-15T02:30:00.000Z');
    expect(instantIn('2026-03-08', '09:00', 'America/New_York').toISOString()).toBe('2026-03-08T13:00:00.000Z');
    expect(instantIn('2026-03-07', '09:00', 'America/New_York').toISOString()).toBe('2026-03-07T14:00:00.000Z');
  });
});

describe('MedSheet', () => {
  function openMeds(a = api(), path = '/meds') {
    return renderApp({ path, api: a, state: stateWith({ features: { life: true } }) });
  }
  const field = (sheet: HTMLElement, label: string) => within(sheet).getByLabelText(label) as HTMLInputElement;
  /** The medicine's row under YOUR MEDICINES. */
  const medRow = async (name: RegExp) => within(await screen.findByRole('region', { name: 'Your medicines' })).getByRole('button', { name });

  it('adds a medicine with exactly what the form says', async () => {
    const a = api();
    openMeds(a);
    fireEvent.click(await screen.findByRole('button', { name: 'Add medicine' }));
    const sheet = await dialog();
    const save = within(sheet).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(field(sheet, 'Name'), { target: { value: 'Placebin' } });
    fireEvent.change(field(sheet, 'Dose'), { target: { value: '10 mg' } });
    fireEvent.change(field(sheet, 'New time'), { target: { value: '21:00' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add time' }));
    expect(within(within(sheet).getByRole('list', { name: 'Dose times' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['08:00', '21:00']);
    fireEvent.click(within(sheet).getByRole('button', { name: 'On these days' }));
    expect(save.disabled).toBe(true);
    expect(within(sheet).getByText('Pick at least one day.')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Thu' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Mon' }));
    fireEvent.change(field(sheet, 'Pills left'), { target: { value: '30' } });
    fireEvent.change(field(sheet, 'Per dose'), { target: { value: '2' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(a.medCreate).toHaveBeenCalledWith(
        { name: 'Placebin', dose: '10 mg', times: ['08:00', '21:00'], schedule: { freq: 'weekly', byWeekday: [1, 4] }, pills: { left: 30, perDose: 2 } },
        expect.any(String),
      ),
    );
    await gone();
    await waitFor(() => expect(a.medsGet).toHaveBeenCalledTimes(2));
  });

  it('every N days sends its interval and start day; a time can be taken off but not the last one', async () => {
    const a = api();
    openMeds(a);
    fireEvent.click(await screen.findByRole('button', { name: 'Add medicine' }));
    const sheet = await dialog();
    fireEvent.change(field(sheet, 'Name'), { target: { value: 'Examplex' } });
    expect((within(sheet).getByRole('button', { name: 'Remove 08:00' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Every N days' }));
    // Narrow fields keep their width (nothing merges classes, so the field style carries none) and the row wraps.
    expect(field(sheet, 'Every').className).not.toContain('w-full');
    expect(field(sheet, 'Every').parentElement?.className).toContain('flex-wrap');
    fireEvent.change(field(sheet, 'Every'), { target: { value: '3' } });
    fireEvent.change(field(sheet, 'days, starting'), { target: { value: '2026-01-20' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(a.medCreate).toHaveBeenCalledWith({ name: 'Examplex', times: ['08:00'], schedule: { freq: 'interval', interval: 3, startDay: '2026-01-20' } }, expect.any(String)),
    );
  });

  it('a change sends only what changed (a cleared field as null)', async () => {
    const a = api();
    openMeds(a);
    fireEvent.click(await medRow(/^Testamol 500 mg/));
    const sheet = await dialog();
    expect(within(sheet).getByRole('heading', { name: 'Change medicine' })).toBeTruthy();
    fireEvent.change(field(sheet, 'Notes'), { target: { value: 'With food' } });
    fireEvent.change(field(sheet, 'Dose'), { target: { value: '' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(a.medUpdate).toHaveBeenCalledWith(TESTAMOL, { dose: null, notes: 'With food' }, expect.any(String)));
  });

  it('Refill asks how many were added and raises the count by that much', async () => {
    const a = api();
    openMeds(a);
    fireEvent.click(await medRow(/^Testamol 500 mg/));
    const sheet = await dialog();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Refill' }));
    fireEvent.change(within(sheet).getByLabelText(REFILL_ASK), { target: { value: '30' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(a.medUpdate).toHaveBeenCalledWith(TESTAMOL, { pills: { left: 44 } }, expect.any(String)));
  });

  it('Stop taking and Delete each ask first', async () => {
    const a = api();
    openMeds(a);
    fireEvent.click(await medRow(/^Testamol 500 mg/));
    let sheet = await dialog();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Stop taking' }));
    expect(a.medStop).not.toHaveBeenCalled();
    const stop = within(sheet).getByRole('group', { name: 'Stop taking' });
    expect(stop.textContent).toContain(STOP_WARNING);
    fireEvent.click(within(stop).getByRole('button', { name: 'Stop taking' }));
    await waitFor(() => expect(a.medStop).toHaveBeenCalledWith(TESTAMOL, expect.any(String)));
    await gone();

    fireEvent.click(await medRow(/^Testamol 500 mg/));
    sheet = await dialog();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));
    const del = within(sheet).getByRole('group', { name: 'Delete' });
    expect(del.textContent).toContain(DELETE_WARNING);
    expect(a.medDelete).not.toHaveBeenCalled();
    fireEvent.click(within(del).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(a.medDelete).toHaveBeenCalledWith(TESTAMOL, expect.any(String)));
  });

  it('a stopped medicine offers Delete only', async () => {
    const a = api({ day: dayOf([]), medicines: [{ ...TESTAMOL_VIEW, stoppedOn: '2026-01-14' }] });
    openMeds(a);
    fireEvent.click(await medRow(/^Testamol 500 mg/));
    const sheet = await dialog();
    expect(sheet.textContent).toContain('Stopped Wed 14 Jan');
    expect(within(sheet).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(within(sheet).queryByRole('button', { name: 'Stop taking' })).toBeNull();
    expect(within(sheet).getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('a failed save keeps the sheet and its values, with Not saved', async () => {
    const a = api();
    a.medCreate.mockRejectedValueOnce(new ApiError('conflict', 'You have 50 medicines. Delete one to add another.', 409));
    openMeds(a);
    fireEvent.click(await screen.findByRole('button', { name: 'Add medicine' }));
    const sheet = await dialog();
    fireEvent.change(field(sheet, 'Name'), { target: { value: 'Placebin' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    const alert = await within(sheet).findByRole('alert');
    expect(alert.textContent).toBe('Not saved. You have 50 medicines. Delete one to add another.');
    expect(field(sheet, 'Name').value).toBe('Placebin');
  });
});

describe('MedsToday', () => {
  it('lists due doses with Taken and Skip and later ones as pending; logged ones fold into one line that opens', async () => {
    mount(<MedsToday data={dayOf(ITEMS)} onChanged={() => undefined} />, api());
    expect(await screen.findByRole('button', { name: 'Taken: Testamol 500 mg at 08:00' })).toBeTruthy();
    const later = document.querySelector(`[data-dose="${TESTAMOL}@21:00"]`) as HTMLElement;
    expect(within(later).getByText('pending')).toBeTruthy();
    expect(document.querySelector(`[data-dose="${PLACEBIN}@08:00"]`)).toBeNull();
    const fold = screen.getByRole('button', { name: '1 taken today' });
    expect(fold.className).toContain('text-ink-3');
    expect(fold.className).toContain('coarse:min-h-44');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector(`[data-dose="${PLACEBIN}@08:00"]`)?.textContent).toContain('08:10');
  });

  it("offline: Taken and Skip are off, and the offline line is Today's (its Page), not said again here", async () => {
    mount(<MedsToday data={dayOf(ITEMS)} onChanged={() => undefined} />, api(), 'offline');
    expect(((await screen.findByRole('button', { name: 'Taken: Testamol 500 mg at 08:00' })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(OFFLINE_WRITE)).toBeNull();
  });

  it('Taken writes the dose for today and calls onChanged', async () => {
    const a = api();
    const onChanged = vi.fn();
    mount(<MedsToday data={dayOf(ITEMS)} onChanged={onChanged} />, a);
    fireEvent.click(await screen.findByRole('button', { name: 'Taken: Testamol 500 mg at 08:00' }));
    await waitFor(() => expect(a.doseLog).toHaveBeenCalledWith(TESTAMOL, { day: TODAY, slot: '08:00', status: 'taken' }, expect.any(String)));
    expect(onChanged).toHaveBeenCalled();
  });

  it('a row opens the dose sheet for today', async () => {
    const a = api();
    mount(<MedsToday data={dayOf(ITEMS)} onChanged={() => undefined} />, a);
    fireEvent.click(await screen.findByRole('button', { name: /Testamol 500 mg at 21:00, pending/ }));
    expect(await within(await dialog()).findByRole('heading', { name: 'Testamol 500 mg' })).toBeTruthy();
    expect(a.medsGet).toHaveBeenCalledWith(TODAY);
  });

  it('with nothing today, says so', () => {
    mount(<MedsToday data={dayOf([])} onChanged={() => undefined} />, api());
    expect(screen.getByText(NO_MEDS_TODAY)).toBeTruthy();
  });
});
