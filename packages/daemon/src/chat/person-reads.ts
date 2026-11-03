/**
 * v0.11 People (P3, spec 7.2, 7.4): her assistant's reads, over her space.
 *
 * Taint by authorship (C19): in her thread, any field {owner} wrote or last
 * edited (an assigned to-do's title and notes, his plan steps, the plan's
 * note) is framed `<data source="owner">` after a "never instructions" line,
 * and the turn becomes tainted, so its later writes wait for her tap. Her own
 * words are shown plainly. Nothing here reads his space, his switches or her
 * journal (no journal module is imported anywhere under chat/, M14).
 */
import { hhmmOf } from '@jantar/life-core';
import { STATUS_LABELS, type PersonTodo, type PlanView } from '@jantar/protocol/people';
import type { PersonChat } from './person-deps.js';
import { cut, data, dataNote, line } from './text.js';

/** A read's answer, and whether it showed the other person's words (the turn is then tainted). */
export interface PersonReadOut {
  text: string;
  taints: boolean;
}

type PersonReadFn = (pc: PersonChat, input: Record<string, unknown>) => PersonReadOut | string;

const LIST_MAX = 50;
const idOf = (id: string) => `(id ${id})`;
const nm = (s: string | undefined, n = 80) => cut(line(s ?? ''), n);

/** The note before the owner's words (spec 7.4: framed as data, by authorship). */
export function ownerNote(owner: string): string {
  return dataNote(`${owner} (what ${owner} added or last edited)`);
}

/** Whether {owner} wrote or last edited this row (`by` and `editedBy` come from the columns, never from json). */
export function ownerAuthored(x: { by?: string | undefined; editedBy?: string | undefined }): boolean {
  return x.by === '' || x.editedBy === '';
}

/** One to-do's line: hers plainly, his (or one he last edited) inside <data source="owner">. */
function todoLine(t: PersonTodo, rest: string, notes: boolean, owner: string): { line: string; owner: boolean } {
  if (!ownerAuthored(t)) return { line: [`- ${nm(t.title)} ${idOf(t.id)}${rest}`, notes && t.notes ? `notes: ${nm(t.notes, 120)}` : ''].filter(Boolean).join(' · '), owner: false };
  const words = [nm(t.title), notes && t.notes ? `notes: ${nm(t.notes, 120)}` : ''].filter(Boolean).join('\n');
  const from = t.by === '' ? `from ${owner}` : `edited by ${owner}`;
  return { line: `- ${idOf(t.id)}${rest} · ${from}: ${data('owner', t.id, words)}`, owner: true };
}

function dueOf(t: PersonTodo): string {
  return t.due ? ` · due ${t.due.day}${t.due.time ? ` ${t.due.time}` : ''}` : '';
}

