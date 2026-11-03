/**
 * Medicines (WP-MD; v0.4 spec 1.4, 4.5): name, dose, 1 to 8 dose times, a
 * schedule (every day, chosen weekdays, every N days from a start day), an
 * optional pill count, and the doses logged against it.
 *
 * Write rules:
 * - Times are sorted and unique. `schedule.startDay` defaults to today. A
 *   schedule or times change applies from today: it is appended to
 *   `history` / `timesHistory` (replacing an entry dated today or later),
 *   so past days and their adherence stay as they were. A times change made
 *   after a dose was logged today keeps that dose on today's list, and a
 *   taken one stands for the earliest of today's doses (`timesFrom`), so
 *   moving 08:00 to 21:00 after the 08:00 dose asks for no second one.
 * - Doses are one row per (medicine, day, slot). Taken takes `perDose` pills
 *   (never below 0); Skip, Undo or a switch from Taken gives them back. A
 *   dose is for today or a past day the medicine was due, logged for a time
 *   never after now and never before the day before its own.
 * - A medicine added today is due from the time it was added: today's
 *   earlier dose times can still be logged (taken before it was added), but
 *   unlogged they are never overdue or a miss (`startTime`, day.ts).
 * - Stop sets `stoppedOn` to today and ends its pings; there is no restart
 *   (add it again). Today's doses after the Stop leave the list: they were
 *   never due (`stopTime`; a dose already logged for one stays where Undo
 *   reaches it). A stopped medicine is not edited. Delete takes its doses.
 * - Every write re-runs the ping producers, then emits `life.changed {}`.
 *   Replies and errors carry ids and fixed sentences only.
 * - v0.12 People: the module works in one space; `inSpace(pid)` is the same
 *   module over hers (only the People module calls it). A write there arms
 *   pings that ring her devices, ticks nobody's stream here (the People
 *   module says who hears of it) and never emits `life.changed {}`, so his
 *   stream can't tell him she is active in an area she keeps private. Her
 *   medicine count is hers: his cap is not shared with hers.
 */
import { consumeDose, hhmmOf, instantAt, shiftDay } from '@jantar/life-core';
import { LIFE_LIMITS, type DoseBody, type MedSchedule, type MedScheduleBody, type MedicineBody, type MedicinePatch } from '@jantar/protocol';
import type { Actor, LifeCore, LifeModuleDeps, LifeResult, MedicinesModule } from '../../contracts.js';
import { adherenceReport, isDueOn, medViews, medsDay } from './day.js';
import { armMed, medPings, refillPings, syncRefill } from './pings.js';
import { HISTORY_MAX, MedsRepo, publicMed, type DoseRow, type StoredMedicine } from './repo.js';

/** A phone clock a little ahead of the Mac's still logs "now". */
const CLOCK_SKEW_MS = 60_000;
/** The most pills a count can hold (MedicineSchema). */
const PILLS_MAX = 100_000;
/** The most dose times a day (MedicineSchema). */
const TIMES_MAX = 8;

export const MED_SENTENCES = {
  notFound: 'No such medicine.',
  doseNotFound: 'No such dose.',
  full: `You have ${LIFE_LIMITS.medicines} medicines. Delete one to add another.`,
  future: "That day hasn't come yet.",
  stopped: 'This medicine is stopped. Add it again to take it again.',
  atFuture: "A dose can't be logged for a time that hasn't come yet.",
  atEarly: "A dose can't be logged for a time more than a day before its day.",
  beforeStart: 'That day is before this medicine was added.',
  afterStop: 'This medicine was stopped before that day.',
  notDue: 'That medicine has no dose at that time on that day.',
} as const;

type Refusal = { ok: false; code: 'not_found' | 'invalid_request' | 'conflict'; reason: string };
const refuse = (code: Refusal['code'], reason: string): Refusal => ({ ok: false, code, reason });
const OK: LifeResult = { ok: true, value: true };

