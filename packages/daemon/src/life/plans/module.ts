/**
 * v0.12 People (P2): her day plans, his templates and her evening review
 * (spec 3.1, 3.2, 3.6, 3.10, 4.3). One plan per day in her space, its
 * steps and check-betweens inline (D4).
 *
 * Who may do what, in code (D22, O4, C32):
 * - She adds, edits and deletes her own steps; on his she sets only `ring`
 *   and `focus` for herself (409 `assigned` for anything else, and Ask to
 *   change instead). Only she starts, finishes, skips, undoes, acks, checks
 *   in, ticks a check-between, carries her own steps, declares a rough day
 *   and sends her review. No method here does any of that for him.
 * - He sets the plan (`assign.plan`), with `srev` (a stale one is 409 and
 *   he reloads). Her steps come through his write unchanged unless
 *   `editHers.plan` is on; then each edit says "Edited by" and her Activity
 *   keeps the old values. Status always comes from the stored step.
 * - Paused holds his writes (409 `paused`); a rough day holds his writes to
 *   today (he can still plan tomorrow).
 * - The honesty rule (spec 3.2): check-ins, skips and review outcomes never
 *   create an item, an alert or a score here.
 *
 * Every refusal of a person, area or row he may not see is the one
 * not_found. Logs carry ids and counts, never titles or notes.
 */
import {
  FOCUS_DEFAULT_MIN,
  FOCUS_PAD_MIN,
  PLAN_BETWEEN_MAX,
  PLAN_STEPS_MAX,
  PLAN_TEMPLATES_MAX,
  REVIEW_CLOSE_AT,
  STEP_LATE_MIN,
  type Agreement,
  type Between,
  type DayPlan,
  type PersonTodo,
  type PlanApplyBody,
  type PlanPutBody,
  type PlanPutStep,
  type PlanStep,
  type PlanTemplate,
  type PlanView,
  type ReviewItem,
  type ReviewSendBody,
  type ReviewView,
  type StepBody,
  type StepCheckinBody,
  type StepPatch,
  type StepStateBody,
  type TemplateBody,
  type TemplatePatch,
} from '@jantar/protocol/people';
import { countsLine, instantAt, minuteOf, reviewCounts, reviewOutcome, shiftDay, type ReviewOutcome } from '@jantar/life-core';
import type { LifeCore, LifeResult } from '../../contracts.js';
import { newId } from '../../core/ids.js';
import type { PeopleModule } from '../people/module.js';
import { CLOSED, NO_PERSON, OK, clipLine, dayLabel, localNow, refuse, shortId, type Refusal } from '../people/kit.js';
import { allPlans, deletePlan, deleteTemplate, getPlan, getTemplate, listTemplates, plansFrom, savePlan, saveTemplate } from './repo.js';

export const PLAN_REASONS = {
  noStep: 'No such step.',
  noPlan: 'There is no plan for that day.',
  assigned: (owner: string) => `${owner} planned this. Ask to change it instead.`,
  notHis: 'Only steps planned for you take "Got it" or "Ask to change".',
  notCheckin: 'This step has no check-in.',
  future: "That day hasn't started yet.",
  notToday: 'A rough day is for today only.',
  stale: 'The plan changed since you opened it. Reload it and try again.',
  rough: (name: string) => `${name} marked today a rough day. You can plan tomorrow.`,
  full: `A plan holds at most ${PLAN_STEPS_MAX} steps and ${PLAN_BETWEEN_MAX} check-betweens.`,
  templatesFull: `${PLAN_TEMPLATES_MAX} templates is the most for now. Delete one first.`,
  noTemplate: 'No such template.',
  moved: 'That step moved to a later day.',
  excused: 'Undo the rough day first.',
  carryLater: 'Carry it to a later day.',
  notOpen: 'Only an open step can be carried.',
  slot: 'That check is not open now.',
  sent: "That day's review was already sent.",
  paused: (name: string) => `${name} has paused. New items wait until sharing resumes.`,
  between: 'A check-between needs its last time after its first.',
} as const;

const STEP_FIELDS = ['title', 'at', 'minutes', 'notes', 'ask', 'ring', 'focus', 'followUp'] as const;
const MIN_MS = 60_000;

/** One check-between's slots: from, then every N minutes, up to and including `to`. */
export function slotsOf(b: Pick<Between, 'every' | 'from' | 'to'>): string[] {
  const out: string[] = [];
  const from = minuteOf(b.from);
  const to = minuteOf(b.to);
  for (let m = from; m <= to && out.length < 16; m += b.every) out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  return out;
}

/**
 * The plan as a view carries it: never the stored review (area `review`,
 * read at his level through the review routes) nor the to-dos that left the
 * day (area `todos`), so `see.plan` alone shows neither.
 */
function shown(plan: DayPlan): DayPlan {
  const { review: _review, todoNotes: _todoNotes, ...rest } = plan;
  return rest;
}

/** An open step: still to do or doing, not carried, not excused. */
export function isOpen(s: PlanStep): boolean {
  return (s.status === 'todo' || s.status === 'doing') && !s.carriedTo;
}

/**
 * The steps due by `minute`, in plan order (Now is the first open one). A
 * timed step is due from its time. An untimed step follows the step before
 * it: due once that one is due or closed (done, skipped, excused), so it
 * never jumps ahead of a timed step he planned before it ("Mock 08:00, then
 * Analysis" has no Now before 08:00, and Next is Mock). A first step with no
 * time is due at once.
 */
export function dueSteps(steps: readonly PlanStep[], minute: number): Set<string> {
  const out = new Set<string>();
  let prev: PlanStep | null = null;
  let prevDue = true;
  for (const s of steps) {
    const due: boolean = s.at !== undefined ? minuteOf(s.at) <= minute : prev === null || prevDue || !(prev.status === 'todo' || prev.status === 'doing');
    if (due) out.add(s.id);
    prev = s;
    prevDue = due;
  }
  return out;
}

/** When a focus step's focus ends (C32): its length plus 30 minutes after Start, or 90 minutes with no length. */
export function focusUntil(s: PlanStep): number | null {
  if (!(s.focus || s.focusByHer) || s.status !== 'doing' || !s.startedAt) return null;
  const mins = s.minutes !== undefined ? s.minutes + FOCUS_PAD_MIN : FOCUS_DEFAULT_MIN;
  return Date.parse(s.startedAt) + mins * MIN_MS;
}

function stepChanges(before: PlanStep, after: PlanStep): { field: string; from?: string; to?: string }[] {
  const out: { field: string; from?: string; to?: string }[] = [];
  for (const f of STEP_FIELDS) {
    const a = before[f];
    const b = after[f];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (f === 'notes') out.push({ field: f });
    else out.push({ field: f, ...(a !== undefined ? { from: String(a).slice(0, 200) } : {}), ...(b !== undefined ? { to: String(b).slice(0, 200) } : {}) });
  }
  return out;
}

/** A step's planned fields from his body (status fields never come from a body). */
function plannedFields(s: PlanPutStep | StepBody): Pick<PlanStep, 'title' | 'ask' | 'ring' | 'focus'> & Partial<Pick<PlanStep, 'at' | 'minutes' | 'notes' | 'followUp'>> {
  return {
    title: s.title,
    ...(s.at !== undefined ? { at: s.at } : {}),
    ...(s.minutes !== undefined ? { minutes: s.minutes } : {}),
    ...(s.notes ? { notes: s.notes } : {}),
    ask: s.ask ?? 'none',
    ring: s.ring ?? true,
    focus: s.focus ?? false,
    ...('followUp' in s && s.followUp !== undefined ? { followUp: s.followUp } : {}),
  };
}

