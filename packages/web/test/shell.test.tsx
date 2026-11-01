import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { account, alert, fakeApi, pending, preloadPlaces, renderApp, session, stateWith } from './helpers.js';

/** Pretend the window is `width` px wide (jsdom has no matchMedia). */
function viewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const m = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: m ? width >= Number(m[1]) : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  });
}

const busy = () =>
  stateWith({
    sessions: [
      session('web-app', { status: 'waiting' }),
      session('infra', { status: 'idle' }),
      session('api'),
    ],
    pending: [pending('web-app', { kind: 'question', tool: 'AskUserQuestion' })],
    accounts: [account(1), account(3, { windows: [{ kind: 'five_hour', pct: 97 }] })],
    alerts: [alert('a1')],
  });

describe('desktop shell', () => {
  beforeEach(() => viewport(1440));
  afterEach(() => vi.unstubAllGlobals());

  it('frames the board with the top bar, rail, ledger, desk and status bar', () => {
    renderApp({ state: busy() });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getAllByRole('link').map((l) => l.getAttribute('aria-label'))).toEqual(['Board', 'Accounts', 'Alerts', 'Devices']);
    expect(within(nav).getByRole('link', { name: 'Board' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: 'Board' }).textContent).toContain('1');
    // The strip: one cell per session, needs-you first.
    const strip = screen.getByRole('listbox', { name: /All sessions/ });
    expect(within(strip).getAllByRole('option').map((o) => o.getAttribute('aria-label')?.split(' · ')[0])).toEqual(['web-app', 'infra', 'api']);
    expect(screen.getByRole('region', { name: 'Ledger' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Desk' })).toBeTruthy();
    // Status bar: link state and every account's 5h %, the one at the ceiling in ember.
    const pairs = screen.getByRole('button', { name: /5-hour usage per account/ });
    expect(pairs.textContent).toBe('5h01420397');
    expect(pairs.querySelector('.text-signal-text')?.textContent).toBe('97');
    expect(screen.getByRole('status', { name: 'Connection' }).textContent).toBe('live');
  });

  it("marks 5h values with the daemon's own ceiling (/v1/plan), and hints 1-N on the board", async () => {
    const getPlan = vi.fn(async () => ({ source: 'ccw-legacy' as const, next: null, accounts: [], updatedAt: null, ceiling: 40 }));
    renderApp({ state: busy(), api: fakeApi({ getPlan }) });
    const pairs = screen.getByRole('button', { name: /5-hour usage per account/ });
    // 42 (acct 01) is past a 40% ceiling once the plan answers; one request serves the whole shell.
    await waitFor(() => expect([...pairs.querySelectorAll('.text-signal-text')].map((b) => b.textContent)).toEqual(['42', '97']));
    expect(getPlan).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('contentinfo').textContent).toContain('1waiting');
  });

  it('opens a session beside the ledger and jumps with the strip and keys', () => {
    const { history } = renderApp({ state: busy() });
    fireEvent.click(screen.getAllByRole('option')[1]!);
    expect(history.entries.at(-1)).toBe('/s/infra');
    expect(screen.getByRole('region', { name: 'Ledger' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Detail' })).getByRole('heading', { level: 1, name: 'infra' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'j' });
    expect(history.entries.at(-1)).toBe('/s/api');
    fireEvent.keyDown(window, { key: 'k' });
    expect(history.entries.at(-1)).toBe('/s/infra');
    fireEvent.keyDown(window, { key: '1' });
    expect(history.entries.at(-1)).toBe('/s/web-app');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(history.entries.at(-1)).toBe('/');
    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.keyDown(window, { key: 'a' });
    expect(history.entries.at(-1)).toBe('/accounts');
  });

  it('opens the palette with Cmd-K and the legend with ?', async () => {
    const { history } = renderApp({ state: busy() });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = await screen.findByPlaceholderText('Jump to a session or account');
    fireEvent.change(input, { target: { value: 'infra' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(history.entries.at(-1)).toBe('/s/infra');
    await act(async () => {
      fireEvent.keyDown(document.body, { key: '?' });
    });
    expect(await screen.findByText('What the squares mean')).toBeTruthy();
  });

  it('counts sessions and accounts in the top bar only once it has heard from the Mac', () => {
    const { unmount } = renderApp({ status: 'connecting' });
    expect(screen.queryByText(/sessions? · \d+ accounts?/)).toBeNull();
    unmount();
    renderApp({ state: busy() });
    expect(screen.getByText('3 sessions · 2 accounts')).toBeTruthy();
  });

  it('v0.5.3: has no header magnifier (the rail lists Intel)', () => {
    renderApp({ state: stateWith({ sessions: [session('web-app')], features: { intel: true } }) });
    expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Intel' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Search the Intel shelf' })).toBeNull();
  });

  it('shows the offline line and a dashed strip', () => {
    renderApp({ state: busy(), status: 'offline' });
    expect(screen.getByRole('alert').textContent).toMatch(/Can't reach the Mac/);
    expect(screen.getByRole('listbox', { name: /All sessions/ }).getAttribute('data-dashed')).toBe('true');
    expect(screen.getByText(/^offline · showing/)).toBeTruthy();
  });
});

describe('tablet shell', () => {
  beforeEach(() => viewport(900));
  afterEach(() => vi.unstubAllGlobals());

  it('opens a session full width, without the ledger beside it', () => {
    renderApp({ state: busy(), path: '/s/infra' });
    expect(screen.queryByRole('region', { name: 'Ledger' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'infra' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
  });
});

describe('phone shell', () => {
  preloadPlaces('intel');

  it('has a header strip that opens the legend, and tabs', async () => {
    renderApp({ state: busy() });
    expect(screen.queryByRole('listbox')).toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent?.replace(/\d+/g, ''))).toEqual(['Board', 'Accounts', 'Alerts', 'Devices']);
    fireEvent.click(screen.getByRole('button', { name: /Tap for the legend/ }));
    expect(await screen.findByRole('dialog', { name: 'What the squares mean' })).toBeTruthy();
  });

  it('has no strip to tap while there are no sessions', () => {
    renderApp({ state: stateWith({ accounts: [account(1)] }) });
    expect(screen.getByText('No Claude sessions running')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Tap for the legend/ })).toBeNull();
  });

  it('v0.5.3: a magnifier in the header while the shelf is on opens it with the search box focused', async () => {
    const intelList = vi.fn(async () => ({ items: [], next: null, total: 0, types: [], tags: [] }));
    const api = fakeApi({ intelList, intelSources: vi.fn(async () => ({ sources: [] })) });
    const { router } = renderApp({ state: stateWith({ sessions: [session('web-app')], features: { intel: true } }), api });
    const header = screen.getByRole('banner');
    const glass = within(header).getByRole('link', { name: 'Search the Intel shelf' });
    expect(glass.getAttribute('href')).toBe('/intel?focus=search');
    // After the strip, a 44 px target.
    expect(glass.previousElementSibling?.getAttribute('aria-label')).toMatch(/Tap for the legend/);
    expect(glass.className).toContain('size-44');
    fireEvent.click(glass);
    const box = await screen.findByLabelText('Search the shelf');
    await waitFor(() => expect(document.activeElement).toBe(box));
    // The word leaves the address once used.
    await waitFor(() => expect(router.getState().route).toEqual({ name: 'intel' }));
    expect(intelList).toHaveBeenCalled();
  });

  it('v0.5.3: on a filtered shelf the magnifier starts a new search (empty box, no type or tag); Back returns to the filtered view', async () => {
    const intelList = vi.fn(async () => ({ items: [], next: null, total: 0, types: [], tags: [] }));
    const api = fakeApi({ intelList, intelSources: vi.fn(async () => ({ sources: [] })) });
    const { router } = renderApp({ state: stateWith({ sessions: [session('web-app')], features: { intel: true } }), api, path: '/intel?q=hooks&type=tool&tag=cli' });
    const box = (await screen.findByLabelText('Search the shelf')) as HTMLInputElement;
    expect(box.value).toBe('hooks');
    fireEvent.click(screen.getByRole('link', { name: 'Search the Intel shelf' }));
    await waitFor(() => expect(router.getState().route).toEqual({ name: 'intel' }));
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(box.value).toBe('');
    // The magnifier pushed one entry (its focus word then left it in place): Back is the search the user had.
    act(() => router.getState().back());
    await waitFor(() => expect(router.getState().route).toEqual({ name: 'intel', q: 'hooks', type: 'tool', tag: 'cli' }));
    await waitFor(() => expect(box.value).toBe('hooks'));
  });

  it('v0.5.3: no magnifier while the shelf is off, nor on an open session', () => {
    const a = renderApp({ state: stateWith({ sessions: [session('web-app')], features: { intel: false } }) });
    expect(screen.queryByRole('link', { name: 'Search the Intel shelf' })).toBeNull();
    a.unmount();
    renderApp({ state: stateWith({ sessions: [session('web-app')], features: { intel: true } }), path: '/s/web-app' });
    expect(screen.queryByRole('link', { name: 'Search the Intel shelf' })).toBeNull();
  });

  it('gives an open session the whole screen', () => {
    renderApp({ state: busy(), path: '/s/infra' });
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to the board' })).toBeTruthy();
  });
});