/** Sorted, unique. */
function normTimes(times: readonly string[]): string[] {
  return [...new Set(times)].sort();
}

const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A body's schedule as stored: weekdays sorted and unique, startDay filled. */
function normSchedule(s: MedScheduleBody, startDay: string): MedSchedule {
  return {
    freq: s.freq,
    ...(s.byWeekday ? { byWeekday: [...new Set(s.byWeekday)].sort((a, b) => a - b) } : {}),
    ...(s.interval !== undefined ? { interval: s.interval } : {}),
    startDay,
  };
}

/** Which days a schedule covers, the start day left out. */
const daysKey = (s: MedSchedule) => JSON.stringify([s.freq, s.byWeekday ?? null, s.interval ?? null]);

/** An entry dated today or later is replaced; the list keeps its newest HISTORY_MAX. */
function appendFrom<T extends { from: string }>(list: readonly T[], entry: T, ...later: T[]): T[] {
  return [...list.filter((e) => e.from < entry.from), entry, ...later].slice(-HISTORY_MAX);
}

/**
 * `timesHistory` after a times change made today, when `logged` holds the
 * doses already logged today. Today keeps every logged slot, and a taken
 * dose stands for the earliest of today's doses: of the new times not
 * logged, today takes only the latest ones still owed (the new number a day
 * less the doses taken). So moving 08:00 to 21:00 after the 08:00 dose asks
 * for no second dose tonight, while adding a time, or moving one not yet
 * taken, counts today. The new times hold from tomorrow either way.
 */
function timesFrom(med: StoredMedicine, times: string[], logged: readonly DoseRow[], today: string): StoredMedicine['timesHistory'] {
  const kept = new Set(logged.map((d) => d.slot));
  const taken = logged.filter((d) => d.status === 'taken').length;
  const open = times.filter((t) => !kept.has(t));
  const owed = Math.max(0, Math.min(times.length - taken, TIMES_MAX - kept.size, open.length));
  const todays = normTimes([...kept, ...open.slice(open.length - owed)]);
  if (sameList(todays, times)) return appendFrom(med.timesHistory, { from: today, times });
  return appendFrom(med.timesHistory, { from: today, times: todays }, { from: shiftDay(today, 1), times });
}

export function buildMedicinesModule(core: LifeCore, deps: LifeModuleDeps): MedicinesModule {
  const log = deps.ctx.log.child({ part: 'life.medicines' });
  core.scheduler.register(medPings(core, log));
  core.scheduler.register(refillPings(core, log));
  const spaces = new Map<string, MedicinesModule>();
  const owner = medicinesIn(core, new MedsRepo(core), (space) => {
    if (space === '') return owner;
    let m = spaces.get(space);
    if (!m) spaces.set(space, (m = medicinesIn(core, new MedsRepo(core, space), () => owner)));
    return m;
  });
  return owner;
}

