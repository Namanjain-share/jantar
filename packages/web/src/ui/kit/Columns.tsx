/**
 * Cards in columns (0.11, build plan 1.5): `<Columns min={340}>{cards}</Columns>`
 * deals its children round-robin into n stacks, in their given order (card i
 * goes to stack i mod n), so a card never jumps to another column when a
 * card above it grows or shrinks (CSS columns would rebalance, and a tap on
 * Taken could move the card under the finger).
 *
 *   n = min(count, max(1, floor((width + 16) / (min + 16))))
 *
 * n is capped at the number of cards, so two cards never leave a third
 * column empty, and at `max`. One ResizeObserver, which sets state only when
 * n changes: a window drag re-renders nothing in between. Without a measure
 * (jsdom, a hidden box) there is one stack.
 *
 * When n changes every card moves to a new parent and remounts, so a card
 * keeps no state that matters: writes in flight, their "Not saved" lines and
 * open menus live in the screen above, and typing happens in sheets. n
 * changes only with the width, never with data.
 *
 * Only lazy screens import this file (it is not in kit/index.ts), so it
 * stays out of the main load.
 */
import { Children, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

/** The gap between columns and between the cards in one, px (gap-16). */
export const GAP = 16;

/** How many columns of at least `min` fit in `width`, at most `count` (at least one). */
export function columnsFor(width: number, min: number, count: number, max = Infinity): number {
  const fit = Math.max(1, Math.floor((width + GAP) / (min + GAP)));
  return Math.max(1, Math.min(fit, count, max));
}

/** `items` dealt round-robin into `n` stacks: item i into stack i mod n. */
export function deal<T>(items: readonly T[], n: number): T[][] {
  const stacks: T[][] = Array.from({ length: Math.max(1, n) }, () => []);
  items.forEach((item, i) => stacks[i % stacks.length]!.push(item));
  return stacks;
}

/**
 * A box's width, read before the first paint and kept by one ResizeObserver,
 * as `bucket(width)`: state changes only when the bucket does (0 when there
 * is no measure).
 */
export function useBucket<T>(ref: RefObject<HTMLElement | null>, bucket: (width: number) => T): T {
  const fn = useRef(bucket);
  fn.current = bucket;
  const [value, setValue] = useState<T>(() => bucket(0));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = (width: number) => setValue(fn.current(width > 0 ? width : 0));
    read(el.getBoundingClientRect().width);
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e) read(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return value;
}

export interface ColumnsProps {
  /** The narrowest a column may be, px. */
  min?: number;
  /** At most this many columns. */
  max?: number;
  children: ReactNode;
  className?: string;
}

export function Columns({ min = 340, max, children, className }: ColumnsProps) {
  const box = useRef<HTMLDivElement>(null);
  const items = Children.toArray(children);
  const count = items.length;
  // What fits the width; the card count caps it at render, so a card shown or hidden never waits for a resize.
  const fit = useBucket(box, (w) => (w > 0 ? columnsFor(w, min, Infinity, max) : 1));
  const stacks = deal(items, Math.min(fit, Math.max(1, count)));
  return (
    <div ref={box} data-columns={stacks.length} className={className}>
      <div className="flex items-start gap-16">
        {stacks.map((stack, i) => (
          <div key={i} className="flex min-w-0 flex-1 flex-col gap-16">
            {stack}
          </div>
        ))}
      </div>
    </div>
  );
}
