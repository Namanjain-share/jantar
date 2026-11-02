/**
 * 0.10.1: New folder in Files, then Start a session here. Inside a folder
 * (never on the list of roots), while Files and launching are both on and
 * the listing has loaded, the header offers New folder: a text button on
 * the phone's second row (icon only below 360 px), an icon button before
 * the ··· on wider screens. Its sheet suggests a free name, checks it as
 * typed (the daemon's rule, and a clash in any letter case with what is
 * listed), sends one Idempotency-Key per folder, and on 201 opens the new
 * folder with a "just made" panel whose primary is the start sheet for it.
 * The session's Files tab and the composer's attach picker never offer it.
 * Every path and name here is made up.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Features, FileEntry } from '@jantar/protocol';
import { ApiError, type Api } from '../src/lib/api.js';
import { clearFilesCache } from '../src/ui/screens/files/data.js';
import { SessionFiles } from '../src/ui/screens/files/SessionFiles.js';
import { FolderBrowse } from '../src/ui/screens/session/attach/FolderBrowse.js';
import { FILES_ON, listing, pendingForever, renderWith, root, viewport } from './files-helpers.js';
import { fakeApi, preloadPlaces, renderApp, session, stateWith } from './helpers.js';

preloadPlaces('files');
beforeAll(async () => {
  await import('../src/ui/screens/files/NewFolderSheet.js');
});

const ROOTS = [root('r.work', { label: 'work', display: '~/Desktop/work' }), root('s.a', { kind: 'session', sid: 'a', label: 'a', display: '~/work/a' })];
const ON: Partial<Features> = { ...FILES_ON, launch: true };
const NEW = 'New folder';
const START = 'Start a session here';
const AUTH = '/files?root=r.work&path=auth%2F';

beforeEach(() => clearFilesCache());
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** The fake daemon: `auth/` lists `entries` (plus what was made), anything else is empty. */
function filesApi(over: Partial<Api> = {}, entries: FileEntry[] = [{ name: 'src', type: 'dir' }]) {
  const made: FileEntry[] = [];
  const filesList = vi.fn(async (q: { root: string; path: string }) => listing(q.path === 'auth' || q.path === '' ? [...entries, ...made] : [], { root: q.root, path: q.path }));
  const foldersCreate = vi.fn(async (b: { root: string; parent: string; name: string }, _key?: string) => {
    made.push({ name: b.name, type: 'dir' });
    return { root: b.root, path: b.parent ? `${b.parent}/${b.name}` : b.name };
  });
  const api = fakeApi({
    filesRoots: vi.fn(async () => ({ roots: ROOTS })),
    filesChanges: vi.fn(async () => ({ changes: [] })),
    filesList: filesList as unknown as Api['filesList'],
    foldersCreate: foldersCreate as unknown as Api['foldersCreate'],
    ...over,
  });
  return { api, filesList, foldersCreate };
}

function renderFiles(opts: { api?: Api; path?: string; features?: Partial<Features>; status?: 'live' | 'offline' } = {}) {
  return renderApp({
    path: opts.path ?? AUTH,
    api: opts.api ?? filesApi().api,
    state: stateWith({ features: opts.features ?? ON }),
    ...(opts.status ? { status: opts.status } : {}),
  });
}

/** Open the sheet; its name field. */
async function openSheet(): Promise<HTMLInputElement> {
  fireEvent.click(await screen.findByRole('button', { name: NEW }));
  const dialog = await screen.findByRole('dialog', { name: NEW });
  return within(dialog).getByRole('textbox', { name: 'Folder name' }) as HTMLInputElement;
}

// While busy the spinner's label joins the name ("CreatingCreate").
const createButton = () => within(screen.getByRole('dialog', { name: NEW })).getByRole('button', { name: /^(Creating)?Create$/ }) as HTMLButtonElement;

