/**
 * v0.11 People: Activity in plain words (spec 8.3), for both sides: her Me ›
 * Activity reads it as "Sam looked at your Today" and his Partner › Activity
 * as "You looked at Asha's Today" (spec 8.3 "Who sees it: both"). Rows come
 * from one table; only the voice differs. A code this build doesn't know
 * reads as "… changed something", never as the raw code.
 *
 * His views of an area are grouped per day ("6 times · last 18:40", C28),
 * under day headers on the device's clock.
 */
import { ALERT_KINDS, type AlertKind } from '@jantar/protocol/people-core';
import type { PersonActivity } from '@jantar/protocol/people';
import { dayLabel } from './time.js';

/** Who reads the row: her ("Sam …, your …") or him ("You …, Asha's …"). */
export interface ActivityVoice {
  /** The owner as the subject: "Sam", or "You" for him. */
  owner: string;
  /** Her as the subject: "You" for her, or "Asha". */
  she: string;
  /** Her possessive: "your", or "Asha's". */
  her: string;
  /** Her as the object: "you", or "Asha". */
  obj: string;
  /** True on her side ("you share"), false on his ("they share"). */
  self: boolean;
}

export const herVoice = (owner: string): ActivityVoice => ({ owner, she: 'You', her: 'your', obj: 'you', self: true });
export const hisVoice = (name: string): ActivityVoice => ({ owner: 'You', she: name, her: `${name}'s`, obj: name, self: false });

/** An area's name as the app says it ("your Today", "Asha's plan"). */
const AREA_WORDS: Record<string, string> = {
  today: 'Today',
  todos: 'to-dos',
  meds: 'medicines',
  weight: 'weight',
  food: 'food log',
  plan: 'plan',
  review: 'evening review',
  sleep: 'sleep',
  journal: 'journal',
  chat: 'chat',
};
const areaWords = (v: ActivityVoice, a: string | undefined) => `${v.her} ${a ? (AREA_WORDS[a] ?? a) : 'space'}`;
const dayOf = (ref: string | undefined) => (ref && /^\d{4}-\d{2}-\d{2}$/.test(ref) ? dayLabel(ref) : null);
const quoted = (t: string | undefined) => (t ? `: ${t}` : '');
/** A daemon title written to her ("your entry of Thu 5 Nov"), in this voice. */
const voiced = (v: ActivityVoice, t: string) => (v.self ? t : t.replace(/^your /, `${v.her} `));
const FIELD_WORDS: Record<string, string> = {
  at: 'the time',
  title: 'the name',
  name: 'the name',
  minutes: 'the length',
  ask: 'what it asks',
  notes: 'the notes',
  due: 'the due day',
  followUp: '"Tell me if not done by"',
  focus: 'focus',
  ring: 'the ring',
  kg: 'the weight',
  chatPerDay: 'messages a day',
  dose: 'the dose',
  times: 'the times',
  schedule: 'the days',
  pills: 'the pill count',
  repeat: 'the repeat',
};

/** "changed the time of 'Mock' 08:00 → 08:30" (the first change named; more as "and 2 more"). */
function changeWords(r: PersonActivity): string {
  const c = r.changes ?? [];
  const first = c[0];
  const what = first ? `${FIELD_WORDS[first.field] ?? first.field} of "${r.title ?? 'a step'}"${first.from !== undefined || first.to !== undefined ? ` ${first.from ?? '–'} → ${first.to ?? '–'}` : ''}` : `"${r.title ?? 'a step'}"`;
  return `${what}${c.length > 1 ? ` and ${c.length - 1} more` : ''}`;
}

