/** Data and layout hooks for the Accounts screen. */
import { useEffect, useRef, useState, type RefObject } from 'react';

/** /v1/plan and the ceiling: one shared feed (ui/plan.ts). */
export { ceilingOf, usePlan } from '../../plan.js';

/** An element's content width, kept current with ResizeObserver (`fallback` until measured). */
export function useWidth<T extends HTMLElement>(fallback: number): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
