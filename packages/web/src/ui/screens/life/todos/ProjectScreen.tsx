/**
 * One project (`/todos?project=<id>`, v0.4 spec 5.3): its status as a
 * segmented control (Active | Paused | Done), its due day and folder, the
 * live sessions in that folder (tap opens one), its open todos (the same
 * rows as the Todos tab) and its notes. Edit opens the project sheet; +
 * adds a todo already in the project.
 */
import { CaretLeftIcon } from '@phosphor-icons/react';
import { useCallback, useMemo } from 'react';
import type { ProjectStatus, ProjectView, Todo } from '@jantar/protocol';
import { routePath } from '../../../../lib/router.js';
import { useApp, useDeps, useNavigate, useNow } from '../../../context.js';
import { glyphStateOf } from '../../../kit/glyph.js';
import { Button } from '../../../kit/Button.js';
import { RailLabel } from '../../../kit/RailLabel.js';
import { StatusGlyph } from '../../../kit/StatusGlyph.js';
import { Link } from '../../../shell/Link.js';
import { Segmented } from '../../accounts/Segmented.js';
import { dayLabel } from '../shared/DayNav.js';
import { LifeEmpty, NotSaved } from '../shared/states.js';
import { useLifeLoad, useLifeStatus } from '../shared/useLife.js';
import { AddButton, Loaded, Page, useLifeClock, useOffline, useSheet, useWrite } from '../today/parts.js';
import { useTodoActions } from './actions.js';
import { liveIn, projectLabel } from './model.js';
import { ProjectSheet, STATUS_SEGMENTS } from './ProjectSheet.js';
import { TodoRow } from './TodoRow.js';
import { TodoSheet } from './TodoSheet.js';

export function ProjectScreen({ id }: { id: string }) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const offline = useOffline();
  const { status } = useLifeStatus();
  const projects = useLifeLoad('projects', () => api.projectsList());
  const todos = useLifeLoad(`todos:project:${id}`, () => api.todosList({ project: id }));
  const reloadProjects = projects.reload;
  const reloadTodos = todos.reload;
  const reload = useCallback(() => {
    reloadProjects();
    reloadTodos();
  }, [reloadProjects, reloadTodos]);
  const actions = useTodoActions(reload);
  const now = useLifeClock(status, todos.data?.today);
  const state = useApp((s) => s.state);
  const nowMs = useNow();
  const write = useWrite();
  const todoSheet = useSheet<Todo>();
  const projectSheet = useSheet<ProjectView>();
  const project = projects.data?.projects.find((p) => p.id === id) ?? null;
  const live = useMemo(() => liveIn(Object.values(state.sessions), project?.folder), [state.sessions, project?.folder]);

  const setStatus = (next: ProjectStatus) => {
    if (!project || next === project.status || offline) return;
    void write.run(`status:${next}`, (key) => api.projectUpdate(project.id, { status: next }, key)).then((r) => r.ok && reload());
  };

  const back = (
    <Link href={routePath({ name: 'todos', tab: 'projects' })} className="inline-flex h-32 items-center gap-4 rounded-btn px-8 type-small text-ink-2 hover:bg-hover hover:text-ink coarse:h-44">
      <CaretLeftIcon size={16} aria-hidden="true" />
      Projects
    </Link>
  );
  const aside = project ? (
    <>
      <Button size="sm" disabled={offline} onClick={() => projectSheet.show(project)}>
        Edit
      </Button>
      <AddButton label="Add todo" disabled={offline} onClick={() => todoSheet.show(null)} />
    </>
  ) : null;

  return (
    <Page title={project ? projectLabel(project) : 'Project'} back={back} aside={aside} undo={actions.undo}>
      <Loaded load={projects}>
        {() =>
          !project ? (
            <LifeEmpty>This project is gone.</LifeEmpty>
          ) : (
            <>
              <div className="px-16 pb-12">
                {/* Segmented has no disabled state of its own; a disabled fieldset turns its buttons off while offline. */}
                <fieldset disabled={offline} className="min-w-0 disabled:opacity-40">
                  <Segmented<ProjectStatus> label="Status" fill value={project.status} onChange={setStatus} segments={STATUS_SEGMENTS} />
                </fieldset>
                {write.error ? <NotSaved error={write.error} /> : null}
              </div>
              <dl className="border-t border-line">
                <div className="flex gap-12 border-b border-line px-16 py-10">
                  <dt className="w-64 flex-none type-small text-ink-3">Due</dt>
                  <dd className="min-w-0 type-mono text-ink">{project.due ? dayLabel(project.due) : 'None'}</dd>
                </div>
                <div className="flex gap-12 border-b border-line px-16 py-10">
                  <dt className="w-64 flex-none type-small text-ink-3">Folder</dt>
                  <dd className="min-w-0 break-all type-mono text-ink">{project.folder ?? 'None'}</dd>
                </div>
              </dl>
              {project.folder ? (
                <section aria-label="Live sessions">
                  <RailLabel ground="bg" count={live.length}>
                    Live sessions
                  </RailLabel>
                  {live.length === 0 ? (
                    <LifeEmpty>No session is running in this folder.</LifeEmpty>
                  ) : (
                    <ul>
                      {live.map((s) => (
                        <li key={s.sid} className="border-b border-line">
                          <Link href={routePath({ name: 'session', sid: s.sid })} className="flex h-44 items-center gap-8 px-16 transition-colors duration-120 ease-hover hover:bg-hover">
                            <StatusGlyph state={glyphStateOf(state, s, nowMs)} />
                            <span className="min-w-0 truncate type-row font-medium text-ink">{s.folder}</span>
                            <span className="min-w-0 truncate type-row text-ink-2">{s.name}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ) : null}
              <section aria-label="Its todos">
                <RailLabel ground="bg" count={todos.data ? actions.visible(todos.data.todos).filter((t) => !t.doneAt).length : undefined}>
                  Todos
                </RailLabel>
                {actions.error ? (
                  <div className="px-16">
                    <NotSaved error={actions.error} />
                  </div>
                ) : null}
                <Loaded load={todos} count={2}>
                  {(d) => {
                    const open = actions.visible(d.todos).filter((t) => !t.doneAt);
                    return open.length === 0 ? (
                      <LifeEmpty>No todos in this project yet.</LifeEmpty>
                    ) : (
                      <ul>
                        {open.map((t) => (
                          <TodoRow key={t.id} todo={t} now={now} offline={offline} actions={actions} onEdit={(x) => todoSheet.show(x)} />
                        ))}
                      </ul>
                    );
                  }}
                </Loaded>
              </section>
              {project.notes ? (
                <section aria-label="Notes">
                  <RailLabel ground="bg">Notes</RailLabel>
                  <p className="whitespace-pre-wrap px-16 py-12 type-small text-ink-2">{project.notes}</p>
                </section>
              ) : null}
            </>
          )
        }
      </Loaded>
      <TodoSheet
        open={todoSheet.open}
        onOpenChange={todoSheet.onOpenChange}
        sheetKey={todoSheet.key}
        todo={todoSheet.item}
        projects={projects.data?.projects ?? []}
        now={now}
        start={{ projectId: id }}
        onSaved={reload}
      />
      <ProjectSheet
        open={projectSheet.open}
        onOpenChange={projectSheet.onOpenChange}
        sheetKey={projectSheet.key}
        project={projectSheet.item}
        onSaved={reload}
        onDeleted={() => navigate(routePath({ name: 'todos', tab: 'projects' }), { replace: true })}
      />
    </Page>
  );
}
