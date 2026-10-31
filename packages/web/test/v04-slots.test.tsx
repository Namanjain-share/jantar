/**
 * WP0's v0.4 slots: nothing new shows while the Mac keeps Life and the
 * shelf off (the default, and what an older daemon means); each place opens
 * once its switch is on (WP0's placeholders, until their packages land);
 * the Board's project chip renders only with Life on; one Claude login
 * hides the usage strip; the push warning and the shared states say what
 * the spec says.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LifeStatus } from '@jantar/protocol';
import { parseRoute, routePath, type Route } from '../src/lib/router.js';
import { ApiError } from '../src/lib/api.js';
import { NO_PUSH, NO_PUSH_DEVICES, NO_PUSH_SWITCH, PushWarning, pushProblem } from '../src/ui/screens/life/shared/PushWarning.js';
import { CommandSentence, LifeError, NO_CONTROL } from '../src/ui/screens/life/shared/states.js';
import { dayLabel, monthLabel, shiftDayKey, shiftMonthKey } from '../src/ui/screens/life/shared/DayNav.js';
import { renderApp, session, stateWith } from './helpers.js';

function viewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const m = /min-width:\s*(\d+)px/.exec(query);
    return { matches: m ? width >= Number(m[1]) : false, media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false };
  });
}
afterEach(() => vi.unstubAllGlobals());

// The chip as a marker, so the test sees the slot whatever WP-W's chip renders for a folder with no project.
vi.mock('../src/ui/screens/life/todos/ProjectChip.js', async () => {
  const { createElement } = await import('react');
  return { ProjectChip: ({ cwd }: { cwd: string }) => createElement('span', { 'data-testid': 'project-chip' }, cwd) };
});

const LIFE_PATHS = ['/today', '/todos', '/meds', '/food', '/places', '/money'];

describe('v0.4 places', () => {
  it('say they are off at the Mac while their switch is off', async () => {
    viewport(1440);
    for (const path of [...LIFE_PATHS, '/intel']) {
      const { unmount } = renderApp({ path, state: stateWith({ sessions: [session('a')], features: { files: true } }) });
      expect(await screen.findByText('That is off on this Mac.'), path).toBeTruthy();
      expect(screen.getByText(path === '/intel' ? 'jantar intel on' : 'jantar life on <module>'), path).toBeTruthy();
      unmount();
    }
  });

  it('open once the switch is on (placeholders until their packages land)', async () => {
    viewport(1440);
    const titles: Record<string, string> = { '/today': 'Today', '/todos': 'Todos', '/meds': 'Medicines', '/food': 'Food', '/places': 'Cafés', '/money': 'Finance', '/intel': 'Intel' };
    for (const [path, title] of Object.entries(titles)) {
      const { unmount } = renderApp({ path, state: stateWith({ sessions: [session('a')], features: { life: true, intel: true } }) });
      expect(await screen.findByRole('heading', { level: 1, name: title }), path).toBeTruthy();
      unmount();
    }
  });

  it('the shelf needs its own switch, not Life', async () => {
    viewport(1440);
    renderApp({ path: '/intel', state: stateWith({ sessions: [session('a')], features: { life: true } }) });
    expect(await screen.findByText('That is off on this Mac.')).toBeTruthy();
  });
});

describe('routes', () => {
  it('round-trip, reading only ids and keys that match their patterns', () => {
    const cases: Route[] = [
      { name: 'today', dose: '01JFZ8X8Y3T0V5G9WQK2M4N6PR@0800' },
      { name: 'todos', tab: 'reminders', project: '01JFZ8X8Y3T0V5G9WQK2M4N6PR', id: '01JFZ8X8Y3T0V5G9WQK2M4N6PS' },
      { name: 'meds', day: '2026-10-29', med: '01JFZ8X8Y3T0V5G9WQK2M4N6PR' },
      { name: 'food', day: '2026-10-30' },
      { name: 'places', filter: 'want' },
      { name: 'money', month: '2026-10', bill: '01JFZ8X8Y3T0V5G9WQK2M4N6PR' },
      { name: 'intel', q: 'hooks', type: 'tool', tag: 'repo', item: 'captures:01J' },
      { name: 'more' },
    ];
    for (const r of cases) {
      const u = new URL(routePath(r), 'http://x');
      expect(parseRoute(u.pathname, u.search), routePath(r)).toEqual(r);
    }
    expect(parseRoute('/today', '?dose=../x')).toEqual({ name: 'today' });
    expect(parseRoute('/meds', '?day=2026-13-01&med=constructor')).toEqual({ name: 'meds' });
    expect(parseRoute('/todos', '?tab=evil&id=__proto__')).toEqual({ name: 'todos' });
    expect(parseRoute('/places', '?filter=all')).toEqual({ name: 'places', filter: 'all' });
    expect(parseRoute('/intel', '?item=a%20b')).toEqual({ name: 'intel' });
  });
});

describe('the Board row', () => {
  it("renders the project chip in the meta line only while Life is on, with the session's cwd", () => {
    viewport(1440);
    const row = session('a', { status: 'idle' });
    const off = renderApp({ state: stateWith({ sessions: [row], features: { files: true } }) });
    expect(document.querySelector('[data-line2]')).toBeTruthy();
    expect(screen.queryByTestId('project-chip')).toBeNull();
    off.unmount();
    renderApp({ state: stateWith({ sessions: [row], features: { life: true } }) });
    const chip = screen.getByTestId('project-chip');
    expect(chip.textContent).toBe(row.cwd);
    expect(chip.closest('[data-line2]')).toBeTruthy();
  });
});

describe('one Claude login', () => {
  it('hides cswap and the usage pairs on the status bar', () => {
    viewport(1440);
    const accounts = [{ id: 0, emailMasked: 'u***@e***.com', isDefaultLogin: true, disabled: false, held: false, usageStatus: 'unknown', windows: [] }];
    const { unmount } = renderApp({ state: stateWith({ sessions: [session('a')], accounts, features: {} }) });
    expect(screen.getByText(/^cswap /)).toBeTruthy();
    unmount();
    renderApp({ state: stateWith({ sessions: [session('a')], accounts, features: {}, accountsMode: 'single' }) });
    expect(screen.queryByText(/^cswap /)).toBeNull();
    expect(screen.queryByRole('button', { name: /5-hour usage/ })).toBeNull();
  });
});

describe('shared Life pieces', () => {
  const status = (over: Partial<LifeStatus> = {}): LifeStatus => ({
    open: true,
    timezone: 'Asia/Kolkata',
    today: '2026-10-30',
    currency: null,
    lockScreenDetails: false,
    modules: { todos: false, medicines: true, food: false, places: false, finance: false },
    estimate: { available: false },
    backups: { last: null, count: 0 },
    push: { devices: 1, webpush: true },
    ...over,
  });

  it('LW5 (shared part): the push warning shows with no device or Web Push off, and only while medicines are on', () => {
    expect(pushProblem(status())).toBeNull();
    expect(pushProblem(status({ push: { devices: 0, webpush: true } }))).toBe(NO_PUSH_DEVICES);
    expect(pushProblem(status({ push: { devices: 2, webpush: false } }))).toBe(NO_PUSH_SWITCH);
    expect(pushProblem(status({ push: { devices: 0, webpush: true }, modules: { todos: true, medicines: false, food: false, places: false, finance: false } }))).toBeNull();
    expect(pushProblem(null)).toBeNull();
    render(<PushWarning status={status({ push: { devices: 0, webpush: true } })} />);
    expect(screen.getByText(NO_PUSH)).toBeTruthy();
    expect(screen.getByText(NO_PUSH_DEVICES)).toBeTruthy();
  });

  it('a switch off or a broken life.db shows its sentence with the command in mono; no control scope says so', () => {
    const { unmount } = render(<LifeError error={new ApiError('forbidden', 'Medicines are off. Turn them on at your Mac: jantar life on medicines', 403)} />);
    expect(screen.getByText('jantar life on medicines').tagName).toBe('CODE');
    unmount();
    const b = render(<LifeError error={new ApiError('life_unavailable', 'Life data could not be opened. The file is untouched. Restore a backup at your Mac: jantar life restore <file>', 503)} />);
    expect(screen.getByText('jantar life restore <file>').tagName).toBe('CODE');
    b.unmount();
    render(<LifeError error={new ApiError('forbidden', 'this device does not have the control scope', 403)} />);
    expect(screen.getByText(NO_CONTROL)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('CommandSentence leaves a sentence without a command as it is', () => {
    render(<CommandSentence sentence="Nothing due today." />);
    expect(screen.getByText('Nothing due today.')).toBeTruthy();
  });

  it('steps days and months as calendar dates', () => {
    expect(shiftDayKey('2026-10-31', 1)).toBe('2026-11-01');
    expect(shiftDayKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftMonthKey('2026-01', -1)).toBe('2025-12');
    expect(dayLabel('2026-10-30')).toBe('Fri 30 Oct');
    expect(monthLabel('2026-10')).toBe('October 2026');
  });
});
