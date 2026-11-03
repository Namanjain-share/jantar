/**
 * v0.11 People (P2): the scheduler's People kinds (contracts.ts
 * PeoplePingKind). Every handler runs as the scheduler, the `system`
 * reader (C4): it reads any person space by row id, and each row's
 * `person` says whose devices ring ('' his).
 *
 * - `plan_step`: a timed step or a check-between slot rings her devices
 *   (`standard`: dropped in her quiet hours, focus, an open night, a mute
 *   or a pause, and never rung later). Rings due in the same minute merge.
 * - `plan_send`: the plan push at her plan time, or his changes coalesced
 *   over 2 minutes (`important`: held while she holds, then sent). Skipped
 *   when the first step rings within 15 minutes: that ring carries "Today's
 *   plan: N steps".
 * - `plan_followup`: "Tell me if not done by" reaches him once, after
 *   checking the agreement again when it fires (C7). A skip (his quiet
 *   hours) looks again every 15 minutes until the day ends; a sent one is
 *   done. Never sent to her.
 * - `plan_rough`: her rough day reaches him 10 s after her tap, unless she
 *   undid it (C35).
 * - `plan_autoapply` (00:05), `plan_review_prompt` (her review time),
 *   `plan_review_close` (12:00): her daily rows.
 * - `alert_release`: the end of a hold; one summary push.
 * - `sleep_close`: an open night closes 20 h after bedtime, with no time
 *   invented.
 * - `owner_summary`: his opt-in day summary (Q16).
 */
import { PEOPLE_LABEL } from '@jantar/protocol/people-core';
import { dayKeyOf, hhmmOf, instantAt, resolveDelivery, shiftDay } from '@jantar/life-core';
import type { LifeCore, LifePush, PingHandler, PingRow } from '../../contracts.js';
import type { AlertsModule } from '../alerts/module.js';
import { planById, savePlan } from '../plans/repo.js';
import type { PlansModule } from '../plans/module.js';
import type { SleepModule } from '../sleep/module.js';
import type { PeopleModule } from './module.js';
import { HOUR_MS, clipLine } from './kit.js';

const RECHECK_MS = 15 * 60_000;

export interface PeoplePingDeps {
  core: LifeCore;
  people: PeopleModule;
  plans: PlansModule;
  alerts: AlertsModule;
  sleep: SleepModule;
}

/** The next `hhmm` strictly after `after`, in the Life zone. */
function nextDaily(core: LifeCore, hhmm: string, after: Date): Date {
  const day = dayKeyOf(after, core.tz());
  const t = instantAt(day, hhmm, core.tz());
  return t.getTime() > after.getTime() ? t : instantAt(shiftDay(day, 1), hhmm, core.tz());
}

function sharing(people: PeopleModule, pid: string): boolean {
  const g = people.gateState(pid);
  return g === 'active' || g === 'paused';
}

