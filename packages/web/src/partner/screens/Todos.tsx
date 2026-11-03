/**
 * v0.11 People: her To-do (`/p/todos?tab=todos|reminders|projects`, spec
 * 1.3.1, 3.3).
 *
 * - To-dos: add one, with a day and a time if she wants (a time makes it a
 *   reminder that rings her phone) and one of her projects; tick (an item
 *   that asks for a report opens its sheet), Got it on his items. A tap on a
 *   title opens its sheet: Snooze (unless he marked it no snooze), Skip with
 *   a reason, Ask to change on his, Edit (its project too) and Delete on
 *   hers. Every tick, skip and snooze of hers shows the shared 5-second Undo
 *   (spec 3.1), the same toast as Today's.
 * - Reminders: the open items with a time.
 * - Projects: hers to make, open, rename, archive and bring back, or delete
 *   (its to-dos stay, with no project). `&project=<id>` is one project's
 *   page: its open to-dos, and Add puts a new one in it. While {owner} sees
 *   her to-dos, the tab says {owner} sees her projects with them.
 */
import type { ProjectView } from '@jantar/protocol';
import type { PersonMe, PersonTodo } from '@jantar/protocol/people';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../ui/kit/Button.js';
import type { PersonApi } from '../api.js';
import { navigate } from '../nav.js';
import { TODOS_TABS, type TodosTab } from '../router.js';
import { Field, Sheet, UndoToast, useUndo } from '../ui.js';
import { TodoRow } from './TodoRow.js';
import { TodoSheet } from './TodoSheet.js';

const field = 'min-h-44 rounded-btn border border-line bg-bg px-8';
const TAB_LABEL: Record<TodosTab, string> = { todos: 'To-dos', reminders: 'Reminders', projects: 'Projects' };

/** "2 open · 1 overdue", or "Nothing open". */
export function projectCounts(p: Pick<ProjectView, 'open' | 'overdue'>): string {
  if (p.open === 0) return 'Nothing open';
  return `${p.open} open${p.overdue ? ` · ${p.overdue} overdue` : ''}`;
}

export function Todos({ me, api, tab = 'todos', project = null, tick }: { me: PersonMe; api: PersonApi; tab?: TodosTab; project?: string | null; tick: number }) {
  const [todos, setTodos] = useState<PersonTodo[] | null>(null);
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [open, setOpen] = useState<PersonTodo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const undo = useUndo();
  const owner = me.owner.name;
  const load = useCallback(
    () =>
      Promise.all([
        api.todos(false, project ?? undefined).then((r) => setTodos(r.todos), () => setTodos([])),
        api.projects().then((r) => setProjects(r.projects), () => setProjects([])),
      ]),
    [api, project],
  );
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
  const names = new Map((projects ?? []).map((p) => [p.id, `${p.emoji ? `${p.emoji} ` : ''}${p.name}`]));
  const here = project ? (projects ?? []).find((p) => p.id === project) : undefined;
  const rows = (list: PersonTodo[]) => (
    <ul className="mt-12 divide-y divide-line">
      {list.map((t) => (
        <TodoRow
          key={t.id}
          t={t}
          owner={owner}
          {...(!project && t.projectId && names.get(t.projectId) ? { project: names.get(t.projectId) } : {})}
          onDone={(d, report) => done(t, d, report)}
          onAck={() => run(api.ack(t.id))}
          onMore={() => setOpen(t)}
        />
      ))}
    </ul>
  );
  const alert = error ? (
    <p role="alert" className="mt-8">
      {error}
    </p>
  ) : null;
  const sheets = (
    <>
      <TodoSheet t={open} owner={owner} shared={me.agreement?.see.todos === true} api={api} close={() => setOpen(null)} run={run} undo={undo.show} projects={projects ?? []} />
      <UndoToast toast={undo.toast} close={undo.close} />
    </>
  );

  if (project) {
    return (
      <div>
        <a
          href="/p/todos?tab=projects"
          className="inline-flex min-h-44 items-center text-ink-2 underline"
          onClick={(e) => {
            e.preventDefault();
            navigate('/p/todos?tab=projects');
          }}
        >
          All projects
        </a>
        {projects && !here ? (
          <p className="mt-12 text-ink-2">This project isn't here any more.</p>
        ) : here ? (
          <ProjectPage key={here.id} p={here} api={api} run={run} />
        ) : (
          <p className="mt-12 text-ink-2">Loading…</p>
        )}
        {here ? <AddTodo api={api} run={run} projects={[]} projectId={here.id} /> : null}
        {alert}
        {here && todos ? todos.length ? rows(todos) : <p className="mt-12 text-ink-2">Nothing open in this project.</p> : null}
        {sheets}
      </div>
    );
  }

  const active = (projects ?? []).filter((p) => p.status === 'active');
  return (
    <div>
      <h1 className="text-title font-semibold">To-do</h1>
      <div role="tablist" className="mt-8 flex flex-wrap gap-8">
        {TODOS_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => navigate(t === 'todos' ? '/p/todos' : `/p/todos?tab=${t}`)}
            className={`min-h-44 px-12 ${tab === t ? 'font-medium text-ink underline' : 'text-ink-2'}`}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      {tab === 'projects' ? (
        <Projects projects={projects} api={api} run={run} shared={me.agreement?.see.todos === true} owner={owner} />
      ) : (
        <>
          <AddTodo api={api} run={run} projects={active} reminder={tab === 'reminders'} />
          {alert}
          {(() => {
            const list = (todos ?? []).filter((t) => tab !== 'reminders' || t.due?.time !== undefined);
            return list.length ? rows(list) : todos ? <p className="mt-12 text-ink-2">{tab === 'reminders' ? 'No reminders.' : 'Nothing open.'}</p> : null;
          })()}
        </>
      )}
      {tab === 'projects' ? alert : null}
      {sheets}
    </div>
  );
}

