/**
 * One todo (v0.4 spec 5.2, 5.3): a circle that marks it done, the title
 * (--ink; a high one at 560 with a mono `high` tag), and a mono meta line
 * `Example · Fri 31 Oct · 11:00 ↻` (the project, the day where the rail does
 * not already say it, the time in mustard, the repeat icon). Tapping the
 * title edits it; ··· or a long press gives Snooze, Edit and Delete.
 *
 * Ember (design rule 3, spec 5.0): "overdue 2d" on a todo that is overdue,
 * and nothing else. Done is never green: the Done list shows a check glyph
 * and --ink-3 text (`DoneRow`).
 */
import { AlarmIcon, CheckIcon, CircleIcon, RepeatIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useId, useRef, useState, type ReactNode } from 'react';
import type { Todo } from '@jantar/protocol';
import { IconButton } from '../../../kit/IconButton.js';
import { useLongPress, type PressGuard, justLongPressed } from '../../../kit/longPress.js';
import { Tag } from '../../../kit/Tag.js';
import { RowMenu, type LifeClock } from '../today/parts.js';
import { SNOOZES, type TodoActions } from './actions.js';
import { dueDay, isOverdue, overdueText } from './model.js';

export interface TodoRowProps {
  todo: Todo;
  now: LifeClock;
  /** The project's name with its emoji, when the row is not on that project's own screen. */
  project?: string | undefined;
  /** Say the due day (the Today rail already does). */
  showDay?: boolean;
  /** Overdue whatever the clock says (Today's list from the daemon). */
  overdue?: boolean;
  /** The Reminders view: an alarm before the time. */
  reminder?: boolean;
  /** Opened from a push: --select for 2 s. */
  highlight?: boolean;
  offline: boolean;
  actions: TodoActions;
  onEdit: (todo: Todo) => void;
}

export function TodoRow({ todo, now, project, showDay = true, overdue, reminder = false, highlight = false, offline, actions, onEdit }: TodoRowProps) {
  const [menu, setMenu] = useState(false);
  const overdueId = useId();
  // The lift that ends a long press also clicks: the row's guard drops that click, so the sheet does not open under the menu.
  const guard = useRef<PressGuard>({ at: -Infinity }).current;
  const late = overdue ?? isOverdue(todo, now);
  const press = useLongPress<HTMLButtonElement>(offline ? undefined : () => setMenu(true), guard);
  const busy = actions.busy.has(todo.id);
  const high = todo.priority === 'high';

  const meta: ReactNode[] = [];
  // First on the meta line, so a wrapped title never has the tag between it and the rest.
  if (high) meta.push(<Tag key="h">high</Tag>);
  if (project) meta.push(<span key="p">{project}</span>);
  if (todo.due && (showDay || late)) meta.push(<span key="d">{dueDay(todo.due.day, now.day)}</span>);
  if (todo.due?.time) {
    meta.push(
      <span key="t" className="inline-flex items-center gap-4 text-jup-text">
        {reminder ? <AlarmIcon size={12} aria-hidden="true" /> : null}
        {todo.due.time}
      </span>,
    );
  }
  if (todo.repeat) {
    meta.push(
      <span key="r" className="inline-flex items-center">
        <RepeatIcon size={12} aria-hidden="true" />
        <span className="sr-only">repeats</span>
      </span>,
    );
  }

  return (
    <li data-todo={todo.id} data-highlight={highlight || undefined} className={clsx('flex items-start gap-4 border-b border-line px-8 py-6 transition-colors duration-160 ease-ui', highlight && 'bg-select')}>
      <IconButton aria-label={`Mark done: ${todo.title}`} disabled={offline || busy} onClick={() => actions.done(todo)}>
        <CircleIcon size={18} aria-hidden="true" />
      </IconButton>
      <button
        type="button"
        className="min-w-0 flex-1 select-none py-4 text-left [-webkit-touch-callout:none] coarse:min-h-44 coarse:py-10"
        // The ember "overdue 2d" sits outside both buttons: Tab to the row says it too.
        aria-describedby={late ? overdueId : undefined}
        onClick={() => {
          if (!justLongPressed(guard)) onEdit(todo);
        }}
        {...press}
      >
        <span className={clsx('block break-words type-row text-ink', high && 'font-medium')}>{todo.title}</span>
        {meta.length ? (
          <span className="mt-2 flex flex-wrap items-center gap-x-6 type-mono text-ink-3">
            {meta.map((m, i) => (
              <span key={i} className="inline-flex items-center gap-6">
                {i > 0 ? <span aria-hidden="true">·</span> : null}
                {m}
              </span>
            ))}
          </span>
        ) : null}
      </button>
      {late ? (
        <span id={overdueId} className="flex-none pt-6 type-mono text-signal-text coarse:pt-12">
          {overdueText(todo, now)}
        </span>
      ) : null}
      <RowMenu
        label={`Actions for ${todo.title}`}
        open={menu}
        onOpenChange={setMenu}
        disabled={offline || busy}
        groups={[
          { label: 'Snooze', items: SNOOZES.map((s) => ({ label: s.label, onSelect: () => actions.snooze(todo, s.preset) })) },
          {
            items: [
              { label: 'Edit', onSelect: () => onEdit(todo) },
              { label: 'Delete', onSelect: () => actions.remove(todo) },
            ],
          },
        ]}
      />
    </li>
  );
}

/** A done todo in the Done list: a check and --ink-3 text; the check makes it not done again. */
export function DoneRow({ todo, offline, actions }: { todo: Todo; offline: boolean; actions: TodoActions }) {
  return (
    <li data-todo={todo.id} className="flex items-center gap-4 border-b border-line px-8 py-6">
      <IconButton aria-label={`Mark not done: ${todo.title}`} disabled={offline || actions.busy.has(todo.id)} onClick={() => actions.undone(todo)}>
        <CheckIcon size={18} aria-hidden="true" />
      </IconButton>
      <span className="min-w-0 flex-1 truncate type-row text-ink-3">{todo.title}</span>
    </li>
  );
}
