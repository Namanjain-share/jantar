/**
 * A place's own scroll box (0.12, build plan 1.5). The shell keys one per
 * place, so a place opens at its own scroll, never the last place's; it is a
 * query container (@container/pane), so what is in it lays out by its width;
 * and its scroll is kept per place (usePaneScroll), so coming back to a place
 * puts it where it was.
 *
 * usePaneScroll keeps a scroll box's scrollTop by key in a module Map: saved
 * on scroll (passive, once a frame), put back when the box mounts again (a
 * place reopened, a SplitPane slot shown again). Content that arrives later (a
 * lazy screen, data) is waited for a few frames, until a wheel or a touch.
 */
import clsx from 'clsx';
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { useLayout } from '../shell/layout.js';
import { useRows } from './rows.js';

const memory = new Map<string, number>();

/** The kept scroll of `key` (tests, and SplitPane's slots). */
export function paneScroll(key: string): number {
  return memory.get(key) ?? 0;
}

export function usePaneScroll(ref: RefObject<HTMLElement | null>, key: string, active = true): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const want = memory.get(key) ?? 0;
    let touched = false;
    let frames = 0;
    let restoring = 0;
    const restore = () => {
      restoring = 0;
      if (touched) return;
      if (el.scrollTop !== want) el.scrollTop = want;
      if (Math.abs(el.scrollTop - want) > 1 && ++frames < 30) restoring = requestAnimationFrame(restore);
    };
    if (want > 0) restore();
    let saving = 0;
    const save = () => {
      if (saving) return;
      saving = requestAnimationFrame(() => {
        saving = 0;
        memory.set(key, el.scrollTop);
      });
    };
    const stop = () => {
      touched = true;
    };
    const opts = { passive: true } as const;
    el.addEventListener('scroll', save, opts);
    el.addEventListener('wheel', stop, opts);
    el.addEventListener('touchstart', stop, opts);
    return () => {
      if (saving) memory.set(key, el.scrollTop);
      cancelAnimationFrame(saving);
      cancelAnimationFrame(restoring);
      el.removeEventListener('scroll', save);
      el.removeEventListener('wheel', stop);
      el.removeEventListener('touchstart', stop);
    };
  }, [ref, key, active]);
}

/** One place's scroll box: key it by the place (`<Pane key={name} name={name}>`). */
export function Pane({ name, children, className }: { name: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  usePaneScroll(ref, name);
  // 0.12 (c30): the place's rows by keyboard (a SplitPane in it keeps its list's own).
  useRows(ref, useLayout().keyboard);
  return (
    <div ref={ref} data-pane={name} className={clsx('@container/pane h-full min-h-0 overflow-y-auto', className)}>
      {children}
    </div>
  );
}
