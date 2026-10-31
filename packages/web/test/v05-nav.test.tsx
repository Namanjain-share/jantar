/**
 * MW5: Meetings in the places (v0.5 spec 5.1). It comes after Intel; with
 * every place on the phone shows Board, Today, Files, Accounts and More
 * (Alerts, Devices, Intel, Meetings); it is a tab when five or fewer places
 * are on, and absent while Meetings are off. The rail lists it.
 */
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_FEATURES } from '@jantar/protocol';
import { navItems, tabItems } from '../src/ui/shell/nav.js';
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

describe('tabItems with Meetings', () => {
  const labels = (f: Partial<typeof NO_FEATURES>) => {
    const t = tabItems({ ...NO_FEATURES, ...f });
    return { tabs: t.tabs.map((i) => i.label), more: t.more.map((i) => i.label) };
  };

  it('a tab with five or fewer places on; in More, after Intel, with every place on; absent while off', () => {
    expect(labels({ meetings: true })).toEqual({ tabs: ['Board', 'Accounts', 'Alerts', 'Devices', 'Meetings'], more: [] });
    expect(labels({ files: true, life: true, intel: true, meetings: true })).toEqual({
      tabs: ['Board', 'Today', 'Files', 'Accounts', 'More'],
      more: ['Alerts', 'Devices', 'Intel', 'Meetings'],
    });
    expect(labels({ files: true, life: true, intel: true })).toEqual({ tabs: ['Board', 'Today', 'Files', 'Accounts', 'More'], more: ['Alerts', 'Devices', 'Intel'] });
    expect(navItems({ ...NO_FEATURES }).map((i) => i.label)).not.toContain('Meetings');
    expect(navItems({ ...NO_FEATURES, meetings: true }).find((i) => i.label === 'Meetings')?.href).toBe('/meetings');
  });
});

describe('on a phone', () => {
  it('nothing new shows while Meetings are off', () => {
    viewport(390);
    renderApp({ state: stateWith({ sessions: [session('a')], features: { files: true } }) });
    expect(places()).toEqual(['Board', 'Files', 'Accounts', 'Alerts', 'Devices']);
  });

  it('More lists Meetings last, and More is the current tab on it', () => {
    viewport(390);
    const all = { files: true, life: true, intel: true, meetings: true };
    const { unmount } = renderApp({ path: '/more', state: stateWith({ sessions: [session('a')], features: all }) });
    expect(within(screen.getByRole('list')).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/alerts', '/devices', '/intel', '/meetings']);
    unmount();
    renderApp({ path: '/meetings', state: stateWith({ sessions: [session('a')], features: all }) });
    expect(within(nav()).getByRole('link', { name: /More/ }).getAttribute('aria-current')).toBe('page');
  });
});

describe('on the rail', () => {
  it('every place that is on, Meetings last', () => {
    viewport(1440);
    renderApp({ state: stateWith({ sessions: [session('a')], features: { files: true, life: true, intel: true, meetings: true } }) });
    expect(places()).toEqual(['Board', 'Today', 'Files', 'Accounts', 'Alerts', 'Devices', 'Intel', 'Meetings']);
  });
});
