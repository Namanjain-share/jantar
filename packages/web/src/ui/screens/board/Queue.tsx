/**
 * "Waiting on you" above the ledger (0.12, build plan c25; ipad-design.md
 * 3.1 "Single"): the Board's own pane is single (an iPad in portrait, a
 * landscape 2/3 window, a narrow Mac window) beside the phone, so the Desk
 * isn't there to show what waits. The Desk's cards, oldest first, up to
 * three:
 *
 * - The oldest, when it is a hook Question with one question (open question
 *   5), is answered here with the session's own card (session/Question.tsx,
 *   the same lazy chunk): a tap selects, Send answer sends, Decline
 *   declines. "Open →" goes to the session for anything else (your own
 *   words, a second look at the transcript).
 * - Every other card (a Plan, a Permission, a terminal dialog, a Question
 *   with several questions) says what it asks and opens the session
 *   ("Review plan →", "Review command →", "Answer →"). Plan and Permission
 *   sit side by side in a pane of 700 or more.
 * - In a window under 600 tall the cards fold to one line that opens the
 *   oldest (kit.css .queue-*), so the ledger keeps its room.
 *
 * An answer given here leaves one line under the cards ("Answered
 * “auth/session.ts”") while the Board stays open.
 */
import { ArrowRightIcon } from '@phosphor-icons/react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { questionsOf } from '../../../lib/describe.js';
import { ago } from '../../../lib/format.js';
import { useApp, useNow } from '../../context.js';
import { buttonClass } from '../../kit/Button.js';
import { Link } from '../../shell/Link.js';
import { cardMachine } from '../session/Info.js';
import { isLate } from '../session/DockFrame.js';
import type { Receipt } from '../session/decide.js';
import { QueueCard } from './Desk.js';
import { deskItem, groupRows, ledgerGroups, type DeskItem } from './model.js';

const QuestionCard = lazy(() => import('../session/Question.js').then((m) => ({ default: m.QuestionCard })));

const QUEUE_MAX = 3;

const sessionHref = (sid: string) => `/s/${encodeURIComponent(sid)}`;

/** The oldest card is answered here: a hook Question with one question. */
export function answerable(item: DeskItem): boolean {
  const card = item.row.card;
  return item.kind === 'question' && card?.kind === 'question' && card.state === 'open' && questionsOf(card).length === 1;
}

export function Queue() {
  const state = useApp((s) => s.state);
  const offline = useApp((s) => s.conn.status === 'offline');
  const now = useNow(15_000);
  const groups = useMemo(() => ledgerGroups(state, now), [state, now]);
  const needs = groupRows(groups, 'needs');
  const items = useMemo(() => needs.slice(0, QUEUE_MAX).map((r) => deskItem(state, r)), [needs, state]);
  const [answered, setAnswered] = useState<Receipt | null>(null);
  const first = items[0];
  if (!first) return answered ? <p className="px-16 pt-12 type-small text-ink-2">{answered.text}</p> : null;
  const inPlace = answerable(first) ? first : null;
  const rest = inPlace ? items.slice(1) : items;
  const card = inPlace?.row.card;
  const session = inPlace ? state.sessions[inPlace.row.sid] : undefined;
  const machine = session ? cardMachine(state, session) : undefined;
  const age = card ? ago(card.createdAt, now) : '';
  return (
    <section aria-label="Waiting on you" className="border-b border-line px-16 pb-16 pt-12">
      <div className="mb-12 flex items-baseline gap-12">
        <h2 className="type-title text-ink">Waiting on you</h2>
        <span className="type-mono text-ink-3">oldest first</span>
      </div>
      {/* A short window: one line, which opens the oldest. */}
      <Link href={sessionHref(first.row.sid)} className="queue-line h-44 items-center gap-8 type-row text-ink">
        <span className="min-w-0 flex-1 truncate">
          {first.word}: {first.head}
        </span>
        <ArrowRightIcon size={14} weight="bold" aria-hidden="true" />
      </Link>
      <div className="queue-cards flex flex-col gap-12">
        {inPlace && card ? (
          <div className="flex flex-col gap-8">
            <Suspense fallback={<QueueCard item={inPlace} index={0} />}>
              <QuestionCard
                key={card.id}
                p={card}
                folder={inPlace.row.folder}
                phone={false}
                offline={offline}
                age={!age || age === 'now' ? 'waiting now' : `waiting ${age}`}
                late={isLate(card.createdAt, now)}
                aside={<span className="type-small text-ink-2">{inPlace.row.folder}</span>}
                onDecided={setAnswered}
                {...(machine ? { machine } : {})}
              />
            </Suspense>
            <Link href={sessionHref(inPlace.row.sid)} className={buttonClass('text', 'md', 'self-start -ml-8')}>
              <span className="inline-flex items-center gap-4">
                Open {inPlace.row.folder}
                <ArrowRightIcon size={14} weight="bold" aria-hidden="true" />
              </span>
            </Link>
          </div>
        ) : null}
        {rest.length ? (
          <div className="grid grid-cols-1 gap-12 @min-[700px]:grid-cols-2">
            {rest.map((it, i) => (
              <QueueCard key={it.row.sid} item={it} index={i + (inPlace ? 1 : 0)} />
            ))}
          </div>
        ) : null}
      </div>
      {needs.length > items.length ? <p className="queue-cards mt-12 text-small text-ink-3">{needs.length - items.length} more waiting in the ledger below.</p> : null}
      {answered ? <p className="mt-8 type-small text-ink-2">{answered.text}</p> : null}
    </section>
  );
}
