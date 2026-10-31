/**
 * The session pane's own keys (direction.md 5.9): a allow / send answer /
 * approve, d deny, r focus the composer, n next. They act only when focus is
 * in the session pane (or nowhere), never while typing, never with a dialog
 * open, and never as the second key of the shell's "g a" jump (the shell's
 * listener runs after this one, so the g is tracked here too).
 */
import { createContext, useContext, useEffect, useRef, type RefObject } from 'react';
import { isTyping } from '../../shell/keys.js';

export const PaneRoot = createContext<RefObject<HTMLElement | null> | null>(null);

export function usePaneKeys(map: Record<string, () => void>, enabled = true): void {
  const root = useContext(PaneRoot);
  const handlers = useRef(map);
  handlers.current = map;
  const sig = Object.keys(map).sort().join(',');
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    let gAt = 0;
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === 'g') {
        gAt = Date.now();
        return;
      }
      const afterG = gAt > 0 && Date.now() - gAt < 900;
      gAt = 0;
      if (afterG || e.repeat) return;
      const fn = handlers.current[e.key];
      if (!fn) return;
      const target = e.target instanceof Node ? e.target : null;
      const pane = root?.current;
      const inPane = !target || target === document.body || target === document.documentElement || !pane || pane.contains(target);
      if (!inPane) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [enabled, sig, root]);
}
