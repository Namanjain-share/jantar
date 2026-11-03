/**
 * 0.13.0 A project as a hub (design 6.2 "A project (hub)", W41): one read,
 * `GET /v1/projects/:id` (W21), then, top to bottom:
 *
 *   the client (while Work is on, a link to it) and the due day
 *   [ Active | Paused | Done ]
 *   the health line: "1 overdue · next: Send wireframes Thu · 5 done this
 *     week · quiet 16 days" (ember only for overdue)
 *   milestones, done of all with the next one (P3, while it has some)
 *   the deal (P3, a link to it) with its stage and next step
 *   Todos (the Todos rows: done, snooze, edit, delete with Undo; + adds one
 *     in this project), then the newest done
 *   Sessions in its folder (the Board's own state), with "New session
 *     here" while Launch is on and this device may start one
 *   Meetings in the project (`GET /v1/meetings?project=`, while Meetings is on)
 *   Log (P2: calls, meetings and notes with its client), Notes
 *   Folder, with "Open folder in Files" while Files is on
 *
 * From a pane of 640 the parts are cards side by side (kit/Columns.tsx).
 * Beside the list it has Close (Esc too); alone, "‹ Projects".
 */
import { CaretLeftIcon, CaretRightIcon, FolderOpenIcon, PlusIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useCallback, useMemo, useRef } from 'react';
import type { FilesRootsResponse, MeetingsList, ProjectStatus, ProjectView, Todo } from '@jantar/protocol';
import type { ProjectHub as Hub } from '@jantar/protocol/work';
import { formatAmount } from '../../../lib/money.js';
import { routePath } from '../../../lib/router.js';
import { useApp, useDeps, useNow } from '../../context.js';
import { Button, buttonClass } from '../../kit/Button.js';
import { Columns, useCardWidth } from '../../kit/Columns.js';
import { glyphStateOf } from '../../kit/glyph.js';
import { Panel } from '../../kit/Panel.js';
import { PaneClose, usePaneClose } from '../../kit/PaneClose.js';
import { StatusGlyph } from '../../kit/StatusGlyph.js';
import { useFeatures } from '../../shell/data.js';
import { Link } from '../../shell/Link.js';
import { readLocalDevice } from '../devices/local.js';
import { Segmented } from '../accounts/Segmented.js';
import { dayLabel } from '../life/shared/DayNav.js';
import { LifeEmpty, NotSaved } from '../life/shared/states.js';
import { useLifeLoad, useLifeStatus } from '../life/shared/useLife.js';
import { AddButton, LineBar, Loaded, Page, clockIn, useLifeClock, useOffline, useSheet, useWrite } from '../life/today/parts.js';
import { useTodoActions } from '../life/todos/actions.js';
import { liveIn, projectLabel, projectOverdue } from '../life/todos/model.js';
import { ProjectSheet, STATUS_SEGMENTS } from '../life/todos/ProjectSheet.js';
import { DoneRow, TodoRow } from '../life/todos/TodoRow.js';
import { TodoSheet } from '../life/todos/TodoSheet.js';
import { workClient } from './client.js';
import { filesHref, healthParts, logLine, newSessionHref } from './model.js';

export interface ProjectHubProps {
  id: string;
  /** The list's address ("‹ Projects"). */
  back: string;
  /** His projects, for the todo sheet's project picker. */
  projects?: readonly ProjectView[];
  /** A write here changed the list's rows (status, counts). */
  onChanged: () => void;
  onDeleted: () => void;
}

/** This browser was paired with `scope` (no record of its pairing: taken to have it, as the places do). */
function mayDo(scope: 'launch'): boolean {
  const scopes = readLocalDevice()?.scopes;
  return !Array.isArray(scopes) || scopes.includes(scope);
}

