/**
 * The accounts strip (0.11, ipad-design.md 2.1): the touch shell's one view
 * of cswap, at the foot of the sidebar and the rail. "5H USAGE" and the
 * connection over one bar per account, each as tall as its 5-hour %, the
 * active account in mustard. One 44 target that opens Accounts. With one
 * Claude login there is no usage: the words only. Dashed while offline or
 * catching up, as the strip is.
 */
import clsx from 'clsx';
import type { ConnInfo } from '../../store.js';
import { Link } from './Link.js';
import type { UsagePair } from './data.js';

/** The tallest bar, px. */
const BAR_H = 16;

export function Bars({ pairs, active, dashed, thin = false, className }: { pairs: readonly UsagePair[]; active: string | null; dashed: boolean; thin?: boolean; className?: string }) {
  return (
    <span aria-hidden="true" className={clsx('flex h-16 max-w-full items-end overflow-hidden', thin ? 'gap-1' : 'gap-2', className)}>
      {pairs.map((p) => (
        <i
          key={p.id}
          className={clsx('block flex-none', thin ? 'w-4' : 'w-6', dashed ? 'border border-dashed border-ink-3' : p.id === active ? 'bg-jup' : 'bg-ink-2')}
          // CSSOM, which the CSP allows: the height is the account's 5-hour %.
          style={{ height: Math.max(2, Math.round(((p.pct ?? 0) / 100) * BAR_H)) }}
        />
      ))}
    </span>
  );
}

export function connLabel(conn: ConnInfo): string {
  switch (conn.status) {
    case 'live':
    case 'polling':
      return 'Live';
    case 'connecting':
      return 'Catching up';
    case 'offline':
      return 'Reconnecting…';
    case 'unauthorized':
      return 'Not paired';
  }
}

export function AccountsStrip({
  pairs,
  active,
  conn,
  single,
  compact = false,
}: {
  pairs: readonly UsagePair[];
  /** The active account's id ("03"), in mustard. */
  active: string | null;
  conn: ConnInfo;
  single: boolean;
  /** The rail's glance: 64 wide, "5H" over the bars. */
  compact?: boolean;
}) {
  const live = conn.status === 'live' || conn.status === 'polling';
  const dashed = !live;
  const name = single ? `Accounts. ${connLabel(conn)}` : `5-hour usage per account, ${connLabel(conn).toLowerCase()}. Open Accounts`;
  if (compact)
    return (
      <Link href="/accounts" aria-label={name} title={name} className="flex h-52 w-64 flex-none flex-col items-center justify-center gap-4 rounded-btn transition-colors duration-120 ease-hover hover:bg-hover">
        <span className="type-rail text-ink-3">{single ? 'Accts' : '5h'}</span>
        {single ? <i aria-hidden="true" className={clsx('block size-6', live ? 'bg-jup' : 'border border-ink-3')} /> : <Bars pairs={pairs} active={active} dashed={dashed} thin />}
      </Link>
    );
  return (
    <Link href="/accounts" aria-label={name} className="flex min-h-52 min-w-0 flex-1 flex-col justify-center gap-6 rounded-btn px-8 transition-colors duration-120 ease-hover hover:bg-hover">
      <span className="flex items-center gap-12 type-rail text-ink-3">
        <span>{single ? 'Accounts' : '5h usage'}</span>
        <span className="inline-flex items-center gap-6">
          <i aria-hidden="true" className={clsx('block size-6 flex-none', live ? 'bg-jup' : 'border border-ink-3')} />
          {connLabel(conn)}
        </span>
      </span>
      {single ? null : <Bars pairs={pairs} active={active} dashed={dashed} />}
    </Link>
  );
}
