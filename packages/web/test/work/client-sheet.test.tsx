/**
 * 0.13.0 Add a client in about ten seconds, or change one (design 6.2,
 * W29) against the fake API, with made-up clients:
 *
 * - Add: a name, a phone, a company by name ("New company: …" when it is
 *   one), Lead or Client; More fields for the rest. The similar check runs
 *   once typing stops, as a POST, and warns ("Already here: …, same
 *   phone") without ever holding Save back. Saved, the client opens.
 * - Edit: every field; only what changed is sent (null clears); a phone
 *   kept keeps its label.
 * - A Mac that can't be reached: "Not saved", the sheet keeps what he typed.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api.js';
import { fakeApi, preloadPlaces, renderApp, stateWith } from '../helpers.js';
import { IDS, WORK_ON, clientAnswers, workRequest } from '../work-helpers.js';

preloadPlaces('work', 'clients');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(o: { request?: Record<string, unknown>; path?: string } = {}) {
  const api = fakeApi({ lifeStatus: vi.fn(async () => WORK_ON()), request: workRequest(clientAnswers(o.request)) });
  return renderApp({ path: o.path ?? '/work?tab=clients', state: stateWith({ features: { life: true } }), api });
}

const calls = (api: { request: unknown }, method: string, path: string) =>
  (api.request as ReturnType<typeof workRequest>).mock.calls.filter(([r]) => r.method === method && r.path === path).map(([, init]) => init);

describe('add a client', () => {
  it('name, phone and company; a similar client warns and never blocks; saved, it opens', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const NEW = '01JWRKC11ENT0000000000NEW0';
    const { api, history, toasts } = setup({
      request: {
        'POST /v1/work/clients/similar': { matches: [{ id: IDS.pat, name: 'Pat Example', company: { id: IDS.client, name: 'Acme' }, why: 'phone' }] },
        'POST /v1/work/clients': { id: NEW, companyId: IDS.client },
      },
    });
    await screen.findByRole('list', { name: 'Clients' });
    fireEvent.click(screen.getByRole('button', { name: 'Add client' }));
    const sheet = await screen.findByRole('dialog', { name: 'New client' });
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Pat Exampel' } });
    fireEvent.change(within(sheet).getByLabelText('Phone'), { target: { value: '098765 43210' } });
    const company = within(sheet).getByLabelText('Company');
    fireEvent.change(company, { target: { value: 'Globex' } });
    expect(within(sheet).getByText('New company: Globex')).toBeTruthy();
    // Nothing is asked until typing stops.
    expect(calls(api, 'POST', '/v1/work/clients/similar')).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(450);
    });
    const warn = await within(sheet).findByRole('link', { name: /Already here: Pat Example · Acme \(same phone\)/ });
    expect(warn.getAttribute('href')).toBe(`/work?tab=clients&id=${IDS.pat}`);
    // The phone goes in a body, never a URL.
    expect(calls(api, 'POST', '/v1/work/clients/similar').at(-1)).toMatchObject({ body: { name: 'Pat Exampel', phone: '098765 43210' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Client' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add client' }));
    await waitFor(() => expect(history.entries.at(-1)).toBe(`/work?tab=clients&id=${NEW}`));
    expect(calls(api, 'POST', '/v1/work/clients')[0]?.body).toEqual({ name: 'Pat Exampel', kind: 'person', state: 'client', companyName: 'Globex', phone: '098765 43210' });
    expect(toasts.getState().toasts.map((t) => t.text)).toContain('Added Pat Exampel');
  });

  it('a company has no company; More fields adds e-mail, tags, source, check-in and notes', async () => {
    const { api } = setup({ request: { 'POST /v1/work/clients': { id: IDS.northwindCo } } });
    await screen.findByRole('list', { name: 'Clients' });
    fireEvent.click(screen.getByRole('button', { name: 'Add client' }));
    const sheet = await screen.findByRole('dialog', { name: 'New client' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Company' }));
    expect(within(sheet).queryByLabelText('Company')).toBeNull();
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Northwind' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'More fields' }));
    fireEvent.change(within(sheet).getByLabelText('E-mail'), { target: { value: 'hello@northwind.example' } });
    fireEvent.change(within(sheet).getByLabelText('Tags'), { target: { value: 'retail, Retail, export' } });
    fireEvent.change(within(sheet).getByLabelText('Source'), { target: { value: 'Referral' } });
    fireEvent.change(within(sheet).getByLabelText('Check in every (days)'), { target: { value: '3' } });
    expect(within(sheet).getByText('A check-in is every 7 to 365 days.')).toBeTruthy();
    expect((within(sheet).getByRole('button', { name: 'Add client' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText('Check in every (days)'), { target: { value: '30' } });
    fireEvent.change(within(sheet).getByLabelText('Notes'), { target: { value: 'Met at the expo.' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add client' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/clients')).toHaveLength(1));
    expect(calls(api, 'POST', '/v1/work/clients')[0]?.body).toEqual({
      name: 'Northwind',
      kind: 'company',
      state: 'lead',
      email: 'hello@northwind.example',
      tags: ['retail', 'export'],
      notes: 'Met at the expo.',
      source: 'Referral',
      checkInDays: 30,
    });
  });

  it('the Mac out of reach: "Not saved", and the sheet keeps what he typed', async () => {
    setup({ request: { 'POST /v1/work/clients': new ApiError('network', 'Failed to fetch', 0) } });
    await screen.findByRole('list', { name: 'Clients' });
    fireEvent.click(screen.getByRole('button', { name: 'Add client' }));
    const sheet = await screen.findByRole('dialog', { name: 'New client' });
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Globex' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add client' }));
    expect(await within(sheet).findByText('Not saved. Kept on this phone until you close Jantar.')).toBeTruthy();
    expect((within(sheet).getByLabelText('Name') as HTMLInputElement).value).toBe('Globex');
  });
});

describe('edit a client', () => {
  it('sends only what changed; a kept phone keeps its label; clearing sends null', async () => {
    const { api } = setup({ path: `/work?tab=clients&id=${IDS.pat}`, request: { 'PATCH /v1/work/clients/:id': { ok: true } } });
    await screen.findByRole('heading', { level: 1, name: 'Pat Example' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const sheet = await screen.findByRole('dialog', { name: 'Edit Pat Example' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove phone 2' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add phone' }));
    fireEvent.change(within(sheet).getByLabelText('Phone 2'), { target: { value: '+91 99999 00000' } });
    fireEvent.change(within(sheet).getByLabelText('Source'), { target: { value: '' } });
    fireEvent.change(within(sheet).getByLabelText('Title'), { target: { value: 'Director' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls(api, 'PATCH', '/v1/work/clients/:id')).toHaveLength(1));
    expect(calls(api, 'PATCH', '/v1/work/clients/:id')[0]).toMatchObject({
      params: { id: IDS.pat },
      body: { phones: [{ value: '98765 43210', label: 'Mobile' }, { value: '+91 99999 00000' }], title: 'Director', source: null },
    });
  });

  it('a person moves to another company or to none from his companies', async () => {
    const { api } = setup({ path: `/work?tab=clients&id=${IDS.pat}`, request: { 'PATCH /v1/work/clients/:id': { ok: true } } });
    await screen.findByRole('heading', { level: 1, name: 'Pat Example' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const sheet = await screen.findByRole('dialog', { name: 'Edit Pat Example' });
    const company = within(sheet).getByLabelText('Company') as HTMLSelectElement;
    await waitFor(() => expect([...company.options].map((o) => o.textContent)).toEqual(['None', 'Acme', 'Northwind']));
    fireEvent.change(company, { target: { value: IDS.northwindCo } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls(api, 'PATCH', '/v1/work/clients/:id')[0]?.body).toEqual({ companyId: IDS.northwindCo }));
  });
});
