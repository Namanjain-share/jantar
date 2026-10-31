/**
 * The only loop in the app: one 4 px square stepping over three places
 * (steps(3), 600 ms), and only while a request is in flight. It appears after
 * 150 ms and stays at least 300 ms. Never put it over data you already have.
 * With reduced motion it stands still.
 */
import clsx from 'clsx';
import { useDelayedFlag } from './delay.js';

export interface SpinnerProps {
  /** Whether the request is in flight (default true: mount it while waiting). */
  active?: boolean;
  label?: string;
  delayMs?: number;
  minMs?: number;
  className?: string;
}

export function Spinner({ active = true, label = 'Loading', delayMs = 150, minMs = 300, className }: SpinnerProps) {
  const shown = useDelayedFlag(active, delayMs, minMs);
  if (!shown) return null;
  return (
    <span role="status" aria-label={label} className={clsx('spinner relative inline-block h-4 w-16 flex-none', className)}>
      <i className="spinner-step absolute left-0 top-0 size-4 bg-ink" />
    </span>
  );
}
