/**
 * v0.12 People: what the owner sees of her, area by area (spec 8.4, D11).
 * `ownerViewOf(pid, area, agreement)` is the only read path into her space
 * from owner code, and her mirror (`GET /v1/p/mirror/:area`) calls the same
 * function with the same agreement, so "See what Sam sees" can't drift from
 * what he sees (T10). His reads write a view mark (one per area per hour);
 * her mirror writes none.
 *
 * An area that is off is `{locked: true}`; an area this build doesn't have
 * yet is null (the routes answer 404).
 *
 * P2 adds the plan (with her status), the evening review at his level
 * (`counts` names no title, note or mood), sleep and the journal, and on
 * Today the plan tile, status, the review from her review time, "Asleep
 * since" and the concern lines. Concerns are derived when he looks and
 * never come from sleep, the journal, moods or review outcomes (spec 3.2).
 */
import {
  builtAreas,
  type Agreement,
  type Area,
  type JournalEntryFull,
  type JournalList,
  type Locked,
  type OwnerTodosView,
  type PersonOwnToday,
  type PersonToday,
  type PersonTodo,
  type PersonWeightsResponse,
  type PlanView,
  type ReviewView,
  type SleepWeek,
} from '@jantar/protocol/people';
import { JOURNAL_PROMPTS, hhmmOf, minuteOf, promptForDay } from '@jantar/life-core';
import type { LifeCore, TodosModule } from '../../contracts.js';
import { byDue, isOverdue } from '../todos/module.js';
import type { PeopleModule } from './module.js';
import type { PersonSpace } from './space.js';

const LOCKED: Locked = { locked: true };

/** The areas this build's views answer (the rest are a later commit's or phase's: 404). */
const VIEW_AREAS: ReadonlySet<Area> = new Set<Area>(['today', 'todos', 'weight', 'plan', 'review', 'sleep', 'journal']);

export type AreaView = OwnerTodosView | PersonWeightsResponse | PersonToday | PlanView | ReviewView | SleepWeek | JournalList | Locked;

export interface ViewOpts {
  day?: string | undefined;
  done?: boolean;
  week?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  before?: string | undefined;
}

export class PeopleViews {
  constructor(
    private readonly people: PeopleModule,
    private readonly space: PersonSpace,
    private readonly todosModule: () => TodosModule,
    private readonly core: () => LifeCore | null,
  ) {}

  /** Whether an area has a view in this build. */
  has(area: Area): boolean {
    return VIEW_AREAS.has(area) && builtAreas().includes(area);
  }

  private todosView(pid: string, done = false): OwnerTodosView {
    const t = this.todosModule().inSpace(pid);
    const list = t.listTodos({ done });
    const projects = t.listProjects();
    return {
      today: list.ok ? list.value.today : '',
      todos: list.ok ? (list.value.todos as PersonTodo[]) : [],
      projects: projects.ok ? projects.value.projects : [],
    };
  }

  private todayTile(pid: string, day: string): { open: number; overdue: number; due: PersonTodo[] } {
    const c = this.core();
    const t = this.todosModule().inSpace(pid);
    const list = t.listTodos({ done: false });
    const todos = list.ok ? (list.value.todos as PersonTodo[]) : [];
    const today = c ? c.today() : day;
    const now = c ? hhmmOf(c.now(), c.tz()) : '00:00';
    const isToday = day === today;
    const overdue = todos.filter((x) => isOverdue(x, day, isToday ? now : '00:00'));
    const due = todos.filter((x) => x.due?.day !== undefined && x.due.day <= day).sort(byDue);
    return { open: todos.length, overdue: overdue.length, due };
  }

  /** The review he sees on a day, at his level (null: off, or nothing to review). */
  private reviewOf(pid: string, day: string, a: Agreement): ReviewView | null {
    const plans = this.people.plans;
    if (!plans || a.see.review === 'off' || !a.see.plan) return null;
    return plans.reviewView(pid, day, a.see.review);
  }

  /**
   * Concern lines, derived when he looks (C22), from the plan only: a
   * check-in step whose time went by unanswered, and late steps. Never from
   * sleep, the journal, moods or review outcomes (the honesty rule).
   */
  private concerns(plan: PlanView | null): string[] {
    const c = this.core();
    if (!plan?.plan || !c || plan.day !== c.today()) return [];
    const out: string[] = [];
    const now = minuteOf(hhmmOf(c.now(), c.tz()));
    const missedCheckin = plan.plan.steps.some((s) => s.ask === 'checkin' && !s.checkin && !s.carriedTo && s.status !== 'excused' && s.at !== undefined && minuteOf(s.at) < now && s.at < '12:00');
    if (missedCheckin) out.push('No morning check-in yet');
    if (plan.late.length >= 2) out.push(`${plan.late.length} steps late`);
    return out;
  }

