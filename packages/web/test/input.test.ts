/**
 * Input modality (lib/input.ts, 0.11): data-input from the last pointer, and
 * the hardware-keyboard guess from keys and the visual viewport.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fromKeydown, fromShrink, isTextField, keyboardStore, setKeyboard, watchInput } from '../src/lib/input.js';
import { layoutAt } from '../src/ui/shell/layout.js';

/** A visual viewport the test resizes. */
function fakeViewport(height: number) {
  const target = new EventTarget() as EventTarget & { height: number; scale: number };
  target.height = height;
  target.scale = 1;
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: target });
  return {
    resize(h: number, scale = 1) {
      target.height = h;
      target.scale = scale;
      target.dispatchEvent(new Event('resize'));
    },
  };
}

function pointer(type: string, pointerType: string) {
  const e = new Event(type, { bubbles: true });
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  window.dispatchEvent(e);
}

let stop: () => void = () => undefined;
beforeEach(() => {
  keyboardStore.setState({ keyboard: false });
  delete document.documentElement.dataset.input;
  stop = watchInput(window);
});
afterEach(() => {
  stop();
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'visualViewport');
});

describe('data-input', () => {
  it('names the last pointer on <html>', () => {
    pointer('pointermove', 'mouse');
    expect(document.documentElement.dataset.input).toBe('mouse');
    pointer('pointerdown', 'touch');
    expect(document.documentElement.dataset.input).toBe('touch');
    pointer('pointerdown', 'pen');
    expect(document.documentElement.dataset.input).toBe('pen');
    // A pointer event without a type leaves it as it was.
    pointer('pointerdown', '');
    expect(document.documentElement.dataset.input).toBe('pen');
  });

  it('stops when told to', () => {
    stop();
    pointer('pointermove', 'mouse');
    expect(document.documentElement.dataset.input).toBeUndefined();
  });
});

describe('the keyboard flag', () => {
  it('turns on with a key pressed outside a text field', () => {
    const button = document.body.appendChild(document.createElement('button'));
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    expect(keyboardStore.getState().keyboard).toBe(true);
    expect(localStorage.getItem('jantar:kb')).toBe('true');
  });

  it('in a text field, only a modifier, an arrow, Tab or Esc says a keyboard is there', () => {
    const field = document.body.appendChild(document.createElement('textarea'));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(keyboardStore.getState().keyboard).toBe(false);
    for (const init of [{ key: 'z', metaKey: true }, { key: 'k', ctrlKey: true }, { key: 'å', altKey: true }, { key: 'ArrowUp' }, { key: 'Tab' }, { key: 'Escape' }]) {
      keyboardStore.setState({ keyboard: false });
      field.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true }));
      expect(keyboardStore.getState().keyboard, init.key).toBe(true);
    }
  });

  it('reads the visual viewport while a field has focus: 30-120 is the shortcut bar, over 200 the on-screen keyboard', () => {
    const vv = fakeViewport(1000);
    const field = document.body.appendChild(document.createElement('input'));
    field.focus();
    vv.resize(945); // a 55 px shrink: the shortcut bar over a hardware keyboard
    expect(keyboardStore.getState().keyboard).toBe(true);
    vv.resize(600); // 400: the docked on-screen keyboard came up
    expect(keyboardStore.getState().keyboard).toBe(false);
    vv.resize(980); // 20: ambiguous (a minimised bar, the floating keyboard), nothing changes
    expect(keyboardStore.getState().keyboard).toBe(false);
    vv.resize(850); // 150: between the two, nothing changes
    expect(keyboardStore.getState().keyboard).toBe(false);
    vv.resize(945, 1.5); // a pinch, not a keyboard
    expect(keyboardStore.getState().keyboard).toBe(false);
  });

  it('keeps the measure from before the first field when focus moves to another, and stops after', () => {
    const vv = fakeViewport(1000);
    const a = document.body.appendChild(document.createElement('input'));
    const b = document.body.appendChild(document.createElement('textarea'));
    a.focus();
    vv.resize(600);
    b.focus(); // the keyboard stays up: still measured against 1000
    vv.resize(950);
    expect(keyboardStore.getState().keyboard).toBe(true);
    b.blur();
    setKeyboard(false);
    vv.resize(940); // no field focused: not watched
    expect(keyboardStore.getState().keyboard).toBe(false);
  });

  it('pure parts: shrink, keydown and text fields', () => {
    expect([0, 29, 30, 120, 121, 200, 201, 400].map(fromShrink)).toEqual([undefined, undefined, true, true, undefined, undefined, false, false]);
    const input = document.createElement('input');
    expect(isTextField(input)).toBe(true);
    input.type = 'checkbox';
    expect(isTextField(input)).toBe(false);
    expect(isTextField(document.createElement('button'))).toBe(false);
    expect(fromKeydown({ key: 'a', metaKey: false, altKey: false, ctrlKey: false, target: document.createElement('textarea') })).toBe(false);
    expect(fromKeydown({ key: 'Shift', metaKey: false, altKey: false, ctrlKey: false, target: document.body })).toBe(true);
  });

  it('a fine pointer has a keyboard from the start; a coarse one once it has been seen', () => {
    expect(layoutAt(1440).keyboard).toBe(true);
    expect(layoutAt(1180, { coarse: true }).keyboard).toBe(false);
    expect(layoutAt(1180, { coarse: true, keyboard: true }).keyboard).toBe(true);
  });
});
