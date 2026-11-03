/**
 * 0.13.0 Work's stage editor (design 5.3, W10), from Deals' ···, against
 * the fake API with the six default stages:
 *
 * - Every stage in order, each renamed in place and moved with ↑ and ↓
 *   (never a drag); an open one can be removed, Won and Lost never.
 * - Add a stage puts a new open one before Won; probability and quiet
 *   days are its own or empty for the ramp and Work's days.
 * - A removed stage that holds deals asks where they go; Save sends the
 *   whole list with the moves (PUT /v1/work/stages) and says how many
 *   deals moved.
 * - What the Mac would refuse keeps Save off with one sentence; offline
 *   keeps it off.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiRequest } from '../../src/lib/api.js';
import { fakeApi, preloadPlaces, renderApp, stateWith } from '../helpers.js';
import { WORK_ON, dealAnswers, workRequest } from '../work-helpers.js';

preloadPlaces('work', 'deals');

afterEach(() => vi.restoreAllMocks());

function setup(o: { request?: Record<string, unknown>; status?: 'live' | 'offline' } = {}) {
  const api = fakeApi({
    lifeStatus: vi.fn(async () => WORK_ON()),
    request: workRequest(dealAnswers({ 'PUT /v1/work/stages': { ok: true, moved: 0 }, ...o.request })),
  });
  return { ...renderApp({ path: '/work?tab=deals&stage=proposal', state: stateWith({ features: { life: true } }), api, ...(o.status ? { status: o.status } : {}) }), api };
}

const puts = (api: { request: unknown }) =>
  (api.request as ReturnType<typeof workRequest>).mock.calls.filter(([r]) => r.method === 'PUT' && r.path === '/v1/work/stages').map(([, init]) => (init as ApiRequest).body);

async function openStages() {
  await screen.findByRole('list', { name: 'Proposal sent' });
  fireEvent.click(screen.getByRole('button', { name: 'More for deals' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit stages' }));
  const sheet = await screen.findByRole('dialog', { name: 'Stages' });
  await within(sheet).findByRole('list', { name: 'The stages, in order' });
  return sheet;
}

const names = (sheet: HTMLElement) => within(within(sheet).getByRole('list', { name: 'The stages, in order' })).getAllByRole('textbox', { name: /^Stage \d+$/ }).map((i) => (i as HTMLInputElement).value);

describe("Work's stages", () => {
  it('every stage in order; an open one can be removed, Won and Lost never; each moves with ↑ and ↓', async () => {
    setup();
    const sheet = await openStages();
    expect(names(sheet)).toEqual(['New lead', 'Contacted', 'Proposal sent', 'Negotiation', 'Won', 'Lost']);
    expect(within(sheet).getByRole('button', { name: 'Remove Contacted' })).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: 'Remove Won' })).toBeNull();
    expect(within(sheet).queryByRole('button', { name: 'Remove Lost' })).toBeNull();
    // The first can't go up, the last can't go down.
    expect((within(sheet).getByRole('button', { name: 'Move New lead up' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(sheet).getByRole('button', { name: 'Move Lost down' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Move Contacted up' }));
    expect(names(sheet)).toEqual(['Contacted', 'New lead', 'Proposal sent', 'Negotiation', 'Won', 'Lost']);
    // Its own probability shows (Proposal sent's 60); the others show the ramp as a hint, and Work's quiet days.
    const p = within(sheet).getAllByRole('textbox', { name: 'Probability %' }) as HTMLInputElement[];
    expect(p.map((i) => i.value)).toEqual(['', '', '60', '']);
    expect(p.map((i) => i.placeholder)).toEqual(['40', '20', '60', '80']);
    expect((within(sheet).getAllByRole('textbox', { name: 'Quiet after (days)' })[0] as HTMLInputElement).placeholder).toBe('14');
    // A stage's two fields leave a 390 phone's sheet (358 inside) room for "12 deals" (8 mono characters, 7.2 each)
    // on their line: Proposal sent's "2 deals" no longer wraps under them while the others' count sits beside.
    const fields = p[0]!.closest('li')!.querySelector('div.mt-6')!;
    const widths = [...fields.children].slice(0, 2).map((f) => Number(/\bw-(\d+)\b/.exec((f as HTMLElement).className)?.[1]));
    expect(widths.every((w) => w > 0)).toBe(true);
    expect(widths[0]! + widths[1]! + 2 * 12 + 8 * 7.2).toBeLessThanOrEqual(358);
  });

  it('rename, reorder and add (before Won): Save sends the whole list, kept stages by id, a new one without', async () => {
    const { api } = setup();
    const sheet = await openStages();
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Stage 2' }), { target: { value: 'Called' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Move Negotiation up' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add a stage' }));
    expect(names(sheet)).toEqual(['New lead', 'Called', 'Negotiation', 'Proposal sent', '', 'Won', 'Lost']);
    // A new stage needs its name before Save.
    expect(within(sheet).getByText('Every stage needs a name of up to 30 characters.')).toBeTruthy();
    expect((within(sheet).getByRole('button', { name: 'Save stages' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Stage 5' }), { target: { value: 'Pilot' } });
    const probability = within(sheet).getAllByRole('textbox', { name: 'Probability %' });
    fireEvent.change(probability[4]!, { target: { value: '90' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save stages' }));
    await waitFor(() => expect(puts(api)).toHaveLength(1));
    expect(puts(api)[0]).toEqual({
      stages: [
        { id: 'new', name: 'New lead', probability: null, quietDays: null },
        { id: 'contacted', name: 'Called', probability: null, quietDays: null },
        { id: 'negotiation', name: 'Negotiation', probability: null, quietDays: null },
        { id: 'proposal', name: 'Proposal sent', probability: 60, quietDays: null },
        { name: 'Pilot', probability: 90, quietDays: null },
        { id: 'won', name: 'Won' },
        { id: 'lost', name: 'Lost' },
      ],
    });
    expect(await screen.findByText('Stages saved.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Stages' })).toBeNull());
  });

  it('a removed stage with deals asks where they go, and the toast says how many moved', async () => {
    const { api } = setup({ request: { 'PUT /v1/work/stages': { ok: true, moved: 2 } } });
    const sheet = await openStages();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove Contacted' }));
    // Contacted holds none: nothing to ask.
    expect(within(sheet).queryByRole('group', { name: 'Removed' })).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove Proposal sent' }));
    const removed = within(sheet).getByRole('group', { name: 'Removed' });
    const to = within(removed).getByRole('combobox', { name: 'Proposal sent · 2 deals: move them to' }) as HTMLSelectElement;
    // Only an open stage kept from before can take them.
    expect([...to.options].map((o) => o.textContent)).toEqual(['New lead', 'Negotiation']);
    fireEvent.change(to, { target: { value: 'negotiation' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save stages' }));
    await waitFor(() => expect(puts(api)).toHaveLength(1));
    expect(puts(api)[0]).toMatchObject({
      stages: [{ id: 'new' }, { id: 'negotiation' }, { id: 'won' }, { id: 'lost' }],
      moves: [{ from: 'proposal', to: 'negotiation' }],
    });
    expect(await screen.findByText('Stages saved. 2 deals moved.')).toBeTruthy();
  });

  it('what the Mac would refuse keeps Save off with one sentence', async () => {
    setup();
    const sheet = await openStages();
    const save = () => within(sheet).getByRole('button', { name: 'Save stages' }) as HTMLButtonElement;
    fireEvent.change(within(sheet).getAllByRole('textbox', { name: 'Probability %' })[0]!, { target: { value: '101' } });
    expect(within(sheet).getByText('A probability is a whole number from 0 to 100.')).toBeTruthy();
    expect(save().disabled).toBe(true);
    fireEvent.change(within(sheet).getAllByRole('textbox', { name: 'Probability %' })[0]!, { target: { value: '' } });
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Stage 1' }), { target: { value: 'won' } });
    expect(within(sheet).getByText('Two stages have the same name.')).toBeTruthy();
    expect(save().disabled).toBe(true);
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Stage 1' }), { target: { value: 'New lead' } });
    for (const n of ['New lead', 'Contacted', 'Proposal sent']) fireEvent.click(within(sheet).getByRole('button', { name: `Remove ${n}` }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove Negotiation' }));
    expect(within(sheet).getByText('Keep at least three stages.')).toBeTruthy();
    expect(save().disabled).toBe(true);
  });

  it('twelve stages at most: Add a stage goes once there are twelve', async () => {
    setup();
    const sheet = await openStages();
    for (let i = 0; i < 6; i++) fireEvent.click(within(sheet).getByRole('button', { name: 'Add a stage' }));
    expect(names(sheet)).toHaveLength(12);
    expect(within(sheet).queryByRole('button', { name: 'Add a stage' })).toBeNull();
  });

  it('offline: Save stays off', async () => {
    setup({ status: 'offline' });
    await screen.findByRole('list', { name: 'Proposal sent' });
    fireEvent.click(screen.getByRole('button', { name: 'More for deals' }));
    // Its menu item is off too: no change can reach the Mac.
    const item = await screen.findByRole('menuitem', { name: 'Edit stages' });
    expect(item.getAttribute('aria-disabled') ?? (item as HTMLButtonElement).disabled?.toString()).toMatch(/true/);
  });
});