/** A step with its planned fields replaced (her flags and every status field kept). */
function withPlanned(s: PlanStep, f: ReturnType<typeof plannedFields>): PlanStep {
  const { at: _a, minutes: _m, notes: _n, followUp: _f, ...rest } = s;
  return { ...rest, ...f };
}

export interface PlansDeps {
  people: PeopleModule;
  core: () => LifeCore | null;
}

export class PlansModule {
  constructor(private readonly d: PlansDeps) {}

  private get people(): PeopleModule {
    return this.d.people;
  }

  private core(): LifeCore | null {
    return this.d.core();
  }

  private iso(ms?: number): string {
    const c = this.core();
    return new Date(ms ?? (c ? c.now().getTime() : Date.now())).toISOString();
  }

  private newPlan(day: string): DayPlan {
    const at = this.iso();
    return { id: newId(), day, srev: 0, steps: [], between: [], createdAt: at, updatedAt: at };
  }

  // ---------------------------------------------------------------------------
  // Reading (her plan, his view and her mirror: one function, D11)

  /**
   * A day's plan with what is derived on read: Now, Next, the late steps,
   * focus, the check-between slots and the counts. Pure over the stored
   * plan and the clock, so his view and her mirror deep-equal (T10).
   */
  view(pid: string, day: string): PlanView {
    const c = this.core();
    const plan = c ? getPlan(c, pid, day) : null;
    return this.derive(day, plan);
  }

  private derive(day: string, plan: DayPlan | null): PlanView {
    const c = this.core();
    const now = c ? localNow(c) : null;
    const today = now?.day ?? day;
    const empty: PlanView = { day, plan: null, now: null, next: null, late: [], focus: null, slots: {}, counts: { done: 0, total: 0 } };
    if (!plan) return empty;
    const steps = plan.steps.filter((s) => !s.carriedTo);
    const counts = { done: steps.filter((s) => s.status === 'done').length, total: steps.length };
    const slots: PlanView['slots'] = {};
    for (const b of plan.between) {
      const list = slotsOf(b);
      slots[b.id] = list.map((slot, i) => {
        if (b.ticks.some((t) => t.slot === slot && t.doneAt)) return { slot, state: 'done' as const };
        if (day < today) return { slot, state: 'past' as const };
        if (day > today || !now) return { slot, state: 'later' as const };
        const end = list[i + 1] ?? null;
        const m = now.minute;
        if (m < minuteOf(slot)) return { slot, state: 'later' as const };
        const endMin = end ? minuteOf(end) : minuteOf(slot) + b.every;
        return { slot, state: m < endMin ? ('open' as const) : ('past' as const) };
      });
    }
    let nowId: string | null = null;
    let nextId: string | null = null;
    const late: string[] = [];
    let focus: PlanView['focus'] = null;
    if (day === today && now) {
      const open = steps.filter((s) => s.status === 'todo' || s.status === 'doing');
      const doing = open.find((s) => s.status === 'doing');
      const dueIds = dueSteps(steps, now.minute);
      const due = open.find((s) => s.status === 'todo' && dueIds.has(s.id));
      const nowStep = doing ?? due ?? null;
      nowId = nowStep?.id ?? null;
      nextId = open.find((s) => s.status === 'todo' && s.id !== nowId && (!nowStep || steps.indexOf(s) > steps.indexOf(nowStep)))?.id ?? null;
      for (const s of open) if (s.status === 'todo' && s.at !== undefined && now.minute >= minuteOf(s.at) + STEP_LATE_MIN) late.push(s.id);
      for (const s of steps) {
        const until = focusUntil(s);
        if (until !== null && until > now.ms) {
          focus = { stepId: s.id, title: s.title, until: new Date(until).toISOString() };
          break;
        }
      }
    }
    return { day, plan: shown(plan), now: nowId, next: nextId, late, focus, slots, counts };
  }

  /** Her read of a plan: marks "Seen" on her first open after it was sent or changed (the join page names it). */
  herView(pid: string, day: string): PlanView {
    const c = this.core();
    if (!c) return this.derive(day, null);
    const plan = getPlan(c, pid, day);
    if (plan?.sentAt && (!plan.seenAt || (plan.changedAt !== undefined && plan.seenAt < plan.changedAt))) {
      const seen = { ...plan, seenAt: this.iso() };
      savePlan(c, pid, seen);
      this.people.herWrote(pid, 'plan', 'plan');
      return this.derive(day, seen);
    }
    return this.derive(day, plan);
  }

  /** The focus step running now, or null (her delivery state reads it). */
  focusOf(pid: string): { stepId: string; title: string; until: string } | null {
    const c = this.core();
    if (!c) return null;
    return this.derive(c.today(), getPlan(c, pid, c.today())).focus;
  }

  // ---------------------------------------------------------------------------
  // Her writes

  private load(pid: string, day: string): { c: LifeCore; plan: DayPlan } | Refusal {
    const c = this.core();
    if (!c) return refuse('unavailable', CLOSED);
    const plan = getPlan(c, pid, day);
    if (!plan) return refuse('not_found', PLAN_REASONS.noPlan);
    return { c, plan };
  }

  private step(plan: DayPlan, stepId: string): PlanStep | null {
    return plan.steps.find((s) => s.id === stepId) ?? null;
  }

  private store(c: LifeCore, pid: string, plan: DayPlan, opts: { structural?: boolean } = {}): DayPlan {
    const next = { ...plan, srev: opts.structural ? plan.srev + 1 : plan.srev, updatedAt: this.iso() };
    savePlan(c, pid, next);
    this.arm(pid, next);
    return next;
  }

  ack(pid: string, day: string): LifeResult {
    const l = this.load(pid, day);
    if ('ok' in l) return l;
    this.store(l.c, pid, { ...l.plan, ackAt: this.iso() });
    this.people.herWrote(pid, 'plan', 'plan');
    return OK;
  }

  addStep(pid: string, day: string, body: StepBody): LifeResult<{ id: string }> {
    const c = this.core();
    if (!c) return refuse('unavailable', CLOSED);
    const plan = getPlan(c, pid, day) ?? this.newPlan(day);
    if (plan.steps.filter((s) => !s.carriedTo).length >= PLAN_STEPS_MAX) return refuse('conflict', PLAN_REASONS.full);
    const step: PlanStep = { id: shortId(), ...plannedFields(body), by: pid, status: 'todo' };
    this.store(c, pid, { ...plan, steps: [...plan.steps, step] }, { structural: true });
    this.people.herWrote(pid, 'plan', 'plan');
    return { ok: true, value: { id: step.id } };
  }

