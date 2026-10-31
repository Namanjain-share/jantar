/**
 * The desktop Accounts matrix (direction.md 5.3, dir-k.html): 40 px rows,
 * hairlines, a sticky rail-style header and a shared time axis over RUNWAY.
 *
 *   ACCT  5H %  RUNWAY · NOW TO RESET  RESETS  7D %  BURN  SESSIONS  FLAGS
 *
 * RESETS and 7D show from 1280 px; below that they move into the expanded
 * row. A row expands (its ACCT button, or a click anywhere on it) to say in
 * words what the runway shows.
 */
import type { State } from '@jantar/protocol';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { windowLabel } from '../../../lib/format.js';
import { Meter } from '../../kit/Meter.js';
import { Tag } from '../../kit/Tag.js';
import { useWidth } from './hooks.js';
import { burnText, resetIn, runwaySentence, type AccountRow, type Part } from './model.js';
import { Runway, RunwayAxis } from './Runway.js';
import { SessionCells, sessionCells } from './SessionCells.js';
import { dayClock, hhmm } from './time.js';

/** Column widths in px (dir-k.html .mx-r), the runway takes the rest. */
const COL = { acct: 144, h5: 160, resets: 136, d7: 128, burn: 88, sessions: 112, flags: 160 } as const;
const RUNWAY_PAD = 32;
/** Room for the reset clock after the runway when RESETS has no column. */
const LABEL_ROOM = 40;
const MAX_WIDTH = 1320;

