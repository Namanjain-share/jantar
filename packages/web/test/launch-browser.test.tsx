/**
 * W3: the New session folder browser (spec 5.3.2) against the fake API:
 * loading, the roots, PINNED / RECENT / FOLDERS, the breadcrumb, pinning,
 * a new folder, paging and the filter, and every refusal the daemon can
 * answer with (launching off, the TCC sentence, no roots, no scope, offline).
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api.js';
import { entryLine, showingLine } from '../src/ui/screens/new/FolderBrowser.js';
import { iso, preloadPlaces, renderApp, stateWith } from './helpers.js';
import { ROOTS, entry, launchApi, listing, viewport } from './launch-fixtures.js';

preloadPlaces('new');

const ON = { launch: true } as const;
const state = () => stateWith({ features: ON });
const rows = () => Array.from(document.querySelectorAll<HTMLElement>('li[data-folder]')).map((r) => r.dataset.folder);
const row = (name: string) => document.querySelector<HTMLElement>(`li[data-folder="${name}"]`)!;
const rails = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);

const FEATURE_OFF = 'Starting sessions from the phone is off. Turn it on at your Mac: jantar launch on';
const TCC = "macOS hasn't let Jantar read Desktop. Allow it in System Settings > Privacy & Security > Files and Folders.";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('folder browser: states', () => {
  it('shows skeleton rows while the roots load, with one display line', async () => {
    const api = launchApi({ foldersRoots: vi.fn(() => new Promise<never>(() => undefined)) });
    renderApp({ path: '/new', api, state: state() });
    // The screen is its own chunk: the shell's skeleton shows until it is in.
    expect((await screen.findByText('New session')).hasAttribute('data-display')).toBe(true);
    expect(document.querySelectorAll('[data-display]').length).toBe(1);
    expect(await screen.findByText('Reading folders…')).toBeTruthy();
    expect(rows()).toEqual([]);
  });

  it('says how to add a root on the Mac when there is none', async () => {
    const api = launchApi({ foldersRoots: vi.fn(async () => ({ roots: [] })) });
    renderApp({ path: '/new', api, state: state() });
    expect(await screen.findByText('No folders to start in')).toBeTruthy();
    expect(screen.getByText('jantar folders add-root ~/Desktop')).toBeTruthy();
  });

  it("shows the daemon's sentence when launching is off at the Mac, and tries again", async () => {
    const foldersRoots = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('forbidden', FEATURE_OFF, 403))
      .mockResolvedValue({ roots: ROOTS });
    const api = launchApi({ foldersRoots });
    renderApp({ path: '/new', api, state: state() });
    expect((await screen.findByRole('alert')).textContent).toBe(FEATURE_OFF);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(rails()).toContain('Folders0'));
    expect(foldersRoots).toHaveBeenCalledTimes(2);
  });

  it('says it cannot reach the Mac when the network fails', async () => {
    const api = launchApi({ foldersRoots: vi.fn(async () => Promise.reject(new ApiError('network', 'fetch failed', 0))) });
    renderApp({ path: '/new', api, state: state() });
    expect((await screen.findByText(/Could not reach the Mac/)).getAttribute('role')).toBe('alert');
  });

  it("shows macOS's privacy refusal (TCC) for a folder it may not read", async () => {
    const api = launchApi({ foldersList: vi.fn(async () => Promise.reject(new ApiError('forbidden', TCC, 403))) });
    renderApp({ path: '/new?root=r.2', api, state: state() });
    expect(await screen.findByText(TCC)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('says "No folders here." for an empty folder, and still offers a new one', async () => {
    renderApp({ path: '/new?root=r.1&path=empty', api: launchApi(), state: state() });
    expect(await screen.findByText('No folders here.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New folder' })).toBeTruthy();
  });
});

describe('folder browser: folders', () => {
  const work = listing(
    [
      entry('jantar', { pinned: true, git: true, live: 2, lastUsed: iso(-3 * 3600_000 + 300_000), lastAccount: 7 }),
      entry('api', { git: true, claudeMd: true }),
      entry('notes'),
    ],
    { hiddenProtected: 2 },
  );

  it('opens the first root and lists PINNED, RECENT and FOLDERS with their facts in mono', async () => {
    const api = launchApi(
      {
        foldersRecent: vi.fn(async () => ({
          recent: [{ rootId: 'r.2', path: 'acme-site', display: '~/Desktop/acme-site', lastUsed: iso(-3600_000 + 300_000), lastAccount: 4 }],
        })),
      },
      { 'r.1:': work },
    );
    renderApp({ path: '/new', api, state: state() });
    await waitFor(() => expect(rows()).toEqual(['jantar', 'acme-site', 'api', 'notes']));
    expect(rails()).toEqual(['Pinned1', 'Recent1', 'Folders2']);
    expect(api.foldersList).toHaveBeenCalledWith({ root: 'r.1' });
    expect(within(row('jantar')).getByText('git · 2 live · 3h ago · 07')).toBeTruthy();
    expect(within(row('api')).getByText('git · CLAUDE.md')).toBeTruthy();
    expect(within(row('acme-site')).getByText('~/Desktop · 1h ago · 04')).toBeTruthy();
    expect(screen.getByText('2 protected folders hidden')).toBeTruthy();
    // The root picker: configured roots, then live session folders.
    const roots = screen.getByRole('group', { name: 'Where to look' });
    expect(within(roots).getAllByRole('button').map((b) => b.textContent)).toEqual(['work', 'Desktop', 'Sessions']);
    expect(within(roots).getByRole('button', { name: 'work' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('opens a folder on tap and walks back up through the breadcrumb', async () => {
    const api = launchApi({}, { 'r.1:': work, 'r.1:api': listing([entry('v2')], { path: 'api' }), 'r.1:api/v2': listing([], { path: 'api/v2' }) });
    const { history } = renderApp({ path: '/new', api, state: state() });
    await waitFor(() => expect(rows()).toContain('api'));
    fireEvent.click(within(row('api')).getByRole('link'));
    expect(history.entries.at(-1)).toBe('/new?root=r.1&path=api');
    await waitFor(() => expect(rows()).toEqual(['v2']));
    fireEvent.click(within(row('v2')).getByRole('link'));
    await waitFor(() => expect(api.foldersList).toHaveBeenLastCalledWith({ root: 'r.1', path: 'api/v2' }));
    const crumbs = screen.getByRole('navigation', { name: 'Folder path' });
    expect(crumbs.textContent).toBe('~/Desktop/work/api/v2');
    expect(within(crumbs).getByText('v2').getAttribute('aria-current')).toBe('page');
    fireEvent.click(within(crumbs).getByRole('button', { name: 'api' }));
    expect(history.entries.at(-1)).toBe('/new?root=r.1&path=api');
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Folder path' })).getByRole('button', { name: '~/Desktop/work' }));
    expect(history.entries.at(-1)).toBe('/new?root=r.1');
  });

  it('opens the start form from Start beside a folder', async () => {
    const { history } = renderApp({ path: '/new', api: launchApi({}, { 'r.1:': work }), state: state() });
    await waitFor(() => expect(rows()).toContain('api'));
    fireEvent.click(screen.getByRole('button', { name: 'Start a session in api' }));
    expect(history.entries.at(-1)).toBe('/new?root=r.1&path=api&start=1');
  });

  it('opens the start form for the folder it stands in from Start here', async () => {
    const { history } = renderApp({ path: '/new?root=r.1&path=api', api: launchApi(), state: state() });
    fireEvent.click(await screen.findByRole('button', { name: 'Start here' }));
    expect(history.entries.at(-1)).toBe('/new?root=r.1&path=api&start=1');
  });

  it('switches roots, and lists each live session folder once under Sessions', async () => {
    const { history } = renderApp({ path: '/new', api: launchApi({}, { 'r.1:': work }), state: state() });
    const roots = await screen.findByRole('group', { name: 'Where to look' });
    fireEvent.click(within(roots).getByRole('button', { name: 'Sessions' }));
    expect(history.entries.at(-1)).toBe('/new?root=sessions');
    await waitFor(() => expect(rows()).toEqual(['web-app']));
    expect(within(row('web-app')).getByText('~/Desktop/work/web-app')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start a session in web-app' }));
    expect(history.entries.at(-1)).toBe('/new?root=s.alpha&start=1');
  });

  it('pins on a long press, moving the row at once, and never opens the folder', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = launchApi({ foldersPin: vi.fn(async () => undefined) }, { 'r.1:': work });
    const { history } = renderApp({ path: '/new', api, state: state() });
    await waitFor(() => expect(rows()).toEqual(['jantar', 'api', 'notes']));
    const link = within(row('notes')).getByRole('link');
    fireEvent.pointerDown(link, { button: 0, clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(499));
    expect(api.foldersPin).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(api.foldersPin).toHaveBeenCalledWith({ root: 'r.1', path: 'notes', pinned: true });
    expect(rows()).toEqual(['jantar', 'notes', 'api']);
    // The click that ends the press opens nothing, whichever row it lands on now.
    fireEvent.pointerUp(within(row('api')).getByRole('link'));
    fireEvent.click(within(row('api')).getByRole('link'));
    fireEvent.click(within(row('notes')).getByRole('link'));
    fireEvent.click(within(row('api')).getByRole('button', { name: 'Start a session in api' }));
    expect(history.entries.at(-1)).toBe('/new');
    expect(await screen.findByText('Pinned notes')).toBeTruthy();
    // A second later, rows open again.
    act(() => vi.advanceTimersByTime(1000));
    fireEvent.click(within(row('api')).getByRole('link'));
    expect(history.entries.at(-1)).toBe('/new?root=r.1&path=api');
  });

  it('cancels a long press when the finger moves (a scroll), and pins with P from the keyboard', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = launchApi({ foldersPin: vi.fn(async () => undefined) }, { 'r.1:': work });
    renderApp({ path: '/new', api, state: state() });
    await waitFor(() => expect(rows()).toContain('notes'));
    const link = within(row('notes')).getByRole('link');
    fireEvent.pointerDown(link, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(link, { clientX: 10, clientY: 40 });
    act(() => vi.advanceTimersByTime(800));
    expect(api.foldersPin).not.toHaveBeenCalled();
    fireEvent.keyDown(within(row('jantar')).getByRole('link'), { key: 'p' });
    expect(api.foldersPin).toHaveBeenCalledWith({ root: 'r.1', path: 'jantar', pinned: false });
  });

  it('puts a pin back when the daemon refuses it', async () => {
    const api = launchApi({ foldersPin: vi.fn(async () => Promise.reject(new ApiError('rate_limited', 'slow down', 429))) }, { 'r.1:': work });
    renderApp({ path: '/new', api, state: state() });
    await waitFor(() => expect(rows()).toContain('notes'));
    fireEvent.keyDown(within(row('notes')).getByRole('link'), { key: 'p' });
    expect(await screen.findByText('Too many tries. Wait a minute and try again.')).toBeTruthy();
    expect(rows()).toEqual(['jantar', 'api', 'notes']);
  });

  it('pages with Show more folders, and filters a long listing as you type', async () => {
    const first = listing(
      Array.from({ length: 14 }, (_, i) => entry(`proj-${String(i).padStart(2, '0')}`)),
      { next: 'cursor-1', truncated: true },
    );
    const foldersList = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(listing([entry('zeta')], { next: null }));
    renderApp({ path: '/new?root=r.1', api: launchApi({ foldersList }), state: state() });
    await waitFor(() => expect(rows().length).toBe(14));
    expect(screen.getByText('Showing 14. Type to filter.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show more folders' }));
    await waitFor(() => expect(rows().length).toBe(15));
    expect(foldersList).toHaveBeenLastCalledWith({ root: 'r.1', after: 'cursor-1' });
    expect(screen.queryByRole('button', { name: 'Show more folders' })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter folders' }), { target: { value: 'ZET' } });
    expect(rows()).toEqual(['zeta']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter folders' }), { target: { value: 'nothing-like-it' } });
    expect(screen.getByText('No folder here matches nothing-like-it.')).toBeTruthy();
  });

  it('says how many folders are still out, "Showing 14 of 15", until every page is in', async () => {
    const first = listing(
      Array.from({ length: 14 }, (_, i) => entry(`proj-${String(i).padStart(2, '0')}`)),
      { next: 'cursor-1', total: 15 },
    );
    const foldersList = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(listing([entry('zeta')], { next: null, total: 15 }));
    renderApp({ path: '/new?root=r.1', api: launchApi({ foldersList }), state: state() });
    await waitFor(() => expect(rows().length).toBe(14));
    expect(screen.getByText('Showing 14 of 15. Type to filter.').className).toContain('type-mono');
    fireEvent.click(screen.getByRole('button', { name: 'Show more folders' }));
    await waitFor(() => expect(rows().length).toBe(15));
    expect(screen.queryByText(/^Showing /)).toBeNull();
  });

  it('a folder too big to read whole gives its count as a floor; a whole one says nothing', () => {
    const e = (n: number) => Array.from({ length: n }, (_, i) => entry(`d${i}`));
    expect(showingLine({ entries: e(500), total: 812, truncated: false })).toBe('Showing 500 of 812. Type to filter.');
    expect(showingLine({ entries: e(500), total: 10_000, truncated: true })).toBe('Showing 500 of 10,000+. Type to filter.');
    expect(showingLine({ entries: e(12), total: 12, truncated: false })).toBeNull();
    // A daemon without the total: the count shown only, and only when it was cut short.
    expect(showingLine({ entries: e(14), truncated: true })).toBe('Showing 14. Type to filter.');
    expect(showingLine({ entries: e(14), truncated: false })).toBeNull();
  });

  it("a folder's line names its last account, but not with one Claude login", () => {
    const e = entry('api', { git: true, lastAccount: 7 });
    expect(entryLine(e, Date.now())).toBe('git · 07');
    expect(entryLine({ ...e, lastAccount: 0 }, Date.now(), true)).toBe('git');
  });

  it('renders folder names as text, never as markup', async () => {
    renderApp({ path: '/new?root=r.1', api: launchApi({}, { 'r.1:': listing([entry('<b>x</b>')]) }), state: state() });
    await waitFor(() => expect(rows()).toEqual(['<b>x</b>']));
    expect(row('<b>x</b>').querySelector('b')).toBeNull();
  });
});

describe('folder browser: new folder', () => {
  const open = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'New folder' }));
    return screen.getByRole('textbox', { name: 'New folder' });
  };

  it('checks the name as you type and opens the start form for the new folder', async () => {
    const foldersCreate = vi.fn(async () => ({ root: 'r.1', path: 'api/next-thing' }));
    const api = launchApi({ foldersCreate });
    const { history } = renderApp({ path: '/new?root=r.1&path=api', api, state: state() });
    const input = await open();
    const create = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    for (const bad of ['.hidden', 'trailing.', 'trailing ', 'a/b']) {
      fireEvent.change(input, { target: { value: bad } });
      expect(create.disabled).toBe(true);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(screen.getByText(/can't end in a space or a dot/)).toBeTruthy();
    }
    fireEvent.change(input, { target: { value: 'next-thing' } });
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(foldersCreate).toHaveBeenCalledWith({ root: 'r.1', parent: 'api', name: 'next-thing' }));
    await waitFor(() => expect(history.entries.at(-1)).toBe('/new?root=r.1&path=api%2Fnext-thing&start=1'));
  });

  it('says the folder exists on a 409', async () => {
    const api = launchApi({ foldersCreate: vi.fn(async () => Promise.reject(new ApiError('conflict', 'exists', 409))) });
    renderApp({ path: '/new?root=r.1', api, state: state() });
    fireEvent.change(await open(), { target: { value: 'api' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('There is already a folder called api here.')).toBeTruthy();
  });

  it('teaches the Mac command on a missing launch scope, with no grant button', async () => {
    localStorage.setItem('jantar:device', JSON.stringify({ id: 'dev-1', name: "Sam's iPhone", scopes: ['read', 'control'] }));
    const api = launchApi({ foldersCreate: vi.fn(async () => Promise.reject(new ApiError('forbidden', 'this device does not have the launch scope', 403))) });
    renderApp({ path: '/new?root=r.1', api, state: state() });
    fireEvent.change(await open(), { target: { value: 'scratch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(document.querySelector('[data-no-scope]')).not.toBeNull());
    expect(document.querySelector('[data-no-scope]')!.textContent).toBe("This browser can't start sessions. On your Mac run jantar devices grant 'Sam'\\''s iPhone' launch.");
    expect(screen.queryByRole('button', { name: /grant/i })).toBeNull();
  });

  it('keeps Create off while offline, with the reason', async () => {
    const api = launchApi();
    renderApp({ path: '/new?root=r.1', api, state: state(), status: 'offline' });
    fireEvent.change(await open(), { target: { value: 'scratch' } });
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Offline: can't make folders right now")).toBeTruthy();
    expect(api.foldersCreate).not.toHaveBeenCalled();
  });
});

describe('folder browser: desktop', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the browser in a column and puts a hint in the detail pane', async () => {
    viewport(1440);
    renderApp({ path: '/new', api: launchApi({}, { 'r.1:': listing([entry('api')]) }), state: state() });
    await waitFor(() => expect(rows()).toEqual(['api']));
    expect(within(screen.getByRole('region', { name: 'Detail' })).getByText('Pick a folder')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Board' })).toBeNull();
  });
});
