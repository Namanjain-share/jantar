/**
 * 0.13.0 Work › Projects (design 6.2-6.4): his projects (his own space's;
 * shared lists live with People) under Active, Paused and Done (Done
 * folded until opened), each the Todos row with its client and its next
 * due todo ("next Thu"), and a tap opens the project's hub (`?id=`,
 * ProjectHub.tsx). Two taps from the Board on a phone (it was four).
 *
 * A SplitPane ("work-projects", fill): with nothing open, a pane of 800 or
 * more shows a table (Name, Client, Status, Open, Overdue, Next, Due,
 * Live); a project opens beside the list (340, 440 from 1180), which is
 * then the rows with the open one current; below 800 and on a phone it
 * opens over the list with "‹ Projects". Editors are the Todos sheets (a
 * bottom sheet on a phone, a form sheet from 640).
 *
 * Projects · Clients sit under the title (parts.tsx WorkTabs).
 *
 * Empty (W28): "No projects yet." with "Start from your client folders"
 * (while Launch or Files can list his folders, SeedSheet.tsx) and "New
 * project"; under a list, the same sheet as a text button. Clients' names
 * come from `GET /v1/work/clients/names`.
 */
import { CaretDownIcon, CaretRightIcon, FolderPlusIcon, PlusIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useCallback, useMemo, useState } from 'react';
import type { ProjectView, Todo } from '@jantar/protocol';
import { routePath } from '../../../lib/router.js';
import { useApp, useDeps, useNavigate } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Panel } from '../../kit/Panel.js';
import { SplitPane, useSplit } from '../../kit/SplitPane.js';
import { useFeatures } from '../../shell/data.js';
import { useLayout } from '../../shell/layout.js';
import { Link } from '../../shell/Link.js';
import { EMPTY, LifeEmpty } from '../life/shared/states.js';
import { useLifeLoad, useLifeStatus, type LifeLoad } from '../life/shared/useLife.js';
import { AddButton, Loaded, Page, useLifeClock, useOffline, useSheet, type LifeClock } from '../life/today/parts.js';
import { dayLabel } from '../life/shared/DayNav.js';
import { liveIn, projectLabel, projectOverdue } from '../life/todos/model.js';
import { ProjectRow } from '../life/todos/ProjectRow.js';
import { ProjectSheet } from '../life/todos/ProjectSheet.js';
import { workClient } from './client.js';
import { STATUS_GROUPS, byStatus, dueWord, nextByProject } from './model.js';
import { ProjectHub } from './ProjectHub.js';
import { WorkTabs } from './WorkTabs.js';
import { SeedSheet } from './SeedSheet.js';

export function Projects({ id }: { id?: string | undefined }) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const projects = useLifeLoad('projects', () => api.projectsList());
  const todos = useLifeLoad('todos:open', () => api.todosList());
  const ids = useMemo(() => [...new Set((projects.data?.projects ?? []).flatMap((p) => (p.clientId ? [p.clientId] : [])))].sort(), [projects.data]);
  const names = useLifeLoad(ids.length ? `work:names:${ids.join(',')}` : null, () => workClient(api).clientNames(ids));
  const clients = useMemo(() => new Map((names.data?.clients ?? []).map((c) => [c.id, c.name])), [names.data]);
  const reloadProjects = projects.reload;
  const reloadTodos = todos.reload;
  const reload = useCallback(() => {
    reloadProjects();
    reloadTodos();
  }, [reloadProjects, reloadTodos]);
  const list = routePath({ name: 'work' });
  return (
    <SplitPane
      name="work-projects"
      list={<ProjectsList projects={projects} todos={todos.data?.todos ?? []} clients={clients} open={id ?? null} onSaved={reload} />}
      detail={id ? <ProjectHub key={id} id={id} back={list} projects={projects.data?.projects ?? []} onChanged={reload} onDeleted={() => navigate(list, { replace: true })} /> : null}
      selection={id}
      empty="fill"
      listLabel="All projects"
      detailLabel="Project"
      onClose={() => navigate(list, { replace: true })}
    />
  );
}

