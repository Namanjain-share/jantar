/**
 * v0.12 People (P1): her to-dos, reminders, projects and weights, as either
 * side writes them (spec 3.3, 3.5, 8.2), over the Todos module in her space.
 *
 * The rules, row by row (spec 3.3):
 * - Hers (`by = <pid>`): she does anything. He edits or deletes only with
 *   `editHers.todos`; each edit sets "Edited by" (editedBy, editedAt) and
 *   writes Activity with the old and new value of each changed field (O4).
 * - His (`by = ''`, "From {owner}"): she can do, undo, snooze (unless he
 *   marked it no snooze), skip with a reason, ack ("Got it") and ask to
 *   change; editing or deleting it is 409 `assigned`. He edits or deletes it
 *   with `assign.todos`.
 * - He never marks done, skips, acks or snoozes for her (no such call here),
 *   and never creates a weight for her: he corrects or deletes one she
 *   logged, with `editHers.weight` (D22).
 * - While she is paused, his writes into her space are 409 `paused`.
 * - Every refusal of a row or an area he may not see is the one not_found.
 * - Each of his writes reaches her: an Activity row, a push, a tick of her
 *   stream. Her writes tick her stream and his only for areas he sees.
 */
import type { SnoozePreset, TodoPatch, TodosQuery, WeightBody } from '@jantar/protocol';
import type { Agreement, AssignTodoBody, AssignTodoPatch, PersonTodo, PersonWeight } from '@jantar/protocol/people';
import type { Actor, LifeCore, LifeResult, TodosModule } from '../../contracts.js';
import { removeWeight, setWeight, weightsOf } from '../food/weight.js';
import type { PeopleModule } from './module.js';

export const SPACE_REASONS = {
  noTodo: 'No such todo.',
  noWeight: 'No weight is logged for that day.',
  assigned: (owner: string) => `${owner} added this. Ask to change it instead.`,
  paused: (name: string) => `${name} has paused. New items wait until sharing resumes.`,
  noSnooze: (owner: string) => `${owner} marked this "no snooze".`,
  notAssigned: 'Only items added for you take "Got it" or "Ask to change".',
} as const;

type Refusal = Extract<LifeResult, { ok: false }>;
const refuse = (code: Refusal['code'], reason: string): Refusal => ({ ok: false, code, reason });
const OK: LifeResult = { ok: true, value: true };
const TITLE_MAX = 120;

/** The fields of a todo his edit changed, old and new, for her Activity (no notes text: a title snapshot and dates only). */
function changesOf(before: PersonTodo, after: PersonTodo): { field: string; from?: string; to?: string }[] {
  const out: { field: string; from?: string; to?: string }[] = [];
  const show = (v: unknown): string | undefined => (v === undefined ? undefined : typeof v === 'string' ? v.slice(0, 200) : JSON.stringify(v).slice(0, 200));
  for (const field of ['title', 'due', 'priority', 'repeat', 'projectId', 'ask', 'snoozable'] as const) {
    const a = before[field];
    const b = after[field];
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ field, ...(show(a) !== undefined ? { from: show(a) } : {}), ...(show(b) !== undefined ? { to: show(b) } : {}) });
  }
  if (before.notes !== after.notes) out.push({ field: 'notes' });
  return out;
}

export class PersonSpace {
  constructor(
    private readonly people: PeopleModule,
    private readonly todosModule: () => TodosModule,
    private readonly core: () => LifeCore | null,
  ) {}

  private todos(pid: string): TodosModule {
    return this.todosModule().inSpace(pid);
  }

  private stamp(): string {
    const c = this.core();
    return (c ? c.now() : new Date()).toISOString();
  }

  /** His write lands: her Activity, her stream, his devices' re-fetch, one push to her. */
  private hisWrite(pid: string, action: string, title: string | undefined, changes?: { field: string; from?: string; to?: string }[]): void {
    this.people.record(pid, { actor: 'owner', action, area: 'todos', ...(title ? { title: title.slice(0, TITLE_MAX) } : {}), ...(changes ? { changes: changes.slice(0, 12) } : {}) });
    this.people.ticks.bump(pid, 'life');
    this.people.ownerChanged();
    const owner = this.people.ownerName();
    const words = action === 'todo.added' ? `${owner} added "${(title ?? '').slice(0, 60)}"` : action === 'todo.deleted' ? `${owner} removed an item` : `${owner} changed "${(title ?? '').slice(0, 60)}"`;
    this.people.pushHer(pid, { kind: 'life', title: 'From ' + owner, body: words, url: '/p/todos', tag: `people:todos:${pid}` });
  }

