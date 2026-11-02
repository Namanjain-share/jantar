/**
 * Chat's writes, deletes and actions (spec 0.10 A6, B7.2, B7.3, B8).
 *
 * A write tool's input is checked against Life's own body schema, the
 * module is called with the turn's actor (so Life's checks, caps, pings and
 * `life.changed` apply as they are), and the daemon writes the change's
 * label from the item afterwards. Each write leaves a journal: the steps
 * that put things back, with the values an edit changed (before and after),
 * so Undo refuses an edit that changed since. A delete or an irreversible
 * action is only ever described here for a card; it runs on the user's tap
 * (runCardAction), as the tapping device.
 *
 * Nothing here logs or emits; errors are fixed sentences.
 */
import { z } from 'zod';
import {
  AmountSchema,
  BillBodySchema,
  BillPaidBodySchema,
  BillPatchSchema,
  BudgetBodySchema,
  CategorySchema,
  DayKeySchema,
  DoseBodySchema,
  FoodNameSchema,
  FoodPatchSchema,
  FoodTargetsBodySchema,
  IntelDepthSchema,
  KcalSchema,
  LifeIdSchema,
  MedicineBodySchema,
  MedicinePatchSchema,
  MeetingPatchSchema,
  MoneyBodySchema,
  MoneyPatchSchema,
  PlaceBodySchema,
  PlacePatchSchema,
  PlaceVisitBodySchema,
  PlaceVisitPatchSchema,
  PostBodySchema,
  PostGoalsBodySchema,
  PostPatchSchema,
  ProjectBodySchema,
  ProjectPatchSchema,
  SnoozePresetSchema,
  TodoBodySchema,
  TodoPatchSchema,
  WeightBodySchema,
  type ChatModule,
  type Dish,
  type DoseBody,
  type FoodTargetsBody,
  type PostGoal,
} from '@jantar/protocol';
import type { Actor, LifeResult } from '../contracts.js';
import { current, findMedicine, findMeeting, findPlace, findTodo, labelOf, type ItemRef } from './items.js';
import type { ChangeJson } from './store.js';
import { cut, line } from './text.js';
import type { ChatDeps } from './types.js';

type Refusal = Extract<LifeResult, { ok: false }>;
const refuse = (code: Refusal['code'], reason: string): Refusal => ({ ok: false, code, reason });

export const ACTION_SENTENCES = {
  bad: "That can't be done as it is.",
  gone: 'That is not there any more.',
  changed: "That changed after Chat's edit; change it back by hand.",
  noUndo: 'Nothing to undo.',
  undone: 'Already undone.',
  old: 'Over a day old. Change it in its own screen instead.',
  noDish: 'No dish by that name at this café.',
  noItem: 'This meeting has no such action item.',
  noWeight: 'No weight on that day.',
  noBudget: 'No budget for that category.',
  noDose: 'No dose logged at that time.',
  stopped: 'That medicine is already stopped.',
  nothing: 'Nothing to change.',
  alreadyDone: 'That todo is already done.',
  alreadyOpen: 'That todo is already open.',
  hasVisits: 'That café has visits now. Delete it in its own screen instead.',
} as const;

const Id = LifeIdSchema;
const Rating = z.number().int().min(1).max(5);
const IntelId = z.string().min(1).max(200);

/** v0.10 (A6): a dish added or changed by name; null clears a field. */
const DishSetSchema = z.strictObject({
  placeId: Id,
  name: z.string().trim().min(1).max(60),
  rating: Rating.nullable().optional(),
  price: AmountSchema.nullable().optional(),
  again: z.boolean().nullable().optional(),
  notes: z.string().max(200).nullable().optional(),
});

/** Every write tool's input (the tool lists it as JSON Schema). */
export const WRITE_INPUTS = {
  todo_add: TodoBodySchema,
  todo_edit: z.strictObject({ id: Id, ...TodoPatchSchema.shape }),
  todo_done: z.strictObject({ id: Id, done: z.boolean().optional() }),
  todo_snooze: z.strictObject({ id: Id, preset: SnoozePresetSchema }),
  project_add: z.strictObject({ ...ProjectBodySchema.omit({ folder: true }).shape }),
  project_edit: z.strictObject({ id: Id, ...ProjectPatchSchema.omit({ folder: true }).shape }),
  med_add: MedicineBodySchema,
  med_edit: z.strictObject({ id: Id, ...MedicinePatchSchema.shape }),
  dose_log: z.strictObject({ medId: Id, ...DoseBodySchema.shape }),
  food_add: z.strictObject({ day: DayKeySchema, name: FoodNameSchema, kcal: KcalSchema }),
  food_edit: z.strictObject({ id: Id, day: DayKeySchema, ...FoodPatchSchema.shape }),
  weight_set: z.strictObject({ day: DayKeySchema, ...WeightBodySchema.shape }),
  food_targets_set: FoodTargetsBodySchema,
  place_add: PlaceBodySchema,
  // Not `dishes`: a wholesale replace would drop dishes with no Confirm card. dish_set adds or changes one, request_delete removes one.
  place_edit: z.strictObject({ id: Id, ...PlacePatchSchema.omit({ dishes: true }).shape }),
  dish_set: DishSetSchema,
  visit_log: z.strictObject({
    placeId: Id,
    ...PlaceVisitBodySchema.shape,
    /** Rate dishes named in `had` (added to the café's dishes when new). */
    dishRatings: z.array(z.strictObject({ name: z.string().trim().min(1).max(60), rating: Rating })).max(10).optional(),
  }),
  visit_edit: z.strictObject({ placeId: Id, visitId: Id, ...PlaceVisitPatchSchema.shape }),
  money_add: MoneyBodySchema,
  money_edit: z.strictObject({ id: Id, ...MoneyPatchSchema.shape }),
  budget_set: z.strictObject({ category: CategorySchema, amount: AmountSchema }),
  bill_add: BillBodySchema,
  bill_edit: z.strictObject({ id: Id, ...BillPatchSchema.shape }),
  bill_paid: z.strictObject({ id: Id, ...BillPaidBodySchema.shape }),
  post_add: z.strictObject({ ...PostBodySchema.omit({ postedUrl: true, status: true }).shape, status: z.enum(['idea', 'ready']).optional() }),
  post_edit: z.strictObject({ id: Id, ...PostPatchSchema.shape }),
  post_goals_set: PostGoalsBodySchema,
  meeting_edit: z.strictObject({ id: Id, ...MeetingPatchSchema.shape }),
  meeting_item_todo: z.strictObject({ id: Id, n: z.number().int().min(0).max(29) }),
  intel_save: z.strictObject({ url: z.url({ protocol: /^https?$/ }).max(2000), depth: IntelDepthSchema.optional() }),
} as const;
export type WriteTool = keyof typeof WRITE_INPUTS;
export const WRITE_TOOLS = Object.keys(WRITE_INPUTS) as WriteTool[];

