/**
 * The touch sidebar (0.12, ipad-design.md 2.1), 220 wide on --page, at a
 * regular width (1024 and up) while it isn't folded, and the same list 300
 * wide over the rail when the rail's sidebar button or ⌘\ opens it.
 *
 *   header   52 below the status bar; its leading 80 x 52 stays free for
 *            the window controls (only the decorative mark sits there);
 *            Hide sidebar (⌘\) at its end
 *   search   "Search or jump": the palette (⌘K)
 *   places   Board, Today (its six places under it, shown or hidden by a
 *            44 caret of its own), Chat, Files, Alerts, Partner (0.12:
 *            Accountability partner, v0.11 People, while it is on); then
 *            the Library label (not a control) and Intel, Meetings; 44
 *            rows, the current one --raised with the ink tick at the left
 *            edge. Only this middle part scrolls.
 *   footer   the accounts strip (opens Accounts) and ⋯ (Devices, Keyboard
 *            shortcuts, the theme, Reload app), above the home indicator
 *
 * Accounts and Devices are not in the list (the strip and ⋯ have them, and
 * ⌘K, ⌘5, ⌘7 and the g chords). Counts are badges only for what needs you
 * (the board) and unseen alerts.
 */
import { CaretDownIcon, CaretRightIcon, DotsThreeIcon, MagnifyingGlassIcon, SidebarSimpleIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { lazy, Suspense, useRef, useState } from 'react';
import type { Features } from '@jantar/protocol';
import type { Route } from '../../lib/router.js';
import type { ConnInfo } from '../../store.js';
import { Badge } from '../kit/Badge.js';
import { Keycap } from '../kit/Keycap.js';
import { Mark } from '../kit/Mark.js';
import { AccountsStrip } from './AccountsStrip.js';
import type { UsagePair } from './data.js';
import { Link } from './Link.js';
import { LIFE } from './life.js';
import { isCurrent, touchItems, type NavItem } from './nav.js';
import { setLifeOpen, useNav } from './navState.js';

const MoreMenu = lazy(() => import('./MoreMenu.js').then((m) => ({ default: m.MoreMenu })));

export interface TouchNavProps {
  route: Route['name'];
  badges: Partial<Record<Route['name'], number>>;
  needs: number;
  features: Readonly<Features>;
  pairs: readonly UsagePair[];
  active: string | null;
  conn: ConnInfo;
  single: boolean;
  onPalette: () => void;
  onShortcuts: () => void;
  /** c32: try the connection again now (the footer's Reconnect while it is down). */
  onReconnect: () => void;
}

const ROW = 'relative flex h-44 min-w-0 items-center gap-12 rounded-btn px-12 transition-colors duration-120 ease-hover';

function Place({
  item,
  route,
  badges,
  indent = false,
  exact = false,
  onGo,
}: {
  item: { route: Route['name']; href: string; label: string; short?: string | undefined; icon: NavItem['icon'] };
  route: Route['name'];
  badges: TouchNavProps['badges'];
  indent?: boolean;
  /** Current only on its own route (Today, while its places are listed under it). */
  exact?: boolean;
  onGo?: (() => void) | undefined;
}) {
  const on = item.route === route || (!exact && isCurrent(item as NavItem, route));
  const n = badges[item.route] ?? 0;
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      // A shorter word where the full one wouldn't fit 220 (Accountability partner: "Partner"); the full one is its name.
      aria-label={item.short ? item.label : undefined}
      aria-current={on ? 'page' : undefined}
      onClick={onGo}
      className={clsx(ROW, 'flex-1', indent && 'pl-32', on ? 'rail-tick bg-raised font-medium text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink')}
    >
      <Icon size={indent ? 18 : 20} aria-hidden="true" className={clsx('flex-none', on ? 'text-ink' : 'text-ink-3')} />
      <span className="min-w-0 flex-1 truncate type-row">{item.short ?? item.label}</span>
      <Badge count={n} label={`${n} new`} />
    </Link>
  );
}

