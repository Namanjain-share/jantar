/**
 * One project (`/todos?project=<id>`, v0.4 spec 5.3): its status as a
 * segmented control (Active | Paused | Done), its due day and folder, the
 * live sessions in that folder (tap opens one), its open todos (the same
 * rows as the Todos tab) and its notes. Edit opens the project sheet; +
 * adds a todo already in the project.
 *
 * 0.11 (build plan 2.4): from a pane of 640 its parts are cards side by
 * side (Details, Live sessions, Todos, Notes), as on the Todos tab.
 */
import { CaretLeftIcon } from '@phosphor-icons/react';
import { useCallback, useMemo, useRef } from 'react';
import type { ProjectStatus, ProjectView, Todo } from '@jantar/protocol';
import { routePath } from '../../../../lib/router.js';
import { useApp, useDeps, useNavigate, useNow } from '../../../context.js';
import { glyphStateOf } from '../../../kit/glyph.js';
import { Button } from '../../../kit/Button.js';
import { Columns, useCardWidth } from '../../../kit/Columns.js';
import { Panel } from '../../../kit/Panel.js';
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
  // Cards from a pane of 640 (0.11), the 0.10 list below it.
  const box = useRef<HTMLDivElement>(null);
  const cards = useCardWidth(box);

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
    <Page title={project ? projectLabel(project) : 'Project'} back={back} aside={aside} undo={actions.undo} wide>
      <div ref={box}>
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
                {(() => {
                  const details = (
                    <dl className={cards ? undefined : 'border-t border-line'}>
                      <div className="flex gap-12 border-b border-line px-16 py-10">
                        <dt className="w-64 flex-none type-small text-ink-3">Due</dt>
                        <dd className="min-w-0 type-mono text-ink">{project.due ? dayLabel(project.due) : 'None'}</dd>
                      </div>
                      <div className="flex gap-12 border-b border-line px-16 py-10">
                        <dt className="w-64 flex-none type-small text-ink-3">Folder</dt>
                        <dd className="min-w-0 break-all type-mono text-ink">{project.folder ?? 'None'}</dd>
                      </div>
                    </dl>
                  );
                  const parts = [
                    cards ? (
                      <Panel key="details" label="Details" card>
                        {details}
                      </Panel>
                    ) : (
                      <div key="details">{details}</div>
                    ),
                    project.folder ? (
                      <Panel key="live" label="Live sessions" count={live.length} card={cards}>
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
                      </Panel>
                    ) : null,
                    <Panel key="todos" label="Todos" name="Its todos" count={todos.data ? actions.visible(todos.data.todos).filter((t) => !t.doneAt).length : undefined} card={cards}>
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
                    </Panel>,
                    project.notes ? (
                      <Panel key="notes" label="Notes" card={cards}>
                        <p className="whitespace-pre-wrap px-16 py-12 type-small text-ink-2">{project.notes}</p>
                      </Panel>
                    ) : null,
                  ].filter((x) => x !== null);
                  return cards ? (
                    <Columns min={340} className="px-16">
                      {parts}
                    </Columns>
                  ) : (
                    parts
                  );
                })()}
              </>
            )
          }
        </Loaded>
      </div>
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
