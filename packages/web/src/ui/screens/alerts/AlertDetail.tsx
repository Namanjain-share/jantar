/**
 * One alert beside the list (0.11, build plan 2.10; `/alerts?id=`): what a
 * row could only hint at, in a pane of its own.
 *
 *   ■ API error · Today 01:43                                   [Close]
 *   api-server · rate limiter                                      title
 *   Hit an API error: 529 overloaded. Retried twice, then stopped.
 *   ┌ what the Mac wrote down, mono on --term ───────────────────────┐
 *   When · Today 01:43 | Session · ■ Working 3m · acct 04 | Machine
 *   [Open session]  [Mute pushes ▾]
 *   EARLIER FROM THIS SESSION                         its other alerts
 *
 * Everything comes from the store (state.alerts, state.sessions): no route.
 * In a split pane Close (and Esc, the SplitPane's) goes back to the list;
 * alone in a narrow pane, "‹ Alerts" does. j and k open the next and the
 * one before in the list's order; Return opens the session.
 */
import { CaretLeftIcon } from '@phosphor-icons/react';
import type { Alert } from '@jantar/protocol';
import { accountId } from '../../../lib/format.js';
import { useApp, useNavigate, useNow } from '../../context.js';
import { buttonClass } from '../../kit/Button.js';
import { GROUP_LABEL, groupOf } from '../../kit/glyph.js';
import { RailLabel } from '../../kit/RailLabel.js';
import { StatusGlyph } from '../../kit/StatusGlyph.js';
import { PaneClose, usePaneClose } from '../../kit/PaneClose.js';
import { Link } from '../../shell/Link.js';
import { useKey } from '../../shell/keys.js';
import { dayLabel } from '../accounts/time.js';
import { rowOf } from '../board/model.js';
import { timeOf } from './AlertRow.js';
import { Mute } from './Mute.js';
import { KIND_WORD, recordOf, relatedAlerts, type AlertAction } from './model.js';

export interface AlertDetailProps {
  alert: Alert;
  subject: string;
  sentence: string;
  action: AlertAction | null;
  unseen: boolean;
  /** The list's address, for "‹ Alerts" alone in a pane. */
  listHref: string;
  /** Where another alert of the list opens (j, k, Earlier). */
  hrefOf: (id: string) => string;
  /** The alerts before and after this one in the list's order. */
  prev: Alert | null;
  next: Alert | null;
}

const TILE = 'min-w-0 rounded-btn bg-surface px-12 py-10';

export function AlertDetail({ alert: a, subject, sentence, action, unseen, listHref, hrefOf, prev, next }: AlertDetailProps) {
  const navigate = useNavigate();
  const now = useNow(30_000);
  const state = useApp((s) => s.state);
  const closing = usePaneClose();
  const session = a.sid ? state.sessions[a.sid] : undefined;
  const live = session ? rowOf(state, session, now) : null;
  const related = relatedAlerts(state.alerts, a);
  const t = Date.parse(a.ts);
  const when = Number.isFinite(t) ? `${dayLabel(t, now)} ${timeOf(a)}` : '';

  useKey(['j', 'k'], (e) => {
    const to = e.key === 'j' ? next : prev;
    if (!to) return;
    e.preventDefault();
    navigate(hrefOf(to.id), { replace: true });
  });
  useKey('Enter', (e) => {
    if (!action || (e.target as HTMLElement | null)?.closest?.('button, a, input, textarea, select')) return;
    e.preventDefault();
    navigate(action.href);
  });

  return (
    <article aria-labelledby="alert-title" className="px-16 pb-32 animate-enter desk:px-24">
      <header className="flex min-h-56 items-center gap-8 border-b border-line">
        {closing ? null : (
          <Link href={listHref} className="-ml-8 inline-flex h-44 flex-none items-center gap-4 px-8 type-small text-ink-2 transition-colors duration-120 ease-hover hover:text-ink">
            <CaretLeftIcon size={16} aria-hidden="true" />
            Alerts
          </Link>
        )}
        <p className="flex min-w-0 flex-1 items-center gap-8 type-mono text-ink-3">
          <StatusGlyph state={unseen ? 'needs' : 'turn'} label={unseen ? 'New' : undefined} />
          <span className="truncate">
            {KIND_WORD[a.kind]} · {when}
          </span>
        </p>
        {closing ? <PaneClose onClick={closing} /> : null}
      </header>

      <h2 id="alert-title" className="mt-16 break-words type-title text-ink">
        {subject}
      </h2>
      <p className="mt-4 break-words type-row text-ink-2">{sentence}</p>
      <pre className="mt-16 overflow-x-auto whitespace-pre-wrap break-words rounded-btn bg-term px-16 py-12 type-code text-term-ink">{recordOf(a)}</pre>

      <dl className="mt-16 grid gap-12 @md:grid-cols-3">
        <div className={TILE}>
          <dt className="type-small text-ink-3">When</dt>
          <dd className="mt-2 type-mono text-ink">{when}</dd>
        </div>
        <div className={TILE}>
          <dt className="type-small text-ink-3">{a.sid ? 'Session' : 'Account'}</dt>
          <dd className="mt-2 flex min-w-0 items-center gap-8 type-mono text-ink">
            {live ? (
              <>
                <StatusGlyph state={live.glyph} />
                <span className="truncate">{[GROUP_LABEL[groupOf(live.glyph)], live.age, live.account ? `acct ${live.account.id}` : null].filter(Boolean).join(' · ')}</span>
              </>
            ) : a.sid ? (
              <span className="text-ink-2">Not on the board now</span>
            ) : a.account !== undefined ? (
              `acct ${accountId(a.account)}`
            ) : (
              <span className="text-ink-2">None</span>
            )}
          </dd>
        </div>
        <div className={TILE}>
          <dt className="type-small text-ink-3">Kind</dt>
          <dd className="mt-2 type-mono text-ink">{KIND_WORD[a.kind]}</dd>
        </div>
      </dl>

      <div className="mt-16 flex flex-wrap items-center gap-8">
        {action ? (
          <Link href={action.href} className={buttonClass('outline', 'lg')}>
            {action.label}
          </Link>
        ) : null}
        <Mute />
      </div>

      {related.length ? (
        <section aria-label="Earlier from this session" className="mt-24">
          <RailLabel ground="bg" inset={false} sticky={false}>
            {a.sid ? 'Earlier from this session' : 'Earlier from this account'}
          </RailLabel>
          <ul>
            {related.map((b) => (
              <li key={b.id} className="border-b border-line">
                <Link href={hrefOf(b.id)} className="flex min-h-44 items-center gap-12 transition-colors duration-120 ease-hover hover:bg-hover">
                  <span className="w-48 flex-none type-mono text-ink-3">{timeOf(b)}</span>
                  <span className="w-88 flex-none type-small text-ink-3">{KIND_WORD[b.kind]}</span>
                  <span className="min-w-0 flex-1 truncate type-small text-ink-2">{b.what}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
