/**
 * v0.6 Fleet in New session (spec 0.5 and 6): a Where row above the folder
 * browser picks the machine, the Mac or a paired one that is online, not
 * watch-only and has starting on there. Once a machine is picked every
 * folder, start-sheet and start call carries its `node` (as `?node=`), the
 * title and the hold name it ("Start in api on build-2"), and the receipt
 * says where the launch runs. "New session here" on a server's row stays on
 * that server, and so does "Try again" on its failed launch. Each machine
 * keeps its own switches: with the Mac's own starting off, New session
 * offers only the machines that can start and picks the first. While no
 * machine can start sessions the screen is v0.5's and sends no `node` at
 * all.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROUTES, type LaunchStartBody, type RouteDef, type State } from '@jantar/protocol';
import { createApi, type Api } from '../src/lib/api.js';
import type { CredentialStore } from '../src/lib/credential.js';
import { createRouter, memoryHistory } from '../src/lib/router.js';
import { createAppStore } from '../src/store.js';
import { AppProvider, createToastStore } from '../src/ui/context.js';
import { onMachine } from '../src/ui/screens/new/data.js';
import { canStartAnywhere, canStartOn, startMachines } from '../src/ui/screens/new/machines.js';
import { NewSession } from '../src/ui/screens/new/NewSession.js';
import { emit, iso, NOW, preloadPlaces, renderApp, session, stateWith } from './helpers.js';
import { fleetNodes, fleetState, IDS, SID } from './fleet-helpers.js';
import { entry, job, launchApi, listing, viewport } from './launch-fixtures.js';

preloadPlaces('new');

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ON = { launch: true } as const;
const NODE = { node: IDS.build2 };
const work = listing([entry('api'), entry('notes')]);
// On a phone an open start form or receipt is a modal sheet: the browser behind it, the Where row
// included, is hidden from the accessibility tree meanwhile, so these look behind it too.
const where = () => screen.findByRole('group', { name: 'Where', hidden: true }, { timeout: 10_000 });
const choices = async () => within(await where()).getAllByRole('button', { hidden: true }).map((b) => b.textContent);
const pressed = async () => within(await where()).getByRole('button', { pressed: true, hidden: true }).textContent;
const pick = async (name: string) => fireEvent.click(within(await where()).getByRole('button', { name, hidden: true }));
const rows = () => Array.from(document.querySelectorAll<HTMLElement>('li[data-folder]')).map((r) => r.dataset.folder);
const row = (name: string) => document.querySelector<HTMLElement>(`li[data-folder="${name}"]`)!;
const sheet = () => screen.getByRole('dialog');
const hold = () => within(sheet()).getByRole('button', { name: /^Hold to start on build-2\. Hold for/ }) as HTMLButtonElement;

describe('the Where row', () => {
  it('offers the Mac and each machine that can start a session now, by name; the Mac first', async () => {
    renderApp({ path: '/new', api: launchApi(), state: fleetState({ features: ON }) });
    // build-1 and win-1 have starting off, build-3 is offline, ro-1 is watch-only.
    expect(await choices()).toEqual(['Mac', 'build-2', 'mini-1']);
    expect(await pressed()).toBe('Mac');
  });

  it('sends node on every folder, start-sheet and start call once a machine is picked, and names it', async () => {
    const launchStart = vi.fn(async (_body: LaunchStartBody, _key: string, _opts?: { node?: string }) => ({ job: job('L1', { node: IDS.build2 }) }));
    const foldersPin = vi.fn(async () => undefined);
    const api = launchApi({ launchStart, foldersPin, launchHistory: vi.fn(async () => ({ sessions: [] })) }, { 'r.1:': work });
    const { history } = renderApp({ path: '/new', api, state: fleetState({ features: ON }) });
    await waitFor(() => expect(rows()).toEqual(['api', 'notes']));
    // The Mac's own calls carry nothing new.
    expect(api.foldersRoots).toHaveBeenLastCalledWith();
    expect(api.foldersList).toHaveBeenLastCalledWith({ root: 'r.1' });

    await pick('build-2');
    expect(await pressed()).toBe('build-2');
    expect(history.entries.at(-1)).toBe('/new');
    await waitFor(() => expect(api.foldersRoots).toHaveBeenLastCalledWith(NODE));
    expect(api.foldersRecent).toHaveBeenLastCalledWith(NODE);
    await waitFor(() => expect(api.foldersList).toHaveBeenLastCalledWith({ root: 'r.1', node: IDS.build2 }));
    await waitFor(() => expect(rows()).toEqual(['api', 'notes']));

    // Pinning (p on a row) goes to the machine too.
    fireEvent.keyDown(within(row('notes')).getByRole('link'), { key: 'p' });
    await waitFor(() => expect(foldersPin).toHaveBeenCalledWith({ root: 'r.1', path: 'notes', pinned: true }, NODE));

    fireEvent.click(within(row('api')).getByRole('button', { name: 'Start a session in api' }));
    expect(history.entries.at(-1)).toBe('/new?root=r.1&path=api&start=1');
    await waitFor(() => expect(hold().disabled).toBe(false));
    expect(within(sheet()).getByRole('heading', { name: 'Start in api on build-2' })).toBeTruthy();
    expect(api.launchPreview).toHaveBeenCalledWith(expect.objectContaining({ root: 'r.1', path: 'api', node: IDS.build2 }));
    for (const [q] of (api.launchPreview as ReturnType<typeof vi.fn>).mock.calls) expect(q.node).toBe(IDS.build2);
    expect(api.launchHistory).toHaveBeenCalledWith({ root: 'r.1', path: 'api', node: IDS.build2 });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const b = hold();
    fireEvent.pointerDown(b, { button: 0 });
    act(() => vi.advanceTimersByTime(2000));
    fireEvent.pointerUp(b);
    await waitFor(() => expect(launchStart).toHaveBeenCalledTimes(1));
    const [body, , opts] = launchStart.mock.calls[0]!;
    expect(opts).toEqual(NODE);
    // The body is the Mac's shape: the node rides in the query only.
    expect(Object.keys(body as object).sort()).toEqual(['account', 'flags', 'path', 'root']);
    await waitFor(() => expect(history.entries.at(-1)).toBe('/new?root=r.1&path=api&launch=L1'));
    expect(await screen.findByText('On build-2')).toBeTruthy();

    // Back to the Mac for the tests after this one (the pick lasts while the app runs).
    vi.useRealTimers();
    await pick('Mac');
    expect(await pressed()).toBe('Mac');
  });

  it("keeps a server's launch receipt and \"New session here\" on that server", async () => {
    const s = fleetState({ features: ON });
    s.launches.L9 = job('L9', { node: IDS.mini1, stage: 'starting' });
    const api = launchApi({ launchGet: vi.fn(async () => ({ job: s.launches.L9! })) });
    const { unmount } = renderApp({ path: '/new?root=r.1&path=api&launch=L9', api, state: s });
    expect(await pressed()).toBe('mini-1');
    expect(await screen.findByText('On mini-1')).toBeTruthy();
    await waitFor(() => expect(api.foldersRoots).toHaveBeenCalledWith({ node: IDS.mini1 }));
    unmount();

    // A Board row's menu opens the start form at that session's folder (root s.<sid>), on its machine.
    const api2 = launchApi();
    renderApp({ path: `/new?root=s.${SID.cswap}&start=1&account=1`, api: api2, state: fleetState({ features: ON }) });
    expect(await pressed()).toBe('build-2');
    await waitFor(() => expect(api2.launchPreview).toHaveBeenCalledWith(expect.objectContaining({ root: `s.${SID.cswap}`, node: IDS.build2 })));
  });

  it('keeps "Try again" on the machine whose launch failed', async () => {
    const s = fleetState({ features: ON });
    s.launches.L8 = job('L8', { node: IDS.mini1, stage: 'failed' });
    const api = launchApi();
    renderApp({ path: '/new?root=r.1&path=api&start=1&from=L8', api, state: s });
    expect(await pressed()).toBe('mini-1');
    await waitFor(() => expect(api.launchPreview).toHaveBeenCalledWith(expect.objectContaining({ root: 'r.1', path: 'api', node: IDS.mini1 })));
    for (const [q] of (api.launchPreview as ReturnType<typeof vi.fn>).mock.calls) expect(q.node).toBe(IDS.mini1);
  });

  it('keeps a picked machine through a dropped link: the form and what was typed stay, and the hold waits for it', async () => {
    const api = launchApi({}, { 'r.1:': work });
    const { store, history } = renderApp({ path: '/new', api, state: fleetState({ features: ON }) });
    await pick('build-2');
    await waitFor(() => expect(rows()).toEqual(['api', 'notes']));
    fireEvent.click(within(row('api')).getByRole('button', { name: 'Start a session in api' }));
    await waitFor(() => expect(hold().disabled).toBe(false));
    fireEvent.change(within(sheet()).getByLabelText(/First prompt/), { target: { value: 'fix the flaky test' } });
    const online = (on: boolean) => {
      const node = { ...store.getState().state.nodes![IDS.build2]!, online: on, since: iso(0) };
      act(() => emit(store, [{ seq: store.getState().state.seq + 1, ts: iso(0), type: 'node.updated', data: { node } }]));
    };

    // build-2's link drops for a second: still build-2 (said offline), the form open as it was, the hold off.
    online(false);
    expect(await pressed()).toBe('build-2 (offline)');
    expect(history.entries.at(-1)).toBe('/new?root=r.1&path=api&start=1');
    expect((within(sheet()).getByLabelText(/First prompt/) as HTMLTextAreaElement).value).toBe('fix the flaky test');
    expect(within(sheet()).getByRole('button', { name: /^Hold to start on build-2\. Hold for/ }).hasAttribute('disabled')).toBe(true);
    expect(within(sheet()).getByText('build-2 is offline')).toBeTruthy();

    // Back: the same form, ready again.
    online(true);
    expect(await pressed()).toBe('build-2');
    await waitFor(() => expect(hold().disabled).toBe(false));
    expect((within(sheet()).getByLabelText(/First prompt/) as HTMLTextAreaElement).value).toBe('fix the flaky test');
    expect(within(sheet()).queryByText('build-2 is offline')).toBeNull();

    await pick('Mac');
    expect(await pressed()).toBe('Mac');
  });

  it('sits under the title in the split layout too', async () => {
    viewport(1280);
    renderApp({ path: '/new', api: launchApi(), state: fleetState({ features: ON }) });
    expect(await choices()).toEqual(['Mac', 'build-2', 'mini-1']);
  });
});

describe('with no machine to start on', () => {
  it("is v0.5's screen: no Where row and no node on any call", async () => {
    const noStart = fleetNodes();
    for (const n of Object.values(noStart)) n.features = { ...n.features, launch: false };
    const cases = [
      () => {
        const s = stateWith({ features: ON, sessions: [session('a')] });
        delete s.nodes;
        return s;
      },
      () => stateWith({ features: ON }),
      () => {
        const s = fleetState({ features: ON });
        s.nodes = noStart;
        return s;
      },
    ];
    for (const make of cases) {
      const api = launchApi({}, { 'r.1:': work });
      const { unmount } = renderApp({ path: '/new', api, state: make() });
      await waitFor(() => expect(rows()).toEqual(['api', 'notes']), { timeout: 10_000 });
      expect(screen.queryByRole('group', { name: 'Where' })).toBeNull();
      for (const call of [...(api.foldersRoots as ReturnType<typeof vi.fn>).mock.calls, ...(api.foldersRecent as ReturnType<typeof vi.fn>).mock.calls]) {
        expect(call).toEqual([]);
      }
      for (const [q] of (api.foldersList as ReturnType<typeof vi.fn>).mock.calls) expect(q).not.toHaveProperty('node');
      unmount();
    }
  });
});

/**
 * New session as the shell mounts it while a session can start anywhere (canStartAnywhere, below):
 * the screen itself, so these hold whatever the Mac's own switch says.
 */
