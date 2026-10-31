/** The legend's Base UI parts, split out so they load on first open (see LegendPopover.tsx). */
import { Popover } from '@base-ui/react/popover';
import { XIcon } from '@phosphor-icons/react';
import type { RefObject } from 'react';
import { Button } from '../kit/Button.js';
import { IconButton } from '../kit/IconButton.js';
import { LEGEND_TITLE, Legend } from '../kit/Legend.js';
import { Sheet } from '../kit/Sheet.js';

export function LegendPopup({ open, onOpenChange, anchor }: { open: boolean; onOpenChange: (o: boolean) => void; anchor: RefObject<HTMLButtonElement | null> }) {
  return (
    <Popover.Root open={open} onOpenChange={(o) => onOpenChange(o)}>
      <Popover.Portal>
        <Popover.Positioner anchor={anchor} side="top" align="end" sideOffset={8} collisionPadding={12} className="z-30">
          <Popover.Popup finalFocus={anchor} className="w-400 rounded-dock bg-raised px-20 pb-12 pt-16 text-ink shadow-float outline-none animate-pop">
            <div className="mb-8 flex items-center">
              <Popover.Title className="type-title">{LEGEND_TITLE}</Popover.Title>
              <Popover.Close render={<IconButton aria-label="Close the legend" className="ml-auto" />}>
                <XIcon size={16} aria-hidden="true" />
              </Popover.Close>
            </div>
            <Legend />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function LegendSheetBody({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={LEGEND_TITLE}
      actions={
        <Button variant="text" size="lg" className="-mr-8" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      }
    >
      <Legend />
    </Sheet>
  );
}
