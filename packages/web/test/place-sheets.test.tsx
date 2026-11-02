/**
 * The café, dish and visit sheets (v0.10 spec 0.10 A7.3) against the fake
 * API: what each one sends. Add café sends only what is set (stars, a price
 * level, would go again, sub-ratings, tags with a custom one, dishes that
 * may wait to be rated); Edit only the keys that changed (a cleared value
 * is null, the sub-ratings per key, the tags as a list); a dish saves the
 * whole list with it in its place, and its Delete has an Undo that puts the
 * list back; a visit is today by default and never later, picks what was
 * had from the dishes or typed, may rate them, and an edit sends nulls for
 * what was cleared. A link must be https. Ratings are labelled radio
 * groups with 44 px stars on touch; the price segments say their level.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api.js';
import { withRatings } from '../src/ui/screens/life/places/VisitSheet.js';
import { preloadPlaces } from './helpers.js';
import { DAY, id, place, render, vid, visit } from './places-helpers.js';

preloadPlaces('places');

afterEach(() => vi.useRealTimers());

const star = (sheet: HTMLElement, group: string, n: number) =>
  fireEvent.click(within(within(sheet).getByRole('radiogroup', { name: group })).getByRole('radio', { name: n === 1 ? '1 star' : `${n} stars` }));

async function openAdd() {
  await screen.findByRole('list', { name: 'Cafés' });
  fireEvent.click(screen.getByRole('button', { name: 'Add café' }));
  return screen.findByRole('dialog', { name: 'New café' });
}

async function openEdit(n: number) {
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  return screen.findByRole('dialog', { name: `Example Café ${n}` });
}

describe('the café sheet', () => {
  it('adds a café with stars, price, would go again, sub-ratings, tags (one custom) and a dish not tried yet', async () => {
    const placeCreate = vi.fn(async () => ({ id: id(20) }));
    render({ api: { placeCreate } });
    const sheet = await openAdd();
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Example Corner' } });
    fireEvent.change(within(sheet).getByLabelText('Area'), { target: { value: 'Market Road' } });
    fireEvent.change(within(sheet).getByLabelText('Link'), { target: { value: 'https://maps.example.com/corner' } });
    expect(within(sheet).getByRole('link', { name: 'Open link' })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('switch', { name: 'Tried it' }));
    star(sheet, 'Stars', 4);
    const price = within(sheet).getByRole('group', { name: 'Price' });
    expect(within(price).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['No price', 'Price level 1 of 4', 'Price level 2 of 4', 'Price level 3 of 4', 'Price level 4 of 4']);
    expect(within(price).getAllByRole('button').map((b) => b.textContent)).toEqual(['None', '₹', '₹₹', '₹₹₹', '₹₹₹₹']);
    fireEvent.click(within(price).getByRole('button', { name: 'Price level 2 of 4' }));
    fireEvent.click(within(within(sheet).getByRole('group', { name: 'Would go again' })).getByRole('button', { name: 'Maybe' }));
    // More ratings is closed until opened (nothing set yet).
    expect(within(sheet).queryByRole('radiogroup', { name: 'Food rating' })).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'More ratings' }));
    star(sheet, 'Food rating', 5);
    star(sheet, 'Work rating', 3);
    const tags = within(sheet).getByRole('group', { name: 'Tags' });
    expect(tags.className).toContain('flex-wrap');
    fireEvent.click(within(tags).getByRole('button', { name: 'Wi-Fi' }));
    fireEvent.click(within(tags).getByRole('button', { name: 'Quiet' }));
    expect(within(tags).getByRole('button', { name: 'Wi-Fi' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(tags).getByRole('button', { name: 'Other…' }));
    fireEvent.change(within(sheet).getByLabelText('New tag'), { target: { value: 'Board games' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add tag' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add dish' }));
    fireEvent.change(within(sheet).getByLabelText('Dish'), { target: { value: 'Sample Idli' } });
    expect(within(sheet).getByText('A dish with no stars is one to try.')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add café' }));
    await waitFor(() =>
      expect(placeCreate).toHaveBeenCalledWith(
        {
          name: 'Example Corner',
          tried: true,
          dishes: [{ name: 'Sample Idli' }],
          area: 'Market Road',
          link: 'https://maps.example.com/corner',
          stars: 4,
          ratings: { food: 5, work: 3 },
          price: 2,
          again: 'maybe',
          tags: ['wifi', 'quiet', 'Board games'],
        },
        expect.any(String),
      ),
    );
  });

  it('a label typed as a tag is kept as its key', async () => {
    const placeCreate = vi.fn(async () => ({ id: id(20) }));
    render({ api: { placeCreate } });
    const sheet = await openAdd();
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Example Corner' } });
    fireEvent.click(within(within(sheet).getByRole('group', { name: 'Tags' })).getByRole('button', { name: 'Other…' }));
    fireEvent.change(within(sheet).getByLabelText('New tag'), { target: { value: 'open LATE' } });
    fireEvent.keyDown(within(sheet).getByLabelText('New tag'), { key: 'Enter' });
    expect(within(within(sheet).getByRole('group', { name: 'Tags' })).getByRole('button', { name: 'Open late' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add café' }));
    await waitFor(() => expect(placeCreate).toHaveBeenCalledWith({ name: 'Example Corner', tried: false, dishes: [], tags: ['late'] }, expect.any(String)));
  });

  it('refuses a link that is not https', async () => {
    render();
    const sheet = await openAdd();
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Example' } });
    fireEvent.change(within(sheet).getByLabelText('Link'), { target: { value: 'http://maps.example.com/x' } });
    expect(within(sheet).getByText('Use a link that starts with https://')).toBeTruthy();
    expect(within(sheet).queryByRole('link')).toBeNull();
    expect((within(sheet).getByRole('button', { name: 'Add café' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('edits: only the keys that changed; Clear and None send null; sub-ratings per key; tags as a list', async () => {
    const placeUpdate = vi.fn(async () => ({ ok: true as const }));
    render({ path: `/places?id=${id(1)}`, api: { placeUpdate } });
    const sheet = await openEdit(1);
    // More ratings is open: some are set.
    expect(within(sheet).getByRole('radiogroup', { name: 'Food rating' })).toBeTruthy();
    expect(within(sheet).queryByLabelText('Dish')).toBeNull();
    fireEvent.change(within(sheet).getByLabelText('Area'), { target: { value: '' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Clear the stars' }));
    fireEvent.click(within(within(sheet).getByRole('group', { name: 'Price' })).getByRole('button', { name: 'No price' }));
    fireEvent.click(within(within(sheet).getByRole('group', { name: 'Would go again' })).getByRole('button', { name: 'No' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Clear Food' }));
    star(sheet, 'Service rating', 2);
    fireEvent.click(within(within(sheet).getByRole('group', { name: 'Tags' })).getByRole('button', { name: 'Quiet' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(placeUpdate).toHaveBeenCalledWith(
        id(1),
        { area: null, stars: null, price: null, again: 'no', ratings: { food: null, service: 2 }, tags: ['wifi', 'sockets', 'Board games'] },
        expect.any(String),
      ),
    );
  });

  it('a save with nothing changed sends nothing', async () => {
    const placeUpdate = vi.fn(async () => ({ ok: true as const }));
    render({ path: `/places?id=${id(1)}`, api: { placeUpdate } });
    const sheet = await openEdit(1);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(placeUpdate).not.toHaveBeenCalled();
  });

  it('a failed save keeps the sheet open with Not saved', async () => {
    const placeUpdate = vi.fn(async (): Promise<never> => {
      throw new ApiError('conflict', 'You have 1,000 cafés. Delete one to add another.', 409);
    });
    render({ path: `/places?id=${id(2)}`, api: { placeUpdate } });
    const sheet = await openEdit(2);
    fireEvent.click(within(sheet).getByRole('switch', { name: 'Tried it' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect((await within(sheet).findByRole('alert')).textContent).toBe('Not saved. You have 1,000 cafés. Delete one to add another.');
    expect((within(sheet).getByRole('switch', { name: 'Tried it' }) as HTMLInputElement).checked).toBe(true);
  });

  it('is 44 px on touch: each star, each price segment, each tag chip', async () => {
    render({ path: `/places?id=${id(1)}` });
    const sheet = await openEdit(1);
    for (const s of within(within(sheet).getByRole('radiogroup', { name: 'Stars' })).getAllByRole('radio')) expect(s.className).toContain('coarse:size-44');
    expect(within(sheet).getByRole('group', { name: 'Price' }).className).toContain('coarse:h-44');
    for (const c of within(within(sheet).getByRole('group', { name: 'Tags' })).getAllByRole('button')) expect(c.className).toContain('coarse:h-44');
  });
});

describe('the dish sheet', () => {
  it('adds a dish with stars, a price, order again and notes; the whole list goes', async () => {
    const placeUpdate = vi.fn(async () => ({ ok: true as const }));
    render({ path: `/places?id=${id(1)}`, api: { placeUpdate } });
    fireEvent.click(await screen.findByRole('button', { name: 'Dish' }));
    const sheet = await screen.findByRole('dialog', { name: 'New dish' });
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Cardamom bun' } });
    expect(within(sheet).getByText('Not tried yet')).toBeTruthy();
    star(sheet, 'Rating for Cardamom bun', 5);
    fireEvent.change(within(sheet).getByLabelText('Price'), { target: { value: '180' } });
    fireEvent.click(within(sheet).getByRole('switch', { name: 'Would order again' }));
    fireEvent.change(within(sheet).getByLabelText('Notes'), { target: { value: 'Warm is best' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add dish' }));
    await waitFor(() =>
      expect(placeUpdate).toHaveBeenCalledWith(
        id(1),
        {
          dishes: [
            { name: 'Sample Dosa', rating: 5, price: 18000, again: true },
            { name: 'Sample Coffee', rating: 3 },
            { name: 'Cardamom bun', rating: 5, price: 18000, again: true, notes: 'Warm is best' },
          ],
        },
        expect.any(String),
      ),
    );
  });

  it('edits one in its place; a cleared rating leaves it untried; Delete has an Undo that puts the list back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const placeUpdate = vi.fn(async () => ({ ok: true as const }));
    render({ path: `/places?id=${id(1)}`, api: { placeUpdate } });
    fireEvent.click(await screen.findByText('Sample Coffee'));
    let sheet = await screen.findByRole('dialog', { name: 'Sample Coffee' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Clear the stars' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(placeUpdate).toHaveBeenLastCalledWith(id(1), { dishes: [{ name: 'Sample Dosa', rating: 5, price: 18000, again: true }, { name: 'Sample Coffee' }] }, expect.any(String)));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByText('Sample Dosa'));
    sheet = await screen.findByRole('dialog', { name: 'Sample Dosa' });
    // The stored price shows as typed, and untouched it is kept as it was.
    expect((within(sheet).getByLabelText('Price') as HTMLInputElement).value).toBe('180');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(placeUpdate).toHaveBeenLastCalledWith(id(1), { dishes: [{ name: 'Sample Coffee', rating: 3 }] }, expect.any(String)));
    expect(await screen.findByText('Deleted: Sample Dosa')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(placeUpdate).toHaveBeenLastCalledWith(id(1), {
        dishes: [
          { name: 'Sample Dosa', rating: 5, price: 18000, again: true },
          { name: 'Sample Coffee', rating: 3 },
        ],
      }),
    );
  });
});

describe('the visit sheet', () => {
  it('logs a visit: today by default, spend, how it was, what I had (a dish and one typed), notes', async () => {
    const placeVisitAdd = vi.fn(async () => ({ id: vid(9) }));
    render({ path: `/places?id=${id(1)}`, api: { placeVisitAdd } });
    fireEvent.click(await screen.findByRole('button', { name: 'Log visit' }));
    const sheet = await screen.findByRole('dialog', { name: 'Log visit' });
    const day = within(sheet).getByLabelText('Day') as HTMLInputElement;
    expect(day.value).toBe(DAY);
    expect(day.max).toBe(DAY);
    fireEvent.change(within(sheet).getByLabelText('Spend'), { target: { value: '450' } });
    star(sheet, 'How was it', 4);
    const had = within(sheet).getByRole('group', { name: 'What I had' });
    expect(within(had).getAllByRole('button').map((b) => b.textContent)).toEqual(['Sample Dosa', 'Sample Coffee']);
    fireEvent.click(within(had).getByRole('button', { name: 'Sample Dosa' }));
    fireEvent.change(within(sheet).getByLabelText('Another dish'), { target: { value: 'Flat white' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }));
    fireEvent.change(within(sheet).getByLabelText('Notes'), { target: { value: 'Quiet before 11' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Log visit' }));
    await waitFor(() =>
      expect(placeVisitAdd).toHaveBeenCalledWith(id(1), { day: DAY, spend: 45000, stars: 4, had: ['Sample Dosa', 'Flat white'], notes: 'Quiet before 11' }, expect.any(String)),
    );
  });

  it('a day after today is refused; a bare visit sends the day alone', async () => {
    const placeVisitAdd = vi.fn(async () => ({ id: vid(9) }));
    render({ path: `/places?id=${id(2)}`, api: { placeVisitAdd } });
    fireEvent.click(await screen.findByRole('button', { name: 'Log visit' }));
    const sheet = await screen.findByRole('dialog', { name: 'Log visit' });
    fireEvent.change(within(sheet).getByLabelText('Day'), { target: { value: '2026-01-16' } });
    expect(within(sheet).getByText('A visit can be today or earlier.')).toBeTruthy();
    expect((within(sheet).getByRole('button', { name: 'Log visit' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText('Day'), { target: { value: '2026-01-14' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Log visit' }));
    await waitFor(() => expect(placeVisitAdd).toHaveBeenCalledWith(id(2), { day: '2026-01-14' }, expect.any(String)));
  });

  it('"Also rate the dishes I had" saves their stars to the dish list after the visit (a new one is added)', async () => {
    const placeVisitAdd = vi.fn(async () => ({ id: vid(9) }));
    const placeUpdate = vi.fn(async () => ({ ok: true as const }));
    render({ path: `/places?id=${id(1)}`, api: { placeVisitAdd, placeUpdate } });
    fireEvent.click(await screen.findByRole('button', { name: 'Log visit' }));
    const sheet = await screen.findByRole('dialog', { name: 'Log visit' });
    fireEvent.click(within(within(sheet).getByRole('group', { name: 'What I had' })).getByRole('button', { name: 'Sample Coffee' }));
    fireEvent.change(within(sheet).getByLabelText('Another dish'), { target: { value: 'Flat white' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }));
    fireEvent.click(within(sheet).getByRole('switch', { name: 'Also rate the dishes I had' }));
    star(sheet, 'Rating for Sample Coffee', 5);
    star(sheet, 'Rating for Flat white', 4);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Log visit' }));
    await waitFor(() => expect(placeVisitAdd).toHaveBeenCalledWith(id(1), { day: DAY, had: ['Sample Coffee', 'Flat white'] }, expect.any(String)));
    await waitFor(() =>
      expect(placeUpdate).toHaveBeenCalledWith(
        id(1),
        {
          dishes: [
            { name: 'Sample Dosa', rating: 5, price: 18000, again: true },
            { name: 'Sample Coffee', rating: 5 },
            { name: 'Flat white', rating: 4 },
          ],
        },
        expect.any(String),
      ),
    );
    expect(withRatings([{ name: 'A' }], new Map([['a', 3]]))).toEqual([{ name: 'A', rating: 3 }]);
  });

  it('an edit sends only what changed, null for what was cleared', async () => {
    const placeVisitUpdate = vi.fn(async () => ({ ok: true as const }));
    render({
      path: `/places?id=${id(1)}`,
      visits: { [id(1)]: [visit(1, 1, { day: '2026-01-12', spend: 45000, stars: 4, had: ['Sample Dosa'], notes: 'Quiet before 11' })] },
      api: { placeVisitUpdate },
    });
    fireEvent.click(await screen.findByText('Mon 12 Jan'));
    const sheet = await screen.findByRole('dialog', { name: 'Visit' });
    expect(within(sheet).queryByRole('switch', { name: 'Also rate the dishes I had' })).toBeNull();
    fireEvent.change(within(sheet).getByLabelText('Spend'), { target: { value: '' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Clear how it was' }));
    fireEvent.click(within(within(sheet).getByRole('group', { name: 'What I had' })).getByRole('button', { name: 'Sample Dosa' }));
    fireEvent.change(within(sheet).getByLabelText('Notes'), { target: { value: '' } });
    fireEvent.change(within(sheet).getByLabelText('Day'), { target: { value: '2026-01-11' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(placeVisitUpdate).toHaveBeenCalledWith(id(1), vid(1), { day: '2026-01-11', spend: null, stars: null, had: null, notes: null }, expect.any(String)),
    );
  });

  it('an untouched spend is not sent again', async () => {
    const placeVisitUpdate = vi.fn(async () => ({ ok: true as const }));
    render({ path: `/places?id=${id(1)}`, visits: { [id(1)]: [visit(1, 1, { spend: 45050 })] }, api: { placeVisitUpdate } });
    fireEvent.click(await screen.findByText('Thu 15 Jan'));
    const sheet = await screen.findByRole('dialog', { name: 'Visit' });
    star(sheet, 'How was it', 3);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(placeVisitUpdate).toHaveBeenCalledWith(id(1), vid(1), { stars: 3 }, expect.any(String)));
    await act(async () => undefined);
    expect(place(1).name).toBe('Example Café 1');
  });
});
