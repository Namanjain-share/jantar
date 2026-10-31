/**
 * The brand mark IS the legend: a 2x2 grid of 6 px squares with 2 px gaps,
 * 14 px in all. Top-left is the needs-you cell (ember while anything needs
 * you, quiet --ink-4 otherwise), top-right working (ink filled), bottom-left
 * your turn (ink outline), bottom-right no update (dashed).
 *
 * The favicons in public/ are the same drawing, written by
 * scripts/gen-icons.mjs from tokens.css; lib/favicon.ts swaps them.
 */
import clsx from 'clsx';
import { PRODUCT_NAME } from '../../brand.js';

export function Mark({ needs = false, label = PRODUCT_NAME, className }: { needs?: boolean; label?: string | null; className?: string }) {
  return (
    <svg
      className={clsx('glyph block flex-none', className)}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      shapeRendering="crispEdges"
      role={label ? 'img' : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      focusable="false"
      data-needs={needs ? 'true' : 'false'}
    >
      <rect className={needs ? 'fill-signal' : 'fill-ink-4'} x="0" y="0" width="6" height="6" />
      <rect className="fill-ink" x="8" y="0" width="6" height="6" />
      <rect className="fill-ink" x="0" y="8" width="6" height="1" />
      <rect className="fill-ink" x="0" y="13" width="6" height="1" />
      <rect className="fill-ink" x="0" y="9" width="1" height="4" />
      <rect className="fill-ink" x="5" y="9" width="1" height="4" />
      <rect className="fill-ink" x="8" y="8" width="2" height="1" />
      <rect className="fill-ink" x="12" y="8" width="2" height="1" />
      <rect className="fill-ink" x="8" y="13" width="2" height="1" />
      <rect className="fill-ink" x="12" y="13" width="2" height="1" />
      <rect className="fill-ink" x="8" y="10" width="1" height="2" />
      <rect className="fill-ink" x="13" y="10" width="1" height="2" />
    </svg>
  );
}

/** Mark plus the wordmark (Archivo wdth 125, 600, 15 px). */
export function Wordmark({ needs = false, className }: { needs?: boolean; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-10', className)}>
      <Mark needs={needs} label={null} />
      <span className="type-word text-ink">{PRODUCT_NAME}</span>
    </span>
  );
}
