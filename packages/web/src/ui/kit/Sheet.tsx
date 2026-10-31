/**
 * A phone bottom sheet on Base UI's Drawer (a Dialog with swipe): focus is
 * trapped, Escape closes, and dragging down dismisses (Base UI decides from
 * distance and velocity). Surface --raised with a 10 px top radius, a 36x4
 * grabber, a --scrim backdrop and no shadow. 420 ms open / 260 ms close on
 * --ease-sheet; opacity only with reduced motion (styles/kit.css .sheet-*).
 */
import { Drawer } from '@base-ui/react/drawer';
import clsx from 'clsx';
import type { ReactNode } from 'react';

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
}

export function Sheet({ open, onOpenChange, title, hideTitle = false, actions, children, className }: SheetProps) {
  return (
    <Drawer.Root open={open} onOpenChange={(next) => onOpenChange(next)} swipeDirection="down">
      <Drawer.Portal>
        <Drawer.Backdrop className="sheet-backdrop fixed inset-0 bg-scrim" />
        <Drawer.Viewport className="fixed inset-0 flex items-end justify-center">
          <Drawer.Popup className={clsx('sheet-popup w-full max-w-560 rounded-t-dock bg-raised px-16 text-ink outline-none', className)}>
            <div className="flex h-20 items-center justify-center" aria-hidden="true">
              <span className="h-4 w-36 rounded-chip bg-ink-4" />
            </div>
            <Drawer.Content>
              <div className={clsx('mb-8 mt-4 flex items-center', hideTitle && 'sr-only')}>
                <Drawer.Title className="type-title text-ink">{title}</Drawer.Title>
                {actions ? <div className="ml-auto">{actions}</div> : null}
              </div>
              {children}
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