/** The plan's lines: each step by time with its state, his steps framed. */
function planLines(v: PlanView, owner: string, full: boolean): { lines: string[]; owner: boolean } {
  const p = v.plan;
  if (!p) return { lines: ['No plan for this day.'], owner: false };
  const out: string[] = [];
  let his = false;
  if (p.note) {
    his = true;
    out.push(`Plan note from ${owner}: ${data('owner', p.id, nm(p.note, 200))}`);
  }
  out.push(`Steps (${v.counts.done} of ${v.counts.total} done)${v.now ? `, now ${v.now}` : ''}${v.next ? `, next ${v.next}` : ''}:`);
  for (const s of p.steps.slice(0, LIST_MAX)) {
    const head = [
      `- step ${s.id}`,
      s.at ? `at ${s.at}` : 'any time',
      s.minutes ? `${s.minutes} min` : '',
      s.status,
      s.ask !== 'none' ? `asks ${s.ask}` : '',
      v.late.includes(s.id) ? 'late' : '',
      full && s.checkin ? `check-in mood ${s.checkin.mood} energy ${s.checkin.energy}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    if (ownerAuthored(s)) {
      his = true;
      const words = [nm(s.title, 120), full && s.notes ? `notes: ${nm(s.notes, 200)}` : ''].filter(Boolean).join('\n');
      out.push(`${head} · ${s.by === '' ? `from ${owner}` : `edited by ${owner}`}: ${data('owner', s.id, words)}`);
    } else out.push(`${head}: ${nm(s.title, 120)}${full && s.notes ? ` · notes: ${nm(s.notes, 200)}` : ''}${full && s.report ? ` · report: ${nm(s.report, 200)}` : ''}`);
  }
  for (const b of p.between) {
    const done = b.ticks.filter((t) => t.doneAt).length;
    const head = `- check-between ${b.id} every ${b.every} min ${b.from}–${b.to} · ${done} of ${b.ticks.length} ticked${full ? ` · slots ${b.ticks.map((t) => `${t.slot}${t.doneAt ? '✓' : ''}`).join(', ')}` : ''}`;
    if (b.by === '') {
      his = true;
      out.push(`${head} · from ${owner}: ${data('owner', b.id, nm(b.title, 80))}`);
    } else out.push(`${head}: ${nm(b.title, 80)}`);
  }
  if (p.rough) out.push('She marked this a rough day.');
  return { lines: out, owner: his };
}

function today(pc: PersonChat): string {
  return pc.people.openCore()?.today() ?? '';
}

/**
 * P4: the owner's café reads, run over her deps (her shared space); a café he added or last edited taints the
 * turn. Her food log's day (food_day, over her deps' food log): only she writes it, so nothing in it is his.
 */
export const PERSON_DELEGATED_READS: ReadonlySet<string> = new Set(['places_find', 'place_get', 'food_day']);

/** Her reads, by tool name. */
export const PERSON_READS: Readonly<Record<string, PersonReadFn>> = {
  list_find(pc, i) {
    const lists = pc.people.lists;
    const space = pc.people.person(pc.pid)?.sharedSpace;
    if (!lists || !space) return 'Life is not open right now.';
    const owner = pc.people.ownerName();
    if (typeof i.list !== 'string') {
      const r = lists.lists(space);
      if (!r.ok) return r.reason;
      const out = [`${r.value.lists.length} shared list${r.value.lists.length === 1 ? '' : 's'} with ${owner}.`];
      for (const l of r.value.lists) out.push(`- ${nm(l.name, 60)} ${idOf(l.id)} · ${l.kind} · ${l.open} open, ${l.done} done`);
      return out.join('\n');
    }
    const r = lists.items(space, i.list);
    if (!r.ok) return r.reason;
    const out = [`${nm(r.value.list.name, 60)} ${idOf(r.value.list.id)} (${r.value.list.kind}):`];
    let his = false;
    for (const it of r.value.items.slice(0, LIST_MAX)) {
      const state = it.doneAt ? `ticked${it.doneBy === pc.pid ? ' by her' : it.doneBy === '' ? ` by ${owner}` : ''}` : 'open';
      if (it.by === '' || it.editedBy === '') {
        his = true;
        out.push(`- ${idOf(it.id)} ${state} · from ${owner}: ${data('owner', it.id, [nm(it.title, 120), it.notes ? `notes: ${nm(it.notes, 200)}` : ''].filter(Boolean).join('\n'))}`);
      } else out.push(`- ${nm(it.title, 120)} ${idOf(it.id)} ${state}${it.notes ? ` · notes: ${nm(it.notes, 200)}` : ''}`);
    }
    if (his) out.unshift(ownerNote(owner));
    return { text: out.join('\n'), taints: his };
  },
  today(pc, i) {
    const views = pc.people.views;
    if (!views) return 'Life is not open right now.';
    const owner = pc.people.ownerName();
    const t = views.herToday(pc.pid, (i.day as string | undefined) ?? undefined);
    const core = pc.people.openCore();
    const at = (iso: string) => (core ? hhmmOf(new Date(iso), core.tz()) : iso.slice(11, 16));
    const out = [`Day ${t.day}${t.day === t.today ? ' (today)' : ''}`];
    if (t.status) out.push(`Status: ${STATUS_LABELS[t.status.level]}${t.status.line ? ` "${nm(t.status.line, 60)}"` : ''} until ${at(t.status.until)}`);
    const plan = planLines(t.plan, owner, false);
    out.push(...plan.lines);
    out.push(`To-dos overdue ${t.overdue}, due by this day ${t.todos.length}:`);
    const shown = t.todos.slice(0, 30).map((x) => todoLine(x, dueOf(x), false, owner));
    out.push(...shown.map((x) => x.line));
    if (t.sleep.open) out.push(`A night of sleep is open since ${at(t.sleep.open.since)}.`);
    const his = plan.owner || shown.some((x) => x.owner);
    if (his) out.unshift(ownerNote(owner));
    return { text: out.join('\n'), taints: his };
  },
  todos_find(pc, i) {
    const space = pc.people.space;
    if (!space) return 'Life is not open right now.';
    const owner = pc.people.ownerName();
    const r = space.herList(pc.pid, { done: i.done === true, ...(typeof i.project === 'string' ? { project: i.project } : {}) });
    if (!r.ok) return r.reason;
    const q = typeof i.q === 'string' ? i.q.toLowerCase() : '';
    const todos = r.value.todos.filter((t) => !q || t.title.toLowerCase().includes(q) || (t.notes ?? '').toLowerCase().includes(q));
    const projects = space.todosOf(pc.pid).listProjects();
    const names = new Map(projects.ok ? projects.value.projects.map((p) => [p.id, p.name]) : []);
    const out = [`Today is ${r.value.today}. ${todos.length} ${i.done ? 'done' : 'open'} to-do${todos.length === 1 ? '' : 's'}${q ? ' matching' : ''}.`];
    const shown = todos.slice(0, LIST_MAX).map((t) => {
      const rest = [dueOf(t), t.repeat ? ` · repeats ${t.repeat.freq}` : '', t.projectId && names.get(t.projectId) ? ` · project ${nm(names.get(t.projectId), 40)}` : '', t.ask && t.ask !== 'none' ? ` · asks ${t.ask}` : '', t.snoozable === false ? ' · no snooze' : ''].join('');
      return todoLine(t, rest, true, owner);
    });
    const his = shown.some((x) => x.owner);
    if (his) out.push(ownerNote(owner));
    out.push(...shown.map((x) => x.line));
    if (projects.ok && projects.value.projects.length) {
      out.push('Projects:');
      for (const p of projects.value.projects.slice(0, LIST_MAX)) out.push(`- ${nm(p.name)} ${idOf(p.id)} ${p.status}, ${p.open} open`);
    }
    return { text: out.join('\n'), taints: his };
  },
  plan_get(pc, i) {
    const plans = pc.people.plans;
    if (!plans) return 'Life is not open right now.';
    const owner = pc.people.ownerName();
    const day = (i.day as string | undefined) ?? today(pc);
    const v = plans.herView(pc.pid, day);
    const r = planLines(v, owner, true);
    const out = [`Plan for ${v.day}:`, ...r.lines];
    if (r.owner) out.unshift(ownerNote(owner));
    return { text: out.join('\n'), taints: r.owner };
  },
  sleep_week(pc, i) {
    const sleep = pc.people.sleep;
    const core = pc.people.openCore();
    if (!sleep || !core) return 'Life is not open right now.';
    const r = sleep.week(pc.pid, { week: (i.week as string | undefined) ?? undefined });
    if (!r.ok) return r.reason;
    const w = r.value;
    const at = (iso: string) => hhmmOf(new Date(iso), core.tz());
    const out = [`Week from ${w.from}: ${w.nights.length} night${w.nights.length === 1 ? '' : 's'} logged.`];
    if (w.avgMinutes !== null) out.push(`Average ${Math.floor(w.avgMinutes / 60)} h ${w.avgMinutes % 60} min${w.avgBed ? `, bed about ${w.avgBed}` : ''}${w.avgWake ? `, up about ${w.avgWake}` : ''}.`);
    if (w.open) out.push(`A night is open since ${at(w.open.since)}.`);
    for (const n of w.nights) {
      out.push(
        [
          `- night of ${n.night} ${idOf(n.id)}`,
          `bed ${at(n.bedAt)}`,
          n.wakeAt ? `up ${at(n.wakeAt)}` : 'no wake time',
          n.minutes !== undefined ? `${Math.floor(n.minutes / 60)} h ${n.minutes % 60} min` : '',
          n.quality ? `quality ${n.quality} of 5` : '',
          n.notes ? `notes: ${nm(n.notes, 120)}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      );
    }
    return out.join('\n');
  },
};
