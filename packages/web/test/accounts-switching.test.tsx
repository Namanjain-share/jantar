/**
 * 0.14.0 Switching rules: an account's weekly cap on its row, and the sheet
 * that reads and saves ccw's switching rules (open, edit, save, a 409 from
 * a switch.json that won't parse, offline). Made-up accounts only.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { SWITCH_RULES, type SwitchRules } from '@jantar/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiRequest, type ApiRoute } from '../src/lib/api.js';
import { writeLocal } from '../src/lib/storage.js';
import { buildRows, capText, closedFlags, runwaySentence } from '../src/ui/screens/accounts/model.js';
import { HOLD_NO_CAP_TEXT, OFFLINE_TEXT, PRESET_TEXT, SAVED_TEXT, SWITCHING_PATHS, patchOf } from '../src/ui/screens/accounts/SwitchingSheet.js';
import { heldSentence } from '../src/ui/screens/new/AccountPicker.js';
import { layoutAt } from '../src/ui/shell/layout.js';
import { dayClock } from '../src/ui/screens/accounts/time.js';
import { LOCAL_DEVICE_KEY } from '../src/ui/screens/devices/local.js';
import { NOW, account, fakeApi, iso, opened, preloadPlaces, renderApp, stateWith } from './helpers.js';

preloadPlaces('accounts');

afterEach(() => {
  vi.restoreAllMocks();
});

const UNTIL = iso(2 * 86_400_000 + 12 * 3_600_000);
const plan = (over: object = {}) => ({
  source: 'ccw-legacy' as const,
  next: null,
  accounts: [
    { id: 1, burnPctPerMin: 0, ridesReset: true, usable: true },
    { id: 2, burnPctPerMin: 0, ridesReset: true, usable: true, weeklyCap: 50, capUntil: UNTIL, nextCap: 75 },
  ],
  updatedAt: iso(0),
  ceiling: 97,
  weeklyCeiling: 95,
  ...over,
});
const RULES: SwitchRules = { hold: [3], ceiling: 97, weeklyCeiling: 95, leadMin: 10, weeklyRamp: { '2': { days: [50, 50, 50, 50, 75, 85, 95], lastHour: 100 } } };
const accounts = [
  account(1, { windows: [{ kind: 'five_hour', pct: 20, resetsAt: iso(3_600_000) }, { kind: 'seven_day', pct: 30, resetsAt: iso(4 * 86_400_000) }] }),
  account(2, { alias: 'side', windows: [{ kind: 'five_hour', pct: 10, resetsAt: iso(3_600_000) }, { kind: 'seven_day', pct: 40, resetsAt: iso(4 * 86_400_000) }] }),
  account(3, { held: true }),
];

/** A fake of the sheet's two calls: GET answers `rules`, PATCH runs `save`. */
function api(save: (body: unknown) => Promise<SwitchRules> = async () => RULES, rules: () => Promise<SwitchRules> = async () => RULES) {
  const request = vi.fn(async (route: ApiRoute, init?: ApiRequest): Promise<unknown> => {
    if (route.method === 'GET' && route.path === SWITCHING_PATHS.read.path) return rules();
    if (route.method === 'PATCH' && route.path === SWITCHING_PATHS.save.path) return save(init?.body);
    throw new Error(`unexpected ${route.method} ${route.path}`);
  });
  return Object.assign(fakeApi({ getPlan: vi.fn(async () => plan()), request: request as never }), { calls: request });
}

async function openSheet() {
  await opened('Accounts');
  fireEvent.click(await screen.findByRole('button', { name: 'Switching rules' }));
  const dialog = await screen.findByRole('dialog', { name: 'Switching rules' });
  await within(dialog).findByRole('form', { name: 'Switching rules' });
  return dialog;
}

const group = (dialog: HTMLElement, name: string) => within(dialog).getByRole('group', { name });

