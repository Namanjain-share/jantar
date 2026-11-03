/**
 * v0.11 People (spec 3.5): her food log, over the Food module in her space.
 *
 * The rules:
 * - It exists only while her food module is on (O6, `jantar people modules
 *   <name> --food on|off`). While it is off every route of hers answers the
 *   one "food log is off" 404, her Today shows no food, her chat has no food
 *   tool, and his reads are the unknown-pid 404. The switch can't go off
 *   while she has entries (module.ts setModules), so it never hides her own
 *   data from her.
 * - Only she writes it: log what she ate (calories optional: an item
 *   without them counts as 0 and shows no number), edit or delete an entry,
 *   set her calorie target and goal weight (her own meta keys). He has no
 *   food verb at all (D22).
 * - His view (`see.food`): `full` is what her join page words as "what you
 *   ate, its calories and each day's total against your target": the day's
 *   items (name and calories, in the order she logged them, never when) and
 *   the last 7 days' totals. `counts` is how many meals she logged, today
 *   and on each of the last 7 days, naming nothing. Never her saved foods,
 *   and never her weight, which is its own area.
 * - Her writes tick her stream, and his only while he sees her food log
 *   (M11). Her own writes leave no Activity row (C8); his reads leave a view
 *   mark (views.ts).
 */
import { shiftDay } from '@jantar/life-core';
import type { FoodBody, FoodDay, FoodPatch, FoodTargetsBody } from '@jantar/protocol';
import { FOOD_WEEK_DAYS, type Agreement, type OwnerFoodView, type PersonFoodBody, type PersonToday } from '@jantar/protocol/people';
import type { Actor, FoodModule, LifeCore, LifeResult } from '../../contracts.js';
import type { PeopleModule } from './module.js';

export const FOOD_REASONS = {
  /** Her routes while her food module is off (spec 3.5's 404 `module_off`). */
  off: 'The food log is off in this space.',
  closed: 'Life is not open right now. Try again in a moment.',
} as const;

type Refusal = Extract<LifeResult, { ok: false }>;
const refuse = (code: Refusal['code'], reason: string): Refusal => ({ ok: false, code, reason });

/** "2 meals", "1 meal". */
export function mealsWord(n: number): string {
  return `${n} meal${n === 1 ? '' : 's'}`;
}

export class PersonFood {
  constructor(
    private readonly people: PeopleModule,
    private readonly foodModule: () => FoodModule,
    private readonly core: () => LifeCore | null,
  ) {}

  private food(pid: string): FoodModule {
    return this.foodModule().inSpace(pid);
  }

  /** Her food module (O6): her food log exists only while it is on. */
  on(pid: string): boolean {
    return this.people.person(pid)?.modules.food === true;
  }

  /** Her routes: Life open, and her food module on (else the one 404). */
  private gate(pid: string): Refusal | null {
    if (!this.core()) return refuse('unavailable', FOOD_REASONS.closed);
    if (!this.on(pid)) return refuse('not_found', FOOD_REASONS.off);
    return null;
  }

  private wrote<T>(pid: string, r: LifeResult<T>): LifeResult<T> {
    if (r.ok) this.people.herWrote(pid, 'food');
    return r;
  }

  // --- her side ----------------------------------------------------------------------

  herDay(pid: string, day?: string): LifeResult<FoodDay> {
    return this.gate(pid) ?? this.food(pid).day(day);
  }

  /** What she ate (calories optional), or one of her saved foods. */
  herAdd(pid: string, body: PersonFoodBody, actor: Actor): LifeResult<{ id: string }> {
    const g = this.gate(pid);
    if (g) return g;
    const b: FoodBody = 'savedId' in body ? body : { day: body.day, name: body.name, kcal: body.kcal ?? 0, ...(body.save ? { save: true } : {}) };
    return this.wrote(pid, this.food(pid).add(b, actor));
  }

  herUpdate(pid: string, id: string, patch: FoodPatch, actor: Actor): LifeResult {
    return this.gate(pid) ?? this.wrote(pid, this.food(pid).update(id, patch, actor));
  }

  herDelete(pid: string, id: string, actor: Actor): LifeResult {
    return this.gate(pid) ?? this.wrote(pid, this.food(pid).remove(id, actor));
  }

  /** Her calorie target and goal weight (her own meta keys; his `full` view shows the target). */
  herTargets(pid: string, body: FoodTargetsBody, actor: Actor): LifeResult {
    return this.gate(pid) ?? this.wrote(pid, this.food(pid).setTargets(body, actor));
  }

  /** Her Today's food line: the day's meals, calories and her target (null while her module is off). */
  herToday(pid: string, day: string): { meals: number; kcal: number; target: number } | null {
    if (!this.core() || !this.on(pid)) return null;
    const r = this.food(pid).day(day);
    return r.ok ? { meals: r.value.entries.length, kcal: r.value.kcal, target: r.value.target } : null;
  }

  // --- his view ----------------------------------------------------------------------

  /**
   * Her food log at a level (`full` or `counts`), for `day` (default today)
   * and the 7 days up to it. null: Life is closed, her module is off, or the
   * day isn't real (his route answers 404).
   */
  view(pid: string, level: 'counts' | 'full', day?: string): OwnerFoodView | null {
    const c = this.core();
    if (!c || !this.on(pid)) return null;
    const m = this.food(pid);
    const today = c.today();
    const d = day ?? today;
    const r = m.day(d);
    if (!r.ok) return null;
    const week = Array.from({ length: FOOD_WEEK_DAYS }, (_, i) => shiftDay(d, -i));
    if (level === 'counts') {
      const counts = m.countsBetween(week[week.length - 1] as string, d);
      return { level: 'counts', day: d, today, meals: r.value.entries.length, days: week.map((x) => ({ day: x, meals: counts.get(x) ?? 0 })) };
    }
    const days = week.map((x) => {
      const v = x === d ? r : m.day(x);
      return v.ok ? { day: x, meals: v.value.entries.length, kcal: v.value.kcal } : { day: x, meals: 0, kcal: 0 };
    });
    return {
      level: 'full',
      day: d,
      today,
      target: r.value.target,
      kcal: r.value.kcal,
      items: r.value.entries.map((e) => ({ id: e.id, name: e.name, kcal: e.kcal })),
      days,
    };
  }

  /** Her food on his Today (and her mirror of it): null while her module is off, a locked tile while see.food is. */
  todayTile(pid: string, a: Agreement, day: string): PersonToday['food'] {
    if (!this.core() || !this.on(pid)) return null;
    if (a.see.food === 'off') return { locked: true };
    const r = this.food(pid).day(day);
    const meals = r.ok ? r.value.entries.length : 0;
    if (a.see.food === 'counts') return { level: 'counts', meals };
    return { level: 'full', meals, kcal: r.ok ? r.value.kcal : 0, target: r.ok ? r.value.target : 0 };
  }

  /** His 21:00 summary's food words, from today's agreement: "2 meals logged" (counts), with the calories at full. */
  summaryParts(pid: string): string[] {
    const a = this.people.agreement(pid);
    const c = this.core();
    if (!a || a.see.food === 'off' || !c || !this.on(pid)) return [];
    const r = this.food(pid).day(c.today());
    if (!r.ok) return [];
    const n = r.value.entries.length;
    if (n === 0) return ['no meals logged'];
    return [a.see.food === 'full' ? `${mealsWord(n)} logged (${r.value.kcal} kcal)` : `${mealsWord(n)} logged`];
  }
}
