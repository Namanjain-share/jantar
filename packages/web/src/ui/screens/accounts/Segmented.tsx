/**
 * A small segmented control (dir-k.html .b-seg): a 32 px hairline box of
 * toggle buttons, the pressed one on --select. Used for the Accounts sort and
 * the Alerts kind filter. 44 px under a coarse pointer, each segment the
 * whole height (0.12: the box's hairline is drawn inside it there, so the
 * segments fill the 44).
 */
import clsx from 'clsx';
import type { ReactNode } from 'react';

export interface Segment<K extends string> {
  key: K;
  label: ReactNode;
  /** Accessible name when the label is not plain text. */
  name?: string;
}

export function Segmented<K extends string>({
  label,
  segments,
  value,
  onChange,
  fill = false,
  className,
}: {
  /** Names the group: "Sort accounts". */
  label: string;
  segments: Segment<K>[];
  value: K;
  onChange: (k: K) => void;
  /** Take the full width, the segments sharing it (a phone's Picture | Text). */
  fill?: boolean;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={clsx(
        'h-32 flex-none rounded-btn border border-line p-2 coarse:h-44 coarse:border-0 coarse:p-0 coarse:ring-1 coarse:ring-inset coarse:ring-line',
        fill ? 'flex w-full' : 'inline-flex',
        className,
      )}
    >
      {segments.map((s) => (
        <button
          key={s.key}
          type="button"
          aria-pressed={s.key === value}
          aria-label={s.name}
          onClick={() => onChange(s.key)}
          className={clsx(
            'relative inline-flex items-center gap-6 whitespace-nowrap rounded-chip px-12 type-small font-medium transition-colors duration-120 ease-hover',
            fill && 'flex-1 justify-center',
            'coarse:h-full coarse:min-w-44 coarse:justify-center coarse:rounded-btn',
            // The ring keeps the picked one visible at night, where --select sits almost on --raised.
            s.key === value ? 'bg-select text-ink ring-1 ring-inset ring-line-strong' : 'text-ink-3 hover:text-ink',
          )}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
