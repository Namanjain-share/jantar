/**
 * Desktop rail, 56 px: 40 px icon links (Board, Today while Life is on,
 * Files while it is on, Accounts, Alerts, Devices, Intel while the shelf is
 * on; every place, no More) and the palette at the bottom. Current: --ink
 * icon and a 2 px --ink tick on the left edge (.rail-tick). Count badges are
 * ember.
 */
import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import type { Route } from '../../lib/router.js';
import { Badge } from '../kit/Badge.js';
import { usePlaceFeatures } from './data.js';
import { Link } from './Link.js';
import { isCurrent, navItems } from './nav.js';

export function Rail({ route, badges, onPalette }: { route: Route['name']; badges: Partial<Record<Route['name'], number>>; onPalette: () => void }) {
  const items = navItems(usePlaceFeatures());
  return (
    <nav aria-label="Main" className="col-start-1 row-start-2 flex flex-col items-center gap-4 border-r border-line py-8">
      {items.map((item) => {
        const on = isCurrent(item, route);
        const n = badges[item.route] ?? 0;
        const Icon = item.icon;
        return (
          <Link
            key={item.route}
            href={item.href}
            aria-label={item.label}
            aria-current={on ? 'page' : undefined}
            title={item.label}
            className={clsx(
              'relative flex size-40 items-center justify-center rounded-btn transition duration-120 ease-hover hover:bg-hover hover:text-ink',
              on ? 'rail-tick text-ink' : 'text-ink-3',
            )}
          >
            <Icon size={20} aria-hidden="true" />
            <Badge count={n} className="absolute right-0 top-2" label={`${n} new`} />
          </Link>
        );
      })}
      <button
        type="button"
        className="mt-auto flex size-40 items-center justify-center rounded-btn text-ink-3 transition duration-120 ease-hover hover:bg-hover hover:text-ink"
        aria-label="Jump to a session"
        title="Jump to a session (⌘K)"
        onClick={onPalette}
      >
        <MagnifyingGlassIcon size={20} aria-hidden="true" />
      </button>
    </nav>
  );
}
