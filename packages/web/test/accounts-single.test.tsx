/**
 * Accounts with one Claude login (v0.4 single-account mode, spec 4.11):
 * "One Claude login. Usage and account moves need cswap (optional)." and the
 * one account with its sessions; no usage, ceiling, refresh, sort, holds,
 * autoswitch or moves, on a phone and on a Mac. Cswap mode is unchanged.
 */
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '@jantar/protocol';
import { SINGLE_DISPLAY, SINGLE_SENTENCE, sessionsText } from '../src/ui/screens/accounts/Single.js';
import { account, fakeApi, renderApp, session, stateWith } from './helpers.js';

/** Pretend the window is `width` px wide (jsdom has no matchMedia). */
function viewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const m = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: m ? width >= Number(m[1]) : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  });
}

afterEach(() => vi.unstubAllGlobals());

/** The one account sources/cswap/single.ts publishes. */
const claude: Account = { id: 0, alias: 'Claude', emailMasked: '', isDefaultLogin: true, disabled: false, held: false, usageStatus: 'unknown', windows: [] };

function single(over: Parameters<typeof stateWith>[0] = {}) {
  return stateWith({
    features: {},
    accountsMode: 'single',
    accounts: [claude],
    sessions: [session('web-app', { account: 0, status: 'waiting', name: 'fix login' }), session('docs', { account: 0, status: 'idle', name: 'changelog' })],
    ...over,
  });
}

/** Nothing about usage, holds or autoswitch is on screen. */
function expectNoUsage() {
  expect(screen.queryByRole('meter')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
  expect(screen.queryByRole('group', { name: 'Sort accounts' })).toBeNull();
  const text = document.body.textContent ?? '';
  for (const word of ['ceiling', 'autoswitch', '5h', 'held', 'next →', 'usage unknown', 'Moves']) expect(text).not.toContain(word);
}

describe('Accounts with one Claude login', () => {
  it('on a phone: the sentence, the one account and its sessions as links', () => {
    viewport(390);
    const api = fakeApi();
    const { history } = renderApp({ path: '/accounts', api, state: single() });
    expect(screen.getByRole('heading', { level: 1, name: 'Accounts' })).toBeTruthy();
    expect(screen.getByText(SINGLE_DISPLAY).hasAttribute('data-display')).toBe(true);
    expect(SINGLE_DISPLAY).toBe('One Claude login');
    expect(screen.getByText(SINGLE_SENTENCE)).toBeTruthy();
    expect(SINGLE_SENTENCE).toBe('Usage and account moves need cswap (optional).');

    const list = screen.getByRole('list', { name: 'Accounts' });
    const rows = within(list).getAllByRole('listitem').filter((li) => li.hasAttribute('data-account'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('Claude');
    expect(rows[0]?.textContent).toContain('2 sessions');
    const links = within(list).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('aria-label')?.split(' · ')[0])).toEqual(['web-app', 'docs']);
    expectNoUsage();
    // No usage refresh is ever asked for.
    expect(api.refreshUsage).not.toHaveBeenCalled();

    fireEvent.click(links[0] as HTMLElement);
    expect(history.entries.at(-1)).toBe('/s/web-app');
  });

  it('on a Mac: the same view, no matrix', () => {
    viewport(1440);
    renderApp({ path: '/accounts', state: single() });
    expect(screen.getByText(SINGLE_DISPLAY)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('columnheader')).toBeNull();
    expectNoUsage();
  });

  it('with no sessions, says so', () => {
    viewport(390);
    renderApp({ path: '/accounts', state: single({ sessions: [] }) });
    expect(screen.getByText('No sessions right now')).toBeTruthy();
    expect(screen.queryAllByRole('link', { name: / · / })).toEqual([]);
    expect([sessionsText(0), sessionsText(1), sessionsText(3)]).toEqual(['No sessions right now', '1 session', '3 sessions']);
  });

  it('names the account Claude before the daemon has sent it', () => {
    viewport(390);
    renderApp({ path: '/accounts', state: single({ accounts: [] }) });
    const row = document.querySelector('[data-account="single"]');
    expect(row?.textContent).toContain('Claude');
  });

  it('waits for the first sync with the skeleton, and offline keeps showing what it last knew', async () => {
    viewport(390);
    const first = renderApp({ path: '/accounts', state: single({ seq: 0 }) });
    expect(await screen.findByText('Connecting to the Mac…')).toBeTruthy();
    expect(screen.queryByText(SINGLE_DISPLAY)).toBeNull();
    first.unmount();

    renderApp({ path: '/accounts', state: single(), status: 'offline' });
    expect(screen.getByText(SINGLE_DISPLAY)).toBeTruthy();
    expect(screen.getByText('2 sessions')).toBeTruthy();
  });

  it('cswap mode is unchanged: usage, the ceiling and Refresh', () => {
    viewport(390);
    renderApp({ path: '/accounts', state: stateWith({ features: {}, accountsMode: 'cswap', accounts: [account(1), account(2)] }) });
    expect(screen.queryByText(SINGLE_DISPLAY)).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect(screen.getAllByRole('meter').length).toBeGreaterThan(0);
  });

  it('a daemon from before v0.4 (no accounts mode) is cswap', () => {
    viewport(390);
    renderApp({ path: '/accounts', state: stateWith({ accounts: [account(1)] }) });
    expect(screen.queryByText(SINGLE_DISPLAY)).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });
});
