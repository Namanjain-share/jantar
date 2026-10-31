/**
 * The Desk: the detail pane while no session is selected (desktop split,
 * >= 1024 px). Never auto-selects: a new arrival must not steal the pane.
 *
 *   left   Waiting on you: one raised card per needs-you session (up to
 *          three, the only stack of raised surfaces allowed), each with the
 *          full question, plan or command and its action. Or, with nothing
 *          waiting: "Nothing needs you" and the last five finished sessions
 *          in past tense. Then the next three 5-hour resets as runways.
 *   side   (>= 1360 px, where the cards keep their width) the newest
 *          alerts and the legend.
 */
import { ArrowRightIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useMemo } from 'react';
import { buttonClass } from '../../kit/Button.js';
import { Keycap } from '../../kit/Keycap.js';
import { Legend } from '../../kit/Legend.js';
import { RailLabel } from '../../kit/RailLabel.js';
import { StatusGlyph } from '../../kit/StatusGlyph.js';
import { readLocal } from '../../../lib/storage.js';
import { ago } from '../../../lib/format.js';
import { useApp, useNow } from '../../context.js';
import { Link } from '../../shell/Link.js';
import { ALERTS_SEEN_KEY } from '../Alerts.js';
import { Runway, runwayLabel } from './Runway.js';
import {
  RUNWAY_SPAN_MIN,
  clockAt as clock,
  deskAlerts,
  deskItem,
  groupRows,
  lastFinished,
  ledgerGroups,
  nextResets,
  replyLine as replyPreview,
  runwaySpan,
  type DeskItem,
  type ResetModel,
} from './model.js';

const QUEUE_MAX = 3;

/** A label with its arrow, set tight like "Answer →". */
function Arrowed({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center gap-4">
      {children}
      <ArrowRightIcon size={14} weight="bold" aria-hidden="true" />
    </span>
  );
}

function sessionHref(sid: string): string {
  return `/s/${encodeURIComponent(sid)}`;
}

function CardBody({ item }: { item: DeskItem }) {
  switch (item.kind) {
    case 'question':
      return item.options.length ? (
        <ul className="flex flex-wrap gap-x-8 gap-y-4 type-mono text-ink-2">
          {item.options.map((o, i) => (
            <li key={`${i}:${o}`} className="inline-flex min-w-0 items-center gap-8">
              <i aria-hidden="true" className="size-6 flex-none border border-line-strong" />
              <span className="truncate">{o}</span>
            </li>
          ))}
          {item.moreQuestions ? (
            <li className="text-ink-3">
              +{item.moreQuestions} {item.moreQuestions === 1 ? 'question' : 'questions'}
            </li>
          ) : null}
        </ul>
      ) : null;
    case 'plan':
      return item.steps.length ? (
        <ol className="grid grid-cols-2 gap-x-16 gap-y-2 text-small text-ink-2">
          {item.steps.map((s, i) => (
            <li key={i} className="flex min-w-0 gap-8">
              <span className="flex-none type-mono leading-18 text-ink-3">{s.n}</span>
              <span className="min-w-0 truncate">{s.text}</span>
            </li>
          ))}
        </ol>
      ) : null;
    case 'permission':
      return item.rule ? (
        <p className="text-small text-ink-3">
          Always allow would save <span className="type-mono text-ink-2">{item.rule}</span>
        </p>
      ) : item.why ? (
        <p className="text-small text-ink-3">{item.why}</p>
      ) : null;
    case 'terminal':
      return item.why ? <p className="line-clamp-2 text-small text-ink-2">{item.why}</p> : null;
  }
}

