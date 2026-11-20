/**
 * 0.14.1 name search in Browse: "Search names in <folder>" above the list,
 * 250 ms after the last keystroke and from 2 characters, clear button and
 * Escape; results in the listing's place (icon, name, the folder it is in,
 * size and age), announced politely; a file opens the viewer, a folder is
 * browsed into and the search ends; "Searching…", "No names match", the
 * truncated footnote and the route's errors as Browse shows them.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileFindEntry, FilesFindResponse } from '@jantar/protocol';
import { ApiError, createApi, type Api } from '../src/lib/api.js';
import type { FilesLocation } from '../src/lib/router.js';
import { Browse } from '../src/ui/screens/files/Browse.js';
import { clearFilesCache, type Loaded } from '../src/ui/screens/files/data.js';
import { FIND_DEBOUNCE_MS, clearKeptSearches, folderOf, searchable } from '../src/ui/screens/files/FindNames.js';
import { layout, listing, pendingForever, renderWith, root } from './files-helpers.js';
import { fakeApi, iso } from './helpers.js';

const ROOTS: Loaded<{ roots: ReturnType<typeof root>[] }> = { data: { roots: [root('r.work', { display: '~/Desktop/work' })] }, error: null, loading: false, reload: () => undefined };

function hit(path: string, over: Partial<FileFindEntry> = {}): FileFindEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { path, name, kind: 'file', size: 12_700, mtime: iso(-7200_000), ...over };
}

function browse(api: Api, path = 'src/') {
  const onLocation = vi.fn((_next: FilesLocation) => undefined);
  const utils = renderWith(<Browse roots={ROOTS} root="r.work" path={path} phone onLocation={onLocation} />, { api });
  return { ...utils, onLocation };
}

const flush = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const field = () => screen.getByRole('textbox', { name: /^Search names in / });

beforeEach(() => {
  clearFilesCache();
  clearKeptSearches();
  layout();
});
afterEach(() => vi.useRealTimers());

describe('the pieces', () => {
  it('a text counts from 2 characters, trimmed; the folder a match is in, from the one searched', () => {
    expect([searchable(''), searchable('a'), searchable(' a '), searchable('ab'), searchable('  ab '), searchable('é'), searchable('日本')]).toEqual([null, null, null, 'ab', 'ab', null, '日本']);
    expect(folderOf('src/auth/session.ts', 'src')).toBe('auth');
    expect(folderOf('src/session.ts', 'src')).toBe('');
    expect(folderOf('a/b/c.txt', '')).toBe('a/b');
  });

  it('the client asks GET /v1/files/find with the folder and the text', async () => {
    const f = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => new Response(JSON.stringify({ entries: [], truncated: false }), { headers: { 'content-type': 'application/json' } }));
    const api = createApi({ fetch: f as unknown as typeof fetch, base: 'http://127.0.0.1:7420' });
    await api.filesFind({ root: 'r.work', path: 'src/a b', q: 'log in' });
    expect(f.mock.calls[0]![0]).toBe('http://127.0.0.1:7420/v1/files/find?root=r.work&path=src%2Fa+b&q=log+in');
  });
});

describe('the field', () => {
  it('sits above the list as a search landmark, named for the folder', async () => {
    const api = fakeApi({ filesList: vi.fn(async () => listing([{ name: 'app.ts', type: 'file', size: 1 }], { path: 'src' })) });
    browse(api);
    await screen.findByRole('button', { name: /app\.ts/ });
    const box = screen.getByRole('search');
    expect(within(box).getByRole('textbox').getAttribute('placeholder')).toBe('Search names in src');
    expect(field().getAttribute('aria-label')).toBe('Search names in src');
    // Above the list: the field comes first in the document.
    const list = screen.getByRole('list', { name: 'src, 1 entries' });
    expect(box.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it(`asks ${FIND_DEBOUNCE_MS} ms after the last keystroke, and only from 2 characters`, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const filesFind = vi.fn(async (): Promise<FilesFindResponse> => ({ entries: [hit('src/login.ts')], truncated: false }));
    const api = fakeApi({ filesList: vi.fn(async () => listing([{ name: 'app.ts', type: 'file', size: 1 }], { path: 'src' })), filesFind });
    browse(api);
    await screen.findByRole('button', { name: /app\.ts/ });
    fireEvent.change(field(), { target: { value: 'l' } });
    await flush(FIND_DEBOUNCE_MS * 2);
    expect(filesFind).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /app\.ts/ })).toBeTruthy();
    fireEvent.change(field(), { target: { value: 'lo' } });
    await flush(FIND_DEBOUNCE_MS - 50);
    fireEvent.change(field(), { target: { value: 'log' } });
    await flush(FIND_DEBOUNCE_MS - 50);
    expect(filesFind).not.toHaveBeenCalled();
    await flush(100);
    expect(filesFind).toHaveBeenCalledTimes(1);
    expect(filesFind).toHaveBeenCalledWith({ root: 'r.work', path: 'src', q: 'log' }, { signal: expect.any(AbortSignal) });
    expect(await screen.findByRole('button', { name: /login\.ts/ })).toBeTruthy();
    // Back under 2 characters: the listing at once, with no ask.
    fireEvent.change(field(), { target: { value: 'l' } });
    expect(await screen.findByRole('button', { name: /app\.ts/ })).toBeTruthy();
    await flush(FIND_DEBOUNCE_MS * 2);
    expect(filesFind).toHaveBeenCalledTimes(1);
  });

  it('the clear button and Escape empty it and bring the listing back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const filesFind = vi.fn(async (): Promise<FilesFindResponse> => ({ entries: [hit('src/login.ts')], truncated: false }));
    browse(fakeApi({ filesList: vi.fn(async () => listing([{ name: 'app.ts', type: 'file', size: 1 }], { path: 'src' })), filesFind }));
    await screen.findByRole('button', { name: /app\.ts/ });
    expect(screen.queryByRole('button', { name: 'Clear the search' })).toBeNull();
    fireEvent.change(field(), { target: { value: 'login' } });
    await flush(FIND_DEBOUNCE_MS + 10);
    await screen.findByRole('button', { name: /login\.ts/ });
    fireEvent.click(screen.getByRole('button', { name: 'Clear the search' }));
    expect((field() as HTMLInputElement).value).toBe('');
    expect(await screen.findByRole('button', { name: /app\.ts/ })).toBeTruthy();
    fireEvent.change(field(), { target: { value: 'login' } });
    await flush(FIND_DEBOUNCE_MS + 10);
    await screen.findByRole('button', { name: /login\.ts/ });
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect((field() as HTMLInputElement).value).toBe('');
    expect(await screen.findByRole('button', { name: /app\.ts/ })).toBeTruthy();
  });
});

describe('the results', () => {
  async function search(api: Api, text: string, path = 'src/') {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const r = browse(api, path);
    await screen.findByRole('search');
    fireEvent.change(field(), { target: { value: text } });
    await flush(FIND_DEBOUNCE_MS + 10);
    return r;
  }

  it('take the listing\'s place: icon, name, the folder it is in, size and age; announced politely', async () => {
    const filesFind = vi.fn(async (): Promise<FilesFindResponse> => ({
      entries: [hit('src/auth', { kind: 'dir', size: undefined }), hit('src/auth/session.ts'), hit('src/session-old.ts', { size: 812 })],
      truncated: false,
    }));
    await search(fakeApi({ filesList: vi.fn(async () => listing([{ name: 'app.ts', type: 'file', size: 1 }], { path: 'src' })), filesFind }), 'sess');
    const list = await screen.findByRole('list', { name: 'Names with “sess”, 3 found' });
    const rows = within(list).getAllByRole('button');
    expect(rows.map((b) => b.textContent)).toEqual(['auth2h ago', 'session.tsauth/12.4 KB · 2h ago', 'session-old.ts812 B · 2h ago']);
    expect(screen.queryByRole('button', { name: /app\.ts/ })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('3 names found.');
  });

  it('a file opens the viewer as Browse does; a folder is browsed into and the search ends', async () => {
    const filesFind = vi.fn(async (): Promise<FilesFindResponse> => ({ entries: [hit('src/auth', { kind: 'dir' }), hit('src/auth/session.ts')], truncated: false }));
    const { onLocation } = await search(fakeApi({ filesList: vi.fn(async () => listing([], { path: 'src' })), filesFind }), 'auth');
    fireEvent.click(await screen.findByRole('button', { name: /session\.ts/ }));
    expect(onLocation).toHaveBeenLastCalledWith({ root: 'r.work', path: 'src/auth/session.ts' });
    // Still searching here (the phone's back finds the results).
    expect((field() as HTMLInputElement).value).toBe('auth');
    fireEvent.click(screen.getByRole('button', { name: /^auth/ }));
    expect(onLocation).toHaveBeenLastCalledWith({ root: 'r.work', path: 'src/auth/' });
    expect((field() as HTMLInputElement).value).toBe('');
  });

  it('come back with the text after a result was opened and the folder shown again', async () => {
    const filesFind = vi.fn(async (): Promise<FilesFindResponse> => ({ entries: [hit('src/auth/session.ts')], truncated: false }));
    const api = fakeApi({ filesList: vi.fn(async () => listing([], { path: 'src' })), filesFind });
    const a = await search(api, 'session');
    fireEvent.click(await screen.findByRole('button', { name: /session\.ts/ }));
    a.unmount();
    browse(api);
    expect((field() as HTMLInputElement).value).toBe('session');
    expect(await screen.findByRole('button', { name: /session\.ts/ })).toBeTruthy();
  });

  it('"Searching…" while it asks, "No names match", and the footnote when a cap was reached', async () => {
    const filesFind = vi.fn((): Promise<FilesFindResponse> => pendingForever());
    const a = await search(fakeApi({ filesList: vi.fn(async () => listing([], { path: 'src' })), filesFind }), 'zz');
    await flush(200);
    expect(screen.getByText('Searching…')).toBeTruthy();
    a.unmount();

    clearFilesCache();
    clearKeptSearches();
    const b = await search(fakeApi({ filesList: vi.fn(async () => listing([], { path: 'src' })), filesFind: vi.fn(async () => ({ entries: [], truncated: false })) }), 'zz');
    expect(await screen.findByText('No names match “zz”.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('No names match.');
    b.unmount();

    clearFilesCache();
    clearKeptSearches();
    const many = Array.from({ length: 100 }, (_, i) => hit(`src/item-${String(i).padStart(3, '0')}.txt`));
    await search(fakeApi({ filesList: vi.fn(async () => listing([], { path: 'src' })), filesFind: vi.fn(async () => ({ entries: many, truncated: true })) }), 'item');
    expect(await screen.findByText('Showing the first 100. Type more to narrow it.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('100 names found, there may be more.');
  });

  it("the route's refusals and an offline Mac read as Browse's do", async () => {
    const filesFind = vi.fn(async () => Promise.reject(new ApiError('forbidden', 'That path leads outside the shared folder.', 403)));
    const a = await search(fakeApi({ filesList: vi.fn(async () => listing([], { path: 'src' })), filesFind }), 'zz');
    expect(await screen.findByText('That path leads outside the shared folder.')).toBeTruthy();
    expect(screen.getByLabelText('Protected')).toBeTruthy();
    a.unmount();

    clearFilesCache();
    clearKeptSearches();
    const failing = vi.fn(async () => Promise.reject(new ApiError('internal', 'boom', 500)));
    await search(fakeApi({ filesList: vi.fn(async () => listing([], { path: 'src' })), filesFind: failing }), 'zz');
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(failing).toHaveBeenCalledTimes(2));
  });

  it('a folder that cannot be read offers no search', async () => {
    browse(fakeApi({ filesList: vi.fn(async () => Promise.reject(new ApiError('forbidden', 'That folder is protected.', 403))) }), 'secret/');
    expect(await screen.findByText('That folder is protected.')).toBeTruthy();
    expect(screen.queryByRole('search')).toBeNull();
  });
});
