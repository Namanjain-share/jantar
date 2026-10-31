/**
 * One meeting in the list (v0.5 spec 5.2): the name, with its start and
 * length in mono --ink-3 on the right ("running" while it is open); under
 * it the project in --ink-2 and the screenshots in mono; then the summary's
 * gist on one line. The row opens the meeting; its ··· menu has Delete,
 * which asks nothing and is held under Undo.
 */
import type { Meeting } from '@jantar/protocol';
import { Link } from '../../shell/Link.js';
import { RowMenu } from '../life/today/parts.js';
import { durationText, hhmm, meetingsPath, shotsText, type MeetingFilters } from './model.js';

export interface MeetingRowProps {
  meeting: Meeting;
  filters: MeetingFilters;
  offline: boolean;
  onDelete: (meeting: Meeting) => void;
}

export function MeetingRow({ meeting: m, filters, offline, onDelete }: MeetingRowProps) {
  const shots = m.shots > 0 ? shotsText(m.shots) : null;
  return (
    <li data-meeting={m.id} className="flex items-start border-b border-line">
      <Link
        href={meetingsPath(filters, m.id)}
        className="block min-w-0 flex-1 py-10 pl-16 pr-4 transition-colors duration-120 ease-hover hover:bg-hover focus-visible:-outline-offset-2"
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
        <RowMenu label={`Actions for ${m.name}`} disabled={offline} groups={[{ items: [{ label: 'Delete', onSelect: () => onDelete(m) }] }]} />
      </div>
    </li>
  );
}
