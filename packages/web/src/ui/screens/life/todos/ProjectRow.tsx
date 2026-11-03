/**
 * One project on the Projects tab (v0.4 spec 5.3): `🛠 Example · active`
 * and a mono line `4 open · 1 overdue · due 15 Nov · 2 live sessions`.
 * The live count joins the phone's sessions by the project's folder. A tap
 * opens the project.
 *
 * Ember (design rule 3, spec 5.0): its overdue todos, and its due day once
 * past while the project is not done. Nothing else on the row.
 *
 * 0.11: `card`, the same project as a card in the Projects grid of a wide
 * pane (build plan 2.4), with its next open todos under the line (`next`,
 * three at most, then how many more).
 */
import { CaretRightIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import type { ProjectView, Todo } from '@jantar/protocol';
import { routePath } from '../../../../lib/router.js';
import { Link } from '../../../shell/Link.js';
import { dayLabel } from '../shared/DayNav.js';
import { projectLabel, projectOverdue } from './model.js';

/** A card lists this many of its open todos. */
const NEXT = 3;

export function ProjectRow({ project, today, live, card = false, next = [] }: { project: ProjectView; today: string; live: number; card?: boolean; next?: readonly Todo[] }) {
  const late = projectOverdue(project, today);
  const parts = [
    <span key="open">{project.open} open</span>,
    project.overdue > 0 ? (
      <span key="late" className="text-signal-text">
        {project.overdue} overdue
      </span>
    ) : null,
    project.due ? (
      <span key="due" className={late ? 'text-signal-text' : undefined}>
        due {dayLabel(project.due).replace(/^\w+ /, '')}
      </span>
    ) : null,
    live > 0 ? <span key="live">{live === 1 ? '1 live session' : `${live} live sessions`}</span> : null,
  ].filter(Boolean);
  return (
    <li className={card ? 'min-w-0' : 'border-b border-line'}>
      <Link
        href={routePath({ name: 'todos', project: project.id })}
        data-project={project.id}
        className={clsx(
          'flex gap-8 transition-colors duration-120 ease-hover',
          card ? 'h-full items-start rounded-dock border border-line bg-raised px-12 py-10 hover:border-line-strong' : 'items-center px-16 py-10 hover:bg-hover',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-8">
            <span className="min-w-0 truncate type-row font-medium text-ink">{projectLabel(project)}</span>
            <span className="flex-none type-mono text-ink-3">{project.status}</span>
          </span>
          <span className="mt-2 flex flex-wrap items-center gap-x-6 type-mono text-ink-3">
            {parts.map((p, i) => (
              <span key={i} className="inline-flex items-center gap-6">
                {i > 0 ? <span aria-hidden="true">·</span> : null}
                {p}
              </span>
            ))}
          </span>
          {card && next.length ? (
            <span className="mt-8 block border-t border-line pt-6">
              {next.slice(0, NEXT).map((t) => (
                <span key={t.id} className="block truncate py-2 type-small text-ink-2">
                  {t.title}
                </span>
              ))}
              {next.length > NEXT ? <span className="block pt-2 type-mono text-ink-3">{next.length - NEXT} more</span> : null}
            </span>
          ) : null}
        </span>
        <CaretRightIcon size={16} aria-hidden="true" className={clsx('flex-none text-ink-3', card && 'mt-2')} />
      </Link>
    </li>
  );
}
