/**
 * v0.12 People: her To-do (`/p/todos`): add, tick (an item that asks for a
 * report opens its sheet), Got it on his items. Every tick shows the shared
 * 5-second Undo (spec 3.1), the same toast as Today's.
 */
import type { PersonMe, PersonTodo } from '@jantar/protocol/people';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../ui/kit/Button.js';
import type { PersonApi } from '../api.js';
import { UndoToast, useUndo } from '../ui.js';
import { TodoRow } from './TodoRow.js';

export function Todos({ me, api, tick }: { me: PersonMe; api: PersonApi; tick: number }) {
  const [todos, setTodos] = useState<PersonTodo[] | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const undo = useUndo();
  const load = useCallback(() => api.todos().then((r) => setTodos(r.todos), () => setTodos([])), [api]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  const run = (p: Promise<unknown>) =>
    p.then(
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
        if (d) undo.show(`Done: ${t.title}`, () => void run(api.done(t.id, false)));
      },
      (e: Error) => setError(e.message),
    );
  return (
    <div>
      <h1 className="text-title font-semibold">To-do</h1>
      <form
        className="mt-12 flex gap-8"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          void run(api.createTodo({ title: title.trim() }).then(() => setTitle('')));
        }}
      >
        <input aria-label="New to-do" className="min-h-44 flex-1 rounded-btn border border-line bg-bg px-8" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        <Button type="submit" variant="primary">
          Add
        </Button>
      </form>
      {error ? (
        <p role="alert" className="mt-8">
          {error}
        </p>
      ) : null}
      <ul className="mt-12 divide-y divide-line">
        {(todos ?? []).map((t) => (
          <TodoRow key={t.id} t={t} owner={me.owner.name} onDone={(d, report) => done(t, d, report)} onAck={() => void run(api.ack(t.id))} />
        ))}
      </ul>
      {todos && todos.length === 0 ? <p className="mt-12 text-ink-2">Nothing open.</p> : null}
      <UndoToast toast={undo.toast} close={undo.close} />
    </div>
  );
}