describe('0.14.0 the weekly cap on an account', () => {
  it('reads the cap from the plan and says it with the next one', () => {
    const rows = buildRows(stateWith({ accounts }), plan(), 97, NOW);
    expect(rows.map((r) => r.cap)).toEqual([null, { now: 50, until: Date.parse(UNTIL), next: 75, reading: true }, null]);
    expect(capText(rows[1]!.cap!, NOW)).toBe(`cap 50% · 75% ${dayClock(Date.parse(UNTIL), NOW)}`);
    expect(capText({ now: 95, until: null, next: null, reading: true }, NOW)).toBe('cap 95%');
    // a ramp with no weekly reading: the weekly limit, and it says why
    expect(capText({ now: 95, until: null, next: null, reading: false }, NOW)).toBe('cap 95% · no weekly reading');
    expect(rows[1]!.flags.map((f) => f.text)).toContain('cap 50%');
    // a paired server's accounts have no ccw plan
    expect(buildRows(stateWith({ accounts }), plan({ source: 'none' }), 97, NOW).every((r) => r.cap === null)).toBe(true);
  });

  it('shows it beside the weekly use in the phone row', async () => {
    renderApp({ path: '/accounts', api: api(), state: stateWith({ accounts }) });
    await opened('Accounts');
    const list = screen.getByRole('list', { name: 'Accounts' });
    const two = within(list).getAllByRole('listitem')[1]!;
    expect(await within(two).findByText('cap 50%')).toBeTruthy(); // its flag on the closed row
    fireEvent.click(within(two).getByRole('button', { name: '02 side' }));
    expect(within(two).getByText(`cap 50% · 75% ${dayClock(Date.parse(UNTIL), NOW)}`)).toBeTruthy();
  });

  it('a closed phone row shows the cap beside another flag, and says when there is no weekly reading (320 and 390)', async () => {
    const unread = account(4, { alias: 'quiet', windows: [{ kind: 'five_hour', pct: 5, resetsAt: iso(3_600_000) }] }); // no weekly window
    const withNext = plan({
      next: 2,
      accounts: [...plan().accounts, { id: 4, burnPctPerMin: 0, ridesReset: true, usable: true, weeklyCap: 95 }],
    });
    const rows = buildRows(stateWith({ accounts: [...accounts, unread] }), withNext, 97, NOW);
    expect(closedFlags(rows[1]!.flags).map((f) => f.text)).toEqual(['next →', 'cap 50%']);
    expect(closedFlags(rows[3]!.flags).map((f) => [f.text, f.note])).toEqual([['cap 95%', 'no weekly reading']]);
    expect(closedFlags([{ text: 'default login', tone: 'plain' }])).toEqual([]);
    for (const width of [320, 390]) {
      const { unmount } = renderApp({
        path: '/accounts',
        api: Object.assign(api(), { getPlan: vi.fn(async () => withNext) }),
        state: stateWith({ accounts: [...accounts, unread] }),
        layout: layoutAt(width, { coarse: true }),
      });
      await opened('Accounts');
      const list = screen.getByRole('list', { name: 'Accounts' });
      const [, two, , four] = within(list).getAllByRole('listitem');
      // closed: both flags, in one group that wraps
      await within(two!).findByText('next →');
      const flags = within(two!).getByText('cap 50%').closest('[data-flags]') as HTMLElement;
      expect(flags.className).toContain('flex-wrap');
      expect(within(flags).getByText('next →')).toBeTruthy();
      expect(within(four!).getByText('cap 95%')).toBeTruthy();
      expect(within(four!).getByText('· no weekly reading')).toBeTruthy();
      // opened: the cap line says it whole
      fireEvent.click(within(four!).getByRole('button', { name: '04 quiet' }));
      expect(within(four!).getByText('cap 95% · no weekly reading')).toBeTruthy();
      unmount();
    }
  });

  it('says a held account with a cap still sees its sessions leave at it', () => {
    const held = account(2, { held: true, windows: [{ kind: 'seven_day', pct: 10, resetsAt: iso(4 * 86_400_000) }] });
    const [withCap] = buildRows(stateWith({ accounts: [held] }), plan(), 97, NOW);
    const [noCap] = buildRows(stateWith({ accounts: [held] }), plan({ source: 'none' }), 97, NOW);
    const text = (r: typeof withCap) => runwaySentence(r!, stateWith({ accounts: [held] }), 97, NOW).map((p) => p.text).join('');
    expect(text(withCap)).toContain('Held: autoswitch moves nothing onto it, and its sessions leave once it passes its weekly cap.');
    expect(text(noCap)).toContain('Held: autoswitch moves nothing onto or off it.');
    expect(heldSentence(2)).toBe('Held for other work. ccw will never move this session, even when 02 fills up.');
    expect(heldSentence(2, true)).toBe('Held for other work: ccw moves no session onto 02, but moves this one off once 02 passes its weekly cap.');
  });

  it('works out only what changed', () => {
    expect(patchOf(RULES, RULES)).toBeNull();
    expect(patchOf(RULES, { ...RULES, hold: [3] })).toBeNull();
    expect(patchOf(RULES, { ...RULES, hold: [4, 3], ceiling: 95 })).toEqual({ hold: [3, 4], ceiling: 95 });
    expect(patchOf(RULES, { ...RULES, weeklyRamp: {} })).toEqual({ weeklyRamp: { '2': null } });
    const preset = { days: [...SWITCH_RULES.preset.days], lastHour: SWITCH_RULES.preset.lastHour };
    expect(patchOf(RULES, { ...RULES, weeklyRamp: { ...RULES.weeklyRamp, '1': preset } })).toEqual({ weeklyRamp: { '1': preset } });
  });
});

