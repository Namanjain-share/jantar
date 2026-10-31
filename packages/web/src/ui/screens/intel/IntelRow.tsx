/**
 * One row of the shelf (v0.4 spec 5.8): the title, then "type · source ·
 * date" in mono --ink-3, then two lines of what it is in --ink-2. The whole
 * row opens the item page; links open only from there.
 */
import type { IntelListItem } from '@jantar/protocol';
import { Link } from '../../shell/Link.js';
import { shelfDate, shelfPath, type ShelfFilters } from './model.js';

export function IntelRow({ item, filters, now }: { item: IntelListItem; filters: ShelfFilters; now: number }) {
  const meta = [item.type, item.source, shelfDate(item.at, now)].filter(Boolean).join(' · ');
  return (
    <li className="border-b border-line">
      <Link
        href={shelfPath(filters, item.id)}
        className="block px-16 py-10 transition-colors duration-120 ease-hover hover:bg-hover focus-visible:-outline-offset-2"
      >
        <p className="line-clamp-3 break-words type-row font-medium text-ink">{item.title}</p>
        <p className="mt-2 truncate type-mono text-ink-3">{meta}</p>
        {item.summary ? <p className="mt-2 line-clamp-2 break-words type-small text-ink-2">{item.summary}</p> : null}
      </Link>
    </li>
  );
}
