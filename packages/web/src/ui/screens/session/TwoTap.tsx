/**
 * A button that needs a second tap within `armMs`. The dock uses it when the
 * daemon answers `needs_confirm` (the server-forced arm): `forceArmed` shows
 * the confirm label straight away. Same logic as v0.1's TwoTapButton.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { buttonClass, type ButtonSize, type ButtonVariant } from '../../kit/Button.js';

export function TwoTap({
  children,
  confirmLabel,
  onConfirm,
  disabled,
  armMs = 6000,
  forceArmed = false,
  variant = 'outline',
  size = 'lg',
  className,
}: {
  children: ReactNode;
  confirmLabel: ReactNode;
  onConfirm: () => void;
  disabled?: boolean;
  armMs?: number;
  forceArmed?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    if (forceArmed) setArmed(true);
  }, [forceArmed]);
  const isArmed = armed || forceArmed;
  return (
    <button
      type="button"
      className={buttonClass(variant, size, className)}
      disabled={disabled}
      aria-live="polite"
      data-armed={isArmed ? 'true' : 'false'}
      onClick={() => {
        if (isArmed) {
          setArmed(false);
          if (timer.current) clearTimeout(timer.current);
          onConfirm();
          return;
        }
        setArmed(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setArmed(false), armMs);
      }}
    >
      {isArmed ? confirmLabel : children}
    </button>
  );
}
