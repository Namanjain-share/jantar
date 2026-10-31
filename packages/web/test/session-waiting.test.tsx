/**
 * When the session screen shows the terminal dialog dock, and how it reads
 * the terminal (v0.4.2, spec 2.1; Session.tsx and session/screen.ts):
 * waiting for at least SCREEN_PATH_SETTLE_MS, a subagent card, or a read
 * that parsed a dialog in any status but ended; a hook card first; the
 * control bar hidden while the dock shows; one poll per session screen at
 * 3 s while Claude asks, 5 s while it works (first read after 5 s), none
 * while idle, 80 lines while the Screen tab's text shows, paused while the
 * page is hidden, one read in flight at most. Plus the Desk's verb.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEYPAD_LINES, type ScreenResponse, type Session, type TerminalDialog } from '@jantar/protocol';
import { SCREEN_PATH_SETTLE_MS } from '../src/ui/screens/session/screen.js';
// The dock's own chunk, loaded up front: under fake timers its lazy import must not race the test's clock.
import '../src/ui/screens/session/TermDialog.js';
import fixtures from './term-dialog-fixtures.json';
import { emit, fakeApi, iso, NOW, pending, renderApp, session, stateWith } from './helpers.js';

const KEY = 'c'.repeat(64);
const create = (fixtures as unknown as Record<string, { dialog: TerminalDialog }>).PERM_CREATE_2?.dialog as TerminalDialog;
const withDialog: ScreenResponse = { text: 'Create file', lines: 40, at: iso(0), backend: 'terminal-app', screenKey: KEY, dialog: create };
const plain: ScreenResponse = { text: '> ', lines: 1, at: iso(0), backend: 'terminal-app', screenKey: KEY };
/** NOW in the helpers' clock, as statusSince. */
const sinceMs = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const dockHeading = () => screen.queryByRole('heading', { name: /^(Claude asks|Claude is waiting in the terminal|A subagent asks)/ });
const controls = () => screen.queryByRole('group', { name: 'Controls' });

function open(s: Partial<Session>, read: ScreenResponse = plain, extra: { pending?: ReturnType<typeof pending>[] } = {}) {
  const getScreen = vi.fn(async (_sid: string, _lines?: number) => read);
  const api = fakeApi({ getScreen });
  const utils = renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', s)], pending: extra.pending ?? [], features: { controls: true } }) });
  return { ...utils, api, getScreen };
}

