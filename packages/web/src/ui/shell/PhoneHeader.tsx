/**
 * Phone header: 52 px below the top safe area. Mark and wordmark on the
 * left, the strip on the right (one tap opens the legend sheet). With no
 * sessions there is no strip to tap: the empty board shows the legend itself.
 */
import { PRODUCT_NAME } from '../../brand.js';
import { Wordmark } from '../kit/Mark.js';
import { Strip, type StripItem } from '../kit/Strip.js';
import { Link } from './Link.js';

export function PhoneHeader({
  needs,
  items,
  dashed,
  onLegend,
  onHome,
}: {
  needs: number;
  items: StripItem[];
  dashed: boolean;
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
        {items.length ? <Strip items={items} dashed={dashed} onLegend={onLegend} className="min-w-0 overflow-hidden" /> : null}
      </div>
    </header>
  );
}
