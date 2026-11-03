/**
 * Keyboard (direction.md 5.9; 0.11, build plan 3.1). The shell owns the
 * global keys; screens add their own (j/k, Enter, a, d, r, 1-9) with useKey,
 * which skips keys typed into fields and keys with modifiers.
 *
 * 0.11: keys work at every width once a hardware keyboard has been seen
 * (shell/layout.ts `keyboard`: a Mac from the start, an iPad once
 * lib/input.ts has seen one), not only from 768 px.
 *
 *   ⌘K           the palette (⌃K too, but only outside a field: on Apple
 *                platforms ⌃K deletes to the end of the line)
 *   ⌘1 … ⌘9      the places in nav order, fixed: Board, Today, Chat, Files,
 *                Accounts, Alerts, Devices, Intel, Meetings (a place that is
 *                off says so; matched on event.code, like every digit with a
 *                modifier: ⌥1 types ¡ on Apple layouts)
 *   ⌘.           Esc, for keyboards without one (the iPad's system Escape)
 *   g then b t c l a d i m f   Board, Today, Chat, Alerts, Accounts,
 *                Devices, Intel, Meetings, Files
 *   ?            the legend
 *
 * In a text field only ⌘K, ⌘1-⌘9, ⌘. and Esc reach the shell (and, from
 * c24 and c28, ⌘\ and ⌘J); everything a field uses stays with the field:
 * ⌘A, ⌘C, ⌘V, ⌘X, ⌘Z, ⌘ or ⌥ with an arrow, ⌘⌫ and every ⌃ chord.
 */
import { useEffect, useRef } from 'react';

/** True when the key went to a text field, where single letters are typing. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return Boolean(el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

/**
 * The digit a key with a modifier means, from `event.code` (Digit1, Numpad1),
 * since `event.key` is whatever the layout types: ⌥1 is ¡ on a Mac.
 */
export function digitOf(e: Pick<KeyboardEvent, 'code' | 'key'>): number | null {
  const m = /^(?:Digit|Numpad)(\d)$/.exec(e.code ?? '');
  if (m) return Number(m[1]);
  return /^\d$/.test(e.key) ? Number(e.key) : null;
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

/** The g chords: g then a letter. */
export const G_ROUTES: Record<string, string> = {
  b: '/',
  t: '/today',
  c: '/chat',
  l: '/alerts',
  a: '/accounts',
  d: '/devices',
  i: '/intel',
  m: '/meetings',
  f: '/files',
};

/**
 * Esc for ⌘.: the same keydown a real Esc sends, to the same element, so
 * every sheet, menu, popover and pane that closes on Esc closes on ⌘. too.
 */
function escapeFrom(target: EventTarget | null): void {
  const el = target instanceof Element ? target : document.activeElement ?? document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
}

export function useGlobalKeys({
  enabled,
  onPalette,
  onLegend,
  navigate,
  onPlace,
}: {
  enabled: boolean;
  onPalette: () => void;
  onLegend: () => void;
  navigate: (to: string) => void;
  /** ⌘1 … ⌘9: the place with that number in nav order (shell/nav.ts). */
  onPlace?: (n: number) => void;
}): void {
  const h = useRef({ onPalette, onLegend, navigate, onPlace });
  h.current = { onPalette, onLegend, navigate, onPlace };
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    let gAt = 0;
    const on = (e: KeyboardEvent) => {
      const typing = isTyping(e.target);
      const k = e.key.toLowerCase();
      // ⌘K anywhere; ⌃K only outside a field (it deletes to the end of the line there).
      if (!e.altKey && k === 'k' && (e.metaKey || (e.ctrlKey && !typing))) {
        e.preventDefault();
        h.current.onPalette();
        return;
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === '.') {
          e.preventDefault();
          escapeFrom(e.target);
          return;
        }
        const n = digitOf(e);
        if (n !== null && n >= 1 && h.current.onPlace) {
          e.preventDefault();
          h.current.onPlace(n);
          return;
        }
      }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing) return;
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
