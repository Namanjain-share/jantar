/**
 * 0.13.0 Work › Deals (design 6.2-6.5, W17, W32, W33) against the fake API,
 * with made-up deals (Acme, Northwind, Globex):
 *
 * - Projects · Clients · Deals under Work's title; Deals is its address.
 * - A phone: a stage picker (the address's `?stage=`) and that stage's
 *   deals, never a board. Totals per currency, never added across.
 * - A card: client and title, value, days in stage, next step, close day
 *   (ember once passed), quiet. Its ··· moves it, logs, sets a next step,
 *   opens the client.
 * - Moves: an open stage at once with Undo (a move back); Won asks about a
 *   project (the client's folder filled in), Lost asks why (eight reasons,
 *   a note; Skip), each with its follow-ups' ticks.
 * - Won's and Lost's own lists; Today's filters (`?show=`) with Clear.
 * - Every state: loading, empty (New deal), an empty stage, Work off,
 *   life.db broken, a failed load, offline (adding and moving off).
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOST_REASON_LABELS } from '@jantar/life-core';
import { WORK_LOST_CODES } from '@jantar/protocol/work';
import { ApiError, type ApiRequest } from '../../src/lib/api.js';
import { parseRoute, routePath } from '../../src/lib/router.js';
import { LOST_REASONS } from '../../src/ui/screens/work/dealModel.js';
import { layoutAt } from '../../src/ui/shell/layout.js';
import { fakeApi, preloadPlaces, renderApp, stateWith } from '../helpers.js';
import { DEALS, IDS, SETTINGS, WORK_ON, dealAnswers, dealHub, lifeStatus, stageCols, workRequest } from '../work-helpers.js';

preloadPlaces('work', 'deals');

afterEach(() => vi.restoreAllMocks());

function setup(o: { request?: Record<string, unknown>; path?: string; layout?: ReturnType<typeof layoutAt>; status?: 'live' | 'offline'; over?: Parameters<typeof fakeApi>[0] } = {}) {
  const api = fakeApi({
    lifeStatus: vi.fn(async () => WORK_ON()),
    projectsList: vi.fn(async () => ({ projects: [] })),
    todosList: vi.fn(async () => ({ todos: [], today: '2026-01-15' })),
    todoDone: vi.fn(async () => ({ ok: true as const })),
    request: workRequest(dealAnswers(o.request)),
    ...o.over,
  });
  return { ...renderApp({ path: o.path ?? '/work?tab=deals', state: stateWith({ features: { life: true } }), api, ...(o.layout ? { layout: o.layout } : {}), ...(o.status ? { status: o.status } : {}) }), api };
}

const calls = (api: { request: unknown }, method: string, path: string) =>
  (api.request as ReturnType<typeof workRequest>).mock.calls.filter(([r]) => r.method === method && r.path === path).map(([, init]) => init as ApiRequest);

describe('the deals address', () => {
  it('carries a stage and a Today filter, and prints them back', () => {
    expect(parseRoute('/work', '?tab=deals&stage=proposal')).toEqual({ name: 'work', tab: 'deals', stage: 'proposal' });
    expect(parseRoute('/work', '?tab=deals&show=quiet')).toEqual({ name: 'work', tab: 'deals', show: 'quiet' });
    expect(parseRoute('/work', '?tab=deals&show=nope&stage=a%20b')).toEqual({ name: 'work', tab: 'deals' });
    expect(routePath({ name: 'work', tab: 'deals', stage: 'won' })).toBe('/work?tab=deals&stage=won');
    expect(routePath({ name: 'work', tab: 'deals', id: IDS.deal, show: 'nostep' })).toBe(`/work?tab=deals&id=${IDS.deal}&show=nostep`);
  });

  it("the Lost sheet's eight reasons are the protocol's codes with life-core's words", () => {
    expect(LOST_REASONS.map((r) => r.key)).toEqual([...WORK_LOST_CODES]);
    for (const r of LOST_REASONS) expect(r.label, r.key).toBe(LOST_REASON_LABELS[r.key]);
  });
});

describe('Work › Deals on a phone', () => {
  it('a stage picker and that stage’s deals, the totals per currency (never added across)', async () => {
    const { history } = setup();
    const picker = await screen.findByRole('group', { name: 'Stages' });
    expect(screen.getByRole('heading', { level: 1, name: 'Work' })).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Work' })).getByRole('button', { name: 'Deals' }).getAttribute('aria-pressed')).toBe('true');
    expect(picker.hasAttribute('data-scroll-x')).toBe(true);
    expect(within(picker).getAllByRole('button').map((b) => b.textContent)).toEqual(['New lead1', 'Contacted0', 'Proposal sent2', 'Negotiation0', 'Won1', 'Lost0']);
    // The first open stage with deals is shown first.
    expect(within(picker).getByRole('button', { name: /New lead/ }).getAttribute('aria-pressed')).toBe('true');
    // The pipeline's totals: one line per currency, rupees (the Life currency) first.
    const totals = document.querySelector('[data-totals]') as HTMLElement;
    expect([...totals.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['Open ₹6,50,000 · weighted ₹3,90,000 · won in 30 days ₹3,00,000', 'Open $2,000 · weighted $400']);
    // They ask for 240 before Insights (and the business) wrap under them, never a basis of 0 (flex-1), which
    // squeezed them to a word a line beside Insights on a 320 phone or a 340 list.
    expect(totals.className.split(' ')).toEqual(expect.arrayContaining(['grow', 'basis-240', 'min-w-0']));
    expect(totals.className).not.toMatch(/\bflex-1\b/);
    expect(screen.queryByRole('region', { name: 'Pipeline' })).toBeNull();
    // A card whose close day passed says so in ember.
    const globex = within(screen.getByRole('list', { name: 'New lead' })).getByRole('link', { name: /Globex/ });
    expect(globex.textContent).toMatch(/Globex · Brand refresh/);
    expect(globex.textContent).toMatch(/\$2,000/);
    expect(within(globex).getByText('close day passed 10 Jan').className).toMatch(/text-signal-text/);
    // Another stage is the address.
    fireEvent.click(within(picker).getByRole('button', { name: /Proposal sent/ }));
    expect(history.entries.at(-1)).toBe('/work?tab=deals&stage=proposal');
    const list = await screen.findByRole('list', { name: 'Proposal sent' });
    expect((document.querySelector('[data-stage-totals]') as HTMLElement).textContent).toBe('₹6,50,000 open · ₹3,90,000 weighted');
    const cards = within(list).getAllByRole('link');
    expect(cards.map((c) => c.getAttribute('href'))).toEqual([`/work?tab=deals&id=${IDS.deal}&stage=proposal`, `/work?tab=deals&id=${IDS.deal2}&stage=proposal`]);
    expect(cards[0]!.textContent).toMatch(/Acme · Site rebuild/);
    expect(cards[0]!.textContent).toMatch(/₹4,50,000/);
    expect(cards[0]!.textContent).toMatch(/12 days · next Tomorrow 15:00 · closes 30 Jan/);
    expect(cards[1]!.textContent).toMatch(/9 days · no next step · quiet/);
    expect(cards[1]!.closest('li')?.getAttribute('data-quiet')).toBe('true');
    expect(screen.getByRole('region', { name: 'Proposal sent' }).textContent).toMatch(/1 quiet/);
  });

  it('a card opens the deal; its page goes back to the stage it came from', async () => {
    const { history } = setup({ path: '/work?tab=deals&stage=proposal' });
    fireEvent.click(within(await screen.findByRole('list', { name: 'Proposal sent' })).getByRole('link', { name: /Site rebuild/ }));
    expect(history.entries.at(-1)).toBe(`/work?tab=deals&id=${IDS.deal}&stage=proposal`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Site rebuild' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Deals' }).getAttribute('href')).toBe('/work?tab=deals&stage=proposal');
  });

  it('Move to… an open stage moves at once; Undo moves it back', async () => {
    const { api } = setup({ path: '/work?tab=deals&stage=proposal' });
    const list = await screen.findByRole('list', { name: 'Proposal sent' });
    fireEvent.click(within(list).getByRole('button', { name: 'Actions for Site rebuild' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
    const stages = await screen.findByRole('radiogroup', { name: 'Stages' });
    expect(within(stages).getByRole('radio', { name: 'Proposal sent' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(stages).getByRole('radio', { name: 'Negotiation' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/deals/:id/move')).toHaveLength(1));
    expect(calls(api, 'POST', '/v1/work/deals/:id/move')[0]).toMatchObject({ params: { id: IDS.deal }, body: { stage: 'negotiation' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/deals/:id/move')).toHaveLength(2));
    expect(calls(api, 'POST', '/v1/work/deals/:id/move')[1]).toMatchObject({ params: { id: IDS.deal }, body: { stage: 'proposal' } });
  });

  it('Won asks "Make a project for it?" with its name and the client’s folder, in the same save', async () => {
    const { api } = setup({ path: '/work?tab=deals&stage=proposal', request: { 'POST /v1/work/deals/:id/move': { id: IDS.deal, from: 'proposal', projectId: IDS.globex } } });
    const list = await screen.findByRole('list', { name: 'Proposal sent' });
    fireEvent.click(within(list).getByRole('button', { name: 'Actions for Site rebuild' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
    fireEvent.click(within(await screen.findByRole('radiogroup', { name: 'Stages' })).getByRole('radio', { name: /^Won/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Won · ₹4,50,000' });
    // Its project already exists in the hub fixture: a deal without one is asked about one.
    expect(within(sheet).getByText(/Its project is Site rebuild/)).toBeTruthy();
    // Its follow-up is offered done, unticked for a win.
    const tick = await within(sheet).findByRole('checkbox', { name: 'Mark done: Call about scope' });
    expect((tick as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Mark as won' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/deals/:id/move')).toHaveLength(1));
    expect(calls(api, 'POST', '/v1/work/deals/:id/move')[0]!.body).toEqual({ stage: 'won' });
    expect(api.todoDone).not.toHaveBeenCalled();
  });

  it('Won is sent once: while its follow-ups are marked done, a second tap sends nothing', async () => {
    let release: () => void = () => undefined;
    const todoDone = vi.fn(() => new Promise<{ ok: true }>((r) => (release = () => r({ ok: true }))));
    const { api } = setup({ path: '/work?tab=deals&stage=proposal', request: { 'POST /v1/work/deals/:id/move': { id: IDS.deal, from: 'proposal' } }, over: { todoDone } });
    const list = await screen.findByRole('list', { name: 'Proposal sent' });
    fireEvent.click(within(list).getByRole('button', { name: 'Actions for Site rebuild' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
    fireEvent.click(within(await screen.findByRole('radiogroup', { name: 'Stages' })).getByRole('radio', { name: /^Won/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Won · ₹4,50,000' });
    fireEvent.click(await within(sheet).findByRole('checkbox', { name: 'Mark done: Call about scope' }));
    const won = within(sheet).getByRole('button', { name: /Mark as won/ });
    fireEvent.click(won);
    await waitFor(() => expect(todoDone).toHaveBeenCalledTimes(1));
    // The move is saved; the tick is still on its way. Another tap sends no second move.
    expect((within(sheet).getByRole('button', { name: /Mark as won/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(within(sheet).getByRole('form', { name: 'Won' }));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(calls(api, 'POST', '/v1/work/deals/:id/move')).toHaveLength(1);
    act(() => release());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Won · ₹4,50,000' })).toBeNull());
    expect(calls(api, 'POST', '/v1/work/deals/:id/move')).toHaveLength(1);
  });

  it('Won on a deal with no project: Make project sends its name and folder; Not now wins without one', async () => {
    const { api } = setup({ path: '/work?tab=deals&stage=proposal', request: { 'GET /v1/work/deals/:id': dealHub({ project: undefined, deal: { ...dealHub().deal, projectId: undefined } }) } });
    const list = await screen.findByRole('list', { name: 'Proposal sent' });
    fireEvent.click(within(list).getByRole('button', { name: 'Actions for Site rebuild' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
    fireEvent.click(within(await screen.findByRole('radiogroup', { name: 'Stages' })).getByRole('radio', { name: /^Won/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Won · ₹4,50,000' });
    expect(within(sheet).getByText(/Make a project for it\?/)).toBeTruthy();
    expect((within(sheet).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Site rebuild');
    // The client's folder, once its page answers.
    await waitFor(() => expect((within(sheet).getByRole('combobox', { name: 'Folder' }) as HTMLSelectElement).value).toBe('/Users/example/Desktop/work/client/acme'));
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Name' }), { target: { value: 'Acme site' } });
    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Mark done: Call about scope' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Make project' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/deals/:id/move')).toHaveLength(1));
    expect(calls(api, 'POST', '/v1/work/deals/:id/move')[0]!.body).toEqual({ stage: 'won', project: { name: 'Acme site', folder: '/Users/example/Desktop/work/client/acme' } });
    await waitFor(() => expect(api.todoDone).toHaveBeenCalledWith(IDS.followUp, true));
  });

  it('Lost asks why (eight reasons, a note), its follow-ups ticked done; Skip moves it with none', async () => {
    const { api } = setup({ path: '/work?tab=deals&stage=proposal', request: { 'POST /v1/work/deals/:id/move': { id: IDS.deal, from: 'proposal' } } });
    const list = await screen.findByRole('list', { name: 'Proposal sent' });
    const lose = async () => {
      fireEvent.click(within(list).getByRole('button', { name: 'Actions for Site rebuild' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
      fireEvent.click(within(await screen.findByRole('radiogroup', { name: 'Stages' })).getByRole('radio', { name: /^Lost/ }));
      return screen.findByRole('dialog', { name: 'Lost · Site rebuild' });
    };
    let sheet = await lose();
    const why = within(sheet).getByRole('group', { name: 'Why it was lost' });
    expect(within(why).getAllByRole('button').map((b) => b.textContent)).toEqual(LOST_REASONS.map((r) => r.label));
    fireEvent.click(within(why).getByRole('button', { name: 'Price' }));
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Note' }), { target: { value: 'Went with a cheaper quote.' } });
    expect((await within(sheet).findByRole('checkbox', { name: 'Mark done: Call about scope' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/deals/:id/move')).toHaveLength(1));
    expect(calls(api, 'POST', '/v1/work/deals/:id/move')[0]!.body).toEqual({ stage: 'lost', lostCode: 'price', lostNote: 'Went with a cheaper quote.' });
    await waitFor(() => expect(api.todoDone).toHaveBeenCalledWith(IDS.followUp, true));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Lost · Site rebuild' })).toBeNull());
    sheet = await lose();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/deals/:id/move')).toHaveLength(2));
    expect(calls(api, 'POST', '/v1/work/deals/:id/move')[1]!.body).toEqual({ stage: 'lost' });
  });

  it("Won's page lists every won deal, newest first, with the last 30 days' total", async () => {
    const { api } = setup({ path: '/work?tab=deals&stage=won' });
    const list = await screen.findByRole('list', { name: 'Won' });
    expect(within(list).getByRole('link', { name: /Shop launch/ }).textContent).toMatch(/₹3,00,000/);
    expect(calls(api, 'GET', '/v1/work/deals').some((c) => c.query?.open === '0' && c.query?.stage === 'won')).toBe(true);
    expect(screen.getByRole('region', { name: 'Won' }).textContent).toMatch(/last 30 days/);
    expect((document.querySelector('[data-stage-totals]') as HTMLElement).textContent).toBe('₹3,00,000 won');
  });

  it('an empty stage says so; no deals at all: one line and New deal', async () => {
    const a = setup({ path: '/work?tab=deals&stage=negotiation' });
    expect(await screen.findByText('Nothing in Negotiation.')).toBeTruthy();
    a.unmount();
    const empty = stageCols().map((c) => ({ ...c, count: 0, value: [], weighted: [], quiet: 0 }));
    setup({ request: { 'GET /v1/work/deals': DEALS([], empty) } });
    expect(await screen.findByText(/No deals yet\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a deal' })).toBeTruthy();
    expect(screen.getByText('Nothing open')).toBeTruthy();
  });

  it('a business with no deals of its own says so, and All businesses brings them back', async () => {
    const studio = '01JWRKBUS1NESS000000000AMG';
    const empty = stageCols().map((c) => ({ ...c, count: 0, value: [], weighted: [], quiet: 0 }));
    const { api } = setup({
      request: {
        'GET /v1/work/settings': SETTINGS({ businesses: [{ id: studio, name: 'Studio' }, { id: '01JWRKBUS1NESS000000000TWO', name: 'Labs' }] }),
        'GET /v1/work/deals': (init: ApiRequest) => (init.query?.business ? DEALS([], empty) : DEALS()),
      },
    });
    fireEvent.change(await screen.findByRole('combobox', { name: 'Business' }), { target: { value: studio } });
    expect(await screen.findByText('No deals for this business.')).toBeTruthy();
    expect(calls(api, 'GET', '/v1/work/deals').some((c) => c.query?.business === studio)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'All businesses' }));
    expect(await screen.findByRole('group', { name: 'Stages' })).toBeTruthy();
  });

  it("Today's filters: the deals they count, one list, with Clear", async () => {
    const { history, api, router } = setup({ path: '/work?tab=deals&show=nostep' });
    const list = await screen.findByRole('list', { name: 'No next step' });
    expect(within(list).getAllByRole('link').map((l) => l.textContent)).toEqual([expect.stringMatching(/Northwind · AI audit/)]);
    expect(within(list).getByRole('link').textContent).toMatch(/Proposal sent/);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(history.entries.at(-1)).toBe('/work?tab=deals');
    // Quiet and closing this week ask the daemon's own windows.
    act(() => router.getState().navigate('/work?tab=deals&show=closing'));
    await waitFor(() => expect(calls(api, 'GET', '/v1/work/deals').some((c) => c.query?.closing === 'week')).toBe(true));
    act(() => router.getState().navigate('/work?tab=deals&show=quiet'));
    await waitFor(() => expect(calls(api, 'GET', '/v1/work/deals').some((c) => c.query?.quiet === '1')).toBe(true));
  });

  it('Work off: the daemon’s sentence; life.db broken: the Life sentence; a failed load: Try again', async () => {
    const off = setup({ over: { lifeStatus: vi.fn(async () => lifeStatus({ todos: true })) } });
    expect((await screen.findByText('jantar work on')).tagName).toBe('CODE');
    off.unmount();
    const broken = new ApiError('life_unavailable', 'Life is unavailable: life.db could not be opened. See it at your Mac: jantar life status', 503);
    const b = setup({ request: { 'GET /v1/work/deals': broken } });
    expect((await screen.findByText('jantar life status')).tagName).toBe('CODE');
    expect(screen.getByRole('heading', { level: 1, name: 'Work' })).toBeTruthy();
    b.unmount();
    setup({ request: { 'GET /v1/work/deals': new ApiError('internal', 'Something broke', 500) } });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('offline: the last pipeline stays; adding and moving are off', async () => {
    setup({ status: 'offline', path: '/work?tab=deals&stage=proposal' });
    const list = await screen.findByRole('list', { name: 'Proposal sent' });
    expect((screen.getByRole('button', { name: 'New deal' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(list).getByRole('button', { name: 'Actions for Site rebuild' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Offline: changes need your Mac')).toBeTruthy();
  });

  it('touch targets: the stage chips, cards and their ··· are 44 on touch', async () => {
    setup({ layout: layoutAt(390, { coarse: true }), path: '/work?tab=deals&stage=proposal' });
    const list = await screen.findByRole('list', { name: 'Proposal sent' });
    expect(within(screen.getByRole('group', { name: 'Stages' })).getByRole('button', { name: /Won/ }).className).toContain('coarse:h-44');
    const card = within(list).getByRole('link', { name: /Site rebuild/ });
    expect(card.className).toContain('coarse:min-h-56');
    // No drag on touch (W32): a long press opens the card's menu instead.
    expect(card.getAttribute('draggable')).toBe('false');
    expect(within(list).getByRole('button', { name: 'Actions for Site rebuild' }).className).toContain('coarse:size-44');
  });

  it('a long press on a card opens its menu (Move to…, Log, Next step, Open client)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setup({ layout: layoutAt(390, { coarse: true }), path: '/work?tab=deals&stage=proposal' });
      const card = within(await screen.findByRole('list', { name: 'Proposal sent' })).getByRole('link', { name: /AI audit/ });
      fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 });
      vi.advanceTimersByTime(600);
      const menu = await screen.findByRole('menu', { name: 'Actions for AI audit' });
      expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Move to…', 'Log', 'Next step', 'Open client']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Open client goes to its client', async () => {
    const { history } = setup({ path: '/work?tab=deals&stage=proposal' });
    const list = await screen.findByRole('list', { name: 'Proposal sent' });
    fireEvent.click(within(list).getByRole('button', { name: 'Actions for AI audit' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open client' }));
    expect(history.entries.at(-1)).toBe(`/work?tab=clients&id=${IDS.northwindCo}`);
  });

  it('Next step on a card: a follow-up with its client and deal', async () => {
    const { api } = setup({ path: '/work?tab=deals&stage=proposal', over: { todoCreate: vi.fn(async () => ({ id: IDS.todo2 })) } });
    const list = await screen.findByRole('list', { name: 'Proposal sent' });
    fireEvent.click(within(list).getByRole('button', { name: 'Actions for AI audit' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Next step' }));
    const sheet = await screen.findByRole('dialog', { name: 'Next step' });
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Title' }), { target: { value: 'Send the audit plan' } });
    fireEvent.click(within(sheet).getByRole('button', { name: /^Add|^Save/ }));
    await waitFor(() => expect(api.todoCreate).toHaveBeenCalled());
    expect(vi.mocked(api.todoCreate).mock.calls[0]![0]).toMatchObject({ title: 'Send the audit plan', contactId: IDS.northwindCo, dealId: IDS.deal2 });
  });
});
