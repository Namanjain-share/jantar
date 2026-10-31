/**
 * Keyboard (desktop, direction.md 5.9). The shell owns the global keys:
 * Cmd/Ctrl-K (palette), ? (legend) and the "g b / g a / g l / g d" jumps.
 * Screens add their own (j/k, Enter, a, d, r, 1-9) with useKey, which skips
 * keys typed into fields and keys with modifiers.
 */
import { useEffect, useRef } from 'react';

/** True when the key went to a text field, where single letters are typing. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return Boolean(el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

/** Call `fn` on a plain key press (no modifiers, not while typing). */
export function useKey(key: string | readonly string[], fn: (e: KeyboardEvent) => void, enabled = true): void {
  const cb = useRef(fn);
  cb.current = fn;
  const keys = typeof key === 'string' ? [key] : key;
  const sig = keys.join('\u0000');
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const list = sig.split('\u0000');
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (list.includes(e.key)) cb.current(e);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [sig, enabled]);
}

export const G_ROUTES: Record<string, string> = { b: '/', a: '/accounts', l: '/alerts', d: '/devices' };

export function useGlobalKeys({
  enabled,
  onPalette,
  onLegend,
  navigate,
}: {
  enabled: boolean;
  onPalette: () => void;
  onLegend: () => void;
  navigate: (to: string) => void;
}): void {
  const h = useRef({ onPalette, onLegend, navigate });
  h.current = { onPalette, onLegend, navigate };
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    let gAt = 0;
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        h.current.onPalette();
        return;
      }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (gAt && Date.now() - gAt < 900) {
        gAt = 0;
        const to = G_ROUTES[e.key];
        if (to) {
          e.preventDefault();
          h.current.navigate(to);
        }
        return;
      }
      if (e.key === 'g') {
        gAt = Date.now();
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        h.current.onLegend();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [enabled]);
}
