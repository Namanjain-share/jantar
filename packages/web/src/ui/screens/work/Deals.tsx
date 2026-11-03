/**
 * 0.13.0 Work › Deals (design 6.2-6.4, W32): his pipeline, a chunk of its
 * own (Work.tsx loads it on the first visit).
 *
 * A phone (and a pane under 800): a stage picker and that stage's deals,
 * never a wide board (W32).
 *
 *   Work                                        ··· +
 *   [ Projects | Clients | Deals ]
 *   Open ₹14,20,000 · weighted ₹7,90,000         Insights ›
 *   [New lead 3][Contacted 4][Proposal sent 2]…  a chip strip that scrolls (`?stage=`)
 *   PROPOSAL SENT · 2
 *   ₹6,50,000 open · ₹3,90,000 weighted          per currency, never added across (W17)
 *   ┌ Acme · Site rebuild            ₹4,50,000 ┐
 *   └ 12 days · next Thu · closes 30 Nov       ┘
 *
 * A wide pane with nothing open (D2): the board, one column per open stage
 * (240 at least, then the board scrolls sideways), each with its count,
 * open and weighted value per currency and how many are quiet; Won and
 * Lost are narrow columns of the last 30 days (a tap lists them). Opening
 * a deal turns the board into the deals grouped by stage beside it.
 *
 * Moving a deal never needs a drag: a card's ··· (a long press on touch)
 * has Move to…, Log, Next step and Open client, and `m` moves the focused
 * card with a keyboard (j/k and ↑↓ go through the cards, ←→ between
 * columns). On the board a mouse or trackpad can also drag a card onto a
 * column (a fine pointer only: on touch a drag fights the scroll, W32).
 * Won and Lost ask first (DealMove.tsx).
 *
 * Today's Work card opens the deals it counts (`?show=nostep|quiet|
 * closing`), one list with Clear. ··· holds Edit stages (StagesSheet.tsx,
 * loaded on first use) and Export CSV (the share sheet or a download).
 *
 * Every state of design 6.5: loading, empty ("No deals yet." with New deal;
 * a business with none, All businesses), an empty stage, Work off and
 * life.db broken (Work.tsx and the daemon's sentences), a failed load (Try
 * again), offline (the last pipeline stays; adding and moving are off).
 */
import { CaretRightIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { ProjectView } from '@jantar/protocol';
import type { WorkDealCard, WorkDealsResponse, WorkSettings, WorkStageColumn } from '@jantar/protocol/work';
import { errorText } from '../../../lib/api.js';
import type { Route, WorkDealsShow } from '../../../lib/router.js';
import { shareFile } from '../../../lib/share-file.js';
import { useDeps, useNavigate, useToast } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { justLongPressed, useLongPress, type PressGuard } from '../../kit/longPress.js';
import { Panel } from '../../kit/Panel.js';
import { SplitPane, useSplit } from '../../kit/SplitPane.js';
import { useLayout } from '../../shell/layout.js';
import { Link } from '../../shell/Link.js';
import { LifeEmpty } from '../life/shared/states.js';
import { useLifeLoad, useLifeStatus, type LifeLoad } from '../life/shared/useLife.js';
import { AddButton, Loaded, Page, RowMenu, useLifeClock, useOffline, useSheet, useUndo, type LifeClock } from '../life/today/parts.js';
import { TodoSheet } from '../life/todos/TodoSheet.js';
import { type WorkClient, workClient } from './client.js';
import { clientPath } from './clientModel.js';
import { DealHub } from './DealHub.js';
import { moveDeal, useDealMove, type MoveFlow, type StageRef } from './DealMove.js';
import { DealSheet } from './DealSheet.js';
import { INSIGHTS_PATH, SHOW_LABEL, byStage, closeText, daysInStageText, dealPath, firstStage, nextStepText, pipelineTotals, scrollToShow, showing, stageTotals, valueText } from './dealModel.js';
import { FromTag } from './parts.js';

// Each loads on first use: stage editing is rare, and the Log sheet is the clients' chunk.
const StagesSheet = lazy(() => import('./StagesSheet.js').then((m) => ({ default: m.StagesSheet })));
const LogSheet = lazy(() => import('./LogSheet.js').then((m) => ({ default: m.LogSheet })));

type WorkRoute = Extract<Route, { name: 'work' }>;

/** A deal dragged on the board carries its id as this type (a mouse or trackpad only). */
export const DEAL_DRAG = 'application/x-jantar-deal';

/** The query a Today filter asks: the daemon's own windows for quiet and closing this week; no next step is the open list's. */
const showQuery = (show: WorkDealsShow | undefined) => (show === 'quiet' ? { quiet: true } : show === 'closing' ? { closing: 'week' as const } : {});

/** `tabs`: Work's segments, which Work.tsx hands over (this chunk imports nothing of Work's own first chunk). */
export function Deals({ route, tabs }: { route: WorkRoute; tabs: ReactNode }) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const w = useMemo(() => workClient(api), [api]);
  const settings = useLifeLoad<WorkSettings>('work:settings', () => w.settings());
  const businesses = settings.data?.businesses ?? [];
  const [business, setBusiness] = useState<string>('');
  const { id, stage, show } = route;
  const query = { ...showQuery(show), ...(business ? { business } : {}) };
  const load = useLifeLoad(`work:deals:${JSON.stringify(query)}`, () => w.deals(query));
  // Won's and Lost's own lists (their column counts the last 30 days; the list is every one, newest first).
  const closedCol = stage ? load.data?.stages.find((s) => s.id === stage && s.kind !== 'open') : undefined;
  const closed = useLifeLoad(closedCol ? `work:deals:closed:${closedCol.id}:${business}` : null, () => w.deals({ open: false, stage: closedCol?.id, ...(business ? { business } : {}) }));
  const list = dealPath(undefined, { stage, show });
  const reloadOpen = load.reload;
  const reloadClosed = closed.reload;
  const reload = useMemo(
    () => () => {
      reloadOpen();
      reloadClosed();
    },
    [reloadOpen, reloadClosed],
  );
  const stages: StageRef[] = useMemo(() => (load.data?.stages ?? []).map((s) => ({ id: s.id, name: s.name, kind: s.kind })), [load.data]);
  return (
    <SplitPane
      name="work-deals"
      list={
        <DealsList
          w={w}
          tabs={tabs}
          load={load}
          closed={closedCol ? closed : null}
          stage={stage}
          show={show}
          businesses={businesses}
          business={business}
          onBusiness={setBusiness}
          open={id ?? null}
          onChanged={reload}
        />
      }
      detail={id ? <DealHub key={id} id={id} back={list} stages={stages} onChanged={reload} onDeleted={() => navigate(list, { replace: true })} /> : null}
      selection={id}
      empty="fill"
      listLabel="All deals"
      detailLabel="Deal"
      onClose={() => navigate(list, { replace: true })}
    />
  );
}

interface DealsListProps {
  w: WorkClient;
  tabs: ReactNode;
  load: LifeLoad<WorkDealsResponse>;
  /** Won's or Lost's own list, while one is the stage shown. */
  closed: LifeLoad<WorkDealsResponse> | null;
  stage: string | undefined;
  show: WorkDealsShow | undefined;
  businesses: WorkSettings['businesses'];
  business: string;
  onBusiness: (id: string) => void;
  open: string | null;
  onChanged: () => void;
}

