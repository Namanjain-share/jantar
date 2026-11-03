/**
 * v0.11 People (P1): her medicines and doses, as either side writes them
 * (spec 3.4, 8.2), over the Medicines module in her space.
 *
 * The rules:
 * - She adds, edits and stops any of her medicines, his additions included
 *   (her phone, her medicine). A change of hers to one he added tells him,
 *   while he sees her medicines in full. Only she logs or undoes a dose.
 * - He adds one for her with `assign.meds` ("Added by {owner}"); he edits or
 *   stops his additions with `assign.meds`, and hers with `editHers.meds`,
 *   which sets "Edited by" and writes Activity with the old and new value
 *   of each changed field (O4). Every one of these needs `see.meds` full.
 *   A row he may not touch answers as one that doesn't exist (404).
 * - He never logs, undoes or deletes a dose, and never deletes a medicine
 *   of hers: Stop keeps her dose history (D22).
 * - While she is paused, his writes are 409 `paused`.
 * - His view (`see.meds`): `full` is what her join page words as "names,
 *   doses, times, whether you took each dose, and how often in the last 30
 *   days": each medicine (name, dose, times, days, who added and edited it,
 *   its 30-day share) and the day's doses taken, skipped or not, never
 *   when she logged one, nor her pill count. Her notes only on a medicine
 *   he may change (his own with assign.meds, hers with editHers.meds), as
 *   the join page says.
 *   `adherence` is the 30-day percentage and how many of today's doses
 *   aren't logged, naming nothing. On either, the two-day concern
 *   (Noblot's medicine escalation, life-core med-escalation.ts) is derived
 *   when he looks, never stored.
 * - Each of his writes reaches her: an Activity row, a push (no medicine
 *   name: lock screens), a tick of her stream. Her writes tick her stream,
 *   and his only while he sees her medicines.
 */
import { PEOPLE_LABEL } from '@jantar/protocol/people-core';
import { computeMedEscalation } from '@jantar/life-core';
import type { DoseBody, MedicineBody, MedicinePatch, MedsDay } from '@jantar/protocol';
import { medsDayTotals, type OwnerDoseItem, type OwnerMedicine, type OwnerMedsDay, type OwnerMedsView, type PersonMedicine, type PersonMedicineView, type PersonMedicinesResponse } from '@jantar/protocol/people';
import type { Actor, LifeCore, LifeResult, MedicinesModule } from '../../contracts.js';
import type { PeopleModule } from './module.js';

export const MEDS_REASONS = {
  noMed: 'No such medicine.',
  paused: (name: string) => `${name} has paused. New items wait until sharing resumes.`,
  closed: 'Life is not open right now. Try again in a moment.',
} as const;

type Refusal = Extract<LifeResult, { ok: false }>;
const refuse = (code: Refusal['code'], reason: string): Refusal => ({ ok: false, code, reason });
const TITLE_MAX = 120;

type Change = { field: string; from?: string; to?: string };

/** Which medicines of hers he may change: his own (assign.meds), hers (editHers.meds). Their notes are his to read. */
export interface MedsReach {
  mine: boolean;
  hers: boolean;
}

/** One medicine at `full`, cut to what she was told (protocol OwnerMedicine). */
export function ownerMedicine(m: PersonMedicineView, reach: MedsReach): OwnerMedicine {
  const canChange = m.by === '' ? reach.mine : reach.hers;
  return {
    id: m.id,
    name: m.name,
    ...(m.dose !== undefined ? { dose: m.dose } : {}),
    times: m.times,
    schedule: m.schedule,
    ...(canChange && m.notes !== undefined ? { notes: m.notes } : {}),
    startedOn: m.startedOn,
    ...(m.stoppedOn !== undefined ? { stoppedOn: m.stoppedOn } : {}),
    adherencePct: m.adherencePct,
    ...(m.by !== undefined ? { by: m.by } : {}),
    ...(m.editedBy !== undefined ? { editedBy: m.editedBy } : {}),
    ...(m.editedAt !== undefined ? { editedAt: m.editedAt } : {}),
  };
}

/** The day's doses as he sees them: taken, skipped or not; never when she logged one. A time gone by before she added it was never due. */
export function ownerMedsDay(d: MedsDay): OwnerMedsDay {
  const groups = d.groups.map((g) => ({
    period: g.period,
    items: g.items
      .filter((i) => !i.beforeAdded)
      .map((i): OwnerDoseItem => ({ medId: i.medId, name: i.name, ...(i.dose !== undefined ? { dose: i.dose } : {}), slot: i.slot, status: i.status, overdue: i.overdue })),
  }));
  return { day: d.day, today: d.today, groups: groups.filter((g) => g.items.length > 0) };
}

