/**
 * Accounts on a phone (and tablet): two-line rows, tap to expand
 * (direction.md 5.3, dir-k.html .p-ar).
 *
 *   03 team                               81 5h
 *   ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▯┊▯     in 12m · 14:20
 *   ──────●━━━━━━━━━━━━━━━   +30%/h  (or "full ~14:16")
 *
 * The expanded row adds the runway in words, the 7d bar and reset, scoped
 * windows, every flag and the sessions as 44 px links. `muted` (an offline
 * server's last readings): the name and % in ink-3, the bar stale.
 */
import type { State } from '@jantar/protocol';
import clsx from 'clsx';
import { windowLabel } from '../../../lib/format.js';
import { Meter } from '../../kit/Meter.js';
import { Tag } from '../../kit/Tag.js';
import { Sentence } from './Matrix.js';
import { burnText, resetIn, runwaySentence, type AccountRow } from './model.js';
import { Runway } from './Runway.js';
import { SessionList, sessionCells } from './SessionCells.js';
import { dayClock, hhmm } from './time.js';

export function PhoneRows({
  rows,
  state,
  ceiling,
  weeklyCeiling,
  now,
  bar,
  open,
  onToggle,
  muted = false,
}: {
  rows: AccountRow[];
  state: State;
  ceiling: number;
  weeklyCeiling: number | null;
  now: number;
  /** Bar and runway width: 200 on a phone, wider on a tablet. */
  bar: number;
  open: ReadonlySet<number>;
  onToggle: (id: number) => void;
  muted?: boolean;
}) {
  return (
    <ul aria-label="Accounts">
      {rows.map((r) => {
        const isOpen = open.has(r.id);
        const xid = `acct-x-${r.id}`;
        const flag = r.flags.find((f) => f.text !== 'default login');
        return (
          <li key={r.id} className="border-b border-line">
            <div className="cursor-pointer px-16 pb-12 pt-10 transition-colors duration-120 ease-hover active:bg-hover" onClick={() => onToggle(r.id)}>
              <div className="flex h-20 items-center">
                <button
                  type="button"
                  aria-label={r.name}
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? xid : undefined}
                  className="flex min-w-0 items-center gap-8 text-left coarse:-my-12 coarse:min-h-44"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(r.id);
                  }}
                >
                  <span className={clsx('type-mono font-key', muted ? 'text-ink-3' : 'text-ink')}>{r.tag}</span>
                  <span className={clsx('min-w-0 truncate type-row', muted ? 'text-ink-3' : 'text-ink-2')}>{r.alias}</span>
                </button>
                {flag ? (
                  <Tag tone={flag.tone} className="ml-8 h-18">
                    {flag.text}
                  </Tag>
                ) : null}
                <span className="ml-auto flex-none pl-12 type-mono">
                  <span className={!r.ok || muted ? 'text-ink-3' : r.past ? 'text-signal-text' : 'text-ink'}>{r.h5 ?? '–'}</span>
                  <span className="ml-4 text-ink-3">5h</span>
                </span>
              </div>
              <div className="mt-6 flex h-16 items-center justify-between gap-12">
                <Meter value={r.h5} stale={!r.ok || muted} label={`${r.name} 5-hour usage`} width={bar} ceiling={ceiling} />
                <span className="truncate type-mono text-ink-3">
                  {r.resetAt !== null ? (
                    <>
                      {resetIn(r, now)} · <b className="font-data text-ink-2">{hhmm(r.resetAt)}</b>
                    </>
                  ) : r.ok ? (
                    'no window open'
                  ) : (
                    'no reading'
                  )}
                </span>
              </div>
              {r.resetAt !== null ? (
                <div className="mt-6 flex h-16 items-center justify-between gap-12">
                  <Runway now={now} resetAt={r.resetAt} fullAt={r.fullAt} width={bar} height={14} />
                  {r.fullAt !== null ? (
                    <b className="truncate type-mono text-signal-text">full ~{hhmm(r.fullAt)}</b>
                  ) : (
                    <span className="truncate type-mono text-ink-3">{burnText(r.burnPerHour)}</span>
                  )}
                </div>
              ) : null}
            </div>
            {isOpen ? <Expanded id={xid} r={r} state={state} ceiling={ceiling} weeklyCeiling={weeklyCeiling} now={now} bar={bar} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function Expanded({
  id,
  r,
  state,
  ceiling,
  weeklyCeiling,
  now,
  bar,
}: {
  id: string;
  r: AccountRow;
  state: State;
  ceiling: number;
  weeklyCeiling: number | null;
  now: number;
  bar: number;
}) {
  const cells = sessionCells(state, r.sessions, now);
  return (
    <div id={id} className="px-16 pb-12 animate-pop">
      <p className="type-small text-ink-2">
        <Sentence parts={runwaySentence(r, state, ceiling, now)} />
      </p>
      {r.d7 !== null ? (
        <div className="mt-12 flex h-16 items-center justify-between gap-12">
          <Meter value={r.d7} label={`${r.name} Weekly usage`} width={bar} ceiling={weeklyCeiling} />
          <span className="truncate type-mono text-ink-3">
            <span className="text-ink">{r.d7}</span> 7d{r.d7ResetAt !== null ? <> · {dayClock(r.d7ResetAt, now)}</> : null}
          </span>
        </div>
      ) : null}
      {r.scoped.map((w) => (
        <div key={w.kind} className="mt-6 flex h-16 items-center justify-between gap-12">
          <Meter value={Math.round(w.pct)} label={`${r.name} ${windowLabel(w.kind)} usage`} width={bar} />
          <span className="truncate type-mono text-ink-3">
            <span className="text-ink">{Math.round(w.pct)}</span> {windowLabel(w.kind).replace(/^Weekly · /, '7d ')}
          </span>
        </div>
      ))}
      {r.flags.length || r.account.alias ? (
        <div className={clsx('mt-12 flex flex-wrap items-center gap-6')}>
          {r.flags.map((f) => (
            <Tag key={f.text} tone={f.tone}>
              {f.text}
            </Tag>
          ))}
          {r.account.alias ? <span className="type-mono text-ink-3">{r.account.emailMasked}</span> : null}
        </div>
      ) : null}
      {cells.length ? (
        <div className="mt-8">
          <SessionList cells={cells} />
        </div>
      ) : null}
    </div>
  );
}
