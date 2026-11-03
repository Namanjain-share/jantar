/**
 * Alerts (direction.md 5.4, dir-k.html): a timeline ledger of limits, API
 * errors, blocked tools and rejected prompts, newest first under day rails.
 *
 *   display   "3 new" (unseen since the last visit) or "Nothing new"
 *   header    "Mute pushes" menu (Mute 1 hour, Mute 8 hours / Unmute)
 *   filters   All · Limits · Errors · Blocked, only past 20 alerts (?kind=)
 *   rows      time · glyph · subject · what happened · action; rows with a
 *             longer text expand inline to show it on --term
 *
 * Opening the screen marks everything seen (the tab badge reads
 * ALERTS_SEEN_KEY); the rows keep showing what was new when it opened.
 *
 * 0.12 (build plan 2.10): a SplitPane. With nothing open the list takes
 * the pane, and in a pane of 800 or more it is one table across it (the
 * 1120 cap is gone); a row opens the alert beside the list (`?id=`,
 * alerts/AlertDetail.tsx), whose rows become two lines. Below 800, and on a
 * phone, a row expands inline as before. The kind filter is in the route
 * (`?kind=`).
 */
import { ChatButton } from '../shell/ChatButton.js';
import { useEffect, useMemo, useState } from 'react';
import type { Alert } from '@jantar/protocol';
import type { AlertsKind } from '../../lib/router.js';
import { readLocal, writeLocal } from '../../lib/storage.js';
import { useApp, useNavigate, useNow } from '../context.js';
import { RailLabel } from '../kit/RailLabel.js';
import { SkeletonRows } from '../kit/Skeleton.js';
import { SplitPane, useSplit } from '../kit/SplitPane.js';
import { useLayout } from '../shell/layout.js';
import { Segmented } from './accounts/Segmented.js';
import { AlertDetail } from './alerts/AlertDetail.js';
import { AlertRowPhone, AlertRowPick, AlertRowTable } from './alerts/AlertRow.js';
import { Mute } from './alerts/Mute.js';
import { ALERTS_SEEN_KEY, FILTER_FROM, FILTER_LABEL, FILTER_ORDER, actionOf, alertsPath, byDay, parseKind, sentenceOf, subjectOf, type DayGroup, type KindFilter } from './alerts/model.js';

/** Remember the newest alert this device has seen (for the tab badge): kept in alerts/model.ts. */
export { ALERTS_SEEN_KEY } from './alerts/model.js';

const EMPTY_LINE = 'Limits, API errors, blocked tools and rejected prompts show up here with what happened.';

export interface AlertsProps {
  /** ?kind=: the filter (past 20 alerts). */
  kind?: AlertsKind | undefined;
  /** ?id=: the alert open beside the list. */
  id?: string | undefined;
}

export function Alerts({ kind: kindParam, id }: AlertsProps) {
  const alerts = useApp((s) => s.state.alerts);
  const sessions = useApp((s) => s.state.sessions);
  // v0.6: a paired machine's alert names its machine first, as on the Board.
  const nodes = useApp((s) => s.state.nodes);
  // First load with nothing cached yet: skeleton rows, not "No alerts".
  const first = useApp((s) => s.state.seq === 0 && s.conn.status !== 'offline');
  const navigate = useNavigate();
  const now = useNow(30_000);
  // What was new when the screen opened stays new while it is open.
  const [seenAtOpen] = useState(() => readLocal<string>(ALERTS_SEEN_KEY, ''));

  useEffect(() => {
    let newest = '';
    for (const a of alerts) if (a.ts > newest) newest = a.ts;
    if (newest) writeLocal(ALERTS_SEEN_KEY, newest);
  }, [alerts]);

  const filtering = alerts.length > FILTER_FROM;
  const active: KindFilter = filtering ? parseKind(kindParam) : 'all';
  const shown = useMemo(() => (active === 'all' ? alerts : alerts.filter((a) => a.kind === active)), [alerts, active]);
  const days = useMemo(() => byDay(shown, now), [shown, now]);
  // The open alert, while it is in the list (a stale link, or one filtered out, shows the list alone).
  const order = useMemo(() => days.flatMap((d) => d.alerts), [days]);
  const at = id ? order.findIndex((a) => a.id === id) : -1;
  const open = at >= 0 ? order[at]! : null;

  if (first && !alerts.length) {
    return (
      <section aria-labelledby="alerts-title" className="animate-enter">
        <h1 id="alerts-title" className="sr-only">
          Alerts
        </h1>
        <SkeletonRows />
      </section>
    );
  }

  return (
    <SplitPane
      name="alerts"
      list={<AlertsList alerts={alerts} days={days} active={active} seenAtOpen={seenAtOpen} openId={open?.id ?? null} />}
      detail={
        open ? (
          <AlertDetail
            alert={open}
            subject={subjectOf(open, sessions, nodes)}
            sentence={sentenceOf(open)}
            action={actionOf(open, sessions)}
            unseen={open.ts > seenAtOpen}
            listHref={alertsPath(active)}
            hrefOf={(x) => alertsPath(active, x)}
            prev={order[at - 1] ?? null}
            next={order[at + 1] ?? null}
          />
        ) : null
      }
      selection={open?.id}
      empty="fill"
      listLabel="All alerts"
      detailLabel="Alert"
      onClose={() => navigate(alertsPath(active), { replace: true })}
    />
  );
}

