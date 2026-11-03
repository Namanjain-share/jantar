/**
 * Todos, Reminders and Projects (v0.4 spec 5.3): `[ Todos | Reminders |
 * Projects ]` and a + that adds what the tab shows.
 *
 * - Todos: rails Overdue, Today, Upcoming, No date, then Done (collapsed;
 *   the newest 100 load when it opens). Done and Delete on a row show a
 *   5 s Undo (Delete asks nothing first).
 * - Reminders: open todos with a time, by when they ring (Reminders.tsx).
 *   + starts a todo with the time first, at the next full hour.
 * - Projects: each with its counts and live sessions (ProjectRow); a tap
 *   opens the project (`?project=`, ProjectScreen.tsx).
 *
 * `id` (from a push) opens the tab it belongs on (Reminders for a todo with
 * a time, unless a tab is asked for) and keeps it in the route, scrolls to
 * the row and holds --select on it for 2 s. The title is the page's <h1> in
 * every state.
 *
 * 0.12 (build plan 2.4): from a pane of 640 the rails are cards side by
 * side (kit/Columns.tsx, at least 340 wide: three at 1440), Reminders'
 * cards are Overdue, Today and Upcoming in the order they ring, and the
 * projects are a grid of cards. Below 640, 0.10's list.
 *
 * 0.13.0 (W20): while Work is on, projects are Work's: there is no Projects
 * tab here, and its address and a project's open in Work (the shell).
 */
import { CaretDownIcon, CaretRightIcon, PlusIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ProjectView, Todo } from '@jantar/protocol';
import { routePath, type TodosTab } from '../../../../lib/router.js';
import { useApp, useDeps, useNavigate } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Columns, useCardWidth } from '../../../kit/Columns.js';
import { Panel } from '../../../kit/Panel.js';
import { Segmented } from '../../accounts/Segmented.js';
import { EMPTY, LifeEmpty, NotSaved } from '../shared/states.js';
import { useLifeLoad, useLifeStatus } from '../shared/useLife.js';
import { AddButton, Loaded, Page, useLifeClock, useOffline, useSheet, type LifeClock } from '../today/parts.js';
import { useTodoActions, type TodoActions } from './actions.js';
import { byRail, liveIn, projectLabel, RAIL_LABEL, RAIL_ORDER } from './model.js';
import { ProjectRow } from './ProjectRow.js';
import { ProjectScreen } from './ProjectScreen.js';
import { ProjectSheet } from './ProjectSheet.js';
import { Reminders } from './Reminders.js';
import { DoneRow, TodoRow } from './TodoRow.js';
import { TodoSheet, type TodoStart } from './TodoSheet.js';
import { useLookingAt } from '../../../shell/lookingAt.js';

export interface TodosProps {
  tab?: TodosTab | undefined;
  project?: string | undefined;
  id?: string | undefined;
}

/** How long a todo opened from a push stays highlighted. */
export const FLASH_MS = 2_000;

export function Todos({ tab, project, id }: TodosProps) {
  if (project) return <ProjectScreen key={project} id={project} />;
  return <TodoLists tab={tab} id={id} />;
}

/** Highlight `id` for FLASH_MS once its row is on screen, and scroll to it. */
function useFlash(id: string | undefined, found: boolean): string | null {
  const [flash, setFlash] = useState<string | null>(null);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!id || !found || seen.current === id) return;
    seen.current = id;
    setFlash(id);
    requestAnimationFrame(() => document.querySelector(`[data-todo="${id}"]`)?.scrollIntoView({ block: 'center' }));
    const t = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [id, found]);
  return flash;
}

const TABS: { key: TodosTab; label: string }[] = [
  { key: 'todos', label: 'Todos' },
  { key: 'reminders', label: 'Reminders' },
  { key: 'projects', label: 'Projects' },
];

const STATUS_ORDER = { active: 0, paused: 1, done: 2 } as const;

