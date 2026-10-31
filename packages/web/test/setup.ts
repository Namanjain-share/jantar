import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll } from 'vitest';

const dom = typeof window !== 'undefined';

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
});