/**
 * The list: the display line, Mute pushes and the kind filters, then the
 * day groups. Its rows by the pane (0.12): a table across a wide pane with
 * nothing open, two-line rows that open their alert beside an open one, and
 * two-line rows that expand inline on a phone or in a pane too narrow for
 * an alert beside the list.
 */
function AlertsList({ alerts, days, active, seenAtOpen, openId }: { alerts: readonly Alert[]; days: DayGroup[]; active: KindFilter; seenAtOpen: string; openId: string | null }) {
  const sessions = useApp((s) => s.state.sessions);
  const nodes = useApp((s) => s.state.nodes);
  const navigate = useNavigate();
  const phone = useLayout().chrome === 'phone';
  const split = useSplit();
  const mode = phone || !split?.split ? 'expand' : split.selected ? 'pick' : 'table';
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const counts = useMemo(() => {
    const c: Record<KindFilter, number> = { all: alerts.length, limit: 0, error: 0, blocked: 0, rejected: 0 };
    for (const a of alerts) c[a.kind] += 1;
    return c;
  }, [alerts]);
  const unseen = alerts.filter((a) => a.ts > seenAtOpen).length;
  const display = unseen ? `${unseen} new` : alerts.length ? 'Nothing new' : 'No alerts';
  const toggle = (id: string) =>
    setExpanded((cur) => {
      const s = new Set(cur);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });

  const filters =
    alerts.length > FILTER_FROM ? (
      <Segmented
        label="Filter alerts"
        value={active}
        onChange={(k) => navigate(alertsPath(k), { replace: true })}
        segments={FILTER_ORDER.filter((k) => k === 'all' || k === active || counts[k] > 0).map((k) => ({
          key: k,
          name: `${FILTER_LABEL[k]} ${counts[k]}`,
          label: (
            <>
              {FILTER_LABEL[k]}
              <span className="type-mono text-ink-3">{counts[k]}</span>
            </>
          ),
        }))}
      />
    ) : null;

  const row = (a: Alert) => {
    const props = { alert: a, subject: subjectOf(a, sessions, nodes), sentence: sentenceOf(a), action: actionOf(a, sessions), unseen: a.ts > seenAtOpen };
    if (mode === 'table') return <AlertRowTable key={a.id} {...props} href={alertsPath(active, a.id)} />;
    if (mode === 'pick') return <AlertRowPick key={a.id} {...props} href={alertsPath(active, a.id)} selected={a.id === openId} />;
    return <AlertRowPhone key={a.id} {...props} open={expanded.has(a.id)} onToggle={() => toggle(a.id)} />;
  };

  const groups = days.map((d) => (
    <section key={d.key} aria-label={d.label}>
      <RailLabel ground={mode === 'table' ? 'surface' : mode === 'pick' ? 'surface' : 'bg'} sticky={mode !== 'table'}>
        {d.label}
      </RailLabel>
      <ul>{d.alerts.map(row)}</ul>
    </section>
  ));
  const list = days.length ? (
    mode === 'table' ? (
      // One table across the pane, on its own ground.
      <div className="overflow-hidden rounded-dock border border-line bg-raised">{groups}</div>
    ) : (
      groups
    )
  ) : alerts.length ? (
    <p className="px-16 py-16 type-small text-ink-3">Nothing of this kind.</p>
  ) : null;

  const wide = mode === 'table';
  return (
    <section aria-labelledby="alerts-title" className={wide ? 'px-16 pb-32 pt-24 animate-enter desk:px-24' : 'pb-24 animate-enter'}>
      <h1 id="alerts-title" className="sr-only">
        Alerts
      </h1>
      <header className={wide ? 'mb-20' : phone ? 'px-16 pb-16 pt-4' : 'px-16 pb-16 pt-16 desk:pt-24'}>
        <div className="flex flex-wrap items-center gap-x-16 gap-y-8">
          <p data-display className="type-display text-ink">
            {display}
          </p>
          {wide && alerts.length ? <p className="type-small text-ink-3">Limits, API errors, blocked tools and rejected prompts</p> : null}
          <span className="ml-auto flex items-center gap-8">
            <Mute />
            <ChatButton where="pane" />
          </span>
        </div>
        {alerts.length ? null : <p className="mt-6 max-w-560 type-small text-ink-2">{EMPTY_LINE}</p>}
        {filters ? <div className="mt-16">{filters}</div> : null}
      </header>
      {list}
    </section>
  );
}