function TodoLists({ tab: asked, id }: { tab?: TodosTab | undefined; id?: string | undefined }) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const offline = useOffline();
  const { status } = useLifeStatus();
  const todos = useLifeLoad('todos:open', () => api.todosList());
  const projects = useLifeLoad('projects', () => api.projectsList());
  const [showDone, setShowDone] = useState(false);
  const done = useLifeLoad(showDone ? 'todos:done' : null, () => api.todosList({ done: true }));
  const reloadTodos = todos.reload;
  const reloadProjects = projects.reload;
  const reloadDone = done.reload;
  const reload = useCallback(() => {
    reloadTodos();
    reloadProjects();
    reloadDone();
  }, [reloadTodos, reloadProjects, reloadDone]);
  const actions = useTodoActions(reload);
  const now = useLifeClock(status, todos.data?.today);
  const sessions = useApp((s) => s.state.sessions);
  const target = id ? todos.data?.todos.find((t) => t.id === id) : undefined;
  const opened: TodosTab | undefined = target ? (target.due?.time ? 'reminders' : 'todos') : undefined;
  const tab: TodosTab = asked ?? opened ?? 'todos';
  const tabs = status?.modules.work ? TABS.filter((t) => t.key !== 'projects') : TABS;
  // The push's tab goes into the route once its todo loads: done or deleted, the todo leaves the open list, and the screen stays put under its Undo line.
  useEffect(() => {
    if (!asked && id && opened) navigate(routePath({ name: 'todos', tab: opened, id }), { replace: true });
  }, [asked, id, opened, navigate]);
  const flash = useFlash(id, target !== undefined);
  // 0.12 (c29): a todo the address names is what Chat beside it is told you mean.
  useLookingAt(target ? { kind: 'todo', id: target.id, label: target.title } : null);
  const todoSheet = useSheet<Todo>();
  const [start, setStart] = useState<TodoStart | undefined>(undefined);
  const projectSheet = useSheet<ProjectView>();
  const pmap = useMemo(() => new Map((projects.data?.projects ?? []).map((p) => [p.id, p])), [projects.data]);
  // Cards from a pane of 640 (0.12), the 0.10 list below it: decided by the page's measured width.
  const box = useRef<HTMLDivElement>(null);
  const cards = useCardWidth(box);

  const add = () => {
    if (tab === 'projects') return projectSheet.show(null);
    setStart(tab === 'reminders' ? { reminder: true } : undefined);
    todoSheet.show(null);
  };
  const edit = (t: Todo) => {
    setStart(undefined);
    todoSheet.show(t);
  };
  const addLabel = tab === 'projects' ? 'Add project' : tab === 'reminders' ? 'Add reminder' : 'Add todo';
  const addButton = (
    <Button onClick={add} disabled={offline}>
      <PlusIcon size={16} aria-hidden="true" />
      {addLabel}
    </Button>
  );

  return (
    <Page title="Todos" aside={<AddButton label={addLabel} onClick={add} disabled={offline} />} undo={actions.undo} wide>
      <div className="px-16 pb-12 @md:max-w-560">
        <Segmented<TodosTab> label="Show" fill value={tab} onChange={(t) => navigate(routePath({ name: 'todos', tab: t }), { replace: true })} segments={tabs} />
      </div>
      {actions.error ? (
        <div className="px-16">
          <NotSaved error={actions.error} />
        </div>
      ) : null}
      <div ref={box}>
        {tab === 'projects' ? (
          <Loaded load={projects}>
            {(d) => {
              const list = [...d.projects].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
              if (list.length === 0) return <LifeEmpty action={addButton}>{EMPTY.projects}</LifeEmpty>;
              const all = Object.values(sessions);
              return (
                <ul aria-label="Projects" className={cards ? 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-12 px-16 pt-4' : 'border-t border-line'}>
                  {list.map((p) => (
                    <ProjectRow
                    key={p.id}
                    project={p}
                    today={now.day}
                    live={liveIn(all, p.folder).length}
                    card={cards}
                    next={cards ? actions.visible(todos.data?.todos ?? []).filter((t) => t.projectId === p.id && !t.doneAt) : undefined}
                  />
                  ))}
                </ul>
              );
            }}
          </Loaded>
        ) : (
          <Loaded load={todos}>
            {(d) =>
              tab === 'reminders' ? (
                <Reminders todos={actions.visible(d.todos)} projects={pmap} now={now} flash={flash} offline={offline} actions={actions} onEdit={edit} addButton={addButton} cards={cards} />
              ) : (
                <>
                  <TodoRails todos={actions.visible(d.todos)} projects={pmap} now={now} flash={flash} offline={offline} actions={actions} onEdit={edit} addButton={addButton} cards={cards} />
                  {cards ? <div className="h-16" /> : null}
                  <button
                    type="button"
                    aria-expanded={showDone}
                    onClick={() => setShowDone((v) => !v)}
                    className="flex h-28 w-full items-center gap-8 border-b border-line px-16 type-rail text-ink-3 transition-colors duration-120 ease-hover hover:text-ink coarse:h-44"
                  >
                    {showDone ? <CaretDownIcon size={12} aria-hidden="true" /> : <CaretRightIcon size={12} aria-hidden="true" />}
                    Done
                  </button>
                  {showDone ? (
                    <Loaded load={done} count={2}>
                      {(dd) =>
                        dd.todos.length === 0 ? (
                          <LifeEmpty>Nothing done yet.</LifeEmpty>
                        ) : (
                          <ul aria-label="Done">
                            {dd.todos.map((t) => (
                              <DoneRow key={t.id} todo={t} offline={offline} actions={actions} />
                            ))}
                          </ul>
                        )
                      }
                    </Loaded>
                  ) : null}
                </>
              )
            }
          </Loaded>
        )}
      </div>
      <TodoSheet
        open={todoSheet.open}
        onOpenChange={todoSheet.onOpenChange}
        sheetKey={todoSheet.key}
        todo={todoSheet.item}
        projects={projects.data?.projects ?? []}
        now={now}
        start={start}
        onSaved={reload}
      />
      <ProjectSheet open={projectSheet.open} onOpenChange={projectSheet.onOpenChange} sheetKey={projectSheet.key} project={projectSheet.item} onSaved={reload} />
    </Page>
  );
}

