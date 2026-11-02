/**
 * One café's screen (v0.10 spec 0.10 A7.2, A7.4) against the fake API: the
 * header (area, Open link, stars, price, would go again), Log visit, and
 * only the sections that hold something (Ratings, Tags, Dishes with their
 * second line, Visits with the count and the usual spend, Notes); an empty
 * café's + Rating, + Dish and + Tag; Show all paging older visits with
 * `before`; a café that is gone; the deletes (a visit at once with a 5 s
 * Undo; a café with no visits back to the list under its Undo; one with
 * visits asks first, then goes); offline; 44 px targets on touch.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preloadPlaces } from './helpers.js';
import { id, place, render, vid, visit } from './places-helpers.js';

preloadPlaces('places');

afterEach(() => vi.useRealTimers());

const VISITS = {
  [id(1)]: [
    visit(1, 1, { day: '2026-01-12', spend: 45000, stars: 4, had: ['Sample Dosa'], notes: 'Quiet before 11, sockets by the window' }),
    visit(2, 1, { day: '2026-01-05', spend: 38000 }),
    visit(3, 1, { day: '2025-12-28' }),
  ],
};

const section = (name: string) => screen.getByRole('region', { name });

describe('the café screen', () => {
  it('shows the header, Log visit and every section that holds something', async () => {
    render({ path: `/places?id=${id(1)}`, visits: VISITS });
    expect(await screen.findByRole('heading', { level: 1, name: 'Example Café 1' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).className).toContain('break-words');
    expect(screen.getByText('Old Town').className).toContain('type-mono');
    expect(screen.getByRole('link', { name: 'Open link' })).toBeTruthy();
    const head = screen.getByText('₹₹ · would go again').parentElement as HTMLElement;
    expect(within(head).getByRole('img', { name: '4 of 5' })).toBeTruthy();
    const log = screen.getByRole('button', { name: 'Log visit' });
    expect(log.className).toContain('w-full');
    expect(log.className).toContain('coarse:min-h-44');
    // The ratings that are set, labelled, as stars.
    const ratings = within(section('Ratings'));
    expect(ratings.getAllByRole('term').map((t) => t.textContent)).toEqual(['Food', 'Work']);
    expect(ratings.getAllByRole('img').map((i) => i.getAttribute('aria-label'))).toEqual(['5 of 5', '3 of 5']);
    expect(within(section('Tags')).getAllByRole('listitem').map((t) => t.textContent)).toEqual(['Wi-Fi', 'Sockets', 'Quiet', 'Board games']);
    const dishes = within(section('Dishes')).getAllByRole('listitem');
    expect(within(dishes[0]!).getByText('₹180 · order again').className).toContain('type-mono');
    expect(within(dishes[1]!).getByRole('img', { name: '3 of 5' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Visits · 3 · about ₹450' })).toBeTruthy();
    const visits = within(section('Visits · 3 · about ₹450')).getAllByRole('listitem');
    expect(visits).toHaveLength(2);
    expect(within(visits[0]!).getByText('Mon 12 Jan')).toBeTruthy();
    expect(within(visits[0]!).getByText('₹450')).toBeTruthy();
    expect(within(visits[0]!).getByText('Quiet before 11, sockets by the window').className).toContain('line-clamp-2');
    expect(within(section('Notes')).getByText('Go before noon.')).toBeTruthy();
    // Nothing is missing, so no + prompts.
    expect(screen.queryByRole('button', { name: 'Rating' })).toBeNull();
  });

  it('Show all pages older visits with before', async () => {
    const { api } = render({ path: `/places?id=${id(1)}`, visits: VISITS });
    fireEvent.click(await screen.findByRole('button', { name: 'Show all' }));
    await waitFor(() => expect(api.placeGet).toHaveBeenCalledWith(id(1), vid(2)));
    await waitFor(() => expect(within(section('Visits · 3 · about ₹450')).getAllByRole('listitem')).toHaveLength(3));
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
  });

  it('an empty café shows Log visit and + Rating, + Dish and + Tag, and no sections', async () => {
    render({ places: [place(7, { tried: false })], path: `/places?id=${id(7)}` });
    await screen.findByRole('button', { name: 'Log visit' });
    for (const name of ['Rating', 'Dish', 'Tag']) expect(screen.getByRole('button', { name })).toBeTruthy();
    for (const name of ['Ratings', 'Tags', 'Dishes', 'Notes']) expect(screen.queryByRole('region', { name })).toBeNull();
    expect(screen.queryByRole('heading', { name: /^Visits/ })).toBeNull();
    expect(screen.getByText('want')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dish' }));
    expect(await screen.findByRole('dialog', { name: 'New dish' })).toBeTruthy();
  });

  it('says so when the café is gone', async () => {
    render({ path: `/places?id=${id(9)}` });
    expect(await screen.findByText(/That café is gone/)).toBeTruthy();
  });

  it('Edit opens the café sheet; a dish and a visit open their own sheets', async () => {
    render({ path: `/places?id=${id(1)}`, visits: VISITS });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('dialog', { name: 'Example Café 1' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(within(section('Dishes')).getByText('Sample Coffee'));
    expect(await screen.findByRole('dialog', { name: 'Sample Coffee' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByText('Mon 12 Jan'));
    expect(await screen.findByRole('dialog', { name: 'Visit' })).toBeTruthy();
  });

  it('offline: Log visit and Edit are off', async () => {
    render({ path: `/places?id=${id(1)}`, conn: 'offline' });
    expect(((await screen.findByRole('button', { name: 'Log visit' })) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('deletes (spec 0.10 A7.4)', () => {
  it('a visit leaves at once with a 5 s Undo; Undo puts it back; else the delete is sent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const placeVisitDelete = vi.fn(async () => ({ ok: true as const }));
    render({ path: `/places?id=${id(1)}`, visits: VISITS, api: { placeVisitDelete } });
    const open = async () => {
      fireEvent.click(await screen.findByText('Mon 12 Jan'));
      return screen.findByRole('dialog', { name: 'Visit' });
    };
    fireEvent.click(within(await open()).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('Mon 12 Jan')).toBeNull());
    expect(screen.getByText('Deleted: the visit of Mon 12 Jan')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Mon 12 Jan')).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(6_000));
    expect(placeVisitDelete).not.toHaveBeenCalled();
    fireEvent.click(within(await open()).getByRole('button', { name: 'Delete' }));
    await act(async () => vi.advanceTimersByTime(5_100));
    expect(placeVisitDelete).toHaveBeenCalledWith(id(1), vid(1), expect.any(String));
  });

  it('a café with no visits goes back to the list under a 5 s Undo, and the delete is sent when it goes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const placeDelete = vi.fn(async () => ({ ok: true as const }));
    const { router } = render({ path: `/places?sort=name&id=${id(2)}`, api: { placeDelete } });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const sheet = await screen.findByRole('dialog', { name: 'Example Café 2' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(router.getState().route).toEqual({ name: 'places', sort: 'name' }));
    await screen.findByRole('list', { name: 'Cafés' });
    expect(screen.queryByText('Example Café 2')).toBeNull();
    expect(screen.getByText('Deleted: Example Café 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Example Café 2')).toBeTruthy();
    expect(placeDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Example Café 2'));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Example Café 2' })).getByRole('button', { name: 'Delete' }));
    await act(async () => vi.advanceTimersByTime(5_100));
    expect(placeDelete).toHaveBeenCalledWith(id(2), expect.any(String));
  });

  it('a café with visits asks first, naming them; Cancel keeps it; Delete sends it and goes back to the list', async () => {
    const placeDelete = vi.fn(async () => ({ ok: true as const }));
    const { router } = render({ path: `/places?id=${id(1)}`, visits: VISITS, api: { placeDelete } });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    let sheet = await screen.findByRole('dialog', { name: 'Example Café 1' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));
    const ask = within(sheet).getByRole('group', { name: 'Delete' });
    expect(within(ask).getByText('Delete Example Café 1 and its 3 visits?')).toBeTruthy();
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(within(sheet).queryByRole('group', { name: 'Delete' })).toBeNull();
    expect(placeDelete).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(within(sheet).getByRole('group', { name: 'Delete' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(placeDelete).toHaveBeenCalledWith(id(1), expect.any(String)));
    await waitFor(() => expect(router.getState().route).toEqual({ name: 'places' }));
    sheet = screen.queryByRole('dialog') as HTMLElement;
    expect(sheet).toBeNull();
    // No Undo for it: it is gone.
    expect(screen.queryByText(/^Deleted:/)).toBeNull();
  });
});