interface ProjectsListProps {
  projects: LifeLoad<{ projects: ProjectView[] }>;
  todos: readonly Todo[];
  clients: ReadonlyMap<string, string>;
  /** The project open beside the list. */
  open: string | null;
  onSaved: () => void;
}

/** The list's page: the groups as rows (a phone, beside an open project) or one table across a wide pane. */
function ProjectsList({ projects, todos, clients, open, onSaved }: ProjectsListProps) {
  const offline = useOffline();
  const phone = useLayout().chrome === 'phone';
  const split = useSplit();
  const table = !phone && Boolean(split?.split) && !split?.selected;
  const { status } = useLifeStatus();
  const now = useLifeClock(status);
  const sessions = useApp((s) => s.state.sessions);
  const features = useFeatures();
  // The folders come from Launch's browser or Files' (W40): with both off there is nothing to start from.
  const canSeed = features.launch || features.files;
  const sheet = useSheet<ProjectView>();
  const seed = useSheet<null>();
  const [showDone, setShowDone] = useState(false);
  const next = useMemo(() => nextByProject(todos), [todos]);

  const newButton = (
    <Button disabled={offline} onClick={() => sheet.show(null)}>
      <PlusIcon size={16} aria-hidden="true" />
      New project
    </Button>
  );
  const seedButton = canSeed ? (
    <Button variant="primary" disabled={offline} onClick={() => seed.show(null)}>
      <FolderPlusIcon size={16} aria-hidden="true" />
      Start from your client folders
    </Button>
  ) : null;

  return (
    <Page title="Work" aside={<AddButton label="New project" disabled={offline} onClick={() => sheet.show(null)} />} wide>
      <WorkTabs tab="projects" />
      <Loaded load={projects}>
        {(d) => {
          if (d.projects.length === 0)
            return (
              <LifeEmpty
                action={
                  <div className="flex flex-wrap gap-8">
                    {seedButton}
                    {newButton}
                  </div>
                }
              >
                {EMPTY.projects}
              </LifeEmpty>
            );
          const groups = byStatus(d.projects);
          const all = Object.values(sessions);
          const shown = STATUS_GROUPS.filter((g) => groups[g.status].length > 0);
          return (
            <div className={table ? 'flex flex-col gap-16 px-16 pt-4' : undefined}>
              {shown.map((g) => {
                const rows = groups[g.status];
                const folded = g.status === 'done' && !showDone;
                const fold =
                  g.status === 'done' ? (
                    <button
                      type="button"
                      aria-expanded={showDone}
                      onClick={() => setShowDone((v) => !v)}
                      className="inline-flex h-28 items-center gap-6 type-rail text-ink-3 transition-colors duration-120 ease-hover hover:text-ink coarse:h-44"
                    >
                      {showDone ? <CaretDownIcon size={12} aria-hidden="true" /> : <CaretRightIcon size={12} aria-hidden="true" />}
                      {showDone ? 'Hide' : 'Show'}
                    </button>
                  ) : undefined;
                return (
                  <Panel key={g.status} label={g.label} count={rows.length} aside={fold} card={table}>
                    {folded ? null : table ? (
                      <ProjectTable label={`${g.label} projects`} projects={rows} clients={clients} next={next} now={now} live={(p) => liveIn(all, p.folder).length} />
                    ) : (
                      <ul aria-label={`${g.label} projects`}>
                        {rows.map((p) => (
                          <ProjectRow
                            key={p.id}
                            project={p}
                            today={now.day}
                            live={liveIn(all, p.folder).length}
                            href={routePath({ name: 'work', id: p.id })}
                            client={p.clientId ? clients.get(p.clientId) : undefined}
                            nextDue={next.get(p.id)}
                            current={p.id === open}
                          />
                        ))}
                      </ul>
                    )}
                  </Panel>
                );
              })}
              {/* More of his folders later on, beside the projects there are (the sheet marks the ones they link). */}
              {canSeed ? (
                <div className={table ? undefined : 'px-8 pt-8'}>
                  <Button variant="text" className="coarse:min-h-44" disabled={offline} onClick={() => seed.show(null)}>
                    <FolderPlusIcon size={16} aria-hidden="true" />
                    Start from your client folders
                  </Button>
                </div>
              ) : null}
            </div>
          );
        }}
      </Loaded>
      <ProjectSheet open={sheet.open} onOpenChange={sheet.onOpenChange} sheetKey={sheet.key} project={sheet.item} onSaved={onSaved} />
      {canSeed ? <SeedSheet open={seed.open} onOpenChange={seed.onOpenChange} sheetKey={seed.key} projects={projects.data?.projects ?? []} onSaved={onSaved} /> : null}
    </Page>
  );
}

