/**
 * v0.4 (WP-LA, spec 5.9): "New Claude session here" in the Files folder
 * header, the one way into the start sheet from Files (the ··· item it
 * replaces is gone): shown only while launching is on, in every state of the
 * folder (loading, empty, refused, listed), on its own row under the
 * breadcrumb on a phone and beside the ··· on a wider screen, outline and
 * ink only. It opens /new for that folder with the start sheet up. Every
 * path here is made up.
 */
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Features } from '@jantar/protocol';
import { ApiError, type Api } from '../src/lib/api.js';
import { clearFilesCache } from '../src/ui/screens/files/data.js';
import { FILES_ON, listing, pendingForever, root, viewport } from './files-helpers.js';
import { fakeApi, preloadPlaces, renderApp, stateWith } from './helpers.js';

preloadPlaces('files');

const ROOTS = [root('r.work', { label: 'work', display: '~/Desktop/work' }), root('s.a', { kind: 'session', sid: 'a', label: 'a', display: '~/work/a' })];
const LAUNCH_ON: Partial<Features> = { ...FILES_ON, launch: true };
const BUTTON = 'New Claude session here';

beforeEach(() => clearFilesCache());
afterEach(() => vi.unstubAllGlobals());

function filesApi(filesList: Api['filesList'] = vi.fn(async () => listing([{ name: 'src', type: 'dir' }]))) {
  return fakeApi({ filesRoots: vi.fn(async () => ({ roots: ROOTS })), filesChanges: vi.fn(async () => ({ changes: [] })), filesList });
}

describe('New Claude session here (Files)', () => {
  it('opens the start sheet for the folder shown; the ··· menu no longer has a start item', async () => {
    const { history } = renderApp({ path: '/files?root=r.work&path=auth%2F', api: filesApi(), state: stateWith({ features: LAUNCH_ON }) });
    const button = await screen.findByRole('button', { name: BUTTON });
    fireEvent.click(screen.getByRole('button', { name: 'Folder options' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Show hidden files']);
    expect(screen.queryByRole('menuitem', { name: /session/i })).toBeNull();
    // Showing hidden files: still that one item, now the other way.
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Show hidden files' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Folder options' }));
    const again = await screen.findByRole('menu');
    expect(within(again).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Hide hidden files']);
    fireEvent.keyDown(again, { key: 'Escape' });
    fireEvent.click(button);
    expect(history.entries.at(-1)).toBe('/new?root=r.work&path=auth&start=1');
  });

  it("at a root's top, and in a live session's folder, it opens that folder", async () => {
    const a = renderApp({ path: '/files?root=r.work', api: filesApi(), state: stateWith({ features: LAUNCH_ON }) });
    fireEvent.click(await screen.findByRole('button', { name: BUTTON }));
    expect(a.history.entries.at(-1)).toBe('/new?root=r.work&start=1');
    a.unmount();
    clearFilesCache();
    const b = renderApp({ path: '/files?root=s.a&path=docs%2Fapi%2F', api: filesApi(), state: stateWith({ features: LAUNCH_ON }) });
    fireEvent.click(await screen.findByRole('button', { name: BUTTON }));
    expect(b.history.entries.at(-1)).toBe('/new?root=s.a&path=docs%2Fapi&start=1');
  });

  it('is not there while launching is off, nor on the list of roots', async () => {
    const off = renderApp({ path: '/files?root=r.work&path=auth%2F', api: filesApi(), state: stateWith({ features: FILES_ON }) });
    await screen.findByRole('button', { name: 'src' });
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
    // The ··· menu is the same with launching off: only the hidden files.
    fireEvent.click(screen.getByRole('button', { name: 'Folder options' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Show hidden files']);
    off.unmount();
    clearFilesCache();
    renderApp({ path: '/files', api: filesApi(), state: stateWith({ features: LAUNCH_ON }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Browse' }));
    await screen.findByRole('list', { name: 'Folders' });
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
  });

  it('is in the header in every state of the folder: loading, empty, refused and listed', async () => {
    for (const filesList of [
      vi.fn(pendingForever),
      vi.fn(async () => listing([])),
      vi.fn(async () => Promise.reject(new ApiError('forbidden', 'That folder is protected.', 403))),
      vi.fn(async () => listing([{ name: 'a.ts', type: 'file', size: 3 }])),
    ]) {
      clearFilesCache();
      const r = renderApp({ path: '/files?root=r.work&path=x%2F', api: filesApi(filesList as Api['filesList']), state: stateWith({ features: LAUNCH_ON }) });
      expect(await screen.findByRole('button', { name: BUTTON })).toBeTruthy();
      r.unmount();
    }
  });

  it('phone: its own row under the breadcrumb; a wide screen: beside the ···; outline and ink, never ember', async () => {
    const phone = renderApp({ path: '/files?root=r.work&path=auth%2F', api: filesApi(), state: stateWith({ features: LAUNCH_ON }) });
    const crumbs = await screen.findByRole('navigation', { name: 'Folder path' });
    const button = screen.getByRole('button', { name: BUTTON });
    expect(crumbs.parentElement?.contains(button)).toBe(false);
    expect(crumbs.parentElement?.nextElementSibling?.contains(button)).toBe(true);
    expect(button.className).toContain('border-line-strong');
    expect(button.className).not.toMatch(/signal|bg-ink\b/);
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    phone.unmount();

    viewport(1440);
    clearFilesCache();
    renderApp({ path: '/files?root=r.work&path=auth%2F', api: filesApi(), state: stateWith({ features: LAUNCH_ON }) });
    const bar = (await screen.findByRole('navigation', { name: 'Folder path' })).parentElement!;
    const wide = within(bar).getByRole('button', { name: BUTTON });
    // Before the ···, in the same bar.
    const options = within(bar).getByRole('button', { name: 'Folder options' });
    expect(wide.compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