  updateStep(pid: string, day: string, stepId: string, patch: StepPatch): LifeResult {
    const l = this.load(pid, day);
    if ('ok' in l) return l;
    const s = this.step(l.plan, stepId);
    if (!s) return refuse('not_found', PLAN_REASONS.noStep);
    let next: PlanStep;
    if (s.by !== pid) {
      // His step: only ring and focus, for herself (C32).
      const other = Object.entries(patch).filter(([k, v]) => v !== undefined && k !== 'ring' && k !== 'focus');
      if (other.length > 0) return refuse('conflict', PLAN_REASONS.assigned(this.people.ownerName()));
      next = { ...s };
      if (patch.ring !== undefined) {
        if (patch.ring) delete next.mutedByHer;
        else next.mutedByHer = true;
      }
      if (patch.focus !== undefined) {
        if (patch.focus) next.focusByHer = true;
        else delete next.focusByHer;
      }
    } else {
      next = { ...s };
      if (patch.title !== undefined) next.title = patch.title;
      for (const f of ['at', 'minutes', 'notes'] as const) {
        const v = patch[f];
        if (v === null) delete next[f];
        else if (v !== undefined) (next as Record<string, unknown>)[f] = v;
      }
      if (patch.ask !== undefined) next.ask = patch.ask;
      if (patch.ring !== undefined) next.ring = patch.ring;
      if (patch.focus !== undefined) next.focus = patch.focus;
    }
    this.store(l.c, pid, { ...l.plan, steps: l.plan.steps.map((x) => (x.id === stepId ? next : x)) }, { structural: s.by === pid });
    this.people.herWrote(pid, 'plan', 'plan');
    if (focusUntil(s) !== null && focusUntil(next) === null) this.people.alerts?.release(pid);
    return OK;
  }

  deleteStep(pid: string, day: string, stepId: string): LifeResult {
    const l = this.load(pid, day);
    if ('ok' in l) return l;
    const s = this.step(l.plan, stepId);
    if (!s) return refuse('not_found', PLAN_REASONS.noStep);
    if (s.by !== pid) return refuse('conflict', PLAN_REASONS.assigned(this.people.ownerName()));
    this.store(l.c, pid, { ...l.plan, steps: l.plan.steps.filter((x) => x.id !== stepId) }, { structural: true });
    this.people.herWrote(pid, 'plan', 'plan');
    return OK;
  }

  /** Start, done, skip or undo (hers alone). Ticks never bump `srev`, so they never conflict with his edits. */
  setState(pid: string, day: string, stepId: string, body: StepStateBody): LifeResult {
    const l = this.load(pid, day);
    if ('ok' in l) return l;
    if (day > l.c.today()) return refuse('conflict', PLAN_REASONS.future);
    const s = this.step(l.plan, stepId);
    if (!s) return refuse('not_found', PLAN_REASONS.noStep);
    if (s.carriedTo) return refuse('conflict', PLAN_REASONS.moved);
    if (s.status === 'excused') return refuse('conflict', PLAN_REASONS.excused);
    const at = this.iso();
    const next: PlanStep = { ...s };
    switch (body.to) {
      case 'doing':
        next.status = 'doing';
        next.startedAt = at;
        delete next.doneAt;
        delete next.skip;
        break;
      case 'done':
        next.status = 'done';
        next.doneAt = at;
        delete next.skip;
        if (body.report) next.report = body.report;
        break;
      case 'skipped':
        next.status = 'skipped';
        next.skip = { at, ...(body.reason ? { reason: body.reason } : {}) };
        delete next.doneAt;
        break;
      case 'todo':
        next.status = 'todo';
        delete next.startedAt;
        delete next.doneAt;
        delete next.skip;
        delete next.report;
        break;
    }
    this.store(l.c, pid, { ...l.plan, steps: l.plan.steps.map((x) => (x.id === stepId ? next : x)) });
    this.people.herWrote(pid, 'plan', 'plan');
    // Focus ends on done or skip: what it held comes back as one summary. Start arms the release at its end.
    if (focusUntil(next) !== null) this.people.alerts?.armRelease(pid);
    else if (focusUntil(s) !== null) this.people.alerts?.release(pid);
    return OK;
  }

  ackStep(pid: string, day: string, stepId: string): LifeResult {
    const l = this.load(pid, day);
    if ('ok' in l) return l;
    const s = this.step(l.plan, stepId);
    if (!s) return refuse('not_found', PLAN_REASONS.noStep);
    if (s.by !== '') return refuse('conflict', PLAN_REASONS.notHis);
    this.store(l.c, pid, { ...l.plan, steps: l.plan.steps.map((x) => (x.id === stepId ? { ...x, ackAt: this.iso() } : x)) });
    this.people.herWrote(pid, 'plan', 'plan');
    return OK;
  }

  checkin(pid: string, day: string, stepId: string, body: StepCheckinBody): LifeResult {
    const l = this.load(pid, day);
    if ('ok' in l) return l;
    const s = this.step(l.plan, stepId);
    if (!s) return refuse('not_found', PLAN_REASONS.noStep);
    if (s.ask !== 'checkin') return refuse('conflict', PLAN_REASONS.notCheckin);
    const checkin = { mood: body.mood, energy: body.energy, ...(body.line ? { line: body.line } : {}), ...(body.need ? { need: body.need } : {}), at: this.iso() };
    this.store(l.c, pid, { ...l.plan, steps: l.plan.steps.map((x) => (x.id === stepId ? { ...x, checkin } : x)) });
    this.people.herWrote(pid, 'plan', 'plan');
    return OK;
  }

  /** Ask to change a step he planned: a change request alert to him, with her note. */
  ask(pid: string, day: string, stepId: string, note: string): LifeResult {
    const l = this.load(pid, day);
    if ('ok' in l) return l;
    const s = this.step(l.plan, stepId);
    if (!s) return refuse('not_found', PLAN_REASONS.noStep);
    if (s.by !== '') return refuse('conflict', PLAN_REASONS.notHis);
    const alerts = this.people.alerts;
    if (!alerts) return refuse('unavailable', CLOSED);
    return alerts.changeRequest(pid, { type: 'step', id: s.id, day, title: s.title }, note);
  }

  /** Carry an open step of hers to a later day: it reads "moved" here, and a copy with `carriedFrom` lands there. */
  carry(pid: string, day: string, stepId: string, to: string): LifeResult {
    const l = this.load(pid, day);
    if ('ok' in l) return l;
    const s = this.step(l.plan, stepId);
    if (!s || s.by !== pid) return refuse('not_found', PLAN_REASONS.noStep);
    if (to <= day || to < l.c.today()) return refuse('invalid_request', PLAN_REASONS.carryLater);
    if (!isOpen(s)) return refuse('conflict', PLAN_REASONS.notOpen);
    this.carrySteps(l.c, pid, l.plan, [s], to);
    this.people.herWrote(pid, 'plan', 'plan');
    return OK;
  }

  /** Move steps to a later day (her carry, or his): one copy each, appended there. */
  private carrySteps(c: LifeCore, pid: string, from: DayPlan, steps: readonly PlanStep[], to: string): DayPlan {
    const ids = new Set(steps.map((s) => s.id));
    const target = getPlan(c, pid, to) ?? this.newPlan(to);
    const copies: PlanStep[] = steps.map((s) => {
      const { status: _st, startedAt: _sa, doneAt: _da, ackAt: _aa, report: _r, skip: _sk, checkin: _ci, carriedTo: _ct, wasStatus: _ws, ...rest } = s;
      return { ...rest, id: shortId(), status: 'todo', carriedFrom: { day: from.day, stepId: s.id } };
    });
    const moved = this.store(c, pid, { ...from, steps: from.steps.map((x) => (ids.has(x.id) ? { ...x, carriedTo: to } : x)) }, { structural: true });
    this.store(c, pid, { ...target, steps: [...target.steps, ...copies] }, { structural: true });
    return moved;
  }

