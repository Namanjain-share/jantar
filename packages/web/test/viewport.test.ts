/**
 * The visual viewport (lib/viewport.ts, 0.12): --vvh, --vvt and --kb while a
 * field has focus, cleared while zoomed and once the field lets go, and the
 * keyboard-up flag the layout reads. 0.13.2 (an iPhone on iOS 26): the
 * keyboard measured against the window's height from before it came up, the
 * page put back at the top, a field removed while focused, and the field
 * brought into view in its own pane only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KB_UP, measure, revealInPane, viewportStore, watchViewport } from '../src/lib/viewport.js';

/** A visual viewport the test moves, in a window 1180 tall. */
function fakeViewport(height = 1180) {
  const target = new EventTarget() as EventTarget & { height: number; offsetTop: number; scale: number };
  target.height = height;
  target.offsetTop = 0;
  target.scale = 1;
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: target });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1180 });
  return {
    /** The window's own height (iOS 26 can shrink it with the keyboard). */
    window(h: number) {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
    },
    resize(h: number, offsetTop = 0, scale = 1) {
      target.height = h;
      target.offsetTop = offsetTop;
      target.scale = scale;
      target.dispatchEvent(new Event('resize'));
    },
  };
}

const vars = () => {
  const s = document.documentElement.style;
  return { vvh: s.getPropertyValue('--vvh'), vvt: s.getPropertyValue('--vvt'), kb: s.getPropertyValue('--kb') };
};

function field(): HTMLInputElement {
  const input = document.createElement('input');
  document.body.append(input);
  return input;
}

let stop: () => void = () => undefined;
let vv: ReturnType<typeof fakeViewport>;
beforeEach(() => {
  vi.useFakeTimers();
  vv = fakeViewport();
  stop = watchViewport(window);
});
afterEach(() => {
  stop();
  vi.useRealTimers();
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'visualViewport');
});

describe('measure', () => {
  it('reads the height, the keyboard and the offset, clamped', () => {
    expect(measure(1180, { height: 847, offsetTop: 0, scale: 1 })).toEqual({ vvh: 847, vvt: 0, kb: 333 });
    expect(measure(820, { height: 402, offsetTop: 60, scale: 1 })).toEqual({ vvh: 402, vvt: 60, kb: 418 });
    // Never past the keyboard, never above the top.
    expect(measure(820, { height: 402, offsetTop: 900, scale: 1 })?.vvt).toBe(418);
    expect(measure(820, { height: 820, offsetTop: -12, scale: 1 })?.vvt).toBe(0);
  });

  it('is null while the page is zoomed', () => {
    expect(measure(820, { height: 400, offsetTop: 100, scale: 1.5 })).toBeNull();
    expect(measure(820, { height: 820, offsetTop: 0, scale: 1.005 })).not.toBeNull();
  });
});

