/**
 * Phone tabs: 56 px plus the bottom safe area, four or five equal links with
 * a 20 px icon over an 11 px label. Current: --ink; others --ink-3. Up to
 * five places are tabs; with more on, the fifth is More (its badge is the
 * sum of the places it holds).
 */
import clsx from 'clsx';
import type { Route } from '../../lib/router.js';
import { Badge } from '../kit/Badge.js';
import { usePlaceFeatures } from './data.js';
import { Link } from './Link.js';
import { isCurrent, tabItems } from './nav.js';

export function TabBar({ route, badges }: { route: Route['name']; badges: Partial<Record<Route['name'], number>> }) {
  const { tabs, more } = tabItems(usePlaceFeatures());
  return (
    <nav aria-label="Main" className={clsx('pb-safe grid flex-none border-t border-line bg-bg', tabs.length === 5 ? 'grid-cols-5' : 'grid-cols-4')}>
      {tabs.map((item) => {
        const on = isCurrent(item, route, more);
        const n = item.route === 'more' ? more.reduce((sum, m) => sum + (badges[m.route] ?? 0), 0) : (badges[item.route] ?? 0);
        const Icon = item.icon;
        return (
          <Link
            key={item.route}
            href={item.href}
            aria-current={on ? 'page' : undefined}
            className={clsx('relative flex h-56 flex-col items-center justify-center gap-4', on ? 'text-ink' : 'text-ink-3')}
          >
            <Icon size={20} aria-hidden="true" />
            <span className="text-rail font-medium">{item.label}</span>
            <Badge count={n} className="absolute left-1/2 top-4 ml-6" label={`${n} new`} />
          </Link>
        );
      })}
    </nav>
  );
}
