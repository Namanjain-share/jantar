/**
 * Single-account mode on the Board and in a session (v0.4, spec 4.11): with
 * one Claude login there is no account to tell apart and no usage, so Board
 * rows drop the account and its 5-hour %, and the session's meta line and
 * property column drop the account, usage, resets, burn and "Also on". The
 * account's "unknown" usage never shows as a problem. Cswap mode keeps all of it.
 */
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account, Session } from '@jantar/protocol';
import { account, iso, renderApp, session, stateWith } from './helpers.js';

function viewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const m = /min-width:\s*(\d+)px/.exec(query);
    return { matches: m ? width >= Number(m[1]) : false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined };
  });
}

afterEach(() => vi.unstubAllGlobals());

const claude: Account = { id: 0, alias: 'Claude', emailMasked: '', isDefaultLogin: true, disabled: false, held: false, usageStatus: 'unknown', windows: [] };

function sessions(acct: number): Session[] {
  return [
    session('web-app', { account: acct, status: 'working', startedAt: iso(-3600_000), mode: 'acceptEdits' }),
    session('docs', { account: acct, status: 'idle', startedAt: iso(-600_000) }),
  ];
}

const singleState = () => stateWith({ features: {}, accountsMode: 'single', accounts: [claude], sessions: sessions(0) });
const cswapState = () =>
  stateWith({
    features: {},
    accountsMode: 'cswap',
    accounts: [account(3, { alias: 'work', windows: [{ kind: 'five_hour', pct: 72, resetsAt: iso(2 * 3600_000) }] })],
    sessions: sessions(3),
  });

const rowOf = (folder: string) => document.querySelector<HTMLElement>(`[data-sid="${folder}"]`);
const metaLine = () => [...document.querySelectorAll('p.type-mono')].find((p) => /started /.test(p.textContent ?? ''));

describe('Board rows', () => {
  it('drop the account and its 5-hour % with one login', () => {
    viewport(1440);
    renderApp({ path: '/', state: singleState() });
    for (const folder of ['web-app', 'docs']) {
      const row = rowOf(folder);
      expect(row, folder).not.toBeNull();
      expect(row?.querySelector('[data-acct]')).toBeNull();
      expect(row?.textContent).not.toMatch(/\b00\b/);
    }
    expect(document.querySelectorAll('[data-acct]')).toHaveLength(0);
  });

  it('keep the account and its % with cswap', () => {
    viewport(1440);
    renderApp({ path: '/', state: cswapState() });
    expect(rowOf('web-app')?.querySelector('[data-acct]')?.textContent).toBe('03 · 5h 72%');
  });

  it('on a phone too, and the empty board example has no account either', () => {
    viewport(390);
    const { unmount } = renderApp({ path: '/', state: singleState() });
    expect(rowOf('web-app')?.querySelector('[data-acct]')).toBeNull();
    unmount();
    renderApp({ path: '/', state: stateWith({ features: {}, accountsMode: 'single', accounts: [claude] }) });
    expect(screen.getByText('No Claude sessions running')).toBeTruthy();
    expect(document.querySelectorAll('[data-acct]')).toHaveLength(0);
  });
});

describe('a session', () => {
  it("meta line: the mode and the start, never the account or its unknown usage", () => {
    viewport(390);
    renderApp({ path: '/s/web-app', state: singleState() });
    const line = metaLine();
    expect(line?.textContent).toBe('auto-accept edits · started 1h ago');
    expect(line?.querySelector('.text-signal-text')).toBeNull();
    expect(document.body.textContent).not.toContain('usage unknown');
  });

  it('meta line: none at all, not an empty one, when the mode is on the chip and the session has no start time', () => {
    viewport(390);
    const bare = [session('web-app', { account: 0, status: 'working', mode: 'acceptEdits' })];
    const lines = () => document.querySelectorAll('p.type-mono.whitespace-nowrap');
    const off = renderApp({ path: '/s/web-app', state: stateWith({ features: {}, accountsMode: 'single', accounts: [claude], sessions: bare }) });
    expect([...lines()].map((p) => p.textContent)).toEqual(['auto-accept edits']);
    off.unmount();
    renderApp({ path: '/s/web-app', state: stateWith({ features: { controls: true }, accountsMode: 'single', accounts: [claude], sessions: bare }) });
    expect(lines()).toHaveLength(0);
  });

  it('meta line with cswap: the account, its 5-hour % and the reset', () => {
    viewport(390);
    renderApp({ path: '/s/web-app', state: cswapState() });
    const text = metaLine()?.textContent ?? '';
    expect(text).toContain('03 work');
    expect(text).toContain('5h 72');
    expect(text).toContain('resets in 1h55');
  });

  it('property column on a wide Mac: no Account, 5-hour, Resets, Burn or Also on rows', () => {
    viewport(1440);
    renderApp({ path: '/s/web-app', state: singleState() });
    const props = screen.getByRole('complementary', { name: 'Session properties' });
    const keys = [...props.querySelectorAll('dt')].map((dt) => dt.textContent);
    expect(keys).not.toContain('Account');
    expect(keys).not.toContain('5-hour');
    expect(keys).not.toContain('Resets');
    expect(keys.some((k) => k?.startsWith('Also on'))).toBe(false);
    expect(keys).toEqual(expect.arrayContaining(['Mode', 'Started', 'Folder']));
    expect(props.querySelector('[role="meter"]')).toBeNull();
  });

  it('property column with cswap keeps the account rows', () => {
    viewport(1440);
    renderApp({ path: '/s/web-app', state: cswapState() });
    const props = screen.getByRole('complementary', { name: 'Session properties' });
    const keys = [...props.querySelectorAll('dt')].map((dt) => dt.textContent);
    expect(keys).toEqual(expect.arrayContaining(['Account', '5-hour', 'Resets', 'Also on 03']));
  });
});
