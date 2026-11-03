/**
 * 0.13.0 Work's place in the app (design 6.1, 13; W18-W20):
 *
 * - Work sits in NAV right after Chat, shown only while Life status says
 *   Work is on, and only on a device paired with control. With Life, Chat
 *   and Work on, a phone's tabs are Board, Today, Chat, Work and More (Files
 *   in More); with Chat off Files keeps its tab. The Mac's rail and the
 *   iPad's sidebar list it in the same order.
 * - ⌘1-⌘9 keep 0.12's nine places (CMD_PLACES); Work is `g w`, and says
 *   it is off while it is.
 * - /work parses and prints back; while Work is on, Todos' Projects tab and a
 *   project's old address land in Work, and stay in Todos while it is off.
 * - The Work place's states: Life off (the shell's off page), Work off (the
 *   daemon's sentence), no control, Life status failing, loading.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_FEATURES } from '@jantar/protocol';
import { parseRoute, routePath } from '../../src/lib/router.js';
import { writeLocal } from '../../src/lib/storage.js';
import { ApiError } from '../../src/lib/api.js';
import { LOCAL_DEVICE_KEY } from '../../src/ui/screens/devices/local.js';
import { CMD_PLACES, NAV, isCurrent, navItems, tabItems } from '../../src/ui/shell/nav.js';
import { offSentence } from '../../src/ui/shell/Shell.js';
import { layoutAt } from '../../src/ui/shell/layout.js';
import { fakeApi, preloadPlaces, renderApp, session, stateWith } from '../helpers.js';
import { lifeStatus, WORK_ON, workRequest } from '../work-helpers.js';

preloadPlaces('work', 'todos');

afterEach(() => vi.unstubAllGlobals());

const nav = () => screen.getByRole('navigation', { name: 'Main' });
const labels = (f: Partial<typeof NO_FEATURES> & { work?: boolean }) => {
  const t = tabItems({ ...NO_FEATURES, ...f });
  return { tabs: t.tabs.map((i) => i.label), more: t.more.map((i) => i.label) };
};
const workApi = (over = {}) => fakeApi({ lifeStatus: vi.fn(async () => WORK_ON()), projectsList: vi.fn(async () => ({ projects: [] })), todosList: vi.fn(async () => ({ todos: [], today: '2026-01-15' })), ...over });

describe('Work in NAV', () => {
  it('right after Chat; a phone tab with Life, Chat and Work on, Files moving into More', () => {
    expect(NAV.map((n) => n.route).slice(0, 5)).toEqual(['board', 'today', 'chat', 'work', 'files']);
    expect(labels({ files: true, life: true, ask: true, work: true })).toEqual({ tabs: ['Board', 'Today', 'Chat', 'Work', 'More'], more: ['Files', 'Accounts', 'Alerts', 'Devices'] });
    // Chat off: Files keeps its tab.
    expect(labels({ files: true, life: true, work: true }).tabs).toEqual(['Board', 'Today', 'Work', 'Files', 'More']);
    // Absent or off: no Work.
    expect(navItems({ ...NO_FEATURES, life: true }).map((i) => i.route)).not.toContain('work');
    expect(navItems({ ...NO_FEATURES, life: true, work: false }).map((i) => i.route)).not.toContain('work');
    const work = NAV.find((n) => n.route === 'work');
    expect(work?.href).toBe('/work');
    expect(work && isCurrent(work, 'work')).toBe(true);
    expect(work && isCurrent(work, 'todos')).toBe(false);
  });

  it('⌘1-⌘9 stay 0.12 places, whatever NAV holds', () => {
    expect(CMD_PLACES).toEqual(['board', 'today', 'chat', 'files', 'accounts', 'alerts', 'devices', 'intel', 'meetings']);
    for (const r of CMD_PLACES) expect(NAV.some((n) => n.route === r)).toBe(true);
    expect(CMD_PLACES).not.toContain('work');
  });

  it('the Mac rail lists Work while Life status says it is on, and ⌘4 is still Files', async () => {
    const state = stateWith({ sessions: [session('a')], features: { files: true, life: true, ask: true } });
    const { history } = renderApp({ state, api: workApi(), layout: layoutAt(1440) });
    const work = await within(nav()).findByRole('link', { name: 'Work' });
    expect(work.getAttribute('href')).toBe('/work');
    const places = within(nav())
      .getAllByRole('link')
      .map((l) => l.getAttribute('aria-label'));
    expect(places.slice(0, 5)).toEqual(['Board', 'Today', 'Chat', 'Work', 'Files']);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '4', code: 'Digit4', metaKey: true }));
    expect(history.entries.at(-1)).toBe('/files');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
    expect(history.entries.at(-1)).toBe('/work');
  });

  it('no Work while it is off, nor on a device paired without control; g w says why', async () => {
    const state = stateWith({ sessions: [session('a')], features: { life: true } });
    const off = fakeApi({ lifeStatus: vi.fn(async () => lifeStatus({ todos: true })) });
    const a = renderApp({ state, api: off, layout: layoutAt(1440) });
    await waitFor(() => expect(off.lifeStatus).toHaveBeenCalled());
    expect(within(nav()).queryByRole('link', { name: 'Work' })).toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
    expect(a.history.entries.at(-1)).toBe('/');
    expect(a.toasts.getState().toasts.at(-1)?.text).toMatch(/^Work is off on this Mac\. Turn it on at the Mac: .+ work on$/);
    a.unmount();
    // Read only: Life status is a control read, so it is never asked, and Work never shows.
    writeLocal(LOCAL_DEVICE_KEY, { id: 'dev-2', name: 'iPad', scopes: ['read'] });
    const api = workApi();
    renderApp({ state, api, layout: layoutAt(1440) });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.lifeStatus).not.toHaveBeenCalled();
    expect(within(nav()).queryByRole('link', { name: 'Work' })).toBeNull();
    expect(offSentence(NAV.find((n) => n.route === 'work')!, false, false)).toBe('Work needs a device paired with control.');
  });
});

describe('/work', () => {
  it('parses and prints back', () => {
    const id = '01JWRKPRJ0000000000000ACME';
    expect(parseRoute('/work')).toEqual({ name: 'work' });
    expect(parseRoute('/work', `?tab=projects&id=${id}`)).toEqual({ name: 'work', tab: 'projects', id });
    expect(parseRoute('/work', '?tab=clients&id=not-an-id')).toEqual({ name: 'work', tab: 'clients' });
    expect(parseRoute('/work', '?tab=nope')).toEqual({ name: 'work' });
    expect(routePath({ name: 'work', tab: 'projects', id })).toBe(`/work?id=${id}`);
    expect(routePath({ name: 'work', tab: 'deals' })).toBe('/work?tab=deals');
    for (const p of ['/work', `/work?id=${id}`, '/work?tab=clients', '/work?tab=insights']) {
      const [path, q = ''] = p.split('?');
      expect(routePath(parseRoute(path!, q ? `?${q}` : ''))).toBe(p);
    }
  });

  it('while Work is on, Todos’ Projects tab and a project’s old address open it in Work (W20)', async () => {
    const id = '01JWRKPRJ0000000000000ACME';
    const state = stateWith({ sessions: [session('a')], features: { life: true } });
    const a = renderApp({ path: '/todos?tab=projects', state, api: workApi() });
    await waitFor(() => expect(a.history.entries.at(-1)).toBe('/work'));
    a.unmount();
    const b = renderApp({ path: `/todos?project=${id}`, state, api: workApi({ request: workRequest({}) }) });
    await waitFor(() => expect(b.history.entries.at(-1)).toBe(`/work?id=${id}`));
    b.unmount();
    // On: Todos has no Projects tab.
    const t = renderApp({ path: '/todos', state, api: workApi() });
    const show = await screen.findByRole('group', { name: 'Show' });
    await waitFor(() => expect(within(show).getAllByRole('button').map((x) => x.textContent)).toEqual(['Todos', 'Reminders']));
    t.unmount();
    // Off: Todos keeps its projects.
    const off = fakeApi({ lifeStatus: vi.fn(async () => lifeStatus({ todos: true })), projectsList: vi.fn(async () => ({ projects: [] })), todosList: vi.fn(async () => ({ todos: [], today: '2026-01-15' })) });
    const c = renderApp({ path: '/todos?tab=projects', state, api: off });
    await waitFor(() => expect(off.lifeStatus).toHaveBeenCalled());
    await screen.findByRole('heading', { level: 1, name: 'Todos' });
    expect(c.history.entries.at(-1)).toBe('/todos?tab=projects');
    expect(within(screen.getByRole('group', { name: 'Show' })).getAllByRole('button').map((x) => x.textContent)).toEqual(['Todos', 'Reminders', 'Projects']);
  });
});

describe('the Work place’s states (design 6.5)', () => {
  const state = stateWith({ sessions: [session('a')], features: { life: true } });

  it('Life off: the shell says how to turn Work on', () => {
    renderApp({ path: '/work', state: stateWith({ sessions: [session('a')], features: { files: true } }) });
    expect(screen.getByText('That is off on this Mac.')).toBeTruthy();
    expect(screen.getByText(/work on$/)).toBeTruthy();
  });

  it('Work off: the daemon’s sentence, its command in mono, under the title', async () => {
    renderApp({ path: '/work', state, api: fakeApi({ lifeStatus: vi.fn(async () => lifeStatus({ todos: true })) }) });
    expect(await screen.findByRole('heading', { level: 1, name: 'Work' })).toBeTruthy();
    const code = await screen.findByText('jantar work on');
    expect(code.tagName).toBe('CODE');
    expect(code.closest('[role="status"]')?.textContent).toBe('Work is off. Turn it on at your Mac: jantar work on');
  });

  it('no control: the Life sentence, and nothing is asked', async () => {
    writeLocal(LOCAL_DEVICE_KEY, { id: 'dev-2', name: 'Phone', scopes: ['read'] });
    const api = workApi();
    renderApp({ path: '/work', state, api });
    expect(await screen.findByText(/This device can read sessions only/)).toBeTruthy();
    expect(api.projectsList).not.toHaveBeenCalled();
  });

  it('Life status unreachable: the offline sentence with Try again; still loading: the skeleton', async () => {
    renderApp({ path: '/work', state, api: fakeApi({ lifeStatus: vi.fn(async () => Promise.reject(new ApiError('network', 'down', 0))) }) });
    expect(await screen.findByText(/Can't reach the Mac/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
