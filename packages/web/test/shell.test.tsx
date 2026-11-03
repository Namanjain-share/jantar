import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLayoutStore, layoutAt } from '../src/ui/shell/layout.js';
import { NAV } from '../src/ui/shell/nav.js';
import { navStore } from '../src/ui/shell/navState.js';
import { account, alert, fakeApi, pending, preloadPlaces, renderApp, session, stateWith } from './helpers.js';

/** Pretend the window is `width` px wide, with a fine pointer unless `coarse` (jsdom has no matchMedia). */
function viewport(width: number, { coarse = false } = {}) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const max = /max-width:\s*(\d+)px/.exec(query);
    const pointer = /\(pointer:\s*(coarse|fine)\)/.exec(query);
    const known = min || max || pointer;
    return {
      matches:
        Boolean(known) &&
        (!min || width >= Number(min[1])) &&
        (!max || width <= Number(max[1])) &&
        (!pointer || (pointer[1] === 'coarse') === coarse),
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

describe('0.11: the chrome by width and pointer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('c24: a touch screen gets the touch shell from 640 (no top bar, no status bar), and the phone below', async () => {
    viewport(1180, { coarse: true });
    const a = renderApp({ state: busy() });
    expect(document.querySelector('[data-chrome]')?.getAttribute('data-chrome')).toBe('touch');
    expect(await screen.findByRole('button', { name: 'Hide sidebar' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Ledger' })).toBeTruthy();
    expect(screen.queryByRole('contentinfo')).toBeNull();
    expect(screen.queryByRole('button', { name: /Tap for the legend/ })).toBeNull();
    a.unmount();
    viewport(600, { coarse: true });
    renderApp({ state: busy() });
    expect(document.querySelector('[data-chrome]')?.getAttribute('data-chrome')).toBe('phone');
    expect(screen.getByRole('button', { name: /Tap for the legend/ })).toBeTruthy();
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

describe('v0.7: Posts in the shell', () => {
  preloadPlaces('posts');
  const ID = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
  const week = { from: '2026-01-12', to: '2026-01-18', posted: 0, goals: [] };

  it('renders Posts at /posts while Life is on (a push lands on /posts?id=), under the Today tab', async () => {
    const postsList = vi.fn(async () => ({ today: '2026-01-15', week, posts: [] }));
    renderApp({ path: `/posts?id=${ID}`, state: stateWith({ sessions: [session('a')], features: { life: true } }), api: fakeApi({ postsList }) });
    expect(await screen.findByRole('heading', { level: 1, name: 'Posts' })).toBeTruthy();
    expect(await screen.findByText('Nothing to post yet. Add a post and Jantar reminds you at its time.')).toBeTruthy();
    expect(postsList).toHaveBeenCalledWith('open');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: /Today/ }).getAttribute('aria-current')).toBe('page');
  });

  it('says it is off at the Mac while Life is off', async () => {
    renderApp({ path: '/posts', state: stateWith({ sessions: [session('a')], features: { files: true } }) });
    expect(await screen.findByText('That is off on this Mac.')).toBeTruthy();
    expect(screen.getByText('jantar life on <module>')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: 'Posts' })).toBeNull();
  });
});