export function Sentence({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.strong ? (
          <b key={i} className="font-medium text-ink">
            {p.text}
          </b>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

function ResetText({ r, now }: { r: AccountRow; now: number }) {
  if (r.resetAt === null) return <>–</>;
  return (
    <>
      {resetIn(r, now)} · <b className="font-data text-ink-2">{hhmm(r.resetAt)}</b>
    </>
  );
}

function ValueText({ r }: { r: AccountRow }) {
  return (
    <span className={clsx('w-24 flex-none text-right type-mono', !r.ok ? 'text-ink-3' : r.past ? 'text-signal-text' : 'text-ink')}>{r.h5 ?? '–'}</span>
  );
}

export function Matrix({
  rows,
  state,
  ceiling,
  weeklyCeiling,
  now,
  wide,
  open,
  onToggle,
}: {
  rows: AccountRow[];
  state: State;
  ceiling: number;
  weeklyCeiling: number | null;
  now: number;
  /** >= 1280: RESETS and 7D get their own columns. */
  wide: boolean;
  open: ReadonlySet<number>;
  onToggle: (id: number) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(MAX_WIDTH);
  const fixed = COL.acct + COL.h5 + COL.burn + COL.sessions + COL.flags + (wide ? COL.resets + COL.d7 : 0);
  const runway = Math.max(160, Math.min(width, MAX_WIDTH) - fixed - RUNWAY_PAD - (wide ? 0 : LABEL_ROOM));
  const lead = COL.acct + COL.h5;

  return (
    <div ref={ref} role="table" aria-label="Accounts" className="w-full max-w-1320">
      <div role="row" className="sticky top-0 z-2 flex h-28 items-center border-b border-line bg-bg type-rail text-ink-3">
        <span role="columnheader" className="w-144 flex-none pl-8">
          Acct
        </span>
        <span role="columnheader" className="w-160 flex-none">
          5h %
        </span>
        <span role="columnheader" className="min-w-0 flex-1">
          Runway · now to reset
        </span>
        {wide ? (
          <span role="columnheader" className="w-136 flex-none">
            Resets
          </span>
        ) : null}
        {wide ? (
          <span role="columnheader" className="w-128 flex-none">
            7d %
          </span>
        ) : null}
        <span role="columnheader" className="w-88 flex-none">
          Burn
        </span>
        <span role="columnheader" className="w-112 flex-none">
          Sessions
        </span>
        <span role="columnheader" className="w-160 flex-none">
          Flags
        </span>
      </div>
      <div className="flex h-20" aria-hidden="true">
        <span className="flex-none" style={{ width: lead }} />
        <RunwayAxis now={now} width={runway} clock={hhmm} />
      </div>

      {rows.map((r) => {
        const isOpen = open.has(r.id);
        const cells = sessionCells(state, r.sessions, now);
        const moveTo = r.moves.find((m) => m.to !== undefined)?.to ?? null;
        const xid = `acct-x-${r.id}`;
        return (
          <div key={r.id} role="rowgroup">
            <div
              role="row"
              className={clsx(
                'flex h-40 cursor-pointer items-center border-b transition-colors duration-120 ease-hover hover:bg-hover',
                isOpen ? 'border-transparent' : 'border-line',
              )}
              onClick={() => onToggle(r.id)}
            >
              <span role="cell" className="flex h-full w-144 flex-none items-center pl-8">
                <button
                  type="button"
                  aria-label={r.name}
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? xid : undefined}
                  className="-ml-8 flex h-28 min-w-0 items-center gap-12 rounded-chip px-8 text-left"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(r.id);
                  }}
                >
                  <span className="type-mono font-key text-ink">{r.tag}</span>
                  <span className="min-w-0 truncate type-row text-ink-2">{r.alias}</span>
                </button>
              </span>
              <span role="cell" className="flex h-full w-160 flex-none items-center gap-12">
                <Meter value={r.h5} stale={!r.ok} label={`${r.name} 5-hour usage`} width={96} ceiling={ceiling} />
                <ValueText r={r} />
              </span>
              <span role="cell" className="flex h-full min-w-0 flex-1 items-start">
                <Runway
                  now={now}
                  resetAt={r.resetAt}
                  fullAt={r.fullAt}
                  width={runway}
                  height={39}
                  empty={r.ok ? 'no window open' : 'no reading'}
                  resetLabel={!wide && r.resetAt !== null ? hhmm(r.resetAt) : undefined}
                />
              </span>
              {wide ? (
                <span role="cell" className="w-136 flex-none type-mono text-ink-3">
                  <ResetText r={r} now={now} />
                </span>
              ) : null}
              {wide ? (
                <span role="cell" className="flex w-128 flex-none items-center gap-12">
                  <Meter value={r.d7} label={`${r.name} Weekly usage`} width={64} ceiling={weeklyCeiling} />
                  <span className="w-24 flex-none text-right type-mono text-ink">{r.d7 ?? '–'}</span>
                </span>
              ) : null}
              <span role="cell" className="w-88 flex-none type-mono text-ink-2">
                {burnText(r.burnPerHour)}
              </span>
              <span role="cell" className="flex w-112 flex-none items-center">
                <SessionCells cells={cells} moveTo={moveTo} />
              </span>
              <span role="cell" className="flex w-160 min-w-0 flex-none gap-6">
                {r.flags.map((f) => (
                  <Tag key={f.text} tone={f.tone}>
                    {f.text}
                  </Tag>
                ))}
              </span>
            </div>
            {isOpen ? (
              <div id={xid} role="row" className="flex border-b border-line pb-12 animate-pop">
                <span className="flex-none" style={{ width: lead }} />
                <div role="cell" className="min-w-0 max-w-720 flex-1">
                  <p className="type-small text-ink-2">
                    <Sentence parts={runwaySentence(r, state, ceiling, now)} />
                  </p>
                  <Extra r={r} now={now} wide={wide} weeklyCeiling={weeklyCeiling} />
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The expanded row's data line: what the columns do not already show. */
function Extra({ r, now, wide, weeklyCeiling }: { r: AccountRow; now: number; wide: boolean; weeklyCeiling: number | null }) {
  const items: ReactNode[] = [];
  if (!wide && r.resetAt !== null) items.push(<span key="reset">5h resets {resetIn(r, now)}</span>);
  if (!wide && r.d7 !== null)
    items.push(
      <span key="d7" className="inline-flex items-center gap-8">
        <Meter value={r.d7} label={`${r.name} Weekly usage`} width={64} ceiling={weeklyCeiling} />
        7d <b className="font-data text-ink">{r.d7}</b>
      </span>,
    );
  if (r.d7ResetAt !== null)
    items.push(
      <span key="d7r">
        7d resets <b className="font-data text-ink-2">{dayClock(r.d7ResetAt, now)}</b>
      </span>,
    );
  for (const w of r.scoped)
    items.push(
      <span key={w.kind} className="inline-flex items-center gap-8">
        <Meter value={Math.round(w.pct)} label={`${r.name} ${windowLabel(w.kind)} usage`} width={64} />
        {windowLabel(w.kind).replace(/^Weekly · /, '7d ')} <b className="font-data text-ink">{Math.round(w.pct)}</b>
      </span>,
    );
  if (r.account.alias) items.push(<span key="email">{r.account.emailMasked}</span>);
  if (!items.length) return null;
  return <p className="mt-6 flex flex-wrap items-center gap-x-16 gap-y-4 type-mono text-ink-3">{items}</p>;
}