export function Sidebar({
  route,
  badges,
  needs,
  features,
  pairs,
  active,
  conn,
  single,
  onPalette,
  onShortcuts,
  onReconnect,
  overlay = false,
  onHide,
}: TouchNavProps & {
  /** Over the rail (300 wide, with a scrim): its header button closes it. */
  overlay?: boolean;
  /** Hide sidebar (⌘\): fold it to the rail, or close the overlay. */
  onHide: () => void;
}) {
  const { lifeOpen } = useNav();
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const items = touchItems(features);
  const top = items.filter((i) => i.group !== 'library');
  const library = items.filter((i) => i.group === 'library');
  // A tap on a place closes the overlay; the sidebar in place stays.
  const onGo = overlay ? onHide : undefined;
  return (
    <nav
      aria-label={overlay ? 'Sidebar' : 'Main'}
      className={clsx(
        'pt-safe pl-safe flex h-full min-h-0 flex-col bg-page',
        overlay ? 'w-300 shadow-float' : 'w-220 border-r border-line',
      )}
    >
      <div className="flex h-52 flex-none items-center justify-between pl-24 pr-8">
        <Mark needs={needs > 0} label={null} />
        <button
          type="button"
          aria-label={overlay ? 'Close sidebar' : 'Hide sidebar'}
          title={overlay ? 'Close sidebar (⌘\\)' : 'Hide sidebar (⌘\\)'}
          onClick={onHide}
          className="flex size-44 items-center justify-center rounded-btn text-ink-3 transition-colors duration-120 ease-hover hover:bg-hover hover:text-ink"
        >
          <SidebarSimpleIcon size={20} aria-hidden="true" />
        </button>
      </div>
      <div className="flex-none px-8 pb-8">
        <button
          type="button"
          onClick={onPalette}
          className="flex h-44 w-full items-center gap-8 rounded-btn bg-raised px-12 text-left type-row text-ink-3 transition-colors duration-120 ease-hover hover:text-ink"
        >
          <MagnifyingGlassIcon size={18} aria-hidden="true" className="flex-none" />
          <span className="min-w-0 flex-1 truncate">Search or jump</span>
          <Keycap size="sm">⌘K</Keycap>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-8">
        <ul className="flex flex-col gap-2">
          {top.map((item) => (
            <li key={item.route}>
              {item.route === 'today' ? (
                <>
                  <div className="flex items-center">
                    <Place item={item} route={route} badges={badges} exact={lifeOpen} onGo={onGo} />
                    <button
                      type="button"
                      aria-expanded={lifeOpen}
                      aria-label={lifeOpen ? "Hide Today's places" : "Show Today's places"}
                      onClick={() => setLifeOpen(!lifeOpen)}
                      className="flex size-44 flex-none items-center justify-center rounded-btn text-ink-3 transition-colors duration-120 ease-hover hover:bg-hover hover:text-ink"
                    >
                      {lifeOpen ? <CaretDownIcon size={16} aria-hidden="true" /> : <CaretRightIcon size={16} aria-hidden="true" />}
                    </button>
                  </div>
                  {lifeOpen ? (
                    <ul aria-label="Today's places" className="mt-2 flex flex-col gap-2">
                      {LIFE.map((l) => (
                        <li key={l.route} className="flex">
                          <Place item={l} route={route} badges={badges} indent onGo={onGo} />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <div className="flex">
                  <Place item={item} route={route} badges={badges} onGo={onGo} />
                </div>
              )}
            </li>
          ))}
        </ul>
        {library.length ? (
          <>
            <p className="px-12 pb-4 pt-16 type-rail text-ink-3">Library</p>
            <ul className="flex flex-col gap-2">
              {library.map((item) => (
                <li key={item.route} className="flex">
                  <Place item={item} route={route} badges={badges} onGo={onGo} />
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
      {conn.status === 'offline' ? (
        // c32: the connection dropped: say so where LIVE was, with a way to try now.
        <div role="status" className="flex flex-none items-center gap-8 border-t border-line pl-16 pr-8">
          <span className="min-w-0 flex-1 truncate type-small text-ink-2">Reconnecting…</span>
          <button
            type="button"
            onClick={onReconnect}
            className="flex h-44 flex-none items-center rounded-btn px-12 type-small font-medium text-ink transition-colors duration-120 ease-hover hover:bg-hover"
          >
            Reconnect
          </button>
        </div>
      ) : null}
      <div className="pb-safe flex flex-none items-center gap-4 border-t border-line px-8 py-4">
        <AccountsStrip pairs={pairs} active={active} conn={conn} single={single} />
        <button
          ref={more}
          type="button"
          aria-label="More"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((o) => !o)}
          className="flex size-44 flex-none items-center justify-center rounded-btn text-ink-3 transition-colors duration-120 ease-hover hover:bg-hover hover:text-ink"
        >
          <DotsThreeIcon size={20} weight="bold" aria-hidden="true" />
        </button>
        {menu && more.current ? (
          <Suspense fallback={null}>
            <MoreMenu anchor={more.current} onClose={() => setMenu(false)} onShortcuts={onShortcuts} />
          </Suspense>
        ) : null}
      </div>
    </nav>
  );
}