function QueueCard({ item, index }: { item: DeskItem; index: number }) {
  const r = item.row;
  return (
    <article className="rounded-dock border border-line bg-raised px-20 py-16" aria-label={`${item.word}: ${r.folder}`}>
      <div className="flex h-20 min-w-0 items-center">
        <StatusGlyph state="needs" className="-ml-4 mr-4" />
        <span className="flex-none text-small font-medium text-ink">{item.word}</span>
        <span className="ml-12 min-w-0 truncate text-small font-medium text-ink-2">
          {r.folder}
          <span className="ml-6 font-regular text-ink-3">{r.name}</span>
        </span>
        {index < 9 ? (
          <span className="ml-auto flex-none" aria-hidden="true">
            <Keycap>{index + 1}</Keycap>
          </span>
        ) : null}
      </div>
      <p className="mt-8 type-title text-pretty text-ink">{item.head}</p>
      {item.command ? (
        <pre className="mt-12 line-clamp-6 whitespace-pre-wrap break-words rounded-btn bg-term px-12 py-8 type-code text-term-ink">
          {item.command}
        </pre>
      ) : null}
      <div className="mt-12 flex items-end gap-24">
        <div className="min-w-0 flex-1">
          <CardBody item={item} />
        </div>
        <Link href={sessionHref(r.sid)} className={buttonClass('outline', 'md', 'flex-none')}>
          <Arrowed>{item.verb}</Arrowed>
        </Link>
      </div>
    </article>
  );
}

function Queue({ items, total }: { items: DeskItem[]; total: number }) {
  return (
    <>
      <div className="mb-12 flex items-baseline gap-12">
        <h2 className="type-title text-ink">Waiting on you</h2>
        <span className="type-mono text-ink-3">oldest first</span>
        <span className="ml-auto flex items-center gap-4 type-mono text-ink-3" aria-hidden="true">
          {items.map((_, i) => (
            <Keycap key={i}>{i + 1}</Keycap>
          ))}
          <span className="ml-4">jump</span>
        </span>
      </div>
      <div className="flex flex-col gap-12">
        {items.map((it, i) => (
          <QueueCard key={it.row.sid} item={it} index={i} />
        ))}
      </div>
      {total > items.length ? (
        <p className="mt-12 text-small text-ink-3">
          {total - items.length} more waiting in the ledger.
        </p>
      ) : null}
    </>
  );
}

