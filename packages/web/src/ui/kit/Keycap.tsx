/**
 * A keyboard hint: mono 11 px in a 3 px-radius box. Shown in the status bar,
 * the Cmd-K footer and next to dock actions. 0.11: only once a hardware
 * keyboard has been seen (shell/layout.ts `keyboard`: a Mac from the start,
 * an iPad after its first key press), at any width; nothing otherwise, so
 * no caller has to ask.
 */
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useLayout } from '../shell/layout.js';

export function Keycap({ children, size = 'md', className }: { children: ReactNode; size?: 'sm' | 'md'; className?: string }) {
  if (!useLayout().keyboard) return null;
  return (
    <kbd
      className={clsx(
        'inline-flex flex-none items-center justify-center rounded-chip border border-line-strong type-key text-ink-2',
        size === 'sm' ? 'h-16 min-w-16 px-3' : 'h-18 min-w-18 px-4',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** "j k move · ↵ open": keycaps and words, separated by middots; nothing without a keyboard. */
export function KeyHints({ hints, className }: { hints: { keys: string[]; label: string }[]; className?: string }) {
  if (!useLayout().keyboard) return null;
  return (
    <span className={clsx('inline-flex items-center gap-6 text-ink-3', className)}>
      {hints.map((h, i) => (
        <span key={h.label} className="inline-flex items-center gap-6">
          {i > 0 ? (
            <span className="mx-4" aria-hidden="true">
              ·
            </span>
          ) : null}
          {h.keys.map((k) => (
            <Keycap key={k} size="sm">
              {k}
            </Keycap>
          ))}
          <span>{h.label}</span>
        </span>
      ))}
    </span>
  );
}
