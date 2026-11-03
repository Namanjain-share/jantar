/**
 * The visual viewport (0.11, build plan 1.8; ipad-design.md 4.6).
 *
 * On an iPad the layout viewport never shrinks for the on-screen keyboard,
 * and iOS may pan the visual viewport to show a field. So while a text field
 * has focus this follows `visualViewport` and sets, on <html>:
 *
 *   --vvh  its height: the shell's height (kit.css .shell), so a pane's
 *          bottom, and the composer pinned there, sit on the keyboard;
 *   --vvt  its offset from the top, clamped to 0 … the keyboard's height:
 *          the shell moves down with a pan, so the headers stay in view;
 *   --kb   the window's height minus its height: the keyboard is up once
 *          it is over 200 (`kbUp`, for the layout context).
 *
 * Nothing is set while no field has focus (the shell is then 100dvh and
 * never moves), and nothing while the page is pinch-zoomed (a zoom changes
 * the visual viewport too, and must never shrink or shift the app). When
 * the field loses focus, --vvt goes back to 0 at once (iOS can leave the
 * offset set after the keyboard closes) and the rest is cleared once the
 * height is full again. On a Mac the visual viewport is the layout
 * viewport, so nothing moves.
 *
 * Once the resizes settle (a frame after the last), the focused field is
 * scrolled into view in its pane (`block: 'nearest'`): the fields that are
 * not pinned at a pane's bottom (a café's notes, a meeting's search, Intel's
 * note) stay visible above the keyboard.
 */
import { createStore } from 'zustand/vanilla';
import { isTextField } from './input.js';

/** The on-screen keyboard is up once the visual viewport is this much shorter than the window, px. */
export const KB_UP = 200;

export const viewportStore = createStore<{ kbUp: boolean }>()(() => ({ kbUp: false }));

export interface ViewportVars {
  vvh: number;
  vvt: number;
  kb: number;
}

/** What to set for a window `innerHeight` tall with this visual viewport; null while it is zoomed (clear everything). */
export function measure(innerHeight: number, vv: { height: number; offsetTop: number; scale: number }): ViewportVars | null {
  if (Math.abs(vv.scale - 1) > 0.01) return null;
  const vvh = Math.round(vv.height);
  const kb = Math.max(0, Math.round(innerHeight - vv.height));
  const vvt = Math.min(Math.max(0, Math.round(vv.offsetTop)), kb);
  return { vvh, vvt, kb };
}

function apply(root: HTMLElement, v: ViewportVars | null): void {
  if (!v) {
    clear(root);
    return;
  }
  root.style.setProperty('--vvh', `${v.vvh}px`);
  root.style.setProperty('--vvt', `${v.vvt}px`);
  root.style.setProperty('--kb', `${v.kb}px`);
  setKbUp(v.kb > KB_UP);
}

function clear(root: HTMLElement): void {
  root.style.removeProperty('--vvh');
  root.style.removeProperty('--vvt');
  root.style.removeProperty('--kb');
  setKbUp(false);
}

function setKbUp(on: boolean): void {
  if (viewportStore.getState().kbUp !== on) viewportStore.setState({ kbUp: on });
}

/** Starts following the visual viewport while a field has focus; returns the stop function. main.tsx calls it once. */
export function watchViewport(win: Window = window): () => void {
  const root = win.document.documentElement;
  const vv = () => win.visualViewport;
  let watching = false;
  let leaving = 0;
  let settle = 0;

  const update = () => {
    const v = vv();
    if (!v) return;
    const m = measure(win.innerHeight, v);
    if (leaving && m) m.vvt = 0;
    apply(root, m);
    if (leaving && (!m || m.kb < 30)) {
      stop();
      return;
    }
    // The focused field into view, a frame after the last resize.
    win.cancelAnimationFrame(settle);
    settle = win.requestAnimationFrame(() => {
      const el = win.document.activeElement;
      if (!leaving && isTextField(el)) (el as HTMLElement).scrollIntoView?.({ block: 'nearest' });
    });
  };
  const start = () => {
    const v = vv();
    win.clearTimeout(leaving);
    leaving = 0;
    if (!v || watching) return;
    watching = true;
    v.addEventListener('resize', update);
    v.addEventListener('scroll', update);
    update();
  };
  const stop = () => {
    win.clearTimeout(leaving);
    leaving = 0;
    win.cancelAnimationFrame(settle);
    if (watching) {
      vv()?.removeEventListener('resize', update);
      vv()?.removeEventListener('scroll', update);
    }
    watching = false;
    clear(root);
  };
  const onFocusIn = (e: FocusEvent) => {
    if (isTextField(e.target)) start();
  };
  const onFocusOut = (e: FocusEvent) => {
    // Focus moving to another field keeps watching.
    if (!watching || isTextField(e.relatedTarget)) return;
    // Back to the top at once; the rest once the keyboard is down (or a second from now).
    root.style.setProperty('--vvt', '0px');
    leaving = win.setTimeout(stop, 1000);
    update();
  };
  const opts = { capture: true, passive: true } as const;
  win.addEventListener('focusin', onFocusIn, opts);
  win.addEventListener('focusout', onFocusOut, opts);
  return () => {
    win.removeEventListener('focusin', onFocusIn, opts);
    win.removeEventListener('focusout', onFocusOut, opts);
    stop();
  };
}
