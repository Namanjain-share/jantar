/**
 * v0.11 People (P3, spec 7.2): her assistant's own writes, over her plan,
 * status, sleep and alerts, as her (the People modules' her-side calls:
 * nothing here can act in {owner}'s name or write his space).
 *
 * Each write answers what the daemon writes on the change row (never the
 * model's words), and the steps that put it back where an Undo makes sense:
 * a step she added goes, a step's state and a check-between's tick go back,
 * a night goes back to what it was. A check-in answer and a status have no
 * Undo (she sets them again), and an alert is always a Do-it card first: it
 * rings {owner}'s phone. A label that carries {owner}'s words (a step he
 * added) is marked so the turn frames it as data and becomes tainted.
 *
 * Nothing here logs or emits; refusals are the modules' fixed sentences.
 */
import { hhmmOf } from '@jantar/life-core';
import { ALERT_KINDS, STATUS_LABELS, type PlanView, type SleepNight } from '@jantar/protocol/people';
import type { LifeResult } from '../contracts.js';
import type { Applied } from './actions.js';
import type { PersonChat } from './person-deps.js';
import { ownerAuthored } from './person-reads.js';
import { PERSON_WRITE_INPUTS, PERSON_WRITE_MODULE, type PersonWriteTool } from './person-tools.js';
import { cut, line } from './text.js';

type Refusal = Extract<LifeResult, { ok: false }>;
const refuse = (code: Refusal['code'], reason: string): Refusal => ({ ok: false, code, reason });

export const PERSON_WRITE_SENTENCES = {
  closed: 'Life is not open right now. Try again in a moment.',
  noStep: 'No such step on that day.',
  noBetween: 'No such check-between on that day.',
  noList: 'No such shared list.',
  noItem: 'No such item on that list.',
  nothing: 'Nothing to change.',
  changed: "That changed after the assistant's edit; change it back by hand.",
  bad: "That can't be done as it is.",
} as const;

type StepState = 'todo' | 'doing' | 'done' | 'skipped';
const STEP_STATES: readonly string[] = ['todo', 'doing', 'done', 'skipped'];

/** One step that puts one of her writes back (actions.ts runs them through undoJournal). */
export type PersonStep =
  | { do: 'person'; op: 'stepRemove'; day: string; stepId: string }
  | { do: 'person'; op: 'stepState'; day: string; stepId: string; before: StepState; after: StepState }
  | { do: 'person'; op: 'tick'; day: string; id: string; slot: string; done: boolean }
  | { do: 'person'; op: 'night'; night: string; before: { bedAt: string; wakeAt?: string; quality?: number; notes?: string } | null; after: { bedAt: string; wakeAt: string | null } }
  /** P4: a shared list's item she added goes; one she ticked goes back. */
  | { do: 'person'; op: 'itemRemove'; listId: string; itemId: string }
  | { do: 'person'; op: 'itemTick'; listId: string; itemId: string; done: boolean };

const t = (s: string | undefined, n = 60) => cut(line(s ?? ''), n);

function planOf(pc: PersonChat, day: string): PlanView | null {
  return pc.people.plans?.herView(pc.pid, day) ?? null;
}

function stepOf(pc: PersonChat, day: string, stepId: string) {
  return planOf(pc, day)?.plan?.steps.find((s) => s.id === stepId) ?? null;
}

function betweenOf(pc: PersonChat, day: string, id: string) {
  return planOf(pc, day)?.plan?.between.find((b) => b.id === id) ?? null;
}

function nightOf(pc: PersonChat, night: string): SleepNight | null {
  const r = pc.people.sleep?.week(pc.pid, { from: night, to: night });
  return r?.ok ? (r.value.nights.find((n) => n.night === night) ?? null) : null;
}

function clock(pc: PersonChat, iso: string | undefined): string {
  const core = pc.people.openCore();
  return iso && core ? hhmmOf(new Date(iso), core.tz()) : '';
}