/** The fields of a medicine an edit changed, old and new, for her Activity (notes: that they changed, never the text). */
export function medChanges(before: PersonMedicine, after: PersonMedicine): Change[] {
  const out: Change[] = [];
  const show = (v: unknown): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v === 'string') return v.slice(0, 200);
    if (Array.isArray(v)) return v.join(', ').slice(0, 200);
    return JSON.stringify(v).slice(0, 200);
  };
  for (const field of ['name', 'dose', 'times', 'schedule', 'pills'] as const) {
    const a = field === 'schedule' ? scheduleWords(before) : before[field];
    const b = field === 'schedule' ? scheduleWords(after) : after[field];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      const from = show(a);
      const to = show(b);
      out.push({ field, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) });
    }
  }
  if (before.notes !== after.notes) out.push({ field: 'notes' });
  if (before.stoppedOn === undefined && after.stoppedOn !== undefined) out.push({ field: 'stopped', to: after.stoppedOn });
  return out;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Every day", "Mon, Thu", "Every 2 days": the days of a schedule, without its start day. */
function scheduleWords(m: PersonMedicine): string {
  const s = m.schedule;
  if (s.freq === 'weekly' && s.byWeekday?.length) return s.byWeekday.map((d) => WEEKDAYS[d] ?? String(d)).join(', ');
  if (s.interval && s.interval > 1) return `Every ${s.interval} days`;
  return 'Every day';
}

export class PersonMeds {
  constructor(
    private readonly people: PeopleModule,
    private readonly medicinesModule: () => MedicinesModule,
    private readonly core: () => LifeCore | null,
  ) {}

  private meds(pid: string): MedicinesModule {
    return this.medicinesModule().inSpace(pid);
  }

  /** Her write lands: her stream; his devices only while he sees her medicines. */
  private herWrite(pid: string): void {
    this.people.ticks.bump(pid, 'life');
    const a = this.people.agreement(pid);
    if (a && a.see.meds !== 'off') this.people.ownerChanged();
  }

  /** His write lands: her Activity, her stream, his devices' re-fetch, one push to her (no medicine name on a lock screen). */
  private hisWrite(pid: string, action: 'med.added' | 'med.edited' | 'med.stopped', title: string, changes?: Change[]): void {
    this.people.record(pid, { actor: 'owner', action, area: 'meds', title: title.slice(0, TITLE_MAX), ...(changes?.length ? { changes: changes.slice(0, 12) } : {}) });
    this.people.ticks.bump(pid, 'life');
    this.people.ownerChanged();
    const owner = this.people.ownerName();
    const times = changes?.find((c) => c.field === 'times');
    const words =
      action === 'med.added'
        ? `${owner} added a medicine for you`
        : action === 'med.stopped'
          ? `${owner} stopped a medicine`
          : times
            ? `${owner} changed a medicine's times: ${times.from ?? '–'} → ${times.to ?? '–'}`
            : `${owner} changed a medicine`;
    this.people.noticeHer(pid, { kind: 'life', title: `From ${owner}`, body: words, url: '/p/health?tab=meds', tag: `people:meds:${pid}` });
  }

  // --- her side ----------------------------------------------------------------------

  herList(pid: string, day?: string): LifeResult<PersonMedicinesResponse> {
    return this.meds(pid).get(day) as LifeResult<PersonMedicinesResponse>;
  }

  /** Today's doses for her Today (null while life.db is closed). */
  herDay(pid: string, day: string): MedsDay | null {
    const r = this.meds(pid).get(day);
    return r.ok ? r.value.day : null;
  }

  herCreate(pid: string, body: MedicineBody, actor: Actor): LifeResult<{ id: string }> {
    const r = this.meds(pid).create(body, actor, { by: pid });
    if (r.ok) this.herWrite(pid);
    return r;
  }

  /** Any of her medicines, his additions included; a change to one he added tells him (while he sees her medicines in full). */
  herUpdate(pid: string, id: string, patch: MedicinePatch, actor: Actor): LifeResult {
    const before = this.meds(pid).find(id);
    if (!before) return refuse('not_found', MEDS_REASONS.noMed);
    const r = this.meds(pid).update(id, patch, actor);
    if (r.ok) {
      this.herWrite(pid);
      if (before.by === '') this.tellHim(pid, 'changed');
    }
    return r;
  }

  herStop(pid: string, id: string, actor: Actor): LifeResult {
    const before = this.meds(pid).find(id);
    if (!before) return refuse('not_found', MEDS_REASONS.noMed);
    const r = this.meds(pid).stopTaking(id, actor);
    if (r.ok) {
      this.herWrite(pid);
      if (before.by === '' && before.stoppedOn === undefined) this.tellHim(pid, 'stopped');
    }
    return r;
  }

  herDoseLog(pid: string, medId: string, body: DoseBody, actor: Actor): LifeResult<{ id: string }> {
    const r = this.meds(pid).logDose(medId, body, actor);
    if (r.ok) this.herWrite(pid);
    return r;
  }

  herDoseUndo(pid: string, medId: string, doseId: string, actor: Actor): LifeResult {
    const r = this.meds(pid).undoDose(medId, doseId, actor);
    if (r.ok) this.herWrite(pid);
    return r;
  }

  /** Her change to a medicine he added reaches his feed: a push about her, built from today's agreement (full only). */
  private tellHim(pid: string, what: 'changed' | 'stopped'): void {
    const a = this.people.agreement(pid);
    if (a?.see.meds !== 'full') return;
    this.people.pushOwner(pid, { kind: 'life', title: `${this.people.nameOf(pid)} ${what} a medicine you added`, body: `Open ${PEOPLE_LABEL} to see.`, url: `/people/${pid}?tab=health`, tag: `people:meds:${pid}` });
  }

