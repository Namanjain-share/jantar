/**
 * Food and calories (v0.4 spec 5.5, 5.10) against the fake API: the day's
 * total against the target (over it: a full bar and "+240 over" in ink),
 * the entries with edit and delete (no confirm: a 5 s Undo that puts the
 * entry back exactly, the delete sent once it goes), stepping days, the add
 * sheet's Type, Saved (one tap, 5 s Undo, Forget with its own Undo) and
 * Ask Claude (unavailable, asking
 * with Cancel, editable rows, a refusal with "Type it instead", and the
 * call carrying no Idempotency-Key), the target sheet, and every state with
 * the <h1>. The weight line and sheet have their own file.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FoodDay, FoodEntry, FoodEstimate, LifeStatus } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import { ESTIMATE_CHECK, NO_ESTIMATE } from '../src/ui/screens/life/food/AddFoodSheet.js';
import { fakeApi, iso, preloadPlaces, renderApp, stateWith } from './helpers.js';

preloadPlaces('food', 'today');

afterEach(() => vi.useRealTimers());

const DAY = '2026-01-15';
const id = (n: number) => `01JFZ8X8Y3T0V5G9WQK2M4N${String(n).padStart(3, '0')}`;

function status(over: Partial<LifeStatus> = {}): LifeStatus {
  return {
    open: true,
    timezone: 'UTC',
    today: DAY,
    currency: null,
    lockScreenDetails: false,
    modules: { todos: false, medicines: false, food: true, places: false, finance: false },
    estimate: { available: true },
    backups: { last: null, count: 0 },
    push: { devices: 1, webpush: true },
    ...over,
  };
}

function entry(n: number, hhmm: string, name: string, kcal: number, day = DAY): FoodEntry {
  return { id: id(n), day, at: `${day}T${hhmm}:00.000Z`, name, kcal, createdAt: iso(0), updatedAt: iso(0) };
}

function foodDay(over: Partial<FoodDay> = {}): FoodDay {
  return {
    day: DAY,
    today: DAY,
    target: 2000,
    kcal: 520,
    entries: [entry(1, '08:40', 'Example poha', 280), entry(2, '13:10', 'Example roti', 240)],
    saved: [{ id: id(30), name: 'Example roti', kcal: 120, uses: 4 }],
    weight: { latest: null, change7: null, change30: null, goalKg: null, recent: [] },
    ...over,
  };
}

function render(opts: { day?: (d?: string) => Promise<FoodDay>; status?: LifeStatus; path?: string; api?: Parameters<typeof fakeApi>[0]; conn?: 'live' | 'offline' } = {}) {
  const api = fakeApi({
    lifeStatus: vi.fn(async () => opts.status ?? status()),
    foodDay: vi.fn(opts.day ?? (async (d?: string) => foodDay(d && d !== DAY ? { day: d, entries: [], kcal: 0 } : {}))),
    ...opts.api,
  });
  return renderApp({ path: opts.path ?? '/food', api, state: stateWith({ features: { life: true } }), ...(opts.conn ? { status: opts.conn } : {}) });
}

const heading = () => screen.findByRole('heading', { level: 1, name: 'Food' });

async function openAdd() {
  await screen.findByText('Example poha');
  fireEvent.click(screen.getAllByRole('button', { name: 'Add food' })[0]!);
  return screen.findByRole('dialog', { name: 'Add food' });
}

describe('Food: states and the day', () => {
  it('shows its title while loading and with an error', async () => {
    let fail!: (e: unknown) => void;
    render({ day: () => new Promise((_, rej) => (fail = rej)) });
    await heading();
    // The <h1> can paint before the effect that calls the loader has run.
    await waitFor(() => expect(fail).toBeTypeOf('function'));
    await act(async () => fail(new ApiError('forbidden', 'Food is off. Turn it on at your Mac: jantar life on food', 403)));
    expect((await screen.findByText('jantar life on food')).tagName).toBe('CODE');
    expect(screen.getByRole('heading', { level: 1, name: 'Food' })).toBeTruthy();
  });

  it('shows the total against the target in mono, and the entries with their time and kcal', async () => {
    render();
    const target = await screen.findByRole('button', { name: 'Daily target 2,000 kcal. Change it' });
    expect(target.textContent).toBe('/ 2,000');
    expect(screen.getByText('520').className).toContain('text-ink');
    expect(document.querySelector('[data-bar]')?.getAttribute('data-bar')).toBe('26');
    const list = screen.getByRole('list', { name: 'Eaten' });
    const first = within(list).getAllByRole('listitem')[0]!;
    expect(within(first).getByText('08:40').className).toContain('type-mono');
    expect(within(first).getByText('280')).toBeTruthy();
  });

  it('over the target: a full bar and "+240 over" in ink, never ember', async () => {
    render({ day: async () => foodDay({ kcal: 2240 }) });
    const over = await screen.findByText('+240 over');
    expect(over.className).toContain('text-ink-2');
    expect(document.querySelector('[data-bar]')?.getAttribute('data-bar')).toBe('100');
    expect(document.querySelector('.text-signal-text')).toBeNull();
  });

  it('steps back a day and never past today', async () => {
    const { api, router } = render();
    await screen.findByText('Example poha');
    expect((screen.getByRole('button', { name: 'Next day' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous day' }));
    expect(router.getState().route).toEqual({ name: 'food', day: '2026-01-14' });
    await waitFor(() => expect(api.foodDay).toHaveBeenLastCalledWith('2026-01-14'));
    expect(await screen.findByText('Nothing logged on Wed 14 Jan.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(router.getState().route).toEqual({ name: 'food' });
  });

  it('says "Nothing logged today." on an empty today', async () => {
    render({ day: async () => foodDay({ entries: [], kcal: 0 }) });
    expect(await screen.findByText('Nothing logged today.')).toBeTruthy();
  });

  it('says Life is broken with the restore command in mono, and no retry', async () => {
    render({ day: async () => Promise.reject(new ApiError('life_unavailable', 'Life data could not be opened. The file is untouched. Restore a backup at your Mac: jantar life restore <file>', 503)) });
    expect((await screen.findByText('jantar life restore <file>')).tagName).toBe('CODE');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await heading();
  });

  it('says so when this device has no control scope', async () => {
    render({ day: async () => Promise.reject(new ApiError('forbidden', 'this device does not have the control scope', 403)) });
    expect(await screen.findByText(/Life needs control access/)).toBeTruthy();
    await heading();
  });

  it('offline: the day stays and adding is off', async () => {
    render({ conn: 'offline' });
    await screen.findByText('Example poha');
    // One add control on the screen, off while offline.
    expect(screen.getAllByRole('button', { name: 'Add food' })).toHaveLength(1);
    for (const b of screen.getAllByRole('button', { name: 'Add food' })) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Offline: changes need your Mac')).toBeTruthy();
  });
});

describe('Food: entries', () => {
  it('edits an entry from a tap, sending what changed', async () => {
    const foodUpdate = vi.fn(async () => ({ ok: true as const }));
    render({ api: { foodUpdate } });
    fireEvent.click(await screen.findByText('Example poha'));
    const sheet = await screen.findByRole('dialog', { name: 'Edit food' });
    fireEvent.change(within(sheet).getByLabelText('kcal'), { target: { value: '300' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(foodUpdate).toHaveBeenCalledWith(id(1), { kcal: 300 }, expect.any(String)));
  });

  it('a failed edit keeps the sheet and its values, with Not saved', async () => {
    const foodUpdate = vi.fn(async (): Promise<never> => {
      throw new ApiError('not_found', 'That entry is gone.', 404);
    });
    render({ api: { foodUpdate } });
    fireEvent.click(await screen.findByText('Example poha'));
    const sheet = await screen.findByRole('dialog', { name: 'Edit food' });
    fireEvent.change(within(sheet).getByLabelText('kcal'), { target: { value: '300' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect((await within(sheet).findByRole('alert')).textContent).toBe('Not saved. That entry is gone.');
    expect((within(sheet).getByLabelText('kcal') as HTMLInputElement).value).toBe('300');
  });

  it('deletes an entry from its ··· menu with no confirm: gone at once, sent when its 5 s Undo goes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const foodDelete = vi.fn(async () => ({ ok: true as const }));
    const { api } = render({ api: { foodDelete } });
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Example roti' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(screen.queryByText('Example roti')).toBeNull();
    expect(screen.getByText('Deleted: Example roti')).toBeTruthy();
    expect(foodDelete).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(5_100));
    expect(foodDelete).toHaveBeenCalledWith(id(2), expect.any(String));
    await waitFor(() => expect(api.foodDay).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Deleted: Example roti')).toBeNull();
  });

  it('Undo puts a deleted entry back as it was, and sends nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const foodDelete = vi.fn(async () => ({ ok: true as const }));
    render({ api: { foodDelete } });
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Example poha' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(screen.queryByText('Example poha')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    const rows = within(screen.getByRole('list', { name: 'Eaten' })).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['08:40Example poha280', '13:10Example roti240']);
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(foodDelete).not.toHaveBeenCalled();
  });

  it('sets the daily target from its sheet, 800 to 6,000', async () => {
    const foodTargets = vi.fn(async () => ({ ok: true as const }));
    render({ api: { foodTargets } });
    fireEvent.click(await screen.findByRole('button', { name: 'Daily target 2,000 kcal. Change it' }));
    const sheet = await screen.findByRole('dialog', { name: 'Daily calorie target' });
    const input = within(sheet).getByLabelText('kcal a day') as HTMLInputElement;
    expect(input.value).toBe('2000');
    expect(input.inputMode).toBe('numeric');
    fireEvent.change(input, { target: { value: '500' } });
    expect((within(sheet).getByRole('button', { name: 'Save target' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(sheet).getByText('A whole number from 800 to 6,000.')).toBeTruthy();
    fireEvent.change(input, { target: { value: '1800' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save target' }));
    await waitFor(() => expect(foodTargets).toHaveBeenCalledWith({ kcalTarget: 1800 }, expect.any(String)));
  });

  it('a failed target keeps the sheet and its value, with Not saved', async () => {
    const foodTargets = vi.fn(async (): Promise<never> => {
      throw new ApiError('network', 'offline', 0);
    });
    render({ api: { foodTargets } });
    fireEvent.click(await screen.findByRole('button', { name: 'Daily target 2,000 kcal. Change it' }));
    const sheet = await screen.findByRole('dialog', { name: 'Daily calorie target' });
    fireEvent.change(within(sheet).getByLabelText('kcal a day'), { target: { value: '1800' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save target' }));
    expect((await within(sheet).findByRole('alert')).textContent).toMatch(/^Not saved\. Could not reach the Mac/);
    expect((within(sheet).getByLabelText('kcal a day') as HTMLInputElement).value).toBe('1800');
  });
});

describe('Food: the add sheet', () => {
  it('Type: adds a name and kcal, and keeps it for one tap when asked', async () => {
    const foodAdd = vi.fn(async () => ({ id: id(40) }));
    render({ api: { foodAdd } });
    const sheet = await openAdd();
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: ' Example upma ' } });
    fireEvent.change(within(sheet).getByLabelText('kcal'), { target: { value: '310' } });
    fireEvent.click(within(sheet).getByRole('switch'));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(foodAdd).toHaveBeenCalledWith({ day: DAY, name: 'Example upma', kcal: 310, save: true }, expect.any(String)));
  });

  it('Type: a failed add keeps the sheet and what was typed, with Not saved', async () => {
    const foodAdd = vi.fn(async (): Promise<never> => {
      throw new ApiError('conflict', 'This day has 200 entries. That is the most it keeps.', 409);
    });
    render({ api: { foodAdd } });
    const sheet = await openAdd();
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Example upma' } });
    fireEvent.change(within(sheet).getByLabelText('kcal'), { target: { value: '310' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }));
    expect((await within(sheet).findByRole('alert')).textContent).toBe('Not saved. This day has 200 entries. That is the most it keeps.');
    expect((within(sheet).getByLabelText('Name') as HTMLInputElement).value).toBe('Example upma');
    expect((within(sheet).getByLabelText('kcal') as HTMLInputElement).value).toBe('310');
  });

  it('Saved: one tap adds it with a 5 s Undo, and Forget drops it at once with its own Undo', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const foodAdd = vi.fn(async () => ({ id: id(41) }));
    const foodDelete = vi.fn(async () => ({ ok: true as const }));
    const foodSavedDelete = vi.fn(async () => ({ ok: true as const }));
    render({ api: { foodAdd, foodDelete, foodSavedDelete } });
    const sheet = await openAdd();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Saved' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add Example roti, 120 kcal' }));
    await waitFor(() => expect(foodAdd).toHaveBeenCalledWith({ day: DAY, savedId: id(30) }, expect.any(String)));
    expect(await within(sheet).findByText('Added: Example roti')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(foodDelete).toHaveBeenCalledWith(id(41), expect.any(String)));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Saved food Example roti' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Forget' }));
    expect(within(sheet).queryByRole('button', { name: 'Add Example roti, 120 kcal' })).toBeNull();
    expect(within(sheet).getByText('Forgotten: Example roti')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Undo' }));
    expect(within(sheet).getByRole('button', { name: 'Add Example roti, 120 kcal' })).toBeTruthy();
    expect(foodSavedDelete).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Saved food Example roti' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Forget' }));
    await act(async () => vi.advanceTimersByTime(5_100));
    expect(foodSavedDelete).toHaveBeenCalledWith(id(30), expect.any(String));
  });

  it('Ask Claude: says why when it cannot run on this Mac', async () => {
    render({ status: status({ estimate: { available: false, reason: NO_ESTIMATE } }) });
    const sheet = await openAdd();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Ask Claude' }));
    expect(within(sheet).getByText(NO_ESTIMATE)).toBeTruthy();
    expect(within(sheet).queryByLabelText('What did you eat?')).toBeNull();
  });

  it('Ask Claude: says what went wrong when the Life status could not be read, with Try again', async () => {
    const lifeStatus = vi.fn(async (): Promise<never> => {
      throw new ApiError('internal', 'Something broke on the Mac.', 500);
    });
    render({ api: { lifeStatus } });
    const sheet = await openAdd();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Ask Claude' }));
    expect(await within(sheet).findByText('Something broke on the Mac.')).toBeTruthy();
    expect(within(sheet).queryByText('Asking the Mac…')).toBeNull();
    const calls = lifeStatus.mock.calls.length;
    fireEvent.click(within(sheet).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(lifeStatus.mock.calls.length).toBe(calls + 1));
  });

  it('Ask Claude: sends the text with no Idempotency-Key, shows editable rows, and adds the ticked ones', async () => {
    const reply: FoodEstimate = { items: [{ name: 'Roti', kcal: 240 }, { name: 'Dal', kcal: 180 }], note: 'Assumed 2 medium rotis and 1 bowl of dal.' };
    const foodEstimate = vi.fn(async (_text: string, _opts?: { signal?: AbortSignal }) => reply);
    const foodAdd = vi.fn(async () => ({ id: id(42) }));
    render({ api: { foodEstimate, foodAdd } });
    const sheet = await openAdd();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Ask Claude' }));
    fireEvent.change(within(sheet).getByLabelText('What did you eat?'), { target: { value: '2 rotis and dal' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Estimate' }));
    const rows = await within(sheet).findByRole('list', { name: "Claude's estimate" });
    // Two arguments only: the text and the abort signal. No key goes with it (spec 1.5, LP3).
    expect(foodEstimate).toHaveBeenCalledTimes(1);
    expect(foodEstimate.mock.calls[0]).toHaveLength(2);
    expect(foodEstimate.mock.calls[0]?.[0]).toBe('2 rotis and dal');
    expect(foodEstimate.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(within(sheet).getByText(reply.note!)).toBeTruthy();
    expect(within(sheet).getByText(ESTIMATE_CHECK)).toBeTruthy();
    expect(foodAdd).not.toHaveBeenCalled();
    const names = within(rows).getAllByLabelText('Name') as HTMLInputElement[];
    expect(names.map((n) => n.value)).toEqual(['Roti', 'Dal']);
    fireEvent.change(within(rows).getAllByLabelText('kcal')[0]!, { target: { value: '260' } });
    fireEvent.click(within(rows).getByRole('checkbox', { name: 'Add Dal' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add 1 item' }));
    await waitFor(() => expect(foodAdd).toHaveBeenCalledWith({ day: DAY, name: 'Roti', kcal: 260 }, expect.any(String)));
    expect(foodAdd).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add food' })).toBeNull());
  });

  it('Ask Claude: "Asking Claude…" with Cancel, which aborts the request', async () => {
    let signal: AbortSignal | undefined;
    const foodEstimate = vi.fn((_text: string, opts?: { signal?: AbortSignal }) => {
      signal = opts?.signal;
      return new Promise<FoodEstimate>(() => undefined);
    });
    render({ api: { foodEstimate } });
    const sheet = await openAdd();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Ask Claude' }));
    fireEvent.change(within(sheet).getByLabelText('What did you eat?'), { target: { value: 'a bowl of example soup' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Estimate' }));
    expect(await within(sheet).findByText('Asking Claude…')).toBeTruthy();
    expect(signal?.aborted).toBe(false);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    expect(signal?.aborted).toBe(true);
    expect((within(sheet).getByLabelText('What did you eat?') as HTMLTextAreaElement).value).toBe('a bowl of example soup');
  });

  it('Ask Claude: a refusal shows its sentence and "Type it instead" opens Type with the text', async () => {
    const foodEstimate = vi.fn(async (): Promise<never> => {
      throw new ApiError('estimate_failed', "Claude couldn't estimate that. Type the calories instead.", 502);
    });
    render({ api: { foodEstimate } });
    const sheet = await openAdd();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Ask Claude' }));
    fireEvent.change(within(sheet).getByLabelText('What did you eat?'), { target: { value: 'example thali' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Estimate' }));
    expect((await within(sheet).findByRole('alert')).textContent).toBe("Claude couldn't estimate that. Type the calories instead.");
    fireEvent.click(within(sheet).getByRole('button', { name: 'Type it instead' }));
    expect(within(sheet).getByRole('button', { name: 'Type' }).getAttribute('aria-pressed')).toBe('true');
    expect((within(sheet).getByLabelText('Name') as HTMLInputElement).value).toBe('example thali');
  });

  it('Ask Claude: no account with room is the daemon sentence too', async () => {
    const foodEstimate = vi.fn(async (): Promise<never> => {
      throw new ApiError('conflict', 'No account has room for an estimate right now. Type the calories instead.', 409);
    });
    render({ api: { foodEstimate } });
    const sheet = await openAdd();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Ask Claude' }));
    fireEvent.change(within(sheet).getByLabelText('What did you eat?'), { target: { value: 'example' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Estimate' }));
    expect(await within(sheet).findByText(/No account has room/)).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Type it instead' })).toBeTruthy();
  });

  it('from Today: loads the saved foods itself', async () => {
    const lifeToday = vi.fn(async () => ({ day: DAY, food: { kcal: 0, target: 2000, weight: null } }));
    const { api } = render({ path: '/today', api: { lifeToday } });
    fireEvent.click(await screen.findByRole('button', { name: 'Add food' }));
    const sheet = await screen.findByRole('dialog', { name: 'Add food' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Saved' }));
    expect(await within(sheet).findByRole('button', { name: 'Add Example roti, 120 kcal' })).toBeTruthy();
    expect(api.foodDay).toHaveBeenCalledWith(DAY);
  });
});
