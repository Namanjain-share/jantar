/**
 * 0.13.0 "Start from your client folders" (W28, W40, design 11): from
 * Work's empty state, a sheet over Launch's folder browser (or Files' while
 * Launch is off). Every folder starts unticked; a ticked one gets a name
 * from its folder that can be changed; a folder a project links already is
 * marked and can't be ticked; Create sends one `POST /v1/work/seed` with
 * the root, each path and name, and "Also make a client for each" (on by
 * default); the toast says what was made. Made-up folders only.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Features, FilesRootsResponse } from '@jantar/protocol';
import { nameFromFolder } from '../../src/ui/screens/work/model.js';
import { fakeApi, preloadPlaces, renderApp, session, stateWith } from '../helpers.js';
import { IDS, WORK_ON, project, workRequest } from '../work-helpers.js';

preloadPlaces('work');

const ROOTS: FilesRootsResponse = { roots: [{ id: 'r.work', kind: 'configured', label: 'work', display: '~/Desktop/work', home: false }, { id: 's.abc', kind: 'session', label: 'acme', sid: 'abc', display: '~/x', home: false }] };

function setup(features: Partial<Features>, projects: ReturnType<typeof project>[] = []) {
  const seed = vi.fn(() => ({ projects: [IDS.northwind, IDS.globex], skipped: 0, clients: [IDS.client, IDS.deal] }));
  const api = fakeApi({
    lifeStatus: vi.fn(async () => WORK_ON()),
    projectsList: vi.fn(async () => ({ projects })),
    todosList: vi.fn(async () => ({ todos: [], today: '2026-01-15' })),
    foldersRoots: vi.fn(async () => ROOTS),
    filesRoots: vi.fn(async () => ROOTS),
    foldersList: vi.fn(async (q: { root: string; path?: string }) => ({
      root: q.root,
      path: q.path ?? '',
      display: q.path ? `~/Desktop/work/${q.path}` : '~/Desktop/work',
      entries: (q.path === 'client' ? ['acme', 'northwind-traders', 'globex_corp'] : ['client', 'notes']).map((name) => ({ name, link: false, git: false, claudeMd: false, live: 0, pinned: false })),
      next: null,
      hiddenProtected: 0,
      truncated: false,
    })),
    filesList: vi.fn(async (q: { root: string; path?: string }) => ({
      root: q.root,
      path: q.path ?? '',
      entries: [
        { name: 'client', type: 'dir' as const },
        { name: 'readme.md', type: 'file' as const },
      ],
      next: null,
      hiddenProtected: 0,
      truncated: false,
    })),
    request: workRequest({ 'POST /v1/work/seed': seed }),
  });
  const r = renderApp({ path: '/work', state: stateWith({ sessions: [session('a')], features: { life: true, ...features } }), api });
  return { ...r, api, seed };
}

describe('Start from your client folders', () => {
  it('names a project from its folder', () => {
    expect(nameFromFolder('globex-labs')).toBe('Globex Labs');
    expect(nameFromFolder('acme_web')).toBe('Acme Web');
    expect(nameFromFolder('northwind.traders')).toBe('Northwind Traders');
    expect(nameFromFolder('ACME')).toBe('ACME');
  });

  it("through Launch's browser: unticked folders, names to change, one Create with the clients", async () => {
    const { api, seed, toasts } = setup({ launch: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Start from your client folders' }));
    const sheet = await screen.findByRole('dialog', { name: 'Start from your client folders' });
    // Only configured roots: one, so no Where choice.
    expect(within(sheet).queryByLabelText('Where')).toBeNull();
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Open client' }));
    await waitFor(() => expect(api.foldersList).toHaveBeenCalledWith({ root: 'r.work', path: 'client' }));
    const folders = await within(sheet).findByRole('list', { name: 'Folders' });
    const boxes = within(folders).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, false, false]);
    expect((within(sheet).getByRole('button', { name: 'Create project' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(folders).getByRole('checkbox', { name: /northwind-traders/ }));
    fireEvent.click(within(folders).getByRole('checkbox', { name: /globex_corp/ }));
    const name = within(sheet).getByRole('textbox', { name: 'Project name for globex_corp' }) as HTMLInputElement;
    expect(name.value).toBe('Globex Corp');
    fireEvent.change(name, { target: { value: 'Globex' } });
    expect((within(sheet).getByRole('checkbox', { name: 'Also make a client for each' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create 2 projects' }));
    await waitFor(() => expect(seed).toHaveBeenCalled());
    expect(api.request).toHaveBeenCalledWith(
      { method: 'POST', path: '/v1/work/seed' },
      {
        body: {
          items: [
            { root: 'r.work', path: 'client/northwind-traders', name: 'Northwind Traders' },
            { root: 'r.work', path: 'client/globex_corp', name: 'Globex' },
          ],
          clients: true,
        },
        idempotencyKey: expect.any(String),
      },
    );
    await waitFor(() => expect(toasts.getState().toasts.at(-1)?.text).toBe('Made 2 projects, 2 clients.'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start from your client folders' })).toBeNull());
  });

  it('under a list too, marking the folders a project links already', async () => {
    setup({ launch: true }, [project(IDS.acme, { folder: '/Users/example/Desktop/work/client/acme' })]);
    await screen.findByRole('list', { name: 'Active projects' });
    fireEvent.click(await screen.findByRole('button', { name: 'Start from your client folders' }));
    const sheet = await screen.findByRole('dialog', { name: 'Start from your client folders' });
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Open client' }));
    const folders = await within(sheet).findByRole('list', { name: 'Folders' });
    const acme = within(folders).getByRole('checkbox', { name: /acme/ }) as HTMLInputElement;
    expect(acme.disabled).toBe(true);
    expect(acme.closest('label')?.textContent).toBe('acmea project');
    expect((within(folders).getByRole('checkbox', { name: /northwind/ }) as HTMLInputElement).disabled).toBe(false);
  });

  it("through Files' browser while Launch is off: folders only", async () => {
    const { api } = setup({ files: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Start from your client folders' }));
    const sheet = await screen.findByRole('dialog', { name: 'Start from your client folders' });
    const folders = await within(sheet).findByRole('list', { name: 'Folders' });
    expect(within(folders).getAllByRole('checkbox').map((b) => b.closest('label')?.textContent)).toEqual(['client']);
    expect(api.filesList).toHaveBeenCalledWith({ root: 'r.work', path: '' });
    expect(api.foldersRoots).not.toHaveBeenCalled();
  });
});
