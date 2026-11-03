/**
 * v0.11 People: her To-do (`/p/todos`, spec 3.3): add one, with a day and a
 * time if she wants (a time makes it a reminder that rings her phone), tick
 * (an item that asks for a report opens its sheet), Got it on his items.
 * A tap on a title opens its sheet: Snooze (unless he marked it no
 * snooze), Skip with a reason, Ask to change on his, Edit and Delete on
 * hers. Every tick, skip and snooze of hers shows the shared 5-second Undo
 * (spec 3.1), the same toast as Today's.
 */
import type { PersonMe, PersonTodo } from '@jantar/protocol/people';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../ui/kit/Button.js';
import type { PersonApi } from '../api.js';
import { UndoToast, useUndo } from '../ui.js';
import { TodoRow } from './TodoRow.js';
import { TodoSheet } from './TodoSheet.js';

const field = 'min-h-44 rounded-btn border border-line bg-bg px-8';

export function Todos({ me, api, tick }: { me: PersonMe; api: PersonApi; tick: number }) {
  const [todos, setTodos] = useState<PersonTodo[] | null>(null);
  const [title, setTitle] = useState('');
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');
  const [open, setOpen] = useState<PersonTodo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const undo = useUndo();
  const load = useCallback(() => api.todos().then((r) => setTodos(r.todos), () => setTodos([])), [api]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  const run = (p: Promise<unknown>) =>
    void p.then(
      () => {
        setError(null);
        void load();
      },
      (e: Error) => setError(e.message),
    );
  const done = (t: PersonTodo, d: boolean, report?: string) =>
    void api.done(t.id, d, report).then(
      () => {
        setError(null);
        void load();
        if (d) undo.show(`Done: ${t.title}`, () => run(api.done(t.id, false)));
      },
      (e: Error) => setError(e.message),
    );
  return (
    <div>
      <h1 className="text-title font-semibold">To-do</h1>
      <form
        className="mt-12 flex flex-col gap-8"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          const due = day ? { day, ...(time ? { time } : {}) } : undefined;
          run(
            api.createTodo({ title: title.trim(), ...(due ? { due } : {}) }).then(() => {
              setTitle('');
              setDay('');
              setTime('');
            }),
          );
        }}
      >
        <div className="flex gap-8">
          <input aria-label="New to-do" className={`${field} min-w-0 flex-1`} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          <Button type="submit" variant="primary" className="min-h-44">
            Add
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-8">
          <label className="flex flex-col gap-4">
            <span className="text-small text-ink-2">Day (optional)</span>
            <input type="date" className={field} value={day} onChange={(e) => setDay(e.target.value)} />
          </label>
          <label className="flex flex-col gap-4">
            <span className="text-small text-ink-2">Time: a reminder (optional)</span>
            <input type="time" className={field} value={time} disabled={!day} onChange={(e) => setTime(e.target.value)} />
          </label>
        </div>
      </form>
      {error ? (
        <p role="alert" className="mt-8">
          {error}
        </p>
      ) : null}
      <ul className="mt-12 divide-y divide-line">
        {(todos ?? []).map((t) => (
          <TodoRow key={t.id} t={t} owner={me.owner.name} onDone={(d, report) => done(t, d, report)} onAck={() => run(api.ack(t.id))} onMore={() => setOpen(t)} />
        ))}
      </ul>
      {todos && todos.length === 0 ? <p className="mt-12 text-ink-2">Nothing open.</p> : null}
      <TodoSheet t={open} owner={me.owner.name} api={api} close={() => setOpen(null)} run={run} undo={undo.show} />
      <UndoToast toast={undo.toast} close={undo.close} />
    </div>
  );
}
