/**
 * Close, for an item open beside its list (0.12, build plan 1.5): a 44 tall
 * text button with an ×, which puts the list back across the pane (the
 * SplitPane's `onClose`; Esc does the same). Alone in a narrow pane the item
 * keeps its back link instead, so `usePaneClose()` is undefined there.
 *
 * Only lazy screens import this file (it is not in kit/index.ts), so it
 * stays out of the main load.
 */
import { XIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useSplit } from './SplitPane.js';

/** The SplitPane's close while the item is beside its list; undefined when it is alone. */
export function usePaneClose(): (() => void) | undefined {
  const split = useSplit();
  return split?.split ? split.close : undefined;
}

export function PaneClose({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex h-44 flex-none items-center gap-6 rounded-btn px-12 type-small text-ink-2 transition-colors duration-120 ease-hover hover:bg-hover hover:text-ink',
        className,
      )}
    >
      <XIcon size={16} aria-hidden="true" />
      Close
    </button>
  );
}
