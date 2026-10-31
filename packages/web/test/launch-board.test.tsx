/**
 * W3 on the Board and in ⌘K (spec 5.3.1, 5.3.4): "+ New" in the header and
 * on the empty board, ghost rows for launches on their way (until the real
 * session's row takes over), and "New session in…" in the palette. None of
 * it shows while the Mac keeps launching off.
 */
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DaemonEvent, type LaunchJob, type State } from '@jantar/protocol';
import type { AppStore } from '../src/store.js';
import { emit, iso, renderApp, session, stateWith } from './helpers.js';
import { job, steps, viewport } from './launch-fixtures.js';

function boardState(launch: boolean, launches: LaunchJob[] = [], sessions = [session('a', { status: 'working' })]): State {
  const s = stateWith({ sessions, features: { launch } });
  for (const j of launches) s.launches[j.id] = j;
  return s;
}

const ghosts = () => Array.from(document.querySelectorAll<HTMLElement>('a[data-launch]'));
const ghost = (id: string) => document.querySelector<HTMLElement>(`a[data-launch="${id}"]`)!;
const progress = (store: AppStore, j: LaunchJob): DaemonEvent =>
  ({ seq: store.getState().state.seq + 1, ts: j.updatedAt, type: 'launch.progress', data: { job: j } }) as DaemonEvent;

const OPENING = job('L1', { stage: 'opening', display: '~/Desktop/work/api', createdAt: iso(288_000), steps: steps('queued', 'opening') });
const DIALOG = job('L2', {
  stage: 'dialog',
  display: '~/Desktop/work/web-app',
  account: 8,
  createdAt: iso(289_000),
  dialog: { title: 'Trust this folder?', options: ['Yes, I trust this folder', 'No, exit'], current: 0, since: iso(293_000) },
});
const DONE = job('L3', { stage: 'done', display: '~/Desktop/work/old' });
/** Its session already has a row of its own. */
const ARRIVED = job('L4', { stage: 'prompting', sid: 'a', display: '~/Desktop/work/a' });

afterEach(() => vi.unstubAllGlobals());

describe('a launch waiting on its dialog card needs you (U8)', () => {
  it('counts on the display line and in the title, and Start opens its receipt when no session needs you', () => {
    const { history } = renderApp({ state: boardState(true, [OPENING, DIALOG]) });
    expect(document.querySelector('[data-display]')?.textContent).toBe('1 needs you');
    expect(document.title).toMatch(/^\(1\)/);
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }));
    expect(history.entries.at(-1)).toBe(`/new?root=r.1&launch=L2`);
  });

  it('is not counted while launching is off', () => {
    renderApp({ state: boardState(false, [DIALOG]) });
    expect(document.querySelector('[data-display]')?.textContent).not.toMatch(/need/);
  });
});

describe('+ New on the Board', () => {
  it('is not there while launching is off', () => {
    renderApp({ state: boardState(false) });
    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull();
  });

  it('sits in the header beside the display line and opens New session; on a phone it is the + alone', () => {
    const { history } = renderApp({ state: boardState(true) });
    const button = screen.getByRole('button', { name: 'New session' });
    expect(button.textContent).toBe('');
    expect(button.querySelector('svg')).toBeTruthy();
    fireEvent.click(button);
    expect(history.entries.at(-1)).toBe('/new');
  });

  it('is in the desktop ledger header too, with its word', () => {
    viewport(1440);
    renderApp({ state: boardState(true) });
    const ledger = screen.getByRole('region', { name: 'Ledger' });
    expect(within(ledger).getByRole('button', { name: 'New session' }).textContent).toBe('New');
  });

  it('teaches on the empty board with "New session"', () => {
    const { history } = renderApp({ state: boardState(true, [], []) });
    expect(screen.getByText('No Claude sessions running')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'New session' });
    expect(button.textContent).toBe('New session');
    fireEvent.click(button);
    expect(history.entries.at(-1)).toBe('/new');
  });
});