  /** Tick or untick a check-between slot: from its time until the next slot; later slots can't be ticked. */
  tick(pid: string, day: string, bid: string, slot: string, done: boolean): LifeResult {
    const l = this.load(pid, day);
    if ('ok' in l) return l;
    const b = l.plan.between.find((x) => x.id === bid);
    if (!b) return refuse('not_found', PLAN_REASONS.noStep);
    const state = this.derive(day, l.plan).slots[bid]?.find((x) => x.slot === slot)?.state;
    if (state === undefined || (state !== 'open' && !(state === 'done' && !done))) return refuse('conflict', PLAN_REASONS.slot);
    const ticks = b.ticks.filter((t) => t.slot !== slot);
    if (done) ticks.push({ slot, doneAt: this.iso() });
    this.store(l.c, pid, { ...l.plan, between: l.plan.between.map((x) => (x.id === bid ? { ...x, ticks } : x)) });
    this.people.herWrote(pid, 'plan', 'plan');
    return OK;
  }

  /**
   * A rough day (spec 3.7): every open step today is excused, today's rings
   * stop, her status turns Low, and he hears one push after 10 seconds,
   * behind her Undo (C35).
   */
  rough(pid: string, day: string, note: string | undefined): LifeResult {
    const c = this.core();
    if (!c) return refuse('unavailable', CLOSED);
    if (day !== c.today()) return refuse('conflict', PLAN_REASONS.notToday);
    const plan = getPlan(c, pid, day) ?? this.newPlan(day);
    if (plan.rough) return OK;
    const at = this.iso();
    const p = this.people.person(pid);
    const prevStatus = this.people.statusOf(p);
    const steps = plan.steps.map((s) => (isOpen(s) ? { ...s, wasStatus: s.status, status: 'excused' as const } : s));
    const saved = this.store(c, pid, { ...plan, steps, rough: { at, ...(note ? { note } : {}), prevStatus } });
    this.people.putStatus(pid, { level: 'low', at, until: this.iso(Date.parse(at) + 12 * 3_600_000) });
    c.scheduler.set('plan_rough', saved.id, '', new Date(Date.parse(at) + 10_000));
    c.scheduler.poke();
    this.people.herWrote(pid, 'plan', 'plan');
    this.people.alerts?.release(pid);
    return OK;
  }

  roughUndo(pid: string, day: string): LifeResult {
    const l = this.load(pid, day);
    if ('ok' in l) return l;
    if (day !== l.c.today()) return refuse('conflict', PLAN_REASONS.notToday);
    const rough = l.plan.rough;
    if (!rough) return OK;
    const steps = l.plan.steps.map((s) => {
      if (s.status !== 'excused') return s;
      const { wasStatus, ...rest } = s;
      return { ...rest, status: wasStatus ?? 'todo' };
    });
    const { rough: _r, ...plan } = l.plan;
    this.store(l.c, pid, { ...plan, steps });
    this.people.putStatus(pid, rough.prevStatus ?? null);
    l.c.scheduler.clear('plan_rough', l.plan.id);
    this.people.herWrote(pid, 'plan', 'plan');
    return OK;
  }

  // ---------------------------------------------------------------------------
  // The evening review (spec 3.10)

  /** The day's items: every step as sent (gone if he removed it), each check-between, and her todos due that day. */
  private reviewItems(pid: string, day: string, plan: DayPlan | null, close: boolean): ReviewItem[] {
    const items: ReviewItem[] = [];
    const ids = new Set<string>();
    for (const s of plan?.steps ?? []) {
      ids.add(s.id);
      const open = isOpen(s);
      const outcome: ReviewOutcome | undefined = open && !close ? undefined : reviewOutcome({ status: s.status, movedTo: s.carriedTo ?? null });
      items.push({
        kind: 'step',
        ref: s.id,
        title: s.title,
        by: s.by,
        ...(outcome ? { outcome } : {}),
        ...(s.doneAt ? { doneAt: s.doneAt } : {}),
        ...(s.carriedTo ? { movedTo: s.carriedTo } : {}),
        ...(s.skip?.reason ? { reason: s.skip.reason } : {}),
        ...(s.report ? { report: s.report } : {}),
      });
    }
    for (const s of plan?.sentSteps ?? []) {
      if (ids.has(s.id)) continue;
      ids.add(s.id);
      items.push({ kind: 'step', ref: s.id, title: s.title, by: s.by, outcome: 'gone' });
    }
    for (const b of plan?.between ?? []) {
      const slots = slotsOf(b);
      items.push({ kind: 'between', ref: b.id, title: b.title, by: b.by, ticks: { done: b.ticks.filter((t) => t.doneAt && slots.includes(t.slot)).length, of: slots.length } });
    }
    for (const t of this.todosOf(pid, day)) {
      if (ids.has(t.id)) continue;
      ids.add(t.id);
      const skipped = t.skipped;
      const status = skipped ? 'skipped' : t.doneAt ? 'done' : 'todo';
      const outcome: ReviewOutcome | undefined = status === 'todo' && !close ? undefined : reviewOutcome({ status });
      items.push({
        kind: 'todo',
        ref: t.id,
        title: t.title.slice(0, 120),
        by: t.by ?? '',
        ...(outcome ? { outcome } : {}),
        ...(t.doneAt && !skipped ? { doneAt: t.doneAt } : {}),
        ...(skipped?.reason ? { reason: skipped.reason } : {}),
        ...(t.report ? { report: t.report } : {}),
      });
    }
    for (const n of plan?.todoNotes ?? []) {
      if (ids.has(n.id)) continue;
      ids.add(n.id);
      items.push({ kind: 'todo', ref: n.id, title: n.title, by: n.by, outcome: n.outcome, ...(n.to ? { movedTo: n.to } : {}) });
    }
    return items;
  }

  /** Her todos due that day: open ones due then, and ones done or skipped that day. */
  private todosOf(pid: string, day: string): PersonTodo[] {
    const space = this.people.space;
    const c = this.core();
    if (!space || !c) return [];
    const out: PersonTodo[] = [];
    const open = space.herList(pid, { done: false });
    if (open.ok) out.push(...open.value.todos.filter((t) => t.due?.day === day));
    const done = space.herList(pid, { done: true });
    if (done.ok) out.push(...done.value.todos.filter((t) => t.due?.day === day && (t.doneAt !== undefined || t.skipped !== undefined)));
    return out;
  }

  /**
   * Whether a day has anything to review (steps, check-betweens or todos
   * due). `todos: false` (his view with `see.todos` off) leaves her to-dos
   * out, so a day with only to-dos reads as nothing to review.
   */
  reviewable(pid: string, day: string, opts: { todos: boolean } = { todos: true }): boolean {
    const c = this.core();
    if (!c) return false;
    const plan = getPlan(c, pid, day);
    if ((plan?.steps.length ?? 0) > 0 || (plan?.between.length ?? 0) > 0 || (plan?.sentSteps?.length ?? 0) > 0) return true;
    return opts.todos && (this.todosOf(pid, day).length > 0 || (plan?.review?.outcomes.some((i) => i.kind === 'todo') ?? false));
  }