  /**
   * One area of hers as the agreement shows it. null: no such area in this
   * build. `{locked: true}`: the agreement has it off (only Today shows
   * locked tiles to him; his area routes answer 404 for it).
   */
  view(pid: string, area: Area, a: Agreement, opts: ViewOpts = {}): AreaView | null {
    if (!this.has(area)) return null;
    const c = this.core();
    switch (area) {
      case 'todos':
        return a.see.todos ? this.todosView(pid, opts.done) : LOCKED;
      case 'weight':
        return a.see.weight ? this.space.weights(pid) : LOCKED;
      case 'plan':
        return a.see.plan && this.people.plans ? this.people.plans.view(pid, opts.day ?? (c ? c.today() : '')) : LOCKED;
      case 'review': {
        if (!c) return LOCKED;
        return this.reviewOf(pid, opts.day ?? c.today(), a) ?? LOCKED;
      }
      case 'sleep': {
        if (!a.see.sleep || !this.people.sleep) return LOCKED;
        const r = this.people.sleep.week(pid, { week: opts.week, from: opts.from, to: opts.to });
        return r.ok ? r.value : LOCKED;
      }
      case 'journal': {
        if (!a.see.journal || !this.people.journal) return LOCKED;
        const r = this.people.journal.list(pid, { before: opts.before, day: opts.day });
        return r.ok ? r.value : LOCKED;
      }
      case 'today': {
        const day = opts.day ?? (c ? c.today() : '');
        const p = this.people.person(pid);
        const st = this.people.gateState(pid);
        const plan = a.see.plan && this.people.plans ? this.people.plans.view(pid, day) : null;
        // The day's review from her review time on (an earlier day's at once), at his level.
        let review: PersonToday['review'] = null;
        if (c && this.people.plans && (day < c.today() || hhmmOf(c.now(), c.tz()) >= (p?.prefs.reviewAt ?? '21:00'))) {
          if (a.see.review === 'off' || !a.see.plan) review = LOCKED;
          else if (this.people.plans.reviewable(pid, day)) review = this.reviewOf(pid, day, a);
        }
        let sleep: PersonToday['sleep'] = LOCKED;
        if (a.see.sleep) {
          const open = this.people.sleep?.openNight(pid) ?? null;
          sleep = { open: open ? { since: open.bedAt, night: open.night } : null };
        }
        return {
          day,
          name: p?.name ?? 'Your partner',
          state: st === 'paused' ? 'paused' : 'active',
          todos: a.see.todos ? this.todayTile(pid, day) : LOCKED,
          meds: null,
          weight: a.see.weight ? { latest: this.space.weights(pid).latest } : LOCKED,
          // Food joins with its routes (a later commit of P1); with her food module off it never exists (O6).
          food: null,
          plan: plan ?? LOCKED,
          status: a.see.plan ? this.people.statusOf(p) : LOCKED,
          review,
          sleep,
          concerns: this.concerns(plan),
        };
      }
      default:
        return null;
    }
  }

  /** His read (`/v1/people/:pid/<area>`): the view, and a view mark for her record. */
  ownerViewOf(pid: string, area: Area, opts: ViewOpts = {}): AreaView | null {
    const reach = this.people.ownerReach(pid);
    if (reach !== 'active' && reach !== 'paused') return null;
    const a = this.people.agreement(pid);
    if (!a) return null;
    const v = this.view(pid, area, a, opts);
    if (v === null) return null;
    if (!('locked' in v)) this.people.viewMark(pid, area);
    return v;
  }

  /** His read of one journal entry (see.journal), with the journal's view mark. */
  ownerJournalEntry(pid: string, id: string): JournalEntryFull | null {
    const reach = this.people.ownerReach(pid);
    const a = this.people.agreement(pid);
    if ((reach !== 'active' && reach !== 'paused') || !a?.see.journal || !this.people.journal) return null;
    const r = this.people.journal.get(pid, id);
    if (!r.ok) return null;
    this.people.viewMark(pid, 'journal');
    return r.value;
  }

  /** Her mirror: exactly his view, with her live agreement, and no view mark. */
  mirror(pid: string, area: Area, opts: ViewOpts = {}): AreaView | null {
    const a = this.people.agreement(pid);
    if (!a) return null;
    return this.view(pid, area, a, opts);
  }

  /** Her own Today: reminders and to-dos due (P1); her plan, status, review and sleep cards and the sharing check-in (P2). */
  herToday(pid: string, day?: string): PersonOwnToday {
    const c = this.core();
    const today = c ? c.today() : '';
    const d = day ?? today;
    const tile = this.todayTile(pid, d);
    const plans = this.people.plans;
    const p = this.people.person(pid);
    const now = c ? hhmmOf(c.now(), c.tz()) : '00:00';
    const open = this.people.sleep?.openNight(pid) ?? null;
    const evening = now >= '20:00' || now < '04:00';
    const plan = plans ? plans.herView(pid, d) : { day: d, plan: null, now: null, next: null, late: [], focus: null, slots: {}, counts: { done: 0, total: 0 } };
    return {
      day: d,
      today,
      meds: null,
      todos: tile.due,
      overdue: tile.overdue,
      plan,
      status: this.people.statusOf(p),
      review: d === today && plans ? plans.reviewCard(pid) : null,
      sleep: {
        open: open ? { since: open.bedAt, night: open.night } : null,
        showStart: d === today && evening && open === null,
        askWake: d === today ? (this.people.sleep?.askWake(pid) ?? null) : null,
      },
      sharingCheckin: d === today && this.people.sharingCheckinDue(pid),
      alertsUnseen: this.people.alerts?.unseenBy(pid) ?? 0,
      prompt: promptForDay(JOURNAL_PROMPTS, today || d),
    };
  }
}
