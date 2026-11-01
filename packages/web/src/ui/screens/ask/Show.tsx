/**
 * A show card's live part (v0.5.3 spec 1.2). Claude only says what to show;
 * the phone fills it from the one `GET /v1/life/today` the page makes while
 * a show card is on screen, so no Life data goes to Claude and the numbers
 * are the Mac's own.
 *
 * - due: today's and overdue todos as TodoRows (their taps work as on
 *   Today); "Nothing due today." with none.
 * - calories: FoodToday against the served target (never a default), and
 *   "N kcal left" under it while under the target.
 * - meds: MedsToday; its dose taps are the only way a dose is logged here.
 *
 * A part that is off now (today's reply leaves it out) says so.
 */
import { createContext, useContext } from 'react';
import type { AskShowWhat, ProjectView, Today, Todo } from '@jantar/protocol';
import { FoodToday } from '../life/food/FoodToday.js';
import { kcalText } from '../life/food/format.js';
import { MedsToday } from '../life/meds/MedsToday.js';
import { NotSaved } from '../life/shared/states.js';
import type { LifeLoad } from '../life/shared/useLife.js';
import { Loaded, type LifeClock } from '../life/today/parts.js';
import type { TodoActions } from '../life/todos/actions.js';
import { projectLabel } from '../life/todos/model.js';
import { TodoRow } from '../life/todos/TodoRow.js';
import { ASK_COPY, SHOW_OFF } from './model.js';

/** What every show card on the page shares: the one today read, the todo taps and the clock. */
export interface ShowDeps {
  today: LifeLoad<Today>;
  actions: TodoActions;
  now: LifeClock;
  projects: readonly ProjectView[];
  offline: boolean;
  onEdit: (todo: Todo) => void;
}

export const ShowContext = createContext<ShowDeps | null>(null);

const Off = ({ what }: { what: AskShowWhat }) => <p className="px-16 py-8 type-small text-ink-2">{SHOW_OFF[what]}</p>;

export function ShowBody({ what }: { what: AskShowWhat }) {
  const deps = useContext(ShowContext);
  if (!deps) return null;
  return (
    <Loaded load={deps.today} count={2}>
      {(t) => {
        switch (what) {
          case 'due':
            return t.todos ? <Due todos={t.todos} deps={deps} /> : <Off what={what} />;
          case 'calories':
            return t.food ? (
              <>
                <FoodToday kcal={t.food.kcal} target={t.food.target} weight={null} />
                {t.food.kcal < t.food.target ? <p className="px-16 pb-8 type-mono text-ink-3">{kcalText(t.food.target - t.food.kcal)} kcal left</p> : null}
              </>
            ) : (
              <Off what={what} />
            );
          case 'meds':
            return t.meds ? <MedsToday data={t.meds} onChanged={deps.today.reload} /> : <Off what={what} />;
        }
      }}
    </Loaded>
  );
}

function Due({ todos, deps }: { todos: NonNullable<Today['todos']>; deps: ShowDeps }) {
  const { actions, now, offline, onEdit } = deps;
  const overdue = actions.visible(todos.overdue);
  const due = actions.visible(todos.today);
  const label = (todo: Todo) => {
    const p = todo.projectId ? deps.projects.find((x) => x.id === todo.projectId) : undefined;
    return p ? projectLabel(p) : undefined;
  };
  return (
    <>
      {actions.error ? (
        <div className="px-16">
          <NotSaved error={actions.error} />
        </div>
      ) : null}
      {overdue.length + due.length === 0 ? (
        <p className="px-16 py-8 type-small text-ink-2">{ASK_COPY.nothingDue}</p>
      ) : (
        <ul aria-label="Due today">
          {overdue.map((todo) => (
            <TodoRow key={todo.id} todo={todo} now={now} project={label(todo)} overdue offline={offline} actions={actions} onEdit={onEdit} />
          ))}
          {due.map((todo) => (
            <TodoRow key={todo.id} todo={todo} now={now} project={label(todo)} showDay={false} offline={offline} actions={actions} onEdit={onEdit} />
          ))}
        </ul>
      )}
    </>
  );
}
