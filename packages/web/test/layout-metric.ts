/**
 * The wide-window metric (0.11, build plan 6.2 #3) and the 44 pt check
 * (#2), pure, so they are unit-tested on synthetic layouts
 * (layout-metric.test.ts) and computed in Node from the rectangles the
 * browser suite collects in the page (test/integration/layout-probe.ts).
 *
 * The empty share: the content region (main, and the Chat dock when it is
 * open) is cut into 4 px columns. A column is used when the content boxes
 * over it cover at least 96 px of its height together (or the whole region,
 * when it is shorter). A lone button at the right edge doesn't make a
 * column used, while a column of 48 px rows does. Content boxes are text
 * runs, pictures, form controls and painted boxes; a border or a hairline
 * alone is not content, so a full-width bordered row with its name at the
 * left and its action 1,300 px away doesn't count as using the width
 * between them.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Named extends Rect {
  name: string;
}

/** Column width, px. */
export const COLUMN = 4;
/** A column is used from this much content height, px. */
export const MIN_USED = 96;
/** The release bar: no more than this share of a wide window's content width empty. */
export const MAX_EMPTY = 0.35;
/** Touch targets: at least this wide and tall, px (A1). */
export const MIN_TARGET = 44;

/** The length the intervals cover together. */
function covered(spans: Array<[number, number]>): number {
  if (spans.length === 0) return 0;
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [start, end] = spans[0]!;
  for (const [s, e] of spans.slice(1)) {
    if (s > end) {
      total += end - start;
      start = s;
      end = e;
    } else if (e > end) end = e;
  }
  return total + (end - start);
}

/** The share (0-1) of `region`'s width that no content uses. */
export function emptyShare(boxes: readonly Rect[], region: Rect): number {
  const n = Math.max(1, Math.floor(region.w / COLUMN));
  const need = Math.min(MIN_USED, region.h);
  const top = region.y;
  const bottom = region.y + region.h;
  let unused = 0;
  for (let i = 0; i < n; i += 1) {
    const left = region.x + i * COLUMN;
    const right = left + COLUMN;
    const spans: Array<[number, number]> = [];
    for (const b of boxes) {
      if (b.w <= 0 || b.h <= 0 || b.x + b.w <= left || b.x >= right) continue;
      const t = Math.max(b.y, top);
      const e = Math.min(b.y + b.h, bottom);
      if (e > t) spans.push([t, e]);
    }
    if (covered(spans) < need) unused += 1;
  }
  return unused / n;
}

/** The targets smaller than 44 x 44. */
export function under44<T extends Rect>(targets: readonly T[]): T[] {
  return targets.filter((t) => t.w < MIN_TARGET || t.h < MIN_TARGET);
}
