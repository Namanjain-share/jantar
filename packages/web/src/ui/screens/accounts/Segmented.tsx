/**
 * A small segmented control (dir-k.html .b-seg): a 32 px hairline box of
 * toggle buttons, the pressed one on --select. Used for the Accounts sort and
 * the Alerts kind filter. 44 px under a coarse pointer, and so is each
 * segment's hit area.
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
      className={clsx('h-32 flex-none rounded-btn border border-line p-2 coarse:h-44', fill ? 'flex w-full' : 'inline-flex', className)}
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
            // 38 px inside the 44 px box on touch: the hit area takes in the padding and border.
            'coarse:before:absolute coarse:before:inset-x-0 coarse:before:-inset-y-3',
            s.key === value ? 'bg-select text-ink' : 'text-ink-3 hover:text-ink',
          )}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
