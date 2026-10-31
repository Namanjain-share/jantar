/**
 * More (v0.4): the places past the phone's fifth tab, as a plain list with
 * their icons and badges. Opened from the More tab; on a wider screen the
 * rail lists every place, so nothing links here.
 */
import { CaretRightIcon } from '@phosphor-icons/react';
import { Badge } from '../../kit/Badge.js';
import { useFeatures, useNeedsCount, useNewAlerts } from '../../shell/data.js';
import { Link } from '../../shell/Link.js';
import { tabItems } from '../../shell/nav.js';

export function More() {
  const { more } = tabItems(useFeatures());
  const badges: Partial<Record<string, number>> = { board: useNeedsCount(), alerts: useNewAlerts(false) };
  return (
    <div className="px-16 pb-48 pt-16 animate-enter md:px-32 md:pt-24">
      <h1 data-display className="type-display text-ink">
        More
      </h1>
      {more.length === 0 ? (
        <p className="mt-12 type-small text-ink-2">Every place is a tab.</p>
      ) : (
        <ul className="mt-12 border-t border-line">
          {more.map((item) => {
            const Icon = item.icon;
            const n = badges[item.route] ?? 0;
            return (
              <li key={item.route} className="border-b border-line">
                <Link href={item.href} className="flex h-48 items-center gap-12 transition-colors duration-120 ease-hover hover:bg-hover">
                  <Icon size={20} aria-hidden="true" className="flex-none text-ink-2" />
                  <span className="flex-1 type-row text-ink">{item.label}</span>
                  <Badge count={n} label={`${n} new`} />
                  <CaretRightIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
