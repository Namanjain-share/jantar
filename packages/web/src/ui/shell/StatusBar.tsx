/**
 * Desktop status bar, 24 px, mono 11.5, --ink-3:
 *
 *   left   live dot (mustard, blinks once per event, never on a timer) and
 *          the link state, cswap's age, then every account's 5h % as
 *          compact pairs ("01 22  02 3 ..."), values at or past the ceiling
 *          in --signal-text. Clicking the pairs opens Accounts. With one
 *          Claude login (v0.4 single mode) there is no cswap and no usage:
 *          the link state only.
 *   right  "New version ready · Reload" when there is one, contextual
 *          keycaps, and "? legend".
 */
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { ago, clock } from '../../lib/format.js';
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
    <footer className="col-span-full row-start-3 flex h-24 min-w-0 items-center gap-12 overflow-hidden whitespace-nowrap border-t border-line pl-16 pr-12 type-mono text-ink-3">
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
            className="inline-flex h-24 min-w-0 items-center gap-12 overflow-hidden rounded-chip px-4 transition duration-120 ease-hover hover:bg-hover"
            aria-label="5-hour usage per account. Open Accounts"
            onClick={onAccounts}
          >
            <span>5h</span>
            {pairs.map((p) => (
              <span key={p.id} className="flex-none">
                {p.id}
                <b className={clsx('ml-4 font-data', pastCeiling(p.pct, ceiling) ? 'text-signal-text' : 'text-ink')}>{p.pct ?? '–'}</b>
              </span>
            ))}
          </button>
        </>
      ) : null}
      <span className="ml-auto flex flex-none items-center gap-12">
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