  // --- his view ----------------------------------------------------------------------

  /**
   * Her medicines at a level (`full` or `adherence`), with the two-day
   * concern. `day` reads that day's doses at `full`; the concern and the
   * adherence numbers are always as of today. `reach` is the agreement's
   * assign.meds and editHers.meds (whose notes he reads).
   */
  view(pid: string, level: 'full' | 'adherence', reach: MedsReach, day?: string): OwnerMedsView | null {
    const c = this.core();
    if (!c) return null;
    const m = this.meds(pid);
    const today = c.today();
    const adherence = m.adherence();
    const esc = computeMedEscalation(adherence.perDay, today);
    const concern = esc.level === 'escalate' ? esc.message : null;
    if (level === 'adherence') {
      const t = m.get(today);
      return { level: 'adherence', pct: adherence.pct, notLoggedToday: t.ok ? medsDayTotals(t.value.day).missed : 0, concern };
    }
    const r = m.get(day && day <= today ? day : today);
    if (!r.ok) return null;
    const medicines = (r.value.medicines as PersonMedicinesResponse['medicines']).map((m) => ownerMedicine(m, reach));
    return { level: 'full', day: ownerMedsDay(r.value.day), medicines, concern };
  }

  /**
   * His 21:00 summary's medicine words, from today's agreement (spec 4.4):
   * "1 dose not logged", and "not logged 2 days running" when the concern
   * holds. Counts only, never a name; nothing while he sees no medicines.
   */
  summaryParts(pid: string): string[] {
    const a = this.people.agreement(pid);
    const c = this.core();
    if (!a || a.see.meds === 'off' || !c) return [];
    const m = this.meds(pid);
    const t = m.get(c.today());
    const missed = t.ok ? medsDayTotals(t.value.day).missed : 0;
    const esc = computeMedEscalation(m.adherence().perDay, c.today());
    const out: string[] = [];
    if (missed > 0) out.push(`${missed} dose${missed === 1 ? '' : 's'} not logged`);
    if (esc.level === 'escalate') out.push(`not logged ${esc.consecutiveMissedDays} days running`);
    return out;
  }

  // --- his writes (ownerOf: the agreement decides; paused holds them) --------------------

  /** His gate: see.meds full and `need`, or the unknown-pid answer; paused is 409. */
  private hisGate(pid: string, need: 'assign' | 'any'): Refusal | null {
    const a = this.people.agreement(pid);
    if (!a || a.see.meds !== 'full' || (need === 'assign' && !a.assign.meds)) return refuse('not_found', 'No such person.');
    if (this.people.gateState(pid) === 'paused') return refuse('conflict', MEDS_REASONS.paused(this.people.nameOf(pid)));
    return null;
  }

  /** One medicine he may change: his own with assign.meds, hers with editHers.meds; any other is the one not_found. */
  private hisRow(pid: string, id: string): { med: PersonMedicine; mine: boolean } | Refusal {
    const a = this.people.agreement(pid);
    if (!a || a.see.meds !== 'full') return refuse('not_found', 'No such person.');
    const med = this.meds(pid).find(id);
    if (!med) return refuse('not_found', MEDS_REASONS.noMed);
    const mine = med.by === '';
    if (!(mine ? a.assign.meds : a.editHers.meds)) return refuse('not_found', MEDS_REASONS.noMed);
    if (this.people.gateState(pid) === 'paused') return refuse('conflict', MEDS_REASONS.paused(this.people.nameOf(pid)));
    return { med, mine };
  }

  assign(pid: string, body: MedicineBody, actor: Actor): LifeResult<{ id: string }> {
    const g = this.hisGate(pid, 'assign');
    if (g) return g;
    if (!this.core()) return refuse('unavailable', MEDS_REASONS.closed);
    const r = this.meds(pid).create(body, actor, { by: '' });
    if (r.ok) this.hisWrite(pid, 'med.added', body.name);
    return r;
  }

  ownerUpdate(pid: string, id: string, patch: MedicinePatch, actor: Actor): LifeResult {
    const row = this.hisRow(pid, id);
    if ('ok' in row) return row;
    const { med, mine } = row;
    const r = this.meds(pid).update(id, patch, actor, mine ? {} : { editedBy: '' });
    if (!r.ok) return r;
    const after = this.meds(pid).find(id) ?? med;
    this.hisWrite(pid, 'med.edited', after.name, medChanges(med, after));
    return r;
  }

  ownerStop(pid: string, id: string, actor: Actor): LifeResult {
    const row = this.hisRow(pid, id);
    if ('ok' in row) return row;
    const { med, mine } = row;
    if (med.stoppedOn !== undefined) return { ok: true, value: true };
    const r = this.meds(pid).stopTaking(id, actor, mine ? {} : { editedBy: '' });
    if (r.ok) this.hisWrite(pid, 'med.stopped', med.name);
    return r;
  }
}
