/**
 * Accounts on a Mac with one Claude login (accountsMode "single", spec 4.11).
 * Without cswap nothing reads usage, holds, autoswitch or moves, so none of
 * them shows: one line says so, then the one account and its sessions as
 * 44 px links, in board order.
 *
 *   One Claude login
 *   Usage and account moves need cswap (optional).
 *   ─────────────────────────────────────────────
 *   Claude                              2 sessions
 *   ■ web-app  fix login redirect
 *   □ docs     changelog
 */
import { boardOrder } from '@jantar/protocol';
import { useMemo } from 'react';
import { useApp, useNow } from '../../context.js';
import { SkeletonRows } from '../../kit/Skeleton.js';
import { useFrame } from '../../shell/layout.js';
import { SessionList, sessionCells } from './SessionCells.js';

export const SINGLE_DISPLAY = 'One Claude login';
export const SINGLE_SENTENCE = 'Usage and account moves need cswap (optional).';
/** The account's name when the daemon has not sent it yet (sources/cswap/single.ts calls it Claude). */
const FALLBACK_NAME = 'Claude';

export function sessionsText(n: number): string {
  return n === 0 ? 'No sessions right now' : `${n} session${n === 1 ? '' : 's'}`;
}

export function SingleAccount() {
  const frame = useFrame();
  const now = useNow(30_000);
  const state = useApp((s) => s.state);
  const conn = useApp((s) => s.conn);
  const phone = frame === 'phone';
  // One login: every session is on it.
  const cells = useMemo(() => sessionCells(state, boardOrder(state), now), [state, now]);
  const name = Object.values(state.accounts)[0]?.alias ?? FALLBACK_NAME;

  const heading = (
    <h1 id="accounts-title" className="sr-only">
      Accounts
    </h1>
  );
  if (state.seq === 0 && conn.status !== 'offline') {
    return (
      <section aria-labelledby="accounts-title" className="animate-enter">
        {heading}
        <SkeletonRows caption="Connecting to the Mac…" />
      </section>
    );
  }
  return (
    <section aria-labelledby="accounts-title" className={phone ? 'pb-24 animate-enter' : 'px-32 pb-32 pt-24 animate-enter'}>
      {heading}
      <div className={phone ? '' : 'max-w-640'}>
        <header className={phone ? 'border-b border-line px-16 pb-16 pt-4' : 'border-b border-line pb-16'}>
          <p data-display className="type-display text-ink">
            {SINGLE_DISPLAY}
          </p>
          <p className="mt-6 type-small text-ink-2">{SINGLE_SENTENCE}</p>
        </header>
        <ul aria-label="Accounts">
          <li data-account="single" className={phone ? 'border-b border-line px-16 pb-8 pt-12' : 'border-b border-line pb-8 pt-12'}>
            <div className="flex h-20 items-center gap-12">
              <span className="min-w-0 truncate type-row font-medium text-ink">{name}</span>
              <span className="ml-auto flex-none type-mono text-ink-3">{sessionsText(cells.length)}</span>
            </div>
            <div className={phone ? 'mt-4' : 'mt-4 px-16'}>
              <SessionList cells={cells} />
            </div>
          </li>
        </ul>
      </div>
    </section>
  );
}