  /**
   * The review at a level: live until she sends it (or it closes), stored
   * after. `counts` names no title, note or mood. `todos: false` (his view
   * and her mirror with `see.todos` off) drops every to-do item and its
   * share of the counts, the stored outcomes too: a sent review still holds
   * them, and the to-dos are their own area.
   */
  reviewView(pid: string, day: string, level: 'full' | 'counts', opts: { todos: boolean }): ReviewView {
    const c = this.core();
    const plan = c ? getPlan(c, pid, day) : null;
    const stored = plan?.review;
    const all = stored ? stored.outcomes : this.reviewItems(pid, day, plan, false);
    const items = opts.todos ? all : all.filter((i) => i.kind !== 'todo');
    const scored = items.filter((i) => i.kind !== 'between');
    const counts = reviewCounts(scored.map((i) => i.outcome));
    const open = scored.filter((i) => i.outcome === undefined).length;
    const line = `${countsLine(counts)}${open > 0 ? ` · ${open} open` : ''}`.replace(/^Nothing planned · /, '');
    const head = { day, sent: stored !== undefined, ...(stored ? { at: stored.at, ...(stored.auto ? { auto: true } : {}) } : {}), counts, line };
    if (level === 'counts') return { level: 'counts', ...head };
    return { level: 'full', ...head, items, ...(stored?.note ? { note: stored.note } : {}), ...(stored?.mood ? { mood: stored.mood } : {}) };
  }

  /**
   * Send the review (hers, once a day): her own open steps listed in
   * `carry` move to the next day, his in `askCarry` go to him as one change
   * request, then every outcome is stored (open is missed). "Also save to
   * my journal" makes a review entry with the same note and mood.
   */
  reviewSend(pid: string, day: string, body: ReviewSendBody): LifeResult {
    const c = this.core();
    if (!c) return refuse('unavailable', CLOSED);
    if (day > c.today()) return refuse('conflict', PLAN_REASONS.future);
    let plan = getPlan(c, pid, day);
    if (plan?.review) return refuse('conflict', PLAN_REASONS.sent);
    const to = shiftDay(day, 1) >= c.today() ? shiftDay(day, 1) : c.today();
    if (plan && body.carry && body.carry.length > 0) {
      const mine = plan.steps.filter((s) => body.carry?.includes(s.id) && s.by === pid && isOpen(s));
      if (mine.length > 0) plan = this.carrySteps(c, pid, plan, mine, to);
    }
    if (plan && body.askCarry && body.askCarry.length > 0) {
      const his = plan.steps.filter((s) => body.askCarry?.includes(s.id) && s.by === '' && isOpen(s));
      if (his.length > 0) this.people.alerts?.carryRequest(pid, day, to, his.map((s) => s.id));
    }
    const at = this.iso();
    const outcomes = this.reviewItems(pid, day, plan, true);
    const base = plan ?? this.newPlan(day);
    this.store(c, pid, { ...base, review: { at, auto: false, outcomes, ...(body.note ? { note: body.note } : {}), ...(body.mood ? { mood: body.mood } : {}) } });
    if (body.toJournal && (body.note || body.mood)) this.people.journal?.reviewEntry(pid, day, body.note, body.mood);
    this.people.herWrote(pid, 'review', 'plan');
    // His one push: no note text on any lock screen, dropped if review is off by now (C7).
    this.people.alerts?.reviewSent(pid, day);
    return OK;
  }

  /** The 12:00 close (the scheduler, `system`): an unsent review is stored with `auto` and no note. Nothing is pushed or counted. */
  closeReviews(pid: string): void {
    const c = this.core();
    if (!c) return;
    const today = c.today();
    for (let back = 7; back >= 1; back -= 1) {
      const day = shiftDay(today, -back);
      const plan = getPlan(c, pid, day);
      if (plan?.review) continue;
      if (!this.reviewable(pid, day)) continue;
      const outcomes = this.reviewItems(pid, day, plan, true);
      this.store(c, pid, { ...(plan ?? this.newPlan(day)), review: { at: this.iso(), auto: true, outcomes } });
      this.people.ticks.bump(pid, 'plan');
    }
  }

  /** Her Today's review card: from her review time until sent, or until 12:00 the next day ("Yesterday's review"). */
  reviewCard(pid: string): { day: string; line: string; done: number; open: number; yesterday: boolean } | null {
    const c = this.core();
    const p = this.people.person(pid);
    if (!c || !p) return null;
    const now = localNow(c);
    const candidates: { day: string; yesterday: boolean }[] = [];
    if (now.hhmm >= p.prefs.reviewAt) candidates.push({ day: now.day, yesterday: false });
    if (now.hhmm < REVIEW_CLOSE_AT) candidates.push({ day: shiftDay(now.day, -1), yesterday: true });
    for (const cand of candidates) {
      const plan = getPlan(c, pid, cand.day);
      if (plan?.review || !this.reviewable(pid, cand.day)) continue;
      const v = this.reviewView(pid, cand.day, 'full', { todos: true });
      const open = v.level === 'full' ? v.items.filter((i) => i.kind !== 'between' && i.outcome === undefined).length : 0;
      return { day: cand.day, line: `${v.counts.done} done · ${open} open`, done: v.counts.done, open, yesterday: cand.yesterday };
    }
    return null;
  }

  /** A todo of hers left the day it was due (moved on, or deleted): that day's review still lists it. */
  noteTodo(pid: string, day: string, note: { id: string; title: string; by: string; outcome: 'moved' | 'gone'; to?: string }): void {
    const c = this.core();
    if (!c || day > c.today()) return;
    const plan = getPlan(c, pid, day) ?? this.newPlan(day);
    if (plan.review) return;
    const notes = [...(plan.todoNotes ?? []).filter((n) => n.id !== note.id), { ...note, title: note.title.slice(0, 120) }].slice(-60);
    savePlan(c, pid, { ...plan, todoNotes: notes, updatedAt: this.iso() });
  }

  // ---------------------------------------------------------------------------
  // His writes (ownerOf: the agreement decides; paused holds them)

  private hisGate(pid: string, day: string | null, need: (a: Agreement) => boolean): { c: LifeCore; a: Agreement } | Refusal {
    const reach = this.people.ownerReach(pid);
    const a = this.people.agreement(pid);
    if ((reach !== 'active' && reach !== 'paused') || !a || !a.see.plan || !need(a)) return refuse('not_found', NO_PERSON);
    const c = this.core();
    if (!c) return refuse('unavailable', CLOSED);
    if (reach === 'paused') return refuse('conflict', PLAN_REASONS.paused(this.people.nameOf(pid)));
    if (day !== null && day === c.today() && getPlan(c, pid, day)?.rough) return refuse('conflict', PLAN_REASONS.rough(this.people.nameOf(pid)));
    return { c, a };
  }