/** The part each write needs on. */
export const WRITE_MODULE: Readonly<Record<WriteTool, ChatModule>> = {
  todo_add: 'todos',
  todo_edit: 'todos',
  todo_done: 'todos',
  todo_snooze: 'todos',
  project_add: 'todos',
  project_edit: 'todos',
  med_add: 'medicines',
  med_edit: 'medicines',
  dose_log: 'medicines',
  food_add: 'food',
  food_edit: 'food',
  weight_set: 'food',
  food_targets_set: 'food',
  place_add: 'places',
  place_edit: 'places',
  dish_set: 'places',
  visit_log: 'places',
  visit_edit: 'places',
  money_add: 'finance',
  money_edit: 'finance',
  budget_set: 'finance',
  bill_add: 'finance',
  bill_edit: 'finance',
  bill_paid: 'finance',
  post_add: 'posts',
  post_edit: 'posts',
  post_goals_set: 'posts',
  meeting_edit: 'meetings',
  meeting_item_todo: 'meetings',
  intel_save: 'intel',
};

/**
 * One step that puts something back. Undo runs a journal's steps last first,
 * after checking that every step's `after` (Chat's value) still holds: an
 * edit's keys, a todo's done state, a day's weight, the targets, a budget,
 * the goals, a dose. A value changed since is the user's: 409.
 */
export type Step =
  | { do: 'remove'; item: ItemRef }
  | { do: 'patch'; item: ItemRef; before: Record<string, unknown>; after: Record<string, unknown> }
  /** Put the todo back to `done` (what it was before Chat's call); Chat's call left it `!done`. */
  | { do: 'todoDone'; id: string; done: boolean }
  | { do: 'weight'; day: string; kg: number | null; after: number }
  | { do: 'targets'; body: FoodTargetsBody; after: FoodTargetsBody }
  | { do: 'budget'; category: string; amount: number | null; after: number }
  | { do: 'goals'; goals: PostGoal[]; after: PostGoal[] }
  | { do: 'dose'; medId: string; doseId: string; prev: DoseBody | null; day: string; slot: string; status: DoseBody['status'] }
  /** After a visit's Undo: the café untried again, unless it has other visits by then. */
  | { do: 'untried'; placeId: string }
  | { do: 'meetingTodo'; id: string; n: number };

export interface Journal {
  steps: Step[];
}

export interface Applied {
  change: ChangeJson;
  journal: Journal | null;
}

/** null and absent are the same value. */
const norm = (v: unknown): unknown => (v === undefined ? null : v);

/** Stable JSON: object keys sorted (an edit's before and after compare by value). */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`)
      .join(',')}}`;
  }
  return JSON.stringify(norm(v));
}

/** The values of `record` at the keys `patch` names (a nested `ratings` patch reads per key), null for absent. */
export function pickKeys(record: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === 'ratings' && v && typeof v === 'object' && !Array.isArray(v)) {
      const cur = (record.ratings ?? {}) as Record<string, unknown>;
      out.ratings = Object.fromEntries(Object.keys(v).map((r) => [r, norm(cur[r])]));
    } else out[k] = norm(record[k]);
  }
  return out;
}

/** Every key of `after` still holds its value in `record`. */
export function unchangedSince(record: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return stable(pickKeys(record, after)) === stable(after);
}

/** The module's patch for an item kind. */
function patchItem(d: ChatDeps, ref: ItemRef, patch: Record<string, unknown>, actor: Actor): LifeResult {
  const parse = <T>(schema: z.ZodType<T>, f: (p: T) => LifeResult): LifeResult => {
    const r = schema.safeParse(patch);
    return r.success ? f(r.data) : refuse('invalid_request', ACTION_SENTENCES.bad);
  };
  switch (ref.kind) {
    case 'todo':
      return parse(TodoPatchSchema, (p) => d.life.todos.updateTodo(ref.id, p, actor));
    case 'project':
      return parse(ProjectPatchSchema, (p) => d.life.todos.updateProject(ref.id, p, actor));
    case 'medicine':
      return parse(MedicinePatchSchema, (p) => d.life.medicines.update(ref.id, p, actor));
    case 'meal':
      return parse(FoodPatchSchema, (p) => d.life.food.update(ref.id, p, actor));
    case 'place':
      return parse(PlacePatchSchema, (p) => d.life.places.update(ref.id, p, actor));
    case 'visit':
      return ref.parent ? parse(PlaceVisitPatchSchema, (p) => d.life.places.visitUpdate(ref.parent as string, ref.id, p, actor)) : refuse('invalid_request', ACTION_SENTENCES.bad);
    case 'money':
      return parse(MoneyPatchSchema, (p) => d.life.finance.update(ref.id, p, actor));
    case 'bill':
      return parse(BillPatchSchema, (p) => d.life.finance.updateBill(ref.id, p, actor));
    case 'post':
      return parse(PostPatchSchema, (p) => d.life.posts.update(ref.id, p, actor));
    case 'meeting':
      return parse(MeetingPatchSchema, (p) => d.meetings.library.update(ref.id, p, actor));
    case 'intel':
      return refuse('invalid_request', ACTION_SENTENCES.bad);
  }
}

/** Delete an item as it is now (an add's Undo, and a Confirm card's tap). */
async function removeItem(d: ChatDeps, ref: ItemRef, actor: Actor): Promise<LifeResult> {
  switch (ref.kind) {
    case 'todo':
      return d.life.todos.removeTodo(ref.id, actor);
    case 'project':
      return d.life.todos.removeProject(ref.id, actor);
    case 'medicine':
      return d.life.medicines.remove(ref.id, actor);
    case 'meal':
      return d.life.food.remove(ref.id, actor);
    case 'place':
      return d.life.places.remove(ref.id, actor);
    case 'visit':
      return ref.parent ? d.life.places.visitRemove(ref.parent, ref.id, actor) : refuse('not_found', ACTION_SENTENCES.gone);
    case 'money':
      return d.life.finance.remove(ref.id, actor);
    case 'bill':
      return d.life.finance.removeBill(ref.id, actor);
    case 'post':
      return d.life.posts.remove(ref.id, actor);
    case 'meeting':
      return d.meetings.library.remove(ref.id, actor);
    case 'intel':
      return d.intel.remove(ref.id);
  }
}

