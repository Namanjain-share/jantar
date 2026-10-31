/**
 * Today (v0.4 spec 5.2): one call, `GET /v1/life/today`, plus the shared
 * LifeStatus (which modules are on, the push warning).
 *
 *   Today                         Thu 30 Oct
 *   No device gets medicine pings.             PushWarning, while medicines are on
 *   MEDICINES   WP-MD's MedsToday              "No medicines today." with none
 *   DUE         overdue todos, then today's    "Nothing due today." with none
 *   BILLS       due within 3 days or overdue   only when there are some
 *   FOOD        1,240 / 2,000 kcal  [+]        always, while food is on
 *   CLAUDE      2 sessions need you  ›         always; a tap opens the Board
 *   LIFE        one row per module that is on, and the shelf
 *
 * A section shows only while its module is on. `dose` (`<medId>@<HHMM>`,
 * from a medicine push) opens WP-MD's DoseSheet over Today for that dose.
 * Today's own rows carry no ember: the rows that may (TodoRow, BillRow)
 * come from their modules. The title is the page's <h1> in every state.
 */
import {
  BookmarksIcon,
  CaretRightIcon,
  CheckSquareIcon,
  CoffeeIcon,
  ForkKnifeIcon,
  PillIcon,
  WalletIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useMemo, type ReactNode } from 'react';
import type { LifeModule, Todo } from '@jantar/protocol';
import { routePath } from '../../../../lib/router.js';
import { useDeps, useNavigate } from '../../../context.js';
import { RailLabel } from '../../../kit/RailLabel.js';
import { useFeatures, useNeedsCount } from '../../../shell/data.js';
import { Link } from '../../../shell/Link.js';
import { AddFoodSheet } from '../food/AddFoodSheet.js';
import { FoodToday } from '../food/FoodToday.js';
import { DoseSheet } from '../meds/DoseSheet.js';
import { parseDoseKey } from '../meds/data.js';
import { MedsToday } from '../meds/MedsToday.js';
import { BillsToday } from '../money/BillsToday.js';
import { dayLabel } from '../shared/DayNav.js';
import { PushWarning } from '../shared/PushWarning.js';
import { LifeEmpty, NotSaved } from '../shared/states.js';
import { useLifeLoad, useLifeStatus } from '../shared/useLife.js';
import { useTodoActions } from '../todos/actions.js';
import { projectLabel } from '../todos/model.js';
import { TodoRow } from '../todos/TodoRow.js';
import { TodoSheet } from '../todos/TodoSheet.js';
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
];

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
  // The sheet's Project list comes from the Mac once a todo is opened (the chips' cache is empty without a stored control scope or after a refusal).
  const sheetProjects = useLifeLoad(todoSheet.key ? 'projects' : null, () => api.projectsList());
  const actions = useTodoActions(load.reload);
  const day = load.data?.day ?? status?.today;
  const now = useLifeClock(status, day);
  const foodSheet = useSheet();
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
                  {overdue.length + due.length === 0 ? (
                    <LifeEmpty>Nothing due today.</LifeEmpty>
                  ) : (
                    <ul>
                      {overdue.map((todo) => (
                        <TodoRow key={todo.id} todo={todo} now={now} project={label(todo)} overdue offline={offline} actions={actions} onEdit={(x) => todoSheet.show(x)} />
                      ))}
                      {due.map((todo) => (
                        // The clock decides: a time that passes while Today stays open turns the row overdue.
                        <TodoRow key={todo.id} todo={todo} now={now} project={label(todo)} showDay={false} offline={offline} actions={actions} onEdit={(x) => todoSheet.show(x)} />
                      ))}
                    </ul>
                  )}
                </Section>
              ) : null}

              {t.bills && t.bills.length > 0 ? (
                <Section label="Bills" count={t.bills.length}>
                  <BillsToday bills={t.bills} />
                </Section>
              ) : null}

              {t.food ? (
                <Section label="Food">
                  <div className="flex items-center gap-4 border-b border-line pr-8">
                    <div className="min-w-0 flex-1">
                      <FoodToday kcal={t.food.kcal} target={t.food.target} weight={t.food.weight} />
                    </div>
                    <AddButton label="Add food" disabled={offline} onClick={() => foodSheet.show()} />
                  </div>
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
        onSaved={load.reload}
      />
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