/** A wide pane with nothing open (D2): one row per project across the table's columns; the name is the row's link. */
function ProjectTable({
  label,
  projects,
  clients,
  next,
  now,
  live,
}: {
  label: string;
  projects: readonly ProjectView[];
  clients: ReadonlyMap<string, string>;
  next: ReadonlyMap<string, Todo>;
  now: LifeClock;
  live: (p: ProjectView) => number;
}) {
  const navigate = useNavigate();
  const cell = 'flex-none truncate type-mono';
  return (
    <div role="table" aria-label={label}>
      <div role="row" className="flex h-32 items-center gap-12 border-b border-line px-16 type-small text-ink-3">
        <span role="columnheader" className="min-w-0 flex-1">
          Name
        </span>
        <span role="columnheader" className="w-160 flex-none">
          Client
        </span>
        <span role="columnheader" className="w-56 flex-none text-right">
          Open
        </span>
        <span role="columnheader" className="w-64 flex-none text-right">
          Overdue
        </span>
        <span role="columnheader" className="w-120 flex-none">
          Next
        </span>
        <span role="columnheader" className="w-72 flex-none">
          Due
        </span>
        <span role="columnheader" className="w-40 flex-none text-right">
          Live
        </span>
      </div>
      {projects.map((p) => {
        const href = routePath({ name: 'work', id: p.id });
        const n = next.get(p.id);
        const late = projectOverdue(p, now.day);
        return (
          <div
            role="row"
            key={p.id}
            data-project={p.id}
            className="flex min-h-44 cursor-pointer items-center gap-12 border-b border-line px-16 transition-colors duration-120 ease-hover last:border-b-0 hover:bg-hover coarse:min-h-52"
            onClick={(e) => {
              if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e.target as Element).closest('a')) return;
              navigate(href);
            }}
          >
            <span role="cell" className="flex min-w-0 flex-1 self-stretch">
              <Link href={href} data-row={p.id} className="flex min-w-0 flex-1 items-center truncate py-6 type-row font-medium text-ink focus-visible:-outline-offset-2">
                {projectLabel(p)}
              </Link>
            </span>
            <span role="cell" className="w-160 flex-none truncate type-small text-ink-2">
              {p.clientId ? (clients.get(p.clientId) ?? '') : ''}
            </span>
            <span role="cell" className={clsx(cell, 'w-56 text-right text-ink-2')}>
              {p.open}
            </span>
            <span role="cell" className={clsx(cell, 'w-64 text-right', p.overdue > 0 ? 'text-signal-text' : 'text-ink-3')}>
              {p.overdue}
            </span>
            <span role="cell" className={clsx(cell, 'w-120 text-ink-2')}>
              {n?.due ? dueWord(n.due, now.day) : ''}
            </span>
            <span role="cell" className={clsx(cell, 'w-72', late ? 'text-signal-text' : 'text-ink-3')}>
              {p.due ? dayLabel(p.due).replace(/^\w+ /, '') : ''}
            </span>
            <span role="cell" className={clsx(cell, 'w-40 text-right text-ink-3')}>
              {live(p) || ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}
