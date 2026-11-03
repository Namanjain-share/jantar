/**
 * 0.13.0 one search across Jantar (W22, design 9, F1): the phone header's
 * magnifier on every screen and ⌘K at any width open the same sheet,
 * "Search or jump". Two characters or more ask GET /v1/search once typing
 * stops for 150 ms; its groups come in its order (Clients, Projects, Deals,
 * Todos, Meetings), then the phone's own Sessions, then Intel, Cafés and
 * Posts, then the places (Work…) and the accounts; "Search Intel only" is
 * last while Intel is on. A row opens its place. One character asks
 * nothing; a device without control never asks (the route is a control
 * read); an answer for older words is never shown for newer ones; a reply
 * that isn't one of the app's own paths is dropped. Made-up names only.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SearchResponse } from '@jantar/protocol/work';
import { ApiError } from '../../src/lib/api.js';
import { writeLocal } from '../../src/lib/storage.js';
import { LOCAL_DEVICE_KEY } from '../../src/ui/screens/devices/local.js';
import { layoutAt } from '../../src/ui/shell/layout.js';
import { fakeApi, renderApp, session, stateWith } from '../helpers.js';
import { IDS, WORK_ON, workRequest } from '../work-helpers.js';

const RESULTS: SearchResponse = {
  groups: [
    { kind: 'client', items: [{ kind: 'client', id: IDS.client, label: 'Acme', sub: 'client', href: `/work?tab=clients&id=${IDS.client}` }] },
    { kind: 'project', items: [{ kind: 'project', id: IDS.acme, label: 'Site rebuild', sub: 'active', href: `/work?tab=projects&id=${IDS.acme}` }] },
    { kind: 'todo', items: [{ kind: 'todo', id: IDS.todo1, label: 'Send wireframes', href: `/todos?id=${IDS.todo1}` }, { kind: 'todo', id: IDS.todo2, label: 'Off-site', href: '//elsewhere.example/x' }] },
    { kind: 'meeting', items: [{ kind: 'meeting', id: IDS.meeting, label: 'Kickoff call', sub: '2026-01-13', href: `/meetings?id=${IDS.meeting}` }] },
    { kind: 'session', items: [{ kind: 'session', id: 'acme-web', label: 'acme-web', href: '/s/acme-web' }] },
    { kind: 'post', items: [{ kind: 'post', id: '01JWRKP0ST000000000000000A', label: 'Launch notes', href: '/posts?id=01JWRKP0ST000000000000000A' }] },
  ],
};

function setup(o: { layout?: NonNullable<Parameters<typeof renderApp>[0]>['layout']; search?: (init: { query?: Record<string, unknown> }) => unknown } = {}) {
  const request = workRequest({ 'GET /v1/search': o.search ?? (() => RESULTS) });
  const api = fakeApi({ lifeStatus: vi.fn(async () => WORK_ON()), request });
  const r = renderApp({ api, state: stateWith({ sessions: [session('acme-web', { folder: 'acme-web' }), session('notes')], features: { life: true, intel: true } }), ...(o.layout ? { layout: o.layout } : {}) });
  return { ...r, request };
}

const openSheet = async () => {
  fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Search' }));
  return screen.findByRole('dialog', { name: 'Search or jump' });
};
const headings = (sheet: HTMLElement) => [...sheet.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent);
const type = (sheet: HTMLElement, text: string) => fireEvent.change(within(sheet).getByPlaceholderText('Search or jump'), { target: { value: text } });

describe('one search across Jantar', () => {
  it("on a phone: the daemon's groups in its order around the phone's own sessions, Places, then Search Intel only", async () => {
    const { request, history } = setup();
    // Work shows among the places once Life status says it is on.
    await screen.findByRole('link', { name: /Work/ });
    const sheet = await openSheet();
    type(sheet, 'acme');
    await within(sheet).findByRole('option', { name: /Site rebuild/ });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ method: 'GET', path: '/v1/search' }, { query: { q: 'acme' }, signal: expect.any(AbortSignal) });
    expect(headings(sheet)).toEqual(['Clients', 'Projects', 'Todos', 'Meetings', 'Sessions', 'Posts']);
    // The phone's own session row (with its glyph), never the daemon's twice; a reply off the app is dropped.
    expect(within(sheet).getAllByRole('option', { name: /acme-web/ })).toHaveLength(1);
    expect(within(sheet).queryByRole('option', { name: /Off-site/ })).toBeNull();
    // Search Intel only, last.
    const options = within(sheet).getAllByRole('option');
    expect(options.at(-1)?.textContent).toMatch(/Search Intel only/);
    fireEvent.click(within(sheet).getByRole('option', { name: /Site rebuild/ }));
    expect(history.entries.at(-1)).toBe(`/work?tab=projects&id=${IDS.acme}`);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search or jump' })).toBeNull());
  });

  it('places are rows too: Work opens Work', async () => {
    const { history } = setup();
    await screen.findByRole('link', { name: /Work/ });
    const sheet = await openSheet();
    type(sheet, 'w');
    const work = await within(sheet).findByRole('option', { name: 'Work' });
    fireEvent.click(work);
    expect(history.entries.at(-1)).toBe('/work');
  });

  it('one character asks nothing; the words wait 150 ms; an older answer never shows for newer words', async () => {
    let answer: (r: SearchResponse) => void = () => undefined;
    const { request } = setup({ search: () => new Promise<SearchResponse>((r) => (answer = r)) });
    const sheet = await openSheet();
    type(sheet, 'a');
    await act(async () => new Promise((r) => setTimeout(r, 200)));
    expect(request).not.toHaveBeenCalled();
    type(sheet, 'ac');
    expect(request).not.toHaveBeenCalled();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(within(sheet).getByText('Searching…')).toBeTruthy();
    type(sheet, 'acm');
    await act(async () => answer(RESULTS));
    // The answer was for "ac": nothing of it shows for "acm".
    expect(within(sheet).queryByRole('option', { name: /Site rebuild/ })).toBeNull();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[1]).toMatchObject({ query: { q: 'acm' } });
    await act(async () => answer(RESULTS));
    expect(await within(sheet).findByRole('option', { name: /Site rebuild/ })).toBeTruthy();
  });

  it('on a phone, Cancel beside the box closes the sheet; ⌘K on the Mac has none', async () => {
    setup();
    const sheet = await openSheet();
    const cancel = within(sheet).getByRole('button', { name: 'Cancel' });
    expect(cancel.className).toContain('h-52');
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search or jump' })).toBeNull());
  });

  it('a search that fails says why, never "Nothing matches."', async () => {
    const offline = new ApiError('network', 'Failed to fetch', 0);
    const broken = new ApiError('life_unavailable', 'Life is unavailable: life.db could not be opened. See it at your Mac: jantar life status', 503);
    let fail: ApiError = offline;
    setup({ search: () => fail });
    const sheet = await openSheet();
    type(sheet, 'zzqx');
    expect(await within(sheet).findByRole('alert')).toBeTruthy();
    expect(within(sheet).getByRole('alert').textContent).toBe('Could not reach the Mac. Check the connection and try again.');
    expect(within(sheet).queryByText('Nothing matches.')).toBeNull();
    fail = broken;
    type(sheet, 'zzqy');
    await waitFor(() => expect(within(sheet).getByRole('alert').textContent).toBe(broken.message));
    expect(within(sheet).queryByText('Nothing matches.')).toBeNull();
  });

  it('a device paired without control never asks: its own sessions only', async () => {
    writeLocal(LOCAL_DEVICE_KEY, { id: 'dev-2', name: 'Phone', scopes: ['read'] });
    const { request } = setup();
    const sheet = await openSheet();
    type(sheet, 'acme');
    expect(await within(sheet).findByRole('option', { name: /acme-web/ })).toBeTruthy();
    await act(async () => new Promise((r) => setTimeout(r, 200)));
    expect(request).not.toHaveBeenCalled();
  });

  it('⌘K on the Mac is the same search', async () => {
    const { request } = setup({ layout: layoutAt(1440) });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const sheet = await screen.findByRole('dialog', { name: 'Search or jump' });
    type(sheet, 'kickoff');
    expect(await within(sheet).findByRole('option', { name: /Kickoff call/ })).toBeTruthy();
    expect(request).toHaveBeenCalledWith({ method: 'GET', path: '/v1/search' }, expect.objectContaining({ query: { q: 'kickoff' } }));
    // Esc closes it on the Mac: no Cancel beside the box.
    expect(within(sheet).queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});
