/**
 * Keys wherever a keyboard is (0.11, build plan 3.1, c11): the shell's keys
 * and a session's pane keys work at every width once a hardware keyboard has
 * been seen, only ⌘K, ⌘1-⌘9, ⌘. and Esc reach Jantar from a text field,
 * keycaps show only with a keyboard, and digits with a modifier are read
 * from event.code.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Keycap, KeyHints } from '../src/ui/kit/Keycap.js';
import { digitOf, G_ROUTES, undoOnScreen } from '../src/ui/shell/keys.js';
import { groupsFor } from '../src/ui/shell/Shortcuts.js';
import { createLayoutStore, layoutAt, LayoutProvider } from '../src/ui/shell/layout.js';
import { offSentence } from '../src/ui/shell/Shell.js';
import { NAV } from '../src/ui/shell/nav.js';
import { fakeApi, pending, preloadPlaces, renderApp, session, stateWith } from './helpers.js';

preloadPlaces('todos', 'today');

const waiting = () => stateWith({ sessions: [session('a', { status: 'waiting' }), session('b')], pending: [pending('a')] });
/** A phone-width window on a touch screen, with or without a keyboard seen. */
const compact = (keyboard: boolean) => layoutAt(390, { coarse: true, keyboard });

describe('at every width once a keyboard has been seen', () => {
  it('compact with a keyboard: ⌘K opens the palette, and a allows on a Permission card', async () => {
    const api = fakeApi();
    const p = pending('a');
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'waiting' })], pending: [p] }), layout: compact(true) });
    await screen.findByRole('button', { name: 'Yes' });
    fireEvent.keyDown(document.body, { key: 'a' });
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(p.id, { behavior: 'allow' }));
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(await screen.findByPlaceholderText('Jump to a session or account')).toBeTruthy();
  });

  it('compact without a keyboard: no keys (a touch screen alone)', async () => {
    const api = fakeApi();
    const { history } = renderApp({ path: '/s/a', api, state: waiting(), layout: compact(false) });
    await screen.findByRole('button', { name: 'Yes' });
    fireEvent.keyDown(document.body, { key: 'a' });
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'b' });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await act(async () => undefined);
    expect(api.decide).not.toHaveBeenCalled();
    expect(history.entries.at(-1)).toBe('/s/a');
    expect(screen.queryByPlaceholderText('Jump to a session or account')).toBeNull();
  });

  it('the keyboard turning on mid-way turns the keys on', async () => {
    const layout = createLayoutStore(compact(false));
    const { history } = renderApp({ state: waiting(), layout });
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'l' });
    expect(history.entries.at(-1)).toBe('/');
    act(() => layout.setState(compact(true), true));
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'l' });
    expect(history.entries.at(-1)).toBe('/alerts');
  });
});

describe('in a text field', () => {
  it('⌘K reaches the palette; ⌘Z, ⌘↑ and ⌃K stay with the field', async () => {
    renderApp({ state: waiting(), layout: layoutAt(1440) });
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    for (const init of [
      { key: 'z', metaKey: true },
      { key: 'ArrowUp', metaKey: true },
      { key: 'k', ctrlKey: true },
    ]) {
      // fireEvent returns false when a listener called preventDefault.
      expect(fireEvent.keyDown(field, init)).toBe(true);
    }
    expect(screen.queryByPlaceholderText('Jump to a session or account')).toBeNull();
    expect(fireEvent.keyDown(field, { key: 'k', metaKey: true })).toBe(false);
    expect(await screen.findByPlaceholderText('Jump to a session or account')).toBeTruthy();
    field.remove();
  });

  it('⌃K opens the palette outside a field', async () => {
    renderApp({ state: waiting(), layout: layoutAt(1440) });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(await screen.findByPlaceholderText('Jump to a session or account')).toBeTruthy();
  });

  it('single letters stay typing', () => {
    const { history } = renderApp({ state: waiting(), layout: layoutAt(1440) });
    const field = document.createElement('textarea');
    document.body.append(field);
    fireEvent.keyDown(field, { key: 'g' });
    fireEvent.keyDown(field, { key: 'a' });
    expect(history.entries.at(-1)).toBe('/');
    field.remove();
  });
});

