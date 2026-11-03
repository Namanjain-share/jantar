// @vitest-environment node
/**
 * Columns (kit/Columns.tsx, 0.12 c14): how many columns fit, and the
 * round-robin deal that keeps a card in its column whatever the others do.
 */
import { describe, expect, it } from 'vitest';
import { columnsFor, deal } from '../src/ui/kit/Columns.js';

describe('columnsFor', () => {
  it('fits columns of at least `min` with 16 px between them', () => {
    // Today at the build plan's sizes (2.3): the pane less its 32 px of padding.
    expect(columnsFor(1384 - 32, 340, 9)).toBe(3); // Mac 1440
    expect(columnsFor(968 - 32, 340, 9)).toBe(2); // Mac 1024
    expect(columnsFor(764 - 32, 340, 9)).toBe(2); // 820 portrait, the Mac's chrome
    expect(columnsFor(696, 340, 9)).toBe(2); // exactly two: 2 x 340 + 16
    expect(columnsFor(695, 340, 9)).toBe(1);
    expect(columnsFor(390, 340, 9)).toBe(1);
  });

  it('is capped at the card count and at max, and is at least one', () => {
    expect(columnsFor(1352, 340, 2)).toBe(2);
    expect(columnsFor(1352, 340, 9, 2)).toBe(2);
    expect(columnsFor(0, 340, 9)).toBe(1);
    expect(columnsFor(1352, 340, 0)).toBe(1);
  });
});

describe('deal', () => {
  it('deals round-robin, in order', () => {
    expect(deal(['a', 'b', 'c', 'd', 'e'], 3)).toEqual([
      ['a', 'd'],
      ['b', 'e'],
      ['c'],
    ]);
    expect(deal(['a', 'b'], 1)).toEqual([['a', 'b']]);
  });

  it('puts card i in column i mod n: its column depends on its place in the order, never on how tall the others are', () => {
    const cards = Array.from({ length: 10 }, (_, i) => i);
    const stacks = deal(cards, 3);
    for (const i of cards) expect(stacks[i % 3]).toContain(i);
  });

  it('gives at least one stack', () => {
    expect(deal([], 0)).toEqual([[]]);
  });
});