/**
 * An edit: the item before, the module's update, the item after; the journal holds both sides of the changed
 * keys. An edit that changes nothing (no key, or every key already so) is refused, so the change list never
 * shows a change that did not happen.
 */
function edit(d: ChatDeps, ref: ItemRef, patch: Record<string, unknown>, actor: Actor, module: ChatModule, op: ChangeJson['op'] = 'edit'): LifeResult<Applied> {
  const before = current(d, ref);
  if (!before) return refuse('not_found', ACTION_SENTENCES.gone);
  const keys = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (Object.keys(keys).length === 0 || stable(pickKeys(before, keys)) === stable(keys)) return refuse('conflict', ACTION_SENTENCES.nothing);
  const r = patchItem(d, ref, patch, actor);
  if (!r.ok) return r;
  const after = current(d, ref) ?? {};
  const step: Step = { do: 'patch', item: ref, before: pickKeys(before, patch), after: pickKeys(after, patch) };
  // The module took it but kept what was there (a trimmed name, a tag already on).
  if (stable(step.before) === stable(step.after)) return refuse('conflict', ACTION_SENTENCES.nothing);
  return { ok: true, value: { change: { module, op, ref: ref.id, label: labelOf(d, ref), undoable: true }, journal: { steps: [step] } } };
}

/** An add: the module's create; Undo deletes it as it is then. */
function added(d: ChatDeps, r: LifeResult<{ id: string }>, ref: (id: string) => ItemRef, module: ChatModule, op: ChangeJson['op'] = 'add'): LifeResult<Applied> {
  if (!r.ok) return r;
  const item = ref(r.value.id);
  return { ok: true, value: { change: { module, op, ref: item.id, label: labelOf(d, item), undoable: true }, journal: { steps: [{ do: 'remove', item }] } } };
}

const split = <T extends Record<string, unknown>, K extends keyof T>(o: T, ...keys: K[]): Omit<T, K> => {
  const out = { ...o };
  for (const k of keys) delete out[k];
  return out;
};

/** A category's monthly budget now, or null. */
function budgetOf(d: ChatDeps, category: string): number | null {
  const m = d.life.finance.month();
  return m.ok ? (m.value.byCategory.find((c) => c.category.toLowerCase() === category.toLowerCase())?.budget ?? null) : null;
}

/** The weekly posting goals now (null when Posts can't be read). */
function goalsNow(d: ChatDeps): PostGoal[] | null {
  const list = d.life.posts.list({ done: false });
  return list.ok ? list.value.week.goals.map((g) => ({ platform: g.platform, ...(g.kind ? { kind: g.kind } : {}), perWeek: g.perWeek })) : null;
}

/** The targets now, at the keys `keys` names (null when Food can't be read). */
function targetsNow(d: ChatDeps, keys: FoodTargetsBody): FoodTargetsBody | null {
  const fd = d.life.food.day();
  if (!fd.ok) return null;
  return { ...(keys.kcalTarget !== undefined ? { kcalTarget: fd.value.target } : {}), ...(keys.goalKg !== undefined ? { goalKg: fd.value.weight.goalKg } : {}) };
}

/** A dose's day item for the medicine at `slot`, as it is now. */
function doseNow(d: ChatDeps, medId: string, day: string, slot: string): { doseId?: string; status: string } | null {
  const r = d.life.medicines.get(day);
  return r.ok ? (r.value.day.groups.flatMap((g) => g.items).find((x) => x.medId === medId && x.slot === slot) ?? null) : null;
}

