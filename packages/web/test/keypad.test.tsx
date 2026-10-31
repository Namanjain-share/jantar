/**
 * The keypad (v0.4.2, spec 3; session/Keypad.tsx) in the dock and under the
 * Screen tab: ↓ composes moves, Enter sends one body `{screen, lines, move,
 * key}` with the screen key and the line count of the read it was shown,
 * the screen is read again after each send, refusals keep the moves, moves
 * counted on one screen never go to another (a 409 or a read with another
 * key clears them), and nothing offers keys while the screen has a dialog
 * with buttons.
 *
 * Fake timers that move with real time: Enter is dropped within
 * TAP_GUARD_MS of a new screen showing (or of an Enter dropped before it),
 * so `ready()` lets that pass.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIALOG_GATES, KEYPAD_ESCAPE, KEYPAD_LINES, type Features, type ScreenResponse, type SessionStatus } from '@jantar/protocol';
import { ApiError, type Api } from '../src/lib/api.js';
import { TAP_GUARD_MS } from '../src/ui/screens/session/answer.js';
import { KEYPAD_CHANGED, KEYPAD_CLEARED, KEYPAD_HINT, KEYPAD_LOOK, KEYPAD_MAX_MOVE, KEYPAD_UNSTEADY } from '../src/ui/screens/session/Keypad.js';
import fixtures from './term-dialog-fixtures.json';
import { fakeApi, iso, renderApp, session, stateWith } from './helpers.js';

const KEY = 'b'.repeat(64);
/** A screen Jantar can't turn into buttons: a list with a pointer and no hint line. */
const UNKNOWN: ScreenResponse = { text: 'Select an item\n❯ First item\n  Second item\n  Third item', lines: 4, at: iso(0), backend: 'terminal-app', screenKey: KEY };
const KEY2 = 'd'.repeat(64);
/** Another list, its pointer on Beta: moves counted on UNKNOWN would choose something else here. */
const OTHER: ScreenResponse = { ...UNKNOWN, text: 'Select an item\n  Alpha\n❯ Beta\n  Gamma', screenKey: KEY2 };

const card = () => screen.getByRole('article');
const keys = () => within(card()).getByRole('region', { name: 'Keys' });
const down = () => within(keys()).getByRole('button', { name: 'Down' }) as HTMLButtonElement;
const enter = () => within(keys()).getByRole('button', { name: /^Enter/ }) as HTMLButtonElement;
const lastLines = () => within(card()).getByLabelText('Last lines of the terminal').textContent;

/** Let `ms` of fake time pass. */
async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
/** Let TAP_GUARD_MS pass, so the screen on show takes keys. */
const settle = () => pass(TAP_GUARD_MS);
/** The keys are on and the screen has been shown long enough to send. */
async function ready() {
  await waitFor(() => expect(enter().disabled).toBe(false));
  await settle();
}
/** The poll reads again at once when the page shows (session/screen.ts). */
const readAgain = () => act(() => void document.dispatchEvent(new Event('visibilitychange')));
/** Let the clicks so far land: whatever they send is in the mock by then. */
const landed = () => act(async () => undefined);

afterEach(() => vi.useRealTimers());

function open(opts: { api?: Partial<Api>; read?: ScreenResponse; status?: SessionStatus; features?: Partial<Features>; conn?: 'offline' } = {}) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const getScreen = vi.fn(async (_sid: string, _lines?: number) => opts.read ?? UNKNOWN);
  const api = fakeApi({ getScreen, sessionKeypad: vi.fn(async () => undefined), ...opts.api });
  const utils = renderApp({
    path: '/s/a',
    api,
    status: opts.conn ?? 'live',
    state: stateWith({ sessions: [session('a', { status: opts.status ?? 'waiting' })], features: { controls: true, ...opts.features } }),
  });
  return { ...utils, api, getScreen };
}

