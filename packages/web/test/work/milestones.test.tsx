/**
 * 0.13.0 A project's milestones (design 4.1, 14.3) on its page, against
 * the fake API with a made-up project:
 *
 * - While Work is on, the page lists them: each ticked done in one tap
 *   (the whole list goes, that one changed), its target day, ember once
 *   missed. None yet: one line and Add.
 * - Edit (a sheet loaded on first use): name, target day, done, ↑ and ↓,
 *   remove, Add a milestone up to twelve; Save sends the list in order, a
 *   kept one by its id. A blank name keeps Save off with one sentence.
 * - Without Work's part of the hub (Work off at the Mac, a shared list),
 *   no Milestones; offline, the ticks are off.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkMilestonesView } from '@jantar/protocol/work';
import type { ApiRequest } from '../../src/lib/api.js';
import { milestonesPlan } from '../../src/ui/screens/work/MilestonesSheet.js';
import { milestonesWith } from '../../src/ui/screens/work/model.js';
import { fakeApi, preloadPlaces, renderApp, stateWith } from '../helpers.js';
import { IDS, WORK_ON, hub, workRequest } from '../work-helpers.js';

preloadPlaces('work', 'milestones');

afterEach(() => vi.restoreAllMocks());

const PATH = `/work?id=${IDS.acme}`;

/** Design (done), Beta (its day passed: missed), Launch (no day). */
const MS = (): WorkMilestonesView => ({
  items: [
    { id: IDS.ms1, name: 'Design', target: '2026-01-05', done: true },
    { id: IDS.ms2, name: 'Beta', target: '2026-01-10' },
    { id: '01JWRKM11E5T0NE00000000003', name: 'Launch' },
  ],
  done: 1,
  percent: 33,
  missed: [IDS.ms2],
  next: IDS.ms2,
});

function setup(o: { hub?: ReturnType<typeof hub>; status?: 'live' | 'offline' } = {}) {
  const api = fakeApi({
    lifeStatus: vi.fn(async () => WORK_ON()),
    projectsList: vi.fn(async () => ({ projects: [] })),
    todosList: vi.fn(async () => ({ todos: [], today: '2026-01-15' })),
    request: workRequest({
      'GET /v1/projects/:id': o.hub ?? hub({ log: [], milestones: MS() }),
      'GET /v1/work/clients/names': { clients: [] },
      'PUT /v1/work/projects/:id/milestones': { ok: true },
    }),
  });
  return { ...renderApp({ path: PATH, state: stateWith({ features: { life: true } }), api, ...(o.status ? { status: o.status } : {}) }), api };
}

const puts = (api: { request: unknown }) =>
  (api.request as ReturnType<typeof workRequest>).mock.calls.filter(([r]) => r.method === 'PUT' && r.path === '/v1/work/projects/:id/milestones').map(([, init]) => init as ApiRequest);

describe('the pure half', () => {
  it('a tick sends the whole list, that one changed', () => {
    expect(milestonesWith(MS().items, IDS.ms2, true)).toEqual({
      milestones: [
        { id: IDS.ms1, name: 'Design', target: '2026-01-05', done: true },
        { id: IDS.ms2, name: 'Beta', target: '2026-01-10', done: true },
        { id: '01JWRKM11E5T0NE00000000003', name: 'Launch' },
      ],
    });
    expect(milestonesWith(MS().items, IDS.ms1, false).milestones[0]).toEqual({ id: IDS.ms1, name: 'Design', target: '2026-01-05' });
  });

  it('the editor sends names trimmed, a day only when set, done only when ticked; a blank name or thirteen are refused', () => {
    expect(milestonesPlan([{ id: IDS.ms1, name: ' Design ', target: '', done: false }, { name: 'Beta', target: '2026-02-01', done: true }])).toEqual({
      ok: true,
      body: { milestones: [{ id: IDS.ms1, name: 'Design' }, { name: 'Beta', target: '2026-02-01', done: true }] },
    });
    expect(milestonesPlan([])).toEqual({ ok: true, body: { milestones: [] } });
    expect(milestonesPlan([{ name: '  ', target: '', done: false }])).toEqual({ ok: false, problem: 'Every milestone needs a name of up to 60 characters.' });
    expect(milestonesPlan(Array.from({ length: 13 }, (_, i) => ({ name: `M${i}`, target: '', done: false }))).ok).toBe(false);
  });
});

