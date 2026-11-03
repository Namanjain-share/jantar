/**
 * v0.11 People in his places (spec 4.1, 9.4): People comes last, after
 * Meetings, so on a phone it sits in More; the rail lists it on a wide
 * screen. It shows only while People is on at the Mac (Features.people) and
 * only on a device paired with control (every People route needs it). On
 * /people, People is the current place (More on a phone), not Today.
 */
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_FEATURES } from '@jantar/protocol';
import { writeLocal } from '../src/lib/storage.js';
import { LOCAL_DEVICE_KEY } from '../src/ui/screens/devices/local.js';
import { isCurrent, navItems, tabItems } from '../src/ui/shell/nav.js';
import { renderApp, session, stateWith } from './helpers.js';

function viewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const m = /min-width:\s*(\d+)px/.exec(query);
    return { matches: m ? width >= Number(m[1]) : false, media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false };
  });
}

const nav = () => screen.getByRole('navigation', { name: 'Main' });
const places = () =>
  within(nav())
    .getAllByRole('link')
    .map((l) => l.getAttribute('aria-label') ?? l.textContent?.trim().replace(/\d+$/, ''));

afterEach(() => vi.unstubAllGlobals());

describe('tabItems with People', () => {
  const labels = (f: Partial<typeof NO_FEATURES>) => {
    const t = tabItems({ ...NO_FEATURES, ...f });
    return { tabs: t.tabs.map((i) => i.label), more: t.more.map((i) => i.label) };
  };

  it('last, in More once six places are on; absent while People is off', () => {
    expect(labels({ life: true, people: true })).toEqual({ tabs: ['Board', 'Today', 'Accounts', 'Alerts', 'More'], more: ['Devices', 'People'] });
    expect(labels({ files: true, life: true, intel: true, meetings: true, people: true })).toEqual({
      tabs: ['Board', 'Today', 'Files', 'Accounts', 'More'],
      more: ['Alerts', 'Devices', 'Intel', 'Meetings', 'People'],
    });
    expect(navItems({ ...NO_FEATURES, life: true }).map((i) => i.label)).not.toContain('People');
    expect(navItems({ ...NO_FEATURES, people: true }).find((i) => i.label === 'People')?.href).toBe('/people');
  });

  it('on /people, People is the current place, not Today', () => {
    const items = navItems({ ...NO_FEATURES, life: true, people: true });
    const today = items.find((i) => i.route === 'today');
    const people = items.find((i) => i.route === 'people');
    expect(today && isCurrent(today, 'people')).toBe(false);
    expect(people && isCurrent(people, 'people')).toBe(true);
  });
});

describe('on a phone', () => {
  it('More lists People, and More is the current tab on it', () => {
    viewport(390);
    const on = { files: true, life: true, people: true };
    const { unmount } = renderApp({ path: '/more', state: stateWith({ sessions: [session('a')], features: on }) });
    const more = within(screen.getByRole('list')).getAllByRole('link');
    expect(more.map((l) => l.getAttribute('href'))).toEqual(['/alerts', '/devices', '/people']);
    expect(more.at(-1)?.textContent).toMatch(/People/);
    unmount();
    renderApp({ path: '/more', state: stateWith({ sessions: [session('a')], features: { files: true, life: true } }) });
    expect(within(screen.getByRole('list')).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/alerts', '/devices']);
  });

  it('a device paired without control has no People row', () => {
    viewport(390);
    writeLocal(LOCAL_DEVICE_KEY, { id: 'dev-2', name: 'iPad', scopes: ['read'] });
    renderApp({ path: '/more', state: stateWith({ sessions: [session('a')], features: { files: true, life: true, people: true } }) });
    expect(within(screen.getByRole('list')).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/alerts', '/devices']);
  });
});

describe('on the rail', () => {
  it('People last while it is on; gone while it is off', () => {
    viewport(1440);
    const { unmount } = renderApp({ state: stateWith({ sessions: [session('a')], features: { files: true, life: true, intel: true, meetings: true, people: true } }) });
    expect(places()).toEqual(['Board', 'Today', 'Files', 'Accounts', 'Alerts', 'Devices', 'Intel', 'Meetings', 'People']);
    expect(within(nav()).getByRole('link', { name: 'People' }).getAttribute('href')).toBe('/people');
    unmount();
    renderApp({ state: stateWith({ sessions: [session('a')], features: { files: true, life: true } }) });
    expect(places()).not.toContain('People');
  });
});
