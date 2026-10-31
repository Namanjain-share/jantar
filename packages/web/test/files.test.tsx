/**
 * The Files place and the session Files tab (v0.3 spec 5.2, U9) against the
 * fake API: every state (loading, empty, error, offline, refused, success),
 * the changed-files list and the folder browser; and, at the end, the
 * security rules this package owns (spec 6): W3 file text only ever as text
 * nodes, W4 Map lookups for names like "constructor", W5 object URLs
 * revoked on unmount. The viewer's kinds have their own file
 * (files-viewer.test.tsx), the highlighter too (files-highlight.test.tsx).
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonEvent, FileChange, FileEntry, FileStat } from '@jantar/protocol';
import { ApiError, type Api } from '../src/lib/api.js';
import { clock } from '../src/lib/format.js';
import type { FilesLocation } from '../src/lib/router.js';
import { FilesPlace } from '../src/ui/screens/files/FilesPlace.js';
import {
  apiPath,
  baseName,
  changeAt,
  changeTags,
  changedBy,
  changedIn,
  changedToday,
  countsText,
  crumbs,
  dirLocation,
  dirOf,
  groupBySession,
  mention,
  nextSelection,
  opensViewer,
  pathLine,
  placeOf,
  sizeText,
  todayCut,
  todayLine,
  toolsText,
} from '../src/ui/screens/files/model.js';
import { parseNotebook } from '../src/ui/screens/files/notebook.js';
import { clearFilesCache } from '../src/ui/screens/files/data.js';
import { FilesTab } from '../src/ui/screens/session/FilesTab.js';
import { FILES_ON, change, layout, listing, objectUrls, pendingForever, renderViewer, renderWith, root, stat, text, viewport } from './files-helpers.js';
import { NOW, emit, fakeApi, iso, pending, renderApp, session, stateWith } from './helpers.js';

beforeEach(() => clearFilesCache());
afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------- pure helpers

describe('files model', () => {
  it('formats sizes, counts, tools and the day line', () => {
    expect([sizeText(0), sizeText(812), sizeText(4200), sizeText(13_000_000), sizeText(1.5 * 1024 ** 3), sizeText(-1)]).toEqual(['0 B', '812 B', '4.1 KB', '12.4 MB', '1.5 GB', '']);
    expect(countsText(42, 7)).toBe('+42 \u22127');
    expect(countsText(6, 2, true)).toBe('~+6 \u22122');
    expect(countsText(null, null)).toBe('');
    expect(toolsText({ tools: ['Write', 'Edit'], ops: 4 })).toBe('Write, Edit \u00d74');
    expect(toolsText({ tools: ['Write'], ops: 1 })).toBe('Write');
    expect([todayLine(0), todayLine(1), todayLine(14)]).toEqual(['No files changed today', '1 file changed today', '14 files changed today']);
    // A list cut at its limit whose oldest row is still today: the count is a floor.
    expect(todayLine(187, true)).toBe('187+ files changed today');
    const today = [change({ lastAt: iso(0) }), change({ changeId: 'c2', lastAt: iso(60_000) })];
    expect(todayCut(today, 2, NOW)).toBe(true);
    expect(todayCut(today, 3, NOW)).toBe(false);
    expect(todayCut([...today, change({ changeId: 'c3', lastAt: iso(-3 * 86_400_000) })], 3, NOW)).toBe(false);
  });

  it('tells whose folder a changed file is in, whichever root lists it', () => {
    // Session b works in a's folder: the list shows that folder once, as s.a.
    const sessions = { a: session('a'), b: session('b', { cwd: '/synthetic/home/work/a', folder: 'a' }), c: session('c', { status: 'ended' }) };
    const byB = change({ sid: 'b', rootId: 's.a' });
    expect(changedIn(byB, '/synthetic/home/work/a', 'src/auth/session.ts')).toBe(true);
    expect(changedIn(byB, '/synthetic/home/work/a/', 'src/auth/session.ts')).toBe(true);
    expect(changedIn(byB, '/synthetic/home/work/b', 'src/auth/session.ts')).toBe(false);
    expect(changedBy(byB, sessions, 'src/auth/session.ts')).toBe('b');
    // Under a root that is a parent of the session's folder, the path relative to the root is not one the session would know.
    expect(changedBy(change({ sid: 'b', rootId: 'r.work', rel: 'a/src/auth/session.ts' }), sessions, 'a/src/auth/session.ts')).toBeUndefined();
    expect(changedBy(change({ sid: 'c', path: '/synthetic/home/work/c/x.ts', rel: 'x.ts' }), sessions, 'x.ts')).toBeUndefined();
    expect(changedBy(change({ sid: 'gone' }), sessions, 'src/auth/session.ts')).toBeUndefined();
    expect(changedBy(change({ sid: '__proto__' }), sessions, 'src/auth/session.ts')).toBeUndefined();
    expect(changedBy(undefined, sessions, 'x.ts')).toBeUndefined();
  });

  it('reads a place from the URL: lists, a folder (trailing slash) or a file', () => {
    expect(placeOf({})).toEqual({ kind: 'lists' });
    expect(placeOf({ root: 'r.w' })).toEqual({ kind: 'dir', root: 'r.w', path: '' });
    expect(placeOf({ root: 'r.w', path: 'src/' })).toEqual({ kind: 'dir', root: 'r.w', path: 'src/' });
    expect(placeOf({ root: 'r.w', path: 'src/a.ts', tab: 'edits' })).toEqual({ kind: 'file', root: 'r.w', path: 'src/a.ts', tab: 'edits' });
    expect(dirLocation('r.w', 'src/auth')).toEqual({ root: 'r.w', path: 'src/auth/' });
    expect(dirLocation('r.w', '')).toEqual({ root: 'r.w' });
    expect([dirOf('src/a.ts'), dirOf('a.ts'), baseName('src/auth/'), apiPath('src/')]).toEqual(['src/', '', 'auth', 'src']);
    expect(crumbs('~/work', 'src/auth/')).toEqual([
      { label: '~/work', path: '' },
      { label: 'src', path: 'src/' },
      { label: 'auth', path: 'src/auth/' },
    ]);
  });

  it('groups changes by session, newest session and newest row first, and counts distinct files today', () => {
    const rows = [
      change({ changeId: '1', sid: 'a', lastAt: iso(10_000) }),
      change({ changeId: '2', sid: 'b', lastAt: iso(30_000), path: '/x/b.ts' }),
      change({ changeId: '3', sid: 'a', lastAt: iso(20_000), path: '/x/c.ts' }),
      change({ changeId: '4', sid: 'gone-session-id', lastAt: iso(5_000) }),
      change({ changeId: '5', sid: 'b', lastAt: iso(-3 * 86400_000), path: '/x/old.ts' }),
    ];
    const groups = groupBySession(rows, { a: session('a', { name: 'fix' }), b: session('b', { name: '' }) });
    expect(groups.map((g) => [g.label, g.changes.map((c) => c.changeId)])).toEqual([
      ['b', ['2', '5']],
      ['a · fix', ['3', '1']],
      ['gone-ses', ['4']],
    ]);
    // c1 and c4 are the same file: counted once; the old one is not today.
    expect(changedToday(rows, NOW)).toBe(3);
    // Several sessions changed the same file: the newest change wins.
    expect(changeAt(rows, 's.a', 'src/auth/session.ts')?.changeId).toBe('2');
    expect(changeAt(rows, 's.a', 'nope.ts')).toBeUndefined();
  });

  it('tags rows and says why one cannot open', () => {
    expect(changeTags(change({ created: true, last: { status: 'rejected', tool: 'Edit', at: iso(0) }, viewable: 'outside' }))).toEqual(['new', 'rejected', 'outside project']);
    expect(changeTags(change({ viewable: 'protected' }))).toEqual(['protected']);
    expect(opensViewer(change())).toBe(true);
    expect(opensViewer(change({ viewable: 'missing' }))).toBe(false);
    expect(opensViewer(change({ rootId: undefined }))).toBe(false);
  });

  it('selects lines: one, a range, then a fresh one; mentions and path:line', () => {
    let sel = nextSelection(null, 5);
    expect(sel).toEqual({ from: 5, to: 5 });
    sel = nextSelection(sel, 2);
    expect(sel).toEqual({ from: 2, to: 5 });
    sel = nextSelection(sel, 9);
    expect(sel).toEqual({ from: 9, to: 9 });
    expect(nextSelection(sel, 9)).toBeNull();
    expect(mention('src/a.ts', null)).toBe('@src/a.ts ');
    expect(mention('src/a.ts', { from: 12, to: 20 })).toBe('@src/a.ts:12-20 ');
    expect(pathLine('src/a.ts', { from: 3, to: 3 })).toBe('src/a.ts:3');
  });

  it('parses notebooks as data: fixed keys only, outputs reduced to text, images or labels', () => {
    const nb = parseNotebook(
      JSON.stringify({
        metadata: { kernelspec: { language: 'python' } },
        cells: [
          { cell_type: 'code', execution_count: 1, source: ['a = 1\n', 'a'], outputs: [{ output_type: 'execute_result', data: { 'text/plain': ['1'] } }] },
          { cell_type: 'code', source: '', outputs: [{ output_type: 'display_data', data: { 'image/svg+xml': '<svg/>' } }, { output_type: 'display_data', data: { 'application/pdf': 'x' } }, 'junk', { output_type: 'nope' }] },
          { cell_type: 'raw', source: 'r' },
          null,
        ],
      }),
    )!;
    expect(nb.language).toBe('python');
    expect(nb.cells).toEqual([
      { kind: 'code', source: 'a = 1\na', count: 1, outputs: [{ kind: 'text', text: '1' }] },
      { kind: 'code', source: '', count: null, outputs: [{ kind: 'hidden', label: 'SVG output not shown' }, { kind: 'hidden', label: 'Output not shown' }] },
      { kind: 'raw', source: 'r' },
    ]);
    expect(parseNotebook('[]')).toBeNull();
    expect(parseNotebook('{"cells": {}}')).toBeNull();
    expect(parseNotebook('{"__proto__": {"cells": []}}')).toBeNull();
  });
});

// ---------------------------------------------------------------- /files: Changed

describe('the Files place: changed files', () => {
  it('says how many files changed today, one rail per session, rows newest first', async () => {
    const api = fakeApi({
      filesChanges: vi.fn(async () => ({
        changes: [
          change(),
          change({ changeId: 'c2', rel: 'README.md', path: '/synthetic/home/work/a/README.md', lastAt: iso(200_000), tools: ['Write'], ops: 1, created: true, added: 12, removed: 0 }),
          change({ changeId: 'c3', sid: 'b', rootId: 's.b', rel: 'app.py', path: '/synthetic/home/work/b/app.py', lastAt: iso(60_000), ops: 1 }),
        ],
      })),
    });
    renderApp({ path: '/files', api, state: stateWith({ sessions: [session('a', { name: 'fix login' }), session('b')], features: FILES_ON }) });
    expect(await screen.findByText('3 files changed today')).toBeTruthy();
    expect(api.filesChanges).toHaveBeenCalledWith({ limit: 200 });
    const list = screen.getByRole('list', { name: 'Changed files' });
    const rails = within(list).getAllByRole('heading').map((h) => h.textContent);
    expect(rails).toEqual(['a · fix login2', 'b · task b1']);
    const rows = within(list).getAllByRole('button').map((b) => b.textContent ?? '');
    // Newest first inside a session: README.md (10:03) before session.ts (10:02).
    expect(rows[0]).toContain('README.md');
    expect(rows[0]).toContain('+12 −0');
    expect(rows[0]).toContain('new');
    expect(rows[1]).toContain('session.ts');
    expect(rows[1]).toContain('+42 −7');
    expect(rows[1]).toContain(`src/auth/ · Edit ×3 · ${clock(iso(120_000), NOW)}`);
  });

  it('shows the empty day, the loading skeleton, and the errors', async () => {
    const empty = renderApp({ path: '/files', api: fakeApi({ filesChanges: vi.fn(async () => ({ changes: [] })) }), state: stateWith({ features: FILES_ON }) });
    expect(await screen.findByText('No files changed today')).toBeTruthy();
    expect(screen.getByText(/Files that Claude creates or changes/)).toBeTruthy();
    empty.unmount();
    clearFilesCache();

    const loading = renderApp({ path: '/files', api: fakeApi({ filesChanges: vi.fn(pendingForever) }), state: stateWith({ features: FILES_ON }) });
    expect(await screen.findByText('Asking the Mac…')).toBeTruthy();
    expect(screen.queryByText(/changed today/)).toBeNull();
    loading.unmount();

    // fakeApi's default: the daemon has no Files part yet (501).
    const old = renderApp({ path: '/files', state: stateWith({ features: FILES_ON }) });
    expect(await screen.findByText("This Mac's Jantar can't show files yet. Update Jantar on the Mac.")).toBeTruthy();
    old.unmount();

    const off = renderApp({
      path: '/files',
      api: fakeApi({ filesChanges: vi.fn(async () => Promise.reject(new ApiError('forbidden', 'Files are off. Turn them on at your Mac: jantar files on', 403))) }),
      state: stateWith({ features: FILES_ON }),
    });
    expect(await screen.findByText('Files are off. Turn them on at your Mac: jantar files on')).toBeTruthy();
    off.unmount();
  });

  it('offline: says the Mac is out of reach, and asks again when it is back', async () => {
    const filesChanges = vi.fn(async (): Promise<{ changes: FileChange[] }> => Promise.reject(new ApiError('network', 'fetch failed', 0)));
    const { store } = renderApp({ path: '/files', api: fakeApi({ filesChanges }), state: stateWith({ features: FILES_ON }), status: 'offline' });
    expect(await screen.findByText("Can't reach the Mac. Files show again when it's back.")).toBeTruthy();
    filesChanges.mockImplementation(async () => ({ changes: [change()] }));
    act(() => store.getState().setConn({ status: 'live' }));
    expect(await screen.findByText('1 file changed today')).toBeTruthy();
  });

  it('a protected row says why instead of opening a viewer', async () => {
    const api = fakeApi({
      filesChanges: vi.fn(async () => ({
        changes: [change({ rel: '.env', path: '/synthetic/home/work/a/.env', viewable: 'protected', rootId: undefined, added: 1, removed: 0 })],
      })),
    });
    renderApp({ path: '/files', api, state: stateWith({ sessions: [session('a')], features: FILES_ON }) });
    const row = await screen.findByRole('button', { name: /\.env/ });
    expect(row.textContent).toContain('protected');
    fireEvent.click(row);
    expect(screen.getByText('This file is protected. Keys and secrets never leave the Mac.')).toBeTruthy();
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(api.filesStat).not.toHaveBeenCalled();
  });

  it('opens a row in the viewer as a pushed screen, and its back button pops it', async () => {
    const api = fakeApi({
      filesChanges: vi.fn(async () => ({ changes: [change()] })),
      filesRoots: vi.fn(async () => ({ roots: [root('s.a', { kind: 'session', sid: 'a', label: 'a' })] })),
      filesStat: vi.fn(async () => stat()),
      filesText: vi.fn(async () => text('import x from "y";\nexport const a = 1;\n')),
    });
    const { history } = renderApp({ path: '/files', api, state: stateWith({ sessions: [session('a')], features: FILES_ON }) });
    fireEvent.click(await screen.findByRole('button', { name: /session\.ts/ }));
    expect(history.location.search).toBe('?root=s.a&path=src%2Fauth%2Fsession.ts');
    expect(await screen.findByRole('heading', { name: 'session.ts' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Line 2' })).toBeTruthy();
    expect(api.filesText).toHaveBeenCalledWith({ root: 's.a', path: 'src/auth/session.ts' });
    // The edits tab exists because a session changed it.
    expect(screen.getByRole('button', { name: "Claude's edits 3" })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the list' }));
    await waitFor(() => expect(history.location.search).toBe(''));
    expect(await screen.findByRole('list', { name: 'Changed files' })).toBeTruthy();
  });

  it('"Ask about this" asks the session that changed the file, though its folder is listed as another session\'s', async () => {
    // a and b work in one folder, so the roots list it once, as s.a; b made the change.
    const api = fakeApi({
      filesChanges: vi.fn(async () => ({ changes: [change({ changeId: 'c9', sid: 'b', rootId: 's.a' })] })),
      filesRoots: vi.fn(async () => ({ roots: [root('s.a', { kind: 'session', sid: 'a', label: 'a' })] })),
      filesStat: vi.fn(async () => stat()),
      filesText: vi.fn(async () => text('x\n')),
    });
    const state = stateWith({ sessions: [session('a', { status: 'idle' }), session('b', { status: 'idle', cwd: '/synthetic/home/work/a', folder: 'a' })], features: FILES_ON });
    const { history } = renderApp({ path: '/files', api, state });
    fireEvent.click(await screen.findByRole('button', { name: /session\.ts/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'More for this file' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ask about this' }));
    await waitFor(() => expect(history.location.pathname).toBe('/s/b'));
    expect(((await screen.findByRole('textbox')) as HTMLTextAreaElement).value).toBe('@src/auth/session.ts ');
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });

  it('asks again when a session reports another changed file', async () => {
    const filesChanges = vi.fn(async () => ({ changes: [change()] }));
    const { store } = renderApp({ path: '/files', api: fakeApi({ filesChanges }), state: stateWith({ sessions: [session('a', { filesChanged: 1 })], features: FILES_ON }) });
    await screen.findByText('1 file changed today');
    expect(filesChanges).toHaveBeenCalledTimes(1);
    act(() =>
      emit(store, [{ seq: store.getState().state.seq + 1, ts: iso(300_000), type: 'session.updated', sid: 'a', data: { patch: { filesChanged: 2 } } } as DaemonEvent]),
    );
    await waitFor(() => expect(filesChanges).toHaveBeenCalledTimes(2));
  });

  it('desktop: the list in the ledger column, the viewer in the detail pane', async () => {
    viewport(1440);
    const api = fakeApi({
      filesChanges: vi.fn(async () => ({ changes: [change()] })),
      filesRoots: vi.fn(async () => ({ roots: [] })),
      filesStat: vi.fn(async () => stat()),
      filesText: vi.fn(async () => text('const a = 1;\n')),
    });
    renderApp({ path: '/files', api, state: stateWith({ sessions: [session('a')], features: FILES_ON }) });
    const detail = screen.getByRole('region', { name: 'File' });
    expect(within(detail).getByText('Pick a file to read it here.')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /session\.ts/ }));
    expect(await within(detail).findByRole('heading', { name: 'session.ts' })).toBeTruthy();
    // Still there beside it, and no back button on a desktop.
    expect(screen.getByRole('list', { name: 'Changed files' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back to the list' })).toBeNull();
  });

  it('shows the "turn it on" sentence when rendered with Files off', () => {
    renderWith(<FilesPlace location={{}} onLocation={() => undefined} />, { state: stateWith({}) });
    expect(screen.getByText(/Files are off\. Turn them on at your Mac:/)).toBeTruthy();
    expect(screen.getByText('jantar files on')).toBeTruthy();
  });
});

// ---------------------------------------------------------------- /files: Browse

describe('the Files place: browse', () => {
  const roots = [
    root('s.a', { kind: 'session', sid: 'a', label: 'a', display: '~/work/a' }),
    root('r.home', { label: 'home', display: '~', home: true }),
    root('r.work', { label: 'work', display: '~/Desktop/work' }),
  ];

  async function openBrowse(api: Api, path = '/files') {
    const r = renderApp({ path, api, state: stateWith({ sessions: [session('a', { account: 7 })], features: FILES_ON }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Browse' }));
    return r;
  }

  it('lists the roots set on the Mac first, then live sessions with their account', async () => {
    const api = fakeApi({ filesRoots: vi.fn(async () => ({ roots })), filesChanges: vi.fn(async () => ({ changes: [] })) });
    await openBrowse(api);
    const list = await screen.findByRole('list', { name: 'Folders' });
    const names = within(list).getAllByRole('button').map((b) => b.textContent);
    expect(names).toEqual(['~ home~', 'work~/Desktop/work', 'a~/work/a · 07']);
  });

  it('opens a folder: breadcrumb, folders first, sizes and ages, protected count, paging and hidden files', async () => {
    const filesList = vi.fn(async (q: { root: string; path?: string; after?: string; hidden?: boolean }) => {
      if (q.after) return listing([{ name: 'z.txt', type: 'file', size: 10 }], { path: 'src' });
      return listing(
        [
          { name: 'auth', type: 'dir' },
          { name: 'app.ts', type: 'file', size: 12_700, mtime: iso(-7200_000) },
          { name: 'out', type: 'link', link: 'outside' },
        ],
        { path: 'src', next: 'out', hiddenProtected: 3 },
      );
    });
    const api = fakeApi({ filesRoots: vi.fn(async () => ({ roots })), filesChanges: vi.fn(async () => ({ changes: [] })), filesList });
    const { history } = await openBrowse(api);
    fireEvent.click(await screen.findByRole('button', { name: /^work/ }));
    expect(history.location.search).toBe('?root=r.work');
    await screen.findByRole('button', { name: 'auth' });
    expect(filesList).toHaveBeenLastCalledWith({ root: 'r.work', path: '', hidden: false });
    expect(screen.getByRole('button', { name: /app\.ts/ }).textContent).toContain('12.4 KB · 2h ago');
    // A link out of the root cannot be opened.
    expect(screen.getByText('link outside').closest('[aria-disabled="true"]')).toBeTruthy();
    expect(screen.getByText('hidden: 3 protected')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show 500 more' }));
    expect(await screen.findByRole('button', { name: /z\.txt/ })).toBeTruthy();
    expect(filesList).toHaveBeenLastCalledWith({ root: 'r.work', path: '', hidden: false, after: 'out' });

    fireEvent.click(screen.getByRole('button', { name: 'auth' }));
    expect(history.location.search).toBe('?root=r.work&path=auth%2F');
    await waitFor(() => expect(filesList).toHaveBeenLastCalledWith({ root: 'r.work', path: 'auth', hidden: false }));
    const crumbs = screen.getByRole('navigation', { name: 'Folder path' });
    expect(crumbs.textContent).toBe('~/Desktop/work/auth/');
    fireEvent.click(within(crumbs).getByRole('button', { name: '~/Desktop/work' }));
    expect(history.location.search).toBe('?root=r.work');

    fireEvent.click(screen.getByRole('button', { name: 'Folder options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show hidden files' }));
    await waitFor(() => expect(filesList).toHaveBeenLastCalledWith({ root: 'r.work', path: '', hidden: true }));
  });

  it('a refused or vanished folder says so; an empty one says it is empty', async () => {
    const filesList = vi.fn(async (q: { path?: string }) => {
      if (q.path === 'secret') throw new ApiError('forbidden', 'That folder is protected.', 403);
      if (q.path === 'gone') throw new ApiError('not_found', '', 404);
      return listing([]);
    });
    const api = fakeApi({ filesRoots: vi.fn(async () => ({ roots })), filesChanges: vi.fn(async () => ({ changes: [] })), filesList });
    const a = renderApp({ path: '/files?root=r.work&path=secret%2F', api, state: stateWith({ features: FILES_ON }) });
    expect(await screen.findByText('That folder is protected.')).toBeTruthy();
    expect(screen.getByLabelText('Protected')).toBeTruthy();
    a.unmount();
    const b = renderApp({ path: '/files?root=r.work&path=gone%2F', api, state: stateWith({ features: FILES_ON }) });
    expect(await screen.findByText('That folder is no longer there.')).toBeTruthy();
    b.unmount();
    renderApp({ path: '/files?root=r.work', api, state: stateWith({ features: FILES_ON }) });
    expect(await screen.findByText('This folder is empty.')).toBeTruthy();
  });

  it('a folder read before gives way to the refusal when the Mac refuses it now', async () => {
    const filesList = vi.fn(async () => listing([{ name: 'plans.md', type: 'file', size: 1 }]));
    const api = fakeApi({ filesRoots: vi.fn(async () => ({ roots })), filesList });
    const a = renderApp({ path: '/files?root=r.work&path=docs%2F', api, state: stateWith({ features: FILES_ON }) });
    expect(await screen.findByRole('button', { name: /plans\.md/ })).toBeTruthy();
    a.unmount();
    filesList.mockImplementation(async () => Promise.reject(new ApiError('forbidden', 'That folder is protected.', 403)));
    renderApp({ path: '/files?root=r.work&path=docs%2F', api, state: stateWith({ features: FILES_ON }) });
    expect(await screen.findByText('That folder is protected.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /plans\.md/ })).toBeNull();
  });

  it('keeps the pages already shown when the Mac comes back with the same first page', async () => {
    const filesList = vi.fn(async (q: { after?: string }) =>
      q.after ? listing([{ name: 'z.txt', type: 'file', size: 1 }]) : listing([{ name: 'a.txt', type: 'file', size: 1 }], { next: 'a.txt' }),
    );
    const { store } = renderApp({ path: '/files?root=r.work', api: fakeApi({ filesRoots: vi.fn(async () => ({ roots })), filesList }), state: stateWith({ features: FILES_ON }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Show 500 more' }));
    expect(await screen.findByRole('button', { name: /z\.txt/ })).toBeTruthy();
    act(() => store.getState().setConn({ status: 'offline' }));
    act(() => store.getState().setConn({ status: 'live' }));
    await waitFor(() => expect(filesList).toHaveBeenCalledTimes(3));
    await act(async () => new Promise<void>((r) => setTimeout(r, 0)));
    expect(screen.getByRole('button', { name: /z\.txt/ })).toBeTruthy();
  });

  it('Browse states: loading roots, no roots, a folder loading, and offline', async () => {
    const a = await openBrowse(fakeApi({ filesRoots: vi.fn(pendingForever), filesChanges: vi.fn(async () => ({ changes: [] })) }));
    expect(await screen.findByText('Asking the Mac…')).toBeTruthy();
    a.unmount();
    clearFilesCache();
    const b = await openBrowse(fakeApi({ filesRoots: vi.fn(async () => ({ roots: [] })), filesChanges: vi.fn(async () => ({ changes: [] })) }));
    expect(await screen.findByText(/No folders to browse yet/)).toBeTruthy();
    b.unmount();
    clearFilesCache();
    const c = renderApp({ path: '/files?root=r.work', api: fakeApi({ filesRoots: vi.fn(async () => ({ roots })), filesList: vi.fn(pendingForever) }), state: stateWith({ features: FILES_ON }) });
    expect(await screen.findByText('Reading the folder…')).toBeTruthy();
    // The breadcrumb is there before the entries are.
    expect(screen.getByRole('navigation', { name: 'Folder path' })).toBeTruthy();
    c.unmount();
    clearFilesCache();
    renderApp({
      path: '/files?root=r.work',
      api: fakeApi({ filesRoots: vi.fn(async () => ({ roots })), filesList: vi.fn(async () => Promise.reject(new ApiError('network', 'down', 0))) }),
      state: stateWith({ features: FILES_ON }),
      status: 'offline',
    });
    expect(await screen.findByText("Can't reach the Mac. Files show again when it's back.")).toBeTruthy();
  });

  it('tapping Browse again inside a folder, or "All folders", goes back to the roots', async () => {
    const api = fakeApi({ filesRoots: vi.fn(async () => ({ roots })), filesChanges: vi.fn(async () => ({ changes: [] })), filesList: vi.fn(async () => listing([])) });
    const { history } = renderApp({ path: '/files?root=r.work', api, state: stateWith({ features: FILES_ON }) });
    await screen.findByText('This folder is empty.');
    fireEvent.click(screen.getByRole('button', { name: 'All folders' }));
    expect(history.location.search).toBe('');
    expect(await screen.findByRole('list', { name: 'Folders' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^work/ }));
    await screen.findByText('This folder is empty.');
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    expect(await screen.findByRole('list', { name: 'Folders' })).toBeTruthy();
  });

  it('virtualises a big folder: only the rows in view are in the DOM', async () => {
    layout();
    const entries: FileEntry[] = Array.from({ length: 500 }, (_, i) => ({ name: `f${String(i).padStart(3, '0')}.ts`, type: 'file' as const, size: 1 }));
    const api = fakeApi({ filesRoots: vi.fn(async () => ({ roots })), filesChanges: vi.fn(async () => ({ changes: [] })), filesList: vi.fn(async () => listing(entries)) });
    renderApp({ path: '/files?root=r.work', api, state: stateWith({ features: FILES_ON }) });
    const list = await screen.findByRole('list', { name: /500 entries/ });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.length).toBeLessThan(80);
    expect(within(list).getByText('f000.ts')).toBeTruthy();
    expect(within(list).queryByText('f499.ts')).toBeNull();
  });
});

// ---------------------------------------------------------------- a session's Files tab

describe("a session's Files tab", () => {
  async function openTab(api: Api, over: Parameters<typeof session>[1] = {}) {
    const r = renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'idle', filesChanged: 2, ...over })], features: FILES_ON }) });
    fireEvent.click(screen.getByRole('tab', { name: /^Files/ }));
    return r;
  }

  it('lists what Claude changed in this session, newest first, under one rail', async () => {
    const api = fakeApi({
      sessionChanges: vi.fn(async () => ({
        changes: [change(), change({ changeId: 'c2', rel: 'b.ts', path: '/synthetic/home/work/a/b.ts', lastAt: iso(250_000) })],
        scan: { done: true, bytes: 10, total: 10 },
        truncated: false,
      })),
    });
    await openTab(api);
    const panel = screen.getByRole('tabpanel', { name: 'Files 2' });
    const list = await within(panel).findByRole('list', { name: 'Files this session changed' });
    expect(within(list).getByRole('heading').textContent).toBe('Changed by Claude2');
    const rows = within(list).getAllByRole('button').map((b) => b.textContent ?? '');
    expect(rows[0]).toContain('b.ts');
    expect(rows[1]).toContain('session.ts');
    expect(api.sessionChanges).toHaveBeenCalledWith('a');
  });

  it('follows the transcript backfill, then says when nothing changed', async () => {
    // Fake timers only, advanced by hand: the 2 s poll fires exactly when the test says.
    vi.useFakeTimers();
    const flush = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    try {
      const sessionChanges = vi.fn(async () => ({ changes: [], scan: { done: false, bytes: 34 * 1024 * 1024, total: 120 * 1024 * 1024 }, truncated: false }));
      await openTab(fakeApi({ sessionChanges }));
      await flush(10);
      const line = screen.getByText('reading the transcript · 34 MB of 120 MB');
      // The byte count changes every poll: it is not a live region; the start and the end are said once each.
      expect(line.closest('[role="status"]')).toBeNull();
      expect(screen.getAllByRole('status').map((s) => s.textContent)).toContain('Reading the transcript');
      expect(sessionChanges).toHaveBeenCalledTimes(1);
      sessionChanges.mockImplementation(async () => ({ changes: [], scan: { done: true, bytes: 120, total: 120 }, truncated: false }));
      await flush(1_000);
      expect(sessionChanges).toHaveBeenCalledTimes(1);
      await flush(1_100);
      expect(sessionChanges).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Claude hasn't changed any files in this session yet.")).toBeTruthy();
      expect(screen.queryByText(/reading the transcript/)).toBeNull();
      expect(screen.getAllByRole('status').map((s) => s.textContent)).toContain('Transcript read in full');
      // Done: no more polling.
      await flush(10_000);
      expect(sessionChanges).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for each backfill reply before asking again, so a slow one still lands', async () => {
    vi.useFakeTimers();
    const flush = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    try {
      const reply = (mb: number) => ({ changes: [], scan: { done: false, bytes: mb * 1024 * 1024, total: 120 * 1024 * 1024 }, truncated: false });
      const sessionChanges = vi.fn(async () => reply(34));
      await openTab(fakeApi({ sessionChanges }));
      await flush(10);
      expect(screen.getByText('reading the transcript · 34 MB of 120 MB')).toBeTruthy();
      // A slow tunnel: each reply takes 3 s, longer than the 2 s between asks.
      sessionChanges.mockImplementation(() => new Promise((r) => setTimeout(() => r(reply(80)), 3_000)));
      await flush(2_000);
      expect(sessionChanges).toHaveBeenCalledTimes(2);
      // Not asked again while that ask is out, so nothing overtakes its reply.
      await flush(2_500);
      expect(sessionChanges).toHaveBeenCalledTimes(2);
      await flush(600);
      expect(screen.getByText('reading the transcript · 80 MB of 120 MB')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a folder already listed under a root set on the Mac: Browse names it, and its own changes can be asked about', async () => {
    const api = fakeApi({
      // The session's folder is the root r.a, so the list leaves s.a out; its changes come under r.a.
      sessionChanges: vi.fn(async () => ({ changes: [change({ rootId: 'r.a' })], scan: { done: true, bytes: 1, total: 1 }, truncated: false })),
      filesRoots: vi.fn(async () => ({ roots: [root('r.a', { label: 'a', display: '~/work/a' })] })),
      filesStat: vi.fn(async () => stat()),
      filesText: vi.fn(async () => text('one\ntwo\n')),
      filesList: vi.fn(async () => listing([{ name: 'src', type: 'dir' }], { root: 's.a' })),
    });
    await openTab(api);
    await screen.findByRole('list', { name: 'Files this session changed' });
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    expect(await screen.findByRole('button', { name: 'src' })).toBeTruthy();
    expect(api.filesList).toHaveBeenCalledWith({ root: 's.a', path: '', hidden: false });
    // Named after the session's folder, never by its id.
    expect(screen.getByRole('navigation', { name: 'Folder path' }).textContent).toBe('a/');
    fireEvent.click(screen.getByRole('button', { name: 'Changed' }));
    fireEvent.click(await screen.findByRole('button', { name: /session\.ts/ }));
    const panel = screen.getByRole('tabpanel', { name: 'Files 2' });
    fireEvent.click(await within(panel).findByRole('button', { name: 'More for this file' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ask about this' }));
    expect(((await screen.findByRole('textbox')) as HTMLTextAreaElement).value).toBe('@src/auth/session.ts ');
  });

  it('shows loading, refused and offline states', async () => {
    const a = await openTab(fakeApi({ sessionChanges: vi.fn(pendingForever) }));
    expect(await screen.findByText('Reading the transcript…')).toBeTruthy();
    a.unmount();
    clearFilesCache();
    const b = await openTab(fakeApi({ sessionChanges: vi.fn(async () => Promise.reject(new ApiError('forbidden', 'This device is not allowed to do that.', 403))) }));
    expect(await screen.findByText('This device is not allowed to do that.')).toBeTruthy();
    b.unmount();
    clearFilesCache();
    renderApp({
      path: '/s/a',
      api: fakeApi({ sessionChanges: vi.fn(async () => Promise.reject(new ApiError('network', 'down', 0))) }),
      state: stateWith({ sessions: [session('a')], features: FILES_ON }),
      status: 'offline',
    });
    fireEvent.click(screen.getByRole('tab', { name: /^Files/ }));
    expect(await screen.findByText("Can't reach the Mac. Files show again when it's back.")).toBeTruthy();
  });

  it('opens a file inside the tab panel and "Ask about this" fills the draft without sending', async () => {
    const api = fakeApi({
      sessionChanges: vi.fn(async () => ({ changes: [change()], scan: { done: true, bytes: 1, total: 1 }, truncated: false })),
      filesRoots: vi.fn(async () => ({ roots: [root('s.a', { kind: 'session', sid: 'a' })] })),
      filesStat: vi.fn(async () => stat()),
      filesText: vi.fn(async () => text('one\ntwo\nthree\n')),
    });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
    const { history } = await openTab(api);
    fireEvent.click(await screen.findByRole('button', { name: /session\.ts/ }));
    const panel = screen.getByRole('tabpanel', { name: 'Files 2' });
    expect(await within(panel).findByRole('heading', { name: 'session.ts' })).toBeTruthy();
    // The viewer's place replaces the URL (the session screen keeps it in its own state).
    expect(history.location.search).toBe('?view=files&root=s.a&path=src%2Fauth%2Fsession.ts');
    fireEvent.click(await within(panel).findByRole('button', { name: 'Line 2' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'More for this file' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ask about this' }));
    const box = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    expect(box.value).toBe('@src/auth/session.ts:2 ');
    expect(screen.getByRole('tab', { name: 'Transcript' }).getAttribute('aria-selected')).toBe('true');
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });

  it('on a phone an open file has the screen: no meta line, control bar or composer until Back', async () => {
    viewport(390);
    const api = fakeApi({
      sessionChanges: vi.fn(async () => ({ changes: [change()], scan: { done: true, bytes: 1, total: 1 }, truncated: false })),
      filesRoots: vi.fn(async () => ({ roots: [root('s.a', { kind: 'session', sid: 'a' })] })),
      filesStat: vi.fn(async () => stat()),
      filesText: vi.fn(async () => text('x\n')),
    });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'idle', filesChanged: 2 })], features: { ...FILES_ON, controls: true } }) });
    fireEvent.click(screen.getByRole('tab', { name: /^Files/ }));
    // The list still has them.
    expect(await screen.findByRole('group', { name: 'Controls' })).toBeTruthy();
    expect(screen.getByRole('textbox')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /session\.ts/ }));
    expect(await screen.findByRole('heading', { name: 'session.ts' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Controls' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Back to the list' }));
    expect(await screen.findByRole('group', { name: 'Controls' })).toBeTruthy();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('on a phone a card still shows under an open file', async () => {
    viewport(390);
    const api = fakeApi({
      sessionChanges: vi.fn(async () => ({ changes: [change()], scan: { done: true, bytes: 1, total: 1 }, truncated: false })),
      filesRoots: vi.fn(async () => ({ roots: [root('s.a', { kind: 'session', sid: 'a' })] })),
      filesStat: vi.fn(async () => stat()),
      filesText: vi.fn(async () => text('x\n')),
    });
    renderApp({
      path: '/s/a',
      api,
      state: stateWith({ sessions: [session('a', { status: 'waiting', filesChanged: 2 })], pending: [pending('a')], features: { ...FILES_ON, controls: true } }),
    });
    fireEvent.click(screen.getByRole('tab', { name: /^Files/ }));
    fireEvent.click(await screen.findByRole('button', { name: /session\.ts/ }));
    expect(await screen.findByRole('heading', { name: 'session.ts' })).toBeTruthy();
    // The card (an article in the dock) is still there to answer.
    expect(screen.getAllByRole('article').length).toBeGreaterThan(0);
    expect(screen.getByText('npm test')).toBeTruthy();
  });

  it('the back button returns to the list; Browse shows the session folder', async () => {
    const api = fakeApi({
      sessionChanges: vi.fn(async () => ({ changes: [change()], scan: { done: true, bytes: 1, total: 1 }, truncated: false })),
      filesRoots: vi.fn(async () => ({ roots: [root('s.a', { kind: 'session', sid: 'a', display: '~/work/a' })] })),
      filesStat: vi.fn(async () => stat()),
      filesText: vi.fn(async () => text('x\n')),
      filesList: vi.fn(async () => listing([{ name: 'src', type: 'dir' }], { root: 's.a' })),
    });
    await openTab(api);
    fireEvent.click(await screen.findByRole('button', { name: /session\.ts/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Back to the list' }));
    expect(await screen.findByRole('list', { name: 'Files this session changed' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    expect(await screen.findByRole('button', { name: 'src' })).toBeTruthy();
    expect(api.filesList).toHaveBeenCalledWith({ root: 's.a', path: '', hidden: false });
    expect(screen.getByRole('navigation', { name: 'Folder path' }).textContent).toBe('~/work/a/');
  });

  it('asks again when the session reports another changed file', async () => {
    const sessionChanges = vi.fn(async () => ({ changes: [change()], scan: { done: true, bytes: 1, total: 1 }, truncated: false }));
    const { store } = await openTab(fakeApi({ sessionChanges }));
    await screen.findByRole('list', { name: 'Files this session changed' });
    expect(sessionChanges).toHaveBeenCalledTimes(1);
    act(() => emit(store, [{ seq: store.getState().state.seq + 1, ts: iso(300_000), type: 'session.updated', sid: 'a', data: { patch: { filesChanged: 3 } } } as DaemonEvent]));
    await waitFor(() => expect(sessionChanges).toHaveBeenCalledTimes(2));
  });

  it('is the tab panel, and says Files are off when rendered with the switch off', () => {
    const loc: FilesLocation = {};
    renderWith(
      <FilesTab sid="a" session={session('a')} phone id="panel-files-a" labelledBy="tab-files-a" location={loc} onLocation={() => undefined} onAsk={() => undefined} />,
      { state: stateWith({ sessions: [session('a')] }) },
    );
    const panel = screen.getByRole('tabpanel');
    expect(panel.id).toBe('panel-files-a');
    expect(panel.getAttribute('aria-labelledby')).toBe('tab-files-a');
    expect(within(panel).getByText(/Files are off/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------- security rules (spec 6)

describe('security rules this package owns (spec 6)', () => {
  it('W3: file text reaches the DOM only as text nodes (code, Markdown, notebook, SVG source)', async () => {
    const hostile = '<b>x</b>\n<script>window.__pwned = 1</script>\n<img src=x onerror="window.__pwned = 2">\n';
    const files: Record<string, { kind: FileStat['kind']; body: string }> = {
      'page.html': { kind: 'text', body: hostile },
      'notes.md': { kind: 'markdown', body: `# Notes\n\n${hostile}` },
      'logo.svg': { kind: 'svg', body: `<svg xmlns="http://www.w3.org/2000/svg">${hostile}</svg>\n` },
      'run.ipynb': {
        kind: 'notebook',
        body: JSON.stringify({ cells: [{ cell_type: 'markdown', source: hostile }, { cell_type: 'code', source: hostile, outputs: [{ output_type: 'stream', text: hostile }] }] }),
      },
    };
    for (const [path, f] of Object.entries(files)) {
      clearFilesCache();
      const api = fakeApi({ filesStat: vi.fn(async () => stat({ kind: f.kind, language: undefined })), filesText: vi.fn(async () => text(f.body)) });
      const { container, unmount } = renderViewer(api, { path });
      await waitFor(() => expect(container.textContent, path).toContain('<b>x</b>'));
      // Only the Phosphor icons are SVG (fill="currentColor"); the file's own <svg> never becomes one.
      expect(container.querySelector('b,script,iframe,object,embed,svg:not([fill="currentColor"])'), path).toBeNull();
      expect(container.querySelector('img[onerror]'), path).toBeNull();
      expect((window as { __pwned?: unknown }).__pwned, path).toBeUndefined();
      unmount();
    }
  });

  it('W4: files named "constructor" and "__proto__.md" render as plain text without throwing', async () => {
    const api = fakeApi({
      filesStat: vi.fn(async () => stat({ kind: 'text', language: '__proto__' })),
      filesText: vi.fn(async () => text('toString\nvalueOf\n', { language: 'constructor' })),
    });
    const a = renderViewer(api, { path: 'constructor' });
    const list = await screen.findByRole('list', { name: 'constructor, 2 lines' });
    expect(list.querySelector('[class*="tk-"]')).toBeNull();
    expect(screen.getByText('constructor · 4.1 KB')).toBeTruthy();
    a.unmount();
    clearFilesCache();
    renderViewer(api, { path: '__proto__.md' });
    expect(await screen.findByRole('list', { name: '__proto__.md, 2 lines' })).toBeTruthy();
    // The same names in a changed-files list and a folder listing.
    clearFilesCache();
    const list2 = fakeApi({
      filesChanges: vi.fn(async () => ({ changes: [change({ rel: 'constructor', path: '/synthetic/constructor' }), change({ changeId: 'c2', rel: '__proto__.md', path: '/synthetic/__proto__.md' })] })),
      filesList: vi.fn(async () => listing([{ name: 'constructor', type: 'file', size: 1 }, { name: '__proto__.md', type: 'file', size: 1 }])),
      filesRoots: vi.fn(async () => ({ roots: [root('r.work')] })),
    });
    const b = renderApp({ path: '/files', api: list2, state: stateWith({ features: FILES_ON }) });
    expect(await screen.findByRole('button', { name: /^constructor/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^__proto__\.md/ })).toBeTruthy();
    b.unmount();
    renderApp({ path: '/files?root=r.work', api: list2, state: stateWith({ features: FILES_ON }) });
    expect(await screen.findByRole('button', { name: /^__proto__\.md/ })).toBeTruthy();
  });

  it('names with hidden characters show them boxed: changed rows, folder rows and the breadcrumb', async () => {
    const RLO = String.fromCodePoint(0x202e);
    const api = fakeApi({
      filesChanges: vi.fn(async () => ({ changes: [change({ rel: `evil${RLO}gnp.ts`, path: `/synthetic/home/work/a/evil${RLO}gnp.ts` })] })),
      filesRoots: vi.fn(async () => ({ roots: [root('r.work')] })),
      filesList: vi.fn(async () => listing([{ name: `invoice${RLO}fdp.exe`, type: 'file', size: 1 }])),
    });
    const a = renderApp({ path: '/files', api, state: stateWith({ sessions: [session('a')], features: FILES_ON }) });
    const row = await screen.findByRole('button', { name: /^evil⟨U\+202E⟩gnp\.ts/ });
    expect(row.querySelector('.tk-hidden')?.textContent).toBe('⟨U+202E⟩');
    a.unmount();
    renderApp({ path: `/files?root=r.work&path=${encodeURIComponent(`in${RLO}box/`)}`, api, state: stateWith({ features: FILES_ON }) });
    const entry = await screen.findByRole('button', { name: /^invoice⟨U\+202E⟩fdp\.exe/ });
    expect(entry.querySelector('.tk-hidden')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Folder path' }).textContent).toBe('~/work/in⟨U+202E⟩box/');
  });

  it('W5: object URLs are revoked when the viewer unmounts (image, SVG preview, notebook image)', async () => {
    const urls = objectUrls();
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
    const image = renderViewer(fakeApi({ filesStat: vi.fn(async () => stat({ kind: 'image' })), filesRaw: vi.fn(async () => png) }), { path: 'a.png' });
    await screen.findByRole('img', { name: 'a.png' });
    image.unmount();

    clearFilesCache();
    const svg = renderViewer(fakeApi({ filesStat: vi.fn(async () => stat({ kind: 'svg' })), filesText: vi.fn(async () => text('<svg/>\n')) }), { path: 'b.svg' });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }));
    await screen.findByRole('img', { name: 'b.svg' });
    svg.unmount();

    clearFilesCache();
    const nb = JSON.stringify({ cells: [{ cell_type: 'code', source: 'plot()', outputs: [{ output_type: 'display_data', data: { 'image/png': btoa('\x89PNG') } }] }] });
    const notebook = renderViewer(fakeApi({ filesStat: vi.fn(async () => stat({ kind: 'notebook' })), filesText: vi.fn(async () => text(nb)) }), { path: 'c.ipynb' });
    await screen.findByRole('img', { name: 'Cell output' });
    notebook.unmount();

    expect(urls.create).toHaveBeenCalledTimes(3);
    expect(urls.revoke.mock.calls.map((c) => c[0]).sort()).toEqual([...urls.made].sort());
  });
});