describe('where New folder shows', () => {
  it('inside a folder, with Files and launching on, once the listing has loaded', async () => {
    renderFiles();
    expect(await screen.findByRole('button', { name: NEW })).toBeTruthy();
  });

  it('not with launching off, not on the list of roots', async () => {
    const off = renderFiles({ features: FILES_ON });
    await screen.findByRole('button', { name: 'src' });
    expect(screen.queryByRole('button', { name: NEW })).toBeNull();
    off.unmount();
    clearFilesCache();
    renderFiles({ path: '/files' });
    fireEvent.click(await screen.findByRole('button', { name: 'Browse' }));
    await screen.findByRole('list', { name: 'Folders' });
    expect(screen.queryByRole('button', { name: NEW })).toBeNull();
  });

  it('not while the folder loads, nor after it was refused (New Claude session here still shows)', async () => {
    const loading = renderFiles({ api: filesApi({ filesList: vi.fn(pendingForever) }).api });
    expect(await screen.findByRole('button', { name: 'New Claude session here' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: NEW })).toBeNull();
    loading.unmount();
    clearFilesCache();
    const refused = vi.fn(async () => Promise.reject(new ApiError('forbidden', 'That folder is protected.', 403)));
    renderFiles({ api: filesApi({ filesList: refused }).api });
    expect(await screen.findByText('That folder is protected.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New Claude session here' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: NEW })).toBeNull();
  });

  it("not in a session's Files tab, nor in the composer's attach picker", async () => {
    const list = vi.fn(async (q: { root: string; path: string }) => listing([{ name: 'src', type: 'dir' }], { root: q.root, path: q.path }));
    const api = filesApi({ filesList: list as unknown as Api['filesList'] }).api;
    const tab = renderWith(<SessionFiles sid="a" session={session('a')} phone location={{ root: 's.a', path: 'docs/' }} onLocation={vi.fn()} onAsk={vi.fn()} />, {
      api,
      state: stateWith({ features: ON, sessions: [session('a')] }),
    });
    await screen.findByRole('button', { name: 'src' });
    expect(screen.getByRole('button', { name: 'New Claude session here' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: NEW })).toBeNull();
    tab.unmount();
    clearFilesCache();
    renderWith(<FolderBrowse sid="a" phone onPick={vi.fn()} />, { api, state: stateWith({ features: ON }) });
    await screen.findByRole('button', { name: 'src' });
    expect(screen.queryByRole('button', { name: NEW })).toBeNull();
  });
});

