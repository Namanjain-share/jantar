/** v0.12 People: her To-do (`/p/todos`): add, tick (with Undo), Got it on his items. */
import type { PersonMe, PersonTodo } from '@jantar/protocol/people';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../ui/kit/Button.js';
import type { PersonApi } from '../api.js';
import { TodoRow } from './TodoRow.js';

export function Todos({ me, api, tick }: { me: PersonMe; api: PersonApi; tick: number }) {
  const [todos, setTodos] = useState<PersonTodo[] | null>(null);
  const [title, setTitle] = useState('');
  const [undo, setUndo] = useState<{ id: string; title: string } | null>(null);
  const load = useCallback(() => api.todos().then((r) => setTodos(r.todos), () => setTodos([])), [api]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  const done = async (t: PersonTodo, d: boolean) => {
    await api.done(t.id, d);
    if (d) setUndo({ id: t.id, title: t.title });
    void load();
  };
  return (
    <div>
      <h1 className="text-title font-semibold">To-do</h1>
      <form
        className="mt-12 flex gap-8"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          void api.createTodo({ title: title.trim() }).then(() => {
            setTitle('');
            void load();
          });
        }}
      >
        <input aria-label="New to-do" className="min-h-44 flex-1 rounded-btn border border-line bg-bg px-8" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        <Button type="submit" variant="primary">
          Add
        </Button>
      </form>
      <ul className="mt-12 divide-y divide-line">
        {(todos ?? []).map((t) => (
          <TodoRow key={t.id} t={t} owner={me.owner.name} onDone={(d) => void done(t, d)} onAck={() => void api.ack(t.id).then(load)} />
        ))}
      </ul>
      {todos && todos.length === 0 ? <p className="mt-12 text-ink-2">Nothing open.</p> : null}
      {undo ? (
        <div role="status" className="fixed inset-x-16 bottom-64 flex items-center justify-between rounded-btn bg-ink px-12 py-8 text-bg">
          <span className="truncate">Done: {undo.title}</span>
          <Button variant="text" onClick={() => void api.done(undo.id, false).then(() => (setUndo(null), load()))}>
            Undo
          </Button>
        </div>
      ) : null}
    </div>
  );
}