function renderNew(state: State, api: Api) {
  const store = createAppStore(state);
  store.getState().setConn({ status: 'live', lastOkAt: NOW });
  const router = createRouter(memoryHistory('/new'));
  return render(
    <AppProvider deps={{ store, api, router, toasts: createToastStore(), now: () => NOW }}>
      <NewSession />
    </AppProvider>,
  );
}

/** The fleet with starting on only where `on` says. */
function startingOn(...on: string[]): State {
  const s = fleetState({ features: {} });
  for (const n of Object.values(s.nodes!)) n.features = { ...n.features, launch: on.includes(n.id) };
  return s;
}

describe("with the Mac's own starting off", () => {
  it('starts on a server that has it on: only that machine is offered, and every call carries its node', async () => {
    // `jantar launch on` on build-1 only.
    const api = launchApi({}, { 'r.1:': work });
    renderNew(startingOn(IDS.build1), api);
    expect(await choices()).toEqual(['build-1']);
    expect(await pressed()).toBe('build-1');
    await waitFor(() => expect(rows()).toEqual(['api', 'notes']), { timeout: 10_000 });
    for (const call of (api.foldersRoots as ReturnType<typeof vi.fn>).mock.calls) expect(call).toEqual([{ node: IDS.build1 }]);
    for (const call of (api.foldersRecent as ReturnType<typeof vi.fn>).mock.calls) expect(call).toEqual([{ node: IDS.build1 }]);
    for (const [q] of (api.foldersList as ReturnType<typeof vi.fn>).mock.calls) expect(q).toEqual({ root: 'r.1', node: IDS.build1 });
  });

  it('the shell mounts New session for it, and the Board offers New and each server row its own "New session here"', async () => {
    const api = launchApi({}, { 'r.1:': work });
    const app = renderApp({ path: '/new', api, state: startingOn(IDS.build1) });
    expect(await choices()).toEqual(['build-1']);
    expect(screen.queryByText(/launch on/)).toBeNull();
    app.unmount();
    // Nowhere to start: the shell's "launch on" page, and no New on the Board.
    const none = renderApp({ path: '/new', api: launchApi(), state: startingOn() });
    expect(await screen.findByText(/launch on/)).toBeTruthy();
    none.unmount();
    renderApp({ path: '/', api: launchApi(), state: startingOn(IDS.build1) });
    expect((await screen.findAllByRole('button', { name: 'New session' })).length).toBeGreaterThan(0);
  });

  it("shows a server's launch on its way on the Board, naming the machine, and counts its dialog in the tab", async () => {
    const s = startingOn(IDS.build2);
    s.launches.L7 = job('L7', { node: IDS.build2, stage: 'dialog' });
    renderApp({ path: '/', api: launchApi(), state: s });
    await waitFor(() => expect(document.querySelector('[data-launch="L7"]')).not.toBeNull());
    expect(document.querySelector('[data-launch="L7"] [data-machine]')?.textContent).toBe('build-2');
    // build-1's open card and this dialog: the Mac's own starting being off never hides it.
    await waitFor(() => expect(document.title).toMatch(/^\(2\) /));
  });

  it('offers each machine that can start but never the Mac, the first one picked', async () => {
    const api = launchApi();
    renderNew(fleetState({ features: {} }), api);
    expect(await choices()).toEqual(['build-2', 'mini-1']);
    expect(await pressed()).toBe('build-2');
    await waitFor(() => expect(api.foldersRoots).toHaveBeenCalledWith({ node: IDS.build2 }));
  });
});

