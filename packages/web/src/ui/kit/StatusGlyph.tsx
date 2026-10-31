/**
 * The status glyph: an 8x8 square, pixel-snapped, in a 16 px slot (rows,
 * dock, legend) or alone at 8 px (the strip). Drawn from 1 px rects with
 * shape-rendering crispEdges, never strokes, so it stays sharp at 1x.
 *
 *   needs       filled --signal          (the only coloured state)
 *   working     filled --ink
 *   compacting  --ink outline, bottom half filled
 *   turn        --ink-2 outline
 *   ended       --ink-4 outline
 *   stale       --ink-3 dashed outline
 *
 * `dashed` draws any state as a dashed outline in its own colour: the strip
 * uses it while offline or not yet in sync.
 */
import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { GlyphState } from './glyph.js';

const FILL: Record<GlyphState, string> = {
  needs: 'fill-signal',
  working: 'fill-ink',
  compacting: 'fill-ink',
  turn: 'fill-ink-2',
  ended: 'fill-ink-4',
  stale: 'fill-ink-3',
};

/** 1 px outline of the 8x8 square at (4,4). */
function box(c: string): ReactNode {
  return (
    <>
      <rect className={c} x="4" y="4" width="8" height="1" />
      <rect className={c} x="4" y="11" width="8" height="1" />
      <rect className={c} x="4" y="5" width="1" height="6" />
      <rect className={c} x="11" y="5" width="1" height="6" />
    </>
  );
}

/** Dashed outline: 2 px on, 1 px off, three dashes per side. */
function dashBox(c: string): ReactNode {
  return [0, 3, 6].map((o) => (
    <g key={o}>
      <rect className={c} x={4 + o} y="4" width="2" height="1" />
      <rect className={c} x={4 + o} y="11" width="2" height="1" />
      <rect className={c} x="4" y={4 + o} width="1" height="2" />
      <rect className={c} x="11" y={4 + o} width="1" height="2" />
    </g>
  ));
}

export function glyphShapes(state: GlyphState, dashed = false): ReactNode {
  const c = FILL[state];
  if (dashed || state === 'stale') return dashBox(c);
  switch (state) {
    case 'needs':
    case 'working':
      return <rect className={c} x="4" y="4" width="8" height="8" />;
    case 'compacting':
      return (
        <>
          {box(c)}
          <rect className={c} x="4" y="8" width="8" height="4" />
        </>
      );
    case 'turn':
    case 'ended':
      return box(c);
  }
}

export interface StatusGlyphProps {
  state: GlyphState;
  /** 'slot': 16 px box with the square centred (rows). 'cell': the bare 8 px square (strip). */
  size?: 'slot' | 'cell';
  dashed?: boolean;
  /** Accessible name; omit when a visible word already says the state. */
  label?: string;
  className?: string;
}

export function StatusGlyph({ state, size = 'slot', dashed = false, label, className }: StatusGlyphProps) {
  const cell = size === 'cell';
  return (
    <svg
      className={clsx('glyph block flex-none', className)}
      width={cell ? 8 : 16}
      height={cell ? 8 : 16}
      viewBox={cell ? '4 4 8 8' : '0 0 16 16'}
      shapeRendering="crispEdges"
      data-glyph={state}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {glyphShapes(state, dashed)}
    </svg>
  );
}
