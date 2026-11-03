/**
 * An empty screen that still teaches: a title, one line, optionally a ghosted
 * example stamped EXAMPLE DATA, and optionally the legend (the empty board
 * shows the five glyphs instead of an illustration).
 *
 * 0.11 (c32): in a pane of 640 or more it sits centred, at most 480 wide,
 * instead of in the top-left corner of a wide pane.
 */
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Legend } from './Legend.js';

export interface EmptyStateProps {
  title: string;
  children?: ReactNode;
  /** A ghosted example (for instance one ledger row). Stamped EXAMPLE DATA. */
  example?: ReactNode;
  legend?: boolean;
  className?: string;
}

export function EmptyState({ title, children, example, legend = false, className }: EmptyStateProps) {
  return (
    <section data-empty-state className={clsx('px-16 py-24 desk:px-32 @md:mx-auto @md:w-full @md:max-w-480 @md:py-64', className)}>
      <h2 className="type-title text-ink @md:text-center">{title}</h2>
      {children ? <div className="mt-6 max-w-560 type-small text-ink-2 @md:text-center">{children}</div> : null}
      {example ? (
        <div className="mt-24 max-w-560">
          <p className="mb-6 type-rail text-ink-3">Example data</p>
          <div className="opacity-60" aria-hidden="true">
            {example}
          </div>
        </div>
      ) : null}
      {legend ? <Legend layout="stacked" className="mt-24 max-w-560" /> : null}
    </section>
  );
}
