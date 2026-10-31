/**
 * Accounts (direction.md 5.3, dir-k.html): usage, resets, burn, moves, held.
 *
 *   display     "1 account runs out before its reset" (one line, no banner)
 *   source      "cswap cache · as of 14:08 · autoswitch ceiling 97% ·
 *               [next → 08] ccw decides while it runs  [Refresh]"; with
 *               no ccw, just "ceiling 97%" (nothing switches accounts)
 *   desktop     the matrix: 5h bar with the ceiling tick, the runway on a
 *               shared now-to-reset axis, 7d, burn, sessions, flags
 *   phone       two-line rows that expand
 *   Moves       lanes for the moves in progress, parked or stuck
 *
 * Sorted by account number; ?sort=headroom puts the most room first. The
 * ceiling comes from /v1/plan, which read-scope devices can see.
 *
 * With one Claude login (v0.4 single-account mode) there is no usage, hold,
 * autoswitch or move to show: accounts/Single.tsx says so instead, with the
 * one account and its sessions.
 */
import { useMemo, useState } from 'react';
import { PRODUCT_NAME } from '../../brand.js';
import { errorText } from '../../lib/api.js';
import { accountId } from '../../lib/format.js';
import { useApp, useDeps, useNavigate, useNow, useToast } from '../context.js';
import { Button } from '../kit/Button.js';
import { EmptyState } from '../kit/EmptyState.js';
import { SkeletonRows } from '../kit/Skeleton.js';
import { Spinner } from '../kit/Spinner.js';
import { Tag } from '../kit/Tag.js';
import { useAccountsMode } from '../shell/data.js';
import { useFrame } from '../shell/layout.js';
import { ceilingOf, usePlan } from './accounts/hooks.js';
import { Matrix } from './accounts/Matrix.js';
import { buildRows, displayLine, LEGACY_TOOL, sortRows, type SortKey } from './accounts/model.js';
import { Moves } from './accounts/Moves.js';
import { PhoneRows } from './accounts/PhoneRows.js';
import { Segmented } from './accounts/Segmented.js';
import { SingleAccount } from './accounts/Single.js';
import { hhmm, searchParam } from './accounts/time.js';

const SORTS = [
  { key: 'id' as const, label: 'Number' },
  { key: 'headroom' as const, label: 'Headroom' },
];

export function Accounts() {
  return useAccountsMode() === 'single' ? <SingleAccount /> : <CswapAccounts />;
}

