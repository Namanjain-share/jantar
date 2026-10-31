/**
 * Shell frames per width (direction.md 5.0 "Shell layout per breakpoint"):
 *
 *   phone   < 768    header 52 + safe area, content, bottom tabs 56 + safe area
 *   tablet  768-1023 top bar 48, rail 56, full-width ledger; a session opens
 *                    full width with a back button; status bar 24
 *   desk    1024-1279 the same plus ledger column 360 beside the detail pane
 *   wide    >= 1280  ledger column 440
 *
 * Matches the Tailwind breakpoints md / lg / xl in tokens.css. Tests (jsdom,
 * no matchMedia) get the phone frame.
 */
import { useMedia } from '../context.js';

export type Frame = 'phone' | 'tablet' | 'desk' | 'wide';

export const MQ = {
  md: '(min-width: 768px)',
  lg: '(min-width: 1024px)',
  xl: '(min-width: 1280px)',
} as const;

export function useFrame(): Frame {
  const md = useMedia(MQ.md);
  const lg = useMedia(MQ.lg);
  const xl = useMedia(MQ.xl);
  if (xl) return 'wide';
  if (lg) return 'desk';
  if (md) return 'tablet';
  return 'phone';
}

/** Ledger and detail side by side (board + session in one frame). */
export function isSplit(frame: Frame): boolean {
  return frame === 'desk' || frame === 'wide';
}