  /** Her write lands: her stream; his devices only while he sees the area. */
  private herWrite(pid: string, area: 'todos' | 'weight'): void {
    this.people.ticks.bump(pid, 'life');
    const a = this.people.agreement(pid);
    if (a && (area === 'todos' ? a.see.todos : a.see.weight)) this.people.ownerChanged();
  }

  // --- her side ----------------------------------------------------------------------

  herList(pid: string, q: TodosQuery): LifeResult<{ today: string; todos: PersonTodo[] }> {
    return this.todos(pid).listTodos(q) as LifeResult<{ today: string; todos: PersonTodo[] }>;
  }

  herCreate(pid: string, body: Parameters<TodosModule['createTodo']>[0], actor: Actor): LifeResult<{ id: string }> {
    const r = this.todos(pid).createTodo(body, actor, { by: pid });
    if (r.ok) this.herWrite(pid, 'todos');
    return r;
  }

  /** One todo of hers, open or done (null: none in her space). */
  findTodo(pid: string, id: string): PersonTodo | null {
    for (const done of [false, true]) {
      const r = this.todos(pid).listTodos({ done });
      if (r.ok) {
        const t = (r.value.todos as PersonTodo[]).find((x) => x.id === id);
        if (t) return t;
      }
    }
    return null;
  }

  herUpdate(pid: string, id: string, patch: TodoPatch, actor: Actor): LifeResult {
    const t = this.findTodo(pid, id);
    if (!t) return refuse('not_found', SPACE_REASONS.noTodo);
    if (t.by === '') return refuse('conflict', SPACE_REASONS.assigned(this.people.ownerName()));
    const r = this.todos(pid).updateTodo(id, patch, actor);
    if (r.ok) this.herWrite(pid, 'todos');
    return r;
  }

  herDelete(pid: string, id: string, actor: Actor): LifeResult {
    const t = this.findTodo(pid, id);
    if (!t) return refuse('not_found', SPACE_REASONS.noTodo);
    if (t.by === '') return refuse('conflict', SPACE_REASONS.assigned(this.people.ownerName()));
    const r = this.todos(pid).removeTodo(id, actor);
    if (r.ok) this.herWrite(pid, 'todos');
    return r;
  }

  herDone(pid: string, id: string, done: boolean, report: string | undefined, actor: Actor): LifeResult {
    const t = this.findTodo(pid, id);
    if (!t) return refuse('not_found', SPACE_REASONS.noTodo);
    const r = this.todos(pid).setDone(id, done, actor);
    if (!r.ok) return r;
    if (report !== undefined && done) this.patchExtra(pid, id, { report });
    this.herWrite(pid, 'todos');
    return OK;
  }

  herSnooze(pid: string, id: string, preset: SnoozePreset, actor: Actor): LifeResult {
    const t = this.findTodo(pid, id);
    if (!t) return refuse('not_found', SPACE_REASONS.noTodo);
    if (t.snoozable === false) return refuse('conflict', SPACE_REASONS.noSnooze(this.people.ownerName()));
    const r = this.todos(pid).snooze(id, preset, actor);
    if (r.ok) this.herWrite(pid, 'todos');
    return r;
  }

  /** Skip with a reason (never scored): it leaves the open list as done does; a repeating one moves on and keeps lastSkip. */
  herSkip(pid: string, id: string, reason: string | undefined, actor: Actor): LifeResult {
    const t = this.findTodo(pid, id);
    if (!t) return refuse('not_found', SPACE_REASONS.noTodo);
    const skip = { at: this.stamp(), ...(reason ? { reason } : {}) };
    const r = this.todos(pid).setDone(id, true, actor);
    if (!r.ok) return r;
    this.patchExtra(pid, id, t.repeat ? { lastSkip: skip } : { skipped: skip });
    this.herWrite(pid, 'todos');
    return OK;
  }

