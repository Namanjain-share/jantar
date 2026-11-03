/**
 * 0.13.0 The Log sheet (design 6.2, W13, W35) against the fake API:
 *
 * - A call with its direction, minutes, how it went, a note, a deal and a
 *   next step (Tomorrow, In 3 days, Next week or a picked day, a time, a
 *   title) is one POST, one save.
 * - A next step needs a day and a title; a note has no direction.
 * - The note and the next step's title are drafts: they survive closing
 *   the sheet, a remount, and a Mac that can't be reached ("Not saved.
 *   Kept on this phone until you close Jantar."); a save clears them.
 * - An entry of his: Edit sends what changed (null clears); Delete goes at
 *   once with Undo, and is sent once the Undo is gone.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api.js';
import { forgetDrafts } from '../../src/lib/drafts.js';
import { fakeApi, preloadPlaces, renderApp, stateWith } from '../helpers.js';
import { IDS, WORK_ON, clientAnswers, clientHub, dealCard, workRequest } from '../work-helpers.js';

preloadPlaces('work', 'clients');

afterEach(() => {
  forgetDrafts();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(request: Record<string, unknown> = {}) {
  const api = fakeApi({ lifeStatus: vi.fn(async () => WORK_ON()), request: workRequest(clientAnswers(request)) });
  return renderApp({ path: `/work?tab=clients&id=${IDS.pat}`, state: stateWith({ features: { life: true } }), api });
}

const calls = (api: { request: unknown }, method: string, path: string) =>
  (api.request as ReturnType<typeof workRequest>).mock.calls.filter(([r]) => r.method === method && r.path === path).map(([, init]) => init);

async function openLog() {
  fireEvent.click(await screen.findByRole('button', { name: 'Log a call or meeting' }));
  return screen.findByRole('dialog', { name: 'Log with Pat Example' });
}

describe('the Log sheet', () => {
  it('a call, how it went, a note, a deal and its next step: one save', async () => {
    const { api } = setup({ 'POST /v1/work/clients/:id/log': { id: '01JWRK10G0000000000000000N', todoId: '01JWRKT0D00000000000000NEW' } });
    const sheet = await openLog();
    expect(within(sheet).getByRole('button', { name: 'Call' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(sheet).getByRole('button', { name: 'In' }));
    fireEvent.change(within(sheet).getByLabelText('Minutes'), { target: { value: '25' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Went well' }));
    fireEvent.change(within(sheet).getByLabelText('Note'), { target: { value: 'Wants a quote by Friday.' } });
    fireEvent.change(within(sheet).getByLabelText('Deal'), { target: { value: IDS.deal } });
    const days = within(sheet).getByRole('group', { name: 'Next step day' });
    expect(within(days).getAllByRole('button').map((b) => b.textContent)).toEqual(['Tomorrow', 'In 3 days', 'Next week', 'Pick']);
    fireEvent.click(within(days).getByRole('button', { name: 'Tomorrow' }));
    fireEvent.change(within(sheet).getByLabelText('Time'), { target: { value: '15:00' } });
    fireEvent.change(within(sheet).getByLabelText('Title'), { target: { value: 'Send the quote' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Log and set next step' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/clients/:id/log')).toHaveLength(1));
    expect(calls(api, 'POST', '/v1/work/clients/:id/log')[0]).toMatchObject({
      params: { id: IDS.pat },
      body: {
        kind: 'call',
        direction: 'in',
        minutes: 25,
        outcome: 'good',
        body: 'Wants a quote by Friday.',
        dealId: IDS.deal,
        next: { title: 'Send the quote', due: { day: '2026-01-16', time: '15:00' }, dealId: IDS.deal },
      },
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Log with Pat Example' })).toBeNull());
    // Saved: the drafts are gone.
    expect((within(await openLog()).getByLabelText('Note') as HTMLTextAreaElement).value).toBe('');
  });

  it("a person's sheet offers its company's open deals too, named with their client, so the next step reaches the deal", async () => {
    const companyDeal = dealCard(IDS.deal2, { title: 'Ops dashboard', client: { id: IDS.client, name: 'Acme' } });
    const won = dealCard(IDS.deal3, { title: 'Brand refresh', kind: 'won' });
    const { api } = setup({
      'GET /v1/work/clients/:id': clientHub({ deals: [dealCard(IDS.deal), companyDeal, won] }),
      'POST /v1/work/clients/:id/log': { id: '01JWRK10G0000000000000000N', todoId: '01JWRKT0D00000000000000NEW' },
    });
    const sheet = await openLog();
    const deal = within(sheet).getByLabelText('Deal') as HTMLSelectElement;
    expect([...deal.options].map((o) => o.textContent)).toEqual(['None', 'Site rebuild', 'Ops dashboard · Acme']);
    fireEvent.change(deal, { target: { value: IDS.deal2 } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Tomorrow' }));
    fireEvent.change(within(sheet).getByLabelText('Title'), { target: { value: 'Send the quote' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Log and set next step' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/clients/:id/log')).toHaveLength(1));
    expect(calls(api, 'POST', '/v1/work/clients/:id/log')[0]).toMatchObject({ params: { id: IDS.pat }, body: { dealId: IDS.deal2, next: { title: 'Send the quote', dealId: IDS.deal2 } } });
  });

  it('Next week is the coming Monday; Pick takes any day; a next step needs a day and a title', async () => {
    const { api } = setup({ 'POST /v1/work/clients/:id/log': { id: '01JWRK10G0000000000000000N' } });
    const sheet = await openLog();
    fireEvent.change(within(sheet).getByLabelText('Title'), { target: { value: 'Send the quote' } });
    expect(within(sheet).getByText('Pick a day for the next step.')).toBeTruthy();
    expect((within(sheet).getByRole('button', { name: 'Log and set next step' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Pick' }));
    fireEvent.change(within(sheet).getByLabelText('Day'), { target: { value: '2026-02-02' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Log and set next step' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/clients/:id/log')[0]?.body).toMatchObject({ next: { title: 'Send the quote', due: { day: '2026-02-02' } } }));
  });

  it('a note has no direction, minutes or outcome; "No answer" is a call’s only', async () => {
    const { api } = setup({ 'POST /v1/work/clients/:id/log': { id: '01JWRK10G0000000000000000N' } });
    const sheet = await openLog();
    expect(within(sheet).getByRole('button', { name: 'No answer' })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Meeting' }));
    expect(within(sheet).queryByRole('button', { name: 'No answer' })).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Note' }));
    expect(within(sheet).queryByRole('group', { name: 'Direction' })).toBeNull();
    expect(within(sheet).queryByLabelText('Minutes')).toBeNull();
    expect(within(sheet).queryByRole('group', { name: 'How it went' })).toBeNull();
    fireEvent.change(within(sheet).getByLabelText('Note'), { target: { value: 'Prefers e-mail.' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Log it' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/clients/:id/log')[0]?.body).toEqual({ kind: 'note', body: 'Prefers e-mail.' }));
  });

  it('the note and the next step are drafts: kept when the sheet closes, after a remount, and when the Mac is out of reach', async () => {
    const a = setup({ 'POST /v1/work/clients/:id/log': new ApiError('network', 'Failed to fetch', 0) });
    let sheet = await openLog();
    fireEvent.change(within(sheet).getByLabelText('Note'), { target: { value: 'Asked for the rates.' } });
    fireEvent.change(within(sheet).getByLabelText('Title'), { target: { value: 'Send the rates' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Tomorrow' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Log and set next step' }));
    expect(await within(sheet).findByText('Not saved. Kept on this phone until you close Jantar.')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Log with Pat Example' })).toBeNull());
    a.unmount();
    setup();
    sheet = await openLog();
    expect((within(sheet).getByLabelText('Note') as HTMLTextAreaElement).value).toBe('Asked for the rates.');
    expect((within(sheet).getByLabelText('Title') as HTMLInputElement).value).toBe('Send the rates');
  });

  it('Edit an entry of his: what changed goes, null clears', async () => {
    const { api } = setup({ 'PATCH /v1/work/log/:id': { ok: true } });
    const log = await screen.findByRole('list', { name: 'Its log' });
    fireEvent.click(within(log).getByRole('button', { name: 'Actions for this call' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const sheet = await screen.findByRole('dialog', { name: 'Edit log entry' });
    expect(within(sheet).queryByRole('group', { name: 'Next step day' })).toBeNull();
    expect((within(sheet).getByLabelText('Note') as HTMLTextAreaElement).value).toBe('Wants a quote by Friday.');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Badly' }));
    fireEvent.change(within(sheet).getByLabelText('Note'), { target: { value: '' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls(api, 'PATCH', '/v1/work/log/:id')).toEqual([expect.objectContaining({ params: { id: IDS.log1 }, body: { outcome: 'bad', body: null } })]));
  });

  it('Delete an entry: gone at once with Undo; Undo puts it back and nothing is sent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = setup({ 'DELETE /v1/work/log/:id': { ok: true } });
    const log = await screen.findByRole('list', { name: 'Its log' });
    fireEvent.click(within(log).getByRole('button', { name: 'Actions for this call' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(document.querySelector(`[data-log="${IDS.log1}"]`)).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(document.querySelector(`[data-log="${IDS.log1}"]`)).not.toBeNull();
    // Again, and let the Undo go.
    fireEvent.click(within(screen.getByRole('list', { name: 'Its log' })).getByRole('button', { name: 'Actions for this call' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(calls(api, 'DELETE', '/v1/work/log/:id')).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(5_100);
    });
    await waitFor(() => expect(calls(api, 'DELETE', '/v1/work/log/:id')).toEqual([expect.objectContaining({ params: { id: IDS.log1 } })]));
  });
});
