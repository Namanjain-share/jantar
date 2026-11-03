/**
 * 0.13.0 One deal as a hub (design 6.2, 4.5, W21, W33): one read,
 * `GET /v1/work/deals/:id`, then, top to bottom:
 *
 *   ‹ Deals                                       Edit ···
 *   Site rebuild
 *   Acme › · Proposal sent · 12 days in stage    (imported: marked so)
 *   ₹4,50,000 · closes 30 Nov · Referral · AMG   the close day ember once it passed
 *   [ Move to… ]                                 an open deal; a closed one: [ Reopen… ]
 *   Quiet: no move and no touch in its stage's quiet days
 *   Lost · Price — "Went with a cheaper quote."  Change reason (a lost deal)
 *   NEXT  Call about scope · Thu 15:00   ✓       its earliest follow-up, else "No next step"
 *   [ Log a call or meeting ]                    the client's Log sheet, the entry this deal's
 *   FOLLOW-UPS   the Todos rows; + Next step (this client and deal)
 *   PROJECT      the project it became, to its hub
 *   LOG          stage moves (by the stages' names) and what was logged with it
 *
 * ··· holds Move to…, Mark won, Mark lost, Reopen and Delete (a Confirm:
 * its log of moves goes; a call or note logged with it stays on the client,
 * its follow-ups stay with no deal; no Undo). With a keyboard: m moves, l
 * logs, n sets a next step, e edits.
 *
 * From a pane of 640 the parts are cards side by side (kit/Columns.tsx).
 * Beside the list it has Close (Esc too); alone, "‹ Deals".
 */
import { CaretLeftIcon, CaretRightIcon, CheckIcon, PlusIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { lazy, Suspense, useCallback, useMemo, useRef, type ReactNode } from 'react';
import type { ProjectView, Todo } from '@jantar/protocol';
import { routePath } from '../../../lib/router.js';
import { useDeps, useToast } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Columns, useCardWidth } from '../../kit/Columns.js';
import { IconButton } from '../../kit/IconButton.js';
import { Panel } from '../../kit/Panel.js';
import { PaneClose, usePaneClose } from '../../kit/PaneClose.js';
import { Sheet } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { dialogOpen, useKey } from '../../shell/keys.js';
import { useLayout } from '../../shell/layout.js';
import { Link } from '../../shell/Link.js';
import { LifeEmpty, NotSaved } from '../life/shared/states.js';
import { useLifeLoad, useLifeStatus } from '../life/shared/useLife.js';
import { Loaded, Page, RowMenu, SheetActions, clockIn, useLifeClock, useOffline, useSheet, useWrite } from '../life/today/parts.js';
import { useTodoActions } from '../life/todos/actions.js';
import { ProjectRow } from '../life/todos/ProjectRow.js';
import { TodoRow } from '../life/todos/TodoRow.js';
import { TodoSheet } from '../life/todos/TodoSheet.js';
import { workClient } from './client.js';
import { clientPath } from './clientModel.js';
import { moveDeal, useDealMove, type StageRef } from './DealMove.js';
import { DealSheet } from './DealSheet.js';
import { closeText, closedText, daysInStageText, lostLabel, valueText } from './dealModel.js';
import { dueWord, logLine } from './model.js';
import { Framed, FromTag } from './parts.js';

// The Log sheet is the clients' chunk: a deal loads it on its first Log.
const LogSheet = lazy(() => import('./LogSheet.js').then((m) => ({ default: m.LogSheet })));

export interface DealHubProps {
  id: string;
  /** The list's address ("‹ Deals"). */
  back: string;
  /** The stages in order (the pipeline's columns), for Move to… and the log's names. */
  stages: readonly StageRef[];
  /** A write here changed the list's cards. */
  onChanged: () => void;
  onDeleted: () => void;
}

