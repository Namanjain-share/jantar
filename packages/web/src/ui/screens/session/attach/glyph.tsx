/**
 * An attachment's glyph (v0.4.2's attachments; split out in v0.5.1): a
 * chip's file kind, and the rows of the + sheet. Phosphor draws every icon in all six weights, so these five are a
 * few kB the app's first load does without (scripts/perf-chunks.mjs): they
 * come with glyph-icons.tsx, loaded with `import()` the first time a glyph
 * shows. Until then its square is kept empty, so nothing moves. The glyphs
 * are decoration (aria-hidden): a chip's name and state say what it is.
 */
import { lazy, Suspense } from 'react';
import type { UploadKind } from '@jantar/protocol';

/** A file kind (UploadKind; one this app does not know gets the plain file), or the sheet's folder row. */
export type GlyphName = UploadKind | 'folder';

export interface GlyphProps {
  name: GlyphName;
  size: number;
  className?: string;
}

const GlyphIcon = lazy(() => import('./glyph-icons.js').then((m) => ({ default: m.GlyphIcon })));

export function Glyph(props: GlyphProps) {
  return (
    <Suspense fallback={<span aria-hidden="true" className={props.className} style={{ width: props.size, height: props.size }} />}>
      <GlyphIcon {...props} />
    </Suspense>
  );
}
