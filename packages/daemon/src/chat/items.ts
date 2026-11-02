/**
 * Chat's view of one item (spec 0.10 B8): find it as it is now (Undo's
 * "changed since" check, a card's label, a change's label) and name it in
 * a short label the daemon writes, never the model: "Todo · Buy milk ·
 * tomorrow 09:00", "Café · Sample Dosa House · 4★".
 */
import {
  POST_KIND_LABEL,
  POST_PLATFORM_LABEL,
  type Bill,
  type FoodEntry,
  type MedicineView,
  type Meeting,
  type MoneyEntry,
  type Place,
  type PlaceVisit,
  type Post,
  type ProjectView,
  type Todo,
} from '@jantar/protocol';
import { shiftDay, shiftMonths } from '@jantar/life-core';
import { cut, line } from './text.js';
import type { ChatDeps } from './types.js';

/** The kinds of item a change or a card points at. */
export type ItemKind = 'todo' | 'project' | 'medicine' | 'meal' | 'place' | 'visit' | 'money' | 'bill' | 'post' | 'meeting' | 'intel';

/** One item: its id, and where it lives when that is needed to find it (a visit's café, a meal's day, an entry's day). */
export interface ItemRef {
  kind: ItemKind;
  id: string;
  /** A visit's café. */
  parent?: string;
  /** A meal's day, a money entry's day. */
  day?: string;
}

const ok = <T>(r: { ok: true; value: T } | { ok: false }): T | null => (r.ok ? r.value : null);

export function findTodo(d: ChatDeps, id: string): Todo | null {
  const t = d.life.todos;
  for (const done of [false, true]) {
    const r = ok(t.listTodos({ done }));
    const hit = r?.todos.find((x) => x.id === id);
    if (hit) return hit;
  }
  return null;
}

export function findProject(d: ChatDeps, id: string): ProjectView | null {
  return ok(d.life.todos.listProjects())?.projects.find((p) => p.id === id) ?? null;
}

export function findMedicine(d: ChatDeps, id: string): MedicineView | null {
  return ok(d.life.medicines.get())?.medicines.find((m) => m.id === id) ?? null;
}

/** Days of a medicine's checklists `medicineHasDoses` reads at most: an add's Undo is within a day of startedOn. */
const DOSE_DAYS_MAX = 7;

/**
 * Whether a dose (taken or skipped) is logged for the medicine. A dose is only ever logged from its
 * startedOn to today, and every logged one is on its day's checklist (one off the schedule too), so
 * those days are read. Past DOSE_DAYS_MAX days it answers yes: it can't tell cheaply, and yes only
 * keeps something.
 */
export function medicineHasDoses(d: ChatDeps, id: string): boolean {
  const now = ok(d.life.medicines.get());
  const med = now?.medicines.find((m) => m.id === id);
  if (!now || !med) return false;
  const today = now.day.today;
  let day = med.startedOn;
  for (let n = 0; day <= today; n++, day = shiftDay(day, 1)) {
    if (n >= DOSE_DAYS_MAX) return true;
    const groups = day === now.day.day ? now.day.groups : ok(d.life.medicines.get(day))?.day.groups;
    if (groups?.some((g) => g.items.some((x) => x.medId === id && x.doseId !== undefined))) return true;
  }
  return false;
}

export function findMeal(d: ChatDeps, id: string, day: string | undefined): FoodEntry | null {
  if (!day) return null;
  return ok(d.life.food.day(day))?.entries.find((e) => e.id === id) ?? null;
}

export function findPlace(d: ChatDeps, id: string): Place | null {
  return ok(d.life.places.get(id))?.place ?? null;
}

export function findVisit(d: ChatDeps, placeId: string | undefined, id: string): PlaceVisit | null {
  if (!placeId) return null;
  return ok(d.life.places.get(placeId))?.visits.find((v) => v.id === id) ?? null;
}

/** A money entry: its day's month first, then this month and the 12 before it. */
export function findMoney(d: ChatDeps, id: string, day?: string): MoneyEntry | null {
  const months: string[] = [];
  if (day) months.push(day.slice(0, 7));
  const now = ok(d.life.finance.month());
  const current = now?.month;
  if (current) for (let i = 0; i <= 12; i++) months.push(shiftMonths(`${current}-01`, -i).slice(0, 7));
  for (const m of [...new Set(months)]) {
    const hit = ok(d.life.finance.month(m))?.entries.find((e) => e.id === id);
    if (hit) return hit;
  }
  return null;
}

export function findBill(d: ChatDeps, id: string): Bill | null {
  return ok(d.life.finance.month())?.bills.find((b) => b.id === id) ?? null;
}