const ACTION_WORDS: Record<string, (v: ActivityVoice, r: PersonActivity) => string> = {
  joined: (v) => `${v.she} joined`,
  view: (v, r) => `${v.owner} looked at ${areaWords(v, r.area ?? r.ref)}`,
  paused: (v) => `${v.she} paused`,
  resumed: (v) => `${v.she} resumed`,
  left: (v) => `${v.she} left`,
  ending: (v) => `${v.owner} ended sharing`,
  restore: (v) => `${v.owner} restored Life data from a backup. Changes after it may be missing.`,
  'agreement.narrowed': (v) => `${v.she} changed what ${v.self ? 'you share' : 'they share'}`,
  'agreement.proposed': (v) => `${v.owner} asked to see more`,
  'agreement.accepted': (v) => `${v.she} said yes to a request`,
  'agreement.declined': (v) => `${v.she} said no to a request`,
  'device.linked': (v, r) => `${v.she} linked ${r.device ?? 'a device'}`,
  'device.revoked': (v, r) => `${r.actor === 'owner' ? v.owner : v.she} revoked ${r.device ?? 'a device'}`,
  // C27: one of his devices can now open her space (paired with control, or raised to it).
  'owner.device': (v, r) => `${v.owner} added a device that can open ${v.her} space${quoted(r.device)}`,
  'module.changed': (v) => `${v.owner} changed ${v.her} modules`,
  'todo.added': (v, r) => `${v.owner} added a to-do${quoted(r.title)}`,
  'todo.edited': (v, r) => (r.changes?.length ? `${v.owner} changed ${changeWords(r)}` : `${v.owner} changed a to-do${quoted(r.title)}`),
  'todo.deleted': (v, r) => `${v.owner} removed a to-do${quoted(r.title)}`,
  'plan.set': (v, r) => `${v.owner} planned ${dayOf(r.ref) ?? 'a day'}`,
  'plan.changed': (v, r) => `${v.owner} changed the plan for ${dayOf(r.ref) ?? 'a day'}${r.fields?.length ? ` (${r.fields.filter((f) => !f.startsWith('0 ')).join(', ')})` : ''}`,
  'step.removed': (v, r) => `${v.owner} removed a step${quoted(r.title)}${r.fields?.includes('was done') ? ' (it was done)' : ''}`,
  'step.edited': (v, r) => `${v.owner} changed ${changeWords(r)}`,
  'step.carried': (v, r) => `${v.owner} moved a step to a later day${quoted(r.title)}`,
  'template.applied': (v, r) => (r.actor === 'owner' ? `${v.owner} applied the template${quoted(r.title)}` : `Template applied${quoted(r.title)}`),
  'journal.commented': (v, r) => `${v.owner} commented on ${r.title ? voiced(v, r.title) : `${v.her} journal`}`,
  'alert.sent': (v, r) => {
    const k = r.fields?.[0] as AlertKind | undefined;
    return `${v.owner} sent ${v.obj} an alert${k && ALERT_KINDS[k] ? `: ${ALERT_KINDS[k].label}` : ''}`;
  },
  'med.added': (v, r) => `${v.owner} added a medicine${quoted(r.title)}`,
  'med.edited': (v, r) => (r.changes?.length ? `${v.owner} changed ${changeWords(r)}` : `${v.owner} changed a medicine${quoted(r.title)}`),
  'med.stopped': (v, r) => `${v.owner} stopped a medicine${quoted(r.title)}`,
  'weight.corrected': (v, r) => `${v.owner} corrected ${v.her} weight${dayOf(r.ref) ? ` for ${dayOf(r.ref)}` : ''}${r.changes?.[0] ? `: ${r.changes[0].from} → ${r.changes[0].to} kg` : ''}`,
  'weight.deleted': (v, r) => `${v.owner} removed ${v.her} weight${dayOf(r.ref) ? ` for ${dayOf(r.ref)}` : ''}`,
  'chat.limit': (v, r) => `${v.owner} set ${v.her} chat to ${r.changes?.[0]?.to ?? 'a new number of'} messages a day`,
  'place.deleted': (v, r) => `${r.actor === 'owner' ? v.owner : v.she} deleted a café for both of you${quoted(r.title)}`,
  'list.deleted': (v, r) => `${r.actor === 'owner' ? v.owner : v.she} deleted a list for both of you${quoted(r.title)}`,
};

/** One row in plain words; `voice` a name is her side with that owner (her Me › Activity). */
export function activityText(voice: ActivityVoice | string, r: PersonActivity): string {
  const v = typeof voice === 'string' ? herVoice(voice) : voice;
  return ACTION_WORDS[r.action]?.(v, r) ?? (r.actor === 'owner' ? `${v.owner} changed something in ${v.her} space` : `A change in ${v.her} space`);
}

/** His views grouped per day and area ("Sam looked at your Today 6 times · last 18:40"), C28. */
export function groupViews(rows: readonly PersonActivity[]): { key: string; row: PersonActivity; count: number }[] {
  const out: { key: string; row: PersonActivity; count: number }[] = [];
  const seen = new Map<string, { key: string; row: PersonActivity; count: number }>();
  for (const r of rows) {
    if (r.action !== 'view') {
      out.push({ key: String(r.seq), row: r, count: 1 });
      continue;
    }
    const k = `${localDayOf(r.at)}|${r.area ?? ''}`;
    const g = seen.get(k);
    if (g) g.count += 1;
    else {
      const ng = { key: k, row: r, count: 1 };
      seen.set(k, ng);
      out.push(ng);
    }
  }
  return out;
}

/** The device's day for an instant (rows say when on the reader's clock). */
export function localDayOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Rows under day headers, newest first ("Tue 3 Nov"). */
export function byDay(rows: readonly PersonActivity[]): { day: string; groups: ReturnType<typeof groupViews> }[] {
  const out: { day: string; groups: ReturnType<typeof groupViews> }[] = [];
  for (const g of groupViews(rows)) {
    const day = localDayOf(g.row.at);
    const last = out[out.length - 1];
    if (last && last.day === day) last.groups.push(g);
    else out.push({ day, groups: [g] });
  }
  return out;
}