const STATE_OP = { done: 'done', skipped: 'skip', doing: 'start', todo: 'undone' } as const;

/** Apply one of her own writes. */
export function applyPersonWrite(pc: PersonChat, tool: PersonWriteTool, raw: unknown): LifeResult<Applied> {
  const plans = pc.people.plans;
  const module = PERSON_WRITE_MODULE[tool];
  switch (tool) {
    case 'step_state': {
      const p = PERSON_WRITE_INPUTS.step_state.safeParse(raw);
      if (!p.success || !plans) return p.success ? refuse('life_unavailable', PERSON_WRITE_SENTENCES.closed) : refuse('invalid_request', PERSON_WRITE_SENTENCES.bad);
      const i = p.data;
      const s = stepOf(pc, i.day, i.stepId);
      if (!s) return refuse('not_found', PERSON_WRITE_SENTENCES.noStep);
      if (s.status === i.to) return refuse('conflict', PERSON_WRITE_SENTENCES.nothing);
      const r = plans.setState(pc.pid, i.day, i.stepId, { to: i.to, ...(i.report ? { report: i.report } : {}), ...(i.reason ? { reason: i.reason } : {}) });
      if (!r.ok) return r;
      const before = s.status;
      const journal = STEP_STATES.includes(before) ? { steps: [{ do: 'person', op: 'stepState', day: i.day, stepId: i.stepId, before: before as StepState, after: i.to } as PersonStep] } : null;
      const label = cut(`Step · ${t(s.title)} · ${i.to === 'doing' ? 'started' : i.to === 'todo' ? 'to do' : i.to}`, 160);
      return { ok: true, value: { change: { module, op: STATE_OP[i.to], ref: i.stepId, label, undoable: journal !== null }, journal, ...(ownerAuthored(s) ? { third: 'owner' as const } : {}) } };
    }
    case 'step_add': {
      const p = PERSON_WRITE_INPUTS.step_add.safeParse(raw);
      if (!p.success || !plans) return p.success ? refuse('life_unavailable', PERSON_WRITE_SENTENCES.closed) : refuse('invalid_request', PERSON_WRITE_SENTENCES.bad);
      const { day, ...body } = p.data;
      const r = plans.addStep(pc.pid, day, body);
      if (!r.ok) return r;
      const label = cut(`Step · ${t(body.title)}${body.at ? ` · ${body.at}` : ''} · ${day}`, 160);
      return { ok: true, value: { change: { module, op: 'add', ref: r.value.id, label, undoable: true }, journal: { steps: [{ do: 'person', op: 'stepRemove', day, stepId: r.value.id } as PersonStep] } } };
    }
    case 'between_tick': {
      const p = PERSON_WRITE_INPUTS.between_tick.safeParse(raw);
      if (!p.success || !plans) return p.success ? refuse('life_unavailable', PERSON_WRITE_SENTENCES.closed) : refuse('invalid_request', PERSON_WRITE_SENTENCES.bad);
      const i = p.data;
      const b = betweenOf(pc, i.day, i.id);
      if (!b) return refuse('not_found', PERSON_WRITE_SENTENCES.noBetween);
      const tick = b.ticks.find((x) => x.slot === i.slot);
      if (tick && Boolean(tick.doneAt) === i.done) return refuse('conflict', PERSON_WRITE_SENTENCES.nothing);
      const r = plans.tick(pc.pid, i.day, i.id, i.slot, i.done);
      if (!r.ok) return r;
      const label = cut(`Check · ${t(b.title)} ${i.slot} · ${i.done ? 'ticked' : 'unticked'}`, 160);
      return { ok: true, value: { change: { module, op: 'tick', ref: i.id, label, undoable: true }, journal: { steps: [{ do: 'person', op: 'tick', day: i.day, id: i.id, slot: i.slot, done: i.done } as PersonStep] }, ...(b.by === '' ? { third: 'owner' as const } : {}) } };
    }
    case 'checkin_answer': {
      const p = PERSON_WRITE_INPUTS.checkin_answer.safeParse(raw);
      if (!p.success || !plans) return p.success ? refuse('life_unavailable', PERSON_WRITE_SENTENCES.closed) : refuse('invalid_request', PERSON_WRITE_SENTENCES.bad);
      const { day, stepId, ...body } = p.data;
      const r = plans.checkin(pc.pid, day, stepId, body);
      if (!r.ok) return r;
      return { ok: true, value: { change: { module, op: 'log', ref: stepId, label: `Check-in · ${day} · mood ${body.mood}, energy ${body.energy}`, undoable: false }, journal: null } };
    }
    case 'status_set': {
      const p = PERSON_WRITE_INPUTS.status_set.safeParse(raw);
      if (!p.success) return refuse('invalid_request', PERSON_WRITE_SENTENCES.bad);
      const r = pc.people.setStatus(pc.pid, p.data);
      if (!r.ok) return r;
      return { ok: true, value: { change: { module, op: 'set', ref: pc.pid, label: `Status · ${STATUS_LABELS[p.data.level]}`, undoable: false }, journal: null } };
    }
    case 'sleep_log': {
      const p = PERSON_WRITE_INPUTS.sleep_log.safeParse(raw);
      const sleep = pc.people.sleep;
      if (!p.success || !sleep) return p.success ? refuse('life_unavailable', PERSON_WRITE_SENTENCES.closed) : refuse('invalid_request', PERSON_WRITE_SENTENCES.bad);
      const i = p.data;
      const had = nightOf(pc, i.night);
      const r = sleep.put(pc.pid, i.night, { bedAt: i.bedAt, ...(i.wakeAt ? { wakeAt: i.wakeAt } : {}), ...(i.quality ? { quality: i.quality } : {}), ...(i.notes ? { notes: i.notes } : {}) });
      if (!r.ok) return r;
      const now = nightOf(pc, i.night);
      const before = had ? { bedAt: had.bedAt, ...(had.wakeAt ? { wakeAt: had.wakeAt } : {}), ...(had.quality ? { quality: had.quality } : {}), ...(had.notes ? { notes: had.notes } : {}) } : null;
      const step: PersonStep = { do: 'person', op: 'night', night: i.night, before, after: { bedAt: now?.bedAt ?? i.bedAt, wakeAt: now?.wakeAt ?? null } };
      const label = cut(`Sleep · night of ${i.night} · bed ${clock(pc, i.bedAt)}${i.wakeAt ? `, up ${clock(pc, i.wakeAt)}` : ''}`, 160);
      return { ok: true, value: { change: { module, op: 'log', ref: i.night, label, undoable: true }, journal: { steps: [step] } } };
    }
    case 'list_item_add': {
      const p = PERSON_WRITE_INPUTS.list_item_add.safeParse(raw);
      const space = sharedOf(pc);
      if (!p.success || !pc.people.lists || !space) return p.success ? refuse('life_unavailable', PERSON_WRITE_SENTENCES.closed) : refuse('invalid_request', PERSON_WRITE_SENTENCES.bad);
      const r = pc.people.lists.addItem(space, pc.pid, p.data.listId, { title: p.data.title, ...(p.data.note ? { note: p.data.note } : {}) });
      if (!r.ok) return r;
      const list = pc.people.lists.items(space, p.data.listId);
      const label = cut(`List · ${list.ok ? t(list.value.list.name, 40) : 'shared'} · ${t(p.data.title)}`, 160);
      return { ok: true, value: { change: { module, op: 'add', ref: r.value.id, label, undoable: true }, journal: { steps: [{ do: 'person', op: 'itemRemove', listId: p.data.listId, itemId: r.value.id } as PersonStep] } } };
    }
    case 'list_item_tick': {
      const p = PERSON_WRITE_INPUTS.list_item_tick.safeParse(raw);
      const space = sharedOf(pc);
      if (!p.success || !pc.people.lists || !space) return p.success ? refuse('life_unavailable', PERSON_WRITE_SENTENCES.closed) : refuse('invalid_request', PERSON_WRITE_SENTENCES.bad);
      const done = p.data.done ?? true;
      const list = pc.people.lists.items(space, p.data.listId);
      if (!list.ok) return refuse('not_found', PERSON_WRITE_SENTENCES.noList);
      const item = list.value.items.find((x) => x.id === p.data.itemId);
      if (!item) return refuse('not_found', PERSON_WRITE_SENTENCES.noItem);
      if (Boolean(item.doneAt) === done) return refuse('conflict', PERSON_WRITE_SENTENCES.nothing);
      const r = pc.people.lists.tick(space, pc.pid, p.data.listId, p.data.itemId, done);
      if (!r.ok) return r;
      const label = cut(`List · ${t(list.value.list.name, 40)} · ${t(item.title)} · ${done ? 'ticked' : 'unticked'}`, 160);
      const his = item.by === '' || item.editedBy === '';
      return { ok: true, value: { change: { module, op: 'tick', ref: p.data.itemId, label, undoable: true }, journal: { steps: [{ do: 'person', op: 'itemTick', listId: p.data.listId, itemId: p.data.itemId, done } as PersonStep] }, ...(his ? { third: 'owner' as const } : {}) } };
    }
    case 'alert_send': {
      const p = PERSON_WRITE_INPUTS.alert_send.safeParse(raw);
      const alerts = pc.people.alerts;
      if (!p.success || !alerts) return p.success ? refuse('life_unavailable', PERSON_WRITE_SENTENCES.closed) : refuse('invalid_request', PERSON_WRITE_SENTENCES.bad);
      const r = alerts.send(pc.pid, '', { kind: p.data.kind, ...(p.data.text ? { text: p.data.text } : {}) });
      if (!r.ok) return r;
      return { ok: true, value: { change: { module, op: 'add', ref: r.value.id, label: cut(`Alert to ${t(pc.people.ownerName(), 40)} · ${ALERT_KINDS[p.data.kind].label}`, 160), undoable: false }, journal: null } };
    }
  }
}

