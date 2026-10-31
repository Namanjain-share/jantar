/**
 * Cafés (v0.4 spec 4.7, 5.6, 5.10; gate LW2 for places) against the fake
 * API: best first as the daemon sends them, All | Tried | Want to try, the
 * row (area, best dish and its stars, `want`), the place sheet (create,
 * edit with dishes replaced wholesale, a link that must be https, Delete
 * that asks nothing: the list holds it back under a 5 s Undo that puts it
 * back exactly), `?id=` opening one place, and every state with the
 * <h1>. A link opens only for http(s), in a new tab with no opener and no
 * referrer; anything else is text, and a hostile name renders as text.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Place } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import { safeHref } from '../src/ui/screens/life/places/PlaceSheet.js';
import { bestDish } from '../src/ui/screens/life/places/Places.js';
import { fakeApi, iso, renderApp, stateWith } from './helpers.js';

afterEach(() => vi.useRealTimers());

const id = (n: number) => `01JFZ8X8Y3T0V5G9WQK2M4N${String(n).padStart(3, '0')}`;

function place(n: number, over: Partial<Place> = {}): Place {
  return { id: id(n), name: `Example Café ${n}`, tried: true, dishes: [], best: null, createdAt: iso(0), updatedAt: iso(0), ...over };
}

const PLACES: Place[] = [
  place(1, { area: 'Old Town', link: 'https://maps.example.com/cafe-1', dishes: [{ name: 'Sample Dosa', rating: 5 }, { name: 'Sample Coffee', rating: 3 }], best: 5 }),
  place(2, { tried: false, dishes: [{ name: 'Sample Toast', rating: 3 }], best: 3 }),
  place(3, { name: '<img src=x onerror="window.__pwned=1">', link: 'javascript:alert(1)' as string }),
];

function render(opts: { places?: Place[]; list?: (f?: string) => Promise<{ places: Place[] }>; path?: string; api?: Parameters<typeof fakeApi>[0]; conn?: 'live' | 'offline' } = {}) {
  const api = fakeApi({ placesList: vi.fn(opts.list ?? (async () => ({ places: opts.places ?? PLACES }))), ...opts.api });
  return renderApp({ path: opts.path ?? '/places', api, state: stateWith({ features: { life: true } }), ...(opts.conn ? { status: opts.conn } : {}) });
}

const heading = () => screen.findByRole('heading', { level: 1, name: 'Cafés' });

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

  it('keeps the daemon order (best first) and shows area, best dish with stars, and want', async () => {
    render();
    const list = await screen.findByRole('list', { name: 'Cafés' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.font-medium')?.textContent)).toEqual(['Example Café 1', 'Example Café 2', '<img src=x onerror="window.__pwned=1">']);
    expect(within(rows[0]!).getByText('Old Town').className).toContain('type-mono');
    expect(within(rows[0]!).getByText('Sample Dosa')).toBeTruthy();
    expect(within(rows[0]!).getByRole('img', { name: '5 of 5' }).querySelectorAll('svg')).toHaveLength(5);
    expect(within(rows[0]!).queryByText('want')).toBeNull();
    expect(within(rows[1]!).getByText('want')).toBeTruthy();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('filters through the route', async () => {
    const { api, router } = render();
    await screen.findByRole('list', { name: 'Cafés' });
    expect(api.placesList).toHaveBeenCalledWith('all');
    fireEvent.click(screen.getByRole('button', { name: 'Want to try' }));
    expect(router.getState().route).toEqual({ name: 'places', filter: 'want' });
    await waitFor(() => expect(api.placesList).toHaveBeenCalledWith('want'));
  });

  it('says so when the list is empty, with an add button', async () => {
    const a = render({ places: [] });
    expect(await screen.findByText('No cafés yet.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Add café' })).toHaveLength(2);
    a.unmount();
    render({ places: [], path: '/places?filter=tried' });
    expect(await screen.findByText('No cafés tried yet.')).toBeTruthy();
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

  it('is 44 px on touch: a row with no dish, and each star of a rating', async () => {
    render();
    const name = await screen.findByText('<img src=x onerror="window.__pwned=1">');
    expect((name.closest('button') as HTMLElement).className).toContain('coarse:min-h-44');
    fireEvent.click(await screen.findByText('Example Café 1'));
    const sheet = await screen.findByRole('dialog', { name: 'Example Café 1' });
    const stars = within(within(sheet).getByRole('radiogroup', { name: 'Rating for Sample Dosa' })).getAllByRole('radio');
    for (const s of stars) expect(s.className).toContain('coarse:size-44');
  });

  it('picks the best dish', () => {
    expect(bestDish(PLACES[0]!)?.name).toBe('Sample Dosa');
    expect(bestDish(place(9, { dishes: [{ name: 'A', rating: 2 }, { name: 'B', rating: 4 }, { name: 'C', rating: 4 }] }))?.name).toBe('B');
    expect(bestDish(place(9))).toBeNull();
  });
});

describe('Cafés: links (LW2)', () => {
  it('opens an https link in a new tab with no opener and no referrer', async () => {
    render();
    fireEvent.click(await screen.findByText('Example Café 1'));
    const sheet = await screen.findByRole('dialog', { name: 'Example Café 1' });
    const link = within(sheet).getByRole('link', { name: 'Open link' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://maps.example.com/cafe-1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('renders no link for anything that is not http(s)', async () => {
    render();
    fireEvent.click(await screen.findByText('<img src=x onerror="window.__pwned=1">'));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).queryByRole('link')).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it('allows http(s) only', () => {
    expect(safeHref('https://example.com/menu')).toBe('https://example.com/menu');
    expect(safeHref('http://example.com/')).toBe('http://example.com/');
    for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'data:text/html,hi', '/relative', 'example.com', 'ftp://example.com', '', undefined]) expect(safeHref(bad), String(bad)).toBeNull();
  });
});

describe('Cafés: the place sheet', () => {
  it('adds a place with its dishes and ratings', async () => {
    const placeCreate = vi.fn(async () => ({ id: id(20) }));
    render({ api: { placeCreate } });
    await screen.findByRole('list', { name: 'Cafés' });
    fireEvent.click(screen.getByRole('button', { name: 'Add café' }));
    const sheet = await screen.findByRole('dialog', { name: 'New café' });
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Example Corner' } });
    fireEvent.change(within(sheet).getByLabelText('Area'), { target: { value: 'Market Road' } });
    fireEvent.change(within(sheet).getByLabelText('Link'), { target: { value: 'https://maps.example.com/corner' } });
    expect(within(sheet).getByRole('link', { name: 'Open link' })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('switch'));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add dish' }));
    fireEvent.change(within(sheet).getByLabelText('Dish'), { target: { value: 'Sample Idli' } });
    const add = within(sheet).getByRole('button', { name: 'Add café' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(within(sheet).getByText('Give each dish 1 to 5 stars.')).toBeTruthy();
    const rating = within(sheet).getByRole('radiogroup', { name: 'Rating for Sample Idli' });
    // No rating yet: nothing checked, and Tab lands on the first star.
    expect(within(rating).getAllByRole('radio').map((r) => [r.getAttribute('aria-checked'), r.tabIndex])).toEqual([['false', 0], ['false', -1], ['false', -1], ['false', -1], ['false', -1]]);
    fireEvent.click(within(rating).getByRole('radio', { name: '4 stars' }));
    // One choice, not four pressed toggles; the arrows move it.
    expect(within(rating).getAllByRole('radio', { checked: true }).map((r) => r.getAttribute('aria-label'))).toEqual(['4 stars']);
    fireEvent.keyDown(within(rating).getByRole('radio', { name: '4 stars' }), { key: 'ArrowLeft' });
    expect(within(rating).getByRole('radio', { checked: true }).getAttribute('aria-label')).toBe('3 stars');
    expect(document.activeElement).toBe(within(rating).getByRole('radio', { name: '3 stars' }));
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    fireEvent.click(add);
    await waitFor(() =>
      expect(placeCreate).toHaveBeenCalledWith(
        { name: 'Example Corner', tried: true, dishes: [{ name: 'Sample Idli', rating: 4 }], area: 'Market Road', link: 'https://maps.example.com/corner' },
        expect.any(String),
      ),
    );
  });

  it('refuses a link that is not https', async () => {
    render();
    await screen.findByRole('list', { name: 'Cafés' });
    fireEvent.click(screen.getByRole('button', { name: 'Add café' }));
    const sheet = await screen.findByRole('dialog', { name: 'New café' });
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Example' } });
    fireEvent.change(within(sheet).getByLabelText('Link'), { target: { value: 'http://maps.example.com/x' } });
    expect(within(sheet).getByText('Use a link that starts with https://')).toBeTruthy();
    expect(within(sheet).queryByRole('link')).toBeNull();
    expect((within(sheet).getByRole('button', { name: 'Add café' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('edits: dishes are sent whole, and a cleared field is null', async () => {
    const placeUpdate = vi.fn(async () => ({ ok: true as const }));
    render({ api: { placeUpdate } });
    fireEvent.click(await screen.findByText('Example Café 1'));
    const sheet = await screen.findByRole('dialog', { name: 'Example Café 1' });
    fireEvent.change(within(sheet).getByLabelText('Area'), { target: { value: '' } });
    fireEvent.click(within(within(sheet).getByRole('radiogroup', { name: 'Rating for Sample Coffee' })).getByRole('radio', { name: '1 star' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove Sample Dosa' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(placeUpdate).toHaveBeenCalledWith(id(1), { area: null, dishes: [{ name: 'Sample Coffee', rating: 1 }] }, expect.any(String)));
  });

  it('Delete asks nothing: the sheet closes, the café leaves the list with a 5 s Undo, and the delete is sent when it goes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const placeDelete = vi.fn(async () => ({ ok: true as const }));
    const { api } = render({ api: { placeDelete } });
    const open = async (name: string) => {
      fireEvent.click(await screen.findByText(name));
      return screen.findByRole('dialog', { name });
    };
    let sheet = await open('Example Café 2');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('Example Café 2')).toBeNull();
    expect(screen.getByText('Deleted: Example Café 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    const names = () => within(screen.getByRole('list', { name: 'Cafés' })).getAllByRole('listitem').map((r) => r.querySelector('.font-medium')?.textContent);
    expect(names()).toEqual(['Example Café 1', 'Example Café 2', '<img src=x onerror="window.__pwned=1">']);
    await act(async () => vi.advanceTimersByTime(6_000));
    expect(placeDelete).not.toHaveBeenCalled();

    sheet = await open('Example Café 2');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));
    await act(async () => vi.advanceTimersByTime(5_100));
    expect(placeDelete).toHaveBeenCalledWith(id(2), expect.any(String));
    await waitFor(() => expect(api.placesList).toHaveBeenCalledTimes(2));
  });

  it('a held delete that fails brings the café back with Not saved', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const placeDelete = vi.fn(async (): Promise<never> => {
      throw new ApiError('network', 'offline', 0);
    });
    render({ api: { placeDelete } });
    fireEvent.click(await screen.findByText('Example Café 1'));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Example Café 1' })).getByRole('button', { name: 'Delete' }));
    await act(async () => vi.advanceTimersByTime(5_100));
    expect(await screen.findByText('Example Café 1')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/^Not saved\. Could not reach the Mac/);
  });

  it('a failed save keeps the sheet open with Not saved', async () => {
    const placeUpdate = vi.fn(async (): Promise<never> => {
      throw new ApiError('conflict', 'You have 1,000 places. Delete some first.', 409);
    });
    render({ api: { placeUpdate } });
    fireEvent.click(await screen.findByText('Example Café 2'));
    const sheet = await screen.findByRole('dialog', { name: 'Example Café 2' });
    fireEvent.click(within(sheet).getByRole('switch'));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect((await within(sheet).findByRole('alert')).textContent).toBe('Not saved. You have 1,000 places. Delete some first.');
    expect((within(sheet).getByRole('switch') as HTMLInputElement).checked).toBe(true);
  });

  it('?id= opens that place on arrival', async () => {
    render({ path: `/places?id=${id(2)}` });
    expect(await screen.findByRole('dialog', { name: 'Example Café 2' })).toBeTruthy();
  });
});