describe('frames', () => {
  it('phone: a text button on the second row, after New Claude session here; its label hides below 360 px', async () => {
    viewport(320);
    renderFiles();
    const crumbs = await screen.findByRole('navigation', { name: 'Folder path' });
    const button = await screen.findByRole('button', { name: NEW });
    const row = crumbs.parentElement!.nextElementSibling!;
    expect(row.contains(button)).toBe(true);
    expect(crumbs.parentElement!.contains(button)).toBe(false);
    const session = within(row as HTMLElement).getByRole('button', { name: 'New Claude session here' });
    expect(session.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Icon only at 320 px (sr-only below 360), labelled at 390 px: the label is in the DOM either way.
    const label = within(button).getByText(NEW);
    expect(label.className).toContain('max-[360px]:sr-only');
    expect(label.classList.contains('sr-only')).toBe(false);
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    // Text, never a fill or ember.
    expect(button.className).not.toMatch(/bg-ink\b|signal|ember/);
  });

  it('390 px: the same row, the label shown', async () => {
    viewport(390);
    renderFiles();
    const button = await screen.findByRole('button', { name: NEW });
    expect(button.textContent).toBe(NEW);
    expect(within(button).getByText(NEW).classList.contains('sr-only')).toBe(false);
  });

  it('desktop: an icon button in the bar, between New Claude session here and the ···, whose menu is unchanged', async () => {
    viewport(1440);
    renderFiles();
    const bar = (await screen.findByRole('navigation', { name: 'Folder path' })).parentElement!;
    const button = await within(bar).findByRole('button', { name: NEW });
    expect(button.getAttribute('title')).toBe(NEW);
    expect(button.textContent).toBe('');
    const session = within(bar).getByRole('button', { name: 'New Claude session here' });
    const options = within(bar).getByRole('button', { name: 'Folder options' });
    expect(session.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(options);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Show hidden files']);
  });
});

describe('the sheet', () => {
  it('opens on a free name, selected, under the folder it goes in', async () => {
    renderFiles();
    const input = await openSheet();
    expect(input.value).toBe('new-project');
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'new-project'.length]);
    expect(within(screen.getByRole('dialog', { name: NEW })).getByText('in ~/Desktop/work/auth')).toBeTruthy();
    // 16 px text (no zoom on iOS), no autocorrect.
    expect(input.className).toContain('type-input');
    expect(input.getAttribute('autocapitalize')).toBe('off');
    expect(input.getAttribute('autocorrect')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.getAttribute('maxlength')).toBe('60');
  });

  it('skips names already listed, in any letter case', async () => {
    renderFiles({
      api: filesApi({}, [
        { name: 'new-project', type: 'dir' },
        { name: 'New-Project-2', type: 'file', size: 1 },
      ]).api,
    });
    expect((await openSheet()).value).toBe('new-project-3');
  });

  it('checks the name as typed: Create off, aria-invalid and the hint; the name is trimmed', async () => {
    const { api, foldersCreate } = filesApi();
    renderFiles({ api });
    const input = await openSheet();
    for (const bad of ['.hidden', 'a/b', 'trailing.', 'café', '']) {
      fireEvent.change(input, { target: { value: bad } });
      expect(createButton().disabled, JSON.stringify(bad)).toBe(true);
      if (bad) {
        expect(input.getAttribute('aria-invalid')).toBe('true');
        const hint = screen.getByText(/can't end in a space or a dot/);
        expect(input.getAttribute('aria-describedby')).toContain(hint.id);
      }
    }
    expect(foldersCreate).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '  my app  ' } });
    expect(input.getAttribute('aria-invalid')).toBe('false');
    fireEvent.click(createButton());
    await waitFor(() => expect(foldersCreate).toHaveBeenCalledWith({ root: 'r.work', parent: 'auth', name: 'my app' }, expect.any(String)));
  });

  it('a folder already listed under that name, in any case: says so, Create off, and Open it goes there', async () => {
    const { api, foldersCreate } = filesApi({}, [
      { name: 'Project', type: 'dir' },
      { name: 'README', type: 'file', size: 10 },
    ]);
    const { history } = renderFiles({ api });
    const input = await openSheet();
    fireEvent.change(input, { target: { value: 'readme' } });
    expect(screen.getByText('There is already a file called README here.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open it' })).toBeNull();
    expect(createButton().disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'project' } });
    expect(screen.getByText('There is already a folder called Project here.')).toBeTruthy();
    expect(createButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    await waitFor(() => expect(history.entries.at(-1)).toBe('/files?root=r.work&path=auth%2FProject%2F'));
    expect(await screen.findByText('Project is ready')).toBeTruthy();
    expect(foldersCreate).not.toHaveBeenCalled();
  });

  it('sends the folder with an Idempotency-Key: a retry of the same name keeps it, another name gets a new one; Enter submits', async () => {
    const foldersCreate = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('network', 'offline', 0))
      .mockRejectedValueOnce(new ApiError('network', 'offline', 0))
      .mockResolvedValue({ root: 'r.work', path: 'auth/other' });
    renderFiles({ api: filesApi({ foldersCreate }).api });
    const input = await openSheet();
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(foldersCreate).toHaveBeenCalledTimes(1));
    expect(foldersCreate).toHaveBeenLastCalledWith({ root: 'r.work', parent: 'auth', name: 'new-project' }, expect.any(String));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not reach the Mac. Check the connection and try again.');
    fireEvent.click(createButton());
    await waitFor(() => expect(foldersCreate).toHaveBeenCalledTimes(2));
    await screen.findByRole('alert');
    fireEvent.change(input, { target: { value: 'other' } });
    fireEvent.click(createButton());
    await waitFor(() => expect(foldersCreate).toHaveBeenCalledTimes(3));
    const keys = foldersCreate.mock.calls.map((c) => c[1] as string);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('while busy: a spinner, Create off, the field read-only', async () => {
    let done: (v: { root: string; path: string }) => void = () => undefined;
    const foldersCreate = vi.fn(() => new Promise<{ root: string; path: string }>((r) => (done = r)));
    renderFiles({ api: filesApi({ foldersCreate }).api });
    const input = await openSheet();
    fireEvent.click(createButton());
    expect(await screen.findByLabelText('Creating')).toBeTruthy();
    expect(createButton().disabled).toBe(true);
    expect(input.readOnly).toBe(true);
    await act(async () => done({ root: 'r.work', path: 'auth/new-project' }));
  });
});