function TodoRails({
  todos,
  projects,
  now,
  flash,
  offline,
  actions,
  onEdit,
  addButton,
  cards,
}: {
  todos: readonly Todo[];
  projects: ReadonlyMap<string, ProjectView>;
  now: LifeClock;
  flash: string | null;
  offline: boolean;
  actions: TodoActions;
  onEdit: (todo: Todo) => void;
  addButton: ReactNode;
  /** 0.12: each rail a card, side by side. */
  cards: boolean;
}) {
  const rails = byRail(todos, now);
  if (RAIL_ORDER.every((r) => rails[r].length === 0)) return <LifeEmpty action={addButton}>{EMPTY.todos}</LifeEmpty>;
  const sections = RAIL_ORDER.filter((r) => rails[r].length > 0).map((r) => (
    // A plain count: each overdue row already carries its ember "overdue 2d" (TodoRow).
    <Panel key={r} label={RAIL_LABEL[r]} count={rails[r].length} card={cards}>
      <ul>
        {rails[r].map((t) => {
          const p = t.projectId ? projects.get(t.projectId) : undefined;
          return (
            <TodoRow
              key={t.id}
              todo={t}
              now={now}
              project={p ? projectLabel(p) : undefined}
              showDay={r !== 'today'}
              highlight={flash === t.id}
              offline={offline}
              actions={actions}
              onEdit={onEdit}
            />
          );
        })}
      </ul>
    </Panel>
  ));
  return cards ? (
    <Columns min={340} className="px-16 pt-4">
      {sections}
    </Columns>
  ) : (
    <>{sections}</>
  );
}
