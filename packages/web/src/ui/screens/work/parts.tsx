/**
 * 0.13.0 Work: small pieces its client screens share. Chips that wrap, the
 * mark beside words someone else wrote (an import, a meeting's names: shown
 * as data, as Chat frames them), and the Mac-asleep line of W35.
 */
import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { ContactFrom } from '@jantar/protocol/work';
import { isApiError } from '../../../lib/api.js';
import { Tag } from '../../kit/Tag.js';
import { NotSaved } from '../life/shared/states.js';

/**
 * One of a few as chips that wrap (44 on touch): a filter, a log entry's kind, how it went. Narrow phones
 * never scroll sideways, where a segmented control of five would. `clearable`: a second tap clears it.
 */
export function Chips<K extends string>({
  label,
  chips,
  value,
  onChange,
  clearable = false,
  className,
}: {
  label: string;
  chips: readonly { key: K; label: string }[];
  value: K | null;
  onChange: (k: K | null) => void;
  clearable?: boolean;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={clsx('flex flex-wrap gap-8', className)}>
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          aria-pressed={value === c.key}
          onClick={() => onChange(value === c.key && clearable ? null : c.key)}
          className={clsx(
            'inline-flex h-32 items-center rounded-chip border px-12 type-small transition-colors duration-120 ease-hover coarse:h-44',
            value === c.key ? 'border-line-strong bg-select text-ink' : 'border-line text-ink-2 hover:text-ink',
          )}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

/** Who wrote the words, when it isn't him: shown beside them, as Chat frames them. */
export const FROM_LABEL: Record<ContactFrom, string> = { import: 'imported', meeting: 'from a meeting' };

/** "imported", "from a meeting": beside words he didn't write. */
export function FromTag({ from, className }: { from: ContactFrom | undefined; className?: string }) {
  if (!from) return null;
  return (
    <span data-from={from} className={className}>
      <Tag>{FROM_LABEL[from]}</Tag>
    </span>
  );
}

/**
 * Words someone else wrote, as data: a quoted block that says where they came from. Always text (no
 * links, no markup), as Chat frames them for Claude.
 */
export function Framed({ from, children }: { from: ContactFrom | undefined; children: ReactNode }) {
  if (!from) return <>{children}</>;
  return (
    <blockquote data-framed={from} className="border-l-2 border-line-strong pl-8">
      <span className="mb-2 block type-mono text-ink-3">{from === 'import' ? 'From an import' : 'From a meeting'}</span>
      {children}
    </blockquote>
  );
}

/** W35: the Mac couldn't be reached. What he typed stays (drafts), until Jantar closes. */
export const KEPT_HERE = 'Not saved. Kept on this phone until you close Jantar.';

/** A failed save: the W35 line when the Mac couldn't be reached, else the daemon's sentence. */
export function SaveError({ error }: { error: unknown }) {
  if (isApiError(error, 'network'))
    return (
      <p role="alert" className="mt-8 type-small text-signal-text">
        {KEPT_HERE}
      </p>
    );
  return <NotSaved error={error} />;
}
