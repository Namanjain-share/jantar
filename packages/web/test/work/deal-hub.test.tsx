/**
 * 0.13.0 A deal's page (design 6.2, 4.5, W21, W33) and the deal sheet,
 * against the fake API with made-up deals:
 *
 * - One read: its client (a link), stage and days in it, value, source and
 *   close day; Move to…, Won and Lost; its next step; Log a call or
 *   meeting; its follow-ups, its project and its log with the stages'
 *   names. Words someone else wrote are marked.
 * - A lost deal says why and can be told another reason; a closed deal is
 *   reopened through Reopen…; a deal with no follow-up says "No next step".
 * - Edit sends only what changed; Delete is a Confirm that says what goes
 *   and what stays, with no Undo.
 * - With a keyboard: m moves, l logs, n sets a next step, e edits.
 * - New deal: one of his clients, or a new one by its name; the value in
 *   hundredths in its currency.
 * - A deal that is gone says the daemon's sentence; offline turns writes off.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiRequest } from '../../src/lib/api.js';
import { layoutAt } from '../../src/ui/shell/layout.js';
import { fakeApi, preloadPlaces, renderApp, stateWith } from '../helpers.js';
import { IDS, WORK_ON, deal, dealAnswers, dealCard, dealHub, workRequest } from '../work-helpers.js';

preloadPlaces('work', 'deals');

afterEach(() => vi.restoreAllMocks());

const PATH = `/work?tab=deals&id=${IDS.deal}`;

function setup(o: { request?: Record<string, unknown>; path?: string; status?: 'live' | 'offline'; layout?: ReturnType<typeof layoutAt>; over?: Parameters<typeof fakeApi>[0] } = {}) {
  const api = fakeApi({
    lifeStatus: vi.fn(async () => WORK_ON()),
    projectsList: vi.fn(async () => ({ projects: [] })),
    todoDone: vi.fn(async () => ({ ok: true as const })),
    request: workRequest(dealAnswers(o.request)),
    ...o.over,
  });
  return { ...renderApp({ path: o.path ?? PATH, state: stateWith({ features: { life: true } }), api, ...(o.status ? { status: o.status } : {}), ...(o.layout ? { layout: o.layout } : {}) }), api };
}

const calls = (api: { request: unknown }, method: string, path: string) =>
  (api.request as ReturnType<typeof workRequest>).mock.calls.filter(([r]) => r.method === method && r.path === path).map(([, init]) => init as ApiRequest);

/** A lost deal: Price, with a note. */
const LOST = () =>
  dealHub({
    deal: deal(IDS.deal, { stage: 'lost', lostAt: '2026-01-12T10:00:00.000Z', lostCode: 'price', lostNote: 'Went with a cheaper quote.' }),
    card: dealCard(IDS.deal, { client: { id: IDS.client, name: 'Acme' }, stage: 'lost', stageName: 'Lost', kind: 'lost', lostAt: '2026-01-12T10:00:00.000Z', lostCode: 'price', daysInStage: 3 }),
    followUps: [],
  });

