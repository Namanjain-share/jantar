/**
 * What a todo row's taps do (v0.4 spec 5.3): Done with a 5 s Undo (a
 * one-off todo sends `done: false`, a repeating one PATCHes its old due day
 * back), Not done from the Done list, the snooze presets and Delete (no
 * confirm: the row goes at once, with a 5 s Undo, and the delete is sent
 * once the Undo goes; parts.tsx `useHeldDeletes`). Each write reloads the
 * list; a failure is kept for the "Not saved" line. A screen lists its
 * todos through `visible`, which leaves out the ones held for deleting.
 */
import { useCallback, useMemo, useState } from 'react';
import type { SnoozePreset, Todo } from '@jantar/protocol';
import { useDeps } from '../../../context.js';
import { useHeldDeletes, useUndo } from '../today/parts.js';

export const SNOOZES: readonly { preset: SnoozePreset; label: string }[] = [
  { preset: '1h', label: 'Later 1 h' },
  { preset: 'tonight', label: 'Tonight' },
  { preset: 'tomorrow', label: 'Tomorrow' },
  { preset: 'nextWeek', label: 'Next week' },
];

export interface TodoActions {
  done(todo: Todo): void;
  undone(todo: Todo): void;
  snooze(todo: Todo, preset: SnoozePreset): void;
  remove(todo: Todo): void;
  /** A row with a write in flight. */
  busy: ReadonlySet<string>;
  error: unknown;
  undo: ReturnType<typeof useUndo>;
  /** `todos` without the ones deleted and still under their Undo. */
  visible(todos: readonly Todo[]): readonly Todo[];
}

export function useTodoActions(reload: () => void): TodoActions {
  const { api } = useDeps();
  const undo = useUndo();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  const act = useCallback(
    async (id: string, fn: () => Promise<unknown>): Promise<boolean> => {
      setError(null);
      setBusy((b) => new Set(b).add(id));
      try {
        await fn();
        reload();
        return true;
      } catch (e) {
        setError(e);
        return false;
      } finally {
        setBusy((b) => {
          const n = new Set(b);
          n.delete(id);
          return n;
        });
      }
    },
    [reload],
  );

  const { show } = undo;
  const done = useCallback(
    (t: Todo) => {
      void act(t.id, () => api.todoDone(t.id, true)).then((ok) => {
        if (!ok) return;
        // A repeating todo never becomes done: Done moved its day on, so Undo puts the old one back.
        const back = t.repeat && t.due ? () => api.todoUpdate(t.id, { due: t.due ?? null }) : () => api.todoDone(t.id, false);
        show(`Done: ${t.title}`, () => void act(t.id, back));
      });
    },
    [act, api, show],
  );
  const undone = useCallback((t: Todo) => void act(t.id, () => api.todoDone(t.id, false)), [act, api]);
  const snooze = useCallback((t: Todo, preset: SnoozePreset) => void act(t.id, () => api.todoSnooze(t.id, preset)), [act, api]);
  const { remove: hold, visible: unheld } = useHeldDeletes(undo);
  const remove = useCallback((t: Todo) => hold(t.id, `Deleted: ${t.title}`, () => act(t.id, () => api.todoDelete(t.id))), [hold, act, api]);
  const visible = useCallback((todos: readonly Todo[]) => unheld(todos, (t) => t.id), [unheld]);

  return useMemo(() => ({ done, undone, snooze, remove, busy, error, undo, visible }), [done, undone, snooze, remove, busy, error, undo, visible]);
}
