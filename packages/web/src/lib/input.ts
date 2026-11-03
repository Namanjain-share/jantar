/**
 * Input modality (0.12, build plan 1.1 and 1.9; ipad-design.md 1.5).
 *
 * - `data-input` on <html> names the last pointer: mouse (a mouse or a
 *   trackpad, an iPad's too), touch or pen. Hover styles key on it as well
 *   as on (hover: hover), because iPadOS reports hover: none with a trackpad.
 * - `keyboard`: a hardware keyboard has been seen. There is no web API for
 *   it, so it is guessed: true on a keydown outside a text field, or on any
 *   key with Cmd, Option or Ctrl, an arrow, Tab or Esc; true while a field is
 *   focused and the visual viewport shrinks by 30-120 px (the shortcut bar,
 *   so a keyboard is attached); false when it shrinks by more than 200 (the
 *   docked on-screen keyboard came up). A shrink under 30 is ambiguous (the
 *   shortcut bar minimised, or the floating keyboard) and changes nothing.
 *   It is kept per device as `jantar:kb`. Only a coarse pointer asks: a fine
 *   pointer has a keyboard from the start (shell/layout.ts).
 * - `mode` (0.12 c31, Devices › This device › Keyboard): Auto is the guess
 *   above; On and Off overrule it on this device (`jantar:kb-mode`), for an
 *   iPad whose keyboard the guess misses, or a Mac that wants no shortcuts.
 */
import { createStore } from 'zustand/vanilla';
import { readLocal, writeLocal } from './storage.js';

export type InputKind = 'mouse' | 'touch' | 'pen';

export const KB_KEY = 'kb';
export const KB_MODE_KEY = 'kb-mode';

export type KeyboardMode = 'auto' | 'on' | 'off';
const MODES: readonly KeyboardMode[] = ['auto', 'on', 'off'];

function savedMode(): KeyboardMode {
  const m = readLocal<string>(KB_MODE_KEY, 'auto');
  return (MODES as readonly string[]).includes(m) ? (m as KeyboardMode) : 'auto';
}

export const keyboardStore = createStore<{ keyboard: boolean; mode: KeyboardMode }>()(() => ({ keyboard: readLocal<boolean>(KB_KEY, false) === true, mode: savedMode() }));

/** The keyboard flag a window with this pointer gets: the mode's, or with Auto the guess (a fine pointer always). */
export function keyboardOn(s: { keyboard: boolean; mode: KeyboardMode }, coarse: boolean): boolean {
  return s.mode === 'on' ? true : s.mode === 'off' ? false : !coarse || s.keyboard;
}

export function setKeyboardMode(mode: KeyboardMode): void {
  if (keyboardStore.getState().mode === mode) return;
  keyboardStore.setState({ mode });
  writeLocal(KB_MODE_KEY, mode);
}

export function setKeyboard(on: boolean): void {
  if (keyboardStore.getState().keyboard === on) return;
  keyboardStore.setState({ keyboard: on });
  writeLocal(KB_KEY, on);
}

const TEXT_INPUT = /^(?:text|search|email|url|tel|password|number|date|datetime-local|month|time|week)$/;

/** A field the on-screen keyboard types into. */
export function isTextField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && TEXT_INPUT.test(el.type || 'text');
}

/** Keys an on-screen keyboard doesn't send. */
const HARDWARE_ONLY = /^(?:Arrow(?:Up|Down|Left|Right)|Tab|Escape)$/;

/** Whether `e` shows a hardware keyboard. */
export function fromKeydown(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'altKey' | 'ctrlKey' | 'target'>): boolean {
  return !isTextField(e.target) || e.metaKey || e.altKey || e.ctrlKey || HARDWARE_ONLY.test(e.key);
}

/** What a shrink of the visual viewport, while a field is focused, says about the keyboard: undefined = nothing. */
export function fromShrink(px: number): boolean | undefined {
  if (px > 200) return false;
  if (px >= 30 && px <= 120) return true;
  return undefined;
}

/** Starts watching the pointer and the keyboard; returns the stop function. main.tsx calls it once. */
export function watchInput(win: Window = window): () => void {
  const root = win.document.documentElement;
  const onPointer = (e: PointerEvent) => {
    const kind = e.pointerType as InputKind | '';
    if (kind && root.dataset.input !== kind) root.dataset.input = kind;
  };
  const onKey = (e: KeyboardEvent) => {
    if (fromKeydown(e)) setKeyboard(true);
  };
  // The visual viewport is watched only while a text field has focus.
  let base = 0;
  const vv = () => win.visualViewport;
  const onResize = () => {
    const v = vv();
    if (!v || Math.abs(v.scale - 1) > 0.01) return; // a pinch, not a keyboard
    const said = fromShrink(base - v.height);
    if (said !== undefined) setKeyboard(said);
  };
  const onFocusIn = (e: FocusEvent) => {
    const v = vv();
    if (!v || base || !isTextField(e.target)) return;
    base = v.height;
    v.addEventListener('resize', onResize);
  };
  const onFocusOut = (e: FocusEvent) => {
    // Focus moving to another field keeps the measure from before the first one.
    if (!base || isTextField(e.relatedTarget)) return;
    base = 0;
    vv()?.removeEventListener('resize', onResize);
  };
  const opts = { capture: true, passive: true } as const;
  win.addEventListener('pointerdown', onPointer, opts);
  win.addEventListener('pointermove', onPointer, opts);
  win.addEventListener('keydown', onKey, opts);
  win.addEventListener('focusin', onFocusIn, opts);
  win.addEventListener('focusout', onFocusOut, opts);
  return () => {
    win.removeEventListener('pointerdown', onPointer, opts);
    win.removeEventListener('pointermove', onPointer, opts);
    win.removeEventListener('keydown', onKey, opts);
    win.removeEventListener('focusin', onFocusIn, opts);
    win.removeEventListener('focusout', onFocusOut, opts);
    vv()?.removeEventListener('resize', onResize);
    base = 0;
  };
}