export function findPost(d: ChatDeps, id: string): Post | null {
  for (const done of [false, true]) {
    const hit = ok(d.life.posts.list({ done }))?.posts.find((p) => p.id === id);
    if (hit) return hit;
  }
  return null;
}

export function findMeeting(d: ChatDeps, id: string): Meeting | null {
  const r = d.meetings.library.get(id);
  return r.ok ? r.value.meeting : null;
}

/** The item as it is now, as a plain record (Undo compares keys of it), or null when it is gone. */
export function current(d: ChatDeps, ref: ItemRef): Record<string, unknown> | null {
  switch (ref.kind) {
    case 'todo':
      return findTodo(d, ref.id);
    case 'project':
      return findProject(d, ref.id);
    case 'medicine':
      return findMedicine(d, ref.id);
    case 'meal':
      return findMeal(d, ref.id, ref.day);
    case 'place':
      return findPlace(d, ref.id);
    case 'visit':
      return findVisit(d, ref.parent, ref.id);
    case 'money':
      return findMoney(d, ref.id, ref.day);
    case 'bill':
      return findBill(d, ref.id);
    case 'post':
      return findPost(d, ref.id);
    case 'meeting': {
      const m = findMeeting(d, ref.id);
      return m ? { ...m } : null;
    }
    case 'intel': {
      const i = d.intel.get(ref.id);
      return i ? { ...i } : null;
    }
  }
}

const name = (s: string | undefined, n = 80) => cut(line(s ?? ''), n);

function dueText(due: { day: string; time?: string | undefined } | undefined): string {
  if (!due) return '';
  return due.time ? `${due.day} ${due.time}` : due.day;
}

function money(amount: number): string {
  const units = amount / 100;
  return Number.isInteger(units) ? String(units) : units.toFixed(2);
}

/** The label of an item as it is now (a change's or a card's), at most 160 characters; `fallback` when it is gone. */
export function labelOf(d: ChatDeps, ref: ItemRef, fallback = ''): string {
  const parts = (...p: (string | undefined | false)[]) => cut(p.filter((x): x is string => typeof x === 'string' && x !== '').join(' · '), 160);
  switch (ref.kind) {
    case 'todo': {
      const t = findTodo(d, ref.id);
      return t ? parts('Todo', name(t.title), dueText(t.due), t.repeat ? `repeats ${t.repeat.freq}` : '', t.doneAt ? 'done' : '') : fallback;
    }
    case 'project': {
      const p = findProject(d, ref.id);
      return p ? parts('Project', name(p.name), p.status !== 'active' && p.status) : fallback;
    }
    case 'medicine': {
      const m = findMedicine(d, ref.id);
      return m ? parts('Medicine', name(m.name), m.dose && name(m.dose, 40), m.times.join(' ')) : fallback;
    }
    case 'meal': {
      const f = findMeal(d, ref.id, ref.day);
      return f ? parts('Food', name(f.name), `${f.kcal} kcal`, f.day) : fallback;
    }
    case 'place': {
      const p = findPlace(d, ref.id);
      return p ? parts('Café', name(p.name), p.stars ? `${p.stars}★` : '', p.area && name(p.area, 40)) : fallback;
    }
    case 'visit': {
      const v = findVisit(d, ref.parent, ref.id);
      const p = ref.parent ? findPlace(d, ref.parent) : null;
      return v ? parts('Visit', p ? name(p.name) : '', v.day, v.stars ? `${v.stars}★` : '', v.spend !== undefined ? money(v.spend) : '') : fallback;
    }
    case 'money': {
      const m = findMoney(d, ref.id, ref.day);
      return m ? parts(m.kind === 'income' ? 'Income' : 'Expense', money(m.amount), name(m.category, 24), m.note && name(m.note, 40), m.day) : fallback;
    }
    case 'bill': {
      const b = findBill(d, ref.id);
      return b ? parts('Bill', name(b.name), money(b.amount), `due ${b.nextDue}`) : fallback;
    }
    case 'post': {
      const p = findPost(d, ref.id);
      return p ? parts(POST_KIND_LABEL[p.kind][0], POST_PLATFORM_LABEL[p.platform], p.title && name(p.title), dueText(p.due), p.status) : fallback;
    }
    case 'meeting': {
      const m = findMeeting(d, ref.id);
      return m ? parts('Meeting', name(m.name)) : fallback;
    }
    case 'intel': {
      const i = d.intel.get(ref.id);
      return i ? parts('Intel', name(i.title)) : fallback;
    }
  }
}