describe("a project's milestones", () => {
  it('lists them: done ones struck through, a missed day in ember; a tick sends the list with it done', async () => {
    const { api } = setup();
    const list = await screen.findByRole('list', { name: 'Its milestones' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['Design5 Jan', 'Betamissed 10 Jan', 'Launch']);
    expect(within(rows[1]!).getByText(/missed/).className).toContain('text-signal-text');
    expect((within(rows[0]!).getByRole('checkbox', { name: /^Design/ }) as HTMLInputElement).checked).toBe(true);
    // The summary under the title still says the progress.
    expect((document.querySelector('[data-milestones]') as HTMLElement).textContent).toMatch(/1 of 3 · 33%next: Beta · 10 Jan/);
    fireEvent.click(within(rows[1]!).getByRole('checkbox', { name: /^Beta/ }));
    await waitFor(() => expect(puts(api)).toHaveLength(1));
    expect(puts(api)[0]).toMatchObject({ params: { id: IDS.acme } });
    expect((puts(api)[0]!.body as { milestones: { id: string; done?: boolean }[] }).milestones.map((m) => m.done ?? false)).toEqual([true, true, false]);
  });

  it('none yet: one line and Add, which opens the editor with a row to type into', async () => {
    const { api } = setup({ hub: hub({ log: [] }) });
    const panel = await screen.findByRole('region', { name: 'Milestones' });
    expect(panel.textContent).toMatch(/No milestones\. Up to twelve steps/);
    fireEvent.click(within(panel).getByRole('button', { name: 'Add' }));
    const sheet = await screen.findByRole('dialog', { name: 'Milestones' });
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Milestone 1' }), { target: { value: 'Wireframes' } });
    fireEvent.change(within(sheet).getByLabelText('Target day of Wireframes'), { target: { value: '2026-02-01' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add a milestone' }));
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Milestone 2' }), { target: { value: 'Go live' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Move Go live up' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save milestones' }));
    await waitFor(() => expect(puts(api)).toHaveLength(1));
    expect(puts(api)[0]!.body).toEqual({ milestones: [{ name: 'Go live' }, { name: 'Wireframes', target: '2026-02-01' }] });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Milestones' })).toBeNull());
  });

  it('Edit: rename, tick, remove; kept ones by their ids; a blank name keeps Save off', async () => {
    const { api } = setup();
    const panel = await screen.findByRole('region', { name: 'Milestones' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Edit' }));
    const sheet = await screen.findByRole('dialog', { name: 'Milestones' });
    const name = (n: number) => within(sheet).getByRole('textbox', { name: `Milestone ${n}` }) as HTMLInputElement;
    expect([1, 2, 3].map((n) => name(n).value)).toEqual(['Design', 'Beta', 'Launch']);
    fireEvent.change(name(2), { target: { value: '' } });
    expect(within(sheet).getByText('Every milestone needs a name of up to 60 characters.')).toBeTruthy();
    expect((within(sheet).getByRole('button', { name: 'Save milestones' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name(2), { target: { value: 'Beta, to five shops' } });
    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Beta, to five shops done' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove Launch' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save milestones' }));
    await waitFor(() => expect(puts(api)).toHaveLength(1));
    expect(puts(api)[0]!.body).toEqual({
      milestones: [
        { id: IDS.ms1, name: 'Design', target: '2026-01-05', done: true },
        { id: IDS.ms2, name: 'Beta, to five shops', target: '2026-01-10', done: true },
      ],
    });
  });

  it('twelve at most: Add a milestone goes once there are twelve', async () => {
    setup();
    fireEvent.click(within(await screen.findByRole('region', { name: 'Milestones' })).getByRole('button', { name: 'Edit' }));
    const sheet = await screen.findByRole('dialog', { name: 'Milestones' });
    for (let i = 0; i < 9; i++) fireEvent.click(within(sheet).getByRole('button', { name: 'Add a milestone' }));
    expect(within(sheet).getAllByRole('textbox', { name: /^Milestone \d+$/ })).toHaveLength(12);
    expect(within(sheet).queryByRole('button', { name: 'Add a milestone' })).toBeNull();
    expect(within(sheet).getByText('Twelve is the most a project has.')).toBeTruthy();
  });

  it("without Work's part of the hub there are no milestones; offline the ticks are off", async () => {
    const p1 = setup({ hub: hub() });
    await screen.findByRole('heading', { level: 1, name: 'Site rebuild' });
    expect(screen.queryByRole('region', { name: 'Milestones' })).toBeNull();
    p1.unmount();
    setup({ status: 'offline' });
    const list = await screen.findByRole('list', { name: 'Its milestones' });
    for (const box of within(list).getAllByRole('checkbox')) expect((box as HTMLInputElement).disabled).toBe(true);
    expect((within(screen.getByRole('region', { name: 'Milestones' })).getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
