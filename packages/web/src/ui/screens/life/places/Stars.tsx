/**
 * A dish's rating, 1 to 5 (v0.4 spec 5.6): StarIcon, filled for the
 * rating and outlined after it, all --ink (one meaning: a dish rating).
 * `StarPicker` is the same five stars as a radio group.
 */
import { StarIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useRef, type KeyboardEvent } from 'react';

const FIVE = [1, 2, 3, 4, 5] as const;

export function Stars({ rating, className }: { rating: number; className?: string }) {
  return (
    <span role="img" aria-label={`${rating} of 5`} className={clsx('inline-flex flex-none items-center text-ink', className)}>
      {FIVE.map((n) => (
        <StarIcon key={n} size={12} weight={n <= rating ? 'fill' : 'regular'} aria-hidden="true" />
      ))}
    </span>
  );
}

/**
 * The rating as a radio group (one choice, not five toggles): the stars up
 * to it are filled, the chosen one is checked, and the arrows move the
 * rating with a roving tab stop, as the start sheet's choices do.
 */
export function StarPicker({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const stop = value >= 1 && value <= 5 ? value : 1;
  const onKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = ((stop - 1 + step + 5) % 5) + 1;
    onChange(next);
    refs.current[next - 1]?.focus();
  };
  return (
    <span role="radiogroup" aria-label={label} onKeyDown={onKey} className="inline-flex flex-none items-center">
      {FIVE.map((n) => (
        <button
          key={n}
          ref={(el) => {
            refs.current[n - 1] = el;
          }}
          type="button"
          role="radio"
          aria-label={n === 1 ? '1 star' : `${n} stars`}
          aria-checked={n === value}
          tabIndex={n === stop ? 0 : -1}
          onClick={() => onChange(n)}
          className="inline-flex size-28 items-center justify-center rounded-btn text-ink transition-colors duration-120 ease-hover hover:bg-hover coarse:size-44"
        >
          <StarIcon size={16} weight={n <= value ? 'fill' : 'regular'} aria-hidden="true" />
        </button>
      ))}
    </span>
  );
}