/** The pipeline's page: its totals, then the board (a wide pane), the stages beside an open deal, or a stage at a time. */
function DealsList({ w, tabs, load, closed, stage, show, businesses, business, onBusiness, open, onChanged }: DealsListProps) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const toast = useToast();
  const offline = useOffline();
  const layout = useLayout();
  const phone = layout.chrome === 'phone';
  const split = useSplit();
  const board = !phone && Boolean(split?.split) && !split?.selected && !stage && !show;
  const beside = Boolean(split?.split && split.selected) && !stage && !show;
  const { status } = useLifeStatus();
  const now = useLifeClock(status);
  const undo = useUndo();
  const add = useSheet<null>();
  const stagesSheet = useSheet<null>();
  const stages: StageRef[] = useMemo(() => (load.data?.stages ?? []).map((s) => ({ id: s.id, name: s.name, kind: s.kind })), [load.data]);
  const flow = useDealMove({ stages, undo, onMoved: onChanged });
  const log = useSheet<WorkDealCard>();
  const next = useSheet<WorkDealCard>();
  // The todo sheet's project picker, once Next step opens it.
  const projects = useLifeLoad<{ projects: ProjectView[] }>(next.open ? 'projects' : null, () => api.projectsList());
  const actions: CardActions = {
    offline,
    flow,
    log: (c) => log.show(c),
    next: (c) => next.show(c),
    client: (c) => navigate(clientPath(c.client.id)),
  };

  const exportCsv = async () => {
    try {
      const csv = await w.exportDealsCsv();
      const r = await shareFile(new File([csv], 'jantar-deals.csv', { type: 'text/csv' }));
      if (r !== 'cancelled') toast('Deals exported.');
    } catch (e) {
      toast(`Not exported. ${errorText(e)}`, 'error');
    }
  };

  const menu = (
    <RowMenu
      label="More for deals"
      groups={[
        {
          items: [
            { label: 'Edit stages', onSelect: () => stagesSheet.show(null), disabled: offline },
            { label: 'Export CSV', onSelect: () => void exportCsv(), disabled: offline },
          ],
        },
      ]}
    />
  );
  const first = load.data ? firstStage(load.data.stages) : undefined;
  const shown = stage ?? first;

  return (
    <Page
      title="Work"
      aside={
        <>
          {menu}
          <AddButton label="New deal" disabled={offline} onClick={() => add.show(null)} />
        </>
      }
      undo={undo}
      wide
    >
      {tabs}
      <Loaded load={load}>
        {(d) => {
          const totals = pipelineTotals(d.stages, status?.currency);
          // The totals ask for 240 before the business and Insights wrap under them: as flex-1 alone (a basis
          // of 0) they shrank to a word a line beside them on a narrow pane.
          const head = (
            <div className="flex flex-wrap items-center gap-x-12 gap-y-4 px-16 pb-8">
              <div data-totals className="min-w-0 grow basis-240">
                {totals.length ? (
                  totals.map((t) => (
                    <p key={t} className="type-mono text-ink-2">
                      {t}
                    </p>
                  ))
                ) : (
                  <p className="type-mono text-ink-3">Nothing open</p>
                )}
              </div>
              {businesses.length >= 2 ? (
                <select aria-label="Business" className="h-32 rounded-btn border border-line bg-bg px-8 type-small text-ink coarse:h-44" value={business} onChange={(e) => onBusiness(e.target.value)}>
                  <option value="">All businesses</option>
                  {businesses.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              ) : null}
              <Link href={INSIGHTS_PATH} className="inline-flex h-32 items-center gap-2 rounded-btn px-8 type-small text-ink hover:bg-hover coarse:h-44">
                Insights
                <CaretRightIcon size={12} aria-hidden="true" className="text-ink-3" />
              </Link>
            </div>
          );
          const nothing = d.stages.every((s) => s.count === 0) && d.deals.length === 0;
          // One business picked, and none of its own: say so, and offer them all again.
          if (nothing && business && !show && !stage)
            return (
              <>
                {head}
                <LifeEmpty
                  action={
                    <Button onClick={() => onBusiness('')} className="coarse:min-h-44">
                      All businesses
                    </Button>
                  }
                >
                  No deals for this business.
                </LifeEmpty>
              </>
            );
          if (nothing && !show && !stage)
            return (
              <>
                {head}
                <LifeEmpty
                  action={
                    <Button variant="primary" disabled={offline} onClick={() => add.show(null)} className="coarse:min-h-44">
                      <PlusIcon size={16} aria-hidden="true" />
                      Add a deal
                    </Button>
                  }
                >
                  No deals yet. A deal is work a client may buy, from a new lead to Won or Lost.
                </LifeEmpty>
              </>
            );
          if (show)
            return (
              <>
                {head}
                <ShowList show={show} cards={showing(d.deals, show)} now={now} actions={actions} open={open} />
              </>
            );
          if (board)
            return (
              <>
                {head}
                <Board cols={d.stages} cards={d.deals} now={now} actions={actions} fine={!layout.coarse} currency={status?.currency} />
              </>
            );
          if (beside)
            return (
              <>
                {head}
                <Grouped cols={d.stages} cards={d.deals} now={now} actions={actions} open={open} />
              </>
            );
          const col = d.stages.find((s) => s.id === shown);
          const cards = col && col.kind !== 'open' ? (closed?.data?.deals ?? null) : d.deals.filter((c) => c.stage === shown);
          return (
            <>
              {head}
              <StagePicker cols={d.stages} value={shown} onPick={(s) => navigate(dealPath(undefined, { stage: s }), { replace: true })} />
              {!phone && split?.split && !split.selected ? (
                <div className="px-8 pb-4">
                  <Button variant="text" className="coarse:min-h-44" onClick={() => navigate(dealPath(), { replace: true })}>
                    Show the board
                  </Button>
                </div>
              ) : null}
              {col ? (
                <StagePage col={col} cards={cards} closedLoad={col.kind !== 'open' ? closed : null} now={now} actions={actions} open={open} currency={status?.currency} />
              ) : (
                <LifeEmpty>That stage is gone. Pick another.</LifeEmpty>
              )}
            </>
          );
        }}
      </Loaded>
      <DealSheet open={add.open} onOpenChange={add.onOpenChange} sheetKey={add.key} deal={null} stages={stages} onSaved={(newId) => {
        onChanged();
        navigate(dealPath(newId));
      }} />
      {stagesSheet.key ? (
        <Suspense fallback={null}>
          <StagesSheet open={stagesSheet.open} onOpenChange={stagesSheet.onOpenChange} sheetKey={stagesSheet.key} onSaved={onChanged} />
        </Suspense>
      ) : null}
      {log.key && log.item ? (
        <Suspense fallback={null}>
          <LogSheet
            open={log.open}
            onOpenChange={log.onOpenChange}
            sheetKey={log.key}
            client={{ id: log.item.client.id, name: log.item.client.name }}
            deals={[log.item]}
            start={{ dealId: log.item.id, ...(log.item.projectId ? { projectId: log.item.projectId } : {}) }}
            now={now}
            onSaved={onChanged}
          />
        </Suspense>
      ) : null}
      {next.item ? (
        <TodoSheet
          open={next.open}
          onOpenChange={next.onOpenChange}
          sheetKey={next.key}
          todo={null}
          projects={projects.data?.projects ?? []}
          clients={[{ id: next.item.client.id, name: next.item.client.name }]}
          now={now}
          start={{ contactId: next.item.client.id, dealId: next.item.id, ...(next.item.projectId ? { projectId: next.item.projectId } : {}) }}
          onSaved={onChanged}
        />
      ) : null}
      {flow.element}
    </Page>
  );
}