describe("a deal's page", () => {
  it('from one read: client, stage and days in it, value, source and close day; next step; follow-ups, project and log', async () => {
    setup();
    expect(await screen.findByRole('heading', { level: 1, name: 'Site rebuild' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Deals' }).getAttribute('href')).toBe('/work?tab=deals');
    expect(screen.getByRole('link', { name: 'Acme' }).getAttribute('href')).toBe(`/work?tab=clients&id=${IDS.client}`);
    expect((document.querySelector('[data-stage]') as HTMLElement).textContent).toBe('Proposal sent');
    expect(screen.getByText('12 days in stage')).toBeTruthy();
    expect(screen.getByText(/₹4,50,000/).closest('p')!.textContent).toMatch(/₹4,50,000·Referral·closes 30 Jan/);
    expect(screen.getByRole('button', { name: 'Move to…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Won' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Lost' })).toBeTruthy();
    const next = document.querySelector('[data-next]') as HTMLElement;
    expect(next.textContent).toMatch(/Call about scope · Tomorrow 15:00/);
    expect(screen.getByRole('button', { name: 'Log a call or meeting' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Follow-ups' })).getByRole('button', { name: 'Mark done: Call about scope' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Project' })).getByRole('link', { name: /Site rebuild/ }).getAttribute('href')).toBe(`/work?id=${IDS.acme}`);
    const log = within(screen.getByRole('list', { name: 'Its log' })).getAllByRole('listitem');
    // A stage move by the stages' names, not their ids.
    expect(log[0]!.textContent).toBe('Stage · Contacted → Proposal sent · 3 Jan');
    expect(log[1]!.textContent).toMatch(/Call · out · 20m · 2 Jan/);
    expect(log[1]!.textContent).toMatch(/Sent the proposal over\./);
  });

  it('Move to… from the page moves it; Won asks first', async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Move to…' }));
    fireEvent.click(within(await screen.findByRole('radiogroup', { name: 'Stages' })).getByRole('radio', { name: 'Negotiation' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/deals/:id/move')).toHaveLength(1));
    expect(calls(api, 'POST', '/v1/work/deals/:id/move')[0]!.body).toEqual({ stage: 'negotiation' });
    fireEvent.click(screen.getByRole('button', { name: 'Won' }));
    expect(await screen.findByRole('dialog', { name: 'Won · ₹4,50,000' })).toBeTruthy();
    expect(calls(api, 'POST', '/v1/work/deals/:id/move')).toHaveLength(1);
  });

  it('a lost deal says why and takes another reason; Reopen… moves it to an open stage', async () => {
    const { api } = setup({ request: { 'GET /v1/work/deals/:id': LOST(), 'PATCH /v1/work/deals/:id': { ok: true }, 'POST /v1/work/deals/:id/move': { id: IDS.deal, from: 'lost' } } });
    const lost = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-lost]');
      if (!el) throw new Error('not yet');
      return el;
    });
    expect(lost.textContent).toMatch(/Price · Went with a cheaper quote\./);
    expect(screen.getByText('lost 12 Jan')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Won' })).toBeNull();
    fireEvent.click(within(lost).getByRole('button', { name: 'Change reason' }));
    const sheet = await screen.findByRole('dialog', { name: 'Why it was lost' });
    expect(within(sheet).getByRole('button', { name: 'Price' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(sheet).queryByRole('button', { name: 'Skip' })).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Went quiet' }));
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Note' }), { target: { value: '' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls(api, 'PATCH', '/v1/work/deals/:id')).toHaveLength(1));
    expect(calls(api, 'PATCH', '/v1/work/deals/:id')[0]!.body).toEqual({ lostCode: 'no_response', lostNote: null });
    expect(calls(api, 'POST', '/v1/work/deals/:id/move')).toHaveLength(0);
    // Reopen: back to an open stage.
    fireEvent.click(screen.getByRole('button', { name: 'Reopen…' }));
    const stages = await screen.findByRole('radiogroup', { name: 'Stages' });
    expect(within(stages).getByRole('radio', { name: 'Lost' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(stages).getByRole('radio', { name: 'Contacted' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/deals/:id/move')).toHaveLength(1));
    expect(calls(api, 'POST', '/v1/work/deals/:id/move')[0]!.body).toEqual({ stage: 'contacted' });
  });

  it("no follow-up: \"No next step\", with its client's own next step named", async () => {
    setup({ request: { 'GET /v1/work/deals/:id': dealHub({ followUps: [], card: { ...dealHub().card, next: { todoId: IDS.todo1, title: 'Call Acme back' } } }) } });
    const next = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-next]');
      if (!el) throw new Error('not yet');
      return el;
    });
    expect(next.textContent).toBe('No next step. Its client’s: Call Acme back.');
    expect(screen.getByText('No follow-up. Add a next step so it isn’t forgotten.')).toBeTruthy();
  });

  it('imported words are marked', async () => {
    setup({ request: { 'GET /v1/work/deals/:id': dealHub({ deal: deal(IDS.deal, { from: 'import' }), client: { id: IDS.client, name: 'Acme', state: 'lead', from: 'import' } }) } });
    await screen.findByRole('heading', { level: 1, name: 'Site rebuild' });
    expect(document.querySelectorAll('[data-from="import"]').length).toBe(2);
  });

  it('Edit sends only what changed (null clears)', async () => {
    const { api } = setup({ request: { 'PATCH /v1/work/deals/:id': { ok: true } } });
    await screen.findByRole('heading', { level: 1, name: 'Site rebuild' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const sheet = await screen.findByRole('dialog', { name: 'Edit Site rebuild' });
    expect((within(sheet).getByRole('textbox', { name: 'Value' }) as HTMLInputElement).value).toBe('450000');
    expect((within(sheet).getByRole('textbox', { name: 'Currency' }) as HTMLInputElement).value).toBe('INR');
    // The stage changes only by a move.
    expect(within(sheet).queryByRole('combobox', { name: 'Stage' })).toBeNull();
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Value' }), { target: { value: '5,00,000' } });
    fireEvent.change(within(sheet).getByLabelText('Closes'), { target: { value: '' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls(api, 'PATCH', '/v1/work/deals/:id')).toHaveLength(1));
    expect(calls(api, 'PATCH', '/v1/work/deals/:id')[0]).toMatchObject({ params: { id: IDS.deal }, body: { value: 50_000_000, expectedClose: null } });
    expect(Object.keys(calls(api, 'PATCH', '/v1/work/deals/:id')[0]!.body as object).sort()).toEqual(['expectedClose', 'value']);
  });

  it('a value that is not one keeps Save off with a sentence', async () => {
    setup();
    await screen.findByRole('heading', { level: 1, name: 'Site rebuild' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const sheet = await screen.findByRole('dialog', { name: 'Edit Site rebuild' });
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Value' }), { target: { value: 'lots' } });
    expect(within(sheet).getByText(/Type the value as digits/)).toBeTruthy();
    expect((within(sheet).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Value' }), { target: { value: '100' } });
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Currency' }), { target: { value: 'RU' } });
    expect(within(sheet).getByText(/three letters/)).toBeTruthy();
    expect((within(sheet).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Delete says what goes and what stays, then deletes with no Undo and goes back to the list', async () => {
    const { api, history, toasts } = setup({ request: { 'DELETE /v1/work/deals/:id': { ok: true, removed: { log: 1 } } } });
    await screen.findByRole('heading', { level: 1, name: 'Site rebuild' });
    fireEvent.click(screen.getByRole('button', { name: 'More for Site rebuild' }));
    expect((await screen.findAllByRole('menuitem')).map((m) => m.textContent)).toEqual(['Move to…', 'Mark won', 'Mark lost', 'Delete']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const sheet = await screen.findByRole('dialog', { name: 'Delete Site rebuild?' });
    expect(within(sheet).getByText('Deletes the deal and its stage moves.')).toBeTruthy();
    expect(within(sheet).getByText(/stays with Acme, and its follow-ups stay, with no deal\./)).toBeTruthy();
    expect(within(sheet).getByText('There is no Undo.')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls(api, 'DELETE', '/v1/work/deals/:id')).toHaveLength(1));
    await waitFor(() => expect(history.entries.at(-1)).toBe('/work?tab=deals'));
    expect(toasts.getState().toasts.map((t) => t.text)).toContain('Deleted Site rebuild.');
  });

  it('with a keyboard: m moves, e edits, n sets a next step, l logs', async () => {
    setup({ layout: layoutAt(1440) });
    await screen.findByRole('heading', { level: 1, name: 'Site rebuild' });
    fireEvent.keyDown(window, { key: 'm' });
    expect(await screen.findByRole('radiogroup', { name: 'Stages' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('radiogroup', { name: 'Stages' })).toBeNull());
    fireEvent.keyDown(window, { key: 'e' });
    expect(await screen.findByRole('dialog', { name: 'Edit Site rebuild' })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Edit Site rebuild' })).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.keyDown(window, { key: 'n' });
    expect(await screen.findByRole('dialog', { name: 'Next step' })).toBeTruthy();
  });

  it('a deal that is gone says so; offline turns its writes off', async () => {
    const gone = setup({ request: { 'GET /v1/work/deals/:id': new ApiError('not_found', 'That deal is not here any more.', 404) } });
    expect(await screen.findByText('That deal is not here any more.')).toBeTruthy();
    gone.unmount();
    setup({ status: 'offline' });
    await screen.findByRole('heading', { level: 1, name: 'Site rebuild' });
    for (const name of ['Move to…', 'Won', 'Lost', 'Edit', 'Log a call or meeting']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled, name).toBe(true);
  });
});

describe('the deal sheet', () => {
  it('New deal with a client of his: its id, an open stage, the value in hundredths; then the deal opens', async () => {
    const { api, history } = setup({ path: '/work?tab=deals&stage=proposal', request: { 'POST /v1/work/deals': { id: IDS.deal2, clientId: IDS.client } } });
    await screen.findByRole('list', { name: 'Proposal sent' });
    fireEvent.click(screen.getByRole('button', { name: 'New deal' }));
    const sheet = await screen.findByRole('dialog', { name: 'New deal' });
    // Won and Lost are moves, never where a deal starts.
    expect([...(within(sheet).getByRole('combobox', { name: 'Stage' }) as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['New lead', 'Contacted', 'Proposal sent', 'Negotiation']);
    expect((within(sheet).getByRole('textbox', { name: 'Currency' }) as HTMLInputElement).value).toBe('INR');
    expect((within(sheet).getByRole('button', { name: 'Add deal' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Title' }), { target: { value: 'Shop app' } });
    fireEvent.change(within(sheet).getByRole('combobox', { name: 'Client' }), { target: { value: 'acme' } });
    fireEvent.change(within(sheet).getByRole('combobox', { name: 'Stage' }), { target: { value: 'contacted' } });
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Value' }), { target: { value: '1,20,000.50' } });
    fireEvent.change(within(sheet).getByLabelText('Closes'), { target: { value: '2026-02-28' } });
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Source' }), { target: { value: 'Referral' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add deal' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/deals')).toHaveLength(1));
    expect(calls(api, 'POST', '/v1/work/deals')[0]!.body).toEqual({ clientId: IDS.client, title: 'Shop app', stage: 'contacted', value: 12_000_050, currency: 'INR', expectedClose: '2026-02-28', source: 'Referral' });
    await waitFor(() => expect(history.entries.at(-1)).toBe(`/work?tab=deals&id=${IDS.deal2}`));
  });

  it('a client by a name that is not his: made as a company, a lead, in the same save', async () => {
    const { api } = setup({ path: '/work?tab=deals&stage=proposal', request: { 'POST /v1/work/deals': { id: IDS.deal2, clientId: IDS.globexCo } } });
    await screen.findByRole('list', { name: 'Proposal sent' });
    fireEvent.click(screen.getByRole('button', { name: 'New deal' }));
    const sheet = await screen.findByRole('dialog', { name: 'New deal' });
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Title' }), { target: { value: 'Brand refresh' } });
    fireEvent.change(within(sheet).getByRole('combobox', { name: 'Client' }), { target: { value: 'Globex' } });
    expect(await within(sheet).findByText('New client: Globex (a company, a lead)')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add deal' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/deals')).toHaveLength(1));
    expect(calls(api, 'POST', '/v1/work/deals')[0]!.body).toEqual({ clientName: 'Globex', title: 'Brand refresh', stage: 'new', currency: 'INR' });
  });

  it('the Mac unreachable: "Not saved", the sheet stays', async () => {
    setup({ path: '/work?tab=deals&stage=proposal', request: { 'POST /v1/work/deals': new ApiError('network', 'offline', 0) } });
    await screen.findByRole('list', { name: 'Proposal sent' });
    fireEvent.click(screen.getByRole('button', { name: 'New deal' }));
    const sheet = await screen.findByRole('dialog', { name: 'New deal' });
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Title' }), { target: { value: 'Shop app' } });
    fireEvent.change(within(sheet).getByRole('combobox', { name: 'Client' }), { target: { value: 'Acme' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add deal' }));
    expect(await within(sheet).findByText('Not saved. Kept on this phone until you close Jantar.')).toBeTruthy();
    expect((within(sheet).getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('Shop app');
  });
});