describe('0.14.0 the Switching rules sheet', () => {
  it('opens with the rules as saved', async () => {
    const a = api();
    renderApp({ path: '/accounts', api: a, state: stateWith({ accounts }) });
    const dialog = await openSheet();
    expect(a.calls).toHaveBeenCalledWith(SWITCHING_PATHS.read);
    expect((within(dialog).getByRole('textbox', { name: '5-hour limit' }) as HTMLInputElement).value).toBe('97');
    expect((within(dialog).getByRole('textbox', { name: 'Weekly limit' }) as HTMLInputElement).value).toBe('95');
    expect((within(dialog).getByRole('textbox', { name: 'Minutes before full' }) as HTMLInputElement).value).toBe('10');
    const three = group(dialog, '03');
    expect((within(three).getByRole('switch', { name: /Hold/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(three).getByRole('switch', { name: /Weekly cap/ }) as HTMLInputElement).checked).toBe(false);
    // Hold: nothing moves onto it; without a cap, nothing off it either
    expect(within(three).getByRole('switch', { name: 'Hold: ccw never moves sessions onto it' })).toBeTruthy();
    expect(within(three).getByRole('switch', { name: /Hold/ }).getAttribute('aria-describedby')).toBe(within(three).getByText(HOLD_NO_CAP_TEXT).id);
    const two = group(dialog, '02 side');
    expect((within(two).getByRole('switch', { name: /Weekly cap/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(two).getByRole('textbox', { name: '02 side day 5' }) as HTMLInputElement).value).toBe('75');
    expect((within(two).getByRole('textbox', { name: '02 side last hour' }) as HTMLInputElement).value).toBe('100');
    // nothing changed yet: nothing to save
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says what Save did in the pinned actions row, announced, and keeps Save off while it saves', async () => {
    let finish: (r: SwitchRules) => void = () => undefined;
    const a = api(() => new Promise<SwitchRules>((r) => (finish = r)));
    renderApp({ path: '/accounts', api: a, state: stateWith({ accounts }) });
    const dialog = await openSheet();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Raise Minutes before full' }));
    const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    fireEvent.click(save);
    await waitFor(() => expect(save.disabled).toBe(true)); // while it saves
    expect(save.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(save);
    fireEvent.submit(within(dialog).getByRole('form', { name: 'Switching rules' }));
    expect(a.calls.mock.calls.filter(([r]) => r.method === 'PATCH')).toHaveLength(1);
    await act(async () => finish({ ...RULES, leadMin: 11 }));
    const receipt = await within(dialog).findByText(SAVED_TEXT);
    const status = receipt.closest('[role="status"]') as HTMLElement;
    expect(status).toBeTruthy();
    // in the actions row, with Save (the row a form sheet pins at its foot)
    const row = status.closest('.sheet-actions') as HTMLElement;
    expect(row).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Save' })).toBe(save);
    expect(row.contains(within(dialog).getByRole('button', { name: 'Close' }))).toBe(true);
    // the live region was there before the receipt, so it is announced
    expect(row.firstElementChild).toBe(status);
  });

  it('asks before Esc or the scrim drops an edit made with − and + or the preset, and not once it is saved (a form sheet)', async () => {
    const custom: SwitchRules = { ...RULES, weeklyRamp: { '2': { days: [40, 40, 40, 40, 60, 80, 90], lastHour: 100 } } };
    const a = api(async (body) => ({ ...custom, ...(body as object) }) as SwitchRules, async () => custom);
    renderApp({ path: '/accounts', api: a, state: stateWith({ accounts }), layout: layoutAt(1440) });
    const dialog = await openSheet();
    const esc = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    // a tap on +: no input event, but an edit
    fireEvent.click(within(dialog).getByRole('button', { name: 'Raise 5-hour limit' }));
    esc();
    expect(await screen.findByRole('group', { name: 'Unsaved changes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect((within(dialog).getByRole('textbox', { name: '5-hour limit' }) as HTMLInputElement).value).toBe('98');
    // − back to as saved: nothing to lose, but the preset is an edit of its own
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lower 5-hour limit' }));
    fireEvent.click(within(group(dialog, '02 side')).getByRole('button', { name: `${PRESET_TEXT} for 02 side` }));
    esc();
    expect(await screen.findByRole('group', { name: 'Unsaved changes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    // saved: Esc closes at once
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await within(dialog).findByText(SAVED_TEXT);
    esc();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Switching rules' })).toBeNull());
    expect(screen.queryByRole('group', { name: 'Unsaved changes' })).toBeNull();
  });

  it('saves only what changed, with one PATCH, and says ccw uses it within a minute', async () => {
    const saved = { ...RULES, hold: [1, 3], weeklyCeiling: 96, weeklyRamp: { ...RULES.weeklyRamp, '1': { days: [45, 50, 50, 50, 75, 85, 95], lastHour: 100 } } };
    const a = api(async () => saved);
    renderApp({ path: '/accounts', api: a, state: stateWith({ accounts }) });
    const dialog = await openSheet();
    const one = group(dialog, '01');
    fireEvent.click(within(one).getByRole('switch', { name: /Hold/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Raise Weekly limit' }));
    fireEvent.click(within(one).getByRole('switch', { name: /Weekly cap/ }));
    // turned on, it starts from the usual week
    expect((within(one).getByRole('textbox', { name: '01 day 7' }) as HTMLInputElement).value).toBe('95');
    fireEvent.click(within(one).getByRole('button', { name: 'Lower 01 day 1' }));
    expect((within(one).getByRole('textbox', { name: '01 day 1' }) as HTMLInputElement).value).toBe('45');
    // typed, and kept within 1 to 100
    const last = within(one).getByRole('textbox', { name: '01 last hour' }) as HTMLInputElement;
    fireEvent.change(last, { target: { value: '250' } });
    fireEvent.blur(last);
    expect(last.value).toBe('100');

    const plans = a.getPlan.mock.calls.length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(SAVED_TEXT)).toBeTruthy();
    const patch = a.calls.mock.calls.find(([r]) => r.method === 'PATCH');
    expect(patch?.[0]).toEqual(SWITCHING_PATHS.save);
    expect(patch?.[1]?.body).toEqual({ hold: [1, 3], weeklyCeiling: 96, weeklyRamp: { '1': { days: [45, 50, 50, 50, 75, 85, 95], lastHour: 100 } } });
    expect(patch?.[1]?.idempotencyKey).toEqual(expect.any(String));
    // the plan is asked for again, and the form now matches what was saved
    await waitFor(() => expect(a.getPlan.mock.calls.length).toBeGreaterThan(plans));
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('turns a weekly cap off, and fills the usual week back in', async () => {
    const a = api(async (body) => ({ ...RULES, weeklyRamp: {} , ...(body as object) }) as SwitchRules);
    renderApp({ path: '/accounts', api: a, state: stateWith({ accounts }) });
    const dialog = await openSheet();
    const two = group(dialog, '02 side');
    fireEvent.click(within(two).getByRole('button', { name: 'Raise 02 side day 1' }));
    expect((within(two).getByRole('textbox', { name: '02 side day 1' }) as HTMLInputElement).value).toBe('55');
    fireEvent.click(within(two).getByRole('button', { name: `${PRESET_TEXT} for 02 side` }));
    expect((within(two).getByRole('textbox', { name: '02 side day 1' }) as HTMLInputElement).value).toBe('50');
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true); // back as saved
    fireEvent.click(within(two).getByRole('switch', { name: /Weekly cap/ }));
    expect(within(two).queryByRole('textbox', { name: '02 side day 1' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await within(dialog).findByText(SAVED_TEXT);
    expect(a.calls.mock.calls.find(([r]) => r.method === 'PATCH')?.[1]?.body).toEqual({ weeklyRamp: { '2': null } });
  });

  it("shows the Mac's 409 under the form and keeps what was typed", async () => {
    const broken = "ccw's switch.json doesn't read as JSON right now, so nothing was saved. Fix the file on the Mac (or wait for ccw to finish writing it), then try again.";
    const a = api(async () => {
      throw new ApiError('conflict', broken, 409);
    });
    renderApp({ path: '/accounts', api: a, state: stateWith({ accounts }) });
    const dialog = await openSheet();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lower 5-hour limit' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(broken);
    expect(within(dialog).queryByText(SAVED_TEXT)).toBeNull();
    expect((within(dialog).getByRole('textbox', { name: '5-hour limit' }) as HTMLInputElement).value).toBe('96');
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false); // try again
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('turns Save off while offline', async () => {
    const a = api();
    const { store } = renderApp({ path: '/accounts', api: a, state: stateWith({ accounts }) });
    const dialog = await openSheet();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Raise Minutes before full' }));
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
    act(() => store.getState().setConn({ status: 'offline', lastOkAt: NOW }));
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText(OFFLINE_TEXT)).toBeTruthy();
    fireEvent.submit(within(dialog).getByRole('form', { name: 'Switching rules' }));
    expect(a.calls.mock.calls.some(([r]) => r.method === 'PATCH')).toBe(false);
  });

  it('says why when the rules cannot be read, and tries again', async () => {
    let fail = true;
    const a = api(undefined, async () => {
      if (fail) throw new ApiError('conflict', "ccw hasn't written its switch.json yet. Start ccw on the Mac once, then try again.", 409);
      return RULES;
    });
    renderApp({ path: '/accounts', api: a, state: stateWith({ accounts }) });
    await opened('Accounts');
    fireEvent.click(await screen.findByRole('button', { name: 'Switching rules' }));
    const dialog = await screen.findByRole('dialog', { name: 'Switching rules' });
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/hasn't written its switch\.json/);
    fail = false;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByRole('form', { name: 'Switching rules' })).toBeTruthy();
  });

  it('is not offered without ccw, nor to a device paired without control', async () => {
    const { unmount } = renderApp({ path: '/accounts', api: fakeApi({ getPlan: vi.fn(async () => plan({ source: 'none', accounts: [] })) }), state: stateWith({ accounts }) });
    await opened('Accounts');
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('button', { name: 'Switching rules' })).toBeNull();
    unmount();
    writeLocal(LOCAL_DEVICE_KEY, { id: 'dev-1', name: 'Viewer', scopes: ['read'] });
    try {
      const a = api();
      renderApp({ path: '/accounts', api: a, state: stateWith({ accounts }) });
      await opened('Accounts');
      await waitFor(() => expect(a.getPlan).toHaveBeenCalled());
      await screen.findByText('cap 50%'); // the plan is in
      expect(screen.queryByRole('button', { name: 'Switching rules' })).toBeNull();
    } finally {
      writeLocal(LOCAL_DEVICE_KEY, undefined);
    }
  });
});