/** Add a to-do: a title, an optional day and time, and one of her active projects (or the page's own). */
function AddTodo({ api, run, projects, projectId, reminder = false }: { api: PersonApi; run: (p: Promise<unknown>) => void; projects: readonly ProjectView[]; projectId?: string; reminder?: boolean }) {
  const [title, setTitle] = useState('');
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');
  const [pick, setPick] = useState('');
  const into = projectId ?? (pick || undefined);
  return (
    <form
      className="mt-12 flex flex-col gap-8"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        const due = day ? { day, ...(time ? { time } : {}) } : undefined;
        run(
          api.createTodo({ title: title.trim(), ...(due ? { due } : {}), ...(into ? { projectId: into } : {}) }).then(() => {
            setTitle('');
            setDay('');
            setTime('');
          }),
        );
      }}
    >
      <div className="flex gap-8">
        <input aria-label={reminder ? 'New reminder' : 'New to-do'} className={`${field} min-w-0 flex-1`} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
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
          <span className="text-small text-ink-2">{reminder ? 'Time: it rings your phone' : 'Time: a reminder (optional)'}</span>
          <input type="time" className={field} value={time} disabled={!day} onChange={(e) => setTime(e.target.value)} />
        </label>
        {!projectId && projects.length ? (
          <label className="flex flex-col gap-4">
            <span className="text-small text-ink-2">Project (optional)</span>
            <select className={field} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">None</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.emoji ? `${p.emoji} ` : ''}
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
    </form>
  );
}

/** Her projects: New project, the active ones (a tap opens one), then the archived ones. */
function Projects({ projects, api, run, shared, owner }: { projects: ProjectView[] | null; api: PersonApi; run: (p: Promise<unknown>) => void; shared: boolean; owner: string }) {
  const [name, setName] = useState('');
  if (!projects) return <p className="mt-12 text-ink-2">Loading…</p>;
  const active = projects.filter((p) => p.status === 'active');
  const archived = projects.filter((p) => p.status !== 'active');
  const row = (p: ProjectView) => (
    <li key={p.id}>
      <a
        href={`/p/todos?project=${p.id}`}
        className="flex min-h-44 flex-wrap items-center justify-between gap-x-8 py-8"
        onClick={(e) => {
          e.preventDefault();
          navigate(`/p/todos?project=${p.id}`);
        }}
      >
        <span className="min-w-0 break-words">
          {p.emoji ? `${p.emoji} ` : ''}
          {p.name}
        </span>
        <span className="text-small text-ink-2">{projectCounts(p)}</span>
      </a>
    </li>
  );
  return (
    <div className="mt-12">
      <form
        className="flex gap-8"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n) return;
          run(api.projectCreate({ name: n }).then(() => setName('')));
        }}
      >
        <input aria-label="New project" placeholder="New project" className={`${field} min-w-0 flex-1`} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="primary" className="min-h-44" disabled={!name.trim()}>
          Add
        </Button>
      </form>
      {shared ? <p className="mt-8 text-small text-ink-2">{owner} sees your projects with your to-dos.</p> : null}
      {active.length ? <ul className="mt-12 divide-y divide-line">{active.map(row)}</ul> : <p className="mt-12 text-ink-2">No projects yet. A project groups to-dos, like "Garden" or "Move house".</p>}
      {archived.length ? (
        <>
          <h2 className="mt-16 font-semibold">Archived</h2>
          <ul className="divide-y divide-line">{archived.map(row)}</ul>
        </>
      ) : null}
    </div>
  );
}

/** One project's head: its name and counts; Rename, Archive or Bring back, and Delete (a second tap; its to-dos stay). */
function ProjectPage({ p, api, run }: { p: ProjectView; api: PersonApi; run: (p: Promise<unknown>) => void }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(p.name);
  const [sure, setSure] = useState(false);
  const archived = p.status !== 'active';
  return (
    <div className="mt-8">
      <h1 className="break-words text-title font-semibold">
        {p.emoji ? `${p.emoji} ` : ''}
        {p.name}
      </h1>
      <p className="text-small text-ink-2">
        {archived ? 'Archived · ' : ''}
        {projectCounts(p)}
      </p>
      <div className="mt-8 flex flex-wrap gap-8">
        <Button variant="outline" className="min-h-44" onClick={() => (setName(p.name), setRenaming(true))}>
          Rename
        </Button>
        <Button variant="outline" className="min-h-44" onClick={() => run(api.projectUpdate(p.id, { status: archived ? 'active' : 'done' }))}>
          {archived ? 'Bring back' : 'Archive'}
        </Button>
        <Button
          variant="text"
          className="min-h-44"
          onClick={() => {
            if (!sure) return setSure(true);
            run(api.projectDelete(p.id).then(() => navigate('/p/todos?tab=projects')));
          }}
        >
          {sure ? 'Tap again: its to-dos stay, with no project' : 'Delete project'}
        </Button>
      </div>
      <Sheet open={renaming} onOpenChange={(o) => !o && setRenaming(false)} title="Rename project">
        <div className="flex flex-col gap-12 pb-24">
          <Field label="Name" value={name} onChange={setName} max={60} />
          <Button
            variant="primary"
            size="xl"
            disabled={!name.trim() || name.trim() === p.name}
            onClick={() => {
              run(api.projectUpdate(p.id, { name: name.trim() }));
              setRenaming(false);
            }}
          >
            Save
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