describe('⌘1 … ⌘9 and the g chords', () => {
  it('open the places in nav order, matched on the key code; from a field too', () => {
    const state = stateWith({ sessions: [session('a')], features: { files: true, life: true, ask: false, intel: true, meetings: true } });
    const { history } = renderApp({ state, layout: layoutAt(1440) });
    fireEvent.keyDown(window, { key: '6', code: 'Digit6', metaKey: true });
    expect(history.entries.at(-1)).toBe('/alerts');
    const field = document.createElement('input');
    document.body.append(field);
    fireEvent.keyDown(field, { key: '2', code: 'Digit2', metaKey: true });
    expect(history.entries.at(-1)).toBe('/today');
    field.remove();
    fireEvent.keyDown(window, { key: '9', code: 'Numpad9', metaKey: true });
    expect(history.entries.at(-1)).toBe('/meetings');
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'f' });
    expect(history.entries.at(-1)).toBe('/files');
  });

  it('a place that is off keeps its number and says it is off', async () => {
    const state = stateWith({ sessions: [session('a')], features: { files: false, life: true, ask: false, intel: false, meetings: false } });
    const { history, toasts } = renderApp({ state, layout: layoutAt(1440) });
    fireEvent.keyDown(window, { key: '8', code: 'Digit8', metaKey: true });
    expect(history.entries.at(-1)).toBe('/');
    expect(toasts.getState().toasts.map((t) => t.text)).toEqual([expect.stringMatching(/^Intel is off on this Mac\. Turn it on at the Mac: .+ intel on$/)]);
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'm' });
    expect(history.entries.at(-1)).toBe('/');
    expect(toasts.getState().toasts.at(-1)?.text).toMatch(/^Meetings is off/);
  });

  it('every g chord names a place in the nav', () => {
    const hrefs = NAV.map((n) => n.href);
    for (const to of Object.values(G_ROUTES)) expect(hrefs).toContain(to);
    expect(Object.keys(G_ROUTES).sort()).toEqual(['a', 'b', 'c', 'd', 'f', 'i', 'l', 'm', 't']);
    expect(offSentence(NAV[2]!, true)).toBe('Chat needs a device paired with control.');
  });

  it('⌥1 is read from its code (it types ¡ on Apple layouts)', () => {
    expect(digitOf({ key: '¡', code: 'Digit1' })).toBe(1);
    expect(digitOf({ key: '€', code: 'Digit2' })).toBe(2);
    expect(digitOf({ key: '7', code: 'Numpad7' })).toBe(7);
    expect(digitOf({ key: '3', code: '' })).toBe(3);
    expect(digitOf({ key: 'a', code: 'KeyA' })).toBeNull();
  });
});

describe('⌘. is Esc', () => {
  it('closes what Esc closes: the palette', async () => {
    renderApp({ state: waiting(), layout: layoutAt(1440) });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = await screen.findByPlaceholderText('Jump to a session or account');
    fireEvent.keyDown(input, { key: '.', metaKey: true });
    await waitFor(() => expect(screen.queryByPlaceholderText('Jump to a session or account')).toBeNull());
  });

  it('closes an open session beside the ledger, as Esc does', async () => {
    const { history } = renderApp({ path: '/s/b', state: waiting(), layout: layoutAt(1440) });
    expect(screen.getByRole('region', { name: 'Ledger' })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: '.', metaKey: true });
    await waitFor(() => expect(history.entries.at(-1)).toBe('/'));
  });
});

describe('keycaps only with a keyboard', () => {
  function Caps() {
    return (
      <div>
        <Keycap>⌘K</Keycap>
        <KeyHints hints={[{ keys: ['j', 'k'], label: 'move' }]} />
      </div>
    );
  }

  it('none on a touch screen until a key is pressed; all on a Mac', () => {
    const layout = createLayoutStore(layoutAt(1180, { coarse: true, keyboard: false }));
    render(
      <LayoutProvider value={layout}>
        <Caps />
      </LayoutProvider>,
    );
    expect(document.querySelectorAll('kbd')).toHaveLength(0);
    expect(screen.queryByText('move')).toBeNull();
    act(() => layout.setState(layoutAt(1180, { coarse: true, keyboard: true }), true));
    expect(document.querySelectorAll('kbd')).toHaveLength(3);
    expect(within(document.body).getByText('move')).toBeTruthy();
  });
});

