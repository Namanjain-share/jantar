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
 */
import { useEffect, useMemo, useState } from 'react';
import { readLocal, writeLocal } from '../../lib/storage.js';
import { useApp, useNavigate, useNow } from '../context.js';
import { RailLabel } from '../kit/RailLabel.js';
import { SkeletonRows } from '../kit/Skeleton.js';
import { useFrame } from '../shell/layout.js';
import { Segmented } from './accounts/Segmented.js';
import { searchParam } from './accounts/time.js';
import { AlertRowDesk, AlertRowPhone } from './alerts/AlertRow.js';
import { Mute } from './alerts/Mute.js';
import { FILTER_FROM, FILTER_LABEL, FILTER_ORDER, actionOf, byDay, parseKind, sentenceOf, subjectOf, type KindFilter } from './alerts/model.js';

/** Remember the newest alert this device has seen (for the tab badge). */
export const ALERTS_SEEN_KEY = 'alerts-seen-ts';

const EMPTY_LINE = 'Limits, API errors, blocked tools and rejected prompts show up here with what happened.';

export function Alerts() {
  const alerts = useApp((s) => s.state.alerts);
  const sessions = useApp((s) => s.state.sessions);
  // First load with nothing cached yet: skeleton rows, not "No alerts".
  const first = useApp((s) => s.state.seq === 0 && s.conn.status !== 'offline');
  const navigate = useNavigate();
  const now = useNow(30_000);
  const phone = useFrame() === 'phone';
  // What was new when the screen opened stays new while it is open.
  const [seenAtOpen] = useState(() => readLocal<string>(ALERTS_SEEN_KEY, ''));
  const [kind, setKind] = useState<KindFilter>(() => parseKind(searchParam('/alerts', 'kind')));
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    let newest = '';
    for (const a of alerts) if (a.ts > newest) newest = a.ts;
    if (newest) writeLocal(ALERTS_SEEN_KEY, newest);
  }, [alerts]);

  const filtering = alerts.length > FILTER_FROM;
  const active: KindFilter = filtering ? kind : 'all';
  const counts = useMemo(() => {
    const c: Record<KindFilter, number> = { all: alerts.length, limit: 0, error: 0, blocked: 0, rejected: 0 };
    for (const a of alerts) c[a.kind] += 1;
    return c;
  }, [alerts]);
  const shown = useMemo(() => (active === 'all' ? alerts : alerts.filter((a) => a.kind === active)), [alerts, active]);
  const days = useMemo(() => byDay(shown, now), [shown, now]);
  const unseen = alerts.filter((a) => a.ts > seenAtOpen).length;
  const display = unseen ? `${unseen} new` : alerts.length ? 'Nothing new' : 'No alerts';

  const changeKind = (k: KindFilter) => {
    setKind(k);
    navigate(k === 'all' ? '/alerts' : `/alerts?kind=${k}`, { replace: true });
  };
  const toggle = (id: string) =>
    setOpen((cur) => {
      const s = new Set(cur);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });

  const filters = filtering ? (
    <Segmented
      label="Filter alerts"
      value={active}
      onChange={changeKind}
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

  const Row = phone ? AlertRowPhone : AlertRowDesk;
  const list = days.length ? (
    days.map((d) => (
      <section key={d.key} aria-label={d.label}>
        <RailLabel ground="bg" inset={phone}>
          {d.label}
        </RailLabel>
        <ul>
          {d.alerts.map((a) => (
            <Row
              key={a.id}
              alert={a}
              subject={subjectOf(a, sessions)}
              sentence={sentenceOf(a)}
              action={actionOf(a, sessions)}
              unseen={a.ts > seenAtOpen}
              open={open.has(a.id)}
              onToggle={() => toggle(a.id)}
            />
          ))}
        </ul>
      </section>
    ))
  ) : alerts.length ? (
    <p className={phone ? 'px-16 py-16 type-small text-ink-3' : 'py-16 type-small text-ink-3'}>Nothing of this kind.</p>
  ) : null;

  return (
    <section aria-labelledby="alerts-title" className={phone ? 'pb-24 animate-enter' : 'px-32 pb-32 pt-24 animate-enter'}>
      <h1 id="alerts-title" className="sr-only">
        Alerts
      </h1>
      <header className={phone ? 'px-16 pb-16 pt-4' : 'mb-20 max-w-1120'}>
        <div className="flex flex-wrap items-center gap-x-16 gap-y-8">
          <p data-display className="type-display text-ink">
            {display}
          </p>
          {!phone && alerts.length ? <p className="type-small text-ink-3">Limits, API errors, blocked tools and rejected prompts</p> : null}
          <span className="ml-auto">
            <Mute />
          </span>
        </div>
        {alerts.length ? null : <p className="mt-6 max-w-560 type-small text-ink-2">{EMPTY_LINE}</p>}
        {filters ? <div className="mt-16">{filters}</div> : null}
      </header>
      <div className={phone ? '' : 'max-w-1120'}>{list}</div>
    </section>
  );
}
