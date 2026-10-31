import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { emptyState, type DaemonEvent } from '@jantar/protocol';
import { PRODUCT_NAME } from '../src/brand.js';
import { App, createAppStore } from '../src/index.js';
import { T0, account, alert, emit, iso, pending, renderApp, session, stateWith } from './helpers.js';

/** Ledger rows in order, as "rail word · sid" (the Board's rows carry data-sid). */
const labels = () =>
  Array.from(document.querySelectorAll<HTMLElement>('a[data-sid]')).map(
    (el) => `${el.getAttribute('data-glyph') === 'turn' ? 'Your turn' : 'Working'} · ${el.dataset.sid}`,
  );

describe('app shell', () => {
  it('renders the board from store events, your turn first', () => {
    const store = createAppStore();
    store.getState().setConn({ status: 'live' });
    render(<App store={store} />);
    expect(screen.getByText('No Claude sessions running')).toBeTruthy();

    const events: DaemonEvent[] = [
      { seq: 1, ts: T0, type: 'session.added', sid: 'alpha', data: { session: session('alpha') } },
      { seq: 2, ts: T0, type: 'session.added', sid: 'bravo', data: { session: session('bravo', { status: 'idle' }) } },
    ];
    act(() => {
      for (const event of events) store.getState().applyMessage({ kind: 'event', event });
    });
    expect(labels()).toEqual(['Your turn · bravo', 'Working · alpha']);
  });

  it('asks for a resync on a gap or a new daemon epoch', () => {
    const store = createAppStore();
    const s = store.getState();
    s.applyMessage({ kind: 'hello', protocol: 1, daemonVersion: '0.1.0', webHash: null, epoch: 'e1', seq: 0 });
    expect(store.getState().needsResync).toBe(false);
    s.applyEvent({ seq: 5, ts: T0, type: 'session.removed', sid: 'x', data: {} });
    expect(store.getState().needsResync).toBe(true);
    s.applyMessage({ kind: 'snapshot', seq: 7, state: emptyState() });
    expect(store.getState().state.seq).toBe(7);
    expect(store.getState().needsResync).toBe(false);
    s.applyMessage({ kind: 'hello', protocol: 1, daemonVersion: '0.1.0', webHash: null, epoch: 'e2', seq: 0 });
    expect(store.getState().needsResync).toBe(true);
  });

  it('flags a new web build when the daemon reports a different hash', () => {
    const store = createAppStore();
    const s = store.getState();
    s.applyMessage({ kind: 'hello', protocol: 1, daemonVersion: '0.1.0', webHash: 'aaa', epoch: 'e1', seq: 0 });
    expect(store.getState().updateAvailable).toBe(false);
    s.applyMessage({ kind: 'hello', protocol: 1, daemonVersion: '0.1.0', webHash: 'bbb', epoch: 'e1', seq: 0 });
    expect(store.getState().updateAvailable).toBe(true);
  });

  it('applies a polled state response only when something changed', () => {
    const store = createAppStore();
    const st = stateWith({ sessions: [session('a')], seq: 4 });
    store.getState().applyStateResponse({ seq: 4, epoch: 'e1', state: st });
    const first = store.getState().state;
    expect(first.sessions.a).toBeTruthy();
    store.getState().applyStateResponse({ seq: 4, epoch: 'e1', state: stateWith({ seq: 4 }) });
    expect(store.getState().state).toBe(first);
    store.getState().applyStateResponse({ seq: 3, epoch: 'e2', state: stateWith({ seq: 3 }) });
    expect(store.getState().state.seq).toBe(3);
    expect(store.getState().epoch).toBe('e2');
  });

  it('shows the pairing steps when the daemon says 401', () => {
    renderApp({ status: 'unauthorized' });
    // direction.md 5.5: the 401 screen names the problem, then the one command.
    expect(screen.getByRole('heading', { name: "This browser isn't paired" })).toBeTruthy();
    expect(screen.getByText('jantar pair')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  it('says when the Mac is unreachable and dashes the strip', () => {
    renderApp({ status: 'offline', state: stateWith({ sessions: [session('a')] }) });
    expect(screen.getByRole('alert').textContent).toBe("Can't reach the Mac. Showing what was last known; retrying.");
    // No connection pill (direction.md 5.0): the strip's cells turn dashed instead.
    const strip = screen.getByRole('button', { name: /All sessions/ });
    expect(strip.getAttribute('data-dashed')).toBe('true');
    expect(strip.querySelectorAll('[data-cell]').length).toBe(1);
  });

  it('badges the Board tab with the needs-you count and Alerts with new alerts', () => {
    const p = pending('a');
    const { store } = renderApp({
      state: stateWith({ sessions: [session('a', { status: 'waiting' }), session('b'), session('c', { status: 'idle' })], pending: [p], alerts: [alert('x1')] }),
    });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: /Board/ }).textContent).toContain('1');
    expect(within(nav).getByRole('link', { name: /Alerts/ }).textContent).toContain('1');
    expect(document.title).toBe(`(1) ${PRODUCT_NAME}`);
    fireEvent.click(within(nav).getByRole('link', { name: /Alerts/ }));
    expect(within(nav).getByRole('link', { name: /Alerts/ }).textContent).not.toMatch(/\d/);
    act(() =>
      emit(store, [{ seq: 11, ts: iso(100_000), type: 'alert.error', data: { alert: alert('x2', { kind: 'error', ts: iso(100_000) }) } }]),
    );
    fireEvent.click(within(nav).getByRole('link', { name: /Board/ }));
    // x2 arrived while the Alerts screen was open, so it counts as seen.
    expect(within(nav).getByRole('link', { name: /Alerts/ }).textContent).not.toMatch(/\d/);
  });

  it('routes to accounts, alerts and devices from the tab bar', () => {
    renderApp({ state: stateWith({ accounts: [account(1)] }) });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    fireEvent.click(within(nav).getByRole('link', { name: /Accounts/ }));
    expect(screen.getByRole('heading', { name: 'Accounts' })).toBeTruthy();
    fireEvent.click(within(nav).getByRole('link', { name: /Alerts/ }));
    expect(screen.getByRole('heading', { name: 'Alerts' })).toBeTruthy();
    fireEvent.click(within(nav).getByRole('link', { name: /Devices/ }));
    expect(screen.getByRole('heading', { name: 'Devices' })).toBeTruthy();
  });

  it('shows a not-found page for unknown paths', () => {
    renderApp({ path: '/nope' });
    expect(screen.getByText('That page does not exist.')).toBeTruthy();
  });
});
