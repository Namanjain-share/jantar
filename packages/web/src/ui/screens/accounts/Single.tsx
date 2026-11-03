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
 *
 * 0.11 (build plan 2.9): from a pane of 640 the login is a card at the
 * pane's width (the 640 column is gone), its sessions in columns of at
 * least 280. With one login nothing reads usage, so there is no meter or
 * reset to put beside it. Without a measure (jsdom), 0.10's column.
 */
import { boardOrder } from '@jantar/protocol';
import { useMemo, useRef } from 'react';
import { useApp, useNow } from '../../context.js';
import { useBucket } from '../../kit/Columns.js';
import { SkeletonRows } from '../../kit/Skeleton.js';
import { useLayout } from '../../shell/layout.js';
import { SessionList, sessionCells } from './SessionCells.js';

export const SINGLE_DISPLAY = 'One Claude login';
export const SINGLE_SENTENCE = 'Usage and account moves need cswap (optional).';
/** The account's name when the daemon has not sent it yet (sources/cswap/single.ts calls it Claude). */
const FALLBACK_NAME = 'Claude';

export function sessionsText(n: number): string {
  return n === 0 ? 'No sessions right now' : `${n} session${n === 1 ? '' : 's'}`;
}

export function SingleAccount({ machines = false }: { machines?: boolean } = {}) {
  const phone = useLayout().chrome === 'phone';
  const now = useNow(30_000);
  const state = useApp((s) => s.state);
  const conn = useApp((s) => s.conn);
  // One login: every session of this Mac is on it (a paired machine's are on its own accounts).
  const cells = useMemo(() => sessionCells(state, boardOrder(state).filter((s) => s.node === undefined), now), [state, now]);
  const name = Object.values(state.accounts)[0]?.alias ?? FALLBACK_NAME;
  // A pane of 640 or more: the card (0.11).
  const box = useRef<HTMLDivElement>(null);
  const card = useBucket(box, (w) => w >= 640) && !phone;

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
      <div ref={box}>
        <div className={phone || card ? '' : 'max-w-640'}>
          <header className={phone ? 'border-b border-line px-16 pb-16 pt-4' : card ? 'pb-16' : 'border-b border-line pb-16'}>
            {/* v0.6: once a machine is paired, this is the Mac's section. */}
            {machines ? <p className="mb-4 type-rail text-ink-3">Mac · 1 login</p> : null}
            <p data-display className="type-display text-ink">
              {SINGLE_DISPLAY}
            </p>
            <p className="mt-6 type-small text-ink-2">{SINGLE_SENTENCE}</p>
          </header>
          <ul aria-label="Accounts">
            <li
              data-account="single"
              className={phone ? 'border-b border-line px-16 pb-8 pt-12' : card ? 'rounded-dock border border-line bg-raised pb-4' : 'border-b border-line pb-8 pt-12'}
            >
              <div className={card ? 'flex h-44 items-center gap-12 border-b border-line px-16' : 'flex h-20 items-center gap-12'}>
                <span className="min-w-0 truncate type-row font-medium text-ink">{name}</span>
                <span className="ml-auto flex-none type-mono text-ink-3">{sessionsText(cells.length)}</span>
              </div>
              <div className={phone ? 'mt-4' : 'mt-4 px-16'}>
                <SessionList cells={cells} columns={card} />
              </div>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
