/**
 * The Board's project chip and useProjects (v0.4 spec 5.3, gate LW6): one
 * cached list for every row, fetched only while Life is on and the stored
 * device scopes include control; again when lifeTick moves; never again
 * after a 403 or a 503 until the app reloads. The chip names the project
 * whose folder holds the session (the deepest folder wins), with its emoji
 * or a folder icon, and nothing for a session outside every project.
 */
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectView } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import { inFolder, projectFor } from '../src/ui/screens/life/todos/useProjects.js';
import { liveIn, sessionFolders } from '../src/ui/screens/life/todos/model.js';
import { fakeApi, iso, renderApp, session, stateWith } from './helpers.js';

const id = (n: number) => `01JFZ8X8Y3T0V5G9WQK2M4N${String(n).padStart(3, '0')}`;

function project(n: number, over: Partial<ProjectView> = {}): ProjectView {
  return { id: id(n), name: `Example ${n}`, status: 'active', open: 0, overdue: 0, createdAt: iso(0), updatedAt: iso(0), ...over };
}

function pairedWith(scopes: string[]) {
  localStorage.setItem('jantar:device', JSON.stringify({ id: 'dev-1', name: 'Phone', scopes }));
}

const rows = [
  session('a', { status: 'idle', cwd: '/synthetic/home/work/alpha' }),
  session('b', { status: 'idle', cwd: '/synthetic/home/work/alpha/sub/deep' }),
  session('c', { status: 'idle', cwd: '/synthetic/home/other' }),
];

const chips = () => [...document.querySelectorAll('[data-project-chip]')].map((c) => c.textContent);

function tick(store: ReturnType<typeof renderApp>['store'], n: number) {
  act(() => store.setState((s) => ({ state: { ...s.state, lifeTick: n } })));
}

describe('useProjects (LW6)', () => {
  it('makes no request without control in the stored scopes', async () => {
    pairedWith(['read']);
    const projectsList = vi.fn(async () => ({ projects: [project(1, { folder: '/synthetic/home/work/alpha' })] }));
    const { store } = renderApp({ api: fakeApi({ projectsList }), state: stateWith({ sessions: rows, features: { life: true }, lifeTick: 1 }) });
    tick(store, 2);
    await act(async () => undefined);
    expect(projectsList).not.toHaveBeenCalled();
    expect(chips()).toEqual([]);
  });

  it('makes no request with no stored device at all', async () => {
    const projectsList = vi.fn(async () => ({ projects: [] }));
    renderApp({ api: fakeApi({ projectsList }), state: stateWith({ sessions: rows, features: { life: true } }) });
    await act(async () => undefined);
    expect(projectsList).not.toHaveBeenCalled();
  });

  it('makes no request while Life is off', async () => {
    pairedWith(['read', 'control']);
    const projectsList = vi.fn(async () => ({ projects: [] }));
    renderApp({ api: fakeApi({ projectsList }), state: stateWith({ sessions: rows, features: { files: true } }) });
    await act(async () => undefined);
    expect(projectsList).not.toHaveBeenCalled();
  });

  it('fetches once for every row, and again when lifeTick moves', async () => {
    pairedWith(['read', 'control']);
    const projectsList = vi.fn(async () => ({
      projects: [project(1, { folder: '/synthetic/home/work/alpha', emoji: '🛠' }), project(2, { name: 'Deep one', folder: '/synthetic/home/work/alpha/sub/' })],
    }));
    const { store } = renderApp({ api: fakeApi({ projectsList }), state: stateWith({ sessions: rows, features: { life: true }, lifeTick: 1 }) });
    await waitFor(() => expect(chips()).toHaveLength(2));
    expect(projectsList).toHaveBeenCalledTimes(1);
    // a is in Example 1's folder, b deeper in Deep one's, c in none.
    expect(chips()).toEqual(expect.arrayContaining(['Project 🛠Example 1', 'Project Deep one']));
    const chipA = document.querySelector('[data-project-chip]');
    expect(chipA?.classList.contains('type-mono')).toBe(true);
    expect(chipA?.classList.contains('text-ink-2')).toBe(true);
    tick(store, 2);
    await waitFor(() => expect(projectsList).toHaveBeenCalledTimes(2));
  });

  it('makes no second request after a 403', async () => {
    pairedWith(['read', 'control']);
    const projectsList = vi.fn(async (): Promise<never> => {
      throw new ApiError('forbidden', 'Todos are off. Turn them on at your Mac: jantar life on todos', 403);
    });
    const { store } = renderApp({ api: fakeApi({ projectsList }), state: stateWith({ sessions: rows, features: { life: true }, lifeTick: 1 }) });
    await waitFor(() => expect(projectsList).toHaveBeenCalledTimes(1));
    tick(store, 2);
    tick(store, 3);
    await act(async () => undefined);
    expect(projectsList).toHaveBeenCalledTimes(1);
    expect(chips()).toEqual([]);
  });

  it('makes no second request after a 503 (Life broken)', async () => {
    pairedWith(['read', 'control']);
    const projectsList = vi.fn(async (): Promise<never> => {
      throw new ApiError('life_unavailable', 'Life data could not be opened. The file is untouched. Restore a backup at your Mac: jantar life restore <file>', 503);
    });
    const { store } = renderApp({ api: fakeApi({ projectsList }), state: stateWith({ sessions: rows, features: { life: true }, lifeTick: 1 }) });
    await waitFor(() => expect(projectsList).toHaveBeenCalledTimes(1));
    tick(store, 2);
    await act(async () => undefined);
    expect(projectsList).toHaveBeenCalledTimes(1);
  });

  it('tries again on the next tick after a network failure', async () => {
    pairedWith(['read', 'control']);
    const projectsList = vi
      .fn<() => Promise<{ projects: ProjectView[] }>>()
      .mockRejectedValueOnce(new ApiError('network', 'offline', 0))
      .mockResolvedValue({ projects: [project(1, { folder: '/synthetic/home/other' })] });
    const { store } = renderApp({ api: fakeApi({ projectsList }), state: stateWith({ sessions: rows, features: { life: true }, lifeTick: 1 }) });
    await waitFor(() => expect(projectsList).toHaveBeenCalledTimes(1));
    tick(store, 2);
    await waitFor(() => expect(chips()).toEqual(['Project Example 1']));
  });
});

