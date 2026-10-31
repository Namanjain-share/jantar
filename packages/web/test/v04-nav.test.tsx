/**
 * LW4: the places and the phone's tabs (v0.4 spec 5.1, D2). Board, Today,
 * Files, Accounts, Alerts, Devices, Intel in that order, each switch's place
 * only while it is on. Up to five are tabs; with six or more the fifth tab
 * is More, holding the rest, its badge their sum. The rail lists every
 * place and has no More.
 */
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_FEATURES } from '@jantar/protocol';
import { tabItems } from '../src/ui/shell/nav.js';
import { alert, renderApp, session, stateWith } from './helpers.js';

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

describe('tabItems', () => {
  it('five or fewer places are all tabs; six or more give four and More', () => {
    const labels = (f: Partial<typeof NO_FEATURES>) => {
      const t = tabItems({ ...NO_FEATURES, ...f });
      return { tabs: t.tabs.map((i) => i.label), more: t.more.map((i) => i.label) };
    };
    expect(labels({})).toEqual({ tabs: ['Board', 'Accounts', 'Alerts', 'Devices'], more: [] });
    expect(labels({ life: true })).toEqual({ tabs: ['Board', 'Today', 'Accounts', 'Alerts', 'Devices'], more: [] });
    expect(labels({ life: true, files: true })).toEqual({ tabs: ['Board', 'Today', 'Files', 'Accounts', 'More'], more: ['Alerts', 'Devices'] });
    expect(labels({ life: true, files: true, intel: true })).toEqual({ tabs: ['Board', 'Today', 'Files', 'Accounts', 'More'], more: ['Alerts', 'Devices', 'Intel'] });
    expect(labels({ intel: true })).toEqual({ tabs: ['Board', 'Accounts', 'Alerts', 'Devices', 'Intel'], more: [] });
  });
});

describe('on a phone', () => {
  it('nothing new shows while every v0.4 switch is off', () => {
    viewport(390);
    renderApp({ state: stateWith({ sessions: [session('a')], features: { files: true } }) });
    expect(places()).toEqual(['Board', 'Files', 'Accounts', 'Alerts', 'Devices']);
  });

  it("with Files, Life and the shelf on: Board, Today, Files, Accounts, More; More's badge is the new alerts", () => {
    viewport(390);
    renderApp({ state: stateWith({ sessions: [session('a')], alerts: [alert('al-1'), alert('al-2')], features: { files: true, life: true, intel: true } }) });
    expect(places()).toEqual(['Board', 'Today', 'Files', 'Accounts', 'More']);
    expect(nav().className).toContain('grid-cols-5');
    const more = within(nav()).getByRole('link', { name: /More/ });
    expect(more.getAttribute('href')).toBe('/more');
    expect(within(more).getByText('2')).toBeTruthy();
  });

  it('More lists the places it holds', () => {
    viewport(390);
    renderApp({ path: '/more', state: stateWith({ sessions: [session('a')], features: { files: true, life: true, intel: true } }) });
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/alerts', '/devices', '/intel']);
    // The More tab is the current place.
    expect(within(nav()).getByRole('link', { name: /More/ }).getAttribute('aria-current')).toBe('page');
  });

  it('Today stays the current tab on every Life screen', () => {
    viewport(390);
    renderApp({ path: '/meds', state: stateWith({ sessions: [session('a')], features: { life: true } }) });
    expect(within(nav()).getByRole('link', { name: /Today/ }).getAttribute('aria-current')).toBe('page');
  });
});

describe('on the rail', () => {
  it('every place that is on, in order, with no More', () => {
    viewport(1440);
    renderApp({ state: stateWith({ sessions: [session('a')], features: { files: true, life: true, intel: true } }) });
    expect(places()).toEqual(['Board', 'Today', 'Files', 'Accounts', 'Alerts', 'Devices', 'Intel']);
  });
});