/** Apply one write tool's checked input as `actor`. */
export async function applyWrite(d: ChatDeps, tool: WriteTool, raw: unknown, actor: Actor): Promise<LifeResult<Applied>> {
  const parsed = WRITE_INPUTS[tool].safeParse(raw);
  if (!parsed.success) return refuse('invalid_request', ACTION_SENTENCES.bad);
  const life = d.life;
  const module = WRITE_MODULE[tool];
  switch (tool) {
    case 'todo_add': {
      const body = WRITE_INPUTS.todo_add.parse(raw);
      return added(d, life.todos.createTodo(body, actor), (id) => ({ kind: 'todo', id }), module);
    }
    case 'todo_edit': {
      const i = WRITE_INPUTS.todo_edit.parse(raw);
      return edit(d, { kind: 'todo', id: i.id }, split(i, 'id'), actor, module);
    }
    case 'todo_done': {
      const i = WRITE_INPUTS.todo_done.parse(raw);
      const done = i.done ?? true;
      const before = findTodo(d, i.id);
      if (!before) return refuse('not_found', ACTION_SENTENCES.gone);
      const repeating = Boolean(before.repeat && before.due);
      // A one-off already so: the module changes nothing, so there is no change to show or undo.
      if (!repeating && Boolean(before.doneAt) === done) return refuse('conflict', done ? ACTION_SENTENCES.alreadyDone : ACTION_SENTENCES.alreadyOpen);
      const r = life.todos.setDone(i.id, done, actor);
      if (!r.ok) return r;
      const ref: ItemRef = { kind: 'todo', id: i.id };
      // A repeating todo's Done moves its due day (the phone's rule): Undo puts the old one back.
      const step: Step = repeating
        ? { do: 'patch', item: ref, before: { due: before.due ?? null }, after: { due: findTodo(d, i.id)?.due ?? null } }
        : { do: 'todoDone', id: i.id, done: Boolean(before.doneAt) };
      return { ok: true, value: { change: { module, op: done ? 'done' : 'undone', ref: i.id, label: labelOf(d, ref), undoable: true }, journal: { steps: [step] } } };
    }
    case 'todo_snooze': {
      const i = WRITE_INPUTS.todo_snooze.parse(raw);
      const before = findTodo(d, i.id);
      if (!before) return refuse('not_found', ACTION_SENTENCES.gone);
      const r = life.todos.snooze(i.id, i.preset, actor);
      if (!r.ok) return r;
      const ref: ItemRef = { kind: 'todo', id: i.id };
      const step: Step = { do: 'patch', item: ref, before: { due: before.due ?? null }, after: { due: findTodo(d, i.id)?.due ?? null } };
      return { ok: true, value: { change: { module, op: 'snooze', ref: i.id, label: labelOf(d, ref), undoable: true }, journal: { steps: [step] } } };
    }
    case 'project_add':
      return added(d, life.todos.createProject(WRITE_INPUTS.project_add.parse(raw), actor), (id) => ({ kind: 'project', id }), module);
    case 'project_edit': {
      const i = WRITE_INPUTS.project_edit.parse(raw);
      return edit(d, { kind: 'project', id: i.id }, split(i, 'id'), actor, module);
    }
    case 'med_add':
      return added(d, life.medicines.create(WRITE_INPUTS.med_add.parse(raw), actor), (id) => ({ kind: 'medicine', id }), module);
    case 'med_edit': {
      const i = WRITE_INPUTS.med_edit.parse(raw);
      return edit(d, { kind: 'medicine', id: i.id }, split(i, 'id'), actor, module);
    }
    case 'dose_log': {
      const i = WRITE_INPUTS.dose_log.parse(raw);
      const med = findMedicine(d, i.medId);
      if (!med) return refuse('not_found', ACTION_SENTENCES.gone);
      const day = life.medicines.get(i.day);
      const prior = day.ok ? day.value.day.groups.flatMap((g) => g.items).find((x) => x.medId === i.medId && x.slot === i.slot && x.doseId) : undefined;
      const prev: DoseBody | null =
        prior && (prior.status === 'taken' || prior.status === 'skipped') ? { day: i.day, slot: i.slot, status: prior.status, ...(prior.at ? { at: prior.at } : {}) } : null;
      const body = split(i, 'medId');
      const r = life.medicines.logDose(i.medId, body, actor);
      if (!r.ok) return r;
      const label = cut(`Dose · ${line(med.name)} · ${i.day} ${i.slot} · ${i.status}`, 160);
      const step: Step = { do: 'dose', medId: i.medId, doseId: r.value.id, prev, day: i.day, slot: i.slot, status: i.status };
      return { ok: true, value: { change: { module, op: 'log', ref: i.medId, label, undoable: true }, journal: { steps: [step] } } };
    }
    case 'food_add': {
      const i = WRITE_INPUTS.food_add.parse(raw);
      return added(d, life.food.add({ day: i.day, name: i.name, kcal: i.kcal }, actor), (id) => ({ kind: 'meal', id, day: i.day }), module);
    }
    case 'food_edit': {
      const i = WRITE_INPUTS.food_edit.parse(raw);
      return edit(d, { kind: 'meal', id: i.id, day: i.day }, split(i, 'id', 'day'), actor, module);
    }
    case 'weight_set': {
      const i = WRITE_INPUTS.weight_set.parse(raw);
      // That day's own weight (FoodDay lists only the newest 30).
      const had = life.food.weightOn(i.day);
      if (!had.ok) return had;
      const prev = had.value;
      if (prev !== null && Math.round(prev * 10) === Math.round(i.kg * 10)) return refuse('conflict', ACTION_SENTENCES.nothing);
      const r = life.food.setWeight(i.day, { kg: i.kg }, actor);
      if (!r.ok) return r;
      const now = life.food.weightOn(i.day);
      const kg = now.ok && now.value !== null ? now.value : i.kg;
      return { ok: true, value: { change: { module, op: 'set', ref: i.day, label: `Weight · ${kg} kg · ${i.day}`, undoable: true }, journal: { steps: [{ do: 'weight', day: i.day, kg: prev, after: kg }] } } };
    }
    case 'food_targets_set': {
      const i = WRITE_INPUTS.food_targets_set.parse(raw);
      const fd = life.food.day();
      if (!fd.ok) return fd;
      const prev: FoodTargetsBody = {
        ...(i.kcalTarget !== undefined ? { kcalTarget: fd.value.target } : {}),
        ...(i.goalKg !== undefined ? { goalKg: fd.value.weight.goalKg } : {}),
      };
      const kg10 = (kg: number | null | undefined) => (kg == null ? null : Math.round(kg * 10));
      const same = (i.kcalTarget === undefined || i.kcalTarget === fd.value.target) && (i.goalKg === undefined || kg10(i.goalKg) === kg10(fd.value.weight.goalKg));
      if (same) return refuse('conflict', ACTION_SENTENCES.nothing);
      const r = life.food.setTargets(i, actor);
      if (!r.ok) return r;
      const label = cut(['Targets', i.kcalTarget !== undefined ? `${i.kcalTarget} kcal a day` : '', i.goalKg != null ? `goal ${i.goalKg} kg` : ''].filter(Boolean).join(' · '), 160);
      const now = targetsNow(d, i);
      return { ok: true, value: { change: { module, op: 'set', ref: 'targets', label, undoable: true }, journal: { steps: [{ do: 'targets', body: prev, after: now ?? i }] } } };
    }
    case 'place_add':
      return added(d, life.places.create(WRITE_INPUTS.place_add.parse(raw), actor), (id) => ({ kind: 'place', id }), module);
    case 'place_edit': {
      const i = WRITE_INPUTS.place_edit.parse(raw);
      return edit(d, { kind: 'place', id: i.id }, split(i, 'id'), actor, module);
    }
    case 'dish_set': {
      const i = WRITE_INPUTS.dish_set.parse(raw);
      const place = findPlace(d, i.placeId);
      if (!place) return refuse('not_found', ACTION_SENTENCES.gone);
      const dishes: Dish[] = place.dishes.map((x) => ({ ...x }));
      const at = dishes.findIndex((x) => x.name.toLowerCase() === i.name.toLowerCase());
      const base: Dish = at >= 0 ? (dishes[at] as Dish) : { name: i.name };
      const next: Dish = { ...base };
      for (const k of ['rating', 'price', 'again', 'notes'] as const) {
        const v = i[k];
        if (v === null) delete next[k];
        else if (v !== undefined) (next as Record<string, unknown>)[k] = v;
      }
      if (at >= 0) dishes[at] = next;
      else dishes.push(next);
      const r = edit(d, { kind: 'place', id: i.placeId }, { dishes }, actor, module, 'set');
      if (!r.ok) return r;
      r.value.change.label = cut(`Dish · ${line(next.name)} · ${line(place.name)}${next.rating ? ` · ${next.rating}★` : ''}`, 160);
      return r;
    }
    case 'visit_log': {
      const i = WRITE_INPUTS.visit_log.parse(raw);
      const place = findPlace(d, i.placeId);
      if (!place) return refuse('not_found', ACTION_SENTENCES.gone);
      const steps: Step[] = [];
      // Dishes first, so a refused rating leaves no visit behind.
      const dishes: Dish[] = place.dishes.map((x) => ({ ...x }));
      for (const dr of i.dishRatings ?? []) {
        const at = dishes.findIndex((x) => x.name.toLowerCase() === dr.name.toLowerCase());
        if (at >= 0) dishes[at] = { ...(dishes[at] as Dish), rating: dr.rating };
        else dishes.push({ name: dr.name, rating: dr.rating });
      }
      // Ratings the dishes already have change nothing: the visit is still logged.
      if (stable(dishes) !== stable(place.dishes)) {
        const r = edit(d, { kind: 'place', id: i.placeId }, { dishes }, actor, module);
        if (!r.ok) return r;
        steps.push(...(r.value.journal?.steps ?? []));
      }
      const body = split(i, 'placeId', 'dishRatings');
      const v = life.places.visitAdd(i.placeId, body, actor);
      if (!v.ok) {
        // Put the dishes back: nothing half-done stays.
        for (const s of steps) if (s.do === 'patch') patchItem(d, s.item, s.before, actor);
        return v;
      }
      const visit: ItemRef = { kind: 'visit', id: v.value.id, parent: i.placeId };
      steps.unshift({ do: 'remove', item: visit });
      // The first visit marks the café tried (the module's rule): Undo marks it untried again, after the visit
      // goes (steps run last first), unless it has other visits by then.
      if (!place.tried) steps.unshift({ do: 'untried', placeId: i.placeId });
      return { ok: true, value: { change: { module, op: 'log', ref: v.value.id, label: labelOf(d, visit), undoable: true }, journal: { steps } } };
    }
    case 'visit_edit': {
      const i = WRITE_INPUTS.visit_edit.parse(raw);
      return edit(d, { kind: 'visit', id: i.visitId, parent: i.placeId }, split(i, 'placeId', 'visitId'), actor, module);
    }
    case 'money_add': {
      const body = WRITE_INPUTS.money_add.parse(raw);
      return added(d, life.finance.add(body, actor), (id) => ({ kind: 'money', id, day: body.day }), module);
    }
    case 'money_edit': {
      const i = WRITE_INPUTS.money_edit.parse(raw);
      return edit(d, { kind: 'money', id: i.id, ...(i.day ? { day: i.day } : {}) }, split(i, 'id'), actor, module);
    }
    case 'budget_set': {
      const i = WRITE_INPUTS.budget_set.parse(raw);
      const prev = budgetOf(d, i.category);
      if (prev === i.amount) return refuse('conflict', ACTION_SENTENCES.nothing);
      const body = BudgetBodySchema.parse(i);
      const r = life.finance.setBudget(body, actor);
      if (!r.ok) return r;
      // The ref is not the category: a category is the user's own words, and audit rows carry ids only.
      const step: Step = { do: 'budget', category: i.category, amount: prev, after: i.amount };
      return { ok: true, value: { change: { module, op: 'set', ref: 'budget', label: cut(`Budget · ${line(i.category)} · ${i.amount / 100}`, 160), undoable: true }, journal: { steps: [step] } } };
    }
    case 'bill_add':
      return added(d, life.finance.createBill(WRITE_INPUTS.bill_add.parse(raw), actor), (id) => ({ kind: 'bill', id }), module);
    case 'bill_edit': {
      const i = WRITE_INPUTS.bill_edit.parse(raw);
      return edit(d, { kind: 'bill', id: i.id }, split(i, 'id'), actor, module);
    }
    case 'bill_paid': {
      const i = WRITE_INPUTS.bill_paid.parse(raw);
      const ref: ItemRef = { kind: 'bill', id: i.id };
      const before = current(d, ref);
      if (!before) return refuse('not_found', ACTION_SENTENCES.gone);
      const r = life.finance.paid(i.id, split(i, 'id'), actor);
      if (!r.ok) return r;
      const after = current(d, ref) ?? {};
      const steps: Step[] = [
        { do: 'remove', item: { kind: 'money', id: r.value.id, ...(i.day ? { day: i.day } : {}) } },
        { do: 'patch', item: ref, before: { nextDue: norm(before.nextDue) }, after: { nextDue: norm(after.nextDue) } },
      ];
      return { ok: true, value: { change: { module, op: 'paid', ref: i.id, label: labelOf(d, ref), undoable: true }, journal: { steps } } };
    }
    case 'post_add':
      return added(d, life.posts.create(WRITE_INPUTS.post_add.parse(raw), actor), (id) => ({ kind: 'post', id }), module);
    case 'post_edit': {
      const i = WRITE_INPUTS.post_edit.parse(raw);
      return edit(d, { kind: 'post', id: i.id }, split(i, 'id'), actor, module);
    }
    case 'post_goals_set': {
      const body = WRITE_INPUTS.post_goals_set.parse(raw);
      const prev = goalsNow(d) ?? [];
      const r = life.posts.setGoals(body, actor);
      if (!r.ok) return r;
      const step: Step = { do: 'goals', goals: prev, after: goalsNow(d) ?? body.goals };
      return { ok: true, value: { change: { module, op: 'set', ref: 'goals', label: `Post goals · ${body.goals.length}`, undoable: true }, journal: { steps: [step] } } };
    }
    case 'meeting_edit': {
      const i = WRITE_INPUTS.meeting_edit.parse(raw);
      return edit(d, { kind: 'meeting', id: i.id }, split(i, 'id'), actor, module);
    }
    case 'meeting_item_todo': {
      const i = WRITE_INPUTS.meeting_item_todo.parse(raw);
      const m = d.meetings.library.get(i.id);
      if (!m.ok) return m;
      const item = m.value.summary.items[i.n];
      if (!item) return refuse('not_found', ACTION_SENTENCES.noItem);
      const r = d.meetings.summaries.addTodo(i.id, i.n, actor);
      if (!r.ok) return r;
      const label = cut(`Todo from ${line(m.value.meeting.name)} · ${line(item.title)}`, 160);
      return { ok: true, value: { change: { module, op: 'todo', ref: i.id, label, undoable: true }, journal: { steps: [{ do: 'meetingTodo', id: i.id, n: i.n }] } } };
    }
    case 'intel_save': {
      const i = WRITE_INPUTS.intel_save.parse(raw);
      const r = await d.intel.read({ text: i.url, ...(i.depth ? { depth: i.depth } : {}) }, { via: 'chat' });
      if (!r.ok) return r;
      const ref: ItemRef = { kind: 'intel', id: r.value.id };
      // A link already on the shelf: nothing was written, so nothing to undo.
      const undoable = !r.value.duplicate;
      return { ok: true, value: { change: { module, op: 'save', ref: r.value.id, label: labelOf(d, ref, 'Intel · a saved link'), undoable }, journal: undoable ? { steps: [{ do: 'remove', item: ref }] } : null } };
    }
  }
}

