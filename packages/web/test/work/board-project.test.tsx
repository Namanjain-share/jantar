/**
 * 0.13.0 (F3, F4): a Board row opens its project, and the session screen
 * names its project.
 *
 * - A Mac session inside a project's folder has the row menu (long press,
 *   right click) with "Open project", whether or not launching is on; it
 *   opens the project's hub in Work while Work is on, else its Todos
 *   screen. The row stays one link: nothing inside it is an <a> (the chip
 *   is a span). A paired server's session has no project.
 * - The session screen has one line under its title, "Project · Site
 *   rebuild ›", a link to the same place, 44 tall on touch; none outside
 *   every project.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Features } from '@jantar/protocol';
import { layoutAt } from '../../src/ui/shell/layout.js';
import { fakeApi, renderApp, session, stateWith } from '../helpers.js';
import { IDS, WORK_ON, lifeStatus, project } from '../work-helpers.js';

const FOLDER = '/Users/example/Desktop/work/client/acme';
const inside = session('acme-web', { status: 'idle', cwd: `${FOLDER}/web`, folder: 'web' });
const outside = session('notes', { status: 'idle', cwd: '/Users/example/notes', folder: 'notes' });

function pairedWith(scopes: string[]) {
  localStorage.setItem('jantar:device', JSON.stringify({ id: 'dev-1', name: 'Phone', scopes }));
}

function setup(o: { features?: Partial<Features>; work?: boolean; path?: string; layout?: NonNullable<Parameters<typeof renderApp>[0]>['layout'] } = {}) {
  pairedWith(['read', 'control', 'launch']);
  const api = fakeApi({
    lifeStatus: vi.fn(async () => (o.work === false ? lifeStatus({ todos: true }) : WORK_ON())),
    projectsList: vi.fn(async () => ({ projects: [project(IDS.acme, { name: 'Site rebuild', emoji: '🛠', folder: FOLDER })] })),
  });
  return renderApp({ path: o.path ?? '/', api, state: stateWith({ sessions: [inside, outside], features: { life: true, ...o.features } }), ...(o.layout ? { layout: o.layout } : {}) });
}

const row = (sid: string) => document.querySelector<HTMLElement>(`a[data-sid="${sid}"]`)!;
const rightClick = (el: HTMLElement) => {
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(ev);
  });
  return ev;
};

describe("a Board row's project", () => {
  it('"Open project" with launching off, to the hub in Work; the row holds no link inside it', async () => {
    const { history } = setup();
    await waitFor(() => expect(row('acme-web').querySelector('[data-project-chip]')).not.toBeNull());
    expect(row('acme-web').querySelectorAll('a')).toHaveLength(0);
    expect(document.getElementById(row('acme-web').getAttribute('aria-describedby')!)!.textContent).toBe('Long press a session, or right click it, to open its project.');
    // A session outside every project: no menu while launching is off.
    expect(rightClick(row('notes')).defaultPrevented).toBe(false);
    expect(row('notes').hasAttribute('aria-describedby')).toBe(false);
    expect(rightClick(row('acme-web')).defaultPrevented).toBe(true);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open project: Site rebuild' }));
    expect(screen.queryByRole('menuitem', { name: 'New session here' })).toBeNull();
    await waitFor(() => expect(history.entries.at(-1)).toMatch(/^\/(work\?id=|todos\?project=)/));
  });

  it('while Work is off, the project opens in Todos; with launching on, both items', async () => {
    const { history } = setup({ work: false, features: { launch: true } });
    await waitFor(() => expect(row('acme-web').querySelector('[data-project-chip]')).not.toBeNull());
    expect(document.getElementById(row('acme-web').getAttribute('aria-describedby')!)!.textContent).toBe(
      'Long press a session, or right click it, to start a new session in its folder or open its project.',
    );
    rightClick(row('acme-web'));
    expect(await screen.findByRole('menuitem', { name: 'New session here' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open project: Site rebuild' }));
    await waitFor(() => expect(history.entries.at(-1)).toBe(`/todos?project=${IDS.acme}`));
  });

  it('opens the hub in Work once Work is known on', async () => {
    const { history, api } = setup();
    await waitFor(() => expect(api.lifeStatus).toHaveBeenCalled());
    await waitFor(() => expect(row('acme-web').querySelector('[data-project-chip]')).not.toBeNull());
    await act(async () => undefined);
    rightClick(row('acme-web'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open project: Site rebuild' }));
    await waitFor(() => expect(history.entries.at(-1)).toBe(`/work?id=${IDS.acme}`));
  });
});

describe("the session screen's project line", () => {
  it('names the project under the title, a link to its hub, 44 tall on touch', async () => {
    setup({ path: '/s/acme-web', layout: layoutAt(390, { coarse: true }) });
    const line = await screen.findByRole('link', { name: 'Project: 🛠 Site rebuild' });
    expect(line.textContent).toBe('Project·🛠 Site rebuild›');
    await waitFor(() => expect(line.getAttribute('href')).toBe(`/work?id=${IDS.acme}`));
    expect(line.className).toContain('coarse:h-44');
  });

  it('says nothing outside every project', async () => {
    const { api } = setup({ path: '/s/notes' });
    await waitFor(() => expect(api.projectsList).toHaveBeenCalled());
    await act(async () => undefined);
    expect(document.querySelector('[data-project-line]')).toBeNull();
  });
});
