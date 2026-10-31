/**
 * The legend. Desktop: a popover above the status bar's "? legend" button
 * (also toggled by "?"), --raised with the one shadow. Phone: a bottom sheet
 * opened by tapping the strip. Both load their Base UI part on first open.
 */
import { lazy, Suspense, useRef, type ReactNode } from 'react';
import { Keycap } from '../kit/Keycap.js';

const LegendPopup = lazy(() => import('./LegendPopup.js').then((m) => ({ default: m.LegendPopup })));
const LegendSheetBody = lazy(() => import('./LegendPopup.js').then((m) => ({ default: m.LegendSheetBody })));

export function LegendPopover({ open, onOpenChange, trigger }: { open: boolean; onOpenChange: (o: boolean) => void; trigger?: ReactNode }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const seen = useRef(false);
  if (open) seen.current = true;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="inline-flex h-24 items-center gap-6 rounded-chip px-4 text-ink-3 transition duration-120 ease-hover hover:text-ink"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Legend"
        onClick={() => onOpenChange(!open)}
      >
        {trigger ?? (
          <>
            <Keycap size="sm">?</Keycap>
            <span>legend</span>
          </>
        )}
      </button>
      {seen.current ? (
        <Suspense fallback={null}>
          <LegendPopup open={open} onOpenChange={onOpenChange} anchor={anchor} />
        </Suspense>
      ) : null}
    </>
  );
}

export function LegendSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const seen = useRef(false);
  if (open) seen.current = true;
  if (!seen.current) return null;
  return (
    <Suspense fallback={null}>
      <LegendSheetBody open={open} onOpenChange={onOpenChange} />
    </Suspense>
  );
}
