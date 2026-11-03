/**
 * 0.13.0 Follow-ups and Work on Today, Todos and a meeting (design 7, 10,
 * W11, W15, W24) against the fake API, with made-up clients:
 *
 * - Today: a follow-up is a Due todo with its client named on the row (from
 *   Today's own answer); the Work card lists what isn't a todo (check-ins,
 *   deals with no next step, quiet, closing this week), each line a link,
 *   and shows only when it has something.
 * - Todos: a follow-up names its client (one names read, ids only); the
 *   todo sheet's Client field lists his clients while Work is on, sets and
 *   clears a todo's client. With Work off: no names, no field.
 * - A meeting: its clients, Unlink, Link a suggestion, and a client made
 *   from one of its names (the meeting's words), while Work is on only.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeetingDetail, Today } from '@jantar/protocol';
import { meetingDetail } from '@jantar/fixtures';
import { workLines } from '../../src/ui/screens/life/today/Today.js';
import { ApiError } from '../../src/lib/api.js';
import { fakeApi, preloadPlaces, renderApp, stateWith } from '../helpers.js';
import { CLIENTS, IDS, WORK_ON, clientRows, lifeStatus, todo, workRequest } from '../work-helpers.js';

preloadPlaces('today', 'todos', 'meetings', 'meetingClients');

afterEach(() => vi.restoreAllMocks());

const DAY = '2026-01-15';
const FOLLOW = todo(IDS.followUp, { title: 'Call about scope', due: { day: DAY, time: '15:00' }, contactId: IDS.pat });
const WORK: NonNullable<Today['work']> = {
  checkIns: [{ id: IDS.northwindCo, name: 'Northwind', every: 30, since: 34 }],
  checkInsMore: 2,
  noNextStep: 2,
  quiet: 1,
  closing: 3,
  clients: [{ id: IDS.pat, name: 'Pat Example' }],
};

const calls = (api: { request: unknown }, method: string, path: string) =>
  (api.request as ReturnType<typeof workRequest>).mock.calls.filter(([r]) => r.method === method && r.path === path).map(([, init]) => init);

describe("Today's Work card and follow-ups", () => {
  function render(t: Partial<Today>, status = WORK_ON()) {
    const api = fakeApi({
      lifeStatus: vi.fn(async () => status),
      lifeToday: vi.fn(async (): Promise<Today> => ({ day: DAY, todos: { overdue: [], today: [FOLLOW] }, ...t })),
      projectsList: vi.fn(async () => ({ projects: [] })),
      request: workRequest({ 'GET /v1/work/clients': CLIENTS() }),
    });
    return renderApp({ path: '/today', api, state: stateWith({ features: { life: true } }) });
  }

  it('the lines: check-ins by name, then counts only, each a link to its list', () => {
    expect(workLines(WORK)).toEqual([
      { key: `check:${IDS.northwindCo}`, text: 'Check in: Northwind (every 30 days, 34 since)', href: `/work?tab=clients&id=${IDS.northwindCo}` },
      { key: 'check:more', text: '+2 more to check in with', href: '/work?tab=clients&list=check-in' },
      { key: 'step', text: 'No next step: 2 deals', href: '/work?tab=deals&show=nostep' },
      { key: 'quiet', text: 'Quiet: 1 deal', href: '/work?tab=deals&show=quiet' },
      { key: 'closing', text: 'Closing this week: 3', href: '/work?tab=deals&show=closing' },
    ]);
    expect(workLines({ ...WORK, checkIns: [], checkInsMore: 0, noNextStep: 0, quiet: 0, closing: 0 })).toEqual([]);
    expect(workLines({ ...WORK, checkIns: [{ id: IDS.sam, name: 'Sam Sample', every: 14, since: null }], checkInsMore: 0, noNextStep: 0, quiet: 0, closing: 0 })[0]?.text).toBe('Check in: Sam Sample (every 14 days, never touched)');
  });

  it('a Due follow-up names its client; the Work card lists the rest', async () => {
    const { api } = render({ work: WORK });
    const due = await screen.findByRole('region', { name: 'Due' });
    const row = within(due).getByRole('button', { name: /^Call about scope/ });
    expect(row.querySelector('[data-client-chip]')?.textContent).toBe('Pat Example');
    const work = await screen.findByRole('list', { name: 'Work' });
    expect(within(work).getByRole('link', { name: /Check in: Northwind/ }).getAttribute('href')).toBe(`/work?tab=clients&id=${IDS.northwindCo}`);
    expect(within(work).getByRole('link', { name: /No next step: 2 deals/ })).toBeTruthy();
    // Today's answer named the client: no names read.
    expect(calls(api, 'GET', '/v1/work/clients/names')).toEqual([]);
  });

  it('no Work card on a day it has nothing', async () => {
    render({ work: { ...WORK, checkIns: [], checkInsMore: 0, noNextStep: 0, quiet: 0, closing: 0 } });
    await screen.findByRole('region', { name: 'Due' });
    expect(screen.queryByRole('list', { name: 'Work' })).toBeNull();
  });
});

describe('Todos: a follow-up names its client; the sheet has a Client field while Work is on', () => {
  function render(status = WORK_ON()) {
    const api = fakeApi({
      lifeStatus: vi.fn(async () => status),
      todosList: vi.fn(async () => ({ today: DAY, todos: [FOLLOW, todo(IDS.todo1, { title: 'Water the plants' })] })),
      projectsList: vi.fn(async () => ({ projects: [] })),
      todoCreate: vi.fn(async () => ({ id: '01JWRKT0D00000000000000NEW' })),
      todoUpdate: vi.fn(async () => ({ ok: true as const })),
      request: workRequest({ 'GET /v1/work/clients/names': { clients: [{ id: IDS.pat, name: 'Pat Example' }] }, 'GET /v1/work/clients': CLIENTS() }),
    });
    return { ...renderApp({ path: '/todos', api, state: stateWith({ features: { life: true } }) }), api };
  }

  it('the row says the client; Edit can clear it (null), a new todo can follow up a client', async () => {
    const { api } = render();
    const row = await screen.findByRole('button', { name: /^Call about scope/ });
    await waitFor(() => expect(row.querySelector('[data-client-chip]')?.textContent).toBe('Pat Example'));
    expect(calls(api, 'GET', '/v1/work/clients/names')).toEqual([{ query: { ids: IDS.pat } }]);
    fireEvent.click(row);
    const sheet = await screen.findByRole('dialog', { name: 'Edit todo' });
    const client = within(sheet).getByLabelText('Client') as HTMLSelectElement;
    await waitFor(() => expect([...client.options].map((o) => o.textContent)).toEqual(['None', 'Acme', 'Northwind', 'Pat Example · Acme', 'Sam Sample']));
    expect(client.value).toBe(IDS.pat);
    fireEvent.change(client, { target: { value: '' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.todoUpdate).toHaveBeenCalledWith(IDS.followUp, { contactId: null }, expect.any(String)));
    fireEvent.click(screen.getByRole('button', { name: 'Add todo' }));
    const add = await screen.findByRole('dialog', { name: 'New todo' });
    fireEvent.change(within(add).getByLabelText('Title'), { target: { value: 'Send the rates' } });
    await waitFor(() => expect((within(add).getByLabelText('Client') as HTMLSelectElement).options.length).toBe(clientRows().length + 1));
    fireEvent.change(within(add).getByLabelText('Client'), { target: { value: IDS.northwindCo } });
    fireEvent.click(within(add).getByRole('button', { name: 'Add todo' }));
    await waitFor(() => expect(api.todoCreate).toHaveBeenCalledWith({ title: 'Send the rates', priority: 'normal', contactId: IDS.northwindCo }, expect.any(String)));
  });

  it('Work off: no names read and no Client field', async () => {
    const { api } = render(lifeStatus({ todos: true }));
    fireEvent.click(await screen.findByRole('button', { name: /^Call about scope/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Edit todo' });
    expect(within(sheet).queryByLabelText('Client')).toBeNull();
    expect((api.request as ReturnType<typeof workRequest>).mock.calls).toEqual([]);
  });
});

describe("a meeting's clients", () => {
  const D = meetingDetail();
  const MID = D.meeting.id;

  function render(work: boolean) {
    const api = fakeApi({
      lifeStatus: vi.fn(async () => (work ? WORK_ON() : lifeStatus({ todos: true }))),
      meetingGet: vi.fn(async (): Promise<MeetingDetail> => D),
      meetingsList: vi.fn(async () => ({ meetings: [D.meeting], next: null, running: null })),
      projectsList: vi.fn(async () => ({ projects: [] })),
      request: workRequest({
        'GET /v1/work/meetings/:meetingId/suggest': {
          linked: [{ id: IDS.client, name: 'Acme', auto: true }],
          auto: { id: IDS.client, name: 'Acme' },
          people: [
            { index: 0, text: 'Pat E.', match: { id: IDS.pat, name: 'Pat Example' } },
            { index: 1, text: 'Jordan Placeholder' },
          ],
        },
        'PUT /v1/work/meetings/:meetingId/clients': { ok: true },
        'POST /v1/work/meetings/:meetingId/clients/new': { id: '01JWRKC11ENT0000000000NEW0' },
        'GET /v1/work/clients': CLIENTS(),
      }),
    });
    return { ...renderApp({ path: `/meetings?id=${MID}`, api, state: stateWith({ features: { life: true, meetings: true } }) }), api };
  }

  it('linked through its project, Unlink, Link a suggestion, and a client made from its people', async () => {
    const { api } = render(true);
    const clients = await screen.findByRole('region', { name: 'Clients' });
    const acme = await within(clients).findByRole('link', { name: /Acme/ });
    expect(acme.textContent).toMatch(/through its project/);
    expect(acme.getAttribute('href')).toBe(`/work?tab=clients&id=${IDS.client}`);
    // Names from the meeting are marked as its words; nothing happens without a tap.
    expect(clients.querySelector('[data-from="meeting"]')).not.toBeNull();
    expect(calls(api, 'PUT', '/v1/work/meetings/:meetingId/clients')).toEqual([]);
    fireEvent.click(within(clients).getByRole('button', { name: 'Link Pat Example' }));
    await waitFor(() => expect(calls(api, 'PUT', '/v1/work/meetings/:meetingId/clients')[0]).toMatchObject({ params: { meetingId: MID }, body: { clientIds: [IDS.client, IDS.pat] } }));
    fireEvent.click(within(clients).getByRole('button', { name: 'Unlink Acme' }));
    await waitFor(() => expect(calls(api, 'PUT', '/v1/work/meetings/:meetingId/clients')[1]).toMatchObject({ body: { clientIds: [] } }));
    fireEvent.click(within(clients).getByRole('button', { name: 'Add Jordan Placeholder as a client' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/meetings/:meetingId/clients/new')).toEqual([expect.objectContaining({ params: { meetingId: MID }, body: { person: 1 } })]));
    fireEvent.click(within(clients).getByRole('button', { name: 'Link another client…' }));
    const pick = within(clients).getByRole('combobox', { name: 'Link a client' });
    await waitFor(() => expect((pick as HTMLSelectElement).options.length).toBeGreaterThan(1));
    fireEvent.change(pick, { target: { value: IDS.northwindCo } });
    await waitFor(() => expect(calls(api, 'PUT', '/v1/work/meetings/:meetingId/clients').at(-1)).toMatchObject({ body: { clientIds: [IDS.client, IDS.northwindCo] } }));
  });

  it('a retry keeps its key only for the same set: after the list changed, the same Link sends a new one', async () => {
    let reads = 0;
    let fail = true;
    const api = fakeApi({
      lifeStatus: vi.fn(async () => WORK_ON()),
      meetingGet: vi.fn(async (): Promise<MeetingDetail> => D),
      meetingsList: vi.fn(async () => ({ meetings: [D.meeting], next: null, running: null })),
      projectsList: vi.fn(async () => ({ projects: [] })),
      request: workRequest({
        // The second read: Northwind was linked meanwhile (on another device; this one hears of it by lifeTick).
        'GET /v1/work/meetings/:meetingId/suggest': () => ({
          linked: reads++ === 0 ? [{ id: IDS.client, name: 'Acme', auto: true }] : [{ id: IDS.client, name: 'Acme', auto: true }, { id: IDS.northwindCo, name: 'Northwind' }],
          people: [
            { index: 0, text: 'Pat E.', match: { id: IDS.pat, name: 'Pat Example' } },
            { index: 1, text: 'Jordan Placeholder' },
          ],
        }),
        'PUT /v1/work/meetings/:meetingId/clients': () => (fail ? new ApiError('network', 'Failed to fetch', 0) : { ok: true }),
      }),
    });
    const { store } = renderApp({ path: `/meetings?id=${MID}`, api, state: stateWith({ features: { life: true, meetings: true } }) });
    const clients = await screen.findByRole('region', { name: 'Clients' });
    fireEvent.click(await within(clients).findByRole('button', { name: 'Link Pat Example' }));
    await waitFor(() => expect(calls(api, 'PUT', '/v1/work/meetings/:meetingId/clients')).toHaveLength(1));
    act(() => store.setState((s) => ({ state: { ...s.state, lifeTick: (s.state.lifeTick ?? 0) + 1 } })));
    await within(clients).findByRole('link', { name: /Northwind/ });
    fail = false;
    fireEvent.click(within(clients).getByRole('button', { name: 'Link Pat Example' }));
    await waitFor(() => expect(calls(api, 'PUT', '/v1/work/meetings/:meetingId/clients')).toHaveLength(2));
    const [first, second] = calls(api, 'PUT', '/v1/work/meetings/:meetingId/clients');
    expect(first).toMatchObject({ body: { clientIds: [IDS.client, IDS.pat] } });
    expect(second).toMatchObject({ body: { clientIds: [IDS.client, IDS.northwindCo, IDS.pat] } });
    expect(second!.idempotencyKey).toBeTruthy();
    expect(second!.idempotencyKey).not.toBe(first!.idempotencyKey);
  });

  it('Work off: no Clients field, nothing of Work asked', async () => {
    const { api } = render(false);
    expect(await screen.findByRole('heading', { level: 1, name: D.meeting.name })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Clients' })).toBeNull();
    expect((api.request as ReturnType<typeof workRequest>).mock.calls).toEqual([]);
  });
});