describe('the chip on a Board row', () => {
  it('shows the project with a folder icon when it has no emoji, in the row meta line', async () => {
    pairedWith(['read', 'control']);
    const projectsList = vi.fn(async () => ({ projects: [project(3, { folder: '/synthetic/home/other' })] }));
    renderApp({ api: fakeApi({ projectsList }), state: stateWith({ sessions: [rows[2]!], features: { life: true } }) });
    const chip = await screen.findByText('Example 3');
    const box = chip.closest('[data-project-chip]');
    expect(box?.querySelector('svg')).toBeTruthy();
    expect(box?.closest('[data-line2]')).toBeTruthy();
  });
});

describe('folder matching', () => {
  it('matches the folder itself and what is under it, never a sibling with the same prefix', () => {
    expect(inFolder('/w/alpha', '/w/alpha')).toBe(true);
    expect(inFolder('/w/alpha/x', '/w/alpha/')).toBe(true);
    expect(inFolder('/w/alphabet', '/w/alpha')).toBe(false);
    expect(inFolder('/w/alpha', 'w/alpha')).toBe(false);
    expect(inFolder('/anything', '/')).toBe(true);
  });

  it('picks the deepest project folder', () => {
    const list = [project(1, { folder: '/w' }), project(2, { folder: '/w/a/b' }), project(3, { folder: '/w/a' }), project(4)];
    expect(projectFor('/w/a/b/c', list)?.id).toBe(id(2));
    expect(projectFor('/w/z', list)?.id).toBe(id(1));
    expect(projectFor('/elsewhere', list)).toBeNull();
  });

  it("v0.6: a paired server's session is never a project's live session or a Folder choice", () => {
    const all = [
      session('mac', { status: 'idle', cwd: '/w/alpha' }),
      session('srv', { status: 'idle', cwd: '/w/alpha/api', node: '01JF1EETN0DEBV11D1000000A1' }),
      session('srv2', { status: 'idle', cwd: '/srv/beta', node: '01JF1EETN0DEBV11D1000000A1' }),
      session('gone', { status: 'ended', cwd: '/w/alpha' }),
    ];
    expect(liveIn(all, '/w/alpha').map((s) => s.sid)).toEqual(['mac']);
    expect(sessionFolders(all)).toEqual(['/w/alpha']);
  });
});