/** What a card's ··· and keys can do. */
interface CardActions {
  offline: boolean;
  flow: MoveFlow;
  log: (c: WorkDealCard) => void;
  next: (c: WorkDealCard) => void;
  client: (c: WorkDealCard) => void;
}

/**
 * The stages as a strip of chips with their counts (it scrolls sideways on a narrow phone; 44 on touch). The
 * picked stage's chip stays in view: a link to a stage past the strip's edge scrolls it there.
 */
function StagePicker({ cols, value, onPick }: { cols: readonly WorkStageColumn[]; value: string | undefined; onPick: (id: string) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = strip.current;
    const chip = box?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!box || !chip) return;
    const to = scrollToShow(box.scrollLeft, box.clientWidth, chip.offsetLeft, chip.offsetWidth);
    if (to !== null) box.scrollLeft = to;
  }, [value]);
  return (
    <div ref={strip} data-scroll-x role="group" aria-label="Stages" className="no-scrollbar relative flex gap-8 overflow-x-auto px-16 pb-12">
      {cols.map((c) => (
        <button
          key={c.id}
          type="button"
          aria-pressed={c.id === value}
          onClick={() => onPick(c.id)}
          className={clsx(
            'inline-flex h-32 flex-none items-center gap-6 rounded-chip border px-12 type-small transition-colors duration-120 ease-hover coarse:h-44',
            c.id === value ? 'border-line-strong bg-select text-ink' : 'border-line text-ink-2 hover:text-ink',
          )}
        >
          {c.name}
          <span className="type-mono text-ink-3">{c.count}</span>
        </button>
      ))}
    </div>
  );
}

