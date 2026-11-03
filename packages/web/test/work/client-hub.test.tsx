/**
 * 0.13.0 A client's hub (design 6.2 "A client", W21, W30, W31) against the
 * fake API, with made-up clients:
 *
 * - One read: the title, company (a link) and state; Call, WhatsApp (the
 *   dial code before a 10-digit number; none without one) and Email as the
 *   phone's own apps; the next step with its Done; follow-ups, deals,
 *   projects, the log (a meeting links to its page, a done follow-up in
 *   between) with Show older, and the details.
 * - Words someone else wrote are marked and framed as data.
 * - Delete spells out what goes and what stays, offers Mark as past first,
 *   and has no Undo; Mark as past is one tap.
 * - "Log the call?" after a Call the page was hidden for, then back.
 * - A client that is gone says the daemon's sentence.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api.js';
import { layoutAt } from '../../src/ui/shell/layout.js';
import { fakeApi, measureAs, preloadPlaces, renderApp, stateWith } from '../helpers.js';
import { IDS, SETTINGS, WORK_ON, clientAnswers, clientHub, contact, logRow, workRequest } from '../work-helpers.js';

preloadPlaces('work', 'clients');

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'visibilityState');
});

const PATH = `/work?tab=clients&id=${IDS.pat}`;

function setup(o: { request?: Record<string, unknown>; status?: 'live' | 'offline'; over?: Parameters<typeof fakeApi>[0] } = {}) {
  const api = fakeApi({
    lifeStatus: vi.fn(async () => WORK_ON()),
    todoDone: vi.fn(async () => ({ ok: true as const })),
    request: workRequest(clientAnswers(o.request)),
    ...o.over,
  });
  return renderApp({ path: PATH, state: stateWith({ features: { life: true, files: true } }), api, ...(o.status ? { status: o.status } : {}) });
}

const requested = (api: { request: unknown }, method: string, path: string) =>
  (api.request as ReturnType<typeof workRequest>).mock.calls.filter(([r]) => r.method === method && r.path === path).map(([, init]) => init);

describe("a client's hub", () => {
  it('from one read: company and state, Call, WhatsApp and Email, the next step, follow-ups, deals, projects, the log and details', async () => {
    setup();
    expect(await screen.findByRole('heading', { level: 1, name: 'Pat Example' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Clients' }).getAttribute('href')).toBe('/work?tab=clients');
    expect(screen.getByRole('link', { name: 'Acme' }).getAttribute('href')).toBe(`/work?tab=clients&id=${IDS.client}`);
    expect(screen.getByText('Head of Ops')).toBeTruthy();
    // The phone's own apps, filled in; WhatsApp with Work's dial code before the 10 digits.
    expect(screen.getByRole('link', { name: 'Call' }).getAttribute('href')).toBe('tel:9876543210');
    const wa = screen.getByRole('link', { name: 'WhatsApp' });
    expect(wa.getAttribute('href')).toBe('https://wa.me/919876543210');
    expect(wa.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('link', { name: 'Email' }).getAttribute('href')).toBe('mailto:pat@acme.example');
    // The next step: its earliest follow-up.
    const next = document.querySelector('[data-next]') as HTMLElement;
    expect(next.textContent).toMatch(/Call about scope · Tomorrow 15:00/);
    expect(within(next).getByRole('button', { name: 'Mark done: Call about scope' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Log a call or meeting' })).toBeTruthy();
    const follow = screen.getByRole('region', { name: 'Follow-ups' });
    expect(within(follow).getByRole('button', { name: 'Mark done: Call about scope' })).toBeTruthy();
    const deals = screen.getByRole('region', { name: 'Deals' });
    const deal = within(deals).getByRole('link', { name: /Site rebuild/ });
    expect(deal.textContent).toMatch(/Proposal sent/);
    expect(deal.textContent).toMatch(/₹4,50,000 · 12 days in stage · no next step/);
    expect(deal.getAttribute('href')).toBe(`/work?tab=deals&id=${IDS.deal}`);
    expect(within(screen.getByRole('region', { name: 'Projects' })).getByRole('link', { name: /Site rebuild/ }).getAttribute('href')).toBe(`/work?id=${IDS.acme}`);
    const log = screen.getByRole('list', { name: 'Its log' });
    const rows = within(log).getAllByRole('listitem');
    expect(rows[0]!.textContent).toMatch(/Call · out · 25m · Went well · 13 Jan/);
    expect(rows[0]!.textContent).toMatch(/Wants a quote by Friday\./);
    expect(within(rows[1]!).getByRole('link', { name: /Meeting · Kickoff call/ }).getAttribute('href')).toBe(`/meetings?id=${IDS.meeting}`);
    expect(rows[2]!.textContent).toMatch(/Done · Send proposal · 11 Jan/);
    // His own call has Edit and Delete; a meeting's row and a done follow-up don't.
    expect(within(rows[0]!).getByRole('button', { name: 'Actions for this call' })).toBeTruthy();
    expect(within(rows[1]!).queryByRole('button', { name: /Actions/ })).toBeNull();
    const details = document.querySelector('[data-details]') as HTMLElement;
    expect(within(details).getByRole('link', { name: '+44 20 7946 0000' }).getAttribute('href')).toBe('tel:+442079460000');
    expect(within(details).getByText('Mobile')).toBeTruthy();
    expect(within(details).getByRole('link', { name: 'acme.example/team' }).getAttribute('target')).toBe('_blank');
    expect(details.textContent).toMatch(/#retail/);
    expect(details.textContent).toMatch(/Referral/);
    expect(details.textContent).toMatch(/every 30 days · 2 since/);
    expect(details.textContent).toMatch(/Prefers calls before noon\./);
  });

  it('WhatsApp needs a country code: none without a dial code for a 10-digit number', async () => {
    setup({ request: { 'GET /v1/work/settings': SETTINGS(), 'GET /v1/work/clients/:id': clientHub({ contact: contact(IDS.pat, { phones: [{ value: '98765 43210' }] }) }) } });
    expect(await screen.findByRole('link', { name: 'Call' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'WhatsApp' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Email' })).toBeNull();
  });

  it('Show older asks for the next page after the last row and adds it', async () => {
    const { api } = setup({ request: { 'GET /v1/work/clients/:id/log': { log: [logRow('01JWRK10G00000000000000009', { kind: 'note', body: 'An older note.', at: '2026-01-02T10:00:00.000Z' })] } } });
    fireEvent.click(await screen.findByRole('button', { name: 'Show older' }));
    expect(await screen.findByText('An older note.')).toBeTruthy();
    expect(requested(api, 'GET', '/v1/work/clients/:id/log')).toEqual([{ params: { id: IDS.pat }, query: { before: '2026-01-11T10:00:00.000Z~01JWRK10G00000000000000003' } }]);
    // The last page has no cursor: no more Show older.
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
  });

  it('words someone else wrote are marked and framed as data', async () => {
    setup({
      request: {
        'GET /v1/work/clients/:id': clientHub({
          contact: contact(IDS.pat, { from: 'import', notes: 'Imported note text.' }),
          company: { id: IDS.client, name: 'Acme', state: 'client', from: 'meeting' },
          log: [logRow(IDS.log1, { kind: 'note', from: 'import', body: 'An imported entry.' })],
          logNext: undefined,
        }),
      },
    });
    expect(await screen.findByText('Its details came from a file you imported.')).toBeTruthy();
    const framed = [...document.querySelectorAll('[data-framed="import"]')].map((e) => e.textContent);
    expect(framed.some((t) => /Imported note text\./.test(t ?? ''))).toBe(true);
    expect(framed.some((t) => /An imported entry\./.test(t ?? ''))).toBe(true);
    expect(document.querySelector('[data-from="meeting"]')?.textContent).toBe('from a meeting');
  });

  it('Delete spells out what goes and stays, offers Mark as past first, then deletes and goes back to the list', async () => {
    const { api, history, toasts } = setup({ request: { 'DELETE /v1/work/clients/:id': { ok: true, removed: { deals: 1, log: 34 } } } });
    await screen.findByRole('heading', { level: 1, name: 'Pat Example' });
    fireEvent.click(screen.getByRole('button', { name: 'More for Pat Example' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const sheet = await screen.findByRole('dialog', { name: 'Delete Pat Example?' });
    expect([...sheet.querySelectorAll('[data-delete-lines] p')].map((p) => p.textContent)).toEqual([
      'Deletes its 1 deal and its whole log.',
      'Its 1 follow-up and 1 project stay, with no client.',
      'There is no Undo. Mark it as past instead to keep its history.',
    ]);
    expect(within(sheet).getByRole('button', { name: 'Mark as past instead' })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(history.entries.at(-1)).toBe('/work?tab=clients'));
    expect(requested(api, 'DELETE', '/v1/work/clients/:id')[0]).toMatchObject({ params: { id: IDS.pat } });
    expect(toasts.getState().toasts.map((t) => t.text)).toContain('Deleted Pat Example, with 1 deal and 34 log entries.');
  });

  it('Mark as past instead, from the Confirm', async () => {
    const { api } = setup({ request: { 'PATCH /v1/work/clients/:id': { ok: true } } });
    await screen.findByRole('heading', { level: 1, name: 'Pat Example' });
    fireEvent.click(screen.getByRole('button', { name: 'More for Pat Example' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete Pat Example?' })).getByRole('button', { name: 'Mark as past instead' }));
    await waitFor(() => expect(requested(api, 'PATCH', '/v1/work/clients/:id')).toEqual([expect.objectContaining({ params: { id: IDS.pat }, body: { state: 'past' } })]));
    expect(requested(api, 'DELETE', '/v1/work/clients/:id')).toEqual([]);
  });

  it('a company lists its people; a deal of one of them is labelled with its client', async () => {
    setup({
      request: {
        'GET /v1/work/clients/:id': clientHub({
          contact: contact(IDS.client, { name: 'Acme', kind: 'company' }),
          company: undefined,
          people: [{ id: IDS.pat, name: 'Pat Example', kind: 'person', state: 'client', title: 'Head of Ops', openDeals: { count: 0, sums: [] }, tags: [] }],
        }),
      },
    });
    const people = await screen.findByRole('region', { name: 'People' });
    expect(within(people).getByRole('link', { name: /Pat Example/ }).getAttribute('href')).toBe(`/work?tab=clients&id=${IDS.pat}`);
    expect(within(screen.getByRole('region', { name: 'Deals' })).getByRole('link', { name: /Site rebuild/ }).textContent).toMatch(/Pat Example · ₹4,50,000/);
  });

  it('"Log the call?" after a Call the page was hidden for, then the Log sheet on Call', async () => {
    let state: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    let t = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    setup();
    const call = await screen.findByRole('link', { name: 'Call' });
    call.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(call);
    state = 'hidden';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    t += 4 * 60_000;
    state = 'visible';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    const ask = await screen.findByText('Log the call with Pat Example?');
    fireEvent.click(within(ask.parentElement!).getByRole('button', { name: 'Log it' }));
    const sheet = await screen.findByRole('dialog', { name: 'Log with Pat Example' });
    expect(within(sheet).getByRole('button', { name: 'Call' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('a call dialog cancelled at once never asks', async () => {
    let state: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    let t = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    setup();
    const call = await screen.findByRole('link', { name: 'Call' });
    call.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(call);
    state = 'hidden';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    t += 3_000;
    state = 'visible';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Log the call with Pat Example?')).toBeNull();
  });

  it('with a keyboard: l logs, n sets a next step, e edits', async () => {
    const api = fakeApi({ lifeStatus: vi.fn(async () => WORK_ON()), request: workRequest(clientAnswers()) });
    measureAs(1180);
    renderApp({ path: PATH, state: stateWith({ features: { life: true } }), api, layout: layoutAt(1440) });
    await screen.findByRole('heading', { level: 1, name: 'Pat Example' });
    fireEvent.keyDown(window, { key: 'l' });
    const log = await screen.findByRole('dialog', { name: 'Log with Pat Example' });
    fireEvent.click(within(log).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.keyDown(window, { key: 'n' });
    const next = await screen.findByRole('dialog', { name: 'Next step' });
    expect((within(next).getByLabelText('Client') as HTMLSelectElement).value).toBe(IDS.pat);
    fireEvent.click(within(next).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.keyDown(window, { key: 'e' });
    expect(await screen.findByRole('dialog', { name: 'Edit Pat Example' })).toBeTruthy();
  });

  it('a client that is gone says the daemon’s sentence; offline the page stays and writes are off', async () => {
    const a = setup({ request: { 'GET /v1/work/clients/:id': new ApiError('not_found', 'No such client.', 404) } });
    expect(await screen.findByText('No such client.')).toBeTruthy();
    a.unmount();
    setup({ status: 'offline' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Pat Example' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Log a call or meeting' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