/** A Do-it card's words for one of her writes (the tap runs it). */
export function describePersonWrite(pc: PersonChat, tool: PersonWriteTool, input: Record<string, unknown>): string {
  const owner = t(pc.people.ownerName(), 40);
  switch (tool) {
    case 'alert_send': {
      const kind = ALERT_KINDS[input.kind as keyof typeof ALERT_KINDS];
      const text = typeof input.text === 'string' && input.text ? `: ${t(input.text, 80)}` : '';
      return cut(`Send ${owner} "${kind?.label ?? 'an alert'}${text}"?`, 200);
    }
    case 'step_state': {
      const s = stepOf(pc, input.day as string, input.stepId as string);
      return cut(`Mark step "${t(s?.title)}" ${String(input.to)}?`, 200);
    }
    case 'step_add':
      return cut(`Add step "${t(input.title as string)}"${input.at ? ` at ${String(input.at)}` : ''}?`, 200);
    case 'between_tick':
      return cut(`${input.done ? 'Tick' : 'Untick'} ${String(input.slot)}?`, 200);
    case 'checkin_answer':
      return `Answer the check-in: mood ${String(input.mood)}, energy ${String(input.energy)}?`;
    case 'status_set':
      return `Set your status to ${STATUS_LABELS[input.level as keyof typeof STATUS_LABELS] ?? 'it'}?`;
    case 'sleep_log':
      return cut(`Log the night of ${String(input.night)}?`, 200);
    case 'list_item_add':
      return cut(`Add "${t(input.title as string)}" to the list?`, 200);
    case 'list_item_tick':
      return input.done === false ? 'Untick the item?' : 'Tick the item?';
  }
}

