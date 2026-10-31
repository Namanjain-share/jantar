/**
 * The todo sheet (v0.4 spec 5.3): Title, Notes, Due (a date and an
 * optional time; with a time it is a reminder), Repeat (only with a date),
 * Priority and Project. A new reminder starts with the time first, filled
 * with the next full hour. Editing sends only what changed (null clears).
 * A failed save keeps the sheet open with its values and "Not saved".
 */
import { useId, useState, type FormEvent } from 'react';
import type { ProjectView, Repeat, Todo, TodoBody, TodoPatch, TodoPriority } from '@jantar/protocol';
import { useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Sheet } from '../../../kit/Sheet.js';
import { Spinner } from '../../../kit/Spinner.js';
import { Segmented } from '../../accounts/Segmented.js';
import { RepeatPicker } from '../shared/RepeatPicker.js';
import { NotSaved } from '../shared/states.js';
import { Field, INPUT, OfflineLine, SheetActions, TEXTAREA, useOffline, useWrite, type LifeClock } from '../today/parts.js';
import { nextFullHour, projectLabel } from './model.js';

export interface TodoStart {
  projectId?: string;
  /** A reminder: the due date and time first, at the next full hour. */
  reminder?: boolean;
}

export interface TodoSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A fresh number per opening (the form starts over). */
  sheetKey: number;
  /** null: a new todo. */
  todo: Todo | null;
  projects: readonly ProjectView[];
  now: LifeClock;
  start?: TodoStart | undefined;
  onSaved: () => void;
}

export function TodoSheet({ open, onOpenChange, sheetKey, todo, projects, now, start, onSaved }: TodoSheetProps) {
  const title = todo ? 'Edit todo' : start?.reminder ? 'New reminder' : 'New todo';
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title}>
      <TodoForm key={sheetKey} todo={todo} projects={projects} now={now} start={start} onDone={() => onOpenChange(false)} onSaved={onSaved} />
    </Sheet>
  );
}

const sameRepeat = (a: Repeat | null, b: Repeat | null) =>
  (a?.freq ?? null) === (b?.freq ?? null) && (a?.byWeekday ?? []).join() === (b?.byWeekday ?? []).join();

function TodoForm({ todo, projects, now, start, onDone, onSaved }: { todo: Todo | null; projects: readonly ProjectView[]; now: LifeClock; start?: TodoStart | undefined; onDone: () => void; onSaved: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const id = useId();
  const first = !todo && start?.reminder ? nextFullHour(now) : null;
  const [title, setTitle] = useState(todo?.title ?? '');
  const [notes, setNotes] = useState(todo?.notes ?? '');
  const [day, setDay] = useState(todo?.due?.day ?? first?.day ?? '');
  const [time, setTime] = useState(todo?.due?.time ?? first?.time ?? '');
  const [repeat, setRepeat] = useState<Repeat | undefined>(todo?.repeat);
  const [priority, setPriority] = useState<TodoPriority>(todo?.priority ?? 'normal');
  const [projectId, setProjectId] = useState(todo?.projectId ?? start?.projectId ?? '');

  const due = day ? { day, ...(time ? { time } : {}) } : null;
  const rep = day && repeat ? repeat : null;
  const ok = title.trim().length > 0;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || w.busy || offline) return;
    if (!todo) {
      const body: TodoBody = {
        title: title.trim(),
        priority,
        ...(notes.trim() ? { notes } : {}),
        ...(due ? { due } : {}),
        ...(projectId ? { projectId } : {}),
        ...(rep ? { repeat: rep } : {}),
      };
      const r = await w.run(JSON.stringify(body), (key) => api.todoCreate(body, key));
      if (!r.ok) return;
    } else {
      const patch: TodoPatch = {};
      if (title.trim() !== todo.title) patch.title = title.trim();
      if (notes !== (todo.notes ?? '')) patch.notes = notes.trim() ? notes : null;
      if (JSON.stringify(due) !== JSON.stringify(todo.due ?? null)) patch.due = due;
      if (priority !== todo.priority) patch.priority = priority;
      if (projectId !== (todo.projectId ?? '')) patch.projectId = projectId || null;
      if (!sameRepeat(rep, todo.repeat ?? null)) patch.repeat = rep;
      if (Object.keys(patch).length) {
        const r = await w.run(JSON.stringify(patch), (key) => api.todoUpdate(todo.id, patch, key));
        if (!r.ok) return;
      }
    }
    onSaved();
    onDone();
  };

  const dueField = (
    <Field label={first ? 'Rings at' : 'Due'} id={`${id}-due`}>
      <div role="group" aria-labelledby={`${id}-due`} className="flex items-center gap-8">
        <input
          type="date"
          aria-label="Due day"
          className={INPUT}
          value={day}
          onChange={(e) => {
            setDay(e.target.value);
            if (!e.target.value) {
              setTime('');
              setRepeat(undefined);
            }
          }}
        />
        <input type="time" aria-label="Due time" className={INPUT} value={time} disabled={!day} onChange={(e) => setTime(e.target.value)} />
        {day ? (
          <Button
            variant="text"
            size="sm"
            onClick={() => {
              setDay('');
              setTime('');
              setRepeat(undefined);
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>
    </Field>
  );

  return (
    <form onSubmit={(e) => void save(e)} aria-label={todo ? 'Edit todo' : 'New todo'}>
      {first ? dueField : null}
      <Field label="Title" htmlFor={`${id}-title`}>
        <input id={`${id}-title`} className={INPUT} value={title} maxLength={200} autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Notes" htmlFor={`${id}-notes`}>
        <textarea id={`${id}-notes`} className={TEXTAREA} value={notes} maxLength={2000} rows={3} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {first ? null : dueField}
      {day ? (
        <Field label="Repeat">
          <RepeatPicker value={repeat} onChange={setRepeat} />
        </Field>
      ) : null}
      <Field label="Priority">
        <Segmented<TodoPriority>
          label="Priority"
          fill
          value={priority}
          onChange={setPriority}
          segments={[
            { key: 'normal', label: 'Normal' },
            { key: 'high', label: 'High' },
          ]}
        />
      </Field>
      <Field label="Project" htmlFor={`${id}-project`}>
        <select id={`${id}-project`} className={INPUT} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">None</option>
          {projects
            .filter((p) => p.status !== 'done' || p.id === projectId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {projectLabel(p)}
              </option>
            ))}
        </select>
      </Field>
      {w.error ? <NotSaved error={w.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!ok || w.busy || offline}>
          {w.busy ? <Spinner label="Saving" /> : null}
          {todo ? 'Save' : first ? 'Add reminder' : 'Add todo'}
        </Button>
        <Button variant="text" size="lg" onClick={onDone}>
          Cancel
        </Button>
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}