/** Whether step `s` may run: Chat's value still holds (else 409), its item is there (else 404); null when it may. */
function stillChats(d: ChatDeps, s: Step): Refusal | null {
  const changed = refuse('conflict', ACTION_SENTENCES.changed);
  switch (s.do) {
    case 'patch': {
      const cur = current(d, s.item);
      if (!cur) return refuse('not_found', ACTION_SENTENCES.gone);
      return unchangedSince(cur, s.after) ? null : changed;
    }
    case 'remove': {
      // An add's Undo never takes what the user added since with it: a café's visits.
      if (s.item.kind !== 'place') return null;
      const p = findPlace(d, s.item.id);
      return p && p.visits.count > 0 ? refuse('conflict', ACTION_SENTENCES.hasVisits) : null;
    }
    case 'todoDone': {
      const t = findTodo(d, s.id);
      if (!t) return refuse('not_found', ACTION_SENTENCES.gone);
      return Boolean(t.doneAt) === !s.done ? null : changed;
    }
    case 'weight': {
      const w = d.life.food.weightOn(s.day);
      if (!w.ok) return w;
      // Chat's weight already gone and none there before: nothing to put back.
      if (w.value === null && s.kg === null) return null;
      return w.value === s.after ? null : changed;
    }
    case 'targets': {
      const now = targetsNow(d, s.after);
      return now && stable(now) === stable(s.after) ? null : changed;
    }
    case 'budget':
      return budgetOf(d, s.category) === s.after ? null : changed;
    case 'goals': {
      const now = goalsNow(d);
      return now && stable(now) === stable(s.after) ? null : changed;
    }
    case 'dose': {
      const now = doseNow(d, s.medId, s.day, s.slot);
      return now?.doseId === s.doseId && now.status === s.status ? null : changed;
    }
    case 'untried':
    case 'meetingTodo':
      return null;
  }
}