/** The module over one space's repo. `inSpace` reaches the others (her space's module is built once). */
function medicinesIn(core: LifeCore, repo: MedsRepo, inSpace: (space: string) => MedicinesModule): MedicinesModule {
  const space = repo.space;

  /** After a committed write: wake the scheduler and (his space only) tell his screens. */
  const done = () => {
    core.scheduler.poke();
    if (space === '') core.changed();
  };

  /** Give back what a Taken dose took, capped at the schema's maximum. */
  const giveBack = (med: StoredMedicine, stamp: string): StoredMedicine =>
    med.pills ? { ...med, pills: { ...med.pills, left: Math.min(PILLS_MAX, med.pills.left + med.pills.perDose) }, updatedAt: stamp } : med;

  const self: MedicinesModule = {
    name: 'medicines',

    inSpace: (other: string) => (other === space ? self : inSpace(other)),

    today: (day) => ({ meds: medsDay(core, repo, repo.all(), day) }),

    get(day) {
      const today = core.today();
      const d = day ?? today;
      if (d > today) return refuse('invalid_request', MED_SENTENCES.future);
      const meds = repo.all();
      return { ok: true, value: { day: medsDay(core, repo, meds, d), medicines: medViews(core, repo, meds) } };
    },

    adherence() {
      const r = adherenceReport(core, repo, repo.all());
      return { pct: r.overall, perDay: r.perDay };
    },

    find(id: string) {
      const m = repo.get(id);
      return m ? publicMed(m) : null;
    },

    create(body: MedicineBody, _actor: Actor, opts: { by?: string } = {}) {
      if (repo.count() >= LIFE_LIMITS.medicines) return refuse('conflict', MED_SENTENCES.full);
      const today = core.today();
      const now = core.now();
      const stamp = now.toISOString();
      const times = normTimes(body.times);
      const schedule = normSchedule(body.schedule, body.schedule.startDay ?? today);
      const med: StoredMedicine = {
        id: core.newId(),
        name: body.name,
        ...(body.dose ? { dose: body.dose } : {}),
        times,
        schedule,
        history: [{ from: schedule.startDay, schedule }],
        ...(body.pills ? { pills: { left: body.pills.left, perDose: body.pills.perDose } } : {}),
        ...(body.notes ? { notes: body.notes } : {}),
        startedOn: today,
        // The dose times already gone by today are not due unless logged (day.ts beforeAdded).
        startTime: hhmmOf(now, core.tz()),
        createdAt: stamp,
        updatedAt: stamp,
        timesHistory: [{ from: today, times }],
      };
      core.db.tx(() => {
        repo.put(med, opts.by ?? '');
        armMed(core, med, [], space);
        syncRefill(core, med, true, space);
      });
      done();
      return { ok: true, value: { id: med.id } };
    },

    update(id: string, patch: MedicinePatch, _actor: Actor, opts: { editedBy?: string } = {}) {
      const med = repo.get(id);
      if (!med) return refuse('not_found', MED_SENTENCES.notFound);
      if (med.stoppedOn) return refuse('conflict', MED_SENTENCES.stopped);
      const today = core.today();
      const next: StoredMedicine = { ...med };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.dose !== undefined) {
        if (patch.dose) next.dose = patch.dose;
        else delete next.dose;
      }
      if (patch.notes !== undefined) {
        if (patch.notes) next.notes = patch.notes;
        else delete next.notes;
      }

      let timesChanged = false;
      if (patch.times) {
        const times = normTimes(patch.times);
        if (!sameList(times, med.times)) {
          next.times = times;
          next.timesHistory = timesFrom(med, times, repo.medDosesOn(id, today), today);
          timesChanged = true;
        }
      }

      let scheduleChanged = false;
      if (patch.schedule) {
        // Without a start day, the same days as now is no change (the start day stays).
        const schedule = normSchedule(patch.schedule, patch.schedule.startDay ?? today);
        const same = patch.schedule.startDay === undefined && daysKey(schedule) === daysKey(med.schedule);
        if (!same && JSON.stringify(schedule) !== JSON.stringify(med.schedule)) {
          next.schedule = schedule;
          next.history = appendFrom(med.history, { from: today, schedule });
          scheduleChanged = true;
        }
      }

      let pillsChanged = false;
      if (patch.pills === null) {
        if (med.pills) {
          delete next.pills;
          pillsChanged = true;
        }
      } else if (patch.pills) {
        // A new count is a refill; perDose stays as it was when left out.
        const pills = { left: patch.pills.left, perDose: patch.pills.perDose ?? med.pills?.perDose ?? 1 };
        if (!med.pills || pills.left !== med.pills.left || pills.perDose !== med.pills.perDose) {
          next.pills = pills;
          pillsChanged = true;
        }
      }

      next.updatedAt = core.now().toISOString();
      // v0.12: "Edited by" on a medicine of hers the owner changed (the People module decides when).
      if (opts.editedBy !== undefined) {
        next.editedBy = opts.editedBy;
        next.editedAt = next.updatedAt;
      }
      core.db.tx(() => {
        repo.put(next);
        if (timesChanged || scheduleChanged) armMed(core, next, med.times, space);
        if (timesChanged || scheduleChanged || pillsChanged) syncRefill(core, next, true, space);
      });
      done();
      return OK;
    },

    stopTaking(id: string, _actor: Actor, opts: { editedBy?: string } = {}) {
      const med = repo.get(id);
      if (!med) return refuse('not_found', MED_SENTENCES.notFound);
      if (med.stoppedOn) return OK;
      const now = core.now();
      const stamp = now.toISOString();
      const next: StoredMedicine = {
        ...med,
        stoppedOn: core.today(),
        stopTime: hhmmOf(now, core.tz()),
        updatedAt: stamp,
        ...(opts.editedBy !== undefined ? { editedBy: opts.editedBy, editedAt: stamp } : {}),
      };
      core.db.tx(() => {
        repo.put(next);
        core.scheduler.clear('med', id);
        core.scheduler.clear('refill', id);
      });
      done();
      return OK;
    },

    remove(id: string, _actor: Actor) {
      if (!repo.get(id)) return refuse('not_found', MED_SENTENCES.notFound);
      core.db.tx(() => {
        repo.delete(id);
        core.scheduler.clear('med', id);
        core.scheduler.clear('refill', id);
      });
      done();
      return OK;
    },

    logDose(medId: string, body: DoseBody, _actor: Actor) {
      const now = core.now();
      if (body.day > core.today()) return refuse('invalid_request', MED_SENTENCES.future);
      const at = body.at ? new Date(body.at) : now;
      if (at.getTime() > now.getTime() + CLOCK_SKEW_MS) return refuse('invalid_request', MED_SENTENCES.atFuture);
      if (at.getTime() < instantAt(shiftDay(body.day, -1), '00:00', core.tz()).getTime()) return refuse('invalid_request', MED_SENTENCES.atEarly);
      const med = repo.get(medId);
      if (!med) return refuse('not_found', MED_SENTENCES.notFound);
      if (body.day < med.startedOn) return refuse('invalid_request', MED_SENTENCES.beforeStart);
      if (med.stoppedOn && body.day > med.stoppedOn) return refuse('invalid_request', MED_SENTENCES.afterStop);
      const existing = repo.doseAt(medId, body.day, body.slot);
      // A logged time that left the schedule can still be changed; a new log needs a due time.
      if (!existing && !isDueOn(med, body.day, body.slot)) return refuse('invalid_request', MED_SENTENCES.notDue);

      const id = existing?.id ?? core.newId();
      const stamp = now.toISOString();
      const wasTaken = existing?.status === 'taken';
      const isTaken = body.status === 'taken';
      let next = med;
      if (med.pills && wasTaken !== isTaken) {
        next = isTaken
          ? { ...med, pills: { ...med.pills, left: consumeDose({ unitsRemaining: med.pills.left, unitsPerDose: med.pills.perDose }) }, updatedAt: stamp }
          : giveBack(med, stamp);
      }
      core.db.tx(() => {
        repo.upsertDose({ id, medId, day: body.day, slot: body.slot, status: body.status, at: at.toISOString() });
        if (next !== med) repo.put(next);
        syncRefill(core, next, false, space);
      });
      done();
      return { ok: true, value: { id } };
    },

    undoDose(medId: string, doseId: string, _actor: Actor) {
      const dose = repo.doseById(medId, doseId);
      if (!dose) return refuse('not_found', MED_SENTENCES.doseNotFound);
      const med = repo.get(medId);
      core.db.tx(() => {
        repo.deleteDose(dose.id);
        if (med) {
          const next = dose.status === 'taken' ? giveBack(med, core.now().toISOString()) : med;
          if (next !== med) repo.put(next);
          syncRefill(core, next, false, space);
        }
      });
      done();
      return OK;
    },
  };
  return self;
}
