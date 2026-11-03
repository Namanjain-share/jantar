/**
 * Today (v0.4 spec 5.2): one call, `GET /v1/life/today`, plus the shared
 * LifeStatus (which modules are on, the push warning).
 *
 *   Today                         Thu 30 Oct
 *   No device gets medicine pings.             PushWarning, while medicines are on
 *   MEDICINES   WP-MD's MedsToday              "No medicines today." with none
 *   DUE         overdue todos, then today's    "Nothing due today." with none
 *               [+] Add todo                   always (v0.5.3): the todo sheet, due today
 *   BILLS       due within 3 days or overdue   only when there are some
 *   POSTS       2 to post today · 1 late  ›    v0.7, while posts are on: one line, a link to Posts
 *               Comments today 3/5        ›    v0.9: with a comment goal, or once one is logged; to Posts › Done
 *   FOOD        1,240 / 1,500 kcal  [+]        always, while food is on
 *               72.4 kg | Log weight           v0.5.3: opens the weight sheet over Today
 *   CLAUDE      2 sessions need you  ›         always; a tap opens the Board
 *   LIFE        one row per module that is on, and the shelf
 *
 * A section shows only while its module is on. `dose` (`<medId>@<HHMM>`,
 * from a medicine push) opens WP-MD's DoseSheet over Today for that dose.
 * The adds are off while offline, like Add food. The weight sheet needs the
 * recent weights and the goal, so it asks for Food's day each time it opens,
 * and only while it is open (the weight line shows the spinner meanwhile;
 * a failure says so under it, with Try again).
 * Today's own rows carry no ember: the rows that may (TodoRow, BillRow)
 * come from their modules. The title is the page's <h1> in every state.
 *
 * 0.11 (build plan 2.3): from a pane 640 wide the sections are cards
 * (Dashboard.tsx) dealt into columns of at least 340 (kit/Columns.tsx):
 * three on a 1440 Mac, two at 1024. Each card has at most five rows and a
 * link to its module; the Claude card lists the three sessions waiting
 * longest (the age ember past ten minutes, as on the Board) with "3 your
 * turn · 8 working"; the Life strip on top replaces the LIFE list; "Edit
 * cards" orders and hides them on this device. Below 640, 0.10's list.
 */
import { BookmarksIcon, CaretRightIcon, PlusIcon, type Icon } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FoodDay, LifeModule, Today as TodayData, Todo } from '@jantar/protocol';
import { routePath } from '../../../../lib/router.js';
import { PeopleCard } from '../../people/PeopleCard.js';
import { useApp, useDeps, useNavigate, useNow } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Columns, useBucket } from '../../../kit/Columns.js';
import { RailLabel } from '../../../kit/RailLabel.js';
import { StatusGlyph } from '../../../kit/StatusGlyph.js';
import { useFeatures, useNeedsCount } from '../../../shell/data.js';
import { Link } from '../../../shell/Link.js';
import { LIFE } from '../../../shell/life.js';
import { useLifeInNav } from '../../../shell/navState.js';
import { groupRows, ledgerGroups } from '../../board/model.js';
import { AddFoodSheet } from '../food/AddFoodSheet.js';
import { FoodToday } from '../food/FoodToday.js';
import { WeightSheet } from '../food/WeightSheet.js';
import { DoseSheet } from '../meds/DoseSheet.js';
import { dayItems, isDue, parseDoseKey } from '../meds/data.js';
import { MedsToday } from '../meds/MedsToday.js';
import { BillsToday } from '../money/BillsToday.js';
import { dayLabel } from '../shared/DayNav.js';
import { PushWarning } from '../shared/PushWarning.js';
import { LifeEmpty, LifeError, NotSaved } from '../shared/states.js';
import { useLifeLoad, useLifeStatus } from '../shared/useLife.js';
import { useTodoActions } from '../todos/actions.js';
import { projectLabel } from '../todos/model.js';
import { TodoRow } from '../todos/TodoRow.js';
import { TodoSheet, type TodoStart } from '../todos/TodoSheet.js';
import { useProjects } from '../todos/useProjects.js';
import { Card, CARD_ROWS, EditCards, LifeStrip, MoreLink, shownCards, useCardPrefs, type CardId, type StripItem, type Tone } from './Dashboard.js';
import { AddButton, Loaded, Page, useLifeClock, useOffline, useSheet } from './parts.js';

