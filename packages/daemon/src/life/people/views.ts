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
 */
import { builtAreas, type Agreement, type Area, type Locked, type OwnerTodosView, type PersonOwnToday, type PersonToday, type PersonTodo, type PersonWeightsResponse } from '@jantar/protocol/people';
import { hhmmOf } from '@jantar/life-core';
import type { LifeCore, TodosModule } from '../../contracts.js';
import { byDue, isOverdue } from '../todos/module.js';
import type { PeopleModule } from './module.js';
import type { PersonSpace } from './space.js';

const LOCKED: Locked = { locked: true };

/** The areas this build's views answer (the rest are a later commit's or phase's: 404). */
const VIEW_AREAS: ReadonlySet<Area> = new Set<Area>(['today', 'todos', 'weight']);

export type AreaView = OwnerTodosView | PersonWeightsResponse | PersonToday | Locked;

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

  /**
   * One area of hers as the agreement shows it. null: no such area in this
   * build. `{locked: true}`: the agreement has it off (only Today shows
   * locked tiles to him; his area routes answer 404 for it).
   */
  view(pid: string, area: Area, a: Agreement, opts: { day?: string | undefined; done?: boolean } = {}): AreaView | null {
    if (!this.has(area)) return null;
    switch (area) {
      case 'todos':
        return a.see.todos ? this.todosView(pid, opts.done) : LOCKED;
      case 'weight':
        return a.see.weight ? this.space.weights(pid) : LOCKED;
      case 'today': {
        const c = this.core();
        const day = opts.day ?? (c ? c.today() : '');
        const p = this.people.person(pid);
        const st = this.people.gateState(pid);
        return {
          day,
          name: p?.name ?? 'Your partner',
          state: st === 'paused' ? 'paused' : 'active',
          todos: a.see.todos ? this.todayTile(pid, day) : LOCKED,
          meds: null,
          weight: a.see.weight ? { latest: this.space.weights(pid).latest } : LOCKED,
          // Food joins with its routes (a later commit of P1); with her food module off it never exists (O6).
          food: null,
        };
      }
      default:
        return null;
    }
  }

  /** His read (`/v1/people/:pid/<area>`): the view, and a view mark for her record. */
  ownerViewOf(pid: string, area: Area, opts: { day?: string | undefined; done?: boolean } = {}): AreaView | null {
    const reach = this.people.ownerReach(pid);
    if (reach !== 'active' && reach !== 'paused') return null;
    const a = this.people.agreement(pid);
    if (!a) return null;
    const v = this.view(pid, area, a, opts);
    if (v === null) return null;
    if (!('locked' in v)) this.people.viewMark(pid, area);
    return v;
  }

  /** Her mirror: exactly his view, with her live agreement, and no view mark. */
  mirror(pid: string, area: Area, opts: { day?: string | undefined } = {}): AreaView | null {
    const a = this.people.agreement(pid);
    if (!a) return null;
    return this.view(pid, area, a, opts);
  }

  /** Her own Today (P1): reminders and to-dos due or overdue (her medicines join with their routes). */
  herToday(pid: string, day?: string): PersonOwnToday {
    const c = this.core();
    const today = c ? c.today() : '';
    const d = day ?? today;
    const tile = this.todayTile(pid, d);
    return { day: d, today, meds: null, todos: tile.due, overdue: tile.overdue };
  }
}
