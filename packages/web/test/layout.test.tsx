/**
 * The layout context (shell/layout.ts): the size classes and the chrome as
 * tables, one listener per query for the whole app, and a layout injected
 * through AppDeps.layout instead of a matchMedia stub.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyboardStore, setKeyboard } from '../src/lib/input.js';
import { viewportStore } from '../src/lib/viewport.js';
import * as layoutModule from '../src/ui/shell/layout.js';
import { QUERIES, TOUCH_SHELL, chromeFor, createLayoutStore, layoutAt, sizeFor, useLayout, type Chrome, type Size } from '../src/ui/shell/layout.js';
import { renderApp, session, stateWith } from './helpers.js';

/** A window `width` wide with a fine or coarse pointer; counts the change listeners added and removed. */
function stubWindow(width: number, coarse = false) {
  const listening = new Map<string, number>();
  vi.stubGlobal('matchMedia', (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const pointer = /pointer:\s*(coarse|fine)/.exec(query);
    const matches = (min ? width >= Number(min[1]) : true) && (pointer ? (pointer[1] === 'coarse') === coarse : true);
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => listening.set(query, (listening.get(query) ?? 0) + 1),
      removeEventListener: () => listening.set(query, (listening.get(query) ?? 0) - 1),
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  });
  return listening;
}

afterEach(() => vi.unstubAllGlobals());

describe('size classes and chrome', () => {
  // width: size, fine pointer, coarse pointer before the touch shell, coarse pointer with it
  const rows: Array<[number, Size, Chrome, Chrome, Chrome]> = [
    [320, 'compact', 'phone', 'phone', 'phone'],
    [375, 'compact', 'phone', 'phone', 'phone'],
    [585, 'compact', 'phone', 'phone', 'phone'],
    [639, 'compact', 'phone', 'phone', 'phone'],
    [640, 'medium', 'phone', 'phone', 'touch'],
    [767, 'medium', 'phone', 'phone', 'touch'],
    [768, 'medium', 'desk', 'desk', 'touch'],
    [820, 'medium', 'desk', 'desk', 'touch'],
    [1023, 'medium', 'desk', 'desk', 'touch'],
    [1024, 'regular', 'desk', 'desk', 'touch'],
    [1180, 'regular', 'desk', 'desk', 'touch'],
    [1440, 'regular', 'desk', 'desk', 'touch'],
  ];

  it.each(rows)('%i px: %s; fine %s, coarse %s, coarse with the touch shell %s', (width, size, fine, coarse, touch) => {
    expect(sizeFor(width)).toBe(size);
    expect(chromeFor(width, false, false)).toBe(fine);
    expect(chromeFor(width, false, true)).toBe(fine);
    expect(chromeFor(width, true, false)).toBe(coarse);
    expect(chromeFor(width, true, true)).toBe(touch);
  });

  it('c24: the Mac keeps its chrome and has a keyboard from the start; an iPad gets the touch shell from 640', () => {
    expect(TOUCH_SHELL).toBe(true);
    expect(layoutAt(1440)).toEqual({ size: 'regular', coarse: false, chrome: 'desk', keyboard: true, kbUp: false });
    expect(layoutAt(820, { coarse: true })).toEqual({ size: 'medium', coarse: true, chrome: 'touch', keyboard: false, kbUp: false });
    expect(layoutAt(639, { coarse: true }).chrome).toBe('phone');
    expect(layoutAt(767).chrome).toBe('phone');
  });

  it('c23: the older frames are gone, and so is the 1280 query only they asked', () => {
    for (const name of ['useFrame', 'isSplit', 'frameOf']) expect(name in layoutModule, name).toBe(false);
    expect(Object.values(QUERIES)).not.toContain('(min-width: 1280px)');
  });
});

describe('the provider', () => {
  it('listens with one listener per query for the whole app: four', () => {
    const listening = stubWindow(1440);
    renderApp({ state: stateWith({ sessions: [session('web-app'), session('api', { status: 'idle' })] }) });
    expect(screen.getByRole('region', { name: 'Ledger' })).toBeTruthy();
    const active = [...listening].filter(([, n]) => n > 0);
    expect(active.map(([q]) => q).sort()).toEqual(Object.values(QUERIES).sort());
    expect(active.every(([, n]) => n === 1)).toBe(true);
    expect(active).toHaveLength(4);
  });

  it('reads the window: 1440 with a fine pointer is the desk, 600 with a coarse one the phone', () => {
    stubWindow(1440);
    const a = renderApp({ state: stateWith({ sessions: [session('web-app')] }) });
    expect(screen.getByRole('region', { name: 'Ledger' })).toBeTruthy();
    a.unmount();
    stubWindow(600, true);
    renderApp({ state: stateWith({ sessions: [session('web-app')] }) });
    expect(screen.queryByRole('region', { name: 'Ledger' })).toBeNull();
    expect(screen.getByRole('link', { name: /Board/ }).closest('nav')?.getAttribute('aria-label')).toBe('Main');
  });

  it('takes a layout from the test instead of matchMedia, and follows a store the test changes', () => {
    const layout = createLayoutStore(layoutAt(1440));
    renderApp({ state: stateWith({ sessions: [session('web-app')] }), layout });
    expect(screen.getByRole('region', { name: 'Ledger' })).toBeTruthy();
    act(() => layout.setState(layoutAt(390), true));
    expect(screen.queryByRole('region', { name: 'Ledger' })).toBeNull();
    act(() => layout.setState(layoutAt(1100), true));
    expect(screen.getByRole('region', { name: 'Ledger' })).toBeTruthy();
  });

  it('0.11 c05: a coarse pointer has a keyboard once lib/input.ts has seen one; a fine pointer from the start', () => {
    keyboardStore.setState({ keyboard: false });
    function Probe() {
      const l = useLayout();
      return <p>{`keyboard ${l.keyboard}`}</p>;
    }
    stubWindow(1180, true);
    const a = render(<Probe />);
    expect(screen.getByText('keyboard false')).toBeTruthy();
    act(() => setKeyboard(true));
    expect(screen.getByText('keyboard true')).toBeTruthy();
    act(() => setKeyboard(false));
    expect(screen.getByText('keyboard false')).toBeTruthy();
    a.unmount();
    stubWindow(1440);
    render(<Probe />);
    expect(screen.getByText('keyboard true')).toBeTruthy();
  });

  it('0.11 c10: kbUp follows the on-screen keyboard (lib/viewport.ts)', () => {
    function Probe() {
      const l = useLayout();
      return <p>{`kbUp ${l.kbUp}`}</p>;
    }
    stubWindow(820, true);
    render(<Probe />);
    expect(screen.getByText('kbUp false')).toBeTruthy();
    act(() => viewportStore.setState({ kbUp: true }));
    expect(screen.getByText('kbUp true')).toBeTruthy();
    act(() => viewportStore.setState({ kbUp: false }));
    expect(screen.getByText('kbUp false')).toBeTruthy();
  });

  it('a screen rendered on its own follows the window by itself', () => {
    stubWindow(1440);
    function Probe() {
      const l = useLayout();
      return <p>{`${l.size} ${l.chrome}`}</p>;
    }
    render(<Probe />);
    expect(screen.getByText('regular desk')).toBeTruthy();
  });
});
