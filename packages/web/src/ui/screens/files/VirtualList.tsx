/**
 * A virtualised list in its own scroller (TanStack Virtual): only the rows
 * in view, plus a few either side, are in the DOM, so a 10,000-entry folder
 * or a long changes list scrolls like a short one. Rows measure themselves
 * (an expanded row, a wrapped line), so `estimate` only has to be close.
 *
 * Positions are set through the element's style object (CSSOM), which the
 * CSP allows; nothing writes a style attribute or a <style> element.
 */
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import clsx from 'clsx';
import { useRef, type ReactNode } from 'react';

/**
 * The scroller's size, as TanStack Virtual's own observer reports it, but
 * never 0: before the first layout (or with no layout at all, as in jsdom)
 * a zero height would draw no rows, so it counts as one screen tall.
 */
export const observeRect: typeof observeElementRect = (instance, cb) =>
  observeElementRect(instance, (rect) => cb(rect.height > 0 ? rect : { width: rect.width, height: typeof window !== 'undefined' ? window.innerHeight || 800 : 800 }));

export interface VirtualListProps<T> {
  items: readonly T[];
  getKey: (item: T, index: number) => string;
  /** Best guess at a row's height in px. */
  estimate: (item: T, index: number) => number;
  render: (item: T, index: number) => ReactNode;
  /** Names the list for assistive tech. */
  label: string;
  /** Inside the scroller, after the rows ("Show 500 more", footnotes). */
  footer?: ReactNode;
  className?: string;
}

export function VirtualList<T>({ items, getKey, estimate, render, label, footer, className }: VirtualListProps<T>) {
  const scroller = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => estimate(items[i]!, i),
    getItemKey: (i) => getKey(items[i]!, i),
    overscan: 8,
    useFlushSync: false,
    observeElementRect: observeRect,
  });
  return (
    <div ref={scroller} data-scroller="" className={clsx('min-h-0 flex-1 overflow-y-auto overscroll-contain', className)}>
      <ul aria-label={label} className="relative w-full" style={{ height: v.getTotalSize() }}>
        {v.getVirtualItems().map((row) => (
          <li
            key={row.key}
            data-index={row.index}
            ref={v.measureElement}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${row.start}px)` }}
          >
            {render(items[row.index]!, row.index)}
          </li>
        ))}
      </ul>
      {footer}
    </div>
  );
}