/** One stage's page: its totals per currency, then its deals (Won's and Lost's: every one, newest first). */
function StagePage({
  col,
  cards,
  closedLoad,
  now,
  actions,
  open,
  currency,
}: {
  col: WorkStageColumn;
  cards: readonly WorkDealCard[] | null;
  closedLoad: LifeLoad<WorkDealsResponse> | null;
  now: LifeClock;
  actions: CardActions;
  open: string | null;
  currency?: string | null | undefined;
}) {
  const totals = stageTotals(col, currency);
  const caption = col.kind === 'open' ? (col.quiet ? `${col.quiet} quiet` : undefined) : 'last 30 days';
  const body =
    cards === null && closedLoad ? (
      <Loaded load={closedLoad} count={2}>
        {(d) => <Cards label={col.name} cards={d.deals} now={now} actions={actions} open={open} stage={col.id} />}
      </Loaded>
    ) : cards && cards.length ? (
      <Cards label={col.name} cards={cards} now={now} actions={actions} open={open} stage={col.id} />
    ) : (
      <LifeEmpty>{col.kind === 'open' ? `Nothing in ${col.name}.` : `No deal ${col.kind === 'won' ? 'won' : 'lost'} yet.`}</LifeEmpty>
    );
  return (
    <Panel label={col.name} count={col.count} aside={caption} card={false}>
      {totals.length ? (
        <div data-stage-totals className="px-16 pb-8">
          {totals.map((t) => (
            <p key={t} className="type-mono text-ink-2">
              {t}
            </p>
          ))}
        </div>
      ) : null}
      {body}
    </Panel>
  );
}

/** Beside an open deal: the open stages as groups, the open one's row current. */
function Grouped({ cols, cards, now, actions, open }: { cols: readonly WorkStageColumn[]; cards: readonly WorkDealCard[]; now: LifeClock; actions: CardActions; open: string | null }) {
  const by = byStage(cards, cols);
  return (
    <>
      {cols
        .filter((c) => c.kind === 'open')
        .map((c) => {
          const list = by.get(c.id) ?? [];
          return (
            <Panel key={c.id} label={c.name} count={list.length} card={false}>
              {list.length ? <Cards label={c.name} cards={list} now={now} actions={actions} open={open} /> : <LifeEmpty>{`Nothing in ${c.name}.`}</LifeEmpty>}
            </Panel>
          );
        })}
    </>
  );
}

/** Today's filter: the deals it counted, one list, with Clear. */
function ShowList({ show, cards, now, actions, open }: { show: WorkDealsShow; cards: readonly WorkDealCard[]; now: LifeClock; actions: CardActions; open: string | null }) {
  const navigate = useNavigate();
  return (
    <>
      <div className="flex items-center gap-8 px-16 pb-12">
        <span className="inline-flex h-32 items-center rounded-chip border border-line-strong bg-select px-12 type-small text-ink coarse:h-44">{SHOW_LABEL[show]}</span>
        <Button variant="text" className="coarse:min-h-44" onClick={() => navigate(dealPath(), { replace: true })}>
          <XIcon size={14} aria-hidden="true" />
          Clear
        </Button>
      </div>
      {cards.length ? <Cards label={SHOW_LABEL[show]} cards={cards} now={now} actions={actions} open={open} show={show} showStage /> : <LifeEmpty>None now.</LifeEmpty>}
    </>
  );
}

/** Deals as cards in a list (the phone's stage page, the groups beside a deal, Today's filter). */
function Cards({
  label,
  cards,
  now,
  actions,
  open,
  stage,
  show,
  showStage = false,
}: {
  label: string;
  cards: readonly WorkDealCard[];
  now: LifeClock;
  actions: CardActions;
  open: string | null;
  stage?: string | undefined;
  show?: WorkDealsShow | undefined;
  showStage?: boolean;
}) {
  return (
    <ul aria-label={label} className="flex flex-col gap-8 px-16 pb-12">
      {cards.map((c) => (
        <DealCardItem key={c.id} card={c} now={now} actions={actions} current={c.id === open} href={dealPath(c.id, { stage, show })} showStage={showStage} />
      ))}
    </ul>
  );
}

/**
 * One deal as a card: "Acme · Site rebuild" and its value, then its days in stage, next step and close
 * day (ember once the close day passed); quiet ones say so. ··· (a long press on touch) moves it, logs
 * with its client, sets a next step or opens the client; `m` moves it with a keyboard.
 */