function Clear({ working, sessions, asOf }: { working: number; sessions: number; asOf: string }) {
  const state = useApp((s) => s.state);
  const now = useNow(30_000);
  const finished = useMemo(() => lastFinished(state), [state]);
  const summary =
    sessions === 0
      ? 'No Claude sessions are running.'
      : working === 0
        ? 'Nothing is working right now.'
        : `${working} ${working === 1 ? 'session is' : 'sessions are'} working.`;
  return (
    <>
      <div className="flex items-baseline gap-12">
        <h2 className="type-title text-ink">Nothing needs you</h2>
        <span className="type-mono text-ink-3">as of {asOf}</span>
      </div>
      <p className="mb-20 mt-4 max-w-520 type-body text-ink-2">{summary} Anything that asks for you shows up here first.</p>
      {finished.length ? (
        <ul className="border-t border-line" aria-label="Last finished">
          {finished.map((s) => {
            const reply = replyPreview(s.lastReply?.text);
            return (
              <li key={s.sid}>
                <Link href={sessionHref(s.sid)} className="group flex w-full gap-8 border-b border-line pb-11 pt-10 text-left">
                  <StatusGlyph state="turn" className="mt-2" />
                  <span className="line-clamp-2 min-w-0 flex-1 type-body text-ink-2">
                    <b className="font-medium text-ink group-hover:underline group-hover:decoration-line-strong group-hover:underline-offset-3">
                      {s.folder}
                    </b>{' '}
                    finished{reply ? ` · ${reply}` : '.'}
                  </span>
                  <span className="flex-none type-mono leading-21 text-ink-3">{ago(s.statusSince, now)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}

function ResetRow({ r, now }: { r: ResetModel; now: number }) {
  const resetClock = clock(r.resetAt, now);
  const fullClock = r.fullAt === null ? null : clock(r.fullAt, now);
  return (
    <div className="border-b border-line pb-11 pt-10">
      <div className="mb-6 flex h-18 min-w-0 items-center">
        <span className="type-mono text-ink">{r.id}</span>
        {r.alias ? <span className="ml-8 min-w-0 truncate text-small text-ink-2">{r.alias}</span> : null}
        <span className="ml-auto flex-none pl-12 type-mono text-ink-3">
          in {runwaySpan(r.inMin)} · <b className="font-data text-ink-2">{resetClock}</b>
        </span>
      </div>
      <Runway r={r} now={now} label={runwayLabel(r, resetClock, fullClock)} />
      {fullClock ? (
        <p className="mt-6 text-small text-ink-2">
          Full ~{fullClock}
          {r.burn ? ` at ${r.burn}` : ''}, <span className="text-ink">{runwaySpan(r.deadMin)} before it resets</span>. The red dashes are that
          dead time.
        </p>
      ) : null}
    </div>
  );
}

function Resets({ resets, accounts, now }: { resets: ResetModel[]; accounts: number; now: number }) {
  return (
    <section className="mt-32" aria-label="Next resets">
      <RailLabel ground="bg" sticky={false} inset={false} aside={`now to ${clock(now + RUNWAY_SPAN_MIN * 60_000, now)}`}>
        Next resets
      </RailLabel>
      {resets.map((r) => (
        <ResetRow key={r.id} r={r} now={now} />
      ))}
      <Link
        href="/accounts"
        className="mt-8 inline-flex h-32 items-center rounded-chip text-small font-medium text-ink-2 transition-colors duration-120 ease-hover hover:text-ink"
      >
        <Arrowed>{`All ${accounts} ${accounts === 1 ? 'account' : 'accounts'}`}</Arrowed>
      </Link>
    </section>
  );
}

function Side({ legend }: { legend: boolean }) {
  const state = useApp((s) => s.state);
  const now = useNow(30_000);
  const alerts = useMemo(() => deskAlerts(state, readLocal<string>(ALERTS_SEEN_KEY, '')), [state]);
  const fresh = alerts.filter((a) => a.unseen).length;
  return (
    <aside className="hidden w-272 flex-none flex-col gap-24 2xl:flex" aria-label="Alerts and legend">
      {alerts.length ? (
        <section>
          <RailLabel ground="bg" sticky={false} inset={false}>
            Alerts
            {fresh ? <span className="ml-8 text-ink-2">{fresh} new</span> : null}
          </RailLabel>
          <ul>
            {alerts.map((a) => (
              <li key={a.alert.id}>
                <Link href={a.href} className="group flex w-full gap-8 border-b border-line pb-11 pt-10 text-left">
                  <StatusGlyph state={a.unseen ? 'needs' : 'turn'} className="mt-1" />
                  <span className="min-w-40 flex-none type-mono leading-18 text-ink-3">{clock(Date.parse(a.alert.ts), now)}</span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={clsx(
                        'block truncate text-small group-hover:underline group-hover:decoration-line-strong group-hover:underline-offset-3',
                        a.unseen ? 'font-medium text-ink' : 'text-ink-2',
                      )}
                    >
                      {a.subject}
                    </span>
                    <span className="mt-2 block text-small text-ink-2">{a.text}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {legend ? (
        <section>
          <RailLabel ground="bg" sticky={false} inset={false} aside="press ? anywhere">
            Legend
          </RailLabel>
          <Legend layout="stacked" />
        </section>
      ) : null}
    </aside>
  );
}

export function Desk() {
  const state = useApp((s) => s.state);
  const conn = useApp((s) => s.conn);
  const now = useNow(15_000);
  const groups = useMemo(() => ledgerGroups(state, now), [state, now]);
  const needs = groupRows(groups, 'needs');
  const items = useMemo(() => needs.slice(0, QUEUE_MAX).map((r) => deskItem(state, r)), [needs, state]);
  const resets = useMemo(() => nextResets(state, now), [state, now]);
  const sessions = Object.keys(state.sessions).length;
  const loading = state.seq === 0 && sessions === 0 && (conn.status === 'connecting' || conn.status === 'offline');
  const asOf = clock(conn.status === 'offline' && conn.lastOkAt ? conn.lastOkAt : now, now);

  return (
    <section aria-label="Desk" className="flex min-h-full gap-40 px-32 py-24 animate-enter">
      <div className="min-w-0 flex-1">
        {loading ? null : items.length ? (
          <Queue items={items} total={needs.length} />
        ) : (
          <Clear working={groupRows(groups, 'working').length} sessions={sessions} asOf={asOf} />
        )}
        {resets.length ? <Resets resets={resets} accounts={Object.keys(state.accounts).length} now={now} /> : null}
      </div>
      <Side legend={sessions > 0 || loading} />
    </section>
  );
}