export function peoplePingHandlers(d: PeoplePingDeps): PingHandler[] {
  const { core, people, plans, alerts } = d;
  const tz = () => core.tz();

  const planStep: PingHandler = {
    kind: 'plan_step',
    group: (row) => row.person ?? '',
    check(row, _dueAt, late) {
      // A late ring is noise (spec 3.6): it moves on unsent.
      if (late) return 'skip';
      const hit = planById(core, row.ref);
      if (!hit || hit.plan.rough || !sharing(people, hit.space)) return 'cancel';
      if (plans.ringTitle(hit.plan, row.sub) === null) return 'cancel';
      return resolveDelivery('standard', alerts.herState(hit.space)).action === 'push' ? 'send' : 'skip';
    },
    push(rows, dueAt) {
      const titles: string[] = [];
      let pid = rows[0]?.person ?? '';
      let first: string | null = null;
      let note = '';
      // Merged rings read in plan order: steps first, then check-betweens (the rows come in id order).
      const order = (row: PingRow): number => {
        const hit = planById(core, row.ref);
        if (!hit) return Number.MAX_SAFE_INTEGER;
        const [id] = row.sub.split('@');
        const i = hit.plan.steps.findIndex((s) => s.id === id);
        return i >= 0 ? i : 1000 + hit.plan.between.findIndex((b) => b.id === id);
      };
      for (const row of [...rows].sort((a, b) => order(a) - order(b))) {
        const hit = planById(core, row.ref);
        if (!hit) continue;
        pid = hit.space;
        const t = plans.ringTitle(hit.plan, row.sub);
        if (t) titles.push(t);
        if (first === null && !row.sub.includes('@')) first = row.sub;
        if (hit.plan.firstRingNote) {
          const n = hit.plan.steps.filter((s) => !s.carriedTo).length;
          note = ` · Today's plan: ${n} step${n === 1 ? '' : 's'}.`;
          const { firstRingNote: _f, ...rest } = hit.plan;
          savePlan(core, hit.space, rest);
        }
      }
      return { kind: 'life', title: 'Plan', body: `${hhmmOf(dueAt, tz())} · ${titles.join(' + ')}${note}`, url: first ? `/p?step=${first}` : '/p', tag: `people:plan:${pid}:ring`, person: pid };
    },
    next: () => null,
    resync: () => plans.resync(),
  };

  const planSend: PingHandler = {
    kind: 'plan_send',
    check(row) {
      const hit = planById(core, row.ref);
      if (!hit || !sharing(people, hit.space)) return 'cancel';
      const { plan, space: pid } = hit;
      const p = people.person(pid);
      if (!p) return 'cancel';
      const needs = !plan.sentAt || plan.pending !== undefined;
      if (!needs) return 'cancel';
      if (plan.sentAt && plan.pending && !p.prefs.rings.planChanges) {
        const { pending: _p, ...rest } = plan;
        savePlan(core, pid, rest);
        return 'cancel';
      }
      if (resolveDelivery('important', alerts.herState(pid)).action !== 'push') return 'skip';
      if (!plan.sentAt && plan.day === core.today()) {
        // No double start: a first step ringing within 15 minutes carries the plan instead.
        const now = core.now().getTime();
        const soon = plan.steps.some((s) => {
          if (s.at === undefined || s.status !== 'todo' || s.carriedTo || !s.ring || s.mutedByHer) return false;
          const at = instantAt(plan.day, s.at, tz()).getTime();
          return at >= now && at - now <= 15 * 60_000;
        });
        if (soon) {
          savePlan(core, pid, { ...plan, sentAt: core.now().toISOString(), firstRingNote: true });
          return 'cancel';
        }
      }
      return 'send';
    },
    push(rows) {
      const hit = planById(core, rows[0]?.ref ?? '');
      if (!hit) return { kind: 'life', title: PEOPLE_LABEL, body: 'Your plan changed.', url: '/p', tag: 'people:plan', person: rows[0]?.person ?? '' };
      const { plan, space: pid } = hit;
      const text = plans.planPushText(pid, plan);
      const { pending: _p, ...rest } = plan;
      savePlan(core, pid, { ...rest, sentAt: plan.sentAt ?? core.now().toISOString() });
      people.ticks.bump(pid, 'plan');
      return { kind: 'life', title: text.title, body: text.body, url: `/p?day=${plan.day}`, tag: `people:plan:${pid}:${plan.day}`, person: pid, urgency: 'normal' };
    },
    next(row, after) {
      const hit = planById(core, row.ref);
      if (!hit || (hit.plan.sentAt && !hit.plan.pending)) return null;
      return new Date(after.getTime() + RECHECK_MS);
    },
    resync() {
      /* rows live in the pings table and survive a restart; a restore's skipDue moves the due ones on */
    },
  };

  /** A follow-up's source: a step of his in her plan (`sub` its id), or an assigned todo (`sub` `todo:<pid>`). */
  const followUpItem = (row: PingRow): { pid: string; title: string; day: string; area: 'plan' | 'todos'; at: string } | null => {
    if (row.sub.startsWith('todo:')) {
      const pid = row.sub.slice(5);
      const t = people.space?.findTodo(pid, row.ref);
      if (!t || t.doneAt || t.by !== '' || !t.followUp || !t.due) return null;
      return { pid, title: t.title, day: t.due.day, area: 'todos', at: t.followUp };
    }
    const hit = planById(core, row.ref);
    const s = hit?.plan.steps.find((x) => x.id === row.sub);
    if (!hit || !s || s.by !== '' || !s.followUp || !(s.status === 'todo' || s.status === 'doing') || s.carriedTo) return null;
    return { pid: hit.space, title: s.title, day: hit.plan.day, area: 'plan', at: s.followUp };
  };

  const planFollowup: PingHandler = {
    kind: 'plan_followup',
    check(row) {
      const item = followUpItem(row);
      if (!item || !sharing(people, item.pid)) return 'cancel';
      // C7: the agreement is checked again when it fires.
      const a = people.agreement(item.pid);
      if (!a || !(item.area === 'plan' ? a.see.plan : a.see.todos)) return 'cancel';
      return resolveDelivery('important', alerts.ownerState()).action === 'push' ? 'send' : 'skip';
    },
    push(rows) {
      const row = rows[0] as PingRow;
      const item = followUpItem(row);
      const pid = item?.pid ?? '';
      const name = people.nameOf(pid);
      const details = core.settings().lockScreenDetails === true;
      const body = item && details ? `${name}: "${clipLine(item.title, 60)}" isn't done yet (${item.at}).` : `${name}: an item isn't done yet.`;
      return { kind: 'life', title: PEOPLE_LABEL, body, url: `/people/${pid}?tab=${item?.area === 'todos' ? 'todos' : 'today'}${item ? `&day=${item.day}` : ''}`, tag: `people:followup:${row.ref}` };
    },
    next(row, after, sent) {
      // One push at that time (spec 4.4): once it went out, the row ends. Only a skip (his quiet hours) looks again.
      if (sent) return null;
      const item = followUpItem(row);
      if (!item) return null;
      const end = instantAt(shiftDay(item.day, 1), '00:00', tz()).getTime();
      const at = after.getTime() + RECHECK_MS;
      return at < end ? new Date(at) : null;
    },
    resync() {
      for (const pid of people.sharingPeople()) plans.armTodoFollowUps(pid);
    },
  };

  const planRough: PingHandler = {
    kind: 'plan_rough',
    check(row) {
      const hit = planById(core, row.ref);
      if (!hit?.plan.rough || !sharing(people, hit.space)) return 'cancel';
      if (!people.agreement(hit.space)?.see.plan) return 'cancel';
      return resolveDelivery('important', alerts.ownerState()).action === 'push' ? 'send' : 'skip';
    },
    push(rows) {
      const hit = planById(core, rows[0]?.ref ?? '');
      const pid = hit?.space ?? '';
      const name = people.nameOf(pid);
      return { kind: 'life', title: PEOPLE_LABEL, body: `${name} marked today a rough day.`, url: `/people/${pid}?tab=today`, tag: `people:rough:${pid}` };
    },
    next(row, after) {
      const hit = planById(core, row.ref);
      if (!hit?.plan.rough || hit.plan.day !== core.today()) return null;
      return new Date(after.getTime() + RECHECK_MS);
    },
    resync() {
      /* one-shot rows; a restart keeps them */
    },
  };

  const daily = (kind: 'plan_autoapply' | 'plan_review_prompt' | 'plan_review_close', at: (pid: string) => string | null, run: (pid: string, late: boolean) => 'send' | 'skip'): PingHandler => ({
    kind,
    check(row, _dueAt, late) {
      if (!sharing(people, row.ref)) return 'cancel';
      return run(row.ref, late);
    },
    push(rows) {
      const pid = rows[0]?.ref ?? '';
      const card = plans.reviewCard(pid);
      return { kind: 'life', title: 'Evening review', body: `How did today go?${card ? ` ${card.line}` : ''}`, url: '/p?review=1', tag: `people:plan:${pid}:review`, person: pid };
    },
    next(row, after) {
      const hhmm = at(row.ref);
      return hhmm ? nextDaily(core, hhmm, after) : null;
    },
    resync() {
      /* plans.resyncPerson sets every daily row (plan_step's resync runs it for everyone) */
    },
  });

  const autoApply = daily(
    'plan_autoapply',
    () => '00:05',
    (pid) => {
      if (people.gateState(pid) === 'active') plans.autoApply(pid);
      return 'skip';
    },
  );
  const reviewPrompt = daily(
    'plan_review_prompt',
    (pid) => people.person(pid)?.prefs.reviewAt ?? null,
    (pid, late) => {
      if (late) return 'skip';
      const today = core.today();
      const v = plans.reviewView(pid, today, 'counts', { todos: true });
      if (v.sent || !plans.reviewable(pid, today)) return 'skip';
      return resolveDelivery('standard', alerts.herState(pid)).action === 'push' ? 'send' : 'skip';
    },
  );
  const reviewClose = daily(
    'plan_review_close',
    () => '12:00',
    (pid) => {
      plans.closeReviews(pid);
      return 'skip';
    },
  );

  const release: PingHandler = {
    kind: 'alert_release',
    check(row) {
      // The release clears this row, or sets it again at the hold's new end (a producer's set wins over 'cancel').
      alerts.release(row.ref);
      return 'cancel';
    },
    push(): LifePush {
      return { kind: 'life', title: PEOPLE_LABEL, body: '', url: '/p', tag: 'people:release' };
    },
    next: () => null,
    resync() {
      for (const pid of people.sharingPeople()) alerts.release(pid);
      alerts.release('');
    },
  };

  const sleepClose: PingHandler = {
    kind: 'sleep_close',
    check(row) {
      d.sleep.closeOpen(row.ref);
      return 'cancel';
    },
    push(): LifePush {
      return { kind: 'life', title: PEOPLE_LABEL, body: '', url: '/p', tag: 'people:sleep' };
    },
    next: () => null,
    resync() {
      for (const pid of people.sharingPeople()) {
        const open = d.sleep.openNight(pid);
        if (open) core.scheduler.set('sleep_close', pid, '', new Date(Date.parse(open.bedAt) + 20 * HOUR_MS), pid);
      }
    },
  };

  const summary: PingHandler = {
    kind: 'owner_summary',
    check(_row, _dueAt, late) {
      if (late || !people.ownerPrefs().summaryAt) return late ? 'skip' : 'cancel';
      if (alerts.summaryText() === null) return 'skip';
      return resolveDelivery('important', alerts.ownerState()).action === 'push' ? 'send' : 'skip';
    },
    push() {
      return { kind: 'life', title: PEOPLE_LABEL, body: alerts.summaryText() ?? '', url: '/people', tag: 'people:summary' };
    },
    next(_row, after) {
      const at = people.ownerPrefs().summaryAt;
      return at ? nextDaily(core, at, after) : null;
    },
    resync: () => alerts.resyncOwner(),
  };

  return [planStep, planSend, planFollowup, planRough, autoApply, reviewPrompt, reviewClose, release, sleepClose, summary];
}
