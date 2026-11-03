/**
 * 0.13.0 Work › Deals › Insights (design 6.2, 6.4, W36) against the fake
 * API, with made-up numbers:
 *
 * - Deals' "Insights ›" opens it; "‹ Deals" goes back.
 * - The period chips (30 days … This FY, All) ask the Mac for that period;
 *   the range line says its days.
 * - One book per currency, never added across (W17): with two, each card
 *   names its currency. No data is "–", never 0 % (W36).
 * - The cards: win rate, cycle, forecast, revenue won, sources, why lost,
 *   then the funnel and time in stage.
 * - Nothing in the period: one line and All time (or Deals); the business
 *   filter once there are two; life.db broken and a failed load; columns on
 *   a wide pane; 44 on touch.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkInsightsReply } from '@jantar/protocol/work';
import { ApiError, type ApiRequest } from '../../src/lib/api.js';
import { anyDeals, bookLabel, closedLine, rangeText } from '../../src/ui/screens/work/dealModel.js';
import { layoutAt } from '../../src/ui/shell/layout.js';
import { fakeApi, measureAs, preloadPlaces, renderApp, stateWith } from '../helpers.js';
import { SETTINGS, WORK_ON, dealAnswers, emptyBook, insights, workRequest } from '../work-helpers.js';

preloadPlaces('work', 'deals', 'insights');

afterEach(() => vi.restoreAllMocks());

function setup(o: { request?: Record<string, unknown>; path?: string; layout?: ReturnType<typeof layoutAt>; status?: 'live' | 'offline' } = {}) {
  const api = fakeApi({
    lifeStatus: vi.fn(async () => WORK_ON()),
    request: workRequest(dealAnswers(o.request)),
  });
  return { ...renderApp({ path: o.path ?? '/work?tab=insights', state: stateWith({ features: { life: true } }), api, ...(o.layout ? { layout: o.layout } : {}), ...(o.status ? { status: o.status } : {}) }), api };
}

const asked = (api: { request: unknown }) =>
  (api.request as ReturnType<typeof workRequest>).mock.calls.filter(([r]) => r.method === 'GET' && r.path === '/v1/work/insights').map(([, init]) => (init as ApiRequest).query);

/** A card's region by its name. */
const card = (name: string) => screen.getByRole('region', { name });

/** The big figure on a card. */
const figure = (name: string) => (card(name).querySelector('[data-figure]') as HTMLElement).textContent;

/** The financial year so far: from 1 April in the Life zone (UTC here). */
const FY: WorkInsightsReply['period'] = { preset: 'fy', from: '2025-04-01T00:00:00.000Z', to: '2026-01-15T10:00:00.000Z' };

describe('the pure half', () => {
  it('the range, a card per currency, what counts as something to read, the closed line', () => {
    const day = (iso: string) => iso.slice(0, 10);
    expect(rangeText(FY, day)).toBe('1 Apr 2025 – 15 Jan 2026');
    expect(rangeText({ preset: 'all', from: '1970-01-01T00:00:00.000Z', to: FY.to }, day)).toBe('All time');
    expect(bookLabel('Win rate', 'USD', 1)).toBe('Win rate');
    expect(bookLabel('Win rate', 'USD', 2)).toBe('Win rate · USD');
    expect(anyDeals([emptyBook()])).toBe(false);
    expect(anyDeals([emptyBook(), { ...emptyBook('USD'), open: { count: 1, value: 1, weighted: 1 } }])).toBe(true);
    expect(closedLine({ won: 0, lost: 0, closed: 0, open: 3, rate: null })).toBe('Nothing closed');
    expect(closedLine({ won: 2, lost: 1, closed: 3, open: 0, rate: 2 / 3 })).toBe('2 won · 1 lost of 3 closed');
  });
});

