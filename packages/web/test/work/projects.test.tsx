/**
 * 0.13.0 Work › Projects and a project's hub (design 6.2-6.5, W41) against
 * the fake API, with made-up companies:
 *
 * - The list: Active, Paused and Done (Done folded), each row the Todos row
 *   with its client's name and its next due todo, linking to `/work?id=`;
 *   two taps from the Board on a phone. Empty: one line and "New project".
 *   A wide pane with nothing open: one table; a project open beside it:
 *   the rows, the open one current. Life broken: the daemon's sentence.
 *   Offline: the last list stays, adding is off.
 * - The hub, from one read: the client and due day, status, the health line
 *   (ember only for overdue), milestones, the deal, todos with the newest
 *   done, sessions in its folder with "New session here" (Launch on and the
 *   launch scope only), meetings (Meetings on only), the log, notes, and
 *   "Open folder in Files" (Files on only). Status is one tap. A project
 *   that is gone says so.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Features, FilesRootsResponse, MeetingsList } from '@jantar/protocol';
import { ApiError } from '../../src/lib/api.js';
import { writeLocal } from '../../src/lib/storage.js';
import { LOCAL_DEVICE_KEY } from '../../src/ui/screens/devices/local.js';
import { layoutAt } from '../../src/ui/shell/layout.js';
import { fakeApi, measureAs, preloadPlaces, renderApp, session, stateWith } from '../helpers.js';
import { IDS, WORK_ON, hub, project, todo, workRequest } from '../work-helpers.js';

preloadPlaces('work');

afterEach(() => vi.restoreAllMocks());

const ROOTS: FilesRootsResponse = {
  roots: [
    { id: 'r.work', kind: 'configured', label: 'work', display: '~/Desktop/work', home: false },
    { id: 'r.home', kind: 'configured', label: 'Home', display: '~', home: true },
  ],
};

const PROJECTS = [
  project(IDS.acme, { name: 'Site rebuild', open: 3, overdue: 0, clientId: IDS.client, folder: '/Users/example/Desktop/work/client/acme' }),
  project(IDS.northwind, { name: 'AI audit', status: 'paused', open: 1 }),
  project(IDS.globex, { name: 'Brand refresh', status: 'done' }),
];

function setup(o: { features?: Partial<Features>; projects?: ReturnType<typeof project>[]; request?: Record<string, unknown>; path?: string; layout?: Parameters<typeof renderApp>[0]['layout']; status?: 'live' | 'offline'; over?: Parameters<typeof fakeApi>[0]; sessions?: ReturnType<typeof session>[] } = {}) {
  const api = fakeApi({
    lifeStatus: vi.fn(async () => WORK_ON()),
    projectsList: vi.fn(async () => ({ projects: o.projects ?? PROJECTS })),
    todosList: vi.fn(async () => ({ todos: [todo(IDS.todo2, { projectId: IDS.acme, due: { day: '2026-01-15', time: '15:00' } })], today: '2026-01-15' })),
    foldersRoots: vi.fn(async () => ROOTS),
    filesRoots: vi.fn(async () => ROOTS),
    meetingsList: vi.fn(async (): Promise<MeetingsList> => ({ meetings: [], next: null, running: null })),
    projectUpdate: vi.fn(async () => ({ ok: true as const })),
    request: workRequest({
      'GET /v1/work/clients/names': { clients: [{ id: IDS.client, name: 'Acme' }] },
      'GET /v1/projects/:id': hub(),
      ...o.request,
    }),
    ...o.over,
  });
  const state = stateWith({ sessions: o.sessions ?? [session('a')], features: { life: true, ...o.features } });
  return renderApp({ path: o.path ?? '/work', state, api, ...(o.layout ? { layout: o.layout } : {}), ...(o.status ? { status: o.status } : {}) });
}

describe('Work › Projects on a phone', () => {
  it('groups the projects, Done folded; a row names its client and next due, and opens the hub', async () => {
    const { history, api } = setup();
    expect(await screen.findByRole('heading', { level: 1, name: 'Work' })).toBeTruthy();
    const active = await screen.findByRole('list', { name: 'Active projects' });
    const row = within(active).getByRole('link', { name: /Site rebuild/ });
    expect(row.getAttribute('href')).toBe(`/work?id=${IDS.acme}`);
    await waitFor(() => expect(within(row).getByText('Acme')).toBeTruthy());
    expect(row.textContent).toMatch(/3 open/);
    expect(row.textContent).toMatch(/next Today/);
    expect(within(screen.getByRole('list', { name: 'Paused projects' })).getByRole('link', { name: /AI audit/ })).toBeTruthy();
    // Done is folded until opened.
    expect(screen.queryByRole('list', { name: 'Done projects' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(within(screen.getByRole('list', { name: 'Done projects' })).getByRole('link', { name: /Brand refresh/ })).toBeTruthy();
    // The client names come from one names read, by id.
    expect(api.request).toHaveBeenCalledWith({ method: 'GET', path: '/v1/work/clients/names' }, { query: { ids: IDS.client } });
    fireEvent.click(row);
    expect(history.entries.at(-1)).toBe(`/work?id=${IDS.acme}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Site rebuild' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Projects' }).getAttribute('href')).toBe('/work');
  });

  it('empty: one line and "New project"', async () => {
    setup({ projects: [] });
    expect(await screen.findByText('No projects yet.')).toBeTruthy();
    // The header's + and the empty state's button.
    expect(screen.getAllByRole('button', { name: 'New project' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'New project' }).at(-1)!);
    expect(await screen.findByRole('dialog', { name: 'New project' })).toBeTruthy();
  });

  it('life.db broken: the daemon’s sentence, with its command in mono', async () => {
    setup({ over: { projectsList: vi.fn(async () => Promise.reject(new ApiError('life_unavailable', 'Life is unavailable: life.db could not be opened. See it at your Mac: jantar life status', 503))) } });
    const code = await screen.findByText('jantar life status');
    expect(code.tagName).toBe('CODE');
    expect(screen.getByRole('heading', { level: 1, name: 'Work' })).toBeTruthy();
  });

  it('a failed load offers Try again', async () => {
    setup({ over: { projectsList: vi.fn(async () => Promise.reject(new ApiError('internal', 'Something broke', 500))) } });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('offline: the last list stays and adding is off', async () => {
    setup({ status: 'offline' });
    expect(await screen.findByRole('list', { name: 'Active projects' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'New project' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Offline: changes need your Mac')).toBeTruthy();
  });

  it('touch targets: every row and button is 44 tall on touch', async () => {
    setup({ layout: layoutAt(390, { coarse: true }) });
    const row = await screen.findByRole('link', { name: /Site rebuild/ });
    expect(row.className).toContain('coarse:min-h-44');
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByRole('button', { name: 'Hide' }).className).toContain('coarse:h-44');
  });
});

describe('Work › Projects in a wide pane', () => {
  it('a table with nothing open; a project beside the rows, the open one current; Esc closes it', async () => {
    measureAs(1100);
    const { history } = setup({ layout: layoutAt(1440) });
    const table = await screen.findByRole('table', { name: 'Active projects' });
    expect(screen.getByRole('table', { name: 'Paused projects' })).toBeTruthy();
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Name', 'Client', 'Open', 'Overdue', 'Next', 'Due', 'Live']);
    const link = within(table).getByRole('link', { name: 'Site rebuild' });
    expect(link.getAttribute('href')).toBe(`/work?id=${IDS.acme}`);
    fireEvent.click(link);
    expect(await screen.findByRole('heading', { level: 1, name: 'Site rebuild' })).toBeTruthy();
    const list = screen.getByRole('region', { name: 'All projects' });
    expect(within(list).queryByRole('table')).toBeNull();
    expect(within(list).getByRole('link', { name: /Site rebuild/ }).getAttribute('aria-current')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(history.entries.at(-1)).toBe('/work'));
  });
});

describe('a project’s hub', () => {
  const PATH = `/work?id=${IDS.acme}`;
  const LIVE = session('acme-web', { cwd: '/Users/example/Desktop/work/client/acme/web', folder: 'acme-web' });

  it('from one read: client, due, status, health, todos, the newest done, sessions, the log and notes', async () => {
    const { api } = setup({
      path: PATH,
      sessions: [LIVE],
      request: {
        'GET /v1/projects/:id': hub({
          project: project(IDS.acme, { name: 'Site rebuild', folder: '/Users/example/Desktop/work/client/acme', due: '2026-01-28', clientId: IDS.client, notes: 'Wants the store live before the festival.' }),
          client: { id: IDS.client, name: 'Acme', state: 'client' },
          log: [{ id: '01JWRKL0G00000000000000001', kind: 'call', at: '2026-01-14T09:00:00.000Z', direction: 'out', minutes: 25, outcome: 'good', body: 'Wants a quote by Friday.' }],
        }),
      },
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Site rebuild' })).toBeTruthy();
    expect(api.request).toHaveBeenCalledWith({ method: 'GET', path: '/v1/projects/:id' }, { params: { id: IDS.acme } });
    expect(screen.getByRole('link', { name: 'Acme' }).getAttribute('href')).toBe(`/work?tab=clients&id=${IDS.client}`);
    expect(screen.getByText('due 28 Jan')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: 'Active' }).getAttribute('aria-pressed')).toBe('true');
    const health = document.querySelector('[data-health]') as HTMLElement;
    expect(health.textContent).toBe('1 overdue·5 done this week');
    expect(within(health).getByText('1 overdue').className).toContain('text-signal-text');
    expect(within(screen.getByRole('region', { name: 'Its todos' })).getAllByRole('listitem').map((l) => l.getAttribute('data-todo'))).toEqual([IDS.todo1, IDS.todo2]);
    const done = screen.getByRole('region', { name: 'Recently done' });
    expect(within(done).getByText('Kickoff notes')).toBeTruthy();
    expect(within(done).getByText('5 this week')).toBeTruthy();
    const sessions = screen.getByRole('region', { name: 'Sessions in its folder' });
    expect(within(sessions).getByRole('link', { name: /acme-web/ }).getAttribute('href')).toBe('/s/acme-web');
    // Launch is off: no "New session here"; Files is off: no "Open folder in Files".
    expect(screen.queryByRole('link', { name: 'New session here' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open folder in Files' })).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Log' })).getByText('Call · out · 25m · Went well · 14 Jan')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Log' })).getByText('Wants a quote by Friday.')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Notes' })).getByText('Wants the store live before the festival.')).toBeTruthy();
    // Meetings are off: never asked.
    expect(api.meetingsList).not.toHaveBeenCalled();
  });

  it('the next due shows while nothing is overdue; milestones and the deal show when there are some', async () => {
    setup({
      path: PATH,
      request: {
        'GET /v1/projects/:id': hub({
          open: [todo(IDS.todo2, { title: 'Send wireframes', due: { day: '2026-01-15', time: '15:00' }, projectId: IDS.acme })],
          health: { overdue: 0, nextDue: { todoId: IDS.todo2, due: { day: '2026-01-15', time: '15:00' } }, quietDays: 16, doneByWeek: [0, 0, 0, 0, 0, 0, 0, 0] },
          doneThisWeek: 0,
          recentDone: [],
          milestones: { items: [{ id: '01JWRKM1LE00000000000000A1', name: 'Design', done: true }, { id: '01JWRKM1LE00000000000000A2', name: 'Beta', target: '2026-02-02' }], done: 1, percent: 50, missed: [], next: '01JWRKM1LE00000000000000A2' },
          deal: { id: IDS.deal, title: 'Site rebuild', client: { id: IDS.client, name: 'Acme' }, stage: 'proposal', stageName: 'Proposal sent', kind: 'open', value: 45000000, currency: 'INR', daysInStage: 12, quiet: false },
        }),
      },
    });
    await screen.findByRole('heading', { level: 1, name: 'Site rebuild' });
    expect((document.querySelector('[data-health]') as HTMLElement).textContent).toBe('next: Send wireframes Today 15:00·quiet 16 days');
    expect((document.querySelector('[data-milestones]') as HTMLElement).textContent).toMatch(/Milestones1 of 2 · 50%next: Beta · 2 Feb/);
    const deal = document.querySelector('[data-deal]') as HTMLAnchorElement;
    expect(deal.getAttribute('href')).toBe(`/work?tab=deals&id=${IDS.deal}`);
    expect(deal.textContent).toMatch(/Proposal sent · ₹4,50,000/);
    expect(deal.textContent).toMatch(/no next step/);
    expect(screen.queryByRole('region', { name: 'Recently done' })).toBeNull();
  });

  it('"New session here" with Launch on and the launch scope; "Open folder in Files" with Files on; meetings with Meetings on', async () => {
    const meetings: MeetingsList = {
      meetings: [{ id: IDS.meeting, site: 'meet', name: 'Kickoff call', autoTodos: false, notes: true, startedAt: '2026-01-13T09:00:00.000Z', endedAt: '2026-01-13T09:40:00.000Z', lines: 10, shots: 0, summary: 'ready', projectId: IDS.acme }],
      next: null,
      running: null,
    } as MeetingsList;
    const { api } = setup({ path: PATH, features: { launch: true, files: true, meetings: true }, over: { meetingsList: vi.fn(async () => meetings) } });
    const here = await screen.findByRole('link', { name: 'New session here' });
    expect(here.getAttribute('href')).toBe('/new?root=r.work&path=client%2Facme&start=1');
    expect(screen.getByRole('link', { name: 'Open folder in Files' }).getAttribute('href')).toBe('/files?root=r.work&path=client%2Facme');
    expect(api.meetingsList).toHaveBeenCalledWith({ project: IDS.acme, limit: 10 });
    const m = within(screen.getByRole('region', { name: 'Meetings' })).getByRole('link', { name: /Kickoff call/ });
    expect(m.getAttribute('href')).toBe(`/meetings?id=${IDS.meeting}`);
    expect(m.textContent).toMatch(/13 Jan/);
  });

  it('a device paired without the launch scope has no "New session here"', async () => {
    writeLocal(LOCAL_DEVICE_KEY, { id: 'dev-3', name: 'Phone', scopes: ['read', 'control'] });
    setup({ path: PATH, features: { launch: true, files: true } });
    expect(await screen.findByRole('link', { name: 'Open folder in Files' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'New session here' })).toBeNull();
  });

  it('status is one tap; a project that is gone says so', async () => {
    const { api, unmount } = setup({ path: PATH });
    await screen.findByRole('heading', { level: 1, name: 'Site rebuild' });
    fireEvent.click(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: 'Paused' }));
    await waitFor(() => expect(api.projectUpdate).toHaveBeenCalledWith(IDS.acme, { status: 'paused' }, expect.any(String)));
    unmount();
    setup({ path: PATH, request: { 'GET /v1/projects/:id': new ApiError('not_found', 'That project is gone.', 404) } });
    expect(await screen.findByText('That project is gone.')).toBeTruthy();
  });
});
