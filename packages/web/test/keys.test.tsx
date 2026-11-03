/**
 * Keys wherever a keyboard is (0.11, build plan 3.1, c11): the shell's keys
 * and a session's pane keys work at every width once a hardware keyboard has
 * been seen, only ⌘K, ⌘1-⌘9, ⌘. and Esc reach Jantar from a text field,
 * keycaps show only with a keyboard, and digits with a modifier are read
 * from event.code.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Keycap, KeyHints } from '../src/ui/kit/Keycap.js';
import { digitOf, G_ROUTES } from '../src/ui/shell/keys.js';
import { createLayoutStore, layoutAt, LayoutProvider } from '../src/ui/shell/layout.js';
import { offSentence } from '../src/ui/shell/Shell.js';
import { NAV } from '../src/ui/shell/nav.js';
import { fakeApi, pending, renderApp, session, stateWith } from './helpers.js';

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