export interface TodayProps {
  dose?: string | undefined;
}

/** The modules in Today's LIFE list, in nav order, with their one icon each (spec 5.0; 0.11: shell/nav.ts LIFE, which the touch sidebar lists too). */
const MODULES: readonly { module: LifeModule; label: string; href: string; icon: Icon }[] = LIFE;

/** Today's sections become cards from a pane this wide (the container size md); below it they are 0.10's list. */
export const CARDS_FROM = 640;

/** At most this many waiting sessions in the Claude card. */
const CLAUDE_ROWS = 3;

/** Today's comments (v0.9): "Comments today 3/5", or "Comments today 3" with no comment goal. */
export function commentsLine(c: { done: number; goal?: number | undefined }): string {
  return c.goal !== undefined ? `Comments today ${c.done}/${c.goal}` : `Comments today ${c.done}`;
}

/** Today's first Posts line (v0.7): "2 to post today · 1 late", or "Nothing to post today". */
export function postsLine(p: { today: number; late: number }): string {
  const first = p.today > 0 ? `${p.today} to post today` : 'Nothing to post today';
  return p.late > 0 ? `${first} · ${p.late} late` : first;
}

/** "3 need you", "1 needs you". */
const needText = (n: number) => `${n} ${n === 1 ? 'needs' : 'need'} you`;
/** "No session needs you", "1 session needs you", "2 sessions need you". */
const sessionsLine = (n: number) => (n === 0 ? 'No session needs you' : n === 1 ? '1 session needs you' : `${n} sessions need you`);

const LINE_ROW = 'flex h-48 items-center gap-8 border-b border-line px-16 transition-colors duration-120 ease-hover hover:bg-hover';

/** A section's parts: its rail count, its card status and link, and its rows. */
interface Part {
  id: CardId;
  count?: number | undefined;
  status?: { text: string; tone: Tone } | null;
  open?: { href: string; label: string; name: string };
  body: ReactNode;
}