function DealCardItem({
  card,
  now,
  actions,
  current = false,
  href,
  compact = false,
  showStage = false,
  drag,
}: {
  card: WorkDealCard;
  now: LifeClock;
  actions: CardActions;
  current?: boolean;
  href: string;
  compact?: boolean;
  showStage?: boolean;
  /** The board's drag, with a mouse or trackpad. */
  drag?: { onStart: (id: string) => void; onEnd: () => void } | undefined;
}) {
  const [menu, setMenu] = useState(false);
  const guard = useRef<PressGuard>({ at: -Infinity }).current;
  const item = useRef<HTMLLIElement>(null);
  const press = useLongPress<HTMLAnchorElement>(actions.offline ? undefined : () => setMenu(true), guard);
  const close = closeText(card);
  const value = valueText(card);
  const facts = [
    showStage ? card.stageName : null,
    card.kind === 'open' ? daysInStageText(card.daysInStage) : null,
    card.kind === 'open' ? nextStepText(card, now.day) : null,
  ].filter((x): x is string => x !== null);
  // Move to… sits beside the card's link (the popover's anchor).
  const move = () => actions.flow.choose(moveDeal(card), item.current?.querySelector<HTMLElement>('[data-row]') ?? null);
  const onKey = (e: KeyboardEvent<HTMLAnchorElement>) => {
    if (e.key !== 'm' || e.metaKey || e.ctrlKey || e.altKey || actions.offline) return;
    e.preventDefault();
    move();
  };
  return (
    <li
      ref={item}
      data-deal={card.id}
      data-quiet={card.quiet || undefined}
      className={clsx('flex items-start gap-4 rounded-btn border pr-4 transition-colors duration-120 ease-hover', current ? 'border-line-strong bg-select' : 'border-line bg-raised hover:bg-hover')}
    >
      <Link
        href={href}
        data-row={card.id}
        aria-current={current ? 'true' : undefined}
        draggable={drag ? true : false}
        onDragStart={
          drag
            ? (e: DragEvent<HTMLAnchorElement>) => {
                e.dataTransfer.setData(DEAL_DRAG, card.id);
                e.dataTransfer.effectAllowed = 'move';
                drag.onStart(card.id);
              }
            : undefined
        }
        onDragEnd={drag ? drag.onEnd : undefined}
        onClick={(e) => {
          if (justLongPressed(guard)) e.preventDefault();
        }}
        onKeyDown={onKey}
        className={clsx('min-w-0 flex-1 select-none py-8 pl-12 [-webkit-touch-callout:none]', compact ? 'coarse:min-h-52' : 'min-h-52 coarse:min-h-56')}
        {...press}
      >
        <span className="flex items-baseline gap-8">
          <span className="min-w-0 flex-1 truncate type-row text-ink">
            <span className="text-ink-2">{card.client.name} · </span>
            <span className="font-medium">{card.title}</span>
          </span>
          {value ? <span className="flex-none type-mono text-ink">{value}</span> : null}
        </span>
        <span className="mt-2 block truncate type-mono text-ink-3">
          {facts.join(' · ')}
          {close ? (
            <>
              {facts.length ? ' · ' : ''}
              <span className={close.late ? 'text-signal-text' : undefined}>{close.text}</span>
            </>
          ) : null}
          {card.quiet ? <span className="text-ink-2">{facts.length || close ? ' · ' : ''}quiet</span> : null}
        </span>
        <FromTag from={card.from ?? card.client.from} className="mt-2 inline-block" />
      </Link>
      <div className="pt-4 coarse:pt-6">
        <RowMenu
          label={`Actions for ${card.title}`}
          open={menu}
          onOpenChange={setMenu}
          disabled={actions.offline}
          groups={[
            {
              items: [
                { label: 'Move to…', onSelect: move },
                { label: 'Log', onSelect: () => actions.log(card) },
                { label: 'Next step', onSelect: () => actions.next(card) },
                { label: 'Open client', onSelect: () => actions.client(card) },
              ],
            },
          ]}
        />
      </div>
    </li>
  );
}

/**
 * The board on a wide pane: a column per open stage (240 at least; past what fits it scrolls sideways),
 * Won and Lost as narrow columns of the last 30 days. ←→ go between columns with a keyboard; a fine
 * pointer can drop a card on a column.
 */
