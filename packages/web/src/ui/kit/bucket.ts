/**
 * A box's width as a bucket (0.11): `useBucket(ref, (w) => w >= 940)`. The
 * one measure Columns, the Life pages, Accounts, Devices and the session's
 * property column share: read before the first paint, then one
 * ResizeObserver that sets state only when the bucket changes, so a window
 * drag re-renders nothing in between. Without a measure (jsdom, a hidden
 * box) the bucket is `bucket(0)`. Small and dependency-free: the session
 * screen, in the main load, uses it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * A box's width, read before the first paint and kept by one ResizeObserver,
 * as `bucket(width)`: state changes only when the bucket does (0 when there
 * is no measure). The box may come later than the first render (a screen
 * that shows a skeleton first) or change: after each render the hook checks
 * which element `ref` holds and observes that one.
 */
export function useBucket<T>(ref: RefObject<HTMLElement | null>, bucket: (width: number) => T): T {
  const fn = useRef(bucket);
  fn.current = bucket;
  const [value, setValue] = useState<T>(() => bucket(0));
  const watched = useRef<{ el: HTMLElement | null; ro: ResizeObserver | null }>({ el: null, ro: null });
  useLayoutEffect(() => {
    const el = ref.current;
    const w = watched.current;
    if (el === w.el) return;
    w.ro?.disconnect();
    w.el = el;
    w.ro = null;
    if (!el) return;
    const read = (width: number) => setValue(fn.current(width > 0 ? width : 0));
    read(el.getBoundingClientRect().width);
    if (typeof ResizeObserver !== 'function') return;
    w.ro = new ResizeObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e) read(e.contentRect.width);
    });
    w.ro.observe(el);
  });
  useEffect(() => {
    const w = watched.current;
    return () => {
      w.ro?.disconnect();
      w.el = null;
      w.ro = null;
    };
  }, []);
  return value;
}
