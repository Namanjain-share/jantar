/**
 * One meeting in the list (v0.5 spec 5.2): the name, with its start and
 * length in mono --ink-3 on the right ("running" while it is open); under
 * it the project in --ink-2 and the screenshots in mono; then the summary's
 * gist on one line. The row opens the meeting; its ··· menu has Delete,
 * which asks nothing and is held under Undo.
 *
 * 0.11: `current` ticks the row of the meeting open beside the list (the
 * SplitPane keeps it in view); MeetingCard is the same meeting as a card for
 * the days across a wide pane (build plan 2.8).
 */
import type { Meeting } from '@jantar/protocol';
import clsx from 'clsx';
import { Link } from '../../shell/Link.js';
import { RowMenu } from '../life/today/parts.js';
import { SUMMARY_FAILED, WRITING, durationText, hhmm, meetingWho, meetingsPath, shotsText, type MeetingFilters } from './model.js';

export interface MeetingRowProps {
  meeting: Meeting;
  filters: MeetingFilters;
  offline: boolean;
  onDelete: (meeting: Meeting) => void;
  /** 0.11: the meeting open beside the list. */
  current?: boolean;
}

function Menu({ m, offline, onDelete }: { m: Meeting; offline: boolean; onDelete: (meeting: Meeting) => void }) {
  return <RowMenu label={`Actions for ${m.name}`} disabled={offline} groups={[{ items: [{ label: 'Delete', onSelect: () => onDelete(m) }] }]} />;
}

export function MeetingRow({ meeting: m, filters, offline, onDelete, current = false }: MeetingRowProps) {
  const shots = m.shots > 0 ? shotsText(m.shots) : null;
  return (
    <li data-meeting={m.id} className={clsx('flex items-start border-b border-line', current && 'bg-select')}>
      <Link
        href={meetingsPath(filters, m.id)}
        aria-current={current ? 'true' : undefined}
        className={clsx(
          'relative block min-h-44 min-w-0 flex-1 py-10 pl-16 pr-4 transition-colors duration-120 ease-hover focus-visible:-outline-offset-2',
          current ? 'row-tick' : 'hover:bg-hover',
        )}
      >
        <span className="flex items-baseline gap-8">
          <span className="min-w-0 flex-1 truncate type-row font-medium text-ink">{m.name}</span>
          <span className="flex-none type-mono text-ink-3">
            {hhmm(m.startedAt)} · {durationText(m)}
          </span>
        </span>
        {m.projectName || shots ? (
          <span className="mt-2 flex min-w-0 items-baseline gap-6">
            {m.projectName ? <span className="min-w-0 truncate type-small text-ink-2">{m.projectName}</span> : null}
            {m.projectName && shots ? (
              <span aria-hidden="true" className="type-small text-ink-3">
                ·
              </span>
            ) : null}
            {shots ? <span className="flex-none type-mono text-ink-3">{shots}</span> : null}
          </span>
        ) : null}
        {m.gist ? <span className="mt-2 block truncate type-small text-ink-2">{m.gist}</span> : null}
      </Link>
      <div className="flex-none pr-8 pt-6">
        <Menu m={m} offline={offline} onDelete={onDelete} />
      </div>
    </li>
  );
}

/** The summary's state where it has no gist to show: being written, or failed. */
function summaryWord(m: Meeting): string | null {
  if (m.endedAt === null || m.gist) return null;
  if (m.summary === 'queued' || m.summary === 'running') return WRITING;
  if (m.summary === 'failed') return SUMMARY_FAILED;
  return null;
}

/**
 * 0.11, the days across a wide pane (build plan 2.8): a card per meeting.
 * The name on two lines, its time and length in mono, who was there, then the
 * summary's first lines (or its state while it has none), and the
 * screenshots. The card opens the meeting beside the list; ··· has Delete.
 */
export function MeetingCard({ meeting: m, filters, offline, onDelete }: Omit<MeetingRowProps, 'current'>) {
  const who = meetingWho(m);
  const state = summaryWord(m);
  return (
    <li data-meeting={m.id} className="relative min-w-0">
      <Link
        href={meetingsPath(filters, m.id)}
        className="flex h-full flex-col rounded-dock border border-line bg-raised px-12 pb-12 pt-10 transition-colors duration-120 ease-hover hover:border-line-strong focus-visible:outline-offset-2"
      >
        {/* Room on the right for the ··· menu, which sits over the card's corner. */}
        <span className="line-clamp-2 break-words pr-28 type-row coarse:pr-44 font-medium text-ink">{m.name}</span>
        <span className="mt-4 truncate type-mono text-ink-3">
          {hhmm(m.startedAt)} · {durationText(m)}
          {m.shots > 0 ? ` · ${shotsText(m.shots)}` : ''}
        </span>
        {who ? <span className="mt-4 truncate type-small text-ink-2">{who}</span> : null}
        {m.gist ? <span className="mt-6 line-clamp-3 break-words type-small text-ink-2">{m.gist}</span> : null}
        {state ? <span className="mt-6 type-small text-ink-3">{state}</span> : null}
      </Link>
      <div className="absolute right-4 top-4">
        <Menu m={m} offline={offline} onDelete={onDelete} />
      </div>
    </li>
  );
}
