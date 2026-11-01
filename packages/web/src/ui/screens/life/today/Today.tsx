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
 */
import {
  BookmarksIcon,
  CaretRightIcon,
  CheckSquareIcon,
  CoffeeIcon,
  ForkKnifeIcon,
  MegaphoneIcon,
  PillIcon,
  WalletIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { FoodDay, LifeModule, Todo } from '@jantar/protocol';
import { routePath } from '../../../../lib/router.js';
import { useDeps, useNavigate } from '../../../context.js';
import { RailLabel } from '../../../kit/RailLabel.js';
import { useFeatures, useNeedsCount } from '../../../shell/data.js';
import { Link } from '../../../shell/Link.js';
import { AddFoodSheet } from '../food/AddFoodSheet.js';
import { FoodToday } from '../food/FoodToday.js';
import { WeightSheet } from '../food/WeightSheet.js';
import { DoseSheet } from '../meds/DoseSheet.js';
import { parseDoseKey } from '../meds/data.js';
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
import { AddButton, Loaded, Page, useLifeClock, useOffline, useSheet } from './parts.js';

export interface TodayProps {
  dose?: string | undefined;
}

/** The modules in Today's LIFE list, in nav order, with their one icon each (spec 5.0). */
const MODULES: readonly { module: LifeModule; label: string; href: string; icon: Icon }[] = [
  { module: 'todos', label: 'Todos', href: '/todos', icon: CheckSquareIcon },
  { module: 'medicines', label: 'Medicines', href: '/meds', icon: PillIcon },
  { module: 'food', label: 'Food', href: '/food', icon: ForkKnifeIcon },
  { module: 'places', label: 'Cafés', href: '/places', icon: CoffeeIcon },
  { module: 'finance', label: 'Finance', href: '/money', icon: WalletIcon },
  { module: 'posts', label: 'Posts', href: '/posts', icon: MegaphoneIcon },
];

/** Today's one Posts line (v0.7): "2 to post today · 1 late", or "Nothing to post today". */
export function postsLine(p: { today: number; late: number }): string {
  const first = p.today > 0 ? `${p.today} to post today` : 'Nothing to post today';
  return p.late > 0 ? `${first} · ${p.late} late` : first;
}

function Section({ label, count, children }: { label: string; count?: number; children: ReactNode }) {
  return (
    <section aria-label={label}>
      <RailLabel ground="bg" {...(count !== undefined ? { count } : {})}>
        {label}
      </RailLabel>
      {children}
    </section>
  );
}

export function Today({ dose }: TodayProps) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const offline = useOffline();
  const { status } = useLifeStatus();
  const features = useFeatures();
  const needs = useNeedsCount();
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

  const date = day ? <span className="flex-none type-mono text-ink-3">{dayLabel(day)}</span> : null;

  return (
    <Page title="Today" aside={date} undo={actions.undo}>
      <PushWarning status={status} />
      <Loaded load={load}>
        {(t) => {
          const meds = t.meds;
          const overdue = t.todos ? actions.visible(t.todos.overdue) : [];
          const due = t.todos ? actions.visible(t.todos.today) : [];
          const medItems = meds ? meds.groups.reduce((n, g) => n + g.items.length, 0) : 0;
          const label = (todo: Todo) => {
            const p = todo.projectId ? pmap.get(todo.projectId) : undefined;
            return p ? projectLabel(p) : undefined;
          };
          return (
            <>
              {meds ? (
                <Section label="Medicines">
                  {medItems === 0 ? <LifeEmpty>No medicines today.</LifeEmpty> : <MedsToday data={meds} onChanged={load.reload} />}
                </Section>
              ) : null}

              {t.todos ? (
                <Section label="Due" count={overdue.length + due.length}>
                  {actions.error ? (
                    <div className="px-16">
                      <NotSaved error={actions.error} />
                    </div>
                  ) : null}
                  {overdue.length + due.length === 0 ? null : (
                    <ul>
                      {overdue.map((todo) => (
                        <TodoRow key={todo.id} todo={todo} now={now} project={label(todo)} overdue offline={offline} actions={actions} onEdit={editTodo} />
                      ))}
                      {due.map((todo) => (
                        // The clock decides: a time that passes while Today stays open turns the row overdue.
                        <TodoRow key={todo.id} todo={todo} now={now} project={label(todo)} showDay={false} offline={offline} actions={actions} onEdit={editTodo} />
                      ))}
                    </ul>
                  )}
                  <div className="flex items-center gap-4 border-b border-line pr-8">
                    <div className="min-w-0 flex-1">{overdue.length + due.length === 0 ? <LifeEmpty>Nothing due today.</LifeEmpty> : null}</div>
                    <AddButton label="Add todo" disabled={offline} onClick={addTodo} />
                  </div>
                </Section>
              ) : null}

              {t.bills && t.bills.length > 0 ? (
                <Section label="Bills" count={t.bills.length}>
                  <BillsToday bills={t.bills} />
                </Section>
              ) : null}

              {t.posts ? (
                <Section label="Posts">
                  <Link href="/posts" className="flex h-48 items-center gap-8 border-b border-line px-16 transition-colors duration-120 ease-hover hover:bg-hover">
                    <span className="flex-1 type-row text-ink">{postsLine(t.posts)}</span>
                    <CaretRightIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
                  </Link>
                </Section>
              ) : null}

              {t.food ? (
                <Section label="Food">
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
                </Section>
              ) : null}

              <AddFoodSheet open={foodSheet.open} onOpenChange={foodSheet.onOpenChange} sheetKey={foodSheet.key} day={t.day} saved={null} status={status} onAdded={load.reload} />
            </>
          );
        }}
      </Loaded>

      <Section label="Claude">
        <Link href="/" className="flex h-48 items-center gap-8 border-b border-line px-16 transition-colors duration-120 ease-hover hover:bg-hover">
          <span className="flex-1 type-row text-ink">
            {needs === 0 ? 'No session needs you' : needs === 1 ? '1 session needs you' : `${needs} sessions need you`}
          </span>
          <CaretRightIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
        </Link>
      </Section>

      <Section label="Life">
        <ul>
          {MODULES.filter((m) => status?.modules[m.module]).map((m) => (
            <ModuleLink key={m.module} href={m.href} label={m.label} icon={m.icon} />
          ))}
          {features.intel ? <ModuleLink href="/intel" label="Intel" icon={BookmarksIcon} /> : null}
        </ul>
      </Section>

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