describe('where a session can start', () => {
  it('startMachines: the online machines with starting on, never a watch-only one, by name', () => {
    expect(startMachines(fleetNodes()).map((n) => n.name)).toEqual(['build-2', 'mini-1']);
    expect(startMachines(undefined)).toEqual([]);
    expect(startMachines({})).toEqual([]);
  });

  it("canStartOn: each machine by its own switch (the Mac by the Mac's)", () => {
    const off = fleetState({ features: {} });
    expect(canStartOn(off, undefined)).toBe(false);
    expect(canStartOn(off, IDS.build2)).toBe(true);
    expect(canStartOn(off, IDS.build1)).toBe(false);
    // Offline, watch-only, unknown.
    expect(canStartOn(off, IDS.build3)).toBe(false);
    expect(canStartOn(off, IDS.ro1)).toBe(false);
    expect(canStartOn(off, 'unknown')).toBe(false);
    expect(canStartOn(fleetState({ features: ON }), undefined)).toBe(true);
  });

  it("canStartAnywhere: the Mac, or any machine by its own switch, online or not (New session exists while it holds)", () => {
    expect(canStartAnywhere(stateWith({ features: {} }))).toBe(false);
    expect(canStartAnywhere(stateWith({ features: ON }))).toBe(true);
    expect(canStartAnywhere(startingOn())).toBe(false);
    expect(canStartAnywhere(startingOn(IDS.build1))).toBe(true);
    // A watch-only machine is no place to start; an offline one keeps New session (its link may be back in a second).
    expect(canStartAnywhere(startingOn(IDS.ro1))).toBe(false);
    expect(canStartAnywhere(startingOn(IDS.build3))).toBe(true);
    const older = stateWith({ features: {} });
    delete older.nodes;
    expect(canStartAnywhere(older)).toBe(false);
  });
});

