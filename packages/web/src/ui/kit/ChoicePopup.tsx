/** The popover half of kit/Popover.tsx's Choice: Base UI's Popover, loaded on the first one. */
import { Popover } from '@base-ui/react/popover';
import { XIcon } from '@phosphor-icons/react';
import { useRef, type ReactNode, type RefObject } from 'react';
import { IconButton } from './IconButton.js';
import { useLayer } from './layer.js';

export function ChoicePopup({
  open,
  onOpenChange,
  title,
  anchor,
  actions,
  side,
  keyboard,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  anchor: RefObject<HTMLElement | null>;
  actions?: ReactNode;
  side: 'top' | 'bottom';
  /** A hardware keyboard: focus the first control on open; else the popup itself (A9). */
  keyboard: boolean;
  children: ReactNode;
}) {
  const layer = useLayer();
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Popover.Root open={open} onOpenChange={(o) => onOpenChange(o)}>
      <Popover.Portal container={layer}>
        <Popover.Positioner anchor={anchor} side={side} align="start" sideOffset={6} collisionPadding={12} className="z-30">
          <Popover.Popup
            ref={popup}
            data-choice=""
            initialFocus={(type) => (keyboard || type === 'keyboard' ? true : popup.current)}
            finalFocus={anchor}
            className="flex max-h-(--available-height) w-(--popover-w) max-w-full flex-col rounded-dock bg-raised text-ink shadow-float outline-none animate-pop"
          >
            <div className="flex h-52 flex-none items-center gap-8 pl-16 pr-8">
              <Popover.Title className="min-w-0 flex-1 truncate type-title">{title}</Popover.Title>
              {actions}
              <Popover.Close render={<IconButton aria-label={`Close ${title.toLowerCase()}`} className="coarse:size-44" />}>
                <XIcon size={16} />
              </Popover.Close>
            </div>
            <div className="min-h-0 overflow-y-auto px-16">{children}</div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
