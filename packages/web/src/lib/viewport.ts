/**
 * The visual viewport (0.12, build plan 1.8; ipad-design.md 4.6).
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
 *          it is over 200 (`kbUp`, for the layout context, and 0.13.2's
 *          data-kb-up on <html>, for kit.css).
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
 * scrolled into view in its pane: the fields that are not pinned at a
 * pane's bottom (a café's notes, a meeting's search, Intel's note) stay
 * visible above the keyboard.
 *
 * 0.13.2, from an iPhone on iOS 26 (a Home Screen app): the window can
 * shrink with the keyboard too, so the keyboard is measured against the
 * window's height from before it came up (`full`), not the window's height
 * now; iOS may scroll the page itself to show the field, which carries the
 * fixed shell off the top, so while a field has focus the page is put back
 * at the top (the shell does the moving, the page never scrolls); a field
 * removed while it has focus (leaving a session with the keyboard up) sends
 * no focusout, so a resize that finds no field focused lets go as a blur
 * would; and the field is brought into view inside its own scroll box only,
 * never by scrolling the page (`scrollIntoView` scrolls every box up to the
 * page, and on iOS that pans it).
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

/** What to set for a window `innerHeight` tall (its height before the keyboard) with this visual viewport; null while it is zoomed (clear everything). */
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
  // 0.13.2: kit.css drops the bottom safe area from the composer's padding while the keyboard covers it.
  root.toggleAttribute('data-kb-up', v.kb > KB_UP);
  setKbUp(v.kb > KB_UP);
}

function clear(root: HTMLElement): void {
  root.style.removeProperty('--vvh');
  root.style.removeProperty('--vvt');
  root.style.removeProperty('--kb');
  root.removeAttribute('data-kb-up');
  setKbUp(false);
}

function setKbUp(on: boolean): void {
  if (viewportStore.getState().kbUp !== on) viewportStore.setState({ kbUp: on });
}

/** The focused field into view inside its nearest scroll box, 16 px clear of its bottom; never the page. */
export function revealInPane(el: HTMLElement, win: Window = window): void {
  for (let p = el.parentElement; p && p !== win.document.body; p = p.parentElement) {
    const y = win.getComputedStyle(p).overflowY;
    if ((y !== 'auto' && y !== 'scroll') || p.scrollHeight <= p.clientHeight) continue;
    const r = el.getBoundingClientRect();
    const box = p.getBoundingClientRect();
    if (r.bottom > box.bottom - 16) p.scrollTop += r.bottom - (box.bottom - 16);
    else if (r.top < box.top) p.scrollTop -= box.top - r.top;
    return;
  }
}

/** Starts following the visual viewport while a field has focus; returns the stop function. main.tsx calls it once. */
export function watchViewport(win: Window = window): () => void {
  const root = win.document.documentElement;
  const vv = () => win.visualViewport;
  let watching = false;
  let leaving = 0;
  let settle = 0;
  /** The window's height before the keyboard came up (0.13.2: iOS 26 can shrink the window with it), and its width then. */
  let full = 0;
  let fullWidth = 0;

  /** The page never scrolls under the shell: put it back if iOS scrolled it to show the field (never while zoomed: that is a pan). */
  const pageToTop = () => {
    if (Math.abs((vv()?.scale ?? 1) - 1) > 0.01) return;
    if (win.scrollY !== 0 || win.scrollX !== 0) win.scrollTo(0, 0);
  };
  const letGo = () => {
    // Back to the top at once; the rest once the keyboard is down (or a second from now).
    root.style.setProperty('--vvt', '0px');
    win.clearTimeout(leaving);
    leaving = win.setTimeout(stop, 1000);
  };
  const update = () => {
    const v = vv();
    if (!v) return;
    // A field removed while it had focus sends no focusout: let go as a blur would.
    if (!leaving && !isTextField(win.document.activeElement)) letGo();
    pageToTop();
    // A turn of the device (the width changes; a keyboard never does) starts the height over.
    if (win.innerWidth !== fullWidth) {
      fullWidth = win.innerWidth;
      full = win.innerHeight;
    }
    full = Math.max(full, win.innerHeight);
    const m = measure(full, v);
    if (leaving && m) m.vvt = 0;
    apply(root, m);
    if (leaving && (!m || m.kb < 30)) {
      stop();
      return;
    }
    // The focused field into view in its pane, a frame after the last resize.
    win.cancelAnimationFrame(settle);
    settle = win.requestAnimationFrame(() => {
      const el = win.document.activeElement;
      if (!leaving && isTextField(el)) revealInPane(el as HTMLElement, win);
    });
  };
  const start = () => {
    const v = vv();
    win.clearTimeout(leaving);
    leaving = 0;
    if (!v || watching) return;
    watching = true;
    // Focus comes before the keyboard: the window is still its full height here.
    full = win.innerHeight;
    fullWidth = win.innerWidth;
    v.addEventListener('resize', update);
    v.addEventListener('scroll', update);
    win.addEventListener('scroll', pageToTop, { passive: true });
    update();
  };
  const stop = () => {
    win.clearTimeout(leaving);
    leaving = 0;
    win.cancelAnimationFrame(settle);
    if (watching) {
      vv()?.removeEventListener('resize', update);
      vv()?.removeEventListener('scroll', update);
      win.removeEventListener('scroll', pageToTop);
      pageToTop();
    }
    watching = false;
    full = 0;
    fullWidth = 0;
    clear(root);
  };
  const onFocusIn = (e: FocusEvent) => {
    if (isTextField(e.target)) start();
  };
  const onFocusOut = (e: FocusEvent) => {
    // Focus moving to another field keeps watching.
    if (!watching || isTextField(e.relatedTarget)) return;
    letGo();
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
