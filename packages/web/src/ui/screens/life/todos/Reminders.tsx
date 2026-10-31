/**
 * The Reminders view (v0.4 spec 1.2, 5.3): a reminder is a todo with a
 * time, not a module of its own. This lists the open todos that have one,
 * in the order they ring, with an alarm before the time (mustard), the
 * repeat icon on repeating ones and overdue ones in ember (TodoRow). Same
 * rows and actions as the Todos tab.
 */
import type { ReactNode } from 'react';
import type { ProjectView, Todo } from '@jantar/protocol';
import { LifeEmpty, EMPTY } from '../shared/states.js';
import type { LifeClock } from '../today/parts.js';
import type { TodoActions } from './actions.js';
import { projectLabel, remindersOf } from './model.js';
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
}: {
  todos: readonly Todo[];
  projects: ReadonlyMap<string, ProjectView>;
  now: LifeClock;
  flash: string | null;
  offline: boolean;
  actions: TodoActions;
  onEdit: (todo: Todo) => void;
  addButton: ReactNode;
}) {
  const list = remindersOf(todos);
  if (list.length === 0) return <LifeEmpty action={addButton}>{EMPTY.reminders}</LifeEmpty>;
  return (
    <ul aria-label="Reminders">
      {list.map((t) => {
        const p = t.projectId ? projects.get(t.projectId) : undefined;
        return (
          <TodoRow
            key={t.id}
            todo={t}
            now={now}
            project={p ? projectLabel(p) : undefined}
            reminder
            highlight={flash === t.id}
            offline={offline}
            actions={actions}
            onEdit={onEdit}
          />
        );
      })}
    </ul>
  );
}
