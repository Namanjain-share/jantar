/**
 * The Base UI half of the mode chip (ModeChip.tsx), split out so it loads
 * with the first chip, not the app shell. A radio list in Claude's cycle
 * order; each row has the mode and one line on what it does, or, for a
 * mode this session does not have, why it is greyed. The current mode's
 * square is filled (the glyph language, not a colour).
 */
import { Menu } from '@base-ui/react/menu';
import { CaretDownIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import type { PermissionModeName } from '@jantar/protocol';
import { Spinner } from '../../../kit/Spinner.js';
import { CHIP, MENU_ITEM, MENU_POPUP } from './look.js';
import { MODE_CHOICES, MODE_HINT, modeLabel } from './modes.js';

export interface ModeMenuProps {
  label: string;
  ariaLabel: string;
  current: string | undefined;
  busy: boolean;
  disabled: boolean;
  unavailable: ReadonlyMap<PermissionModeName, string>;
  onPick: (mode: PermissionModeName) => void;
}

export function ModeMenu({ label, ariaLabel, current, busy, disabled, unavailable, onPick }: ModeMenuProps) {
  return (
    <Menu.Root>
      <Menu.Trigger className={CHIP} disabled={disabled} aria-label={ariaLabel}>
        <span className="truncate">{label}</span>
        {busy ? <Spinner label="Switching the mode" /> : <CaretDownIcon size={12} aria-hidden="true" />}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={6} collisionPadding={12} className="z-30">
          <Menu.Popup className={MENU_POPUP} aria-label="Permission modes">
            <Menu.RadioGroup value={current ?? null} onValueChange={(v: PermissionModeName) => onPick(v)}>
              {MODE_CHOICES.map((mode) => {
                const why = unavailable.get(mode);
                return (
                  <Menu.RadioItem key={mode} value={mode} label={modeLabel(mode)} disabled={why !== undefined} closeOnClick className={clsx(MENU_ITEM, 'items-start')}>
                    <span aria-hidden="true" className={clsx('mt-6 size-8 flex-none border', mode === current ? 'border-ink bg-ink' : 'border-ink-3')} />
                    <span className="min-w-0">
                      <span className="block font-medium">{modeLabel(mode)}</span>
                      <span className="block text-ink-3">{why ?? MODE_HINT[mode]}</span>
                    </span>
                  </Menu.RadioItem>
                );
              })}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