  /**
   * His plan for a day (spec 4.3). Steps with an id he knows are updated
   * (his always, hers only with `editHers.plan`, else kept as they are);
   * steps without one are new and his; stored steps missing from the body
   * go if they are his (or hers with `editHers.plan`), else stay where they
   * were. Carried-away steps always stay (they are the day's history).
   */
  put(pid: string, day: string, body: PlanPutBody): LifeResult<PlanView> {
    const g = this.hisGate(pid, day, (a) => a.assign.plan);
    if ('ok' in g) return g;
    const { c, a } = g;
    const current = getPlan(c, pid, day);
    if (body.srev !== (current?.srev ?? 0)) return refuse('conflict', PLAN_REASONS.stale);
    for (const b of body.between) if (b.from >= b.to) return refuse('invalid_request', PLAN_REASONS.between);
    const plan = current ?? this.newPlan(day);
    const editHers = a.editHers.plan;
    const byId = new Map(plan.steps.map((s) => [s.id, s]));
    const seen = new Set<string>();
    const steps: PlanStep[] = [];
    const herEdits: { title: string; changes: ReturnType<typeof stepChanges> }[] = [];
    const hisEdits: { title: string; changes: ReturnType<typeof stepChanges> }[] = [];
    let added = 0;
    let edited = 0;
    const at = this.iso();
    for (const s of body.steps) {
      const ex = s.id ? byId.get(s.id) : undefined;
      if (ex && !seen.has(ex.id)) {
        seen.add(ex.id);
        if (ex.by === '') {
          const next = withPlanned(ex, plannedFields(s));
          const changes = stepChanges(ex, next);
          if (changes.length > 0) {
            hisEdits.push({ title: next.title, changes });
            edited += 1;
          }
          steps.push(next);
        } else if (editHers) {
          const next = withPlanned(ex, plannedFields(s));
          const changes = stepChanges(ex, next);
          if (changes.length > 0) {
            herEdits.push({ title: ex.title, changes });
            edited += 1;
            steps.push({ ...next, editedBy: '', editedAt: at });
          } else steps.push(ex);
        } else steps.push(ex);
        continue;
      }
      added += 1;
      steps.push({ id: shortId(), ...plannedFields(s), by: '', status: 'todo' });
    }
    const removed: PlanStep[] = [];
    plan.steps.forEach((ex, i) => {
      if (seen.has(ex.id)) return;
      if (ex.carriedTo || (ex.by !== '' && !editHers)) steps.splice(Math.min(i, steps.length), 0, ex);
      else removed.push(ex);
    });
    if (steps.filter((s) => !s.carriedTo).length > PLAN_STEPS_MAX) return refuse('conflict', PLAN_REASONS.full);
    const oldOrder = plan.steps.filter((s) => seen.has(s.id)).map((s) => s.id);
    const newOrder = steps.filter((s) => seen.has(s.id)).map((s) => s.id);
    const moved = oldOrder.filter((id, i) => newOrder[i] !== id).length;
    const betweenById = new Map(plan.between.map((b) => [b.id, b]));
    const between: Between[] = body.between.map((b) => {
      const ex = b.id ? betweenById.get(b.id) : undefined;
      const keep = ex && ex.every === b.every && ex.from === b.from && ex.to === b.to ? ex.ticks : [];
      return { id: ex?.id ?? shortId(), title: b.title, every: b.every, from: b.from, to: b.to, ticks: keep, by: ex?.by ?? '' };
    });
    const note = body.note === null ? undefined : (body.note ?? plan.note);
    const { note: _n, ...rest } = plan;
    const next: DayPlan = {
      ...rest,
      ...(note ? { note } : {}),
      steps,
      between,
      sentSteps: this.snapshot(plan, steps),
    };
    const saved = this.afterHisWrite(c, pid, plan, next, body.send, { added, removed: removed.length, moved, edited });
    this.recordHis(pid, day, current === null, { added, removed, moved, herEdits, hisEdits: current === null ? [] : hisEdits });
    // His answer carries her plan (her reports, check-ins, her own steps): a read like any other, so it leaves a view mark (spec 8.5).
    this.people.viewMark(pid, 'plan');
    return { ok: true, value: this.answer(c, day, saved) };
  }

  /** His save's answer: the plan as his view derives it, and when its push to her is lined up (if not sent yet). */
  private answer(c: LifeCore, day: string, saved: DayPlan): PlanView {
    const view = this.derive(day, saved);
    if (saved.sentAt) return view;
    const row = c.db.prepare("SELECT next_at FROM pings WHERE kind = 'plan_send' AND ref = ? AND sub = ''").get(saved.id) as { next_at: string | null } | undefined;
    return row?.next_at ? { ...view, sendsAt: row.next_at } : view;
  }

  /** His steps as sent: the union of earlier snapshots and this one (a step he removed then reads "gone"; her own deletes are hers). */
  private snapshot(plan: DayPlan, steps: readonly PlanStep[]): DayPlan['sentSteps'] {
    const map = new Map((plan.sentSteps ?? []).map((s) => [s.id, s]));
    for (const s of steps) if (s.by === '') map.set(s.id, { id: s.id, title: s.title, by: s.by });
    return [...map.values()].slice(-60);
  }

  /** Save his change, bump `srev`, and line up the push: the first one at her plan time, a change one coalesced over 2 minutes. */
  private afterHisWrite(c: LifeCore, pid: string, before: DayPlan, after: DayPlan, send: PlanPutBody['send'], change: { added: number; removed: number; moved: number; edited: number }): DayPlan {
    const at = this.iso();
    let next: DayPlan = { ...after, changedAt: at };
    if (before.sentAt) {
      const was = before.pending ?? { added: 0, removed: 0, moved: 0, edited: 0 };
      const pending = { added: was.added + change.added, removed: was.removed + change.removed, moved: was.moved + change.moved, edited: was.edited + change.edited };
      const any = pending.added + pending.removed + pending.moved + pending.edited > 0;
      // Her plan ack resets on a change she should see again.
      const { ackAt: _ack, ...rest } = next;
      next = any ? { ...rest, pending } : next;
    }
    const saved = this.store(c, pid, next, { structural: true });
    this.lineUpPush(c, pid, saved, send);
    this.people.hisWrote(pid, 'plan');
    return saved;
  }

  private lineUpPush(c: LifeCore, pid: string, plan: DayPlan, send: PlanPutBody['send']): void {
    const p = this.people.person(pid);
    if (!p || send === 'quiet') return;
    const today = c.today();
    const nowMs = c.now().getTime();
    if (plan.sentAt) {
      if (!plan.pending) return;
      const existing = c.db.prepare("SELECT next_at FROM pings WHERE kind = 'plan_send' AND ref = ? AND sub = ''").get(plan.id) as { next_at: string | null } | undefined;
      const at = nowMs + 2 * MIN_MS;
      if (existing?.next_at && Date.parse(existing.next_at) <= at) return;
      c.scheduler.set('plan_send', plan.id, '', new Date(at), pid);
    } else {
      if (plan.day < today) return;
      const pushAt = instantAt(plan.day, p.prefs.planPushAt, c.tz()).getTime();
      // A row due right now waits for the minute's sweep; one a second ahead arms the near timer ("sends at once").
      const soon = nowMs + 1_000;
      const when = send === 'now' ? soon : Math.max(soon, pushAt);
      c.scheduler.set('plan_send', plan.id, '', new Date(when), pid);
    }
    c.scheduler.poke();
  }

