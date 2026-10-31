/**
 * Small pieces the Devices and Pair screens share: the property row, the
 * square switch, the theme radios, the "now" mark, inline results and the
 * copy helper. Kit tokens only (styles/tokens.css); no colour literals.
 */
import clsx from 'clsx';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { CheckIcon } from '@phosphor-icons/react';
import type { Scope } from '@jantar/protocol';
import { themeStore, type ThemePref } from '../../../lib/theme.js';
import { hhmm } from '../accounts/time.js';

/** A label column (128 px on desktop, a line of its own on phones) and its value. */
export function PropRow({ label, children, aside, below, className }: { label: ReactNode; children: ReactNode; aside?: ReactNode; below?: ReactNode; className?: string }) {
  return (
    <div className={clsx('border-b border-line py-12 md:py-8', className)}>
      <div className="flex flex-col gap-8 md:min-h-32 md:flex-row md:items-center md:gap-16">
        <div className="type-small text-ink-3 md:w-128 md:flex-none">{label}</div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-12 gap-y-8">{children}</div>
        {aside ? <div className="-mx-8 flex flex-wrap items-center md:mx-0 md:ml-auto md:justify-end">{aside}</div> : null}
      </div>
      {below ? <div className="mt-12 md:ml-144">{below}</div> : null}
    </div>
  );
}

/**
 * An on/off switch: a native checkbox (Space toggles, the label clicks it)
 * drawn as a 28x16 box with an 8 px square knob, the glyph shape. On is an
 * --ink fill. Locked switches stay on and read as disabled.
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
  id,
  label,
  describedBy,
}: {
  checked: boolean;
  onChange?: (on: boolean) => void;
  disabled?: boolean;
  id?: string;
  /** Only when no <label> names it. */
  label?: string;
  describedBy?: string;
}) {
  return (
    <span className="relative inline-flex flex-none">
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        aria-describedby={describedBy}
        onChange={(e) => onChange?.(e.target.checked)}
        className="peer absolute inset-0 m-0 size-full cursor-pointer appearance-none opacity-0 disabled:cursor-default"
      />
      <span
        aria-hidden="true"
        className={clsx(
          'pointer-events-none relative block h-16 w-28 rounded-chip border border-line-strong bg-bg transition-colors duration-120 ease-hover',
          'before:absolute before:left-3 before:top-3 before:size-8 before:bg-ink-3 before:transition-transform before:duration-120 before:ease-out',
          'peer-checked:border-ink peer-checked:bg-ink peer-checked:before:translate-x-12 peer-checked:before:bg-bg',
          'peer-disabled:peer-checked:border-ink-3 peer-disabled:peer-checked:bg-ink-3',
          'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink',
        )}
      />
    </span>
  );
}

const THEMES: { v: ThemePref; label: string }[] = [
  { v: 'system', label: 'System' },
  { v: 'light', label: 'Light' },
  { v: 'dark', label: 'Dark' },
];

/** System / Light / Dark as one radio group (arrow keys move and pick), drawn as a segmented control. */
export function ThemeRadios() {
  const pref = useStore(themeStore, (s) => s.pref);
  const set = useStore(themeStore, (s) => s.set);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = THEMES.findIndex((t) => t.v === pref);
    const next = (at + step + THEMES.length) % THEMES.length;
    const t = THEMES[next];
    if (!t) return;
    set(t.v);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Theme" onKeyDown={onKey} className="inline-flex h-32 items-center gap-2 rounded-btn border border-line p-2 coarse:h-50">
      {THEMES.map((t, i) => {
        const on = pref === t.v;
        return (
          <button
            key={t.v}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => set(t.v)}
            className={clsx(
              'h-26 rounded-chip px-12 type-small font-medium transition-colors duration-120 ease-hover coarse:h-44 coarse:px-16',
              // The same segmented look as Transcript | Screen and the Accounts sort.
              on ? 'bg-select text-ink' : 'text-ink-3 hover:text-ink',
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** The mustard "now" mark (Jupiter marks time): a 6 px square and the word. */
export function NowMark({ className }: { className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-6 type-mono text-jup-text', className)}>
      <i className="block size-6 flex-none bg-jup" aria-hidden="true" />
      now
    </span>
  );
}

/** A quiet result line ("Notifications are on"), announced politely. */
export function Receipt({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="status" className={clsx('flex items-center gap-6 type-small text-ink-2', className)}>
      <CheckIcon size={16} aria-hidden="true" className="flex-none text-ink" />
      {children}
    </p>
  );
}

/** An error that belongs to a control: inline under it, in --signal-text. */
export function InlineError({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" className={clsx('type-small text-signal-text', className)}>
      {children}
    </p>
  );
}

/** A terminal command in a mono box: what to type on the Mac. */
export function CommandBox({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={clsx('inline-flex h-40 items-center rounded-btn border border-line-strong bg-surface px-12 type-code text-ink', className)}>{children}</code>;
}

/** Copy text to the clipboard; false where the browser refuses (plain http). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A value that switches back after `ms` ("Copied" -> "Copy"). */
export function useFlash<T>(rest: T, ms = 2000): [T, (v: T) => void] {
  const [v, setV] = useState(rest);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return [
    v,
    (next: T) => {
      setV(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setV(rest), ms);
    },
  ];
}

/** "Oct 21" in the reader's locale. */
export function shortDate(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
}

/** "18:40", 24-hour on every locale (accounts/time.ts). */
export function shortTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? hhmm(t) : '';
}

/** What each scope lets a paired device do. */
export const SCOPE_TEXT: Record<Scope, string> = {
  read: 'See sessions and usage',
  control: 'Answer and send prompts',
  launch: 'Start sessions and make folders',
  admin: 'Change settings and devices',
};

/** A numbered step: the numeral in a 28 px mono box (square, like the glyphs). */
export function StepNumber({ n }: { n: number }) {
  return (
    <span aria-hidden="true" className="flex size-28 flex-none items-center justify-center rounded-chip border border-line-strong type-mono text-ink">
      {n}
    </span>
  );
}