describe('0.11 c08: one shell tree', () => {
  it('a session at 1440, 820 and 390 renders through the same tree: the composer keeps its node and its draft', () => {
    const layout = createLayoutStore(layoutAt(1440));
    renderApp({ state: busy(), path: '/s/infra', layout });
    const area = screen.getByLabelText('Prompt for Claude') as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: 'half a thought' } });
    expect(screen.getByRole('region', { name: 'Ledger' })).toBeTruthy();
    // 820: the Mac's chrome, the pane too narrow for the ledger beside the session.
    act(() => layout.setState(layoutAt(820), true));
    expect(screen.queryByRole('region', { name: 'Ledger' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to the board' })).toBeTruthy();
    expect(screen.getByLabelText('Prompt for Claude')).toBe(area);
    // 390: the phone's chrome around the same place.
    act(() => layout.setState(layoutAt(390), true));
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(screen.getByLabelText('Prompt for Claude')).toBe(area);
    act(() => layout.setState(layoutAt(1440), true));
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(screen.getByLabelText('Prompt for Claude')).toBe(area);
    expect(area.value).toBe('half a thought');
  });

  it("a place opens at its own scroll, not the last place's, and gets its own back", () => {
    const tops = new WeakMap<Element, number>();
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: HTMLElement) {
        return tops.get(this) ?? 0;
      },
      set(this: HTMLElement, v: number) {
        tops.set(this, v);
      },
    });
    try {
      const { router } = renderApp({ state: busy(), path: '/devices', layout: layoutAt(1440) });
      const devices = document.querySelector('[data-pane="devices"]') as HTMLElement;
      expect(devices).toBeTruthy();
      devices.scrollTop = 900;
      fireEvent.scroll(devices);
      act(() => router.getState().navigate('/alerts'));
      const alerts = document.querySelector('[data-pane="alerts"]') as HTMLElement;
      expect(alerts).not.toBe(devices);
      expect(alerts.scrollTop).toBe(0);
      act(() => router.getState().navigate('/devices'));
      expect((document.querySelector('[data-pane="devices"]') as HTMLElement).scrollTop).toBe(900);
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollTop');
    }
  });

  it('main never scrolls; the phone and the Mac put the same place in the same slot', () => {
    const layout = createLayoutStore(layoutAt(1440));
    renderApp({ state: busy(), layout });
    const main = screen.getByRole('main');
    expect(main.className).not.toMatch(/overflow/);
    expect(document.querySelector('[data-chrome]')?.getAttribute('data-chrome')).toBe('desk');
    act(() => layout.setState(layoutAt(390), true));
    expect(screen.getByRole('main')).toBe(main);
    expect(document.querySelector('[data-chrome]')?.getAttribute('data-chrome')).toBe('phone');
  });
});

describe('0.11: More is the phone tab', () => {
  it('a wider chrome sends /more to the board; the phone keeps it', async () => {
    const wide = renderApp({ state: busy(), path: '/more', layout: layoutAt(1440) });
    await waitFor(() => expect(wide.router.getState().route).toEqual({ name: 'board' }));
    wide.unmount();
    const phone = renderApp({ state: busy(), path: '/more', layout: layoutAt(390, { coarse: true }) });
    expect(await screen.findByRole('heading', { level: 1, name: 'More' })).toBeTruthy();
    expect(phone.router.getState().route).toEqual({ name: 'more' });
  });
});

describe('0.11 c10: the shell follows the visual viewport', () => {
  it('is the shell box on every chrome, and popups go into its layer, not <body>', async () => {
    const layout = createLayoutStore(layoutAt(1440));
    renderApp({ state: busy(), layout });
    const shell = document.querySelector('[data-chrome]');
    expect(shell?.classList.contains('shell')).toBe(true);
    const layer = shell?.querySelector(':scope > .shell-layer');
    expect(layer).toBeTruthy();
    // The palette's dialog portals into the layer.
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = await screen.findByPlaceholderText('Jump to a session or account');
    expect(layer?.contains(input)).toBe(true);
    // A chrome change keeps the same shell box and layer.
    act(() => layout.setState(layoutAt(390), true));
    expect(document.querySelector('[data-chrome]')).toBe(shell);
    expect(shell?.classList.contains('shell')).toBe(true);
  });
});