  private recordHis(
    pid: string,
    day: string,
    created: boolean,
    w: { added: number; removed: PlanStep[]; moved: number; herEdits: { title: string; changes: ReturnType<typeof stepChanges> }[]; hisEdits?: { title: string; changes: ReturnType<typeof stepChanges> }[] },
  ): void {
    const label = dayLabel(day);
    if (created) this.people.record(pid, { actor: 'owner', action: 'plan.set', area: 'plan', ref: day, title: `Plan for ${label}`, fields: [`${w.added} steps`] });
    else if (w.added + w.removed.length + w.moved > 0) {
      this.people.record(pid, { actor: 'owner', action: 'plan.changed', area: 'plan', ref: day, title: `Plan for ${label}`, fields: [`${w.added} added`, `${w.removed.length} removed`, `${w.moved} moved`] });
    }
    for (const r of w.removed) this.people.record(pid, { actor: 'owner', action: 'step.removed', area: 'plan', ref: day, title: r.title, ...(r.status === 'done' ? { fields: ['was done'] } : {}) });
    for (const e of w.herEdits) this.people.record(pid, { actor: 'owner', action: 'step.edited', area: 'plan', ref: day, title: e.title, changes: e.changes.slice(0, 12) });
    // His own steps' changes too ("Sam changed the time of 'Mock' 08:00 → 08:30"): every write into her space is on her record (spec 8.3).
    for (const e of w.hisEdits ?? []) this.people.record(pid, { actor: 'owner', action: 'step.edited', area: 'plan', ref: day, title: e.title, changes: e.changes.slice(0, 12) });
  }

  /** Remove his steps from a day (hers too with `editHers.plan`); the row stays while anything of hers or a review is left. */
  remove(pid: string, day: string): LifeResult {
    const g = this.hisGate(pid, day, (a) => a.assign.plan);
    if ('ok' in g) return g;
    const { c, a } = g;
    const plan = getPlan(c, pid, day);
    if (!plan) return refuse('not_found', PLAN_REASONS.noPlan);
    const keep = plan.steps.filter((s) => s.carriedTo || (s.by !== '' && !a.editHers.plan));
    const removed = plan.steps.filter((s) => !keep.includes(s));
    if (keep.length === 0 && !plan.review && !plan.rough && plan.between.every((b) => b.by !== '')) {
      deletePlan(c, pid, day);
      c.scheduler.clear('plan_step', plan.id);
      c.scheduler.clear('plan_send', plan.id);
      c.scheduler.clear('plan_followup', plan.id);
    } else {
      this.afterHisWrite(c, pid, plan, { ...plan, steps: keep, between: plan.between.filter((b) => b.by !== '') }, undefined, { added: 0, removed: removed.length, moved: 0, edited: 0 });
    }
    this.people.hisWrote(pid, 'plan');
    this.recordHis(pid, day, false, { added: 0, removed, moved: 0, herEdits: [] });
    return OK;
  }

  /** Apply a template (replace his open steps, or append). */
  apply(pid: string, day: string, body: PlanApplyBody, actor: 'owner' | 'system' = 'owner'): LifeResult<PlanView> {
    const g = this.hisGate(pid, day, (a) => a.assign.plan);
    if ('ok' in g) return g;
    const { c } = g;
    const t = getTemplate(c, pid, body.templateId);
    if (!t) return refuse('not_found', PLAN_REASONS.noTemplate);
    const current = getPlan(c, pid, day);
    if (body.srev !== (current?.srev ?? 0)) return refuse('conflict', PLAN_REASONS.stale);
    const plan = current ?? this.newPlan(day);
    const fromTemplate: PlanStep[] = t.steps.map((s) => ({ id: shortId(), ...plannedFields(s), by: '', status: 'todo' }));
    const kept = body.mode === 'replace' ? plan.steps.filter((s) => s.by !== '' || s.carriedTo || !isOpen(s)) : plan.steps;
    const steps = [...kept, ...fromTemplate];
    if (steps.filter((s) => !s.carriedTo).length > PLAN_STEPS_MAX) return refuse('conflict', PLAN_REASONS.full);
    const between = [...(body.mode === 'replace' ? plan.between.filter((b) => b.by !== '') : plan.between), ...t.between.map((b) => ({ ...b, id: shortId(), ticks: [], by: '' }))].slice(0, PLAN_BETWEEN_MAX);
    const removed = plan.steps.length - kept.length;
    const next: DayPlan = { ...plan, steps, between, templateId: t.id, templateName: t.name, ...(t.note && !plan.note ? { note: t.note } : {}), sentSteps: this.snapshot(plan, steps) };
    const saved = this.afterHisWrite(c, pid, plan, next, 'atPushTime', { added: fromTemplate.length, removed, moved: 0, edited: 0 });
    this.people.record(pid, { actor, action: 'template.applied', area: 'plan', ref: day, title: t.name });
    if (actor === 'owner') this.people.viewMark(pid, 'plan');
    return { ok: true, value: this.answer(c, day, saved) };
  }

  /** His carry from a sent review: his open steps (and hers with `editHers.plan`) move to a later day. */
  ownerCarry(pid: string, day: string, stepIds: readonly string[], to?: string): LifeResult {
    const g = this.hisGate(pid, null, (a) => a.assign.plan);
    if ('ok' in g) return g;
    const { c, a } = g;
    const plan = getPlan(c, pid, day);
    if (!plan) return refuse('not_found', PLAN_REASONS.noPlan);
    const target = to ?? (shiftDay(day, 1) >= c.today() ? shiftDay(day, 1) : c.today());
    if (target <= day || target < c.today()) return refuse('invalid_request', PLAN_REASONS.carryLater);
    if (target === c.today() && getPlan(c, pid, target)?.rough) return refuse('conflict', PLAN_REASONS.rough(this.people.nameOf(pid)));
    const steps = plan.steps.filter((s) => stepIds.includes(s.id) && isOpen(s) && (s.by === '' || a.editHers.plan));
    if (steps.length === 0) return refuse('not_found', PLAN_REASONS.noStep);
    this.carrySteps(c, pid, plan, steps, target);
    for (const s of steps) this.people.record(pid, { actor: 'owner', action: 'step.carried', area: 'plan', ref: day, title: s.title, fields: [`to ${target}`] });
    const t = getPlan(c, pid, target);
    if (t?.sentAt) this.afterHisWrite(c, pid, t, t, undefined, { added: steps.length, removed: 0, moved: 0, edited: 0 });
    else this.people.hisWrote(pid, 'plan');
    return OK;
  }

  // --- templates (his, in her space so forget takes them)

  templates(pid: string): LifeResult<{ templates: PlanTemplate[] }> {
    const reach = this.people.ownerReach(pid);
    const a = this.people.agreement(pid);
    const c = this.core();
    if ((reach !== 'active' && reach !== 'paused') || !a?.see.plan || !a.assign.plan) return refuse('not_found', NO_PERSON);
    if (!c) return refuse('unavailable', CLOSED);
    return { ok: true, value: { templates: listTemplates(c, pid) } };
  }

  templateCreate(pid: string, body: TemplateBody): LifeResult<{ id: string }> {
    const g = this.hisGate(pid, null, (a) => a.assign.plan);
    if ('ok' in g) return g;
    if (listTemplates(g.c, pid).length >= PLAN_TEMPLATES_MAX) return refuse('conflict', PLAN_REASONS.templatesFull);
    const at = this.iso();
    const t: PlanTemplate = {
      id: newId(),
      name: body.name,
      weekdays: [...new Set(body.weekdays ?? [])].sort(),
      ...(body.note ? { note: body.note } : {}),
      steps: body.steps.map((s) => plannedFields(s)),
      between: body.between ?? [],
      createdAt: at,
      updatedAt: at,
    };
    saveTemplate(g.c, pid, t);
    this.resyncPerson(pid);
    return { ok: true, value: { id: t.id } };
  }

