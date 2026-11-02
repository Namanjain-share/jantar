// @vitest-environment node
/**
 * The wide-window metric (layout-metric.ts, 0.11 c13) on synthetic layouts:
 * the user's 720 column at 1384 fails, three columns of cards pass, and the
 * metric can't be gamed by a header button at the edge or by full-width
 * bordered rows with words only at their two ends.
 */
import { describe, expect, it } from 'vitest';
import { emptyShare, MAX_EMPTY, MIN_USED, under44, type Rect } from './layout-metric.js';

/** The Mac at 1440 x 960: the content region right of the rail, under the top bar. */
const MAIN: Rect = { x: 56, y: 48, w: 1384, h: 888 };

/** Rows of text `h` tall, `gap` apart, from x to x + w, down the region. */
function rows(x: number, w: number, h = 20, gap = 28): Rect[] {
  const out: Rect[] = [];
  for (let y = MAIN.y + 16; y + h <= MAIN.y + MAIN.h; y += h + gap) out.push({ x, y, w, h });
  return out;
}

describe('emptyShare', () => {
  it("fails the user's Today: one 720 column (688 of text) at 1384 leaves about half empty", () => {
    const share = emptyShare(rows(MAIN.x + 16, 688), MAIN);
    expect(share).toBeGreaterThan(0.45);
    expect(share).toBeLessThan(0.52);
    expect(share).toBeGreaterThan(MAX_EMPTY);
  });

  it('passes three columns of cards (painted boxes) across the width', () => {
    const cards: Rect[] = [0, 1, 2].map((i) => ({ x: MAIN.x + 24 + i * (440 + 16), y: MAIN.y + 24, w: 440, h: 300 }));
    expect(emptyShare(cards, MAIN)).toBeLessThan(MAX_EMPTY);
  });

  it("a header button at the right edge doesn't rescue a 720 column", () => {
    const button: Rect = { x: MAIN.x + MAIN.w - 60, y: MAIN.y + 8, w: 44, h: 44 };
    expect(emptyShare([...rows(MAIN.x + 16, 688), button], MAIN)).toBeGreaterThan(MAX_EMPTY);
  });

  it('full-width bordered rows with words only at their two ends fail (a border is not content)', () => {
    const names = rows(MAIN.x + 16, 260);
    const actions = rows(MAIN.x + MAIN.w - 16 - 80, 80);
    expect(emptyShare([...names, ...actions], MAIN)).toBeGreaterThan(MAX_EMPTY);
  });

  it('a column is used from 96 px of content, counted once where boxes overlap', () => {
    const region: Rect = { x: 0, y: 0, w: 8, h: 400 };
    // Column 1: 95 px (two overlapping boxes, 60 + 60 with 25 shared); column 2: exactly 96.
    const boxes: Rect[] = [
      { x: 0, y: 0, w: 4, h: 60 },
      { x: 0, y: 35, w: 4, h: 60 },
      { x: 4, y: 100, w: 4, h: 48 },
      { x: 4, y: 200, w: 4, h: MIN_USED - 48 },
    ];
    expect(emptyShare(boxes, region)).toBe(0.5);
    expect(emptyShare([...boxes, { x: 0, y: 300, w: 4, h: 1 }], region)).toBe(0);
  });

  it('counts only what is inside the region, and a region shorter than 96 by its own height', () => {
    const short: Rect = { x: 0, y: 0, w: 40, h: 50 };
    expect(emptyShare([{ x: 0, y: 0, w: 40, h: 50 }], short)).toBe(0);
    expect(emptyShare([{ x: 0, y: 60, w: 40, h: 200 }], short)).toBe(1);
    expect(emptyShare([{ x: 100, y: 0, w: 40, h: 50 }], short)).toBe(1);
  });
});

describe('under44', () => {
  it('lists the targets under 44 in either direction', () => {
    const t = [
      { name: 'Send', x: 0, y: 0, w: 44, h: 44 },
      { name: 'Undo', x: 0, y: 0, w: 60, h: 32 },
      { name: '×', x: 0, y: 0, w: 24, h: 44 },
    ];
    expect(under44(t).map((x) => x.name)).toEqual(['Undo', '×']);
  });
});
