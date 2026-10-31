/**
 * Long press on a link row: 500 ms held without moving. A context menu
 * (right click, the keyboard's menu key, or the touch platforms' own long
 * press) fires it too, instead of the browser's link menu. iOS sends no
 * contextmenu for a touch, so the timer is the long press there; the row
 * also needs `[-webkit-touch-callout:none]` and `select-none`, or iOS shows
 * the link preview and selects text.
 *
 * Whatever a long press does can move rows (a pin) or open a menu, so the
 * click that follows the finger lifting can land on the wrong thing: rows
 * that share a guard ignore clicks for a second after one fired
 * (`justLongPressed`).
 */
import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';

export const LONG_PRESS_MS = 500;

/** When the last long press among the rows that share it fired. */
export interface PressGuard {
  at: number;
}

export const justLongPressed = (g: PressGuard) => {
  const d = Date.now() - g.at;
  return d >= 0 && d < 1000;
};

/** Pointer and context-menu handlers for a row; none when `onLong` is undefined. `onLong` gets the row. */
export function useLongPress<E extends HTMLElement>(onLong: ((el: E) => void) | undefined, guard: PressGuard) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const at = useRef<{ x: number; y: number } | null>(null);
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    at.current = null;
  };
  useEffect(() => stop, []);
  const fire = (el: E) => {
    stop();
    guard.at = Date.now();
    onLong?.(el);
  };
  if (!onLong) return {};
  return {
    onPointerDown(e: PointerEvent<E>) {
      if (e.button > 0) return;
      stop();
      at.current = { x: e.clientX, y: e.clientY };
      const el = e.currentTarget;
      timer.current = setTimeout(() => fire(el), LONG_PRESS_MS);
    },
    onPointerMove(e: PointerEvent<E>) {
      const a = at.current;
      if (a && Math.hypot(e.clientX - a.x, e.clientY - a.y) > 8) stop();
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    onContextMenu(e: MouseEvent<E>) {
      e.preventDefault();
      if (!justLongPressed(guard)) fire(e.currentTarget);
    },
  };
}
