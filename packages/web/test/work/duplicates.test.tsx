/**
 * 0.13.0 Duplicates and merging (design 5.3, P3b) against the fake API:
 *
 * - Find duplicates: each group says why (the same e-mail, phone or name);
 *   he picks the one to keep; for each other one, Not a duplicate, or
 *   Merge into it: the fields they hold differently, his picks of the
 *   other's, then one merge.
 * - Merge with… from a client's page: find the other among his clients of
 *   the same kind, then the same merge step. An imported one's mark comes
 *   along, and the sheet says so.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkDuplicatesReply } from '@jantar/protocol/work';
import { fakeApi, preloadPlaces, renderApp, stateWith } from '../helpers.js';
import { CLIENTS, IDS, WORK_ON, clientAnswers, clientRow, workRequest } from '../work-helpers.js';

preloadPlaces('work', 'clients');

afterEach(() => vi.restoreAllMocks());

const GROUPS: WorkDuplicatesReply = {
  groups: [
    {
      key: '01JWRKGR0VP000000000000001',
      reasons: ['email', 'name'],
      clients: [
        { id: IDS.client, name: 'Acme', kind: 'company', state: 'client' },
        { id: IDS.northwindCo, name: 'Acme Ltd', kind: 'company', state: 'lead', from: 'import' },
      ],
    },
  ],
};

function setup(o: { path?: string; request?: Record<string, unknown> } = {}) {
  const api = fakeApi({
    lifeStatus: vi.fn(async () => WORK_ON()),
    request: workRequest(
      clientAnswers({
        'GET /v1/work/duplicates': GROUPS,
        'GET /v1/work/clients/:id/merge': { conflicts: [{ field: 'name', label: 'Name', survivor: 'Acme', loser: 'Acme Ltd' }, { field: 'city', label: 'City', survivor: '', loser: 'Pune' }] },
        'POST /v1/work/clients/:id/merge': { ok: true },
        'POST /v1/work/clients/:id/not-duplicate': { ok: true },
        ...o.request,
      }),
    ),
  });
  return renderApp({ path: o.path ?? '/work?tab=clients', state: stateWith({ features: { life: true } }), api });
}

const calls = (api: { request: unknown }, method: string, path: string) =>
  (api.request as ReturnType<typeof workRequest>).mock.calls.filter(([r]) => r.method === method && r.path === path).map(([, init]) => init);

async function openDuplicates() {
  await screen.findByRole('list', { name: 'Clients' });
  fireEvent.click(screen.getByRole('button', { name: 'More for clients' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Find duplicates' }));
  return screen.findByRole('dialog', { name: 'Possible duplicates' });
}

describe('find duplicates', () => {
  it('a group says why; Not a duplicate rules the pair apart', async () => {
    const { api } = setup();
    const sheet = await openDuplicates();
    await within(sheet).findByRole('list', { name: 'Possible duplicates' });
    const group = sheet.querySelector('[data-group]') as HTMLElement;
    expect(group.textContent).toMatch(/same e-mail · same name/);
    expect(within(group).getByRole('button', { name: 'Keep Acme' }).getAttribute('aria-pressed')).toBe('true');
    expect(group.querySelector('[data-from="import"]')).not.toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: 'Not a duplicate' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/clients/:id/not-duplicate')).toEqual([expect.objectContaining({ params: { id: IDS.client }, body: { otherId: IDS.northwindCo } })]));
  });

  it('Merge into the one kept: the fields that differ, his picks, one merge', async () => {
    const { api, toasts } = setup();
    const sheet = await openDuplicates();
    await within(sheet).findByRole('list', { name: 'Possible duplicates' });
    const group = sheet.querySelector('[data-group]') as HTMLElement;
    // Keep the other one: the merge goes the other way.
    fireEvent.click(within(group).getByRole('button', { name: 'Keep Acme Ltd' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Merge into Acme Ltd' }));
    const step = await screen.findByRole('dialog', { name: 'Merge into Acme Ltd' });
    expect(step.textContent).toMatch(/Acme's deals, log, follow-ups, projects and people move to Acme Ltd/);
    await within(step).findByRole('list', { name: 'Fields that differ' });
    expect(calls(api, 'GET', '/v1/work/clients/:id/merge')[0]).toMatchObject({ params: { id: IDS.northwindCo }, query: { loser: IDS.client } });
    const name = within(step).getByRole('group', { name: 'Name' });
    fireEvent.click(within(name).getByRole('button', { name: 'Acme Ltd' }));
    fireEvent.click(within(name).getByRole('button', { name: 'Acme' }));
    fireEvent.click(within(within(step).getByRole('group', { name: 'City' })).getByRole('button', { name: 'Pune' }));
    fireEvent.click(within(step).getByRole('button', { name: 'Merge' }));
    // Name went back to this one's; City takes the other's.
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/clients/:id/merge')).toEqual([expect.objectContaining({ params: { id: IDS.northwindCo }, body: { loserId: IDS.client, picks: ['city'] } })]));
    expect(toasts.getState().toasts.map((t) => t.text)).toContain('Merged Acme into Acme Ltd.');
  });

  it('none: one line', async () => {
    setup({ request: { 'GET /v1/work/duplicates': { groups: [] } } });
    const sheet = await openDuplicates();
    expect(await within(sheet).findByText('No possible duplicates.')).toBeTruthy();
  });
});

describe('merge with… from a client', () => {
  it('finds the other among his clients of the same kind; an imported one passes its mark on', async () => {
    const { api } = setup({
      path: `/work?tab=clients&id=${IDS.pat}`,
      request: {
        'GET /v1/work/clients': (init: { query?: Record<string, unknown> }) =>
          init.query?.q === 'sam' ? CLIENTS([clientRow(IDS.sam, { name: 'Sam Sample', kind: 'person', from: 'import' }), clientRow(IDS.pat, { name: 'Pat Example', kind: 'person' })]) : CLIENTS(),
        'GET /v1/work/clients/:id/merge': { conflicts: [] },
      },
    });
    await screen.findByRole('heading', { level: 1, name: 'Pat Example' });
    fireEvent.click(screen.getByRole('button', { name: 'More for Pat Example' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Merge with…' }));
    const sheet = await screen.findByRole('dialog', { name: 'Merge into Pat Example' });
    fireEvent.change(within(sheet).getByRole('searchbox', { name: 'Find a client' }), { target: { value: 'sam' } });
    const list = await within(sheet).findByRole('list', { name: 'Clients to merge' });
    // Never itself.
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual([expect.stringMatching(/^Sam Sample/)]);
    expect(calls(api, 'GET', '/v1/work/clients').some((i) => i?.query?.q === 'sam' && i.query.kind === 'person')).toBe(true);
    fireEvent.click(within(list).getByRole('button', { name: /Sam Sample/ }));
    expect(await within(sheet).findByText('Pat Example takes this mark too: its words stay data.')).toBeTruthy();
    expect(await within(sheet).findByText(/No field differs/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/clients/:id/merge')).toEqual([expect.objectContaining({ params: { id: IDS.pat }, body: { loserId: IDS.sam } })]));
  });
});
