/**
 * A section of a pane (0.12, build plan 2.4-2.6): 0.10's rail label over its
 * rows in a narrow pane, or a card in a wide one, as Today's cards are
 * (life/today/Dashboard.tsx): a raised box with a 44 header (the label in
 * the rail type, a count, and an aside at the right, such as "+ Dish"),
 * then the rows, whose last hairline tucks under the card's border. The
 * place decides `card` from its pane (beside a list, or a pane of 640 or
 * more), so nothing measures here, and the section's name and heading are
 * the same either way.
 *
 * Only lazy screens import this file (it is not in kit/index.ts), so it
 * stays out of the main load.
 */
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { RailLabel } from './RailLabel.js';

export interface PanelProps {
  /** The section's name and heading. */
  label: ReactNode;
  count?: number | undefined;
  /** At the heading's right: a caption, or a small text button. */
  aside?: ReactNode;
  card: boolean;
  /** The region's name when `label` is not plain text. */
  name?: string;
  className?: string;
  children: ReactNode;
}

export function Panel({ label, count, aside, card, name, className, children }: PanelProps) {
  const region = name ?? (typeof label === 'string' ? label : undefined);
  if (!card)
    return (
      <section aria-label={region} className={className}>
        <RailLabel ground="bg" aside={aside} {...(count !== undefined ? { count } : {})}>
          {label}
        </RailLabel>
        {children}
      </section>
    );
  return (
    <section aria-label={region} className={clsx('min-w-0 overflow-hidden rounded-dock border border-line bg-raised', className)}>
      <header className="flex h-44 items-center gap-8 border-b border-line pl-16 pr-8">
        <h2 className="flex min-w-0 flex-1 items-center gap-8 type-rail text-ink-3">
          <span className="truncate">{label}</span>
          {count !== undefined ? <span className="text-ink-2">{count}</span> : null}
        </h2>
        {aside ? <span className="flex-none type-mono text-ink-3">{aside}</span> : null}
      </header>
      <div className="-mb-px">{children}</div>
    </section>
  );
}
