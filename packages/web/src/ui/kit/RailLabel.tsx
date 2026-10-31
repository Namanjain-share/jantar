/**
 * A group rail: 28 px, mono 11, uppercase via CSS (the DOM stays "Your
 * turn"), with the count beside it. Sticky inside its scroll container by
 * default. The count is --signal-text only for the Needs you group.
 */
import clsx from 'clsx';
import type { ReactNode } from 'react';

export interface RailLabelProps {
  children: ReactNode;
  count?: number;
  /** 'needs' turns the count ember. */
  tone?: 'plain' | 'needs';
  /** The ground behind it: the ledger column is surface, full pages are bg. */
  ground?: 'surface' | 'bg';
  sticky?: boolean;
  /** Right-aligned caption in sentence case ("now to 20:08", "press ? anywhere"). */
  aside?: ReactNode;
  /** Horizontal padding: 16 in the ledger, 0 inside padded pages. */
  inset?: boolean;
  className?: string;
}

export function RailLabel({ children, count, tone = 'plain', ground = 'surface', sticky = true, aside, inset = true, className }: RailLabelProps) {
  return (
    <div
      className={clsx(
        'flex h-28 flex-none items-center gap-8 border-b border-line',
        inset && 'px-16',
        sticky && 'sticky top-0 z-2',
        ground === 'surface' ? 'bg-surface' : 'bg-bg',
        className,
      )}
    >
      <h2 className="flex items-center gap-8 type-rail text-ink-3">
        <span>{children}</span>
        {count !== undefined ? <span className={tone === 'needs' ? 'text-signal-text' : 'text-ink-2'}>{count}</span> : null}
      </h2>
      {aside ? <span className="ml-auto type-mono text-ink-3">{aside}</span> : null}
    </div>
  );
}
