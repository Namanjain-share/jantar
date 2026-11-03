/**
 * One value from a short list (0.11, build plan c26 and 1.10; ipad-design.md
 * 3.13): a sort, a filter, a dose. On the phone it is the bottom sheet it
 * always was. At any wider chrome it is a popover beside the control that
 * opened it, --popover-w (320) wide, 44 rows on touch, instead of a 540 form
 * sheet across the screen for one tap.
 *
 * Placed against the visual viewport, so the on-screen keyboard never sits
 * over it: below its anchor while 220 or more is free there, else above it,
 * else (the keyboard leaves no room either way) the form sheet (placeFor).
 * Without a hardware keyboard nothing inside is focused on open (A9): the
 * popup takes the focus, so the keyboard stays down until a field is tapped.
 *
 * Only lazy screens import it (Cafés, Medicines), and Base UI's Popover
 * (ChoicePopup.tsx) loads on the first popover, so neither main nor those
 * screens' first load hold it (code-split.test, perf-chunks).
 */
import { lazy, Suspense, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { useLayout } from '../shell/layout.js';
import { Sheet } from './Sheet.js';

// Base UI's Popover loads on the first popover, not with the screens that may show one (their 1.11 targets).
const ChoicePopup = lazy(() => import('./ChoicePopup.js').then((m) => ({ default: m.ChoicePopup })));

/** A popover needs this much room between its anchor and the visible edge, px. */
export const POPOVER_ROOM = 220;

export type Placement = 'below' | 'above' | 'sheet';

/** Where a popover goes for an anchor at `rect`, in a visual viewport `top` … `top + height` (the keyboard's top). */
export function placeFor(rect: { top: number; bottom: number }, vv: { top: number; height: number }): Placement {
  if (vv.top + vv.height - rect.bottom >= POPOVER_ROOM) return 'below';
  if (rect.top - vv.top >= POPOVER_ROOM) return 'above';
  return 'sheet';
}

/** The visible part of the window: the visual viewport where there is one. */
function visible(win: Window): { top: number; height: number } {
  const vv = win.visualViewport;
  return vv ? { top: vv.offsetTop, height: vv.height } : { top: 0, height: win.innerHeight };
}

export interface ChoiceProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names the popover or the sheet. */
  title: string;
  /** The control that opened it. Without one (a push opened it), the sheet. */
  anchor: RefObject<HTMLElement | null>;
  /** Beside the title (a "Done" text button). */
  actions?: ReactNode;
  children: ReactNode;
}

export function Choice({ open, onOpenChange, title, anchor, actions, children }: ChoiceProps) {
  const { chrome, keyboard } = useLayout();
  // Measured once each time it opens (a popover that hops sides under a finger would lose the tap), and kept while it closes.
  const last = useRef<Placement>('sheet');
  const place = useMemo<Placement>(() => {
    if (!open) return last.current;
    const el = anchor.current;
    return chrome === 'phone' || !el || typeof window === 'undefined' ? 'sheet' : placeFor(el.getBoundingClientRect(), visible(window));
  }, [open, chrome, anchor]);
  last.current = place;

  if (place === 'sheet' || chrome === 'phone') {
    return (
      <Sheet open={open} onOpenChange={onOpenChange} title={title} actions={actions}>
        {children}
      </Sheet>
    );
  }
  return (
    <Suspense fallback={null}>
      <ChoicePopup open={open} onOpenChange={onOpenChange} title={title} anchor={anchor} actions={actions} side={place === 'above' ? 'top' : 'bottom'} keyboard={keyboard}>
        {children}
      </ChoicePopup>
    </Suspense>
  );
}
