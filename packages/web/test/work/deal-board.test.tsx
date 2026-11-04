/**
 * 0.13.0 Work › Deals on a wide pane (design 6.3, 6.4, W32) against the
 * fake API, with made-up deals (Acme, Northwind, Globex):
 *
 * - A pane of 800 or more with nothing open: the board, a column per open
 *   stage with its count and totals per currency, Won and Lost as narrow
 *   columns of the last 30 days (each opens its own list).
 * - A mouse or trackpad drags a card onto a column (an open stage moves at
 *   once; Won and Lost ask first). Touch never drags: the card's ··· is
 *   the way, as it is with a mouse too.
 * - With a keyboard: ←→ go between columns, `m` opens Move to… for the
 *   focused card.
 * - A deal open: the open stages as groups beside it, its row current.
 * - A pane under 800 (the iPad upright): the phone's stage pages.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiRequest } from '../../src/lib/api.js';
import { DEAL_DRAG } from '../../src/ui/screens/work/Deals.js';
import { layoutAt } from '../../src/ui/shell/layout.js';
import { fakeApi, measureAs, preloadPlaces, renderApp, stateWith } from '../helpers.js';
import { IDS, WORK_ON, dealAnswers, workRequest } from '../work-helpers.js';

preloadPlaces('work', 'deals');

afterEach(() => vi.restoreAllMocks());

function setup(o: { path?: string; layout?: ReturnType<typeof layoutAt>; pane?: number; request?: Record<string, unknown> } = {}) {
  measureAs(o.pane ?? 1180);
  const api = fakeApi({
    lifeStatus: vi.fn(async () => WORK_ON()),
    projectsList: vi.fn(async () => ({ projects: [] })),
    request: workRequest(dealAnswers(o.request)),
  });
  return { ...renderApp({ path: o.path ?? '/work?tab=deals', state: stateWith({ features: { life: true } }), api, layout: o.layout ?? layoutAt(1440) }), api };
}

const moves = (api: { request: unknown }) =>
  (api.request as ReturnType<typeof workRequest>).mock.calls.filter(([r]) => r.method === 'POST' && r.path === '/v1/work/deals/:id/move').map(([, init]) => init as ApiRequest);

/** The board, once the pipeline has answered. */
const boardShown = () =>
  waitFor(() => {
    const b = document.querySelector<HTMLElement>('[data-board]');
    if (!b) throw new Error('no board yet');
    return b;
  });

/** A drag's DataTransfer as a browser gives one: the types it holds, and its data by type. */
function transfer() {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    setData: (k: string, v: string) => void data.set(k, v),
    getData: (k: string) => data.get(k) ?? '',
    effectAllowed: 'all',
    dropEffect: 'none',
  };
}

