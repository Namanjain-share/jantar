/**
 * 0.13.0 Work › Clients (design 6.2-6.5, W20) against the fake API, with
 * made-up clients (Acme, Northwind, Pat Example, Sam Sample):
 *
 * - Projects · Clients under Work's title; the Clients tab is its address.
 * - The groups: Needs a step (an open deal and no follow-up), Clients,
 *   Leads, Past (folded). A row: its name (a person with its company), its
 *   next step (ember once overdue), its open deals per currency and last
 *   touch; an imported one is marked.
 * - The filters are the address: the box (after typing stops), the state
 *   chips, a tag and a starter list; the sort is the screen's.
 * - A wide pane with nothing open: one table; a client open beside it.
 * - Every state: loading, empty (Add a client, Import a file), nothing
 *   matching (Clear filters), Work off, life.db broken, a failed load,
 *   offline (the last list stays, adding is off).
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api.js';
import { layoutAt } from '../../src/ui/shell/layout.js';
import { fakeApi, measureAs, preloadPlaces, renderApp, stateWith } from '../helpers.js';
import { CLIENTS, IDS, WORK_ON, clientAnswers, clientRows, lifeStatus, workRequest } from '../work-helpers.js';

preloadPlaces('work', 'clients');

afterEach(() => vi.restoreAllMocks());

function setup(o: { request?: Record<string, unknown>; path?: string; layout?: ReturnType<typeof layoutAt>; status?: 'live' | 'offline'; over?: Parameters<typeof fakeApi>[0] } = {}) {
  const api = fakeApi({
    lifeStatus: vi.fn(async () => WORK_ON()),
    projectsList: vi.fn(async () => ({ projects: [] })),
    todosList: vi.fn(async () => ({ todos: [], today: '2026-01-15' })),
    request: workRequest(clientAnswers(o.request)),
    ...o.over,
  });
  return renderApp({ path: o.path ?? '/work?tab=clients', state: stateWith({ features: { life: true } }), api, ...(o.layout ? { layout: o.layout } : {}), ...(o.status ? { status: o.status } : {}) });
}

const clientsCalls = (request: ReturnType<typeof workRequest>) =>
  request.mock.calls.filter(([r, init]) => r.path === '/v1/work/clients' && r.method === 'GET' && init?.query?.kind !== 'company').map(([, init]) => init?.query);

describe('Work › Clients on a phone', () => {
  it('groups the clients: Needs a step, Clients, Leads, Past folded; a row says its next step, deals and last touch', async () => {
    const { history } = setup();
    // The heading shows while the chunk loads too: wait for the list.
    const step = await screen.findByRole('list', { name: 'Needs a step' });
    expect(screen.getByRole('heading', { level: 1, name: 'Work' })).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Work' })).getByRole('button', { name: 'Clients' }).getAttribute('aria-pressed')).toBe('true');
    const northwind = within(step).getByRole('link', { name: /Northwind/ });
    expect(northwind.textContent).toMatch(/no next step/);
    expect(northwind.textContent).toMatch(/lead/);
    expect(northwind.textContent).toMatch(/1 open deal · ₹2,00,000/);
    expect(northwind.textContent).toMatch(/quiet 26 days/);
    const clients = screen.getByRole('list', { name: 'Clients' });
    const acme = within(clients).getByRole('link', { name: /^Acme/ });
    expect(acme.textContent).toMatch(/next Today 15:00/);
    expect(acme.textContent).toMatch(/2 open deals · ₹6,50,000/);
    expect(acme.textContent).toMatch(/talked 2d ago/);
    expect(acme.getAttribute('href')).toBe(`/work?tab=clients&id=${IDS.client}`);
    // A person names its company.
    expect(within(clients).getByRole('link', { name: /Pat Example.*Acme/ })).toBeTruthy();
    // Past is folded; an imported one is marked so.
    expect(screen.queryByRole('list', { name: 'Past' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    const past = within(screen.getByRole('list', { name: 'Past' })).getByRole('link', { name: /Sam Sample/ });
    expect(past.querySelector('[data-from="import"]')?.textContent).toBe('imported');
    fireEvent.click(acme);
    expect(history.entries.at(-1)).toBe(`/work?tab=clients&id=${IDS.client}`);
  });

  it('an overdue next step is ember on its row', async () => {
    const rows = clientRows();
    rows[0] = { ...rows[0]!, next: { todoId: IDS.followUp, title: 'Send the quote', due: { day: '2026-01-12' } } };
    setup({ request: { 'GET /v1/work/clients': CLIENTS(rows) } });
    const acme = within(await screen.findByRole('list', { name: 'Clients' })).getByRole('link', { name: /^Acme/ });
    const next = within(acme).getByText('next 12 Jan');
    expect(next.className).toMatch(/text-signal-text/);
  });

  it('the filters are the address: state chips, a tag, a starter list, and the box once typing stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { history, api } = setup();
      await screen.findByRole('list', { name: 'Clients' });
      fireEvent.click(within(screen.getByRole('group', { name: 'State' })).getByRole('button', { name: 'Leads' }));
      expect(history.entries.at(-1)).toBe('/work?tab=clients&state=lead');
      await waitFor(() => expect(clientsCalls(api.request as ReturnType<typeof workRequest>).at(-1)).toMatchObject({ state: 'lead', sort: 'name' }));
      fireEvent.change(screen.getByRole('combobox', { name: 'Tag' }), { target: { value: 'retail' } });
      expect(history.entries.at(-1)).toBe('/work?tab=clients&state=lead&tag=retail');
      fireEvent.change(screen.getByRole('combobox', { name: 'List' }), { target: { value: 'check-in' } });
      expect(history.entries.at(-1)).toBe('/work?tab=clients&state=lead&tag=retail&list=check-in');
      fireEvent.change(screen.getByRole('searchbox', { name: 'Filter clients' }), { target: { value: 'acme' } });
      // Nothing until typing stops.
      expect(history.entries.at(-1)).not.toMatch(/q=/);
      await act(async () => {
        vi.advanceTimersByTime(350);
      });
      expect(history.entries.at(-1)).toBe('/work?tab=clients&q=acme&state=lead&tag=retail&list=check-in');
      await waitFor(() => expect(clientsCalls(api.request as ReturnType<typeof workRequest>).at(-1)).toMatchObject({ q: 'acme', state: 'lead', tag: 'retail', list: 'check-in' }));
      // A starter list shows as one group under its name.
      expect(await screen.findByRole('list', { name: 'Needs a check-in' })).toBeTruthy();
      // The sort is the screen's: asked again, the address unchanged.
      fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), { target: { value: 'touch' } });
      await waitFor(() => expect(clientsCalls(api.request as ReturnType<typeof workRequest>).at(-1)).toMatchObject({ sort: 'touch' }));
      expect(history.entries.at(-1)).toBe('/work?tab=clients&q=acme&state=lead&tag=retail&list=check-in');
    } finally {
      vi.useRealTimers();
    }
  });

  it('empty: one line with Add a client and Import a file; nothing matching: Clear filters', async () => {
    const a = setup({ request: { 'GET /v1/work/clients': CLIENTS([]) } });
    expect(await screen.findByText('No clients yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a client' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import a file' })).toBeTruthy();
    a.unmount();
    const { history } = setup({ path: '/work?tab=clients&state=past', request: { 'GET /v1/work/clients': CLIENTS([]) } });
    expect(await screen.findByText('No clients match.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(history.entries.at(-1)).toBe('/work?tab=clients');
  });

  it('more than one answer holds: says how many are not shown', async () => {
    setup({ request: { 'GET /v1/work/clients': CLIENTS(clientRows(), 312) } });
    expect(await screen.findByText('312 more not shown. Narrow the filter to find them.')).toBeTruthy();
  });

  it('Work off: the daemon’s sentence, its command in mono', async () => {
    setup({ over: { lifeStatus: vi.fn(async () => lifeStatus({ todos: true })) } });
    const code = await screen.findByText('jantar work on');
    expect(code.tagName).toBe('CODE');
  });

  it('life.db broken: the Life sentence; a failed load: Try again', async () => {
    const broken = new ApiError('life_unavailable', 'Life is unavailable: life.db could not be opened. See it at your Mac: jantar life status', 503);
    const a = setup({ request: { 'GET /v1/work/clients': broken } });
    expect((await screen.findByText('jantar life status')).tagName).toBe('CODE');
    expect(screen.getByRole('heading', { level: 1, name: 'Work' })).toBeTruthy();
    a.unmount();
    setup({ request: { 'GET /v1/work/clients': new ApiError('internal', 'Something broke', 500) } });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('offline: the last list stays, adding and the menu are off', async () => {
    setup({ status: 'offline' });
    expect(await screen.findByRole('list', { name: 'Clients' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add client' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Offline: changes need your Mac')).toBeTruthy();
  });

  it('the Projects segment goes back to the projects', async () => {
    const { history } = setup();
    await screen.findByRole('list', { name: 'Clients' });
    fireEvent.click(within(screen.getByRole('group', { name: 'Work' })).getByRole('button', { name: 'Projects' }));
    expect(history.entries.at(-1)).toBe('/work');
    expect(await screen.findByText('No projects yet.')).toBeTruthy();
  });

  it('Export CSV hands the file to the share sheet or a download', async () => {
    const download = vi.fn();
    const created = vi.fn((_b: Blob) => 'blob:csv');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(download);
    const { toasts } = setup({ request: { 'GET /v1/work/export.csv': 'name,kind\r\nAcme,company\r\n' } });
    await screen.findByRole('list', { name: 'Clients' });
    fireEvent.click(screen.getByRole('button', { name: 'More for clients' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export CSV' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(await (created.mock.calls[0]![0] as File).text()).toBe('name,kind\r\nAcme,company\r\n');
    expect((created.mock.calls[0]![0] as File).name).toBe('jantar-clients.csv');
    await waitFor(() => expect(toasts.getState().toasts.map((t) => t.text)).toContain('Clients exported.'));
    vi.unstubAllGlobals();
  });
});

describe('Work › Clients on wide panes', () => {
  it('a pane of 800 or more with nothing open: one table; a client open beside the rows', async () => {
    measureAs(1180);
    const { history } = setup({ layout: layoutAt(1440) });
    const table = await screen.findByRole('table', { name: 'Clients' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Company', 'State', 'Next step', 'Last touch', 'Open deals', 'Tags']);
    const row = within(table).getAllByRole('row').find((r) => r.getAttribute('data-client') === IDS.pat)!;
    expect(row.textContent).toMatch(/Acme/);
    expect(row.textContent).toMatch(/#retail/);
    fireEvent.click(within(row).getByRole('link', { name: 'Pat Example' }));
    expect(history.entries.at(-1)).toBe(`/work?tab=clients&id=${IDS.pat}`);
    // The client opens beside the rows, the open one current; Close (and Esc) closes it.
    expect(await screen.findByRole('heading', { level: 1, name: 'Pat Example' })).toBeTruthy();
    const list = screen.getByRole('region', { name: 'All clients' });
    expect(within(list).queryByRole('table')).toBeNull();
    expect(within(list).getByRole('link', { name: /Pat Example/ }).getAttribute('aria-current')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(history.entries.at(-1)).toBe('/work?tab=clients'));
  });
});