/** Undo a journal as `actor`: every step checked first (409 when changed since), then the steps last first. */
export async function undoJournal(d: ChatDeps, journal: Journal, actor: Actor): Promise<LifeResult> {
  for (const s of journal.steps) {
    const no = stillChats(d, s);
    if (no) return no;
  }
  for (const s of [...journal.steps].reverse()) {
    const r = await undoStep(d, s, actor);
    // An item already gone counts as removed.
    if (!r.ok && !(s.do === 'remove' && r.code === 'not_found')) return r;
  }
  return { ok: true, value: true };
}

async function undoStep(d: ChatDeps, s: Step, actor: Actor): Promise<LifeResult> {
  const life = d.life;
  switch (s.do) {
    case 'remove':
      return removeItem(d, s.item, actor);
    case 'patch':
      return patchItem(d, s.item, s.before, actor);
    case 'todoDone':
      return life.todos.setDone(s.id, s.done, actor);
    case 'weight': {
      if (s.kg !== null) return life.food.setWeight(s.day, { kg: s.kg }, actor);
      const r = life.food.removeWeight(s.day, actor);
      return !r.ok && r.code === 'not_found' ? { ok: true, value: true } : r;
    }
    case 'targets':
      return Object.keys(s.body).length ? life.food.setTargets(s.body, actor) : { ok: true, value: true };
    case 'budget':
      return life.finance.setBudget({ category: s.category, amount: s.amount }, actor);
    case 'goals':
      return life.posts.setGoals({ goals: s.goals }, actor);
    case 'dose':
      return s.prev ? life.medicines.logDose(s.medId, s.prev, actor).ok ? { ok: true, value: true } : refuse('conflict', ACTION_SENTENCES.changed) : life.medicines.undoDose(s.medId, s.doseId, actor);
    case 'untried': {
      const p = findPlace(d, s.placeId);
      if (!p || !p.tried || p.visits.count > 0) return { ok: true, value: true };
      return life.places.update(s.placeId, { tried: false }, actor);
    }
    case 'meetingTodo':
      return d.meetings.summaries.removeTodo(s.id, s.n, actor);
  }
}

// ------------------------------------------------------------------ cards: deletes and actions

export const DELETE_KINDS = ['todo', 'project', 'medicine', 'dose', 'meal', 'saved_food', 'weight', 'place', 'visit', 'dish', 'money', 'budget', 'bill', 'post', 'meeting', 'meeting_todo', 'intel'] as const;
export type DeleteKind = (typeof DELETE_KINDS)[number];
export const ACTION_KINDS = ['stop_medicine', 'summarize_meeting', 'reread_link'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const DELETE_MODULE: Readonly<Record<DeleteKind, ChatModule>> = {
  todo: 'todos',
  project: 'todos',
  medicine: 'medicines',
  dose: 'medicines',
  meal: 'food',
  saved_food: 'food',
  weight: 'food',
  place: 'places',
  visit: 'places',
  dish: 'places',
  money: 'finance',
  budget: 'finance',
  bill: 'finance',
  post: 'posts',
  meeting: 'meetings',
  meeting_todo: 'meetings',
  intel: 'intel',
};
export const ACTION_MODULE: Readonly<Record<ActionKind, ChatModule>> = { stop_medicine: 'medicines', summarize_meeting: 'meetings', reread_link: 'intel' };

/** What a card's tap runs (kept in chat.db with the card; read back with this schema). */
export const CardActionSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('delete'), kind: z.enum(DELETE_KINDS), id: z.string().min(1).max(200), parent: z.string().max(200).optional(), day: DayKeySchema.optional() }),
  z.strictObject({ t: z.literal('action'), kind: z.enum(ACTION_KINDS), id: z.string().min(1).max(200), depth: IntelDepthSchema.optional() }),
  z.strictObject({ t: z.literal('write'), tool: z.enum(WRITE_TOOLS as [WriteTool, ...WriteTool[]]), input: z.unknown() }),
]);
export type CardAction = z.infer<typeof CardActionSchema>;

export interface Described {
  module: ChatModule;
  op: string;
  ref: string | null;
  label: string;
}

const q = (s: string, n = 80) => cut(line(s), n);