/** Her shared space (P4), or null. */
function sharedOf(pc: PersonChat): string | null {
  try {
    return pc.people.person(pc.pid)?.sharedSpace ?? null;
  } catch {
    return null;
  }
}

/** Whether her step may be put back: the assistant's value still holds (else 409), its item is there (else 404). */
export function stillPerson(pc: PersonChat, s: PersonStep): Refusal | null {
  const changed = refuse('conflict', PERSON_WRITE_SENTENCES.changed);
  switch (s.op) {
    case 'stepRemove':
      return null;
    case 'stepState': {
      const st = stepOf(pc, s.day, s.stepId);
      if (!st) return refuse('not_found', PERSON_WRITE_SENTENCES.noStep);
      return st.status === s.after ? null : changed;
    }
    case 'tick': {
      const b = betweenOf(pc, s.day, s.id);
      if (!b) return refuse('not_found', PERSON_WRITE_SENTENCES.noBetween);
      const tick = b.ticks.find((x) => x.slot === s.slot);
      return Boolean(tick?.doneAt) === s.done ? null : changed;
    }
    case 'night': {
      const n = nightOf(pc, s.night);
      if (!n) return s.before === null ? null : refuse('not_found', PERSON_WRITE_SENTENCES.nothing);
      return n.bedAt === s.after.bedAt && (n.wakeAt ?? null) === s.after.wakeAt ? null : changed;
    }
    case 'itemRemove':
      return null;
    case 'itemTick': {
      const space = sharedOf(pc);
      const list = space && pc.people.lists ? pc.people.lists.items(space, s.listId) : null;
      const item = list?.ok ? list.value.items.find((x) => x.id === s.itemId) : undefined;
      if (!item) return refuse('not_found', PERSON_WRITE_SENTENCES.noItem);
      return Boolean(item.doneAt) === s.done ? null : changed;
    }
  }
}

