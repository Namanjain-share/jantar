/**
 * A Board row's menu (spec 5.3.1), opened by a long press or a right click
 * on the row (Row.tsx) and anchored to it: "New session here", the start
 * form for that session's folder on that session's account (Auto when it
 * has none; a held account still asks first), and (0.13.0, F3) "Open
 * project" for a session inside a project's folder: the project's hub in
 * Work while Work is on, else its Todos screen. The row is a link, so the
 * project chip on it stays a span and the menu is the way to the project.
 * Its own chunk, like MuteMenu: the Base UI menu loads on the first open,
 * not with the shell.
 *
 * The folder is the session's own root (`s.<sid>`), which the Mac resolves
 * while the session is live, so an ended row offers only its project.
 */
import { Menu } from '@base-ui/react/menu';
import { routePath } from '../../../lib/router.js';
import { useNavigate } from '../../context.js';
import type { RowModel } from './model.js';
import { useLayer } from '../../kit/layer.js';

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
  /** "New session here": a session can start in this row's folder. */
  newHere?: boolean;
  /** 0.13.0: the project whose folder holds the session, and where it opens. */
  project?: { name: string; href: string } | undefined;
}

export function RowMenu({ row, anchor, onClose, newHere = true, project }: RowMenuProps) {
  const navigate = useNavigate();
  const layer = useLayer();
  return (
    <Menu.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Menu.Portal container={layer}>
        <Menu.Positioner anchor={anchor} side="bottom" align="end" sideOffset={4} collisionPadding={12} className="z-30">
          <Menu.Popup aria-label={`${row.folder} · ${row.name}`} className="min-w-176 rounded-btn bg-raised py-4 text-ink shadow-float outline-none animate-pop">
            {newHere ? (
              <Menu.Item
                className={ITEM}
                onClick={() => {
                  onClose();
                  navigate(newHereHref(row));
                }}
              >
                New session here
              </Menu.Item>
            ) : null}
            {project ? (
              <Menu.Item
                className={ITEM}
                aria-label={`Open project: ${project.name}`}
                onClick={() => {
                  onClose();
                  navigate(project.href);
                }}
              >
                Open project
              </Menu.Item>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