/** A delete card's label from the item as it is now; not_found when it is not there. */
export function describeDelete(d: ChatDeps, a: Extract<CardAction, { t: 'delete' }>): LifeResult<Described> {
  const gone = refuse('not_found', ACTION_SENTENCES.gone);
  const module = DELETE_MODULE[a.kind];
  const out = (label: string, ref: string | null = a.id): LifeResult<Described> => ({ ok: true, value: { module, op: 'delete', ref, label: cut(label, 200) } });
  const life = d.life;
  switch (a.kind) {
    case 'todo': {
      const t = findTodo(d, a.id);
      return t ? out(`Delete todo ${q(t.title)}?`) : gone;
    }
    case 'project': {
      const p = current(d, { kind: 'project', id: a.id }) as { name?: string; open?: number } | null;
      return p ? out(`Delete project ${q(p.name ?? '')}? Its ${p.open ?? 0} open todos keep going, with no project.`) : gone;
    }
    case 'medicine': {
      const m = findMedicine(d, a.id);
      return m ? out(`Delete medicine ${q(m.name)} and its dose history?`) : gone;
    }
    case 'dose': {
      if (!a.parent) return gone;
      const m = findMedicine(d, a.parent);
      return m ? out(`Remove the logged dose of ${q(m.name)}?`) : gone;
    }
    case 'meal': {
      const f = current(d, { kind: 'meal', id: a.id, ...(a.day ? { day: a.day } : {}) }) as { name?: string; kcal?: number } | null;
      return f ? out(`Delete ${q(f.name ?? '')} (${f.kcal ?? 0} kcal)?`) : gone;
    }
    case 'saved_food': {
      const fd = life.food.day();
      const s = fd.ok ? fd.value.saved.find((x) => x.id === a.id) : undefined;
      return s ? out(`Delete the saved food ${q(s.name)}?`) : gone;
    }
    case 'weight': {
      const w = life.food.weightOn(a.id);
      return w.ok && w.value !== null ? out(`Delete the weight of ${a.id} (${w.value} kg)?`) : refuse('not_found', ACTION_SENTENCES.noWeight);
    }
    case 'place': {
      const p = findPlace(d, a.id);
      if (!p) return gone;
      const n = p.visits.count;
      return out(n > 0 ? `Delete café ${q(p.name)} and its ${n} visit${n === 1 ? '' : 's'}?` : `Delete café ${q(p.name)}?`);
    }
    case 'visit': {
      if (!a.parent) return gone;
      const p = findPlace(d, a.parent);
      const v = current(d, { kind: 'visit', id: a.id, parent: a.parent }) as { day?: string } | null;
      return p && v ? out(`Delete the visit to ${q(p.name)} on ${v.day ?? ''}?`) : gone;
    }
    case 'dish': {
      if (!a.parent) return gone;
      const p = findPlace(d, a.parent);
      const dish = p?.dishes.find((x) => x.name.toLowerCase() === a.id.toLowerCase());
      return p && dish ? out(`Remove ${q(dish.name)} from ${q(p.name)}?`, a.parent) : refuse('not_found', ACTION_SENTENCES.noDish);
    }
    case 'money': {
      const m = current(d, { kind: 'money', id: a.id, ...(a.day ? { day: a.day } : {}) }) as { kind?: string; amount?: number; category?: string } | null;
      return m ? out(`Delete the ${m.kind ?? 'entry'} of ${(m.amount ?? 0) / 100} (${q(m.category ?? '', 24)})?`) : gone;
    }
    case 'budget': {
      const m = life.finance.month();
      const b = m.ok ? m.value.byCategory.find((c) => c.category.toLowerCase() === a.id.toLowerCase() && c.budget !== null) : undefined;
      return b ? out(`Remove the budget for ${q(b.category, 24)}?`) : refuse('not_found', ACTION_SENTENCES.noBudget);
    }
    case 'bill': {
      const b = current(d, { kind: 'bill', id: a.id }) as { name?: string } | null;
      return b ? out(`Delete bill ${q(b.name ?? '')}? Its reminders stop.`) : gone;
    }
    case 'post': {
      const p = current(d, { kind: 'post', id: a.id }) as { title?: string; kind?: string } | null;
      return p ? out(`Delete the ${p.kind ?? 'post'}${p.title ? ` ${q(p.title)}` : ''}?`) : gone;
    }
    case 'meeting': {
      const m = findMeeting(d, a.id);
      return m ? out(`Delete meeting ${q(m.name)} with its notes and screenshots?`) : gone;
    }
    case 'meeting_todo': {
      const m = d.meetings.library.get(a.id);
      const n = Number(a.parent);
      const item = m.ok && Number.isInteger(n) ? m.value.summary.items[n] : undefined;
      return m.ok && item?.todoId ? out(`Remove the todo made from ${q(item.title)}?`) : refuse('not_found', ACTION_SENTENCES.noItem);
    }
    case 'intel': {
      const i = d.intel.get(a.id);
      return i ? out(`Delete ${q(i.title)} from the Intel shelf?`) : gone;
    }
  }
}

/** An action card's label (an irreversible or quota-spending action). */
export function describeAction(d: ChatDeps, a: Extract<CardAction, { t: 'action' }>): LifeResult<Described> {
  const module = ACTION_MODULE[a.kind];
  const gone = refuse('not_found', ACTION_SENTENCES.gone);
  switch (a.kind) {
    case 'stop_medicine': {
      const m = findMedicine(d, a.id);
      if (!m) return gone;
      if (m.stoppedOn) return refuse('conflict', ACTION_SENTENCES.stopped);
      return { ok: true, value: { module, op: 'stop', ref: a.id, label: cut(`Stop taking ${q(m.name)} from today?`, 200) } };
    }
    case 'summarize_meeting': {
      const m = findMeeting(d, a.id);
      return m ? { ok: true, value: { module, op: 'summarize', ref: a.id, label: cut(`Summarize ${q(m.name)}? It runs Claude on your account.`, 200) } } : gone;
    }
    case 'reread_link': {
      const i = d.intel.get(a.id);
      return i ? { ok: true, value: { module, op: 'reread', ref: a.id, label: cut(`Read ${q(i.title)} again? It runs Claude on your account.`, 200) } } : gone;
    }
  }
}