describe('after the folder is made', () => {
  it('opens it with the panel; Start a session here is the start sheet for it; Back is the parent again', async () => {
    const { api, filesList } = filesApi();
    const { history, router } = renderFiles({ api });
    await openSheet();
    const before = history.entries.length;
    fireEvent.click(createButton());
    await waitFor(() => expect(history.entries.at(-1)).toBe('/files?root=r.work&path=auth%2Fnew-project%2F'));
    expect(history.entries.length).toBe(before + 1);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: NEW })).toBeNull());
    expect(await screen.findByText('new-project is ready')).toBeTruthy();
    expect(screen.getByText('~/Desktop/work/auth/new-project')).toBeTruthy();
    expect(screen.getByText(/Claude asks whether to trust a new folder/)).toBeTruthy();
    expect(await screen.findByText('This folder is empty.')).toBeTruthy();
    const start = screen.getByRole('button', { name: START });
    await waitFor(() => expect(document.activeElement).toBe(start));
    // One primary on screen: the header's New Claude session here stays outline.
    expect(screen.getByRole('button', { name: 'New Claude session here' }).className).toContain('border-line-strong');
    expect(start.className).toContain('bg-ink');

    // Back: the parent, asked for again, with the new folder in it, and no panel.
    const asked = filesList.mock.calls.filter(([q]) => q.path === 'auth').length;
    act(() => router.getState().back());
    expect(await screen.findByRole('button', { name: 'new-project' })).toBeTruthy();
    expect(filesList.mock.calls.filter(([q]) => q.path === 'auth').length).toBe(asked + 1);
    expect(screen.queryByText('new-project is ready')).toBeNull();
    // Into it again: no panel (it shows only on the way in from New folder).
    fireEvent.click(screen.getByRole('button', { name: 'new-project' }));
    expect(await screen.findByText('This folder is empty.')).toBeTruthy();
    expect(screen.queryByText('new-project is ready')).toBeNull();
    expect(screen.queryByRole('button', { name: START })).toBeNull();
  });

  it('Start a session here opens /new for the folder with the start sheet up', async () => {
    const { history } = renderFiles();
    await openSheet();
    fireEvent.click(createButton());
    fireEvent.click(await screen.findByRole('button', { name: START }));
    expect(history.entries.at(-1)).toBe('/new?root=r.work&path=auth%2Fnew-project&start=1');
  });

  it("at a root's top the new folder is root/name", async () => {
    const { api, foldersCreate } = filesApi();
    const { history } = renderFiles({ api, path: '/files?root=r.work' });
    await openSheet();
    fireEvent.click(createButton());
    await waitFor(() => expect(foldersCreate).toHaveBeenCalledWith({ root: 'r.work', parent: '', name: 'new-project' }, expect.any(String)));
    await waitFor(() => expect(history.entries.at(-1)).toBe('/files?root=r.work&path=new-project%2F'));
    expect(await screen.findByText('~/Desktop/work/new-project')).toBeTruthy();
  });
});

describe('refusals stay in the sheet', () => {
  const refuse = async (err: ApiError) => {
    const r = renderFiles({ api: filesApi({ foldersCreate: vi.fn(async () => Promise.reject(err)) }).api });
    await openSheet();
    fireEvent.click(createButton());
    return r;
  };

  it("409: the daemon's sentence", async () => {
    const taken = 'A folder named New-Project already exists here; names that differ only in capitals count as the same';
    await refuse(new ApiError('conflict', taken, 409));
    expect((await screen.findByRole('alert')).textContent).toBe(taken);
    expect(screen.getByRole('dialog', { name: NEW })).toBeTruthy();
  });

  it('403 for the missing launch scope: the grant command, and no grant button', async () => {
    localStorage.setItem('jantar:device', JSON.stringify({ id: 'dev-1', name: "Sam's iPhone", scopes: ['read', 'control'] }));
    await refuse(new ApiError('forbidden', 'this device does not have the launch scope', 403));
    await waitFor(() => expect(document.querySelector('[data-no-scope]')).not.toBeNull());
    expect(document.querySelector('[data-no-scope]')!.textContent).toContain("jantar devices grant 'Sam'\\''s iPhone' launch");
    expect(screen.queryByRole('button', { name: /grant/i })).toBeNull();
  });

  it("403 with launching off, and 429: the daemon's sentence", async () => {
    const off = 'Starting sessions from the phone is off. Turn it on at your Mac: jantar launch on';
    const first = await refuse(new ApiError('forbidden', off, 403));
    expect((await screen.findByRole('alert')).textContent).toBe(off);
    first.unmount();
    clearFilesCache();
    await refuse(new ApiError('rate_limited', 'At most 10 new folders an hour; try again later', 429));
    expect((await screen.findByRole('alert')).textContent).toBe('At most 10 new folders an hour; try again later');
  });

  it('offline: Create off with the reason, and nothing is sent', async () => {
    const { api, foldersCreate } = filesApi();
    renderFiles({ api, status: 'offline' });
    const input = await openSheet();
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText("Offline: can't make folders right now")).toBeTruthy();
    fireEvent.submit(input.closest('form')!);
    expect(foldersCreate).not.toHaveBeenCalled();
  });
});

describe('keyboard', () => {
  it('Escape closes the sheet and focus goes back to New folder', async () => {
    renderFiles();
    const button = await screen.findByRole('button', { name: NEW });
    const input = await openSheet();
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: NEW })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it('Cancel closes it too, and the next opening starts afresh', async () => {
    renderFiles();
    const input = await openSheet();
    fireEvent.change(input, { target: { value: 'half-typed' } });
    fireEvent.click(within(screen.getByRole('dialog', { name: NEW })).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: NEW })).toBeNull());
    expect((await openSheet()).value).toBe('new-project');
  });
});
