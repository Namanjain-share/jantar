/**
 * The touch sidebar's ⋯ menu (0.12, ipad-design.md 2.1): Devices (it left
 * the place list), Keyboard shortcuts, the theme, and Reload app (a Home
 * Screen app has no reload of its own). Its own chunk, like the Board's row
 * menu: the Base UI menu loads on the first open, not with the shell.
 */
import { Menu } from '@base-ui/react/menu';
import { useStore } from 'zustand';
import { themeStore, type ThemePref } from '../../lib/theme.js';
import { useNavigate } from '../context.js';
import { useLayer } from '../kit/layer.js';

const ITEM =
  'flex h-44 cursor-pointer select-none items-center gap-12 px-16 type-row text-ink outline-none transition-colors duration-120 ease-hover data-highlighted:bg-select';

const NEXT_THEME: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_WORD: Record<ThemePref, string> = { system: 'Follow the system', light: 'Day', dark: 'Night' };

export function MoreMenu({ anchor, onClose, onShortcuts }: { anchor: HTMLElement; onClose: () => void; onShortcuts: () => void }) {
  const navigate = useNavigate();
  const layer = useLayer();
  const pref = useStore(themeStore, (s) => s.pref);
  const set = useStore(themeStore, (s) => s.set);
  return (
    <Menu.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Menu.Portal container={layer}>
        <Menu.Positioner anchor={anchor} side="top" align="end" sideOffset={8} collisionPadding={12} className="z-30">
          <Menu.Popup aria-label="More" className="min-w-240 rounded-btn bg-raised py-4 text-ink shadow-float outline-none animate-pop">
            <Menu.Item
              className={ITEM}
              onClick={() => {
                onClose();
                navigate('/devices');
              }}
            >
              Devices
            </Menu.Item>
            <Menu.Item
              className={ITEM}
              onClick={() => {
                onClose();
                onShortcuts();
              }}
            >
              Keyboard shortcuts
            </Menu.Item>
            <Menu.Item className={ITEM} closeOnClick={false} onClick={() => set(NEXT_THEME[pref])}>
              Theme: {THEME_WORD[pref]}
            </Menu.Item>
            <Menu.Item className={ITEM} onClick={() => window.location.reload()}>
              Reload app
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
