/**
 * v0.12 People: the People place's icon, two figures in Phosphor's regular
 * weight (a 256 grid, 16 px strokes, round ends). Drawn here rather than
 * imported, so the People entry adds only a few bytes to the owner's main
 * load (spec 9.4: People's screens stay lazy; its place in the nav is all
 * of it that the main load carries).
 */
import type { Icon } from '@phosphor-icons/react';

function Glyph({ size = 24, className, ...rest }: { size?: number | string; className?: string } & Record<string, unknown>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth={16} strokeLinecap="round" strokeLinejoin="round" className={className} {...rest}>
      <circle cx="88" cy="100" r="40" />
      <path d="M16 200c16-28 42-44 72-44s56 16 72 44" />
      <circle cx="176" cy="92" r="32" />
      <path d="M172 156c28 0 52 14 68 40" />
    </svg>
  );
}

/** Typed as a Phosphor icon: the places render every icon the same way. */
export const PeopleGlyph = Glyph as unknown as Icon;
