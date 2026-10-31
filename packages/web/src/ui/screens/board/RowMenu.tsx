/**
 * A Board row's menu (spec 5.3.1), opened by a long press or a right click
 * on the row (Row.tsx) and anchored to it. One item for now: "New session
 * here", the start form for that session's folder on that session's account
 * (Auto when it has none; a held account still asks first). Its own chunk,
 * like MuteMenu: the Base UI menu loads on the first open, not with the
 * shell.
 *
 * The folder is the session's own root (`s.<sid>`), which the Mac resolves
 * while the session is live, so ended rows have no menu.
 */
import { Menu } from '@base-ui/react/menu';
import { routePath } from '../../../lib/router.js';
import { useNavigate } from '../../context.js';
import type { RowModel } from './model.js';

const ITEM =
  'flex h-32 cursor-pointer select-none items-center px-12 type-small text-ink outline-none transition-colors duration-120 ease-hover ' +
  'data-highlighted:bg-select coarse:h-44';

/** Where "New session here" goes: the start form for the session's folder, on its account. */
export function newHereHref(row: Pick<RowModel, 'sid' | 'session'>): string {
  const account = row.session.account;
  return routePath({ name: 'new', root: `s.${row.sid}`, start: true, ...(account !== null ? { account } : {}) });
}

export interface RowMenuProps {
  row: RowModel;
  anchor: HTMLElement;
  onClose: () => void;
}

export function RowMenu({ row, anchor, onClose }: RowMenuProps) {
  const navigate = useNavigate();
  return (
    <Menu.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="end" sideOffset={4} collisionPadding={12} className="z-30">
          <Menu.Popup aria-label={`${row.folder} · ${row.name}`} className="min-w-176 rounded-btn bg-raised py-4 text-ink shadow-float outline-none animate-pop">
            <Menu.Item
              className={ITEM}
              onClick={() => {
                onClose();
                navigate(newHereHref(row));
              }}
            >
              New session here
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