describe('the board on a wide pane', () => {
  it('a column per open stage with its count and totals; Won and Lost narrow, each opening its list', async () => {
    const { history } = setup();
    const board = await boardShown();
    expect(board.hasAttribute('data-scroll-x')).toBe(true);
    expect([...board.querySelectorAll('[data-column]')].map((c) => c.getAttribute('data-column'))).toEqual(['new', 'contacted', 'proposal', 'negotiation', 'won', 'lost']);
    const proposal = within(board).getByRole('region', { name: 'Proposal sent' });
    expect(within(proposal).getByRole('heading').textContent).toMatch(/Proposal sent2.*1 quiet/);
    expect(proposal.textContent).toMatch(/₹6,50,000 open · ₹3,90,000 weighted/);
    const cards = within(within(proposal).getByRole('list')).getAllByRole('link');
    expect(cards.map((a) => a.getAttribute('href'))).toEqual([`/work?tab=deals&id=${IDS.deal}`, `/work?tab=deals&id=${IDS.deal2}`]);
    // On a 240 column the deal comes first, its client on the second line: "Acme · Site r…" hid the deal.
    const [first, second] = [...cards[0]!.children] as HTMLElement[];
    expect(first!.textContent).toMatch(/^Site rebuild₹4,50,000$/);
    expect(second!.textContent).toMatch(/^Acme · 12 days/);
    expect(within(board).getByRole('region', { name: 'Contacted' }).textContent).toMatch(/Nothing here/);
    // Won's column: the last 30 days, a link to every won deal.
    const won = within(within(board).getByRole('region', { name: 'Won' })).getByRole('link');
    expect(won.textContent).toMatch(/Won.*30 days.*1.*₹3,00,000/);
    fireEvent.click(won);
    expect(history.entries.at(-1)).toBe('/work?tab=deals&stage=won');
    // A stage's page on a wide pane offers the board back.
    fireEvent.click(await screen.findByRole('button', { name: 'Show the board' }));
    expect(history.entries.at(-1)).toBe('/work?tab=deals');
    expect(screen.queryByRole('group', { name: 'Stages' })).toBeNull();
  });

  it('a mouse drags a card onto an open stage: it moves at once, with Undo', async () => {
    const { api } = setup();
    const board = await boardShown();
    const card = within(board).getByRole('link', { name: /Brand refresh/ });
    expect(card.getAttribute('draggable')).toBe('true');
    const dt = transfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    expect(dt.getData(DEAL_DRAG)).toBe(IDS.deal3);
    const contacted = within(board).getByRole('region', { name: 'Contacted' });
    expect(contacted.textContent).toMatch(/Drop here/);
    fireEvent.dragOver(contacted, { dataTransfer: dt });
    expect(contacted.getAttribute('data-over')).toBe('true');
    fireEvent.drop(contacted, { dataTransfer: dt });
    await waitFor(() => expect(moves(api)).toHaveLength(1));
    expect(moves(api)[0]).toMatchObject({ params: { id: IDS.deal3 }, body: { stage: 'contacted' } });
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('0.13.1: a move from the open deal retires the drag’s Undo line; the one Undo takes back the latest move', async () => {
    // Each deal answers with the stage it really left.
    const from: Record<string, string> = { [IDS.deal]: 'proposal', [IDS.deal2]: 'proposal', [IDS.deal3]: 'new' };
    const { api, history } = setup({ request: { 'POST /v1/work/deals/:id/move': (init: ApiRequest) => ({ id: init.params?.id, from: from[init.params?.id as string] }) } });
    const lines = () => screen.queryAllByRole('status').filter((s) => within(s).queryByRole('button', { name: 'Undo' }));
    const board = await boardShown();
    // The drag: Brand refresh to Contacted, "Moved to Contacted · Undo" on the list's line.
    const dt = transfer();
    fireEvent.dragStart(within(board).getByRole('link', { name: /Brand refresh/ }), { dataTransfer: dt });
    const contacted = within(board).getByRole('region', { name: 'Contacted' });
    fireEvent.dragOver(contacted, { dataTransfer: dt });
    fireEvent.drop(contacted, { dataTransfer: dt });
    await waitFor(() => expect(lines().map((l) => l.textContent)).toEqual(['Moved to ContactedUndo']));
    // Site rebuild opens beside the list; the drag's line is still the only one.
    fireEvent.click(within(board).getByRole('link', { name: /Site rebuild/ }));
    expect(history.entries.at(-1)).toBe(`/work?tab=deals&id=${IDS.deal}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Move to…' }));
    fireEvent.click(within(await screen.findByRole('radiogroup', { name: 'Stages' })).getByRole('radio', { name: 'Negotiation' }));
    await waitFor(() => expect(moves(api)).toHaveLength(2));
    // One line, the deal's: the list's line for the drag is gone, not kept beside it.
    await waitFor(() => expect(lines().map((l) => l.textContent)).toEqual(['Moved to NegotiationUndo']));
    expect(within(screen.getByRole('region', { name: 'All deals' })).queryByRole('button', { name: 'Undo' })).toBeNull();
    // Its Undo takes back the move just made (Site rebuild to Proposal sent), never the drag.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(moves(api)).toHaveLength(3));
    expect(moves(api)[2]).toMatchObject({ params: { id: IDS.deal }, body: { stage: 'proposal' } });
    expect(lines()).toEqual([]);
    // And the other way round: a move from the deal, then one from the list; only the list's line stays.
    fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));
    fireEvent.click(within(await screen.findByRole('radiogroup', { name: 'Stages' })).getByRole('radio', { name: 'Negotiation' }));
    await waitFor(() => expect(lines().map((l) => l.textContent)).toEqual(['Moved to NegotiationUndo']));
    const list = screen.getByRole('region', { name: 'All deals' });
    fireEvent.click(within(list).getByRole('button', { name: 'Actions for AI audit' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
    fireEvent.click(within(await screen.findByRole('radiogroup', { name: 'Stages' })).getByRole('radio', { name: 'Contacted' }));
    await waitFor(() => expect(moves(api)).toHaveLength(5));
    await waitFor(() => expect(lines().map((l) => l.textContent)).toEqual(['Moved to ContactedUndo']));
    fireEvent.click(within(list).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(moves(api)).toHaveLength(6));
    expect(moves(api)[5]).toMatchObject({ params: { id: IDS.deal2 }, body: { stage: 'proposal' } });
  });

  it('a drop on Won asks about a project first; nothing moves until he says', async () => {
    const { api } = setup();
    const board = await boardShown();
    const dt = transfer();
    fireEvent.dragStart(within(board).getByRole('link', { name: /Site rebuild/ }), { dataTransfer: dt });
    const won = within(board).getByRole('region', { name: 'Won' });
    fireEvent.dragOver(won, { dataTransfer: dt });
    fireEvent.drop(won, { dataTransfer: dt });
    expect(await screen.findByRole('dialog', { name: 'Won · ₹4,50,000' })).toBeTruthy();
    expect(moves(api)).toHaveLength(0);
  });

  it('something else dragged over a column is not taken', async () => {
    setup();
    const board = await boardShown();
    const contacted = within(board).getByRole('region', { name: 'Contacted' });
    const other = transfer();
    other.setData('text/plain', 'hello');
    fireEvent.dragOver(contacted, { dataTransfer: other });
    expect(contacted.hasAttribute('data-over')).toBe(false);
  });

  it('touch never drags (W32): the card’s ··· moves it', async () => {
    setup({ layout: layoutAt(1180, { coarse: true }), pane: 960 });
    const board = await boardShown();
    const card = within(board).getByRole('link', { name: /Site rebuild/ });
    expect(card.getAttribute('draggable')).toBe('false');
    fireEvent.click(within(board).getByRole('button', { name: 'Actions for Site rebuild' }));
    expect(await screen.findByRole('menuitem', { name: 'Move to…' })).toBeTruthy();
  });

  it('with a keyboard: ←→ go between columns, m opens Move to… for the focused card', async () => {
    setup();
    const board = await boardShown();
    const globex = within(board).getByRole('link', { name: /Brand refresh/ });
    globex.focus();
    fireEvent.keyDown(globex, { key: 'ArrowRight' });
    // Contacted is empty: the next column with a card, at the same place.
    expect(document.activeElement?.getAttribute('data-row')).toBe(IDS.deal);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement?.getAttribute('data-row')).toBe(IDS.deal3);
    fireEvent.keyDown(document.activeElement!, { key: 'm' });
    const stages = await screen.findByRole('radiogroup', { name: 'Stages' });
    expect(within(stages).getByRole('radio', { name: 'New lead' }).getAttribute('aria-checked')).toBe('true');
  });

  it('a deal open: the open stages as groups beside it, its row current', async () => {
    setup({ path: `/work?tab=deals&id=${IDS.deal}` });
    expect(await screen.findByRole('heading', { level: 1, name: 'Site rebuild' })).toBeTruthy();
    const list = screen.getByRole('region', { name: 'All deals' });
    expect(list.querySelector('[data-board]')).toBeNull();
    expect(within(list).getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['New lead', 'Contacted', 'Proposal sent', 'Negotiation']);
    expect(within(list).getByRole('link', { name: /Site rebuild/ }).getAttribute('aria-current')).toBe('true');
    // Beside the list the deal has Close, not "‹ Deals".
    expect(screen.getByRole('button', { name: /Close/ })).toBeTruthy();
  });

  it('a pane under 800 (the iPad upright): the stage pages, not the board', async () => {
    setup({ layout: layoutAt(820, { coarse: true }), pane: 748 });
    expect(await screen.findByRole('group', { name: 'Stages' })).toBeTruthy();
    expect(document.querySelector('[data-board]')).toBeNull();
  });
});