describe('the keypad in the dock', () => {
  it('composes moves, then Enter sends one body with the read\'s screen key and its line count, and reads again', async () => {
    const { api, getScreen } = open();
    await ready();
    expect(within(keys()).getByText('no moves')).toBeTruthy();
    expect(within(keys()).getByText(KEYPAD_HINT)).toBeTruthy();
    fireEvent.click(down());
    fireEvent.click(down());
    expect(within(keys()).getByText('moves: ↓ 2')).toBeTruthy();
    // Nothing is typed until Enter.
    expect(api.sessionKeypad).not.toHaveBeenCalled();
    const before = getScreen.mock.calls.length;
    fireEvent.click(enter());
    await waitFor(() => expect(api.sessionKeypad).toHaveBeenCalledTimes(1));
    // The lines the read asked for (KEYPAD_LINES), not the reply's own count (4).
    expect(api.sessionKeypad).toHaveBeenCalledWith('a', { screen: KEY, lines: KEYPAD_LINES, move: 2, key: 'enter' }, expect.any(String));
    expect(await within(keys()).findByText('Sent ↓ 2 and Enter')).toBeTruthy();
    expect(within(keys()).getByText('no moves')).toBeTruthy();
    await waitFor(() => expect(getScreen.mock.calls.length).toBeGreaterThan(before));
    expect(getScreen.mock.calls.every(([, lines]) => lines === KEYPAD_LINES)).toBe(true);
  });

  it('Enter alone sends no moves; clear drops the pending ones', async () => {
    const { api } = open();
    await ready();
    fireEvent.click(down());
    fireEvent.click(within(keys()).getByRole('button', { name: 'clear' }));
    expect(within(keys()).getByText('no moves')).toBeTruthy();
    fireEvent.click(enter());
    await waitFor(() => expect(api.sessionKeypad).toHaveBeenCalledWith('a', { screen: KEY, lines: KEYPAD_LINES, move: 0, key: 'enter' }, expect.any(String)));
  });

  it('offers ↑ only with DIALOG_GATES.up and Esc only with KEYPAD_ESCAPE, and no text field', async () => {
    open();
    await ready();
    expect(within(keys()).queryByRole('button', { name: 'Up' }) !== null).toBe(DIALOG_GATES.up);
    expect(within(keys()).queryByRole('button', { name: 'Esc' }) !== null).toBe(KEYPAD_ESCAPE);
    expect(within(keys()).queryByRole('textbox')).toBeNull();
  });

  it('as shipped, ↑ is on (SP14) and Esc is off (SP1): ↑ and ↓ add up, and Enter sends a negative move', async () => {
    expect(DIALOG_GATES.up).toBe(true);
    expect(KEYPAD_ESCAPE).toBe(false);
    const { api } = open();
    await ready();
    const up = within(keys()).getByRole('button', { name: 'Up' }) as HTMLButtonElement;
    fireEvent.click(up);
    fireEvent.click(up);
    fireEvent.click(down());
    expect(within(keys()).getByText('moves: ↑ 1')).toBeTruthy();
    fireEvent.click(enter());
    await waitFor(() => expect(api.sessionKeypad).toHaveBeenCalledWith('a', { screen: KEY, lines: KEYPAD_LINES, move: -1, key: 'enter' }, expect.any(String)));
    expect(await within(keys()).findByText('Sent ↑ 1 and Enter')).toBeTruthy();
    // ↑ stops at the same bound as ↓.
    for (let i = 0; i < KEYPAD_MAX_MOVE + 5; i += 1) fireEvent.click(up);
    expect(within(keys()).getByText(`moves: ↑ ${KEYPAD_MAX_MOVE}`)).toBeTruthy();
    expect(up.disabled).toBe(true);
  });

  it(`stops at ${KEYPAD_MAX_MOVE} moves`, async () => {
    open();
    await ready();
    for (let i = 0; i < KEYPAD_MAX_MOVE + 5; i += 1) fireEvent.click(down());
    expect(within(keys()).getByText(`moves: ↓ ${KEYPAD_MAX_MOVE}`)).toBeTruthy();
    expect(down().disabled).toBe(true);
  });

  it('moves counted on one screen are not sent onto the next: Enter clears them, and a double tap sends nothing', async () => {
    const getScreen = vi.fn().mockResolvedValueOnce(UNKNOWN).mockResolvedValue(OTHER);
    const { api } = open({ api: { getScreen } });
    await ready();
    fireEvent.click(down());
    readAgain();
    await waitFor(() => expect(lastLines()).toContain('❯ Beta'));
    await settle();
    // Both halves of a double tap on Enter, after the user has had the new screen for a while.
    fireEvent.click(enter());
    fireEvent.click(enter());
    await landed();
    expect(api.sessionKeypad).not.toHaveBeenCalled();
    expect(within(keys()).getByText(KEYPAD_CLEARED)).toBeTruthy();
    expect(within(keys()).getByText('no moves')).toBeTruthy();
    // Counted again on the screen in front of the user, the keys go.
    await settle();
    fireEvent.click(down());
    fireEvent.click(enter());
    await waitFor(() => expect(api.sessionKeypad).toHaveBeenCalledWith('a', { screen: KEY2, lines: KEYPAD_LINES, move: 1, key: 'enter' }, expect.any(String)));
    expect(api.sessionKeypad).toHaveBeenCalledTimes(1);
  });

  it('an Enter that lands as another screen shows clears the moves counted on the one before', async () => {
    const getScreen = vi.fn().mockResolvedValueOnce(UNKNOWN).mockResolvedValue(OTHER);
    const { api } = open({ api: { getScreen } });
    await ready();
    fireEvent.click(down());
    readAgain();
    await waitFor(() => expect(lastLines()).toContain('❯ Beta'));
    fireEvent.click(enter());
    fireEvent.click(enter());
    await landed();
    expect(api.sessionKeypad).not.toHaveBeenCalled();
    expect(within(keys()).getByText(KEYPAD_CLEARED)).toBeTruthy();
    expect(within(keys()).getByText('no moves')).toBeTruthy();
  });

  it(`drops an Enter within ${TAP_GUARD_MS} ms of the keypad showing, and each dropped Enter starts that again`, async () => {
    const { api } = open();
    await waitFor(() => expect(enter().disabled).toBe(false));
    await pass(TAP_GUARD_MS - 200);
    fireEvent.click(enter());
    // Nothing changed on the Mac: the keypad has only just shown.
    expect(await within(keys()).findByText(KEYPAD_LOOK)).toBeTruthy();
    // Past the first window, but inside the one the dropped Enter started.
    await pass(TAP_GUARD_MS - 200);
    fireEvent.click(enter());
    await landed();
    expect(api.sessionKeypad).not.toHaveBeenCalled();
    await settle();
    fireEvent.click(enter());
    await waitFor(() => expect(api.sessionKeypad).toHaveBeenCalledWith('a', { screen: KEY, lines: KEYPAD_LINES, move: 0, key: 'enter' }, expect.any(String)));
  });

  it(`drops an Enter within ${TAP_GUARD_MS} ms of a new screen showing (it was aimed at the one before)`, async () => {
    const getScreen = vi.fn().mockResolvedValueOnce(UNKNOWN).mockResolvedValue(OTHER);
    const { api } = open({ api: { getScreen } });
    await ready();
    readAgain();
    await waitFor(() => expect(lastLines()).toContain('❯ Beta'));
    fireEvent.click(enter());
    expect(await within(keys()).findByText(KEYPAD_CHANGED)).toBeTruthy();
    expect(api.sessionKeypad).not.toHaveBeenCalled();
    await settle();
    fireEvent.click(enter());
    await waitFor(() => expect(api.sessionKeypad).toHaveBeenCalledWith('a', { screen: KEY2, lines: KEYPAD_LINES, move: 0, key: 'enter' }, expect.any(String)));
  });

  it('a 409 clears the moves and reads again; a double tap on the screen it brings sends nothing', async () => {
    const sessionKeypad = vi.fn().mockRejectedValueOnce(new ApiError('conflict', 'The terminal changed. Look at it again.', 409)).mockResolvedValue(undefined);
    const getScreen = vi.fn().mockResolvedValueOnce(UNKNOWN).mockResolvedValue(OTHER);
    open({ api: { sessionKeypad, getScreen } });
    await ready();
    fireEvent.click(down());
    fireEvent.click(enter());
    expect(await within(keys()).findByText(KEYPAD_CLEARED)).toBeTruthy();
    expect(within(keys()).getByText('no moves')).toBeTruthy();
    await waitFor(() => expect(lastLines()).toContain('❯ Beta'));
    fireEvent.click(enter());
    fireEvent.click(enter());
    await landed();
    expect(sessionKeypad).toHaveBeenCalledTimes(1);
    await settle();
    fireEvent.click(down());
    fireEvent.click(enter());
    await waitFor(() => expect(sessionKeypad).toHaveBeenLastCalledWith('a', { screen: KEY2, lines: KEYPAD_LINES, move: 1, key: 'enter' }, expect.any(String)));
    expect(sessionKeypad).toHaveBeenCalledTimes(2);
  });

  it('a 409 on the same screen holds the next Enter back too; two 409s in a row say the terminal keeps changing', async () => {
    const sessionKeypad = vi.fn().mockRejectedValue(new ApiError('conflict', 'The terminal changed. Look at it again.', 409));
    const { getScreen } = open({ api: { sessionKeypad } });
    await ready();
    const before = getScreen.mock.calls.length;
    fireEvent.click(enter());
    expect(await within(keys()).findByText(KEYPAD_CHANGED)).toBeTruthy();
    await waitFor(() => expect(getScreen.mock.calls.length).toBeGreaterThan(before));
    // The read brought the same key back, and still the window starts again from the 409.
    await waitFor(() => expect(enter().disabled).toBe(false));
    fireEvent.click(enter());
    await landed();
    expect(sessionKeypad).toHaveBeenCalledTimes(1);
    await settle();
    fireEvent.click(enter());
    expect(await within(keys()).findByText(KEYPAD_UNSTEADY)).toBeTruthy();
    expect(sessionKeypad).toHaveBeenCalledTimes(2);
  });

  it("a refusal shows the daemon's sentence and keeps the moves", async () => {
    const reason = "Claude's prompt box is showing: use the composer. (↑ would bring back your last prompt and Return would send it.)";
    const sessionKeypad = vi.fn().mockRejectedValue(new ApiError('refused', reason, 422));
    open({ api: { sessionKeypad } });
    await ready();
    fireEvent.click(down());
    fireEvent.click(enter());
    expect((await within(keys()).findByRole('alert')).textContent).toBe(reason);
    expect(within(keys()).getByText('moves: ↓ 1')).toBeTruthy();
  });

  it('a network error keeps the Idempotency-Key for the same keys; the next send gets a new one', async () => {
    const sessionKeypad = vi.fn().mockRejectedValueOnce(new ApiError('network', 'offline', 0)).mockResolvedValue(undefined);
    open({ api: { sessionKeypad } });
    await ready();
    fireEvent.click(enter());
    await within(keys()).findByRole('alert');
    fireEvent.click(enter());
    await within(keys()).findByText('Sent Enter');
    await ready();
    fireEvent.click(enter());
    await waitFor(() => expect(sessionKeypad).toHaveBeenCalledTimes(3));
    const ids = sessionKeypad.mock.calls.map((c) => c[2] as string);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[1]);
  });

  it('is off without a screen key to check, offline, and with Controls off (with why)', async () => {
    const { screenKey: _key, ...noKey } = UNKNOWN;
    const first = open({ read: noKey });
    await within(card()).findByRole('region', { name: 'Keys' });
    expect(enter().disabled).toBe(true);
    expect(within(keys()).getByText(/can't be checked at the moment of typing/)).toBeTruthy();
    first.unmount();

    const second = open({ conn: 'offline' });
    await within(card()).findByRole('region', { name: 'Keys' });
    expect(enter().disabled).toBe(true);
    expect(down().disabled).toBe(true);
    second.unmount();

    open({ features: { controls: false } });
    await within(card()).findByRole('region', { name: 'Keys' });
    expect(enter().disabled).toBe(true);
    expect(within(keys()).getByText(/^Controls are off\. Turn them on at your Mac: jantar controls on$/)).toBeTruthy();
  });

  it('never shows on a dialog with buttons', async () => {
    const d = (fixtures as unknown as Record<string, { dialog: ScreenResponse['dialog'] }>).PLAN_80COL?.dialog;
    open({ read: { ...UNKNOWN, dialog: d } });
    await within(card()).findByRole('group', { name: 'Choices' });
    expect(within(card()).queryByRole('region', { name: 'Keys' })).toBeNull();
  });
});

describe('the keypad under the Screen tab', () => {
  const tab = () => screen.getByRole('tabpanel', { name: 'Screen' });

  it('opens with Keys while no dialog shows, and sends the 80 lines the tab shows', async () => {
    const { api } = open({ status: 'idle' });
    fireEvent.click(screen.getByRole('tab', { name: 'Screen' }));
    await waitFor(() => expect(within(tab()).getByLabelText('Terminal text').textContent).toContain('Select an item'));
    const toggle = within(tab()).getByRole('button', { name: 'Keys' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    // The keypad is its own chunk: it shows once loaded.
    const pad = await within(tab()).findByRole('region', { name: 'Keys' });
    // An Enter as the keys open: nothing on the Mac changed, the keypad only just showed.
    fireEvent.click(within(pad).getByRole('button', { name: /^Enter/ }));
    expect(await within(pad).findByText(KEYPAD_LOOK)).toBeTruthy();
    expect(api.sessionKeypad).not.toHaveBeenCalled();
    await settle();
    fireEvent.click(within(pad).getByRole('button', { name: 'Down' }));
    fireEvent.click(within(pad).getByRole('button', { name: /^Enter/ }));
    await waitFor(() => expect(api.sessionKeypad).toHaveBeenCalledWith('a', { screen: KEY, lines: 80, move: 1, key: 'enter' }, expect.any(String)));
  });

  it('has no Keys while Controls are off, or while the dock answers a dialog', async () => {
    const off = open({ status: 'idle', features: { controls: false } });
    fireEvent.click(screen.getByRole('tab', { name: 'Screen' }));
    await waitFor(() => expect(within(tab()).getByLabelText('Terminal text').textContent).toContain('Select an item'));
    expect(within(tab()).queryByRole('button', { name: 'Keys' })).toBeNull();
    off.unmount();

    const d = (fixtures as unknown as Record<string, { dialog: ScreenResponse['dialog'] }>).PERM_CREATE_2?.dialog;
    open({ status: 'idle', read: { ...UNKNOWN, dialog: d } });
    fireEvent.click(screen.getByRole('tab', { name: 'Screen' }));
    // An idle session's read starts with the tab's text, and its dialog brings the dock up.
    await screen.findByRole('group', { name: 'Choices' });
    expect(within(tab()).queryByRole('button', { name: 'Keys' })).toBeNull();
  });
});
