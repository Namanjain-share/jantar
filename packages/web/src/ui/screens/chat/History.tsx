/**
 * Chat's history column (0.12, build plan 2.2): an index into the one
 * thread, built from the turns already loaded (`GET /v1/chat`, 30 a page);
 * there is no search or day route.
 *
 *   [ Search the chat          ]
 *   Days | Changes 2 | Photos              only while This chat isn't beside the thread
 *   TODAY
 *   Add oat milk to my list                a tap scrolls the thread to the turn
 *   photo · 2 changes · 13:02   confirm    ember while a card waits; a Siri tag
 *   [ Load earlier · kept 30 days ]
 *
 * In a pane of 1180 or more, Changes and Photos have their own column
 * (ThisChat.tsx) and the history lists days only.
 */
import clsx from 'clsx';
import { useId, useState } from 'react';
import type { ChatTurn } from '@jantar/protocol';
import { Button } from '../../kit/Button.js';
import { RailLabel } from '../../kit/RailLabel.js';
import { Spinner } from '../../kit/Spinner.js';
import { useSplit } from '../../kit/SplitPane.js';
import { Tag } from '../../kit/Tag.js';
import { Segmented } from '../accounts/Segmented.js';
import { CHAT_COPY, byDay, dayName, firstLine, matches, turnMeta, undoableChanges, waitsForTap } from './model.js';
import { ChangeList, PhotoGrid } from './ThisChat.js';

type Tab = 'days' | 'changes' | 'photos';

export interface HistoryProps {
  turns: readonly ChatTurn[];
  nowMs: number;
  offline: boolean;
  /** The turn the thread was last scrolled to from here (or the first of ?day=). */
  picked: string | null;
  /** More turns before the loaded ones. */
  earlier: boolean;
  loadingEarlier: boolean;
  onEarlier: () => void;
  onPick: (t: ChatTurn) => void;
  onChanged: () => void;
}

export function History({ turns, nowMs, offline, picked, earlier, loadingEarlier, onEarlier, onPick: pickTurn, onChanged }: HistoryProps) {
  const split = useSplit();
  const wide = split?.wide ?? false;
  // 0.12 (c25): over the thread ("‹ Days"), a pick goes to the turn and puts the days away.
  const onPick = (t: ChatTurn) => {
    pickTurn(t);
    split?.overlay?.set(false);
  };
  const searchId = useId();
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<Tab>('days');
  const shown = wide ? 'days' : tab;
  const days = byDay(turns.filter((t) => matches(t, q)));
  const changes = undoableChanges(turns, nowMs).length;

  return (
    <div className="pb-24">
      <div className="sticky top-0 z-3 border-b border-line bg-surface px-12 pb-8 pt-12">
        <label htmlFor={searchId} className="sr-only">
          Search the chat
        </label>
        <input
          id={searchId}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search the chat"
          maxLength={200}
          enterKeyHint="search"
          autoCapitalize="off"
          className="h-40 w-full min-w-0 rounded-btn border border-line-strong bg-bg px-12 type-input text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink coarse:h-44"
        />
        {wide ? null : (
          <Segmented
            label="The history shows"
            value={tab}
            onChange={setTab}
            fill
            className="mt-8"
            segments={[
              { key: 'days', label: 'Days' },
              { key: 'changes', label: changes ? <>Changes <span className="type-mono text-ink-3">{changes}</span></> : 'Changes', name: changes ? `Changes ${changes}` : 'Changes' },
              { key: 'photos', label: 'Photos' },
            ]}
          />
        )}
      </div>
      {shown === 'changes' ? (
        <ChangeList turns={turns} nowMs={nowMs} offline={offline} onChanged={onChanged} />
      ) : shown === 'photos' ? (
        <PhotoGrid turns={turns} onPick={onPick} />
      ) : days.length ? (
        days.map((d) => (
          <section key={d.day} aria-label={dayName(d.day, nowMs)}>
            <RailLabel ground="surface" sticky={false} count={d.turns.length}>
              {dayName(d.day, nowMs)}
            </RailLabel>
            <ul>
              {d.turns.map((t) => (
                <li key={t.id} className="border-b border-line">
                  <button
                    type="button"
                    aria-current={picked === t.id ? 'true' : undefined}
                    onClick={() => onPick(t)}
                    className={clsx(
                      'relative block w-full px-16 py-8 text-left transition-colors duration-120 ease-hover coarse:min-h-44',
                      picked === t.id ? 'row-tick bg-select' : 'hover:bg-hover',
                    )}
                  >
                    <span className="block truncate type-row text-ink">{firstLine(t)}</span>
                    <span className="mt-2 flex items-center gap-8 type-mono text-ink-3">
                      <span className="min-w-0 truncate">{turnMeta(t)}</span>
                      {waitsForTap(t) ? <span className="flex-none text-signal-text">confirm</span> : null}
                      {t.via === 'voice' ? <Tag className="ml-auto">{CHAT_COPY.siri}</Tag> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      ) : (
        <p className="px-16 py-12 type-small text-ink-3">Nothing in the loaded days says that.</p>
      )}
      <div className="px-12 pt-12">
        {earlier ? (
          <Button variant="text" size="lg" className="w-full justify-start" disabled={offline || loadingEarlier} onClick={onEarlier}>
            {loadingEarlier ? <Spinner label="Loading" /> : null}
            Load earlier · kept 30 days
          </Button>
        ) : (
          <p className="px-4 type-mono text-ink-3">Kept 30 days</p>
        )}
      </div>
    </div>
  );
}
