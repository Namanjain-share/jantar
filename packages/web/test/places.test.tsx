/**
 * Cafés, the list (v0.4 spec 4.7, 5.6, 5.10; v0.10 spec 0.10 A7.1; gate
 * LW2 for places) against the fake API: the daemon's order as it sends it,
 * All | Tried | Want to try, the row (the café's own stars or `want`, the
 * price level in the Life currency or as a word, `not again`, the best
 * dish, then area, last visit and tags with "+2"), Sort and Filters sheets
 * and the search driving the address and the daemon's query, the filters
 * that are on as chips that wrap, an empty list and one nothing matches, a
 * 0.9 daemon's answer without the new fields, `?id=` opening a café's
 * screen, every state with the <h1>, and 44 px targets under a coarse
 * pointer. A link opens only for http(s); a hostile name renders as text.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Place } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import { safeHref } from '../src/ui/screens/life/shared/links.js';
import { bestDish } from '../src/ui/screens/life/places/Places.js';
import { tagsLine } from '../src/ui/screens/life/places/model.js';
import { iso, preloadPlaces } from './helpers.js';
import { PLACES, id, listOf, place, render, status } from './places-helpers.js';

preloadPlaces('places');

afterEach(() => vi.useRealTimers());

const heading = () => screen.findByRole('heading', { level: 1, name: 'Cafés' });
const rows = async () => within(await screen.findByRole('list', { name: 'Cafés' })).getAllByRole('listitem');

describe('Cafés: the list', () => {
  it('shows its title while loading and with an error', async () => {
    let fail!: (e: unknown) => void;
    render({ list: () => new Promise((_, rej) => (fail = rej)) });
    await heading();
    // The <h1> can paint before the effect that calls the loader has run.
    await waitFor(() => expect(fail).toBeTypeOf('function'));
    await act(async () => fail(new ApiError('forbidden', 'Cafés are off. Turn them on at your Mac: jantar life on places', 403)));
    expect((await screen.findByText('jantar life on places')).tagName).toBe('CODE');
    expect(screen.getByRole('heading', { level: 1, name: 'Cafés' })).toBeTruthy();
  });

  it("keeps the daemon's order; a row has the café's stars or want, the price, the best dish, then area, last visit and tags", async () => {
    render();
    const r = await rows();
    expect(r.map((x) => x.querySelector('.font-medium')?.textContent)).toEqual(['Example Café 1', 'Example Café 2', '<img src=x onerror="window.__pwned=1">']);
    // Line 1: its own 4 stars and ₹₹; the best dish's 5 stars on line 2.
    expect(within(r[0]!).getAllByRole('img').map((i) => i.getAttribute('aria-label'))).toEqual(['4 of 5', '5 of 5']);
    expect(within(r[0]!).getByText('₹₹').className).toContain('type-mono');
    expect(within(r[0]!).getByText('Sample Dosa')).toBeTruthy();
    // Line 3, in mono: the area, the last visit, two tags and how many more.
    const third = within(r[0]!).getByText('Old Town · 12 Jan · Wi-Fi Sockets +2');
    expect(third.className).toContain('type-mono');
    expect(third.className).toContain('truncate');
    expect(within(r[0]!).queryByText('want')).toBeNull();
    // Not tried: `want` where the stars go; its price ₹.
    expect(within(r[1]!).getByText('want')).toBeTruthy();
    expect(within(r[1]!).getByText('₹')).toBeTruthy();
    expect(within(r[2]!).getByText('not again')).toBeTruthy();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('with no Life currency the price is a word in a mono tag', async () => {
    render({ status: status({ currency: null }) });
    const r = await rows();
    await waitFor(() => expect(within(r[0]!).getByText('Mid')).toBeTruthy());
    expect(within(r[0]!).getByText('Mid').className).toContain('font-mono');
    expect(within(r[1]!).getByText('Cheap')).toBeTruthy();
  });

  it('a café with no stars, price, dishes or tags is one line; tags overflow as +N', async () => {
    render({ places: [place(5, { tags: ['wifi'] }), place(6)] });
    const r = await rows();
    expect(within(r[0]!).queryByRole('img')).toBeNull();
    expect(within(r[0]!).getByText('Wi-Fi')).toBeTruthy();
    expect(within(r[1]!).getByRole('button').textContent).toBe('Example Café 6');
    expect(tagsLine(['wifi', 'quiet'])).toBe('Wi-Fi Quiet');
    expect(tagsLine(['wifi', 'quiet', 'late', 'Board games', 'ac'])).toBe('Wi-Fi Quiet +3');
  });

  it("a 0.9 daemon's answer (no tags, areas or visits) renders", async () => {
    const old = { id: id(1), name: 'Example Café 1', area: 'Old Town', tried: true, dishes: [{ name: 'Sample Dosa', rating: 5 }], best: 5, createdAt: iso(0), updatedAt: iso(0) } as unknown as Place;
    render({ list: async () => ({ places: [old] }) });
    const r = await rows();
    expect(within(r[0]!).getByText('Sample Dosa')).toBeTruthy();
    expect(within(r[0]!).getByText('Old Town')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
    expect(await screen.findByText('No tags on these cafés yet.')).toBeTruthy();
  });

  it('All | Tried | Want to try through the address and the query', async () => {
    const { api, router } = render();
    await screen.findByRole('list', { name: 'Cafés' });
    expect(api.placesList).toHaveBeenCalledWith({});
    fireEvent.click(screen.getByRole('button', { name: 'Want to try' }));
    expect(router.getState().route).toEqual({ name: 'places', filter: 'want' });
    await waitFor(() => expect(api.placesList).toHaveBeenCalledWith({ filter: 'want' }));
  });

  it('Sort opens a radio list; a pick goes into the address and the query', async () => {
    const { api, router } = render();
    await screen.findByRole('list', { name: 'Cafés' });
    fireEvent.click(screen.getByRole('button', { name: 'Sort: Best' }));
    const sheet = await screen.findByRole('dialog', { name: 'Sort' });
    const group = within(sheet).getByRole('radiogroup', { name: 'Sort cafés' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Best', 'Recent', 'Most visited', 'Name', 'Price', 'Work']);
    expect(within(group).getByRole('radio', { checked: true }).textContent).toBe('Best');
    fireEvent.click(within(group).getByRole('radio', { name: 'Work' }));
    expect(router.getState().route).toEqual({ name: 'places', sort: 'work' });
    await waitFor(() => expect(api.placesList).toHaveBeenCalledWith({ sort: 'work' }));
    expect(await screen.findByRole('button', { name: 'Sort: Work' })).toBeTruthy();
  });

  it('Filters: tags (work first, with counts), price up to, stars at least, would go again and area drive the address', async () => {
    const { api, router } = render();
    await screen.findByRole('list', { name: 'Cafés' });
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    let sheet = await screen.findByRole('dialog', { name: 'Filters' });
    const tags = within(sheet).getByRole('group', { name: 'Tags' });
    expect(within(tags).getAllByRole('button').map((b) => b.textContent)).toEqual(['Wi-Fi1', 'Sockets1', 'Quiet1', 'Board games1']);
    expect(tags.className).toContain('flex-wrap');
    fireEvent.click(within(tags).getByRole('button', { name: /Wi-Fi/ }));
    expect(router.getState().route).toEqual({ name: 'places', tags: 'wifi' });
    sheet = await screen.findByRole('dialog', { name: 'Filters' });
    fireEvent.click(within(within(sheet).getByRole('group', { name: 'Tags' })).getByRole('button', { name: /Sockets/ }));
    expect(router.getState().route).toEqual({ name: 'places', tags: 'wifi,sockets' });
    fireEvent.click(within(within(sheet).getByRole('group', { name: 'Price up to' })).getByRole('button', { name: 'Up to price level 2 of 4' }));
    fireEvent.click(within(within(sheet).getByRole('group', { name: 'Stars at least' })).getByRole('button', { name: 'At least 4 stars' }));
    fireEvent.click(within(sheet).getByRole('switch'));
    fireEvent.click(within(within(sheet).getByRole('group', { name: 'Area' })).getByRole('button', { name: /Old Town/ }));
    expect(router.getState().route).toEqual({ name: 'places', tags: 'wifi,sockets', price: '2', stars: '4', again: true, area: 'Old Town' });
    await waitFor(() => expect(api.placesList).toHaveBeenLastCalledWith({ tags: 'wifi,sockets', price: '2', stars: '4', again: '1', area: 'Old Town' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Filters, 6 on' })).toBeTruthy();
  });

  it('the filters that are on show as chips that wrap; each takes itself off, Clear takes them all', async () => {
    const { router } = render({ path: '/places?sort=price&tags=wifi,quiet&price=2&stars=3&again=1&area=Old%20Town' });
    const on = await screen.findByRole('group', { name: 'Filters on' });
    expect(on.className).toContain('flex-wrap');
    expect(within(on).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
      'Take off Wi-Fi',
      'Take off Quiet',
      'Take off Up to ₹₹',
      'Take off 3+ stars',
      'Take off Would go again',
      'Take off Old Town',
      'Clear',
    ]);
    for (const chip of within(on).getAllByRole('button').slice(0, 6)) expect(chip.className).toContain('coarse:h-44');
    fireEvent.click(within(on).getByRole('button', { name: 'Take off Wi-Fi' }));
    expect(router.getState().route).toMatchObject({ tags: 'quiet', price: '2' });
    fireEvent.click(within(await screen.findByRole('group', { name: 'Filters on' })).getByRole('button', { name: 'Clear' }));
    // The sort is not a filter: it stays.
    expect(router.getState().route).toEqual({ name: 'places', sort: 'price' });
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Filters on' })).toBeNull());
  });

  it('the search goes into the address 250 ms after typing stops; closing it takes it off', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api, router } = render();
    await screen.findByRole('list', { name: 'Cafés' });
    fireEvent.click(screen.getByRole('button', { name: 'Search cafés' }));
    const box = screen.getByRole('searchbox', { name: 'Search cafés' });
    fireEvent.change(box, { target: { value: 'dos' } });
    fireEvent.change(box, { target: { value: 'dosa' } });
    await act(async () => vi.advanceTimersByTime(100));
    expect(router.getState().route).toEqual({ name: 'places' });
    await act(async () => vi.advanceTimersByTime(200));
    expect(router.getState().route).toEqual({ name: 'places', q: 'dosa' });
    await waitFor(() => expect(api.placesList).toHaveBeenLastCalledWith({ q: 'dosa' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close the search' }));
    expect(router.getState().route).toEqual({ name: 'places' });
    expect(screen.getByRole('button', { name: 'Sort: Best' })).toBeTruthy();
  });

  it('says so when the list is empty (with an add button), and when nothing matches (with a clear)', async () => {
    const a = render({ places: [] });
    expect(await screen.findByText('No cafés yet.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Add café' })).toHaveLength(2);
    a.unmount();
    const b = render({ places: [], path: '/places?filter=tried' });
    expect(await screen.findByText('No cafés tried yet.')).toBeTruthy();
    b.unmount();
    const { router } = render({ places: [], path: '/places?sort=name&q=nothing&tags=wifi' });
    expect(await screen.findByText('No café matches.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear the search and filters' }));
    expect(router.getState().route).toEqual({ name: 'places', sort: 'name' });
  });

  it('offline: the list stays and adding is off', async () => {
    render({ conn: 'offline' });
    await screen.findByRole('list', { name: 'Cafés' });
    expect((screen.getByRole('button', { name: 'Add café' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Offline: changes need your Mac')).toBeTruthy();
  });

  it('says Life is broken with the restore command in mono, and no retry', async () => {
    render({ list: async () => Promise.reject(new ApiError('life_unavailable', 'Life data could not be opened. The file is untouched. Restore a backup at your Mac: jantar life restore <file>', 503)) });
    expect((await screen.findByText('jantar life restore <file>')).tagName).toBe('CODE');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await heading();
  });

  it('says so when this device has no control scope', async () => {
    render({ list: async () => Promise.reject(new ApiError('forbidden', 'this device does not have the control scope', 403)) });
    expect(await screen.findByText(/Life needs control access/)).toBeTruthy();
    await heading();
  });

  it('is 44 px on touch: a row, the bar, and the filter chips', async () => {
    render();
    const name = await screen.findByText('<img src=x onerror="window.__pwned=1">');
    expect((name.closest('button') as HTMLElement).className).toContain('coarse:min-h-44');
    for (const label of ['Sort: Best', 'Filters']) expect(screen.getByRole('button', { name: label }).className).toContain('coarse:min-h-44');
    expect(screen.getByRole('button', { name: 'Search cafés' }).className).toContain('coarse:size-44');
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    for (const chip of within(within(sheet).getByRole('group', { name: 'Tags' })).getAllByRole('button')) expect(chip.className).toContain('coarse:h-44');
  });

  it('picks the best dish; an unrated one never counts', () => {
    expect(bestDish(PLACES[0]!)?.name).toBe('Sample Dosa');
    expect(bestDish(place(9, { dishes: [{ name: 'A', rating: 2 }, { name: 'B', rating: 4 }, { name: 'C', rating: 4 }] }))?.name).toBe('B');
    expect(bestDish(place(9, { dishes: [{ name: 'Must try' }, { name: 'B', rating: 1 }] }))?.name).toBe('B');
    expect(bestDish(place(9, { dishes: [{ name: 'Must try' }] }))).toBeNull();
    expect(bestDish(place(9))).toBeNull();
  });

  it('a tap opens the café screen at ?id=, keeping the view for the way back', async () => {
    const { router } = render({ path: '/places?sort=work' });
    fireEvent.click(await screen.findByText('Example Café 2'));
    expect(router.getState().route).toEqual({ name: 'places', sort: 'work', id: id(2) });
    expect(await screen.findByRole('heading', { level: 1, name: 'Example Café 2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Cafés' }));
    expect(router.getState().route).toEqual({ name: 'places', sort: 'work' });
  });

  it('?id= opens that café on arrival', async () => {
    render({ path: `/places?id=${id(2)}` });
    expect(await screen.findByRole('heading', { level: 1, name: 'Example Café 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Log visit' })).toBeTruthy();
  });
});

describe('Cafés: links (LW2)', () => {
  it('opens an https link in a new tab with no opener and no referrer', async () => {
    render({ path: `/places?id=${id(1)}` });
    const link = (await screen.findByRole('link', { name: 'Open link' })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://maps.example.com/cafe-1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('renders no link for anything that is not http(s)', async () => {
    render({ path: `/places?id=${id(3)}` });
    await screen.findByRole('button', { name: 'Log visit' });
    expect(screen.queryByRole('link', { name: 'Open link' })).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it('allows http(s) only', () => {
    expect(safeHref('https://example.com/menu')).toBe('https://example.com/menu');
    expect(safeHref('http://example.com/')).toBe('http://example.com/');
    for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'data:text/html,hi', '/relative', 'example.com', 'ftp://example.com', '', undefined]) expect(safeHref(bad), String(bad)).toBeNull();
  });

  it('the list reply helper counts tags and areas (fixture check)', () => {
    expect(listOf([place(1, { tags: ['wifi'], area: 'Old Town' }), place(2, { tags: ['wifi'] })])).toMatchObject({ tags: [{ tag: 'wifi', n: 2 }], areas: [{ area: 'Old Town', n: 1 }] });
  });
});