  herAck(pid: string, id: string): LifeResult {
    const t = this.findTodo(pid, id);
    if (!t) return refuse('not_found', SPACE_REASONS.noTodo);
    if (t.by !== '') return refuse('conflict', SPACE_REASONS.notAssigned);
    this.patchExtra(pid, id, { ackAt: this.stamp() });
    this.herWrite(pid, 'todos');
    return OK;
  }

  herAsk(pid: string, id: string, note: string): LifeResult {
    const t = this.findTodo(pid, id);
    if (!t) return refuse('not_found', SPACE_REASONS.noTodo);
    if (t.by !== '') return refuse('conflict', SPACE_REASONS.notAssigned);
    this.patchExtra(pid, id, { askedChange: { at: this.stamp(), note } });
    this.herWrite(pid, 'todos');
    // He hears that she asked, never what (her note shows on the item when he looks).
    this.people.pushOwner(pid, { kind: 'life', title: `${this.people.nameOf(pid)} asks to change an item`, body: 'Open People to see.', url: `/people/${pid}?tab=todos&id=${id}`, tag: `people:ask:${pid}` });
    return OK;
  }

  /** Set People's daemon fields on a stored todo (no edit of hers or his: done, skip, ack, report, ask). */
  private patchExtra(pid: string, id: string, extra: Partial<PersonTodo>): void {
    const c = this.core();
    if (!c) return;
    const r = c.db.prepare('SELECT json FROM todos WHERE space = ? AND id = ?').get(pid, id) as { json: string } | undefined;
    if (!r) return;
    const next = { ...(JSON.parse(r.json) as object), ...extra, updatedAt: this.stamp() };
    c.db.prepare('UPDATE todos SET json = ?, updated_at = ? WHERE space = ? AND id = ?').run(JSON.stringify(next), next.updatedAt, pid, id);
  }

  // --- his side (ownerOf: the agreement decides; paused holds his writes) ---------------

  private hisGate(pid: string, a: Agreement | null, need: (a: Agreement) => boolean): LifeResult | null {
    if (!a || !need(a)) return refuse('not_found', 'No such person.');
    if (this.people.gateState(pid) === 'paused') return refuse('conflict', SPACE_REASONS.paused(this.people.nameOf(pid)));
    return null;
  }

  /**
   * His edit or delete of one todo in her space: `see.todos` or nothing
   * exists; his own rows need `assign.todos`, hers `editHers.todos` (a row
   * he may not touch answers as one that doesn't exist); paused holds it.
   */
  private hisRow(pid: string, id: string): { t: PersonTodo; mine: boolean } | Refusal {
    const a = this.people.agreement(pid);
    if (!a?.see.todos) return refuse('not_found', 'No such person.');
    const t = this.findTodo(pid, id);
    if (!t) return refuse('not_found', SPACE_REASONS.noTodo);
    const mine = t.by === '';
    if (!(mine ? a.assign.todos : a.editHers.todos)) return refuse('not_found', SPACE_REASONS.noTodo);
    if (this.people.gateState(pid) === 'paused') return refuse('conflict', SPACE_REASONS.paused(this.people.nameOf(pid)));
    return { t, mine };
  }

  assign(pid: string, body: AssignTodoBody, actor: Actor): LifeResult<{ id: string }> {
    const a = this.people.agreement(pid);
    const g = this.hisGate(pid, a, (x) => x.see.todos && x.assign.todos);
    if (g) return g as LifeResult<{ id: string }>;
    const { ask, snoozable, ...todo } = body;
    const r = this.todos(pid).createTodo(todo, actor, { by: '', extra: { ...(ask && ask !== 'none' ? { ask } : {}), ...(snoozable === false ? { snoozable: false } : {}) } });
    if (r.ok) this.hisWrite(pid, 'todo.added', body.title);
    return r;
  }

