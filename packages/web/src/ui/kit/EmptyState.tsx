/**
 * An empty screen that still teaches: a title, one line, optionally a ghosted
 * example stamped EXAMPLE DATA, and optionally the legend (the empty board
 * shows the five glyphs instead of an illustration).
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
    <section className={clsx('px-16 py-24 md:px-32', className)}>
      <h2 className="type-title text-ink">{title}</h2>
      {children ? <div className="mt-6 max-w-560 type-small text-ink-2">{children}</div> : null}
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
