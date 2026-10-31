/**
 * Hold-to-commit timing for HoldButton ("Always allow", "Revoke"): press and
 * hold for `durationMs`; letting go early cancels. Pointer and keyboard
 * (Space/Enter held) both work. A safety timer, so it is kept with reduced
 * motion too.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';

export const HOLD_MS = 2000;

export interface HoldHandlers {
  onPointerDown(e: PointerEvent<HTMLElement>): void;
  onPointerUp(): void;
  onPointerLeave(): void;
  onPointerCancel(): void;
  onKeyDown(e: KeyboardEvent<HTMLElement>): void;
  onKeyUp(e: KeyboardEvent<HTMLElement>): void;
  onClick(e: MouseEvent<HTMLElement>): void;
  onContextMenu(e: MouseEvent<HTMLElement>): void;
}

export function useHold({ onCommit, durationMs = HOLD_MS, disabled = false }: { onCommit: () => void; durationMs?: number; disabled?: boolean }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setHolding(false);
  }, []);

  const start = useCallback(() => {
    if (disabled || timer.current) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      commit.current();
    }, durationMs);
  }, [disabled, durationMs]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  useEffect(() => {
    if (disabled) cancel();
  }, [disabled, cancel]);

  const isKey = (k: string) => k === ' ' || k === 'Enter';
  const handlers: HoldHandlers = {
    onPointerDown(e) {
      if (e.button > 0) return;
      e.preventDefault();
      start();
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onKeyDown(e) {
      if (!isKey(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) start();
    },
    onKeyUp(e) {
      if (isKey(e.key)) cancel();
    },
    // A click alone never commits.
    onClick(e) {
      e.preventDefault();
    },
    onContextMenu(e) {
      e.preventDefault();
    },
  };
  return { holding, handlers, cancel };
}
