/**
 * 0.15 Messages: the Messages place's icon, two speech bubbles in Phosphor's
 * regular weight (a 256 grid, 16 px strokes, round ends), as its ChatsCircle
 * draws them. Drawn here rather than imported, as people-glyph.tsx is: the
 * imported icon put the owner's main load over its size gate
 * (scripts/perf-chunks.mjs), and Chat's icon is a bubble too.
 */
import type { Icon } from '@phosphor-icons/react';

function Glyph({ size = 24, className, ...rest }: { size?: number | string; className?: string } & Record<string, unknown>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth={16} strokeLinecap="round" strokeLinejoin="round" className={className} {...rest}>
      <path d="M34 140A72 72 0 1 1 60 166L28 172Z" />
      <path d="M173 81A72 72 0 0 1 222 188l6 32-32-6A72 72 0 0 1 96 184" />
    </svg>
  );
}

/** Typed as a Phosphor icon: the places render every icon the same way. */
export const MessagesGlyph = Glyph as unknown as Icon;