/** Put one of her steps back. */
export function undoPerson(pc: PersonChat, s: PersonStep): LifeResult {
  const plans = pc.people.plans;
  const sleep = pc.people.sleep;
  switch (s.op) {
    case 'stepRemove': {
      if (!plans) return refuse('life_unavailable', PERSON_WRITE_SENTENCES.closed);
      const r = plans.deleteStep(pc.pid, s.day, s.stepId);
      return !r.ok && r.code === 'not_found' ? { ok: true, value: true } : r;
    }
    case 'stepState':
      return plans ? plans.setState(pc.pid, s.day, s.stepId, { to: s.before }) : refuse('life_unavailable', PERSON_WRITE_SENTENCES.closed);
    case 'tick':
      return plans ? plans.tick(pc.pid, s.day, s.id, s.slot, !s.done) : refuse('life_unavailable', PERSON_WRITE_SENTENCES.closed);
    case 'night': {
      if (!sleep) return refuse('life_unavailable', PERSON_WRITE_SENTENCES.closed);
      if (s.before === null) {
        const r = sleep.remove(pc.pid, s.night);
        return !r.ok && r.code === 'not_found' ? { ok: true, value: true } : r;
      }
      return sleep.put(pc.pid, s.night, s.before);
    }
    case 'itemRemove': {
      const space = sharedOf(pc);
      if (!space || !pc.people.lists) return refuse('life_unavailable', PERSON_WRITE_SENTENCES.closed);
      const r = pc.people.lists.deleteItem(space, pc.pid, s.listId, s.itemId);
      return !r.ok && r.code === 'not_found' ? { ok: true, value: true } : r;
    }
    case 'itemTick': {
      const space = sharedOf(pc);
      if (!space || !pc.people.lists) return refuse('life_unavailable', PERSON_WRITE_SENTENCES.closed);
      return pc.people.lists.tick(space, pc.pid, s.listId, s.itemId, !s.done);
    }
  }
}
