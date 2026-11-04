/**
 * A sheet on Base UI's Drawer (a Dialog with swipe): focus is trapped, Escape
 * closes, and dragging down dismisses (Base UI decides from distance and
 * velocity). Surface --raised, a --scrim backdrop and no shadow. 420 ms open
 * / 260 ms close on --ease-sheet; opacity only with reduced motion
 * (styles/kit.css .sheet-*).
 *
 * Two presentations of the same Drawer (0.12, build plan D9 and 1.10), from
 * the layout's chrome, as `data-present`:
 *
 *   bottom  the phone: a bottom sheet, 10 px top radius and a 36x4 grabber.
 *   form    any wider chrome, either pointer: a form sheet, --sheet-w (540)
 *           wide, near the top (safe top + 48; + 16 while the on-screen
 *           keyboard is up, so the form gets the room), all corners rounded, no
 *           grabber, never taller than the visual viewport, its Save and
 *           Cancel row kept in view at its foot (.sheet-actions).
 *
 * It is one component either way, so a resize across the phone's edge (640 on
 * an iPad, 768 on a Mac) changes classes and never remounts the form inside:
 * what was typed stays. A form sheet with a changed field asks before a scrim
 * tap, Esc, ⌘. or a swipe closes it (it saw an `input` event in its popup);
 * the form's own Cancel and Save close it at once. 0.14.0: a form that knows
 * better (a stepper's − and + and a preset fire no `input` event) says so
 * with `dirty`, which then decides alone. A phone's bottom sheet closes
 * without asking, unless the caller opts in with `discardQuestion` (0.14.0:
 * Switching rules), which asks it at every size. Without a hardware
 * keyboard nothing is focused on open, so the on-screen keyboard stays down
 * until a field is tapped (A9).
 */
import { Drawer } from '@base-ui/react/drawer';
import clsx from 'clsx';
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useLayout } from '../shell/layout.js';
import { Button } from './Button.js';
import { useLayer } from './layer.js';

type PopupProps = ComponentProps<typeof Drawer.Popup>;

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Always given: it names the dialog. */
  title: string;
  /** Hide the visible title row (the name stays for screen readers). */
  hideTitle?: boolean;
  /** Right side of the title row, e.g. a "Done" text button. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Where focus goes on open (default: the first field, else the sheet). */
  initialFocus?: PopupProps['initialFocus'];
  /** Where focus goes on close (default: the trigger, when Base UI opened it). */
  finalFocus?: PopupProps['finalFocus'];
  /**
   * 0.14.0: whether the form has changes not yet saved, from the form itself.
   * Given, it alone decides whether a scrim tap, Esc, ⌘. or a swipe asks
   * first (an edit by tapping − or +, or a preset, fires no `input` event;
   * an edit undone or saved asks nothing). Absent: an `input` event in the
   * popup since it opened, as before.
   */
  dirty?: boolean;
  /**
   * 0.14.0: opt in to asking at every size, the phone's bottom sheet too
   * (by default only a form sheet asks), with this question ("Discard what
   * you changed?"). Absent: the bottom sheet closes at once, as before.
   */
  discardQuestion?: string;
}

/** What closes a form sheet only after asking, once a field changed: everything but the form's own buttons. */
const ASKS = new Set(['outside-press', 'escape-key', 'swipe', 'close-watcher', 'focus-out']);

export function Sheet({ open, onOpenChange, title, hideTitle = false, actions, children, className, initialFocus, finalFocus, dirty, discardQuestion }: SheetProps) {
  const layer = useLayer();
  const { chrome, keyboard, kbUp } = useLayout();
  const form = chrome !== 'phone';
  const present = form ? 'form' : 'bottom';
  const popup = useRef<HTMLDivElement>(null);
  const changed = useRef(false);
  const [asking, setAsking] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  // Each opening starts unchanged.
  useEffect(() => {
    if (open) return;
    changed.current = false;
    setAsking(false);
  }, [open]);
  useEffect(() => {
    if (asking) keep.current?.focus();
  }, [asking]);

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(next, details) => {
        if (!next && (form || discardQuestion !== undefined) && (dirty ?? changed.current) && ASKS.has(details.reason)) {
          details.cancel();
          setAsking(true);
          return;
        }
        onOpenChange(next);
      }}
      swipeDirection="down"
    >
      <Drawer.Portal container={layer}>
        <Drawer.Backdrop className="sheet-backdrop fixed inset-0 bg-scrim" />
        <Drawer.Viewport data-present={present} data-kb={form && kbUp ? '' : undefined} className={clsx('sheet-viewport fixed inset-0 flex justify-center', form ? 'items-start' : 'items-end')}>
          <Drawer.Popup
            ref={popup}
            data-present={present}
            // Without a hardware keyboard, focus the sheet itself: a field would raise the on-screen keyboard over it
            // (unless the caller names where focus goes, as New folder does).
            initialFocus={initialFocus ?? ((type) => (keyboard || type === 'keyboard' ? true : popup.current))}
            finalFocus={finalFocus}
            onInput={() => {
              changed.current = true;
            }}
            className={clsx('sheet-popup bg-raised px-16 text-ink outline-none', form ? '@container/sheet' : 'w-full max-w-560 rounded-t-dock', className)}
          >
            {/* The grabber is the phone's; its slot stays, so the form below keeps its place in the tree. */}
            {form ? null : (
              <div className="flex h-20 items-center justify-center" aria-hidden="true">
                <span className="h-4 w-36 rounded-chip bg-ink-4" />
              </div>
            )}
            <Drawer.Content>
              <div className={clsx('mb-8 mt-4 flex items-center', hideTitle && 'sr-only')}>
                <Drawer.Title className="type-title text-ink">{title}</Drawer.Title>
                {actions ? <div className="ml-auto">{actions}</div> : null}
              </div>
              {asking ? (
                <div role="group" aria-label="Unsaved changes" className="mb-12 flex flex-wrap items-center gap-8 rounded-btn bg-surface px-12 py-8">
                  <span className="mr-auto type-small text-ink">{discardQuestion ?? 'Discard what you typed?'}</span>
                  <Button ref={keep} variant="outline" size="lg" onClick={() => setAsking(false)}>
                    Keep editing
                  </Button>
                  <Button variant="text" size="lg" onClick={() => onOpenChange(false)}>
                    Discard
                  </Button>
                </div>
              ) : null}
              {children}
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