function Board({
  cols,
  cards,
  now,
  actions,
  fine,
  currency,
}: {
  cols: readonly WorkStageColumn[];
  cards: readonly WorkDealCard[];
  now: LifeClock;
  actions: CardActions;
  fine: boolean;
  /** The Life currency, whose totals come first. */
  currency?: string | null | undefined;
}) {
  const by = byStage(cards, cols);
  const open = cols.filter((c) => c.kind === 'open');
  const closed = cols.filter((c) => c.kind !== 'open');
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const drag =
    fine && !actions.offline
      ? {
          onStart: (id: string) => setDragging(id),
          onEnd: () => {
            setDragging(null);
            setOver(null);
          },
        }
      : undefined;
  const dropOn = (stageId: string) =>
    drag
      ? {
          onDragOver: (e: DragEvent<HTMLElement>) => {
            if (!dragging || !Array.from(e.dataTransfer.types).includes(DEAL_DRAG)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (over !== stageId) setOver(stageId);
          },
          onDragLeave: (e: DragEvent<HTMLElement>) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === stageId ? null : o));
          },
          onDrop: (e: DragEvent<HTMLElement>) => {
            e.preventDefault();
            const id = e.dataTransfer.getData(DEAL_DRAG) || dragging;
            const card = cards.find((c) => c.id === id);
            setDragging(null);
            setOver(null);
            if (card) actions.flow.to(moveDeal(card), stageId);
          },
        }
      : {};
  // ←→: the card at the same place in the next column that has one.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.metaKey || e.ctrlKey || e.altKey) return;
    const at = (e.target as Element).closest<HTMLElement>('[data-row]');
    const column = at?.closest<HTMLElement>('[data-column]');
    if (!at || !column || !box.current) return;
    const columns = Array.from(box.current.querySelectorAll<HTMLElement>('[data-column]'));
    const rows = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>('[data-row]'));
    const index = rows(column).indexOf(at);
    const step = e.key === 'ArrowRight' ? 1 : -1;
    for (let i = columns.indexOf(column) + step; i >= 0 && i < columns.length; i += step) {
      const list = rows(columns[i]!);
      if (list.length) {
        e.preventDefault();
        list[Math.min(index, list.length - 1)]!.focus();
        return;
      }
    }
  };
  return (
    <div ref={box} data-scroll-x data-board className="no-scrollbar overflow-x-auto px-16 pb-16" onKeyDown={onKey}>
      <div className="grid items-start gap-12" style={{ gridTemplateColumns: `repeat(${open.length}, minmax(240px, 1fr)) repeat(${closed.length}, 128px)` }}>
        {open.map((col) => {
          const list = by.get(col.id) ?? [];
          return (
            <section
              key={col.id}
              aria-label={col.name}
              data-column={col.id}
              data-over={over === col.id || undefined}
              className={clsx('min-w-0 rounded-dock border p-8 transition-colors duration-120 ease-hover', over === col.id ? 'border-line-strong bg-select' : 'border-line bg-surface')}
              {...dropOn(col.id)}
            >
              <header className="px-4 pb-8">
                <h2 className="flex items-baseline gap-8 type-rail text-ink-3">
                  <span className="min-w-0 truncate">{col.name}</span>
                  <span className="text-ink-2">{col.count}</span>
                  {col.quiet ? <span className="ml-auto normal-case">{col.quiet} quiet</span> : null}
                </h2>
                {stageTotals(col, currency).map((t) => (
                  <p key={t} className="mt-2 truncate type-mono text-ink-2">
                    {t}
                  </p>
                ))}
              </header>
              {list.length ? (
                <ul aria-label={col.name} className="flex flex-col gap-8">
                  {list.map((c) => (
                    <DealCardItem key={c.id} card={c} now={now} actions={actions} href={dealPath(c.id)} compact drag={drag} />
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-8 type-small text-ink-3">{dragging ? 'Drop here' : 'Nothing here'}</p>
              )}
            </section>
          );
        })}
        {closed.map((col) => (
          <section
            key={col.id}
            aria-label={col.name}
            data-column={col.id}
            data-over={over === col.id || undefined}
            className={clsx('min-w-0 rounded-dock border transition-colors duration-120 ease-hover', over === col.id ? 'border-line-strong bg-select' : 'border-line bg-surface')}
            {...dropOn(col.id)}
          >
            <Link href={dealPath(undefined, { stage: col.id })} className="flex min-h-88 flex-col gap-2 p-12 hover:bg-hover">
              <span className="type-rail text-ink-3">{col.name}</span>
              <span className="type-mono text-ink-3">30 days</span>
              <span className="type-mono text-ink">{col.count}</span>
              {stageTotals(col, currency).map((t) => (
                <span key={t} className="truncate type-mono text-ink-2">
                  {t.replace(/ (won|lost)$/, '')}
                </span>
              ))}
            </Link>
          </section>
        ))}
      </div>
    </div>
  );
}

