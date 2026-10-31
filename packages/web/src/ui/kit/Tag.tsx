/**
 * Tags: mono 11 px in a 3 px-radius box with a 1 px --line-strong outline.
 *
 *   plain  ink-2 text: "held", "default login", "+2 agents"
 *   next   the next account autoswitch will use: mustard fill (Jupiter marks
 *          luck), the only tag with a fill
 *   warn   --signal-text: a usageStatus that needs you ("token expired")
 */
import clsx from 'clsx';
import type { ReactNode } from 'react';

export type TagTone = 'plain' | 'next' | 'warn';

const TONE: Record<TagTone, string> = {
  plain: 'border-line-strong text-ink-2',
  next: 'border-jup bg-jup-fill text-on-jup',
  warn: 'border-line-strong text-signal-text',
};

export function Tag({ tone = 'plain', children, className }: { tone?: TagTone; children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex h-20 flex-none items-center whitespace-nowrap rounded-chip border px-6 font-mono text-rail font-data',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