describe('0.11 c30: the whole key map', () => {
  const life = {
    open: true,
    timezone: 'UTC',
    today: '2026-01-15',
    currency: null,
    lockScreenDetails: false,
    modules: { todos: true, medicines: false, food: false, places: false, finance: false, posts: false },
    estimate: { available: false },
    backups: { last: null, count: 0 },
    push: { devices: 1, webpush: true },
  } as const;
  const todo = (n: number) => ({ id: `01JFZ8X8Y3T0V5G9WQK2M4N${String(n).padStart(3, '0')}`, title: `Example todo ${n}`, priority: 'normal' as const, createdAt: '2026-01-14T10:00:00.000Z', updatedAt: '2026-01-14T10:00:00.000Z' });
  function todos(api: Parameters<typeof fakeApi>[0] = {}) {
    const a = fakeApi({
      lifeStatus: vi.fn(async () => life),
      todosList: vi.fn(async (q?: { done?: boolean }) => ({ today: '2026-01-15', todos: q?.done ? [] : [todo(1), todo(2)] })),
      projectsList: vi.fn(async () => ({ projects: [] })),
      todoDone: vi.fn(async () => ({ ok: true as const })),
      ...api,
    });
    renderApp({ path: '/todos', api: a, state: stateWith({ features: { life: true } }) });
    return a;
  }

  it('⌘Z undoes the Undo on screen, outside a field; with none on screen it does nothing', async () => {
    const api = todos();
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done: Example todo 1' }));
    await waitFor(() => expect(api.todoDone).toHaveBeenCalledWith(todo(1).id, true));
    await screen.findByRole('button', { name: 'Undo' });
    fireEvent.keyDown(document.body, { key: 'z', code: 'KeyZ', metaKey: true });
    await waitFor(() => expect(api.todoDone).toHaveBeenLastCalledWith(todo(1).id, false));
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    // Nothing undoable on screen: ⌘Z does nothing (and leaves the browser's own ⌘Z alone).
    const calls = vi.mocked(api.todoDone).mock.calls.length;
    const e = new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', metaKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(vi.mocked(api.todoDone).mock.calls.length).toBe(calls);
  });

  it("⌘Z in Chat reaches only the newest turn's newest Undo; over a sheet only the sheet's", () => {
    document.body.innerHTML = `
      <div data-pane="chat"><ol>
        <li data-turn="1"><button data-undo="change" id="old">Undo</button></li>
        <li data-turn="2"><button data-undo="change" id="a">Undo</button><button data-undo="change" id="b">Undo</button><button id="in">x</button></li>
      </ol></div>
      <div><button data-undo="line" id="line">Undo</button></div>`;
    expect(undoOnScreen(document.getElementById('in'))?.id).toBe('b');
    expect(undoOnScreen(document.body)?.id).toBe('line');
    (document.getElementById('b') as HTMLButtonElement).disabled = true;
    expect(undoOnScreen(document.getElementById('in'))?.id).toBe('a');
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><p>A sheet</p></div>');
    expect(undoOnScreen(document.body)).toBeNull();
    document.body.innerHTML = '';
  });

  it('a list moves by ↑ ↓ (and j k) from row to row, with one row in the tab order; x, e and ⌫ act on the todo', async () => {
    const api = todos({ todoDelete: vi.fn(async () => ({ ok: true as const })) });
    const first = (await screen.findByText('Example todo 1')).closest('button') as HTMLButtonElement;
    const second = screen.getByText('Example todo 2').closest('button') as HTMLButtonElement;
    await waitFor(() => expect([first.tabIndex, second.tabIndex]).toEqual([0, -1]));
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    expect([first.tabIndex, second.tabIndex]).toEqual([-1, 0]);
    fireEvent.keyDown(second, { key: 'k' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'x' });
    await waitFor(() => expect(api.todoDone).toHaveBeenCalledWith(todo(1).id, true));
    fireEvent.keyDown(second, { key: 'e' });
    expect(await screen.findByRole('dialog', { name: 'Edit todo' })).toBeTruthy();
  });

  it('c opens the place\'s new item', async () => {
    todos();
    await screen.findByText('Example todo 1');
    fireEvent.keyDown(document.body, { key: 'c' });
    expect(await screen.findByRole('dialog', { name: 'New todo' })).toBeTruthy();
  });

  it('after an in-app link the new pane\'s heading has the focus', async () => {
    renderApp({ path: '/', state: stateWith({ sessions: [session('a')], features: { life: true } }), api: fakeApi({ lifeStatus: vi.fn(async () => life), todosList: vi.fn(async () => ({ today: '2026-01-15', todos: [] })), projectsList: vi.fn(async () => ({ projects: [] })) }) });
    const rail = screen.getByRole('navigation', { name: 'Main' });
    fireEvent.click(within(rail).getByRole('link', { name: /Today/ }));
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.tagName).toBe('H1'));
    expect(document.activeElement?.getAttribute('tabindex')).toBe('-1');
  });

  it('? opens the shortcuts with the place\'s own keys first; a browser tab says what the browser may keep', async () => {
    renderApp({ path: '/', state: waiting() });
    fireEvent.keyDown(document.body, { key: '?' });
    const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    const groups = within(sheet).getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(groups[0]).toBe('Board');
    expect(groups).toContain('Anywhere');
    expect(groupsFor('posts').slice(0, 2).map((g) => g.id)).toEqual(['posts', 'lists']);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Legend' }));
    expect(within(sheet).getByText(/Claude asked a question/)).toBeTruthy();
  });

  it('a skip link goes to the place first', () => {
    renderApp({ path: '/', state: waiting() });
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip.getAttribute('href')).toBe('#main');
  });
});