describe('Insights', () => {
  it("opens from Deals' Insights ›, and ‹ Deals goes back", async () => {
    const { history } = setup({ path: '/work?tab=deals&stage=proposal' });
    fireEvent.click(await screen.findByRole('link', { name: 'Insights' }));
    expect(history.entries.at(-1)).toBe('/work?tab=insights');
    const back = await screen.findByRole('link', { name: 'Deals' });
    expect(screen.getByRole('heading', { level: 1, name: 'Insights' })).toBeTruthy();
    fireEvent.click(back);
    expect(history.entries.at(-1)).toBe('/work?tab=deals');
  });

  it('one book per currency, each card naming its own; no data is "–", never 0 %', async () => {
    setup();
    expect(await screen.findByRole('heading', { level: 1, name: 'Insights' })).toBeTruthy();
    await screen.findByRole('region', { name: 'Win rate · INR' });
    expect((document.querySelector('[data-range]') as HTMLElement).textContent).toBe('17 Oct 2025 – 15 Jan 2026');
    expect(figure('Win rate · INR')).toBe('67%');
    expect(card('Win rate · INR').textContent).toMatch(/2 won · 1 lost of 3 closed · 2 open/);
    // Dollars: one open deal, nothing closed: "–", not 0 %.
    expect(figure('Win rate · USD')).toBe('–');
    expect(card('Win rate · USD').textContent).toMatch(/Nothing closed · 1 open/);
    expect(figure('Cycle · INR')).toBe('18.5 days');
    expect(card('Cycle · INR').textContent).toMatch(/over 2 deals · fastest 12 days · slowest 25 days/);
    expect(figure('Cycle · USD')).toBe('–');
    expect(card('Cycle · USD').textContent).toMatch(/Nothing won/);
    // Never a sum across currencies: no card holds both symbols.
    for (const r of screen.getAllByRole('region')) expect(/₹/.test(r.textContent ?? '') && /\$/.test(r.textContent ?? ''), r.getAttribute('aria-label') ?? '').toBe(false);
  });

  it('the forecast, revenue won, sources and why lost, in the book’s currency', async () => {
    setup();
    await screen.findByRole('region', { name: 'Forecast · INR' });
    const forecast = within(screen.getByRole('list', { name: 'Forecast · INR' })).getAllByRole('listitem');
    expect(forecast.map((r) => r.textContent)).toEqual(['Jan 2026₹2,70,000₹4,50,000 open · 1 deal', 'No close day₹1,20,000₹2,00,000 open · 1 deal']);
    expect(card('Forecast · INR').textContent).toMatch(/₹3,90,000 weighted/);
    const revenue = within(screen.getByRole('list', { name: 'Revenue won · INR' })).getAllByRole('listitem');
    expect(revenue.map((r) => r.textContent)).toEqual(['Dec 2025₹2,00,0001 deal', 'Jan 2026₹3,00,0001 deal']);
    expect(revenue[1]!.querySelector('[data-bar]')?.getAttribute('data-bar')).toBe('100');
    expect(within(screen.getByRole('list', { name: 'Sources · INR' })).getByRole('listitem').textContent).toBe('Referral100%3 deals · 2 won · 1 open · ₹5,00,000');
    expect(within(screen.getByRole('list', { name: 'Why lost · INR' })).getByRole('listitem').textContent).toBe('Price100%1 deal · ₹1,00,000');
    // The dollar book has none of these yet: each says so in a line.
    expect(card('Revenue won · USD').textContent).toMatch(/Nothing won in this period\./);
    expect(card('Why lost · USD').textContent).toMatch(/Nothing lost in this period\./);
  });

  it('the funnel and time in stage, once for every currency', async () => {
    setup();
    await screen.findByRole('region', { name: 'Funnel' });
    const funnel = within(screen.getByRole('list', { name: 'Funnel' })).getAllByRole('listitem');
    expect(funnel.map((r) => r.textContent)).toEqual(['New lead75%4 came in · 3 moved on', 'Proposal sent–3 came in · 1 moved on']);
    const time = within(screen.getByRole('list', { name: 'Time in stage' })).getByRole('listitem');
    expect(time.textContent).toBe('Proposal sent10.5 daysmedian 9 days · 2 there now, oldest 12 days');
  });

  it('a period chip asks the Mac for it: This FY from 1 April', async () => {
    const { api } = setup({ request: { 'GET /v1/work/insights': (init: ApiRequest) => insights(init.query?.period === 'fy' ? { period: FY } : {}) } });
    const chips = await screen.findByRole('group', { name: 'Period' });
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['30 days', '90 days', '6 months', '12 months', 'This FY', 'All']);
    expect(within(chips).getByRole('button', { name: '90 days' }).getAttribute('aria-pressed')).toBe('true');
    expect(asked(api)[0]).toMatchObject({ period: '90d' });
    fireEvent.click(within(chips).getByRole('button', { name: 'This FY' }));
    await waitFor(() => expect((document.querySelector('[data-range]') as HTMLElement | null)?.textContent).toBe('1 Apr 2025 – 15 Jan 2026'));
    expect(asked(api).at(-1)).toMatchObject({ period: 'fy' });
    // A second tap keeps the period (a period is always picked).
    fireEvent.click(within(chips).getByRole('button', { name: 'This FY' }));
    expect(within(chips).getByRole('button', { name: 'This FY' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('nothing in the period: one line and All time; nothing at all: one line and Deals', async () => {
    const none = insights({ books: [emptyBook('INR')], funnel: { rows: [], unknownEntered: 0, unknownExited: 0 }, timeInStage: [] });
    const { api } = setup({ request: { 'GET /v1/work/insights': (init: ApiRequest) => (init.query?.period === 'all' ? { ...none, period: { ...none.period, preset: 'all' } } : none) } });
    expect(await screen.findByText('No deals in the last 90 days.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Win rate' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all time' }));
    expect(await screen.findByText('No deals yet. Insights fill in as deals move.')).toBeTruthy();
    expect(asked(api).at(-1)).toMatchObject({ period: 'all' });
    expect(screen.getByRole('link', { name: 'Go to Deals' }).getAttribute('href')).toBe('/work?tab=deals');
    expect((document.querySelector('[data-range]') as HTMLElement).textContent).toBe('All time');
  });

  it('one currency: the cards carry no currency in their names', async () => {
    setup({ request: { 'GET /v1/work/insights': insights({ books: [insights().books[0]!] }) } });
    expect(await screen.findByRole('region', { name: 'Win rate' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Win rate · INR' })).toBeNull();
  });

  it('the business filter shows once there are two, and asks for that business', async () => {
    const amg = '01JWRKBUS1NESS000000000AMG';
    const { api } = setup({ request: { 'GET /v1/work/settings': SETTINGS({ businesses: [{ id: amg, name: 'Studio' }, { id: '01JWRKBUS1NESS000000000TWO', name: 'Labs' }] }) } });
    const select = (await screen.findByRole('combobox', { name: 'Business' })) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: amg } });
    await waitFor(() => expect(asked(api).at(-1)).toMatchObject({ business: amg }));
  });

  it('life.db broken: the Life sentence; a failed load: Try again', async () => {
    const broken = new ApiError('life_unavailable', 'Life is unavailable: life.db could not be opened. See it at your Mac: jantar life status', 503);
    const b = setup({ request: { 'GET /v1/work/insights': broken } });
    expect((await screen.findByText('jantar life status')).tagName).toBe('CODE');
    b.unmount();
    setup({ request: { 'GET /v1/work/insights': new ApiError('internal', 'Something broke', 500) } });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('a wide pane: the cards in columns of 340, three at most', async () => {
    measureAs(1180);
    setup({ layout: layoutAt(1440) });
    await screen.findByRole('region', { name: 'Win rate · INR' });
    expect(document.querySelector('[data-columns]')?.getAttribute('data-columns')).toBe('3');
  });

  it('touch: the period chips are 44 by 44 at least ("All" is narrower)', async () => {
    setup({ layout: layoutAt(390, { coarse: true }) });
    const chips = await screen.findByRole('group', { name: 'Period' });
    const all = within(chips).getByRole('button', { name: 'All' });
    expect(all.className).toContain('coarse:h-44');
    expect(all.className).toContain('coarse:min-w-44');
  });
});
