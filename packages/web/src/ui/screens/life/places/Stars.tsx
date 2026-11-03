/**
 * A rating, 1 to 5 (v0.4 spec 5.6): StarIcon, filled for the rating and
 * outlined after it, all --ink (one meaning: a rating; no colour carries
 * it). `StarPicker` is the same five stars as a radio group. v0.10: a
 * café's stars, its sub-ratings, a dish and a visit use it too; its value
 * may be none (`null`), and `ClearRating` is the text button that clears
 * one (in a Field's aside).
 *
 * 0.11 (build plan 2.5, OQ9): `RateStars` sets a café's sub-rating with one
 * tap on its screen.
 */
import { StarIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '../../../kit/Button.js';

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
 * rating with a roving tab stop, as the start sheet's choices do. `null`
 * (or 0) is no rating: nothing is checked and Tab lands on the first star.
 */
export function StarPicker({ value, onChange, label }: { value: number | null; onChange: (n: number) => void; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const v = value ?? 0;
  const stop = v >= 1 && v <= 5 ? v : 1;
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
          aria-checked={n === v}
          tabIndex={n === stop ? 0 : -1}
          onClick={() => onChange(n)}
          className="inline-flex size-28 items-center justify-center rounded-btn text-ink transition-colors duration-120 ease-hover hover:bg-hover coarse:size-44"
        >
          <StarIcon size={16} weight={n <= v ? 'fill' : 'regular'} aria-hidden="true" />
        </button>
      ))}
    </span>
  );
}

/** "Clear" beside a rating that is set (a Field's aside); nothing while none is. */
export function ClearRating({ value, onClear, label }: { value: number | null | undefined; onClear: () => void; label: string }) {
  if (!value) return null;
  return (
    <Button variant="text" size="sm" aria-label={label} onClick={onClear}>
      Clear
    </Button>
  );
}

/**
 * A rating set with one tap (0.11, OQ9): five stars as a radio group. A tap
 * on another value calls `onRate` (the screen sends it, with an Undo); a tap
 * on the value it has does nothing. With a mouse or a trackpad a hover
 * previews the value and never sets it; the arrows move the focus (and the
 * preview), and Return or Space sets it. Each star is a 44 cell on touch.
 * Clearing a rating stays in the café's sheet.
 */
export function RateStars({ value, label, onRate, disabled = false }: { value: number; label: string; onRate: (n: number) => void; disabled?: boolean }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [preview, setPreview] = useState<number | null>(null);
  const shown = preview ?? value;
  const stop = value >= 1 && value <= 5 ? value : 1;
  const onKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = refs.current.findIndex((el) => el === document.activeElement);
    const next = ((Math.max(0, at) + step + 5) % 5) + 1;
    setPreview(next);
    refs.current[next - 1]?.focus();
  };
  return (
    <span
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKey}
      onPointerLeave={() => setPreview(null)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPreview(null);
      }}
      className="-ml-6 inline-flex flex-none items-center"
    >
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
          disabled={disabled}
          onPointerEnter={(e) => {
            if (e.pointerType === 'mouse') setPreview(n);
          }}
          onClick={() => {
            setPreview(null);
            if (n !== value) onRate(n);
          }}
          className="inline-flex size-28 items-center justify-center rounded-btn text-ink transition-colors duration-120 ease-hover hover:bg-hover disabled:text-ink-3 coarse:size-44"
        >
          <StarIcon size={16} weight={n <= shown ? 'fill' : 'regular'} aria-hidden="true" />
        </button>
      ))}
    </span>
  );
}
