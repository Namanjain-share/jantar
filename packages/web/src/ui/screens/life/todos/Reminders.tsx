/**
 * The Reminders view (v0.4 spec 1.2, 5.3): a reminder is a todo with a
 * time, not a module of its own. This lists the open todos that have one,
 * in the order they ring, with an alarm before the time (mustard), the
 * repeat icon on repeating ones and overdue ones in ember (TodoRow). Same
 * rows and actions as the Todos tab.
 *
 * 0.12 (build plan 2.4): with `cards` (a pane of 640 or more) they are
 * cards side by side, Overdue, Today and Upcoming, each in the order they
 * ring.
 */
import type { ReactNode } from 'react';
import { Columns } from '../../../kit/Columns.js';
import { Panel } from '../../../kit/Panel.js';
import type { ProjectView, Todo } from '@jantar/protocol';
import { LifeEmpty, EMPTY } from '../shared/states.js';
import type { LifeClock } from '../today/parts.js';
import type { TodoActions } from './actions.js';
import { byRail, projectLabel, RAIL_LABEL, RAIL_ORDER, remindersOf } from './model.js';
import { TodoRow } from './TodoRow.js';

export function Reminders({
  todos,
  projects,
  now,
  flash,
  offline,
  actions,
  onEdit,
  addButton,
  cards = false,
  client,
}: {
  todos: readonly Todo[];
  projects: ReadonlyMap<string, ProjectView>;
  /** 0.13.0: a follow-up's client's name (Work). */
  client?: ((todo: Todo) => string | undefined) | undefined;
  now: LifeClock;
  flash: string | null;
  offline: boolean;
  actions: TodoActions;
  onEdit: (todo: Todo) => void;
  addButton: ReactNode;
  /** 0.12: cards by when they ring, side by side. */
  cards?: boolean;
}) {
  const list = remindersOf(todos);
  if (list.length === 0) return <LifeEmpty action={addButton}>{EMPTY.reminders}</LifeEmpty>;
  const row = (t: Todo) => {
    const p = t.projectId ? projects.get(t.projectId) : undefined;
    return (
      <TodoRow
        key={t.id}
        todo={t}
        now={now}
        project={p ? projectLabel(p) : undefined}
        client={client?.(t)}
        reminder
        highlight={flash === t.id}
        offline={offline}
        actions={actions}
        onEdit={onEdit}
      />
    );
  };
  if (!cards) return <ul aria-label="Reminders">{list.map(row)}</ul>;
  // byRail keeps the order it is given: the order they ring.
  const rails = byRail(list, now);
  return (
    <Columns min={340} className="px-16 pt-4">
      {RAIL_ORDER.filter((r) => rails[r].length > 0).map((r) => (
        <Panel key={r} label={RAIL_LABEL[r]} count={rails[r].length} card>
          <ul aria-label={`Reminders, ${RAIL_LABEL[r]}`}>{rails[r].map(row)}</ul>
        </Panel>
      ))}
    </Columns>
  );
}
