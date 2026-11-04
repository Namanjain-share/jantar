/**
 * Desktop status bar, 24 px, mono 11.5, --ink-3:
 *
 *   left   live dot (mustard, blinks once per event, never on a timer) and
 *          the link state, cswap's age, then every account's 5h % as
 *          compact pairs ("01 22  02 3 ..."), values at or past the ceiling
 *          in --signal-text (0.14.0: "02 no limit" for an account with no
 *          5-hour limit, named in full on hover, never 0). Clicking the pairs opens Accounts. With one
 *          Claude login (v0.4 single mode) there is no cswap and no usage:
 *          the link state only.
 *   right  "New version ready · Reload" when there is one, contextual
 *          keycaps, and "? legend".
 *
 * 0.12: the grid row is 24 plus the bottom safe area, and the bar pads it,
 * so on an iPad nothing sits over the home indicator.
 *
 * 0.12.0: the bar keeps the window's resize corner (its bottom-right
 * 24 x 24) free with any pointer: it pads its right side (pr-corner), and
 * only the left side shrinks and clips when the text is wider than the bar
 * (another font, a long link state), so "? legend" stays clear of it. The
 * right group (update notice, key hints, legend) does not shrink yet: if it
 * alone is wider than the bar (a narrow window, very large text and the
 * update notice), it still overflows into the padding.
 */
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { NO_FIVE_HOUR_LIMIT, NO_LIMIT_SHORT, ago, clock } from '../../lib/format.js';
import type { Route } from '../../lib/router.js';
import type { ConnInfo } from '../../store.js';
import { KeyHints } from '../kit/Keycap.js';
import { pastCeiling } from '../kit/meterMath.js';
import type { UsagePair } from './data.js';

export function connWord(conn: ConnInfo, now: number): string {
  switch (conn.status) {
    case 'live':
      return 'live';
    case 'polling':
      return 'polling';
    case 'connecting':
      return conn.lastOkAt ? `catching up · last ${clock(new Date(conn.lastOkAt).toISOString(), now)}` : 'connecting';
    case 'offline':
      return conn.lastOkAt ? `offline · showing ${clock(new Date(conn.lastOkAt).toISOString(), now)}` : 'offline';
    case 'unauthorized':
      return 'not paired';
  }
}

type Hint = { keys: string[]; label: string };

const HINTS: Partial<Record<Route['name'], Hint[]>> = {
  board: [
    { keys: ['j', 'k'], label: 'move' },
    { keys: ['↵'], label: 'open' },
  ],
  session: [
    { keys: ['j', 'k'], label: 'move' },
    { keys: ['esc'], label: 'desk' },
  ],
};
const OTHER_HINTS: Hint[] = [{ keys: ['g', 'b'], label: 'board' }];

/** The status bar's keycaps for this screen; on the board, "1–3 waiting" while anything needs you. */
export function hintsFor(route: Route['name'], needs: number): Hint[] {
  const base = HINTS[route] ?? OTHER_HINTS;
  if (route !== 'board' || needs <= 0) return base;
  const n = Math.min(needs, 9);
  return [...base, { keys: [n === 1 ? '1' : `1–${n}`], label: 'waiting' }];
}

export function StatusBar({
  conn,
  seq,
  now,
  fetchedAt,
  pairs,
  ceiling,
  route,
  needs = 0,
  updateAvailable,
  onAccounts,
  legend,
  single = false,
}: {
  conn: ConnInfo;
  seq: number;
  now: number;
  fetchedAt: string | null;
  pairs: UsagePair[];
  ceiling: number;
  route: Route['name'];
  /** Sessions that need you, for the "1–3 waiting" hint. */
  needs?: number;
  updateAvailable: boolean;
  onAccounts: () => void;
  legend: ReactNode;
  /** One Claude login (accounts mode single): no cswap age, no usage pairs. */
  single?: boolean;
}) {
  const live = conn.status === 'live' || conn.status === 'polling';
  return (
    <footer className="pb-safe pr-corner col-span-full row-start-3 flex h-full min-w-0 items-center gap-12 overflow-hidden whitespace-nowrap border-t border-line pl-16 type-mono text-ink-3">
      {/* The left side: it shrinks and clips, never the right one. */}
      <span className="flex h-full min-w-0 flex-1 items-center gap-12 overflow-hidden">
        <span className="inline-flex flex-none items-center gap-8 text-ink-2" role="status" aria-live="polite" aria-label="Connection">
          {/* Remounts on every event, so the blink plays once per event. */}
          <i key={seq} aria-hidden="true" className={clsx('block size-6 flex-none', live ? 'bg-jup animate-blink' : 'border border-ink-3')} />
          <span>{connWord(conn, now)}</span>
        </span>
        {single ? null : (
          <>
            <span aria-hidden="true">·</span>
            <span className="flex-none">cswap {fetchedAt ? ago(fetchedAt, now) || 'now' : '–'}</span>
          </>
        )}
        {pairs.length && !single ? (
          <>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              className="inline-flex h-full min-w-0 items-center gap-12 overflow-hidden rounded-chip px-4 transition duration-120 ease-hover hover:bg-hover"
              aria-label="5-hour usage per account. Open Accounts"
              onClick={onAccounts}
            >
              <span>5h</span>
              {pairs.map((p) => (
                <span key={p.id} className="flex-none" title={p.noLimit ? `${p.id}: ${NO_FIVE_HOUR_LIMIT}` : undefined}>
                  {p.id}
                  {/* 0.14.0: no 5-hour limit: said, named in full on hover, never 0. */}
                  <b className={clsx('ml-4 font-data', p.noLimit ? 'text-ink-3' : pastCeiling(p.pct, ceiling) ? 'text-signal-text' : 'text-ink')}>
                    {p.noLimit ? NO_LIMIT_SHORT : (p.pct ?? '–')}
                  </b>
                </span>
              ))}
            </button>
          </>
        ) : null}
      </span>
      <span className="flex flex-none items-center gap-12">
        {updateAvailable ? (
          <span className="inline-flex items-center gap-6 text-ink-2">
            New version ready ·
            <button type="button" className="rounded-chip text-ink underline underline-offset-3" onClick={() => window.location.reload()}>
              Reload
            </button>
          </span>
        ) : null}
        <KeyHints hints={hintsFor(route, needs)} />
        <span aria-hidden="true">·</span>
        {legend}
      </span>
    </footer>
  );
}
