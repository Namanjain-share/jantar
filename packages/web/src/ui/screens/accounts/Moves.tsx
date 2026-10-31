/**
 * Moves below the matrix (direction.md 5.3): every move in progress, parked
 * or stuck, drawn as git-graph lanes. Account lanes sit 16 px apart; a 2 px
 * --ink line on a 4 px --bg casing runs from the `from` lane to the `to`
 * lane, dashed while the move is in progress, with a hollow dot for now.
 * Held accounts' lanes are dashed.
 *
 * v0.1 has no move history endpoint, so only current moves show (state.moves).
 * v0.4: the primer's one line (Primer.tsx) closes the section.
 */
import type { Account, Move, State } from '@jantar/protocol';
import clsx from 'clsx';
import { Fragment } from 'react';
import { accountId, agoLong } from '../../../lib/format.js';
import { moveStepWord, moveWho } from './model.js';
import { PrimerLine } from './Primer.js';
import { dayClock } from './time.js';

const IN_PROGRESS: Move['step'][] = ['saving', 'restarting', 'continuing'];

function Lanes({ accounts, move, labels }: { accounts: Account[]; move: Move; labels: boolean }) {
  const ids = accounts.map((a) => a.id);
  const width = Math.max(176, ids.length * 16);
  const height = labels ? 56 : 40;
  const top = labels ? 18 : 2;
  const lx = (id: number) => 8 + Math.max(0, ids.indexOf(id)) * 16;
  const x1 = lx(move.from) + 0.5;
  const x2 = (move.to !== undefined ? lx(move.to) : lx(move.from)) + 0.5;
  const sq = top + 2;
  const cy = height - 9;
  const d = `M${x1} ${sq + 6} C${x1} ${sq + 18} ${x2} ${cy - 17} ${x2} ${cy - 3}`;
  const dashed = IN_PROGRESS.includes(move.step);
  const name = `Move from ${accountId(move.from)}${move.to !== undefined ? ` to ${accountId(move.to)}` : ''}, ${dashed ? 'in progress' : moveStepWord(move)}`;
  return (
    <svg className="block flex-none" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={name}>
      <g shapeRendering="crispEdges">
        {accounts.map((a) => {
          const x = lx(a.id);
          if (!a.held) return <rect key={a.id} className="fill-line" x={x} y={top} width="1" height={height - top} />;
          const dots: number[] = [];
          for (let y = top; y < height; y += 4) dots.push(y);
          return (
            <Fragment key={a.id}>
              {dots.map((y) => (
                <rect key={y} className="fill-ink-4" x={x} y={y} width="1" height="2" />
              ))}
            </Fragment>
          );
        })}
      </g>
      {labels
        ? accounts.map((a) => (
            <text
              key={a.id}
              className={clsx('font-mono text-rail font-data tabular-nums', a.id === move.from || a.id === move.to ? 'fill-ink' : 'fill-ink-3')}
              x={lx(a.id) + 0.5}
              y="11"
              textAnchor="middle"
            >
              {accountId(a.id)}
            </text>
          ))
        : null}
      <path className="stroke-bg" d={d} fill="none" strokeWidth="4" />
      <path className="stroke-ink" d={d} fill="none" strokeWidth="2" strokeDasharray={dashed ? '3 2' : undefined} />
      <rect className="fill-ink" x={x1 - 3.5} y={sq} width="7" height="7" shapeRendering="crispEdges" />
      <circle className="fill-bg stroke-ink" cx={x2} cy={cy} r="3.5" strokeWidth="1.5" />
    </svg>
  );
}

function statusText(m: Move, now: number): string {
  const step = moveStepWord(m);
  if (m.step === 'parked' && m.wakeAt) return `${step} · wakes ${dayClock(Date.parse(m.wakeAt), now)}`;
  const since = agoLong(m.since, now);
  const base = since ? `${step} · moved ${since}` : step;
  return m.step === 'stuck' && m.why ? `${base} · ${m.why}` : base;
}

export function Moves({ state, now, phone, legacy = true }: { state: State; now: number; phone: boolean; legacy?: boolean }) {
  const accounts = Object.values(state.accounts).sort((a, b) => a.id - b.id);
  const moves = Object.values(state.moves).sort((a, b) => a.since.localeCompare(b.since));
  const held = accounts.filter((a) => a.held).map((a) => accountId(a.id));
  // Moves come only from the legacy ccw tool: without it, and with nothing to show, no Moves heading (the primer's line stays).
  const quiet = !legacy && !moves.length && !held.length;

  return (
    <section aria-labelledby={quiet ? undefined : 'moves-title'} className={clsx(phone ? 'mt-24 px-16' : 'mt-28 max-w-1320')}>
      {quiet ? null : (
        <div className="flex h-28 items-center gap-8 border-b border-line">
          <h2 id="moves-title" className="flex items-center gap-8 type-rail text-ink-3">
            <span>Moves</span>
            <span className="text-ink-2">{moves.length}</span>
          </h2>
          <span className="ml-8 type-mono text-ink-3">in progress, parked or stuck</span>
        </div>
      )}
      {moves.length === 0 && !quiet ? <p className="mt-12 type-small text-ink-3">No moves in progress.</p> : null}
      {moves.map((m, i) => {
        const who = moveWho(m, state);
        const route = `${accountId(m.from)} → ${m.to !== undefined ? accountId(m.to) : '?'}`;
        const whoNode = (
          <span className="min-w-0 truncate type-row text-ink-2">
            <b className="font-medium text-ink">{who.folder}</b> {who.name}
          </span>
        );
        if (phone) {
          return (
            <div key={m.sid} className="flex items-center gap-16 border-b border-line py-8">
              <Lanes accounts={accounts} move={m} labels={i === 0} />
              <div className="flex min-w-0 flex-col gap-4">
                {whoNode}
                <span className="flex min-w-0 flex-wrap gap-x-8 gap-y-4 type-mono text-ink-3">
                  <span className="text-ink-2">{route}</span>
                  <span>{statusText(m, now)}</span>
                </span>
              </div>
            </div>
          );
        }
        return (
          <div key={m.sid} className="flex items-center gap-32 border-b border-line py-8">
            <Lanes accounts={accounts} move={m} labels={i === 0} />
            <span className="flex w-280 min-w-0 flex-none">{whoNode}</span>
            <span className="w-96 flex-none type-mono text-ink-2">{route}</span>
            <span className="min-w-0 truncate type-mono text-ink-3">{statusText(m, now)}</span>
          </div>
        );
      })}
      {held.length ? (
        <p className="mt-12 type-small text-ink-3">
          Held {held.length === 1 ? 'account' : 'accounts'} <HeldList ids={held} /> {held.length === 1 ? 'is' : 'are'} left out of autoswitch.
          {moves.length ? ` ${held.length === 1 ? 'Its lane is' : 'Their lanes are'} dashed.` : ''}
        </p>
      ) : null}
      <PrimerLine primer={state.primer} now={now} />
    </section>
  );
}

/** "03, 05 and 09" with the ids in mono. */
function HeldList({ ids }: { ids: string[] }) {
  return (
    <>
      {ids.map((id, i) => (
        <Fragment key={id}>
          {i > 0 ? (i === ids.length - 1 ? ' and ' : ', ') : null}
          <b className="type-mono text-ink-2">{id}</b>
        </Fragment>
      ))}
    </>
  );
}
