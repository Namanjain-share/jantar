/**
 * Edit a meeting (v0.5 spec 5.5): Name, Project (every project not done,
 * paused ones too, as Todos' own sheet offers them, plus "No project"; gone
 * while Todos are off), People, and "Action items go to this project's
 * todos" only while the summary has not run (none or queued) and a project
 * is chosen. Save sends only what changed (null clears); a failed save
 * keeps the sheet open with its values and "Not saved".
 */
import { useId, useState, type FormEvent } from 'react';
import { MEETING_LIMITS, type MeetingDetail, type MeetingPatch, type ProjectView } from '@jantar/protocol';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Sheet } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { NotSaved } from '../life/shared/states.js';
import { Field, INPUT, OfflineLine, SheetActions, useOffline, useWrite } from '../life/today/parts.js';
import { editProjects, projectText } from './model.js';

export interface EditSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A fresh number per opening (the form starts over). */
  sheetKey: number;
  detail: MeetingDetail;
  projects: readonly ProjectView[];
  /** Todos are on: Project and the auto todos switch show. */
  todos: boolean;
  onSaved: () => void;
}

export function EditSheet({ open, onOpenChange, sheetKey, detail, projects, todos, onSaved }: EditSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Edit meeting">
      <EditForm key={sheetKey} detail={detail} projects={projects} todos={todos} onDone={() => onOpenChange(false)} onSaved={onSaved} />
    </Sheet>
  );
}

function EditForm({ detail, projects, todos, onDone, onSaved }: { detail: MeetingDetail; projects: readonly ProjectView[]; todos: boolean; onDone: () => void; onSaved: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const id = useId();
  const m = detail.meeting;
  const [name, setName] = useState(m.name);
  const [projectId, setProjectId] = useState(m.projectId ?? '');
  const [people, setPeople] = useState(m.people ?? '');
  const [autoTodos, setAutoTodos] = useState(m.autoTodos);
  const ok = name.trim().length > 0;
  // No summary has added items yet (a failed one added none), so they can still go to the project by themselves.
  const canAuto = todos && projectId !== '' && detail.summary.state !== 'running' && detail.summary.state !== 'done';
  const options = editProjects(projects, m.projectId);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || w.busy || offline) return;
    const patch: MeetingPatch = {};
    if (name.trim() !== m.name) patch.name = name.trim();
    if (todos && projectId !== (m.projectId ?? '')) patch.projectId = projectId || null;
    if (people.trim() !== (m.people ?? '')) patch.people = people.trim() || null;
    if (canAuto && autoTodos !== m.autoTodos) patch.autoTodos = autoTodos;
    if (Object.keys(patch).length) {
      const r = await w.run(JSON.stringify(patch), (key) => api.meetingUpdate(m.id, patch, key));
      if (!r.ok) return;
      onSaved();
    }
    onDone();
  };

  return (
    <form onSubmit={(e) => void save(e)} aria-label="Edit meeting">
      <Field label="Name" htmlFor={`${id}-name`}>
        <input id={`${id}-name`} className={INPUT} value={name} maxLength={MEETING_LIMITS.name} autoComplete="off" onChange={(e) => setName(e.target.value)} />
      </Field>
      {todos ? (
        <Field label="Project" htmlFor={`${id}-project`}>
          <select id={`${id}-project`} className={INPUT} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">No project</option>
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {projectText(p)}
              </option>
            ))}
            {m.projectId && !options.some((p) => p.id === m.projectId) ? <option value={m.projectId}>{m.projectName ?? 'This project'}</option> : null}
          </select>
        </Field>
      ) : null}
      <Field label="People" htmlFor={`${id}-people`}>
        <input id={`${id}-people`} className={INPUT} value={people} maxLength={MEETING_LIMITS.people} autoComplete="off" onChange={(e) => setPeople(e.target.value)} />
      </Field>
      {canAuto ? (
        <label className="flex min-h-44 items-center gap-12 py-8 type-small text-ink">
          <input type="checkbox" className="size-16 flex-none accent-ink" checked={autoTodos} onChange={(e) => setAutoTodos(e.target.checked)} />
          Action items go to this project's todos
        </label>
      ) : null}
      {w.error ? <NotSaved error={w.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!ok || w.busy || offline}>
          {w.busy ? <Spinner label="Saving" /> : null}
          Save
        </Button>
        <Button variant="text" size="lg" onClick={onDone}>
          Cancel
        </Button>
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}
