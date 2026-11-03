/**
 * The touch shell's nav (0.11, build plan c24; ipad-design.md 2.1-2.2): an
 * iPad (a coarse pointer) from 640 wide. Its own chunk (TouchShell): the
 * Mac and the phone never load it, and main.tsx starts loading it before
 * the first render on a touch screen that wide. The Mac keeps its rail, top bar and
 * status bar; the phone its header and tabs.
 *
 *   regular (1024 and up)  the sidebar (Sidebar.tsx), 220, unless folded
 *                          (⌘\ or its button, remembered on this device)
 *   medium, or folded      the labelled rail, 72: the window-controls zone
 *                          (decorative mark), the sidebar button, the places
 *                          (icon over a rail label, 64 x 56), then Jump (⌘K)
 *                          and the accounts glance at its foot. The sidebar
 *                          button shows the sidebar 300 wide over the panes,
 *                          with a scrim (plain markup: a tap on the scrim, a
 *                          place, Esc or ⌘\ closes it); at a regular width it
 *                          unfolds the sidebar instead.
 *
 * Every list follows nav.ts NAV, so the sidebar, the rail and the phone's
 * tabs keep one order (and ⌘1-⌘9 mean the same places at every width).
 */
import { MagnifyingGlassIcon, SidebarSimpleIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { Badge } from '../kit/Badge.js';
import { Mark } from '../kit/Mark.js';
import { AccountsStrip } from './AccountsStrip.js';
import { useKey } from './keys.js';
import { useLayout } from './layout.js';
import { Link } from './Link.js';
import { isCurrent, touchItems } from './nav.js';
import { setFolded, setOverlay, useNav, useSidebar } from './navState.js';
import { Sidebar, type TouchNavProps } from './Sidebar.js';

function TouchRail({ route, badges, needs, features, pairs, active, conn, single, onPalette, onSidebar }: TouchNavProps & { onSidebar: () => void }) {
  const items = touchItems(features);
  return (
    <nav aria-label="Main" className="pt-safe pb-safe pl-safe flex h-full min-h-0 w-72 flex-col items-center border-r border-line bg-page">
      {/* The window controls' corner (80 x 52): only the decorative mark. */}
      <div className="flex h-52 flex-none items-center justify-center">
        <Mark needs={needs > 0} label={null} />
      </div>
      <button
        type="button"
        aria-label="Show sidebar"
        title="Show sidebar (⌘\\)"
        onClick={onSidebar}
        className="flex h-44 w-64 flex-none items-center justify-center rounded-btn text-ink-3 transition-colors duration-120 ease-hover hover:bg-hover hover:text-ink"
      >
        <SidebarSimpleIcon size={20} aria-hidden="true" />
      </button>
      <ul className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto py-8">
        {items.map((item) => {
          const on = isCurrent(item, route);
          const n = badges[item.route] ?? 0;
          const Icon = item.icon;
          return (
            <li key={item.route}>
              <Link
                href={item.href}
                aria-label={item.label}
                aria-current={on ? 'page' : undefined}
                className={clsx(
                  'relative flex h-56 w-64 flex-col items-center justify-center gap-4 rounded-btn transition-colors duration-120 ease-hover',
                  on ? 'rail-tick bg-raised text-ink' : 'text-ink-3 hover:bg-hover hover:text-ink',
                )}
              >
                <Icon size={20} aria-hidden="true" />
                {/* 64 wide: a place's short word where it has one (Accountability partner: "Partner"). */}
                <span aria-hidden="true" className="type-rail">
                  {item.short ?? item.label}
                </span>
                <Badge count={n} className="absolute right-6 top-2" label={`${n} new`} />
              </Link>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        aria-label="Jump to a session"
        title="Jump to a session (⌘K)"
        onClick={onPalette}
        className="flex h-56 w-64 flex-none flex-col items-center justify-center gap-4 rounded-btn text-ink-3 transition-colors duration-120 ease-hover hover:bg-hover hover:text-ink"
      >
        <MagnifyingGlassIcon size={20} aria-hidden="true" />
        <span aria-hidden="true" className="type-rail">
          Jump
        </span>
      </button>
      <div className="flex-none pb-4">
        <AccountsStrip pairs={pairs} active={active} conn={conn} single={single} compact />
      </div>
    </nav>
  );
}

export function TouchNav(props: TouchNavProps) {
  const { size } = useLayout();
  const sidebar = useSidebar();
  const { overlay } = useNav();
  const regular = size === 'regular';
  // The overlay belongs to the rail: gone once the sidebar is in place, and Esc closes it.
  const shown = overlay && !sidebar;
  useKey('Escape', () => setOverlay(false), shown);
  if (sidebar) return <Sidebar {...props} onHide={() => setFolded(true)} />;
  return (
    <>
      <TouchRail {...props} onSidebar={() => (regular ? setFolded(false) : setOverlay(true))} />
      {shown ? (
        <div className="fixed inset-0 z-40 flex">
          <Sidebar {...props} overlay onHide={() => setOverlay(false)} />
          {/* The scrim: a tap anywhere beside the sidebar closes it (its header button is the named control). */}
          <div aria-hidden="true" className="min-w-0 flex-1 bg-scrim animate-fade" onClick={() => setOverlay(false)} />
        </div>
      ) : null}
    </>
  );
}
