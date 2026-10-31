/**
 * The project sheet (v0.4 spec 5.3): Name, Emoji (one optional text
 * field), Status, Due (an optional date), Folder (one of the folders the
 * phone's sessions run in, or None; matched by prefix, never opened) and
 * Notes. A small project manager, not a CRM: nothing else. Delete asks
 * first and moves the project's todos to no project.
 */
import { useId, useState, type FormEvent } from 'react';
import type { ProjectBody, ProjectPatch, ProjectStatus, ProjectView } from '@jantar/protocol';
import { useApp, useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Sheet } from '../../../kit/Sheet.js';
import { Spinner } from '../../../kit/Spinner.js';
import { Segmented } from '../../accounts/Segmented.js';
import { TwoTap } from '../../session/TwoTap.js';
import { NotSaved } from '../shared/states.js';
import { Field, INPUT, OfflineLine, SheetActions, TEXTAREA, useOffline, useWrite } from '../today/parts.js';
import { sessionFolders } from './model.js';

export const STATUS_SEGMENTS: { key: ProjectStatus; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'paused', label: 'Paused' },
  { key: 'done', label: 'Done' },
];

export interface ProjectSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  /** null: a new project. */
  project: ProjectView | null;
  onSaved: () => void;
  /** After a delete (the project screen goes back to the list). */
  onDeleted?: () => void;
}

export function ProjectSheet({ open, onOpenChange, sheetKey, project, onSaved, onDeleted }: ProjectSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={project ? 'Edit project' : 'New project'}>
      <ProjectForm key={sheetKey} project={project} onDone={() => onOpenChange(false)} onSaved={onSaved} onDeleted={onDeleted} />
    </Sheet>
  );
}

function ProjectForm({ project, onDone, onSaved, onDeleted }: { project: ProjectView | null; onDone: () => void; onSaved: () => void; onDeleted?: (() => void) | undefined }) {
  const { api } = useDeps();
  const offline = useOffline();
  const sessions = useApp((s) => s.state.sessions);
  const w = useWrite();
  const id = useId();
  const [name, setName] = useState(project?.name ?? '');
  const [emoji, setEmoji] = useState(project?.emoji ?? '');
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? 'active');
  const [due, setDue] = useState(project?.due ?? '');
  const [folder, setFolder] = useState(project?.folder ?? '');
  const [notes, setNotes] = useState(project?.notes ?? '');
  const folders = sessionFolders(Object.values(sessions));
  if (project?.folder && !folders.includes(project.folder)) folders.unshift(project.folder);
  const ok = name.trim().length > 0;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || w.busy || offline) return;
    if (!project) {
      const body: ProjectBody = {
        name: name.trim(),
        status,
        ...(emoji.trim() ? { emoji: emoji.trim() } : {}),
        ...(notes.trim() ? { notes } : {}),
        ...(due ? { due } : {}),
        ...(folder ? { folder } : {}),
      };
      const r = await w.run(JSON.stringify(body), (key) => api.projectCreate(body, key));
      if (!r.ok) return;
    } else {
      const patch: ProjectPatch = {};
      if (name.trim() !== project.name) patch.name = name.trim();
      if (status !== project.status) patch.status = status;
      if (emoji.trim() !== (project.emoji ?? '')) patch.emoji = emoji.trim() || null;
      if (notes !== (project.notes ?? '')) patch.notes = notes.trim() ? notes : null;
      if (due !== (project.due ?? '')) patch.due = due || null;
      if (folder !== (project.folder ?? '')) patch.folder = folder || null;
      if (Object.keys(patch).length) {
        const r = await w.run(JSON.stringify(patch), (key) => api.projectUpdate(project.id, patch, key));
        if (!r.ok) return;
      }
    }
    onSaved();
    onDone();
  };

  const remove = async () => {
    if (!project) return;
    const r = await w.run(`delete:${project.id}`, (key) => api.projectDelete(project.id, key));
    if (!r.ok) return;
    onSaved();
    onDone();
    onDeleted?.();
  };

  return (
    <form onSubmit={(e) => void save(e)} aria-label={project ? 'Edit project' : 'New project'}>
      <Field label="Name" htmlFor={`${id}-name`}>
        <input id={`${id}-name`} className={INPUT} value={name} maxLength={60} autoComplete="off" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Emoji" htmlFor={`${id}-emoji`}>
        <input id={`${id}-emoji`} className={INPUT} value={emoji} maxLength={16} autoComplete="off" onChange={(e) => setEmoji(e.target.value)} />
      </Field>
      <Field label="Status">
        <Segmented<ProjectStatus> label="Status" fill value={status} onChange={setStatus} segments={STATUS_SEGMENTS} />
      </Field>
      <Field label="Due" htmlFor={`${id}-due`} aside={due ? <Button variant="text" size="sm" onClick={() => setDue('')}>Clear</Button> : null}>
        <input id={`${id}-due`} type="date" className={INPUT} value={due} onChange={(e) => setDue(e.target.value)} />
      </Field>
      <Field label="Folder" htmlFor={`${id}-folder`}>
        <select id={`${id}-folder`} className={INPUT} value={folder} onChange={(e) => setFolder(e.target.value)}>
          <option value="">None</option>
          {folders.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Notes" htmlFor={`${id}-notes`}>
        <textarea id={`${id}-notes`} className={TEXTAREA} value={notes} maxLength={2000} rows={3} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {w.error ? <NotSaved error={w.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!ok || w.busy || offline}>
          {w.busy ? <Spinner label="Saving" /> : null}
          {project ? 'Save' : 'Add project'}
        </Button>
        {project ? (
          <TwoTap size="lg" variant="text" confirmLabel="Delete project" disabled={w.busy || offline} onConfirm={() => void remove()}>
            Delete
          </TwoTap>
        ) : (
          <Button variant="text" size="lg" onClick={onDone}>
            Cancel
          </Button>
        )}
      </SheetActions>
      {project ? <p className="mt-8 type-small text-ink-3">Deleting a project keeps its todos, with no project.</p> : null}
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}
