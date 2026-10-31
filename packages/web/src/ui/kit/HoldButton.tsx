/**
 * Hold to commit (2.0 s): a fill grows left to right while held; releasing
 * early runs it back in 180 ms. The label swaps to `holdingLabel` while held.
 * Used for "Always allow" and "Revoke". Never ember.
 */
import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import { buttonClass, type ButtonSize, type ButtonVariant } from './Button.js';
import { HOLD_MS, useHold } from './hold.js';

export interface HoldButtonProps {
  children: ReactNode;
  onCommit: () => void;
  holdingLabel?: ReactNode;
  durationMs?: number;
  disabled?: boolean;
  variant?: Exclude<ButtonVariant, 'text'>;
  size?: ButtonSize;
  /** Defaults to "<label>. Hold for 2 seconds" when children is a string. */
  'aria-label'?: string;
  className?: string;
}

export function HoldButton({
  children,
  onCommit,
  holdingLabel = 'Keep holding',
  durationMs = HOLD_MS,
  disabled = false,
  variant = 'outline',
  size = 'md',
  'aria-label': ariaLabel,
  className,
}: HoldButtonProps) {
  const { holding, handlers } = useHold({ onCommit, durationMs, disabled });
  const secs = Math.round((durationMs / 1000) * 10) / 10;
  const name = ariaLabel ?? (typeof children === 'string' ? `${children}. Hold for ${secs} seconds` : undefined);
  return (
    <button
      type="button"
      className={buttonClass(variant, size, clsx('hold isolate overflow-hidden', className))}
      disabled={disabled}
      aria-label={name}
      data-holding={holding ? 'true' : 'false'}
      // Custom properties through the style prop are set with CSSOM, which the CSP allows.
      style={{ '--hold-ms': `${durationMs}ms`, ...(variant === 'primary' ? { '--hold-fill': 'var(--bg)' } : {}) } as CSSProperties}
      {...handlers}
    >
      <span className="hold-fill" aria-hidden="true" />
      <span className="hold-label">{children}</span>
      <span className="hold-label-2" aria-hidden="true">
        {holdingLabel}
      </span>
    </button>
  );
}