export function DealHub({ id, back, stages, onChanged, onDeleted }: DealHubProps) {
  const { api } = useDeps();
  const w = useMemo(() => workClient(api), [api]);
  const toast = useToast();
  const offline = useOffline();
  const { status } = useLifeStatus();
  const now = useLifeClock(status);
  const load = useLifeLoad(`work:deal:${id}`, () => w.deal(id));
  const hub = load.data;
  const reloadHub = load.reload;
  const reload = useCallback(() => {
    reloadHub();
    onChanged();
  }, [reloadHub, onChanged]);
  const actions = useTodoActions(reload);
  const flow = useDealMove({ stages, undo: actions.undo, onMoved: reload });
  const write = useWrite();
  const edit = useSheet<null>();
  const log = useSheet<null>();
  const todoSheet = useSheet<Todo>();
  const confirm = useSheet<null>();
  const close = usePaneClose();
  const box = useRef<HTMLDivElement>(null);
  const moveButton = useRef<HTMLButtonElement>(null);
  const cards = useCardWidth(box);
  const projects = useLifeLoad<{ projects: ProjectView[] }>(todoSheet.open ? 'projects' : null, () => api.projectsList());
  const names = useMemo(() => new Map(stages.map((s) => [s.id, s.name])), [stages]);
  const card = hub?.card;
  const move = () => {
    if (card && !offline) flow.choose(moveDeal(card), moveButton.current);
  };
  const toKind = (kind: 'won' | 'lost') => {
    const stage = stages.find((s) => s.kind === kind);
    if (card && stage) flow.to(moveDeal(card), stage.id);
  };

  // Design 6.4's keys with a keyboard: m moves, l logs, n sets a next step, e edits (none while a sheet or menu is open).
  useKey(
    ['m', 'l', 'n', 'e'],
    (e) => {
      if (dialogOpen()) return;
      e.preventDefault();
      if (e.key === 'm') move();
      else if (e.key === 'l') log.show(null);
      else if (e.key === 'n') todoSheet.show(null);
      else edit.show(null);
    },
    useLayout().keyboard && Boolean(card) && !offline,
  );

  const remove = async () => {
    if (!hub || offline) return;
    const r = await write.run(`delete:${hub.deal.id}`, (key) => w.dealDelete(hub.deal.id, key));
    if (!r.ok) return;
    toast(`Deleted ${hub.deal.title}.`);
    confirm.close();
    onChanged();
    onDeleted();
  };

  const backLink = close ? (
    <div className="flex">
      <PaneClose onClick={close} className="ml-auto" />
    </div>
  ) : (
    <Link href={back} className="inline-flex h-32 items-center gap-4 rounded-btn px-8 type-small text-ink-2 hover:bg-hover hover:text-ink coarse:h-44">
      <CaretLeftIcon size={16} aria-hidden="true" />
      Deals
    </Link>
  );
  const isOpen = card?.kind === 'open';
  const aside = hub ? (
    <>
      <Button size="sm" className="coarse:min-w-44" disabled={offline} onClick={() => edit.show(null)}>
        Edit
      </Button>
      <RowMenu
        label={`More for ${hub.deal.title}`}
        disabled={offline}
        groups={[
          {
            items: [
              { label: isOpen ? 'Move to…' : 'Reopen…', onSelect: move },
              ...(isOpen
                ? [
                    { label: 'Mark won', onSelect: () => toKind('won') },
                    { label: 'Mark lost', onSelect: () => toKind('lost') },
                  ]
                : []),
              { label: 'Delete', onSelect: () => confirm.show(null) },
            ],
          },
        ]}
      />
    </>
  ) : null;

  return (
    <Page title={hub?.deal.title ?? 'Deal'} back={backLink} aside={aside} undo={actions.undo} wide>
      <div ref={box}>
        <Loaded load={load}>
          {(h) => {
            const c = h.card;
            const followUps = actions.visible(h.followUps);
            const first = followUps[0];
            const closeAt = closeText(c);
            const closedAt = closedText(c, (iso) => clockIn(Date.parse(iso), status?.timezone).day);
            const facts = [valueText(c), h.deal.source ?? null].filter((x): x is string => Boolean(x));
            const parts: ReactNode[] = [
              <Panel key="follow" label="Follow-ups" count={followUps.length} card={cards} aside={
                <Button variant="text" size="sm" className="coarse:min-h-44" disabled={offline} onClick={() => todoSheet.show(null)}>
                  <PlusIcon size={14} aria-hidden="true" />
                  Next step
                </Button>
              }>
                {actions.error ? (
                  <div className="px-16">
                    <NotSaved error={actions.error} />
                  </div>
                ) : null}
                {followUps.length === 0 ? (
                  <LifeEmpty>{c.kind === 'open' ? 'No follow-up. Add a next step so it isn’t forgotten.' : 'No open follow-up.'}</LifeEmpty>
                ) : (
                  <ul>
                    {followUps.map((t) => (
                      <TodoRow key={t.id} todo={t} now={now} offline={offline} actions={actions} onEdit={(x) => todoSheet.show(x)} />
                    ))}
                  </ul>
                )}
              </Panel>,
              h.project ? (
                <Panel key="project" label="Project" card={cards}>
                  <ul>
                    <ProjectRow project={h.project} today={now.day} live={0} href={routePath({ name: 'work', id: h.project.id })} />
                  </ul>
                </Panel>
              ) : null,
              <Panel key="log" label="Log" count={h.log.length} card={cards}>
                {h.log.length === 0 ? (
                  <LifeEmpty>Nothing logged with this deal yet.</LifeEmpty>
                ) : (
                  <ul aria-label="Its log">
                    {h.log.map((row) => {
                      const l = logLine(row, status?.timezone, names);
                      return (
                        <li key={row.id} data-log={row.id} data-kind={row.kind} className="border-b border-line px-16 py-10">
                          <span className="block truncate type-mono text-ink-2">{l.line}</span>
                          {row.from ? <FromTag from={row.from} className="mt-2 inline-block" /> : null}
                          {l.body ? (
                            <div className="mt-2">
                              <Framed from={row.from}>
                                <span className="line-clamp-4 block whitespace-pre-wrap break-words type-small text-ink-2">{l.body}</span>
                              </Framed>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Panel>,
            ].filter((x) => x !== null);
            return (
              <>
                <p className="flex flex-wrap items-center gap-x-8 gap-y-2 px-16 pb-4 type-small text-ink-2">
                  <Link href={clientPath(h.client.id)} className="inline-flex h-32 items-center gap-2 text-ink hover:underline coarse:h-44">
                    {h.client.name}
                    <CaretRightIcon size={12} aria-hidden="true" className="text-ink-3" />
                  </Link>
                  <FromTag from={h.client.from} />
                  <span data-stage className="type-mono text-ink">
                    {c.stageName}
                  </span>
                  {c.kind === 'open' ? <span className="type-mono text-ink-3">{daysInStageText(c.daysInStage)} in stage</span> : closedAt ? <span className="type-mono text-ink-3">{closedAt}</span> : null}
                  <FromTag from={h.deal.from} />
                </p>
                {facts.length || closeAt ? (
                  <p className="flex flex-wrap items-center gap-x-6 px-16 pb-8 type-mono text-ink-2">
                    {facts.map((f, i) => (
                      <span key={f} className="inline-flex items-center gap-6">
                        {i > 0 ? <span aria-hidden="true">·</span> : null}
                        {f}
                      </span>
                    ))}
                    {closeAt ? (
                      <span className={clsx('inline-flex items-center gap-6', closeAt.late && 'text-signal-text')}>
                        {facts.length ? <span aria-hidden="true">·</span> : null}
                        {closeAt.text}
                      </span>
                    ) : null}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-8 px-16 pb-12">
                  <Button ref={moveButton} disabled={offline || flow.busy} onClick={move} className="coarse:min-h-44">
                    {flow.busy ? <Spinner label="Moving" /> : null}
                    {c.kind === 'open' ? 'Move to…' : 'Reopen…'}
                  </Button>
                  {c.kind === 'open' ? (
                    <>
                      <Button variant="text" disabled={offline} onClick={() => toKind('won')} className="coarse:min-h-44">
                        Won
                      </Button>
                      <Button variant="text" disabled={offline} onClick={() => toKind('lost')} className="coarse:min-h-44">
                        Lost
                      </Button>
                    </>
                  ) : null}
                </div>
                {c.quiet ? <p className="px-16 pb-8 type-small text-ink-2">Quiet: no move and no word with the client in this stage’s quiet days.</p> : null}
                {c.kind === 'lost' ? (
                  <div data-lost className="mx-16 mb-8 flex flex-wrap items-center gap-8 rounded-btn border border-line px-12 py-8">
                    <span className="flex-none type-rail text-ink-3">Lost</span>
                    <span className="min-w-0 flex-1 type-small text-ink">
                      {lostLabel(h.deal.lostCode)}
                      {h.deal.lostNote ? <span className="text-ink-2"> · {h.deal.lostNote}</span> : null}
                    </span>
                    <Button variant="text" size="sm" className="coarse:min-h-44" disabled={offline} onClick={() => flow.editLost(moveDeal(c))}>
                      Change reason
                    </Button>
                  </div>
                ) : null}
                {first ? (
                  <div data-next className="mx-16 mb-8 flex min-h-44 items-center gap-8 rounded-btn border border-line pl-12 pr-4">
                    <span className="flex-none type-rail text-ink-3">Next</span>
                    <span className="min-w-0 flex-1 truncate type-row text-ink">
                      {first.title}
                      {first.due ? <span className="type-mono text-ink-2"> · {dueWord(first.due, now.day)}</span> : null}
                    </span>
                    <IconButton aria-label={`Mark done: ${first.title}`} disabled={offline || actions.busy.has(first.id)} onClick={() => actions.done(first)}>
                      <CheckIcon size={16} aria-hidden="true" />
                    </IconButton>
                  </div>
                ) : c.kind === 'open' ? (
                  <p data-next className="px-16 pb-8 type-small text-ink-2">
                    No next step.{c.next ? ` Its client’s: ${c.next.title}.` : ''}
                  </p>
                ) : null}
                <div className="px-16 pb-12">
                  <Button variant="primary" size="lg" className="w-full @md:w-auto" disabled={offline} onClick={() => log.show(null)}>
                    Log a call or meeting
                  </Button>
                </div>
                {cards ? (
                  <Columns min={340} className="px-16">
                    {parts}
                  </Columns>
                ) : (
                  parts
                )}
              </>
            );
          }}
        </Loaded>
      </div>
      {hub ? (
        <>
          <DealSheet open={edit.open} onOpenChange={edit.onOpenChange} sheetKey={edit.key} deal={hub} stages={stages} onSaved={reload} />
          {log.key ? (
            <Suspense fallback={null}>
              <LogSheet
                open={log.open}
                onOpenChange={log.onOpenChange}
                sheetKey={log.key}
                client={{ id: hub.client.id, name: hub.client.name }}
                deals={hub.card.kind === 'open' ? [hub.card] : []}
                start={{ ...(hub.card.kind === 'open' ? { dealId: hub.deal.id } : {}), ...(hub.deal.projectId ? { projectId: hub.deal.projectId } : {}) }}
                now={now}
                onSaved={reload}
              />
            </Suspense>
          ) : null}
          <TodoSheet
            open={todoSheet.open}
            onOpenChange={todoSheet.onOpenChange}
            sheetKey={todoSheet.key}
            todo={todoSheet.item}
            projects={projects.data?.projects ?? (hub.project ? [hub.project] : [])}
            clients={[{ id: hub.client.id, name: hub.client.name }]}
            now={now}
            start={{ contactId: hub.client.id, dealId: hub.deal.id, ...(hub.deal.projectId ? { projectId: hub.deal.projectId } : {}) }}
            onSaved={reload}
          />
          <Sheet open={confirm.open} onOpenChange={confirm.onOpenChange} title={`Delete ${hub.deal.title}?`}>
            <div className="flex flex-col gap-6" data-delete-lines>
              <p className="type-small text-ink-2">Deletes the deal and its stage moves.</p>
              <p className="type-small text-ink-2">A call or a note logged with it stays with {hub.client.name}, and its follow-ups stay, with no deal.</p>
              <p className="type-small text-ink-2">There is no Undo.</p>
            </div>
            {write.error ? <NotSaved error={write.error} /> : null}
            <SheetActions>
              <Button size="lg" className="flex-1" disabled={offline || write.busy} onClick={() => void remove()}>
                {write.busy ? <Spinner label="Deleting" /> : null}
                Delete
              </Button>
              <Button variant="text" size="lg" onClick={confirm.close}>
                Cancel
              </Button>
            </SheetActions>
          </Sheet>
        </>
      ) : null}
      {flow.element}
    </Page>
  );
}