export function Today({ dose }: TodayProps) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const offline = useOffline();
  const { status } = useLifeStatus();
  const features = useFeatures();
  const lifeInNav = useLifeInNav();
  const needs = useNeedsCount();
  const state = useApp((s) => s.state);
  const nowMs = useNow(15_000);
  const load = useLifeLoad('today', () => api.lifeToday());
  const projects = useProjects();
  const pmap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const todoSheet = useSheet<Todo>();
  const [todoStart, setTodoStart] = useState<TodoStart | undefined>(undefined);
  // The sheet's Project list comes from the Mac once a todo is opened (the chips' cache is empty without a stored control scope or after a refusal).
  const sheetProjects = useLifeLoad(todoSheet.key ? 'projects' : null, () => api.projectsList());
  const actions = useTodoActions(load.reload);
  const day = load.data?.day ?? status?.today;
  const now = useLifeClock(status, day);
  const foodSheet = useSheet();
  const weightSheet = useSheet();
  // Today's food day, for the weight sheet (its recent weights and goal): asked for afresh at each opening, and only
  // while the sheet is open, so a life tick on Today never fetches it once the sheet has closed.
  const weightLoad = useLifeLoad(weightSheet.open ? `food:${now.day}:${weightSheet.key}` : null, () => api.foodDay(now.day));
  // The last answer stays while the sheet closes, so it slides away rather than vanishing.
  const [weightLast, setWeightLast] = useState<FoodDay | null>(null);
  useEffect(() => {
    if (weightLoad.data) setWeightLast(weightLoad.data);
  }, [weightLoad.data]);
  const weightDay = weightLoad.data ?? weightLast;
  // Cards from a pane of 640 (0.11), the 0.10 list below it: decided by the page's measured width.
  const body = useRef<HTMLDivElement>(null);
  const cards = useBucket(body, (w) => w >= CARDS_FROM);
  const [prefs, setPrefs] = useCardPrefs();
  const [editing, setEditing] = useState(false);
  const addTodo = () => {
    setTodoStart({ day: now.day });
    todoSheet.show(null);
  };
  const editTodo = (x: Todo) => {
    setTodoStart(undefined);
    todoSheet.show(x);
  };
  const savedWeight = () => {
    load.reload();
    weightLoad.reload();
  };
  // The push's key has no day: a 23:00 dose opened after midnight is last night's.
  const doseOf = dose ? parseDoseKey(dose, now) : null;
  const label = (todo: Todo) => {
    const p = todo.projectId ? pmap.get(todo.projectId) : undefined;
    return p ? projectLabel(p) : undefined;
  };

  /** The sections Today's data has, each once. */
  const dataParts = (t: TodayData): Part[] => {
    const parts: Part[] = [];
    const meds = t.meds;
    if (meds) {
      const items = dayItems(meds);
      const due = items.filter((i) => isDue(i, meds.day, now)).length;
      parts.push({
        id: 'meds',
        status: due ? { text: `${due} due`, tone: 'due' } : null,
        open: { href: '/meds', label: 'Open', name: 'Open Medicines' },
        body: items.length === 0 ? <LifeEmpty>No medicines today.</LifeEmpty> : <MedsToday data={meds} onChanged={load.reload} {...(cards ? { max: CARD_ROWS } : {})} />,
      });
    }
    if (t.todos) {
      const overdue = actions.visible(t.todos.overdue);
      const today = actions.visible(t.todos.today);
      const all = overdue.length + today.length;
      // A card shows five; the list shows every one.
      const cap = cards ? CARD_ROWS : Infinity;
      const shownOverdue = overdue.slice(0, cap);
      const shownToday = today.slice(0, Math.max(0, cap - shownOverdue.length));
      parts.push({
        id: 'due',
        count: all,
        status: cards && overdue.length ? { text: `${overdue.length} late`, tone: 'needs' } : null,
        open: { href: '/todos', label: 'Todos', name: 'Open Todos' },
        body: (
          <>
            {actions.error ? (
              <div className="px-16">
                <NotSaved error={actions.error} />
              </div>
            ) : null}
            {all === 0 ? null : (
              <ul>
                {shownOverdue.map((todo) => (
                  <TodoRow key={todo.id} todo={todo} now={now} project={label(todo)} overdue offline={offline} actions={actions} onEdit={editTodo} />
                ))}
                {shownToday.map((todo) => (
                  // The clock decides: a time that passes while Today stays open turns the row overdue.
                  <TodoRow key={todo.id} todo={todo} now={now} project={label(todo)} showDay={false} offline={offline} actions={actions} onEdit={editTodo} />
                ))}
              </ul>
            )}
            {cards ? (
              // The card's last row: Add todo, and how many more the card leaves to Todos.
              <>
                {all === 0 ? <LifeEmpty>Nothing due today.</LifeEmpty> : null}
                <div className="flex min-h-44 items-center gap-8 border-b border-line px-8">
                  <Button variant="text" disabled={offline} onClick={addTodo}>
                    <PlusIcon size={16} aria-hidden="true" />
                    Add todo
                  </Button>
                  <span className="flex-1" />
                  <MoreLink n={all - shownOverdue.length - shownToday.length} href="/todos" what="todos" inline />
                </div>
              </>
            ) : (
              <div className="flex items-center gap-4 border-b border-line pr-8">
                <div className="min-w-0 flex-1">{all === 0 ? <LifeEmpty>Nothing due today.</LifeEmpty> : null}</div>
                <AddButton label="Add todo" disabled={offline} onClick={addTodo} />
              </div>
            )}
          </>
        ),
      });
    }
    if (t.bills && t.bills.length > 0) {
      const shown = cards ? t.bills.slice(0, CARD_ROWS) : t.bills;
      parts.push({
        id: 'bills',
        count: t.bills.length,
        open: { href: '/money', label: 'Open', name: 'Open Finance' },
        body: (
          <>
            <BillsToday bills={shown} />
            {cards ? <MoreLink n={t.bills.length - shown.length} href="/money" what="bills" /> : null}
          </>
        ),
      });
    }
    if (t.posts) {
      parts.push({
        id: 'posts',
        status: cards && t.posts.today ? { text: `${t.posts.today} today`, tone: 'plain' } : null,
        open: { href: '/posts', label: 'Open', name: 'Open Posts' },
        body: (
          <>
            <Link href="/posts" className={LINE_ROW}>
              <span className="flex-1 type-row text-ink">{postsLine(t.posts)}</span>
              <CaretRightIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
            </Link>
            {t.posts.comments && (t.posts.comments.goal !== undefined || t.posts.comments.done > 0) ? (
              <Link href={routePath({ name: 'posts', filter: 'done' })} className={LINE_ROW}>
                <span className="flex-1 type-row text-ink">{commentsLine(t.posts.comments)}</span>
                <CaretRightIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
              </Link>
            ) : null}
          </>
        ),
      });
    }
    if (t.food) {
      parts.push({
        id: 'food',
        open: { href: '/food', label: 'Open', name: 'Open Food' },
        body: (
          <>
            <div className="flex items-center gap-4 border-b border-line pr-8">
              <div className="min-w-0 flex-1">
                <FoodToday
                  kcal={t.food.kcal}
                  target={t.food.target}
                  weight={t.food.weight}
                  onWeight={() => weightSheet.show()}
                  weightBusy={weightSheet.open && !weightLoad.data && !weightLoad.error}
                />
              </div>
              <AddButton label="Add food" disabled={offline} onClick={() => foodSheet.show()} />
            </div>
            {weightSheet.open && !weightLoad.data && weightLoad.error ? <LifeError error={weightLoad.error} onRetry={weightLoad.reload} /> : null}
          </>
        ),
      });
    }
    return parts;
  };

  const claude = (): Part => {
    if (!cards)
      return {
        id: 'claude',
        body: (
          <Link href="/" className={LINE_ROW}>
            <span className="flex-1 type-row text-ink">{sessionsLine(needs)}</span>
            <CaretRightIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
          </Link>
        ),
      };
    // The card: the oldest waits first (the Board's queue), each a link, then the line and the counts.
    const groups = ledgerGroups(state, nowMs);
    const waiting = groupRows(groups, 'needs');
    const turn = groupRows(groups, 'turn').length;
    const working = groupRows(groups, 'working').length;
    return {
      id: 'claude',
      status: needs ? { text: needText(needs), tone: 'needs' } : null,
      open: { href: '/', label: 'Board', name: 'Open the Board' },
      body: (
        <>
          {waiting.length ? (
            <ul aria-label="Waiting on you">
              {waiting.slice(0, CLAUDE_ROWS).map((r) => (
                <li key={r.sid}>
                  <Link href={`/s/${encodeURIComponent(r.sid)}`} className={LINE_ROW}>
                    <StatusGlyph state={r.glyph} />
                    <span className="min-w-0 flex-1 truncate type-row">
                      <span className="font-medium text-ink">{r.folder}</span> <span className="text-ink-2">{r.name}</span>
                    </span>
                    <span className={r.ageEmber ? 'flex-none type-mono text-signal-text' : 'flex-none type-mono text-ink-3'}>{r.age}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          <Link href="/" className={LINE_ROW}>
            <span className="flex-1 type-row text-ink">{sessionsLine(needs)}</span>
            <CaretRightIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
          </Link>
          {turn + working > 0 ? (
            <p className="flex h-40 items-center gap-16 border-b border-line px-16 type-mono text-ink-3">
              {turn ? (
                <span className="inline-flex items-center gap-8">
                  <StatusGlyph state="turn" />
                  {turn} your turn
                </span>
              ) : null}
              {working ? (
                <span className="inline-flex items-center gap-8">
                  <StatusGlyph state="working" />
                  {working} working
                </span>
              ) : null}
            </p>
          ) : null}
        </>
      ),
    };
  };

  const lifeLinks = [
    ...MODULES.filter((m) => status?.modules[m.module]),
    ...(features.intel ? [{ module: null, label: 'Intel', href: '/intel', icon: BookmarksIcon }] : []),
  ];
  const t = load.data;
  const strip: StripItem[] = lifeLinks.map((m) => ({
    href: m.href,
    label: m.label,
    icon: m.icon,
    count:
      m.module === 'todos' && t?.todos
        ? t.todos.overdue.length + t.todos.today.length
        : m.module === 'medicines' && t?.meds
          ? dayItems(t.meds).filter((i) => i.status === 'pending').length
          : m.module === 'posts' && t?.posts
            ? t.posts.today + t.posts.late
            : undefined,
  }));

  const card = (p: Part) => (
    <Card key={p.id} id={p.id} card={cards} count={p.count} status={p.status} open={p.open}>
      {p.body}
    </Card>
  );

  const date = day ? <span className="flex-none type-mono text-ink-3">{dayLabel(day)}</span> : null;
  const aside = cards ? (
    <>
      {date}
      <Button variant="text" aria-pressed={editing} onClick={() => setEditing((e) => !e)}>
        {editing ? 'Done' : 'Edit cards'}
      </Button>
    </>
  ) : (
    date
  );

  let content: ReactNode;
  if (cards && editing) content = <EditCards prefs={prefs} onChange={setPrefs} onDone={() => setEditing(false)} />;
  else if (cards) {
    // Every card Today has something for, in this device's order and without the ones switched off.
    const parts = new Map<CardId, Part>([...(t ? dataParts(t) : []), claude()].map((p) => [p.id, p]));
    const order = shownCards(prefs, (id) => parts.has(id));
    content = (
      <>
        {/* 0.11: not while the iPad's sidebar lists them under Today. */}
        {lifeInNav ? null : <LifeStrip items={strip} />}
        <div className="px-16">
          <Loaded load={load}>{() => null}</Loaded>
        </div>
        <Columns min={340} className="px-16 pt-8">
          {order.map((id) => card(parts.get(id)!))}
        </Columns>
      </>
    );
  } else
    content = (
      <>
        <Loaded load={load}>{(data) => <>{dataParts(data).map(card)}</>}</Loaded>
        {card(claude())}
        <section aria-label="Life">
          <RailLabel ground="bg">Life</RailLabel>
          <ul>
            {lifeLinks.map((m) => (
              <ModuleLink key={m.href} href={m.href} label={m.label} icon={m.icon} />
            ))}
          </ul>
        </section>
      </>
    );

  return (
    <Page title="Today" aside={aside} undo={actions.undo} wide>
      <div ref={body}>
        <PushWarning status={status} />
        <PeopleCard />
        {content}
      </div>
      {t ? <AddFoodSheet open={foodSheet.open} onOpenChange={foodSheet.onOpenChange} sheetKey={foodSheet.key} day={t.day} saved={null} status={status} onAdded={load.reload} /> : null}
      <TodoSheet
        open={todoSheet.open}
        onOpenChange={todoSheet.onOpenChange}
        sheetKey={todoSheet.key}
        todo={todoSheet.item}
        projects={sheetProjects.data?.projects ?? projects}
        now={now}
        start={todoStart}
        onSaved={load.reload}
      />
      {weightDay ? (
        <WeightSheet
          open={weightSheet.open && weightLoad.data !== null}
          onOpenChange={weightSheet.onOpenChange}
          sheetKey={weightSheet.key}
          day={weightDay.day}
          today={weightDay.today}
          weight={weightDay.weight}
          onSaved={savedWeight}
        />
      ) : null}
      {doseOf && day ? (
        <DoseSheet
          medId={doseOf.medId}
          slot={doseOf.slot}
          day={doseOf.day}
          onClose={() => {
            navigate(routePath({ name: 'today' }), { replace: true });
            load.reload();
          }}
        />
      ) : null}
    </Page>
  );
}

function ModuleLink({ href, label, icon: IconCmp }: { href: string; label: string; icon: Icon }) {
  return (
    <li className="border-b border-line">
      <Link href={href} className="flex h-48 items-center gap-12 px-16 transition-colors duration-120 ease-hover hover:bg-hover">
        <IconCmp size={20} aria-hidden="true" className="flex-none text-ink-2" />
        <span className="flex-1 type-row text-ink">{label}</span>
        <CaretRightIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
      </Link>
    </li>
  );
}
