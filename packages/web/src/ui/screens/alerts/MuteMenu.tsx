/**
 * The Base UI half of the "Mute pushes" menu, split out so it loads with the
 * Alerts screen, not the app shell (see Mute.tsx). A desktop popover: --raised
 * with the one shadow; 44 px items under a coarse pointer.
 */
import { Menu } from '@base-ui/react/menu';
import { CaretDownIcon } from '@phosphor-icons/react';
import { Button } from '../../kit/Button.js';

const ITEM =
  'flex h-32 cursor-pointer select-none items-center px-12 type-small text-ink outline-none transition-colors duration-120 ease-hover ' +
  'data-highlighted:bg-select coarse:h-44';

export interface MuteMenuProps {
  /** Trigger text: "Mute pushes" or "Muted until 18:40". */
  label: string;
  muted: boolean;
  busy: boolean;
  onMute: (minutes: number) => void;
}

export function MuteMenu({ label, muted, busy, onMute }: MuteMenuProps) {
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button size="sm" disabled={busy} />}>
        {label}
        <CaretDownIcon size={12} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} collisionPadding={12} className="z-30">
          <Menu.Popup className="min-w-176 rounded-btn bg-raised py-4 text-ink shadow-float outline-none animate-pop">
            {muted ? (
              <Menu.Item className={ITEM} onClick={() => onMute(0)}>
                Unmute
              </Menu.Item>
            ) : (
              <>
                <Menu.Item className={ITEM} onClick={() => onMute(60)}>
                  Mute 1 hour
                </Menu.Item>
                <Menu.Item className={ITEM} onClick={() => onMute(8 * 60)}>
                  Mute 8 hours
                </Menu.Item>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