  templateUpdate(pid: string, id: string, patch: TemplatePatch): LifeResult {
    const g = this.hisGate(pid, null, (a) => a.assign.plan);
    if ('ok' in g) return g;
    const t = getTemplate(g.c, pid, id);
    if (!t) return refuse('not_found', PLAN_REASONS.noTemplate);
    const next: PlanTemplate = {
      ...t,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.weekdays !== undefined ? { weekdays: [...new Set(patch.weekdays)].sort() } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.steps !== undefined ? { steps: patch.steps.map((s) => plannedFields(s)) } : {}),
      ...(patch.between !== undefined ? { between: patch.between } : {}),
      updatedAt: this.iso(),
    };
    saveTemplate(g.c, pid, next);
    this.resyncPerson(pid);
    return OK;
  }

  templateDelete(pid: string, id: string): LifeResult {
    const g = this.hisGate(pid, null, (a) => a.assign.plan);
    if ('ok' in g) return g;
    if (!deleteTemplate(g.c, pid, id)) return refuse('not_found', PLAN_REASONS.noTemplate);
    return OK;
  }

  /** 00:05 (the scheduler): with no plan today, the weekday's template is applied, and the push goes at her plan time. */
  autoApply(pid: string): void {
    const c = this.core();
    if (!c) return;
    const now = localNow(c);
    if (getPlan(c, pid, now.day)) return;
    const t = listTemplates(c, pid).find((x) => x.weekdays.includes(now.weekday));
    if (!t) return;
    const r = this.apply(pid, now.day, { templateId: t.id, mode: 'replace', srev: 0 }, 'system');
    if (!r.ok) return;
  }

  // ---------------------------------------------------------------------------
  // Rings (the scheduler's rows for her plan)

  /** Set this plan's rows: one per timed open step and per check-between slot still ahead; his follow-ups. */
  arm(pid: string, plan: DayPlan): void {
    const c = this.core();
    const p = this.people.person(pid);
    if (!c) return;
    c.scheduler.clear('plan_step', plan.id);
    c.scheduler.clear('plan_followup', plan.id);
    const nowMs = c.now().getTime();
    if (p && !plan.rough && plan.day >= c.today()) {
      for (const s of plan.steps) {
        if (s.at === undefined || !isOpen(s)) continue;
        const at = instantAt(plan.day, s.at, c.tz());
        if (s.status === 'todo' && s.ring && !s.mutedByHer && p.prefs.rings.steps && at.getTime() > nowMs) c.scheduler.set('plan_step', plan.id, s.id, at, pid);
      }
      for (const s of plan.steps) {
        if (s.followUp === undefined || s.by !== '' || !isOpen(s)) continue;
        const at = instantAt(plan.day, s.followUp, c.tz());
        if (at.getTime() > nowMs) c.scheduler.set('plan_followup', plan.id, s.id, at);
      }
      if (p.prefs.rings.between) {
        for (const b of plan.between) {
          for (const slot of slotsOf(b)) {
            if (b.ticks.some((t) => t.slot === slot && t.doneAt)) continue;
            const at = instantAt(plan.day, slot, c.tz());
            if (at.getTime() > nowMs) c.scheduler.set('plan_step', plan.id, `${b.id}@${slot}`, at, pid);
          }
        }
      }
    }
    c.scheduler.poke();
  }

  /** His follow-ups on todos he assigned her ("Tell me if not done by 13:00" on the due day). */
  armTodoFollowUps(pid: string): void {
    const c = this.core();
    const space = this.people.space;
    if (!c || !space) return;
    const open = space.herList(pid, { done: false });
    if (!open.ok) return;
    const nowMs = c.now().getTime();
    for (const t of open.value.todos) {
      if (t.by !== '' || !t.followUp || !t.due) {
        c.scheduler.clear('plan_followup', t.id);
        continue;
      }
      const at = instantAt(t.due.day, t.followUp, c.tz());
      if (at.getTime() > nowMs) c.scheduler.set('plan_followup', t.id, `todo:${pid}`, at);
      else c.scheduler.clear('plan_followup', t.id);
    }
    c.scheduler.poke();
  }

  /** Her daily rows (template apply at 00:05, review prompt at her review time, review close at 12:00) and every plan ahead's rings. */
  resyncPerson(pid: string): void {
    const c = this.core();
    if (!c) return;
    const g = this.people.gateState(pid);
    const p = this.people.person(pid);
    for (const kind of ['plan_autoapply', 'plan_review_prompt', 'plan_review_close'] as const) c.scheduler.clear(kind, pid);
    if ((g !== 'active' && g !== 'paused') || !p) return;
    const nextAt = (hhmm: string): Date => {
      const now = c.now();
      const today = c.today();
      const t = instantAt(today, hhmm, c.tz());
      return t.getTime() > now.getTime() ? t : instantAt(shiftDay(today, 1), hhmm, c.tz());
    };
    c.scheduler.set('plan_autoapply', pid, '', nextAt('00:05'), pid);
    c.scheduler.set('plan_review_prompt', pid, '', nextAt(p.prefs.reviewAt), pid);
    c.scheduler.set('plan_review_close', pid, '', nextAt(REVIEW_CLOSE_AT), pid);
    for (const plan of plansFrom(c, pid, c.today())) this.arm(pid, plan);
    this.armTodoFollowUps(pid);
  }

  /** Every person's rows (the scheduler's start, a zone change, a restore). */
  resync(): void {
    for (const pid of this.people.sharingPeople()) this.resyncPerson(pid);
  }

  /** Her plans and templates (her export). */
  exportRows(pid: string): { plans: DayPlan[]; templates: PlanTemplate[] } {
    const c = this.core();
    if (!c) return { plans: [], templates: [] };
    return { plans: allPlans(c, pid), templates: listTemplates(c, pid) };
  }

  /** The push text for a plan (first push or coalesced change), and its tag. */
  planPushText(pid: string, plan: DayPlan): { title: string; body: string } {
    const c = this.core();
    const today = c?.today() ?? plan.day;
    const when = plan.day === today ? 'today' : dayLabel(plan.day);
    const n = plan.steps.filter((s) => !s.carriedTo).length;
    const owner = this.people.ownerName();
    if (!plan.sentAt || !plan.pending) return { title: `From ${owner}`, body: `Your plan for ${when}: ${n} step${n === 1 ? '' : 's'}.` };
    const p = plan.pending;
    const parts = [
      p.moved ? `${p.moved} step${p.moved === 1 ? '' : 's'} moved` : '',
      p.added ? `${p.added} added` : '',
      p.removed ? `${p.removed} removed` : '',
      p.edited ? `${p.edited} changed` : '',
    ].filter(Boolean);
    return { title: `From ${owner}`, body: `${owner} changed ${when === 'today' ? "today's" : `${when}'s`} plan${parts.length ? `: ${parts.join(', ')}` : ''}.` };
  }

  /** One line for a step's or slot's ring. */
  ringTitle(plan: DayPlan, sub: string): string | null {
    const [id, slot] = sub.split('@') as [string, string | undefined];
    if (slot !== undefined) {
      const b = plan.between.find((x) => x.id === id);
      return b && !b.ticks.some((t) => t.slot === slot && t.doneAt) ? clipLine(b.title, 60) : null;
    }
    const s = plan.steps.find((x) => x.id === id);
    return s && s.status === 'todo' && !s.carriedTo && s.ring && !s.mutedByHer ? clipLine(s.title, 60) : null;
  }
}
