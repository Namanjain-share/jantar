/**
 * Small pieces the dock cards share: the command box on --term (at most six
 * lines until expanded), a tool field, the inline error and offline lines,
 * and the action row that stacks on a phone.
 */
import clsx from 'clsx';
import { useState, type ReactNode } from 'react';
import type { ToolField } from '../../../lib/describe.js';

const CLAMP_LINES = 6;
const CLAMP_CHARS = 480;

/** A command or code in a --term box (the real terminal's colours in both themes). */
export function CmdBox({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.split('\n').length > CLAMP_LINES || text.length > CLAMP_CHARS;
  return (
    <div className={className}>
      <pre
        className={clsx(
          'no-scrollbar overflow-x-auto whitespace-pre-wrap rounded-btn bg-term px-14 py-10 type-code text-term-ink wrap-break-word',
          long && !open && 'line-clamp-6',
        )}
      >
        {text}
      </pre>
      {long ? (
        <button
          type="button"
          className="mt-4 h-24 rounded-chip type-small text-ink-2 transition-colors duration-120 hover:text-ink coarse:h-44"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : `Show all ${text.split('\n').length} lines`}
        </button>
      ) : null}
    </div>
  );
}

/** One field of a tool call: code in a --term box, text as a labelled line. */
export function FieldView({ f }: { f: ToolField }) {
  if (f.code) {
    return (
      <div className="mt-12">
        {f.label !== 'Command' ? <p className="mb-4 type-mono text-ink-3">{f.label}</p> : null}
        <CmdBox text={f.text} />
      </div>
    );
  }
  return (
    <p className="mt-8 flex min-w-0 items-baseline gap-8">
      <span className="flex-none type-small text-ink-3">{f.label}</span>
      <span className="min-w-0 type-mono text-ink-2 wrap-anywhere">{f.text}</span>
    </p>
  );
}

/** An action's error, inline under the controls (direction.md 5.6). */
export function InlineError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-12 type-small text-signal-text">
      {error}
    </p>
  );
}

export function OfflineLine({ offline }: { offline: boolean }) {
  if (!offline) return null;
  return <p className="mt-12 type-mono text-ink-3">Offline: can't send right now</p>;
}

/** The dock's action row: one line on desktop, a stack or a two-column grid on a phone. */
export function Actions({ phone, layout = 'row', children, className }: { phone: boolean; layout?: 'row' | 'stack' | 'grid'; children: ReactNode; className?: string }) {
  return (
    <div
      className={clsx(
        'mt-16',
        !phone && 'flex flex-wrap items-center gap-8',
        phone && layout === 'grid' && 'grid grid-cols-2 gap-8',
        phone && layout === 'stack' && 'flex flex-col gap-8',
        phone && layout === 'row' && 'flex items-center gap-8',
        className,
      )}
    >
      {children}
    </div>
  );
}
