/**
 * The visual viewport (lib/viewport.ts, 0.11): --vvh, --vvt and --kb while a
 * field has focus, cleared while zoomed and once the field lets go, and the
 * keyboard-up flag the layout reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KB_UP, measure, viewportStore, watchViewport } from '../src/lib/viewport.js';

/** A visual viewport the test moves, in a window 1180 tall. */
function fakeViewport(height = 1180) {
  const target = new EventTarget() as EventTarget & { height: number; offsetTop: number; scale: number };
  target.height = height;
  target.offsetTop = 0;
  target.scale = 1;
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: target });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1180 });
  return {
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

  it('scrolls the focused field into view once the resizes settle', () => {
    const input = field();
    const into = vi.fn();
    input.scrollIntoView = into;
    input.focus();
    vv.resize(900);
    vv.resize(847);
    expect(into).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(into).toHaveBeenCalledTimes(1);
    expect(into).toHaveBeenCalledWith({ block: 'nearest' });
  });
});