describe('onMachine', () => {
  it('sends ?node= on every call whose route takes it, and leaves the Mac\'s calls alone', async () => {
    // Every route the Mac forwards by ?node= (protocol NodeQuerySchema on its query).
    const nodeRoutes = (Object.entries(ROUTES) as [string, RouteDef][])
      .filter(([, r]) => {
        const shape = (r.query as unknown as { shape?: Record<string, unknown> } | undefined)?.shape;
        return shape !== undefined && Object.hasOwn(shape, 'node');
      })
      .map(([n]) => n)
      .sort();
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const credentials = { get: async () => null, set: async () => undefined, clear: async () => undefined } as unknown as CredentialStore;
    const real = createApi({ fetch: fetch as unknown as typeof globalThis.fetch, base: 'https://mac.example.test', credentials });
    const flags = { permission: 'manual', chrome: false, effort: 'default', model: 'default' } as const;
    const calls: Record<string, (api: ReturnType<typeof onMachine>) => Promise<unknown>> = {
      foldersRoots: (a) => a.foldersRoots(),
      foldersList: (a) => a.foldersList({ root: 'r.1' }),
      foldersRecent: (a) => a.foldersRecent(),
      foldersPin: (a) => a.foldersPin({ root: 'r.1', path: 'a', pinned: true }),
      foldersCreate: (a) => a.foldersCreate({ root: 'r.1', parent: '', name: 'new-app' }, 'k1'),
      launchPreview: (a) => a.launchPreview({ root: 'r.1', path: 'a' }),
      launchStart: (a) => a.launchStart({ root: 'r.1', path: 'a', account: 'auto', flags }, 'k2'),
      launchHistory: (a) => a.launchHistory({ root: 'r.1' }),
      refreshUsage: (a) => a.refreshUsage(),
    };
    // A new route that takes ?node= needs its line here and in onMachine.
    expect(Object.keys(calls).sort()).toEqual(nodeRoutes);

    const machine = onMachine(real, IDS.build2);
    for (const name of nodeRoutes) await calls[name]!(machine);
    const urls = fetch.mock.calls.map(([u]) => new URL(String(u)));
    expect(urls.length).toBe(nodeRoutes.length);
    for (const u of urls) expect(u.searchParams.get('node'), u.pathname).toBe(IDS.build2);

    // The Mac: the same API, untouched.
    expect(onMachine(real, undefined)).toBe(real);
  });
});