/** cswap's accounts: usage, resets, burn, holds and moves. */
function CswapAccounts() {
  const { api } = useDeps();
  const toast = useToast();
  const navigate = useNavigate();
  const frame = useFrame();
  const now = useNow(30_000);
  const state = useApp((s) => s.state);
  const conn = useApp((s) => s.conn);
  const plan = usePlan();
  const ceiling = ceilingOf(plan);
  const weeklyCeiling = plan?.weeklyCeiling ?? null;
  const [sort, setSort] = useState<SortKey>(() => (searchParam('/accounts', 'sort') === 'headroom' ? 'headroom' : 'id'));
  // Rows the user opened, and rows that open on their own but were folded.
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  const [folded, setFolded] = useState<ReadonlySet<number>>(() => new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const rows = useMemo(() => buildRows(state, plan, ceiling, now), [state, plan, ceiling, now]);
  const sorted = useMemo(() => sortRows(rows, sort, ceiling), [rows, sort, ceiling]);
  // Only the legacy ccw tool moves sessions between accounts; without it there is no autoswitch to name.
  const legacy = plan?.source === 'ccw-legacy';
  const next = legacy ? plan.next : null;
  const matrix = frame === 'desk' || frame === 'wide';
  const phone = frame === 'phone';

  // In the matrix, an account that runs out before its reset opens with the
  // reason in words (dir-k.html); phone rows already say "full ~17:05".
  const auto = useMemo(() => new Set(matrix ? rows.filter((r) => r.fullAt !== null).map((r) => r.id) : []), [matrix, rows]);
  const open = useMemo<ReadonlySet<number>>(() => new Set([...opened, ...auto].filter((id) => !folded.has(id))), [opened, auto, folded]);
  const toggle = (id: number) => {
    const closing = open.has(id);
    const edit = (add: boolean) => (cur: ReadonlySet<number>) => {
      const s = new Set(cur);
      if (add) s.add(id);
      else s.delete(id);
      return s;
    };
    setOpened(edit(!closing));
    setFolded(edit(closing));
  };

  const changeSort = (k: SortKey) => {
    setSort(k);
    navigate(k === 'headroom' ? '/accounts?sort=headroom' : '/accounts', { replace: true });
  };

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const r = await api.refreshUsage();
      toast(r.queued ? 'Usage refresh asked for' : `Not refreshed: ${r.reason ?? 'try again later'}`, r.queued ? 'ok' : 'info');
    } catch (e) {
      setRefreshError(errorText(e));
    } finally {
      setRefreshing(false);
    }
  };

  const heading = (
    <h1 id="accounts-title" className="sr-only">
      Accounts
    </h1>
  );

  if (!rows.length) {
    const first = state.seq === 0 && conn.status !== 'offline';
    return (
      <section aria-labelledby="accounts-title" className="animate-enter">
        {heading}
        {first ? (
          <SkeletonRows caption="Connecting to the Mac…" />
        ) : (
          <EmptyState title="No accounts yet">
            <p>{PRODUCT_NAME} reads cswap's usage cache. Accounts appear after the first reading.</p>
          </EmptyState>
        )}
      </section>
    );
  }

  const fetchedAt = state.usage.fetchedAt ? Date.parse(state.usage.fetchedAt) : NaN;
  const source = (
    <>
      <span>
        cswap{state.usage.source === 'cache' ? ' cache' : ''} · {Number.isFinite(fetchedAt) ? `as of ${hhmm(fetchedAt)}` : 'no reading yet'}
      </span>
      <span aria-hidden="true">·</span>
      <span>
        {phone || !legacy ? 'ceiling' : 'autoswitch ceiling'} <b className="font-data text-ink-2">{ceiling}%</b>
      </span>
    </>
  );
  const nextNote =
    next !== null ? (
      <span className="inline-flex items-center gap-8">
        <Tag tone="next">next → {accountId(next)}</Tag>
        <span>{LEGACY_TOOL} decides while it runs</span>
      </span>
    ) : null;
  const refreshButton = (
    <Button size="sm" onClick={() => void refresh()} disabled={refreshing}>
      {refreshing ? <Spinner label="Refreshing" /> : null}
      Refresh
    </Button>
  );
  const errorLine = refreshError ? (
    <span role="alert" className="type-small text-signal-text">
      {refreshError}
    </span>
  ) : null;
  const sortControl = <Segmented label="Sort accounts" segments={SORTS} value={sort} onChange={changeSort} />;

  if (phone || !matrix) {
    return (
      <section aria-labelledby="accounts-title" className={phone ? 'pb-24 animate-enter' : 'px-32 pb-32 pt-24 animate-enter'}>
        {heading}
        <div className={phone ? '' : 'max-w-640'}>
          <header className={phone ? 'border-b border-line px-16 pb-16 pt-4' : 'border-b border-line pb-16'}>
            <p data-display className="type-display text-ink">
              {displayLine(rows)}
            </p>
            <p className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-4 type-mono text-ink-3">
              {source}
            </p>
            {nextNote ? <p className="mt-6 flex flex-wrap items-center gap-8 type-mono text-ink-3">{nextNote}</p> : null}
            <div className="mt-12 flex flex-wrap items-center gap-8">
              {refreshButton}
              {sortControl}
            </div>
            {errorLine ? <p className="mt-8">{errorLine}</p> : null}
          </header>
          <PhoneRows
            rows={sorted}
            state={state}
            ceiling={ceiling}
            weeklyCeiling={weeklyCeiling}
            now={now}
            bar={phone ? 200 : 320}
            open={open}
            onToggle={toggle}
          />
          <Moves state={state} now={now} phone legacy={legacy} />
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="accounts-title" className="px-32 pb-32 pt-24 animate-enter">
      {heading}
      <header className="mb-20 max-w-1320">
        <p data-display className="type-display text-ink">
          {displayLine(rows)}
        </p>
        <div className="mt-6 flex min-h-24 flex-wrap items-center gap-x-8 gap-y-4 type-mono text-ink-3">
          {source}
          {nextNote ? (
            <>
              <span aria-hidden="true">·</span>
              {nextNote}
            </>
          ) : null}
          <span className="ml-8 inline-flex">{refreshButton}</span>
          {errorLine}
          <span className="ml-auto inline-flex">{sortControl}</span>
        </div>
      </header>
      <Matrix
        rows={sorted}
        state={state}
        ceiling={ceiling}
        weeklyCeiling={weeklyCeiling}
        now={now}
        wide={frame === 'wide'}
        open={open}
        onToggle={toggle}
      />
      <Moves state={state} now={now} phone={false} legacy={legacy} />
    </section>
  );
}
