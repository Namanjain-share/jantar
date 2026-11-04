/**
 * Cards in columns (0.12, build plan 1.5): `<Columns min={340}>{cards}</Columns>`
 * deals its children round-robin into n stacks, in their given order (card i
 * goes to stack i mod n), so a card never jumps to another column when a
 * card above it grows or shrinks (CSS columns would rebalance, and a tap on
 * Taken could move the card under the finger).
 *
 *   n = min(count, max(1, floor((width + 16) / (min + 16))))
 *
 * n is capped at the number of cards, so two cards never leave a third
 * column empty (unless `fill` keeps it, for a band under another), and at
 * `max`. One ResizeObserver, which sets state only when
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
import { Children, useRef, type ReactNode, type RefObject } from 'react';
import { useBucket } from './bucket.js';

export { useBucket };

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

/** From a pane this wide a page's sections are cards (Today, Todos, Medicines, Food, Finance). */
export const CARDS_FROM = 640;

/** Whether the box is CARDS_FROM wide or more: false without a measure (jsdom, a hidden box), so 0.10's list. */
export function useCardWidth(ref: RefObject<HTMLElement | null>): boolean {
  return useBucket(ref, (w) => w >= CARDS_FROM);
}

export interface ColumnsProps {
  /** The narrowest a column may be, px. */
  min?: number;
  /** At most this many columns. */
  max?: number;
  /**
   * 0.13.1: keep every column that fits, even with fewer cards than columns, so a band of cards under
   * another lines up with its columns (Insights' cards by currency, then the stages' two).
   */
  fill?: boolean;
  children: ReactNode;
  className?: string;
}

export function Columns({ min = 340, max, fill = false, children, className }: ColumnsProps) {
  const box = useRef<HTMLDivElement>(null);
  const items = Children.toArray(children);
  const count = items.length;
  // What fits the width; the card count caps it at render, so a card shown or hidden never waits for a resize.
  const fit = useBucket(box, (w) => (w > 0 ? columnsFor(w, min, Infinity, max) : 1));
  const stacks = deal(items, fill ? fit : Math.min(fit, Math.max(1, count)));
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