/** A Confirm card's tap: the same module call the phone's own button makes, as the tapping device. */
export async function runCardAction(d: ChatDeps, a: Exclude<CardAction, { t: 'write' }>, actor: Actor): Promise<LifeResult> {
  const life = d.life;
  if (a.t === 'action') {
    switch (a.kind) {
      case 'stop_medicine':
        return life.medicines.stopTaking(a.id, actor);
      case 'summarize_meeting':
        return d.meetings.summaries.request(a.id, actor);
      case 'reread_link': {
        const r = d.intel.reread(a.id, a.depth);
        return r.ok ? { ok: true, value: true } : r;
      }
    }
  }
  switch (a.kind) {
    case 'todo':
      return life.todos.removeTodo(a.id, actor);
    case 'project':
      return life.todos.removeProject(a.id, actor);
    case 'medicine':
      return life.medicines.remove(a.id, actor);
    case 'dose':
      return a.parent ? life.medicines.undoDose(a.parent, a.id, actor) : refuse('not_found', ACTION_SENTENCES.noDose);
    case 'meal':
      return life.food.remove(a.id, actor);
    case 'saved_food':
      return life.food.removeSaved(a.id, actor);
    case 'weight':
      return life.food.removeWeight(a.id, actor);
    case 'place':
      return life.places.remove(a.id, actor);
    case 'visit':
      return a.parent ? life.places.visitRemove(a.parent, a.id, actor) : refuse('not_found', ACTION_SENTENCES.gone);
    case 'dish': {
      if (!a.parent) return refuse('not_found', ACTION_SENTENCES.gone);
      const p = findPlace(d, a.parent);
      if (!p) return refuse('not_found', ACTION_SENTENCES.gone);
      const dishes = p.dishes.filter((x) => x.name.toLowerCase() !== a.id.toLowerCase());
      if (dishes.length === p.dishes.length) return refuse('not_found', ACTION_SENTENCES.noDish);
      return life.places.update(a.parent, { dishes }, actor);
    }
    case 'money':
      return life.finance.remove(a.id, actor);
    case 'budget':
      return life.finance.setBudget({ category: a.id, amount: null }, actor);
    case 'bill':
      return life.finance.removeBill(a.id, actor);
    case 'post':
      return life.posts.remove(a.id, actor);
    case 'meeting':
      return d.meetings.library.remove(a.id, actor);
    case 'meeting_todo': {
      const n = Number(a.parent);
      return Number.isInteger(n) ? d.meetings.summaries.removeTodo(a.id, n, actor) : refuse('not_found', ACTION_SENTENCES.noItem);
    }
    case 'intel':
      return d.intel.remove(a.id);
  }
}

/** The item a write changes, from its checked input; null for an add or a set. */
function writeTarget(tool: WriteTool, input: Record<string, unknown>): ItemRef | null {
  const id = typeof input.id === 'string' ? input.id : '';
  const day = typeof input.day === 'string' ? { day: input.day } : {};
  switch (tool) {
    case 'todo_edit':
    case 'todo_done':
    case 'todo_snooze':
      return { kind: 'todo', id };
    case 'project_edit':
      return { kind: 'project', id };
    case 'med_edit':
      return { kind: 'medicine', id };
    case 'dose_log':
      return { kind: 'medicine', id: String(input.medId ?? '') };
    case 'food_edit':
      return { kind: 'meal', id, ...day };
    case 'place_edit':
      return { kind: 'place', id };
    case 'dish_set':
    case 'visit_log':
      return { kind: 'place', id: String(input.placeId ?? '') };
    case 'visit_edit':
      return { kind: 'visit', id: String(input.visitId ?? ''), parent: String(input.placeId ?? '') };
    case 'money_edit':
      return { kind: 'money', id, ...day };
    case 'bill_edit':
    case 'bill_paid':
      return { kind: 'bill', id };
    case 'post_edit':
      return { kind: 'post', id };
    case 'meeting_edit':
    case 'meeting_item_todo':
      return { kind: 'meeting', id };
    default:
      return null;
  }
}

/** One value of a held write, short: "18:00", "cleared", "yes". */
function shortValue(v: unknown): string {
  if (v === null) return 'cleared';
  if (typeof v === 'string') return q(v, 40);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.map(shortValue).join(', ');
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).map(shortValue).join(' ');
  return '';
}

/** Keys of a write's input that name its item, not what changes. */
const WHERE_KEYS = new Set(['id', 'placeId', 'visitId', 'medId']);

/**
 * A Do-it card's label: what the write would do, from its checked input. An edit names its item by the
 * item's own label (as the change list would) and lists what it changes, so a tap after someone else's
 * text is never a blind one: "Change Medicine · Placebin · 08:00: times 23:00?".
 */
export function describeWrite(d: ChatDeps, tool: WriteTool, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? q(input[k] as string) : '');
  const target = writeTarget(tool, input);
  const name = target ? labelOf(d, target, 'an item that is not there now') : '';
  const changes = Object.entries(input)
    .filter(([k, v]) => !WHERE_KEYS.has(k) && !(k === 'day' && (tool === 'food_edit' || tool === 'money_edit')) && v !== undefined)
    .map(([k, v]) => `${k} ${shortValue(v)}`.trim())
    .join(', ');
  const named: Partial<Record<WriteTool, string>> = {
    todo_done: `Mark ${name} ${input.done === false ? 'not done' : 'done'}`,
    todo_snooze: `Snooze ${name}: ${s('preset')}`,
    bill_paid: `Mark ${name} paid`,
    dose_log: `Log ${name}: ${s('day')} ${s('slot')} ${s('status')}`,
    dish_set: `Set dish ${s('name')} at ${name}${changes ? `: ${changes}` : ''}`,
    visit_log: `Log a visit to ${name}${changes ? `: ${changes}` : ''}`,
    meeting_item_todo: `Add action item ${typeof input.n === 'number' ? input.n : ''} of ${name} to its todos`,
  };
  if (target && named[tool]) return cut(`${named[tool]}?`, 200);
  if (target) return cut(`Change ${name}: ${changes || 'nothing'}?`, 200);
  const what: Partial<Record<WriteTool, string>> = {
    todo_add: `Add todo ${s('title')}`,
    project_add: `Add project ${s('name')}`,
    med_add: `Add medicine ${s('name')}`,
    food_add: `Log ${s('name')}${typeof input.kcal === 'number' ? ` (${input.kcal} kcal)` : ''}`,
    place_add: `Add café ${s('name')}`,
    money_add: `Add ${s('kind') || 'an entry'}${typeof input.amount === 'number' ? ` of ${input.amount / 100}` : ''}`,
    bill_add: `Add bill ${s('name')}`,
    post_add: `Plan a ${s('kind') || 'post'}${s('title') ? ` ${s('title')}` : ''}`,
    intel_save: 'Save a link to Intel',
    weight_set: `Set the weight of ${s('day')} to ${typeof input.kg === 'number' ? input.kg : ''} kg`,
    food_targets_set: `Set the food targets: ${changes}`,
    budget_set: `Set the budget for ${s('category')} to ${typeof input.amount === 'number' ? input.amount / 100 : ''}`,
    post_goals_set: `Replace the posting goals: ${changes}`,
  };
  return cut(`${what[tool] ?? `${tool.replace(/_/g, ' ')}: ${changes}`}?`, 200);
}
