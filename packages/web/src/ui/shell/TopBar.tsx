/**
 * Desktop top bar, 48 px: the mark in the rail's 56 px column, the wordmark,
 * the strip, a quiet count, and "Cmd-K Jump to a session" on the right.
 * No connection pill: the status bar carries liveness.
 */
import { PRODUCT_NAME } from '../../brand.js';
import { Keycap } from '../kit/Keycap.js';
import { Mark } from '../kit/Mark.js';
import { Strip, type StripItem } from '../kit/Strip.js';
import { Link } from './Link.js';

export function TopBar({
  needs,
  items,
  accounts,
  known,
  dashed,
  onOpen,
  onPalette,
  onHome,
}: {
  needs: number;
  items: StripItem[];
  accounts: number;
  /** Whether the app has heard from the Mac yet (live, or a cached state); no count before that. */
  known: boolean;
  dashed: boolean;
  onOpen: (sid: string) => void;
  onPalette: () => void;
  /** Also retries the connection, like tapping the brand always has. */
  onHome?: () => void;
}) {
  return (
    <header className="col-span-full row-start-1 flex h-48 min-w-0 items-center border-b border-line">
      <Link href="/" onClick={onHome} className="flex h-47 w-56 flex-none items-center justify-center" aria-label={`${PRODUCT_NAME}: board`}>
        <Mark needs={needs > 0} label={null} />
      </Link>
      <span className="mr-24 flex-none type-word text-ink" aria-hidden="true">
        {PRODUCT_NAME}
      </span>
      <Strip items={items} dashed={dashed} onOpen={onOpen} />
      {known ? (
        <span className="ml-16 hidden truncate type-mono text-ink-3 xl:inline">
          {items.length} {items.length === 1 ? 'session' : 'sessions'} · {accounts} {accounts === 1 ? 'account' : 'accounts'}
        </span>
      ) : null}
      <button
        type="button"
        className="ml-auto mr-12 flex h-32 flex-none items-center gap-8 rounded-btn pl-6 pr-8 text-small text-ink-3 transition duration-120 ease-hover hover:bg-hover hover:text-ink"
        onClick={onPalette}
      >
        <Keycap>⌘K</Keycap>
        <span>Jump to a session</span>
      </button>
    </header>
  );
}
