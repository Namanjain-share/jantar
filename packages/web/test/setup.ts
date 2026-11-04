import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeAll } from 'vitest';
import { forgetDrafts } from '../src/lib/drafts.js';
import { setShortcuts } from '../src/ui/shell/navState.js';

const dom = typeof window !== 'undefined';

// 0.13.0: amounts are formatted in the device's own locale (lib/money.ts passes none). Tests
// pin that default to en-IN, the locale they read in ("₹4,50,000"), so a runner set to en-US
// or C (CI) formats the same. An explicit locale still wins.
const TEST_LOCALE = 'en-IN';
const NumberFormat = Intl.NumberFormat;
const Pinned = function NumberFormatPinned(locales?: string | string[], options?: Intl.NumberFormatOptions) {
  return new NumberFormat(locales ?? TEST_LOCALE, options);
} as unknown as typeof Intl.NumberFormat;
Object.defineProperties(Pinned, Object.getOwnPropertyDescriptors(NumberFormat));
Intl.NumberFormat = Pinned;
const toLocaleString = Number.prototype.toLocaleString;
Number.prototype.toLocaleString = function pinned(this: number, locales?: string | string[], options?: Intl.NumberFormatOptions) {
  return toLocaleString.call(this, locales ?? TEST_LOCALE, options);
};

// findBy and waitFor give up after 1 s; shared CI runners load a lazy screen more slowly than that.
configure({ asyncUtilTimeout: process.env.CI ? 5_000 : 1_000 });

beforeAll(() => {
  if (!dom) return;
  // jsdom has no layout: make scrolling a no-op instead of a console error.
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  // Base UI (Drawer, Popover, Dialog) and cmdk measure with ResizeObserver.
  if (!('ResizeObserver' in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

afterEach(() => {
  if (!dom) return;
  cleanup();
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
  // After cleanup(): an unmounting composer puts its draft aside, which the next test must not find.
  forgetDrafts();
  // The ? overlay's open flag is the shell's, kept outside React (c31).
  setShortcuts(false);
});