  ownerUpdate(pid: string, id: string, patch: AssignTodoPatch, actor: Actor): LifeResult {
    const row = this.hisRow(pid, id);
    if ('ok' in row) return row;
    const { t, mine } = row;
    const { ask, snoozable, ...todoPatch } = patch;
    const r = this.todos(pid).updateTodo(id, todoPatch as TodoPatch, actor);
    if (!r.ok) return r;
    const extra: Partial<PersonTodo> = {};
    if (ask !== undefined) extra.ask = ask;
    if (snoozable !== undefined) extra.snoozable = snoozable;
    if (!mine) {
      extra.editedBy = '';
      extra.editedAt = this.stamp();
    }
    this.patchExtra(pid, id, extra);
    const after = this.findTodo(pid, id) ?? t;
    this.hisWrite(pid, 'todo.edited', after.title, mine ? undefined : changesOf(t, after));
    return OK;
  }

  ownerDelete(pid: string, id: string, actor: Actor): LifeResult {
    const row = this.hisRow(pid, id);
    if ('ok' in row) return row;
    const { t } = row;
    const r = this.todos(pid).removeTodo(id, actor);
    if (r.ok) this.hisWrite(pid, 'todo.deleted', t.title);
    return r;
  }

  // --- weights -----------------------------------------------------------------------

  weights(pid: string): { weights: PersonWeight[]; latest: PersonWeight | null } {
    const c = this.core();
    const weights = c ? weightsOf(c, pid) : [];
    return { weights, latest: weights[0] ?? null };
  }

  herWeightSet(pid: string, day: string, body: WeightBody): LifeResult {
    const c = this.core();
    if (!c) return refuse('unavailable', 'Life is not open right now. Try again in a moment.');
    const r = setWeight(c, day, body.kg, pid);
    if (r.ok) this.herWrite(pid, 'weight');
    return r;
  }

  herWeightDelete(pid: string, day: string): LifeResult {
    const c = this.core();
    if (!c) return refuse('unavailable', 'Life is not open right now. Try again in a moment.');
    const r = removeWeight(c, day, pid);
    if (r.ok) this.herWrite(pid, 'weight');
    return r;
  }

  /** His correction of a day she logged (editHers.weight); a day she hasn't logged is 404: he never creates one (D22). */
  ownerWeightCorrect(pid: string, day: string, body: WeightBody): LifeResult {
    const a = this.people.agreement(pid);
    const g = this.hisGate(pid, a, (x) => x.see.weight && x.editHers.weight);
    if (g) return g;
    const c = this.core();
    if (!c) return refuse('unavailable', 'Life is not open right now. Try again in a moment.');
    const before = weightsOf(c, pid).find((w) => w.day === day);
    if (!before) return refuse('not_found', SPACE_REASONS.noWeight);
    const r = setWeight(c, day, body.kg, pid);
    if (!r.ok) return r;
    const after = weightsOf(c, pid).find((w) => w.day === day);
    this.people.record(pid, { actor: 'owner', action: 'weight.corrected', area: 'weight', ref: day, changes: [{ field: 'kg', from: String(before.kg), to: String(after?.kg ?? body.kg) }] });
    this.people.ticks.bump(pid, 'life');
    this.people.ownerChanged();
    this.people.pushHer(pid, { kind: 'life', title: `From ${this.people.ownerName()}`, body: `${this.people.ownerName()} corrected your weight of ${day}`, url: '/p', tag: `people:weight:${pid}` });
    return OK;
  }

  ownerWeightDelete(pid: string, day: string): LifeResult {
    const a = this.people.agreement(pid);
    const g = this.hisGate(pid, a, (x) => x.see.weight && x.editHers.weight);
    if (g) return g;
    const c = this.core();
    if (!c) return refuse('unavailable', 'Life is not open right now. Try again in a moment.');
    const before = weightsOf(c, pid).find((w) => w.day === day);
    if (!before) return refuse('not_found', SPACE_REASONS.noWeight);
    const r = removeWeight(c, day, pid);
    if (!r.ok) return r;
    this.people.record(pid, { actor: 'owner', action: 'weight.deleted', area: 'weight', ref: day, changes: [{ field: 'kg', from: String(before.kg) }] });
    this.people.ticks.bump(pid, 'life');
    this.people.ownerChanged();
    return OK;
  }
}