describe('0.11 c24: the touch shell', () => {
  const touchAt = (width: number) => layoutAt(width, { coarse: true });
  const allOn = () => stateWith({ sessions: [session('web-app', { status: 'waiting' })], pending: [pending('web-app')], features: { files: true, life: true, intel: true, meetings: true, ask: true } });
  const navNames = (nav: HTMLElement) =>
    within(nav)
      .getAllByRole('link')
      .map((a) => a.getAttribute('aria-label') ?? a.querySelector('span')?.textContent?.trim() ?? '');
  beforeEach(() => {
    localStorage.clear();
    navStore.setState({ folded: false, lifeOpen: true, overlay: false });
  });

  it('640 and 820: the labelled rail; 1180 and 1440: the sidebar', async () => {
    for (const [width, kind] of [
      [640, 'rail'],
      [820, 'rail'],
      [1180, 'sidebar'],
      [1440, 'sidebar'],
    ] as const) {
      const r = renderApp({ state: allOn(), layout: touchAt(width) });
      if (kind === 'sidebar') {
        expect(await screen.findByRole('button', { name: 'Hide sidebar' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Search or jump' })).toBeTruthy();
      } else {
        expect(await screen.findByRole('button', { name: 'Show sidebar' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Jump to a session' })).toBeTruthy();
      }
      expect(document.querySelector('header')).toBeNull();
      expect(screen.queryByRole('contentinfo')).toBeNull();
      r.unmount();
    }
  });

  it('one nav order: the sidebar, the rail and the tabs all follow NAV (Accounts and Devices leave the touch list)', async () => {
    const order = NAV.filter((n) => n.touch !== false).map((n) => n.label);
    const side = renderApp({ state: allOn(), layout: touchAt(1180) });
    await screen.findByRole('button', { name: 'Hide sidebar' });
    const names = navNames(screen.getByRole('navigation', { name: 'Main' }));
    expect(names.filter((n) => order.includes(n))).toEqual(order);
    expect(names).not.toContain('Accounts');
    expect(names).not.toContain('Devices');
    // Today's places under Today, in Today's order.
    expect(within(screen.getByRole('list', { name: "Today's places" })).getAllByRole('link').map((a) => a.textContent?.trim())).toEqual(['Todos', 'Medicines', 'Food', 'Cafés', 'Finance', 'Posts']);
    side.unmount();
    const rail = renderApp({ state: allOn(), layout: touchAt(820) });
    await screen.findByRole('button', { name: 'Show sidebar' });
    expect(navNames(screen.getByRole('navigation', { name: 'Main' })).filter((n) => order.includes(n))).toEqual(order);
    rail.unmount();
    renderApp({ state: allOn(), layout: touchAt(390) });
    expect(navNames(screen.getByRole('navigation', { name: 'Main' })).slice(0, 4)).toEqual(order.slice(0, 4));
  });

  it('⌘\\ and the button fold the sidebar to the rail, remembered on this device; the rail’s button unfolds it', async () => {
    const r = renderApp({ state: allOn(), layout: layoutAt(1180, { coarse: true, keyboard: true }) });
    await screen.findByRole('button', { name: 'Hide sidebar' });
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash', metaKey: true });
    expect(await screen.findByRole('button', { name: 'Show sidebar' })).toBeTruthy();
    expect(localStorage.getItem('jantar:sidebar-folded')).toBe('true');
    r.unmount();
    navStore.setState({ folded: true });
    renderApp({ state: allOn(), layout: touchAt(1180) });
    fireEvent.click(await screen.findByRole('button', { name: 'Show sidebar' }));
    expect(await screen.findByRole('button', { name: 'Hide sidebar' })).toBeTruthy();
    expect(localStorage.getItem('jantar:sidebar-folded')).toBe('false');
  });

  it('at 820 the rail’s button shows the sidebar over the panes; a place, Esc or ⌘\\ closes it', async () => {
    const { history } = renderApp({ state: allOn(), layout: layoutAt(820, { coarse: true, keyboard: true }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Show sidebar' }));
    const over = await screen.findByRole('navigation', { name: 'Sidebar' });
    fireEvent.click(within(over).getByRole('link', { name: 'Alerts' }));
    expect(history.entries.at(-1)).toBe('/alerts');
    expect(screen.queryByRole('navigation', { name: 'Sidebar' })).toBeNull();
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash', metaKey: true });
    expect(await screen.findByRole('navigation', { name: 'Sidebar' })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('navigation', { name: 'Sidebar' })).toBeNull();
  });

  it('the accounts strip opens Accounts; ⋯ holds Devices', async () => {
    const { history } = renderApp({ state: allOn(), layout: touchAt(1180) });
    fireEvent.click(await screen.findByRole('link', { name: /5-hour usage per account/ }));
    expect(history.entries.at(-1)).toBe('/accounts');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Devices' }));
    expect(history.entries.at(-1)).toBe('/devices');
  });
});
