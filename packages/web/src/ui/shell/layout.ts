/**
 * The layout context (0.11): one set of media-query listeners for the whole
 * app, and what a screen may ask of the window.
 *
 *   size      compact < 640 <= medium < 1024 <= regular, by the window's width
 *   coarse    (pointer: coarse): a touch screen (an iPad, even with a trackpad)
 *   chrome    the shell around the panes: phone (header and tabs), touch (the
 *             iPad's sidebar and rail, once TOUCH_SHELL is on) or desk (the
 *             Mac's rail, top bar and status bar). A fine pointer gets the
 *             phone below 768 and desk from 768, as before; a coarse pointer
 *             gets the same until the touch shell exists, then the phone below
 *             640 and touch from 640.
 *   keyboard  a hardware keyboard has been seen (a fine pointer: from the start)
 *   kbUp      the on-screen keyboard is up
 *
 * Panes are laid out by their own width (container queries), with either
 * pointer; only the chrome follows the pointer.
 *
 * useFrame() and isSplit() are the older frames, built on the same
 * listeners, for the places that still lay out by the window until they move
 * to their pane's width:
 *
 *   phone   < 768    header 52 + safe area, content, bottom tabs 56 + safe area
 *   tablet  768-1023 top bar 48, rail 56, full-width ledger; a session opens
 *                    full width with a back button; status bar 24
 *   desk    1024-1279 the same plus ledger column 360 beside the detail pane
 *   wide    >= 1280  ledger column 440
 *
 * Without matchMedia (jsdom) the window reads as 0 wide with a fine pointer:
 * the phone chrome. Tests inject a layout instead (AppDeps.layout,
 * renderApp({ layout })).
 */
import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

export type Size = 'compact' | 'medium' | 'regular';
export type Chrome = 'phone' | 'touch' | 'desk';
export type Frame = 'phone' | 'tablet' | 'desk' | 'wide';

export interface Layout {
  size: Size;
  coarse: boolean;
  chrome: Chrome;
  keyboard: boolean;
  kbUp: boolean;
  /** At least 1280 wide: only the `wide` frame asks (useFrame). */
  wide: boolean;
}
export type LayoutStore = StoreApi<Layout>;

/** The touch shell (sidebar, labelled rail) is not built yet: until it is, a coarse pointer gets the Mac's chrome from 768. */
export const TOUCH_SHELL = false;

/** What the provider listens to: one listener each, for the whole app. */
export const QUERIES = {
  medium: '(min-width: 640px)',
  desk: '(min-width: 768px)',
  regular: '(min-width: 1024px)',
  wide: '(min-width: 1280px)',
  coarse: '(pointer: coarse)',
} as const;

export function sizeFor(width: number): Size {
  return width >= 1024 ? 'regular' : width >= 640 ? 'medium' : 'compact';
}

export function chromeFor(width: number, coarse: boolean, touchShell: boolean = TOUCH_SHELL): Chrome {
  if (coarse && touchShell) return width >= 640 ? 'touch' : 'phone';
  return width >= 768 ? 'desk' : 'phone';
}

export interface LayoutOptions {
  coarse?: boolean;
  keyboard?: boolean;
  kbUp?: boolean;
  touchShell?: boolean;
}

/** The layout of a window `width` wide: what the provider computes, and what a test injects. */
export function layoutAt(width: number, o: LayoutOptions = {}): Layout {
  const coarse = o.coarse ?? false;
  return {
    size: sizeFor(width),
    coarse,
    chrome: chromeFor(width, coarse, o.touchShell),
    // A fine pointer is a Mac or a desktop browser, so it has a keyboard from the start.
    keyboard: o.keyboard ?? !coarse,
    kbUp: o.kbUp ?? false,
    wide: width >= 1280,
  };
}

export function frameOf(l: Layout): Frame {
  if (l.chrome === 'phone') return 'phone';
  if (l.wide) return 'wide';
  return l.size === 'regular' ? 'desk' : 'tablet';
}

/** The 0.10 frame, for the places that still lay out by the window. */
export function useFrame(): Frame {
  return frameOf(useLayout());
}

/** Ledger and detail side by side (board + session in one frame). */
export function isSplit(frame: Frame): boolean {
  return frame === 'desk' || frame === 'wide';
}

export function createLayoutStore(initial: Layout): LayoutStore {
  return createStore<Layout>()(() => initial);
}

const hasMedia = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

/** The window's breakpoint, read from the queries: the layout of the narrowest width that matches them. */
function fromQueries(matches: (q: string) => boolean): Layout {
  const width = matches(QUERIES.wide) ? 1280 : matches(QUERIES.regular) ? 1024 : matches(QUERIES.desk) ? 768 : matches(QUERIES.medium) ? 640 : 0;
  return layoutAt(width, { coarse: matches(QUERIES.coarse) });
}

function readWindow(): Layout {
  return hasMedia() ? fromQueries((q) => window.matchMedia(q).matches) : layoutAt(0);
}

function same(a: Layout, b: Layout): boolean {
  return a.size === b.size && a.coarse === b.coarse && a.chrome === b.chrome && a.keyboard === b.keyboard && a.kbUp === b.kbUp && a.wide === b.wide;
}

/** Keeps `store` in step with the window: one change listener per query, until the returned function runs. */
function follow(store: LayoutStore): () => void {
  if (!hasMedia()) return () => undefined;
  const lists = new Map<string, MediaQueryList>(Object.values(QUERIES).map((q) => [q, window.matchMedia(q)]));
  const update = () => {
    const next = fromQueries((q) => lists.get(q)?.matches ?? false);
    if (!same(store.getState(), next)) store.setState(next, true);
  };
  for (const l of lists.values()) l.addEventListener?.('change', update);
  // The window may have changed between the first render and now.
  update();
  return () => {
    for (const l of lists.values()) l.removeEventListener?.('change', update);
  };
}

const isStore = (v: Layout | LayoutStore | undefined): v is LayoutStore => typeof (v as LayoutStore | undefined)?.getState === 'function';

const LayoutContext = createContext<LayoutStore | null>(null);

/**
 * Gives the app its layout: the window's (one listener per query), or
 * `value` when a test passes one (a store it can change, or a fixed layout).
 */
export function LayoutProvider({ value, children }: { value?: Layout | LayoutStore; children: ReactNode }) {
  const [store] = useState<LayoutStore>(() => (isStore(value) ? value : createLayoutStore(value ?? readWindow())));
  const fixed = value !== undefined;
  useEffect(() => (fixed ? undefined : follow(store)), [fixed, store]);
  return createElement(LayoutContext.Provider, { value: store }, children);
}

/** The layout. A screen rendered outside the provider (a test of one screen) follows the window on its own. */
export function useLayout(): Layout {
  const provided = useContext(LayoutContext);
  const [own] = useState(() => (provided ? null : createLayoutStore(readWindow())));
  useEffect(() => (own ? follow(own) : undefined), [own]);
  return useStore((provided ?? own) as LayoutStore);
}
