/**
 * Weight with food (v0.4 spec 1.5, 4.6, 5.5; the 13:55 update): the line
 * under the calories (latest, change over 7 and 30 days, goal; "Log
 * weight" with none), the weight sheet (the day Food shows, kg with one
 * decimal from a decimal keyboard, the last 30 with Delete (no confirm: a
 * 5 s Undo, the delete sent once it goes or the sheet closes, and never
 * after a new weight for that day), the goal with Clear), and the parsing
 * and formatting behind them. No BMI, no chart.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FoodDay, LifeStatus, WeightSummary } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import { kgChange, kgText, parseKg, weightLine } from '../src/ui/screens/life/food/format.js';
import { fakeApi, preloadPlaces, renderApp, stateWith } from './helpers.js';

preloadPlaces('food', 'today');

afterEach(() => vi.useRealTimers());

const DAY = '2026-01-15';

const status: LifeStatus = {
  open: true,
  timezone: 'UTC',
  today: DAY,
  currency: null,
  lockScreenDetails: false,
  modules: { todos: false, medicines: false, food: true, places: false, finance: false },
  estimate: { available: false },
  backups: { last: null, count: 0 },
  push: { devices: 1, webpush: true },
};

const WEIGHT: WeightSummary = {
  latest: { day: DAY, kg: 72.4 },
  change7: -0.6,
  change30: -1.6,
  goalKg: 70,
  recent: [
    { day: DAY, kg: 72.4 },
    { day: '2026-01-08', kg: 73 },
    { day: '2025-12-16', kg: 74 },
  ],
};

function day(weight: WeightSummary, d = DAY): FoodDay {
  return { day: d, today: DAY, target: 2000, kcal: 0, entries: [], saved: [], weight };
}

function render(weight: WeightSummary = WEIGHT, api: Parameters<typeof fakeApi>[0] = {}, path = '/food') {
  return renderApp({
    path,
    api: fakeApi({ lifeStatus: vi.fn(async () => status), foodDay: vi.fn(async (d?: string) => day(weight, d ?? DAY)), ...api }),
    state: stateWith({ features: { life: true } }),
  });
}

async function openSheet(line: string | RegExp) {
  fireEvent.click(await screen.findByText(line));
  return screen.findByRole('dialog', { name: 'Weight' });
}

describe('the weight line', () => {
  it('shows the latest weight, the change over 7 and 30 days and the goal, in mono', async () => {
    render();
    const line = await screen.findByText('72.4 kg · -0.6 in 7 days · -1.6 in 30 · goal 70.0');
    expect(line.className).toContain('type-mono');
    expect(line.className).toContain('text-ink-2');
    // It breaks only between its parts: "goal 70.0" never splits over two lines.
    expect(line.textContent).toBe('72.4\u00a0kg · -0.6\u00a0in\u00a07\u00a0days · -1.6\u00a0in\u00a030 · goal\u00a070.0');
  });

  it('says "Log weight" with none logged', async () => {
    render({ latest: null, change7: null, change30: null, goalKg: null, recent: [] });
    expect(await screen.findByText('Log weight')).toBeTruthy();
  });

  it('leaves out a change it has no earlier weight for', () => {
    expect(weightLine({ ...WEIGHT, change30: null, goalKg: null }, 'en-US')).toBe('72.4 kg · -0.6 in 7 days');
    expect(weightLine({ ...WEIGHT, change7: 0 }, 'en-US')).toBe('72.4 kg · 0.0 in 7 days · -1.6 in 30 · goal 70.0');
    expect(weightLine({ ...WEIGHT, latest: null }, 'en-US')).toBeNull();
  });
});

describe('the weight sheet', () => {
  it('logs the weight for the day shown, from a decimal keyboard', async () => {
    const weightSet = vi.fn(async () => ({ ok: true as const }));
    const { api } = render({ latest: null, change7: null, change30: null, goalKg: null, recent: [] }, { weightSet });
    const sheet = await openSheet('Log weight');
    const kg = within(sheet).getByLabelText('Weight today, kg') as HTMLInputElement;
    expect(kg.inputMode).toBe('decimal');
    fireEvent.change(kg, { target: { value: '72,44' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save weight' }));
    await waitFor(() => expect(weightSet).toHaveBeenCalledWith(DAY, 72.4, expect.any(String)));
    await waitFor(() => expect(api.foodDay).toHaveBeenCalledTimes(2));
  });

  it('logs for a past day when Food shows one, prefilled with what that day has', async () => {
    const weightSet = vi.fn(async () => ({ ok: true as const }));
    render(WEIGHT, { weightSet }, '/food?day=2026-01-08');
    const sheet = await openSheet(/^72\.4 kg/);
    const kg = within(sheet).getByLabelText('Weight on Thu 8 Jan, kg') as HTMLInputElement;
    expect(kg.value).toBe('73');
    fireEvent.change(kg, { target: { value: '72.9' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save weight' }));
    await waitFor(() => expect(weightSet).toHaveBeenCalledWith('2026-01-08', 72.9, expect.any(String)));
  });

  it('a failed weight or goal keeps the sheet and what was typed, with Not saved', async () => {
    const weightSet = vi.fn(async (): Promise<never> => {
      throw new ApiError('conflict', 'You have 10,000 weights. Delete some first.', 409);
    });
    const foodTargets = vi.fn(async (): Promise<never> => {
      throw new ApiError('network', 'offline', 0);
    });
    render(WEIGHT, { weightSet, foodTargets });
    const sheet = await openSheet(/^72\.4 kg/);
    const log = within(sheet).getByRole('form', { name: 'Log weight' });
    fireEvent.change(within(log).getByLabelText('Weight today, kg'), { target: { value: '72.1' } });
    fireEvent.click(within(log).getByRole('button', { name: 'Save weight' }));
    expect((await within(log).findByRole('alert')).textContent).toBe('Not saved. You have 10,000 weights. Delete some first.');
    expect((within(log).getByLabelText('Weight today, kg') as HTMLInputElement).value).toBe('72.1');
    const goal = within(sheet).getByRole('form', { name: 'Goal weight' });
    fireEvent.change(within(goal).getByLabelText('Goal weight, kg'), { target: { value: '68.5' } });
    fireEvent.click(within(goal).getByRole('button', { name: 'Save goal' }));
    expect((await within(goal).findByRole('alert')).textContent).toMatch(/^Not saved\. Could not reach the Mac/);
    expect((within(goal).getByLabelText('Goal weight, kg') as HTMLInputElement).value).toBe('68.5');
    expect(screen.getByRole('dialog', { name: 'Weight' })).toBeTruthy();
  });

  it('refuses a weight outside 20 to 400 kg', async () => {
    const weightSet = vi.fn(async () => ({ ok: true as const }));
    render(WEIGHT, { weightSet });
    const sheet = await openSheet(/^72\.4 kg/);
    fireEvent.change(within(sheet).getByLabelText('Weight today, kg'), { target: { value: '500' } });
    expect((within(sheet).getByRole('button', { name: 'Save weight' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(sheet).getByText('A weight in kg from 20 to 400, like 72.4.')).toBeTruthy();
  });

  it('lists the recent weights with Delete: gone at once, Undo puts it back, sent when the 5 s Undo goes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const weightDelete = vi.fn(async () => ({ ok: true as const }));
    const { api } = render(WEIGHT, { weightDelete });
    const sheet = await openSheet(/^72\.4 kg/);
    const recent = within(sheet).getByRole('region', { name: 'Recent weights' });
    expect(within(recent).getAllByRole('listitem')).toHaveLength(3);
    expect(within(recent).getByText('73.0 kg')).toBeTruthy();
    const remove = async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Weight on Thu 8 Jan' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    };
    await remove();
    expect(within(recent).queryByText('73.0 kg')).toBeNull();
    expect(within(sheet).getByText('Last 2 weights')).toBeTruthy();
    expect(within(sheet).getByText('Deleted: 73.0 kg on Thu 8 Jan')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Undo' }));
    expect(within(recent).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Thu 15 Jan72.4 kg', 'Thu 8 Jan73.0 kg', 'Tue 16 Dec74.0 kg']);
    expect(weightDelete).not.toHaveBeenCalled();
    await remove();
    await act(async () => vi.advanceTimersByTime(5_100));
    expect(weightDelete).toHaveBeenCalledWith('2026-01-08', expect.any(String));
    await waitFor(() => expect(api.foodDay).toHaveBeenCalledTimes(2));
  });

  it('a weight held for deleting is sent when the sheet closes, but never after a new weight for its day', async () => {
    const weightDelete = vi.fn(async () => ({ ok: true as const }));
    const weightSet = vi.fn(async () => ({ ok: true as const }));
    render(WEIGHT, { weightDelete, weightSet });
    let sheet = await openSheet(/^72\.4 kg/);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Weight on Thu 15 Jan' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.change(within(sheet).getByLabelText('Weight today, kg'), { target: { value: '72.1' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save weight' }));
    await waitFor(() => expect(weightSet).toHaveBeenCalledWith(DAY, 72.1, expect.any(String)));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Weight' })).toBeNull());
    expect(weightDelete).not.toHaveBeenCalled();

    sheet = await openSheet(/^72\.4 kg/);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Weight on Thu 8 Jan' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(weightDelete).toHaveBeenCalledWith('2026-01-08', expect.any(String)));
  });

  it('sets and clears the goal weight', async () => {
    const foodTargets = vi.fn(async () => ({ ok: true as const }));
    render(WEIGHT, { foodTargets });
    const sheet = await openSheet(/^72\.4 kg/);
    const goal = within(sheet).getByLabelText('Goal weight, kg') as HTMLInputElement;
    expect(goal.value).toBe('70');
    fireEvent.change(goal, { target: { value: '68.5' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save goal' }));
    await waitFor(() => expect(foodTargets).toHaveBeenCalledWith({ goalKg: 68.5 }, expect.any(String)));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(foodTargets).toHaveBeenLastCalledWith({ goalKg: null }, expect.any(String)));
  });

  it('Today shows the latest weight with its day', async () => {
    renderApp({
      path: '/today',
      api: fakeApi({ lifeStatus: vi.fn(async () => status), lifeToday: vi.fn(async () => ({ day: DAY, food: { kcal: 300, target: 1800, weight: { day: '2026-01-14', kg: 72.4 } } })) }),
      state: stateWith({ features: { life: true } }),
    });
    expect(await screen.findByText('72.4 kg · Wed 14 Jan')).toBeTruthy();
    expect(screen.getByText('300 / 1,800 kcal')).toBeTruthy();
  });

  it("Today leaves out the day of today's weight: the header already says it", async () => {
    renderApp({
      path: '/today',
      api: fakeApi({ lifeStatus: vi.fn(async () => status), lifeToday: vi.fn(async () => ({ day: DAY, food: { kcal: 300, target: 1800, weight: { day: DAY, kg: 72.4 } } })) }),
      state: stateWith({ features: { life: true } }),
    });
    expect(await screen.findByText('Thu 15 Jan')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('72.4 kg')).toBeTruthy());
    expect(screen.getAllByText(/Thu 15 Jan/)).toHaveLength(1);
  });
});

describe('kg in and out', () => {
  it('reads kg with a dot or a comma, rounded to one decimal, 20 to 400', () => {
    expect(parseKg('72.4')).toBe(72.4);
    expect(parseKg('72,45')).toBe(72.5);
    expect(parseKg(' 80 ')).toBe(80);
    for (const bad of ['', 'abc', '19.9', '400.1', '-70', '7 2']) expect(parseKg(bad), bad).toBeNull();
  });

  it('writes kg with one decimal and a change with its sign', () => {
    expect(kgText(72, 'en-US')).toBe('72.0');
    expect(kgChange(-0.6, 'en-US')).toBe('-0.6');
    expect(kgChange(1.2, 'en-US')).toBe('+1.2');
    expect(kgChange(0, 'en-US')).toBe('0.0');
  });
});
