/**
 * Phone header: 52 px below the top safe area. Mark and wordmark on the
 * left, the strip on the right (one tap opens the legend sheet). With no
 * sessions there is no strip to tap: the empty board shows the legend itself.
 * v0.5.3: while the Intel shelf is on, a magnifier after the strip opened
 * the shelf with its search box focused (/intel?focus=search). 0.13.0 (F1):
 * the magnifier is on every phone screen and opens the search sheet (the
 * palette: clients, projects, todos, meetings, sessions, Intel, cafés and
 * posts, each while its part is on), whose last row is still "Search Intel
 * only".
 */
import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { PRODUCT_NAME } from '../../brand.js';
import { Wordmark } from '../kit/Mark.js';
import { Strip, type StripItem } from '../kit/Strip.js';
import { Link } from './Link.js';

export function PhoneHeader({
  needs,
  items,
  dashed,
  onSearch,
  onLegend,
  onHome,
}: {
  needs: number;
  items: StripItem[];
  dashed: boolean;
  /** 0.13.0: the magnifier opens the search sheet. */
  onSearch?: () => void;
  onLegend: () => void;
  /** Also retries the connection, like tapping the brand always has. */
  onHome?: () => void;
}) {
  return (
    <header className="pt-safe flex-none bg-bg">
      <div className="flex h-52 items-center justify-between gap-16 px-16">
        <Link href="/" onClick={onHome} aria-label={`${PRODUCT_NAME}: board`} className="flex h-44 items-center">
          <Wordmark needs={needs > 0} />
        </Link>
        <div className="flex min-w-0 items-center gap-4">
          {items.length ? <Strip items={items} dashed={dashed} onLegend={onLegend} className="min-w-0 overflow-hidden" /> : null}
          {onSearch ? (
            <button
              type="button"
              onClick={onSearch}
              aria-label="Search"
              title="Search"
              className="-mr-12 flex size-44 flex-none items-center justify-center rounded-btn text-ink-3 transition-colors duration-120 ease-hover hover:text-ink"
            >
              <MagnifyingGlassIcon size={20} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
