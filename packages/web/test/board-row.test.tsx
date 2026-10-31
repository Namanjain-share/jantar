/**
 * Wave 2 on a Board row: the "4 files" meta on line 2 of a your-turn row
 * while Files is on (spec 5.2.1), and the row's menu, "New session here"
 * (spec 5.3.1), which opens the start form for that session's folder on
 * that session's account (route /new?root=s.<sid>&start=1&account=N).
 * None of it shows while its switch is off.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Features, Session } from '@jantar/protocol';
import { parseRoute, routePath } from '../src/lib/router.js';
import { LONG_PRESS_MS } from '../src/ui/kit/longPress.js';
import { newHereHref } from '../src/ui/screens/board/RowMenu.js';
import { renderApp, session, stateWith } from './helpers.js';
import { launchApi } from './launch-fixtures.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const row = (sid: string) => document.querySelector<HTMLElement>(`a[data-sid="${sid}"]`)!;
const line2 = (sid: string) => row(sid).querySelector<HTMLElement>('[data-line2]')!;

function board(sessions: Session[], features: Partial<Features> = {}) {
  return renderApp({ state: stateWith({ sessions, features }) });
}

describe('the "4 files" meta', () => {
  const turn = (sid: string, filesChanged?: number) => session(sid, { status: 'idle', ...(filesChanged !== undefined ? { filesChanged } : {}) });

  it('shows on line 2 of a your-turn row, in mono, before the account', () => {
    board([turn('a', 4), turn('b', 1)], { files: true });
    const meta = line2('a').querySelector<HTMLElement>('[data-files]')!;
    expect(meta.textContent).toBe('4 files');
    expect(meta.className).toContain('type-mono');
    expect(meta.className).toContain('text-ink-3');
    // Before the account cell, on the same line.
    expect(meta.compareDocumentPosition(line2('a').querySelector('[data-acct]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line2('b').querySelector('[data-files]')!.textContent).toBe('1 file');
  });

  it('is not there with no changed files, on a row that is not your turn, or while Files is off', () => {
    board([turn('a', 0), turn('b'), session('c', { status: 'working', filesChanged: 3 }), session('d', { status: 'ended', filesChanged: 2 })], { files: true });
    for (const sid of ['a', 'b', 'c']) expect(line2(sid).querySelector('[data-files]'), sid).toBeNull();
    expect(row('d').querySelector('[data-files]')).toBeNull();
  });

  it('is not there while Files is off, whatever the session says', () => {
    board([turn('a', 4)]);
    expect(row('a').querySelector('[data-files]')).toBeNull();
    expect(screen.queryByText('4 files')).toBeNull();
  });
});

describe('the new route keeps an account', () => {
  it('reads and writes &account=N, and leaves anything else out', () => {
    expect(parseRoute('/new', '?root=s.a&start=1&account=7')).toEqual({ name: 'new', root: 's.a', start: true, account: 7 });
    expect(parseRoute('/new', '?root=s.a&start=1&account=0')).toMatchObject({ account: 0 });
    for (const bad of ['x', '-1', '1.5', '1234', '', '07a']) expect(parseRoute('/new', `?root=s.a&account=${bad}`), bad).not.toHaveProperty('account');
    expect(routePath({ name: 'new', root: 's.a', start: true, account: 7 })).toBe('/new?root=s.a&start=1&account=7');
    expect(routePath({ name: 'new', root: 'r.1', path: 'api' })).toBe('/new?root=r.1&path=api');
  });

  it('"New session here" keeps the folder and the account, or Auto when the session has none', () => {
    expect(newHereHref({ sid: 'a', session: session('a', { account: 7 }) })).toBe('/new?root=s.a&start=1&account=7');
    expect(newHereHref({ sid: 'a', session: session('a', { account: null }) })).toBe('/new?root=s.a&start=1');
  });
});

describe("a row's menu", () => {
  it('opens on a right click and starts a new session in that folder, on that account', async () => {
    const { history } = board([session('a', { status: 'idle', account: 7 })], { launch: true });
    const r = row('a');
    // The way in is told to screen readers.
    expect(document.getElementById(r.getAttribute('aria-describedby')!)!.textContent).toMatch(/Long press a session, or right click it/);
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => {
      r.dispatchEvent(ev);
    });
    // The browser's own link menu is held back.
    expect(ev.defaultPrevented).toBe(true);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New session here' }));
    expect(history.entries.at(-1)).toBe('/new?root=s.a&start=1&account=7');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('opens on a long press, and the click that follows does not open the session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { history } = board([session('a', { status: 'working', account: 3 })], { launch: true });
    const r = row('a');
    fireEvent.pointerDown(r, { button: 0, clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    fireEvent.pointerUp(r);
    fireEvent.click(r);
    expect(history.entries.at(-1)).toBe('/');
    expect(await screen.findByRole('menuitem', { name: 'New session here' })).toBeTruthy();
  });

  it('a short press still opens the session, and a moving finger is a scroll, not a long press', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { history } = board([session('a', { status: 'working' })], { launch: true });
    const r = row('a');
    fireEvent.pointerDown(r, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(r, { clientX: 10, clientY: 40 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.pointerUp(r);
    fireEvent.click(r);
    expect(history.entries.at(-1)).toBe('/s/a');
  });

  it('opens the start form on the session account, through the new route', async () => {
    const api = launchApi();
    renderApp({ path: newHereHref({ sid: 'alpha', session: session('alpha', { account: 8 }) }), api, state: stateWith({ sessions: [session('alpha', { status: 'idle', account: 8 })], features: { launch: true } }) });
    await waitFor(() => expect(api.launchPreview).toHaveBeenCalledWith({ root: 's.alpha', account: 8 }));
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByRole('button', { name: /^Account/ })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: /^Account/ }).textContent).toContain('08');
  });

  it('a held account still asks before it starts', async () => {
    const api = launchApi();
    renderApp({ path: '/new?root=s.alpha&start=1&account=2', api, state: stateWith({ sessions: [session('alpha', { status: 'idle', account: 2 })], features: { launch: true } }) });
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByRole('button', { name: 'Use 02 anyway' })).toBeTruthy();
    expect((within(sheet).getByRole('button', { name: /^Hold to start/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a session whose folder is listed under another root leaves the browser at its start, not a dead end', async () => {
    const api = launchApi();
    // s.beta is the second session in web-app: the roots list shows that folder once, as s.alpha.
    renderApp({ path: '/new?root=s.beta&start=1&account=7', api, state: stateWith({ sessions: [session('beta', { status: 'idle', account: 7 })], features: { launch: true } }) });
    await screen.findByRole('dialog');
    await waitFor(() => expect(api.foldersList).toHaveBeenCalled());
    expect(screen.queryByText(/not on this Mac any more/)).toBeNull();
    expect(api.launchPreview).toHaveBeenCalledWith({ root: 's.beta', account: 7 });
  });

  it('has no menu on an ended row, nor anywhere while launching is off', () => {
    board([session('a', { status: 'idle' }), session('e', { status: 'ended' })], { launch: true });
    const ended = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => {
      row('e').dispatchEvent(ended);
    });
    expect(ended.defaultPrevented).toBe(false);
    expect(row('e').hasAttribute('aria-describedby')).toBe(false);
  });

  it('is not there while launching is off: the row is the plain link it was', () => {
    board([session('a', { status: 'idle' })]);
    const r = row('a');
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => {
      r.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(false);
    expect(r.hasAttribute('aria-describedby')).toBe(false);
    expect(r.className).not.toContain('select-none');
    expect(screen.queryByText(/Long press a session/)).toBeNull();
  });

  it('closes when its row ends', async () => {
    const { store } = board([session('a', { status: 'idle' })], { launch: true });
    act(() => {
      row('a').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(await screen.findByRole('menuitem', { name: 'New session here' })).toBeTruthy();
    act(() =>
      store.getState().applyEvent({ seq: store.getState().state.seq + 1, ts: '2026-01-15T10:06:00.000Z', type: 'session.updated', sid: 'a', data: { patch: { status: 'ended' } } } as never),
    );
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'New session here' })).toBeNull());
  });
});