describe('watchViewport', () => {
  it('sets nothing until a field has focus', () => {
    vv.resize(847);
    expect(vars()).toEqual({ vvh: '', vvt: '', kb: '' });
  });

  it('follows the keyboard while a field has focus', () => {
    field().focus();
    expect(vars()).toEqual({ vvh: '1180px', vvt: '0px', kb: '0px' });
    vv.resize(847);
    expect(vars()).toEqual({ vvh: '847px', vvt: '0px', kb: '333px' });
    expect(viewportStore.getState().kbUp).toBe(true);
    // 0.13.2: kit.css reads it to drop the composer's bottom safe area.
    expect(document.documentElement.hasAttribute('data-kb-up')).toBe(true);
    // A pan: the shell moves down with it.
    vv.resize(847, 60);
    expect(vars().vvt).toBe('60px');
  });

  it('a shortcut bar is not the on-screen keyboard', () => {
    field().focus();
    vv.resize(1180 - 55);
    expect(vars().kb).toBe('55px');
    expect(55).toBeLessThan(KB_UP);
    expect(viewportStore.getState().kbUp).toBe(false);
  });

  it('clears everything while zoomed', () => {
    field().focus();
    vv.resize(847);
    vv.resize(600, 100, 1.5);
    expect(vars()).toEqual({ vvh: '', vvt: '', kb: '' });
    expect(viewportStore.getState().kbUp).toBe(false);
  });

  it('puts the offset back at once when the field lets go, and clears the rest once the keyboard is down', () => {
    const input = field();
    input.focus();
    vv.resize(847, 60);
    input.blur();
    expect(vars().vvt).toBe('0px');
    // iOS leaves the offset set while the keyboard goes down: still 0.
    vv.resize(1000, 60);
    expect(vars().vvt).toBe('0px');
    vv.resize(1180, 0);
    expect(vars()).toEqual({ vvh: '', vvt: '', kb: '' });
    expect(viewportStore.getState().kbUp).toBe(false);
    expect(document.documentElement.hasAttribute('data-kb-up')).toBe(false);
  });

  it('clears after a second if the height never comes back', () => {
    const input = field();
    input.focus();
    vv.resize(847);
    input.blur();
    vi.advanceTimersByTime(1000);
    expect(vars()).toEqual({ vvh: '', vvt: '', kb: '' });
  });

  it('keeps watching when focus moves to another field', () => {
    const a = field();
    const b = field();
    a.focus();
    vv.resize(847);
    b.focus();
    vi.advanceTimersByTime(1000);
    expect(vars().vvh).toBe('847px');
  });

  it('brings the focused field into view in its pane once the resizes settle, never by scrolling the page', () => {
    const pane = document.createElement('div');
    pane.style.overflowY = 'auto';
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 500 });
    pane.getBoundingClientRect = () => ({ top: 0, bottom: 500, left: 0, right: 390, width: 390, height: 500, x: 0, y: 0, toJSON: () => ({}) });
    const input = document.createElement('input');
    input.getBoundingClientRect = () => ({ top: 600, bottom: 640, left: 0, right: 390, width: 390, height: 40, x: 0, y: 600, toJSON: () => ({}) });
    pane.append(input);
    document.body.append(pane);
    const into = vi.fn();
    input.scrollIntoView = into;
    input.focus();
    vv.resize(900);
    vv.resize(847);
    expect(pane.scrollTop).toBe(0);
    vi.advanceTimersByTime(20);
    // 640 - (500 - 16): the pane scrolls, the page doesn't.
    expect(pane.scrollTop).toBe(156);
    expect(into).not.toHaveBeenCalled();
  });

  it('measures the keyboard from the height before it, when the window shrinks with it (iOS 26)', () => {
    field().focus();
    vv.window(847);
    vv.resize(847);
    expect(vars()).toEqual({ vvh: '847px', vvt: '0px', kb: '333px' });
    expect(viewportStore.getState().kbUp).toBe(true);
  });

  it('starts the height over when the device turns', () => {
    field().focus();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1180 });
    vv.window(820);
    vv.resize(820);
    expect(vars().kb).toBe('0px');
    expect(viewportStore.getState().kbUp).toBe(false);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  });

  it('puts the page back at the top when iOS scrolls it to show the field', () => {
    const to = vi.fn();
    const scrollTo = window.scrollTo;
    window.scrollTo = to as typeof window.scrollTo;
    try {
      field().focus();
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 357 });
      vv.resize(495);
      expect(to).toHaveBeenCalledWith(0, 0);
      to.mockClear();
      window.dispatchEvent(new Event('scroll'));
      expect(to).toHaveBeenCalledWith(0, 0);
      // Pinch-zoomed, a scroll is the person panning: left alone.
      to.mockClear();
      vv.resize(400, 100, 1.5);
      window.dispatchEvent(new Event('scroll'));
      expect(to).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
      window.scrollTo = scrollTo;
    }
  });

  it('lets go when the focused field is removed without a focusout (leaving a session with the keyboard up)', () => {
    const input = field();
    input.focus();
    vv.resize(847, 60);
    input.remove();
    // The keyboard goes down with its bar still counted: the offset is 0 at once.
    vv.resize(1180 - 45, 60);
    expect(vars().vvt).toBe('0px');
    vi.advanceTimersByTime(1000);
    expect(vars()).toEqual({ vvh: '', vvt: '', kb: '' });
    expect(viewportStore.getState().kbUp).toBe(false);
  });
});

describe('revealInPane', () => {
  it('leaves a field that is already in view, and scrolls one above the pane down into it', () => {
    const pane = document.createElement('div');
    pane.style.overflowY = 'scroll';
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 500 });
    pane.scrollTop = 300;
    pane.getBoundingClientRect = () => ({ top: 100, bottom: 600, left: 0, right: 390, width: 390, height: 500, x: 0, y: 100, toJSON: () => ({}) });
    const input = document.createElement('input');
    pane.append(input);
    document.body.append(pane);
    input.getBoundingClientRect = () => ({ top: 200, bottom: 240, left: 0, right: 390, width: 390, height: 40, x: 0, y: 200, toJSON: () => ({}) });
    revealInPane(input);
    expect(pane.scrollTop).toBe(300);
    input.getBoundingClientRect = () => ({ top: 40, bottom: 80, left: 0, right: 390, width: 390, height: 40, x: 0, y: 40, toJSON: () => ({}) });
    revealInPane(input);
    expect(pane.scrollTop).toBe(240);
  });
});