/** Let `ms` of fake time pass, with the promises it starts settled. */
async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('when the dock shows (spec 2.1)', () => {
  it(`waiting shows the composer for the first ${SCREEN_PATH_SETTLE_MS} ms (a hook card may come first), then the dock`, async () => {
    open({ status: 'waiting', statusSince: sinceMs(SCREEN_PATH_SETTLE_MS - 400) });
    expect(dockHeading()).toBeNull();
    expect(screen.getByLabelText('Prompt for Claude')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Claude is waiting in the terminal' })).toBeTruthy();
    expect(screen.queryByLabelText('Prompt for Claude')).toBeNull();
  });

  it('a session waiting longer than that shows the dock at once, and no control bar', () => {
    open({ status: 'waiting', statusSince: sinceMs(60_000) });
    expect(dockHeading()?.textContent).toBe('Claude is waiting in the terminal');
    expect(controls()).toBeNull();
  });

  it('a read that parsed a dialog brings the dock up while the session reports working, and hides the control bar', async () => {
    vi.useFakeTimers();
    const { getScreen } = open({ status: 'working' }, withDialog);
    expect(controls()).not.toBeNull();
    expect(getScreen).not.toHaveBeenCalled();
    await pass(5_000);
    expect(getScreen).toHaveBeenCalledWith('a', KEYPAD_LINES);
    expect(screen.getByRole('heading', { name: 'Claude asks · Create file' })).toBeTruthy();
    expect(controls()).toBeNull();
    expect(screen.queryByLabelText('Prompt for Claude')).toBeNull();
  });

  it('a subagent card brings the dock up in any status but ended', async () => {
    const sub = pending('a', { kind: 'subagent-info', tool: 'Bash', agentId: 'agent-1' });
    open({ status: 'idle' }, withDialog, { pending: [sub] });
    expect(await screen.findByRole('heading', { name: 'A subagent asks · Bash' })).toBeTruthy();
    expect(controls()).toBeNull();
  });

  it('a hook card takes the bottom first, even with a dialog on the screen', async () => {
    const card = pending('a');
    const { getScreen } = open({ status: 'waiting' }, withDialog, { pending: [card] });
    await waitFor(() => expect(getScreen).toHaveBeenCalled());
    await act(async () => undefined);
    expect(dockHeading()).toBeNull();
    // The card is the one dock (its own heading names the tool).
    expect(within(screen.getByRole('article')).getByRole('heading', { name: /Bash/ })).toBeTruthy();
  });

  it('an ended session reads nothing and shows no dock', async () => {
    const { getScreen } = open({ status: 'ended' }, withDialog);
    await act(async () => undefined);
    expect(getScreen).not.toHaveBeenCalled();
    expect(dockHeading()).toBeNull();
    expect(screen.getByText('This session has ended.')).toBeTruthy();
  });

  it('when Claude moves on, the dock goes and the composer and control bar come back', async () => {
    const { store } = open({ status: 'waiting', statusSince: sinceMs(60_000) }, withDialog);
    expect(await screen.findByRole('heading', { name: 'Claude asks · Create file' })).toBeTruthy();
    act(() => emit(store, [{ seq: 11, ts: iso(1000), type: 'session.updated', sid: 'a', data: { patch: { status: 'idle', statusSince: iso(1000) } } }]));
    await waitFor(() => expect(dockHeading()).toBeNull());
    expect(screen.getByLabelText('Prompt for Claude')).toBeTruthy();
    expect(controls()).not.toBeNull();
  });
});

describe('the one screen poll (spec 2.1)', () => {
  it('waiting: reads at once, then every 3 s', async () => {
    vi.useFakeTimers();
    const { getScreen } = open({ status: 'waiting', statusSince: sinceMs(60_000) });
    await pass(0);
    expect(getScreen).toHaveBeenCalledTimes(1);
    await pass(3_000);
    expect(getScreen).toHaveBeenCalledTimes(2);
    await pass(3_000);
    expect(getScreen).toHaveBeenCalledTimes(3);
    expect(getScreen.mock.calls.every(([sid, lines]) => sid === 'a' && lines === KEYPAD_LINES)).toBe(true);
  });

  it('working: first after 5 s, then every 5 s; idle: never', async () => {
    vi.useFakeTimers();
    const working = open({ status: 'working' });
    await pass(4_900);
    expect(working.getScreen).not.toHaveBeenCalled();
    await pass(100);
    expect(working.getScreen).toHaveBeenCalledTimes(1);
    await pass(5_000);
    expect(working.getScreen).toHaveBeenCalledTimes(2);
    working.unmount();

    const idle = open({ status: 'idle' });
    await pass(20_000);
    expect(idle.getScreen).not.toHaveBeenCalled();
  });

  it('a status change reads at once', async () => {
    vi.useFakeTimers();
    const { getScreen, store } = open({ status: 'working' });
    await pass(1_000);
    expect(getScreen).not.toHaveBeenCalled();
    act(() => emit(store, [{ seq: 11, ts: iso(1000), type: 'session.updated', sid: 'a', data: { patch: { status: 'waiting', statusSince: iso(1000) } } }]));
    await pass(0);
    expect(getScreen).toHaveBeenCalledTimes(1);
  });

  it("the Screen tab's text reads 80 lines, and the dock reads the same result", async () => {
    const { getScreen } = open({ status: 'waiting', statusSince: sinceMs(60_000) }, withDialog);
    await screen.findByRole('heading', { name: 'Claude asks · Create file' });
    fireEvent.click(screen.getByRole('tab', { name: 'Screen' }));
    await waitFor(() => expect(getScreen).toHaveBeenLastCalledWith('a', 80));
    expect(within(screen.getByRole('tabpanel', { name: 'Screen' })).getByLabelText('Terminal text').textContent).toBe('Create file');
    expect(screen.getByRole('heading', { name: 'Claude asks · Create file' })).toBeTruthy();
  });

  it('pauses while the page is hidden and reads the moment it shows again', async () => {
    vi.useFakeTimers();
    const { getScreen } = open({ status: 'waiting', statusSince: sinceMs(60_000) });
    await pass(0);
    expect(getScreen).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await pass(9_000);
    expect(getScreen).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await pass(0);
    expect(getScreen).toHaveBeenCalledTimes(2);
  });

  it('keeps one read in flight: asks during it read once more when it lands', async () => {
    vi.useFakeTimers();
    let land: (r: ScreenResponse) => void = () => undefined;
    const getScreen = vi
      .fn()
      .mockImplementationOnce(() => new Promise<ScreenResponse>((r) => (land = r)))
      .mockResolvedValue(plain);
    renderApp({ path: '/s/a', api: fakeApi({ getScreen }), state: stateWith({ sessions: [session('a', { status: 'waiting', statusSince: sinceMs(60_000) })] }) });
    await pass(0);
    await pass(3_000);
    await pass(3_000);
    expect(getScreen).toHaveBeenCalledTimes(1);
    await act(async () => land(plain));
    await pass(0);
    expect(getScreen).toHaveBeenCalledTimes(2);
  });
});

describe('the Desk (spec 5)', () => {
  it('offers Answer for a session waiting in the terminal with no card', () => {
    vi.stubGlobal('matchMedia', (query: string) => {
      const m = /min-width:\s*(\d+)px/.exec(query);
      return { matches: m ? 1440 >= Number(m[1]) : false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined };
    });
    try {
      renderApp({ state: stateWith({ sessions: [session('term', { status: 'waiting', statusSince: iso(40_000) })] }) });
      const desk = screen.getByRole('region', { name: 'Desk' });
      const link = within(desk).getByRole('link', { name: 'Answer' });
      expect(link.getAttribute('href')).toBe('/s/term');
      expect(within(desk).queryByText('See the screen')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