describe('ghost rows', () => {
  it('shows launches on their way under STARTING, oldest first, and not the finished or arrived ones', () => {
    renderApp({ state: boardState(true, [DIALOG, DONE, ARRIVED, OPENING]) });
    expect(ghosts().map((g) => g.dataset.launch)).toEqual(['L1', 'L2']);
    expect(screen.getByRole('heading', { level: 2, name: 'Starting2' })).toBeTruthy();
    expect(ghost('L1').textContent).toBe('apiStarting07 · opening a window · 12s');
    expect(ghost('L1').getAttribute('data-glyph')).toBe('working');
    // In a dialog the glyph is needs-you and the words say so too.
    expect(ghost('L2').getAttribute('data-glyph')).toBe('needs');
    expect(ghost('L2').textContent).toBe('web-appStarting08 · Claude asks: Trust this folder? · 11s');
    expect(ghost('L2').querySelector('[data-glyph="needs"] .fill-signal')).toBeTruthy();
    expect(ghost('L1').querySelector('.fill-signal')).toBeNull();
  });

  it('names no account with one Claude login', () => {
    const state = stateWith({ sessions: [session('a', { status: 'working' })], features: { launch: true }, accountsMode: 'single' });
    state.launches[OPENING.id] = { ...OPENING, account: 0 };
    renderApp({ state });
    expect(ghost('L1').textContent).toBe('apiStartingopening a window · 12s');
  });

  it('opens the receipt on tap', () => {
    const { history } = renderApp({ state: boardState(true, [OPENING]) });
    fireEvent.click(ghost('L1'));
    expect(history.entries.at(-1)).toBe('/new?root=r.1&launch=L1');
  });

  it('follows the stream and leaves once the launch ends or its session arrives', () => {
    const { store } = renderApp({ state: boardState(true, [OPENING, DIALOG]) });
    act(() => emit(store, [progress(store, { ...OPENING, stage: 'starting', updatedAt: iso(296_000) })]));
    expect(ghost('L1').textContent).toContain('07 · starting Claude');
    act(() => emit(store, [progress(store, { ...OPENING, stage: 'done', updatedAt: iso(297_000) })]));
    expect(ghosts().map((g) => g.dataset.launch)).toEqual(['L2']);
    act(() =>
      emit(store, [
        { seq: store.getState().state.seq + 1, ts: iso(298_000), type: 'session.added', sid: DIALOG.sid, data: { session: session(DIALOG.sid, { status: 'working' }) } } as DaemonEvent,
      ]),
    );
    expect(ghosts()).toEqual([]);
    expect(screen.queryByRole('heading', { level: 2, name: /^Starting/ })).toBeNull();
  });

  it('shows on the empty board too, the first launch included', () => {
    renderApp({ state: boardState(true, [OPENING], []) });
    expect(ghosts().map((g) => g.dataset.launch)).toEqual(['L1']);
    expect(screen.getByText('No Claude sessions running')).toBeTruthy();
  });

  it('stays hidden while launching is off', () => {
    renderApp({ state: boardState(false, [OPENING]) });
    expect(ghosts()).toEqual([]);
  });
});

describe('⌘K', () => {
  it('offers "New session in…" while launching is on, and opens the browser', async () => {
    viewport(1440);
    const { history } = renderApp({ state: boardState(true) });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = await screen.findByPlaceholderText('Jump to a session or account');
    fireEvent.change(input, { target: { value: 'new session' } });
    fireEvent.click(await screen.findByText('New session in…'));
    expect(history.entries.at(-1)).toBe('/new');
  });

  it('has no such entry while launching is off', async () => {
    viewport(1440);
    renderApp({ state: boardState(false) });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await screen.findByPlaceholderText('Jump to a session or account');
    expect(screen.queryByText('New session in…')).toBeNull();
  });
});