export function ProjectHub({ id, back, projects = [], onChanged, onDeleted }: ProjectHubProps) {
  const { api } = useDeps();
  const offline = useOffline();
  const features = useFeatures();
  const { status } = useLifeStatus();
  const load = useLifeLoad(`work:project:${id}`, () => workClient(api).projectHub(id));
  const hub = load.data;
  const project = hub?.project ?? null;
  const meetings = useLifeLoad<MeetingsList>(features.meetings ? `work:meetings:${id}` : null, () => api.meetingsList({ project: id, limit: 10 }));
  // The Mac's roots place the folder for "New session here" and "Open folder in Files" (the same roots in both).
  const rootsOn = Boolean(project?.folder) && (features.launch || features.files);
  const roots = useLifeLoad<FilesRootsResponse>(rootsOn ? `work:roots:${features.launch ? 'launch' : 'files'}` : null, () => (features.launch ? api.foldersRoots() : api.filesRoots()));
  const reloadHub = load.reload;
  const reload = useCallback(() => {
    reloadHub();
    onChanged();
  }, [reloadHub, onChanged]);
  const actions = useTodoActions(reload);
  const now = useLifeClock(status);
  const state = useApp((s) => s.state);
  const nowMs = useNow();
  const write = useWrite();
  const todoSheet = useSheet<Todo>();
  const projectSheet = useSheet<ProjectView>();
  const close = usePaneClose();
  const box = useRef<HTMLDivElement>(null);
  const cards = useCardWidth(box);
  const live = useMemo(() => liveIn(Object.values(state.sessions), project?.folder), [state.sessions, project?.folder]);

  const setStatus = (next: ProjectStatus) => {
    if (!project || next === project.status || offline) return;
    void write.run(`status:${next}`, (key) => api.projectUpdate(project.id, { status: next }, key)).then((r) => r.ok && reload());
  };

  const backLink = close ? (
    <div className="flex">
      <PaneClose onClick={close} className="ml-auto" />
    </div>
  ) : (
    <Link href={back} className="inline-flex h-32 items-center gap-4 rounded-btn px-8 type-small text-ink-2 hover:bg-hover hover:text-ink coarse:h-44">
      <CaretLeftIcon size={16} aria-hidden="true" />
      Projects
    </Link>
  );
  const aside = project ? (
    <>
      <Button size="sm" className="coarse:min-w-44" disabled={offline} onClick={() => projectSheet.show(project)}>
        Edit
      </Button>
      <AddButton label="Add todo" disabled={offline} onClick={() => todoSheet.show(null)} />
    </>
  ) : null;

  return (
    <Page title={project ? projectLabel(project) : 'Project'} back={backLink} aside={aside} undo={actions.undo} wide>
      <div ref={box}>
        <Loaded load={load}>
          {(h) => (
            <>
              <Summary hub={h} today={now.day} />
              <div className="px-16 pb-12 @md:max-w-560">
                {/* Segmented has no disabled state of its own; a disabled fieldset turns its buttons off while offline. */}
                <fieldset disabled={offline} className="min-w-0 disabled:opacity-40">
                  <Segmented<ProjectStatus> label="Status" fill value={h.project.status} onChange={setStatus} segments={STATUS_SEGMENTS} />
                </fieldset>
                {write.error ? <NotSaved error={write.error} /> : null}
              </div>
              <Health hub={h} now={now} />
              {(() => {
                const folder = h.project.folder;
                const rootList = roots.data?.roots ?? [];
                const newHere = features.launch && mayDo('launch') ? newSessionHref(folder, rootList, live) : null;
                const inFiles = features.files ? filesHref(folder, rootList) : null;
                const open = actions.visible(h.open);
                const done = actions.visible(h.recentDone);
                const parts = [
                  <Panel key="todos" label="Todos" name="Its todos" count={open.length} card={cards}>
                    {actions.error ? (
                      <div className="px-16">
                        <NotSaved error={actions.error} />
                      </div>
                    ) : null}
                    {open.length === 0 ? (
                      <LifeEmpty>No open todos in this project.</LifeEmpty>
                    ) : (
                      <ul>
                        {open.map((t) => (
                          <TodoRow key={t.id} todo={t} now={now} offline={offline} actions={actions} onEdit={(x) => todoSheet.show(x)} />
                        ))}
                      </ul>
                    )}
                  </Panel>,
                  done.length ? (
                    <Panel key="done" label="Recently done" aside={h.doneThisWeek ? `${h.doneThisWeek} this week` : undefined} card={cards}>
                      <ul>
                        {done.map((t) => (
                          <DoneRow key={t.id} todo={t} offline={offline} actions={actions} />
                        ))}
                      </ul>
                    </Panel>
                  ) : null,
                  folder ? (
                    <Panel key="sessions" label="Sessions" name="Sessions in its folder" count={live.length} card={cards}>
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
                      {newHere ? (
                        <div className="px-16 py-12">
                          <Link href={newHere} className={buttonClass('outline', 'md', 'coarse:min-h-44')}>
                            <PlusIcon size={16} aria-hidden="true" />
                            New session here
                          </Link>
                        </div>
                      ) : null}
                    </Panel>
                  ) : null,
                  features.meetings ? (
                    <Panel key="meetings" label="Meetings" count={meetings.data?.meetings.length} card={cards}>
                      <Loaded load={meetings} count={2}>
                        {(m) =>
                          m.meetings.length === 0 ? (
                            <LifeEmpty>No meetings in this project yet.</LifeEmpty>
                          ) : (
                            <ul>
                              {m.meetings.map((x) => (
                                <li key={x.id} className="border-b border-line">
                                  <Link href={routePath({ name: 'meetings', id: x.id })} className="flex min-h-44 items-center gap-8 px-16 py-8 transition-colors duration-120 ease-hover hover:bg-hover">
                                    <span className="min-w-0 flex-1 truncate type-row text-ink">{x.name}</span>
                                    <span className="flex-none type-mono text-ink-3">{dayLabel(clockIn(Date.parse(x.startedAt), status?.timezone).day).replace(/^\w+ /, '')}</span>
                                    <CaretRightIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          )
                        }
                      </Loaded>
                    </Panel>
                  ) : null,
                  h.log ? (
                    <Panel key="log" label="Log" count={h.log.length} card={cards}>
                      {h.log.length === 0 ? (
                        <LifeEmpty>Nothing logged with its client yet.</LifeEmpty>
                      ) : (
                        <ul>
                          {h.log.map((row) => {
                            const l = logLine(row, status?.timezone);
                            return (
                              <li key={row.id} className="border-b border-line px-16 py-10">
                                <span className="block truncate type-mono text-ink-2">{l.line}</span>
                                {l.body ? <span className="mt-2 line-clamp-2 block whitespace-pre-wrap break-words type-small text-ink-2">{l.body}</span> : null}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </Panel>
                  ) : null,
                  h.project.notes ? (
                    <Panel key="notes" label="Notes" card={cards}>
                      <p className="whitespace-pre-wrap px-16 py-12 type-small text-ink-2">{h.project.notes}</p>
                    </Panel>
                  ) : null,
                  <Panel key="folder" label="Folder" card={cards}>
                    <p className="break-all px-16 py-10 type-mono text-ink">{folder ?? 'None'}</p>
                    {inFiles ? (
                      <div className="px-16 pb-12">
                        <Link href={inFiles} className={buttonClass('outline', 'md', 'coarse:min-h-44')}>
                          <FolderOpenIcon size={16} aria-hidden="true" />
                          Open folder in Files
                        </Link>
                      </div>
                    ) : null}
                  </Panel>,
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
          )}
        </Loaded>
      </div>
      <TodoSheet
        open={todoSheet.open}
        onOpenChange={todoSheet.onOpenChange}
        sheetKey={todoSheet.key}
        todo={todoSheet.item}
        projects={projects.length ? projects : project ? [project] : []}
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
        onDeleted={onDeleted}
      />
    </Page>
  );
}

/** Under the title: the client (a link to it) and the due day; then the deal and the milestones (P3), each only when there is one. */
function Summary({ hub, today }: { hub: Hub; today: string }) {
  const p = hub.project;
  const late = projectOverdue(p, today);
  const facts = [
    hub.client ? (
      <Link key="client" href={routePath({ name: 'work', tab: 'clients', id: hub.client.id })} className="inline-flex h-32 items-center gap-2 type-small text-ink hover:underline coarse:h-44">
        {hub.client.name}
        <CaretRightIcon size={12} aria-hidden="true" className="text-ink-3" />
      </Link>
    ) : null,
    p.due ? (
      <span key="due" className={clsx('type-mono', late ? 'text-signal-text' : 'text-ink-3')}>
        due {dayLabel(p.due).replace(/^\w+ /, '')}
      </span>
    ) : null,
  ].filter((x) => x !== null);
  const ms = hub.milestones;
  const nextMs = ms?.next ? ms.items.find((m) => m.id === ms.next) : undefined;
  return (
    <>
      {facts.length ? (
        <p className="flex flex-wrap items-center gap-x-8 px-16 pb-8">
          {facts.map((f, i) => (
            <span key={i} className="inline-flex items-center gap-8">
              {i > 0 ? (
                <span aria-hidden="true" className="text-ink-3">
                  ·
                </span>
              ) : null}
              {f}
            </span>
          ))}
        </p>
      ) : null}
      {hub.deal ? (
        <Link
          href={routePath({ name: 'work', tab: 'deals', id: hub.deal.id })}
          data-deal={hub.deal.id}
          className="mx-16 mb-8 flex min-h-44 items-center gap-8 rounded-btn border border-line px-12 py-8 transition-colors duration-120 ease-hover hover:bg-hover"
        >
          <span className="flex-none type-rail text-ink-3">Deal</span>
          <span className="min-w-0 flex-1 truncate type-row text-ink">
            {hub.deal.stageName}
            {hub.deal.value !== undefined ? <span className="type-mono text-ink-2"> · {formatAmount(hub.deal.value, hub.deal.currency)}</span> : null}
          </span>
          {hub.deal.kind === 'open' && !hub.deal.next ? <span className="flex-none type-mono text-ink-3">no next step</span> : null}
          <CaretRightIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
        </Link>
      ) : null}
      {ms && ms.items.length ? (
        <div data-milestones className="px-16 pb-8">
          <p className="flex items-baseline gap-8 type-small text-ink-2">
            <span className="type-rail text-ink-3">Milestones</span>
            <span className="type-mono">
              {ms.done} of {ms.items.length} · {ms.percent}%
            </span>
            {nextMs ? <span className="min-w-0 truncate">next: {nextMs.name}{nextMs.target ? ` · ${dayLabel(nextMs.target).replace(/^\w+ /, '')}` : ''}</span> : null}
          </p>
          <LineBar value={ms.done} max={ms.items.length} className="mt-6 @md:max-w-560" />
        </div>
      ) : null}
    </>
  );
}

/** The health line (W41): ember only for what is overdue. */
function Health({ hub, now }: { hub: Hub; now: ReturnType<typeof useLifeClock> }) {
  const parts = healthParts(hub, now);
  return (
    <p data-health className="flex flex-wrap items-center gap-x-6 px-16 pb-12 type-mono text-ink-2">
      {parts.map((p, i) => (
        <span key={p.key} className="inline-flex items-center gap-6">
          {i > 0 ? <span aria-hidden="true">·</span> : null}
          <span className={p.ember ? 'text-signal-text' : undefined}>{p.text}</span>
        </span>
      ))}
    </p>
  );
}
