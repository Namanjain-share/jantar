/**
 * Medicine pings: what the one scheduler sends for medicines (v0.4 spec 4.5).
 *
 *   med     one row per (medicine, dose time), sub "HH:MM", grouped by time,
 *           so two medicines at 08:00 are one push "Medicines due · 2".
 *           next = life-core nextMedSlot (the next scheduled day, honouring
 *           the start, a stop and the schedule history).
 *   refill  one row per medicine that keeps a pill count, sub ''. Armed for
 *           the next 10:00 when supply turns low and no row exists; a ring
 *           parks it (next = null), and only a new pill count or a schedule
 *           edit clears it. So it rings once per box, not every morning. A
 *           row parked without a ring (its catch-up more than 6 hours late,
 *           or its sends given up) is armed again by the next dose or resync.
 *
 * Guards re-read the medicine just before a send and fail open: when one
 * throws, the push goes out (a missed dose ping is the worse failure). A
 * late `med` row says "Not logged at 08:00" and is skipped when that
 * medicine's next time is under MED_CATCH_UP_GAP_MS away, so a catch-up
 * never invites a double dose.
 *
 * Lock screen: "Medicine due" and the time, never a name, unless
 * life.lockScreenDetails is on at the Mac. Logs carry kinds only.
 *
 * v0.12 People: a medicine in her space rings her devices only (the row
 * names her: `person`), and its rows' sub is `<pid>|HH:MM`, so her 08:00
 * never merges with his 08:00 into one push (spec 3.4, C5). The handlers
 * are the `system` reader (C4): they read every space, so a restart keeps
 * her pings; her push opens her app (`/p/health?tab=meds&dose=`).
 */
import { dayKeyOf, hhmmOf, instantAt, nextMedSlot, shiftDay } from '@jantar/life-core';
import { MED_CATCH_UP_GAP_MS } from '@jantar/protocol';
import type { LifeCore, LifePush, Logger, PingHandler, PingRow } from '../../contracts.js';
import { personOfSpace } from '../todos/pings.js';
import { isDueOn, supplyOf } from './day.js';
import { MedsRepo, allMedsAnySpace, countMedsAnySpace, hasPing, medAnySpace, medPingTimes, pingKeys, type StoredMedicine } from './repo.js';

/** When a refill ping rings: the next 10:00 in the Life zone. */
export const REFILL_AT = '10:00';

const slotOf = (med: StoredMedicine) => ({ schedule: med.schedule, history: med.history, startedOn: med.startedOn, ...(med.stoppedOn ? { stoppedOn: med.stoppedOn } : {}) });

/** `name dose`, for the lock screen with details on. */
const label = (med: StoredMedicine) => (med.dose ? `${med.name} ${med.dose}` : med.name);

/** A dose time's row sub in a space: "08:00" for the owner, "<pid>|08:00" in hers. */
export function medSub(space: string, slot: string): string {
  return space === '' ? slot : `${space}|${slot}`;
}

/** The dose time a row's sub names ("<pid>|08:00" and "08:00" both name 08:00). */
export function slotOfSub(sub: string): string {
  const i = sub.lastIndexOf('|');
  return i === -1 ? sub : sub.slice(i + 1);
}

/** The next time strictly after `after` that any of the medicine's dose times comes round. */
export function nextDoseOf(med: StoredMedicine, after: Date, tz: string): Date | null {
  let best: Date | null = null;
  for (const t of med.times) {
    const at = nextMedSlot(slotOf(med), t, after, tz);
    if (at && (!best || at < best)) best = at;
  }
  return best;
}

/** The next 10:00 after now. */
function nextRefillAt(core: LifeCore): Date {
  const tz = core.tz();
  const today = core.today();
  const at = instantAt(today, REFILL_AT, tz);
  return at.getTime() > core.now().getTime() ? at : instantAt(shiftDay(today, 1), REFILL_AT, tz);
}

/**
 * Rows for each of the medicine's dose times, at their next slot; rows for
 * times it no longer has are removed. A stopped medicine has none.
 *
 * A row already due is left alone: it is not sent yet (the catch-up the
 * start sweep is sending, a failed send the next sweep retries), and the
 * scheduler's check re-reads the medicine before it rings. Moving it on
 * here would drop that dose's ping.
 */
export function armMed(core: LifeCore, med: StoredMedicine, before: readonly string[] = [], space = ''): void {
  const s = core.scheduler;
  if (med.stoppedOn) {
    s.clear('med', med.id);
    return;
  }
  for (const t of before) if (!med.times.includes(t)) s.clear('med', med.id, medSub(space, t));
  const now = core.now();
  const stored = medPingTimes(core, med.id);
  const person = personOfSpace(space);
  for (const t of med.times) {
    const sub = medSub(space, t);
    const at = stored.get(sub);
    if (at && Date.parse(at) <= now.getTime()) continue;
    const next = nextMedSlot(slotOf(med), t, now, core.tz());
    if (person) s.set('med', med.id, sub, next, person);
    else s.set('med', med.id, sub, next);
  }
}

/**
 * The refill producer. `reset` (a new pill count, a schedule edit, a new
 * medicine) forgets an earlier ring first; otherwise a row still armed, or
 * one that rang, is left alone: one ring per box.
 */
export function syncRefill(core: LifeCore, med: StoredMedicine, reset: boolean, space = ''): void {
  const s = core.scheduler;
  if (!med.pills || med.stoppedOn) {
    s.clear('refill', med.id);
    return;
  }
  if (reset) s.clear('refill', med.id);
  if (!supplyOf(med, core.today())?.low) return;
  if (!reset && hasPing(core, 'refill', med.id)) return;
  const person = personOfSpace(space);
  if (person) s.set('refill', med.id, '', nextRefillAt(core), person);
  else s.set('refill', med.id, '', nextRefillAt(core));
}

/** Rows of `kind` whose medicine is gone (or whose time, in its own space, it no longer has). */
function dropOrphans(core: LifeCore, kind: 'med' | 'refill', meds: readonly { med: StoredMedicine; space: string }[]): void {
  const live = new Map(meds.filter((m) => !m.med.stoppedOn).map((m) => [m.med.id, m]));
  for (const { ref, sub } of pingKeys(core, kind)) {
    const hit = live.get(ref);
    if (!hit) core.scheduler.clear(kind, ref);
    else if (kind === 'med' && !hit.med.times.some((t) => medSub(hit.space, t) === sub)) core.scheduler.clear(kind, ref, sub);
  }
}

export function medPings(core: LifeCore, log: Logger): PingHandler {
  return {
    kind: 'med',
    // Her rows' sub starts with her id: her 08:00 and his are two pushes, each to its own devices.
    group: (row) => row.sub,

    check(row, dueAt, late) {
      try {
        const hit = medAnySpace(core, row.ref);
        const slot = slotOfSub(row.sub);
        if (!hit || hit.med.stoppedOn || medSub(hit.space, slot) !== row.sub || !hit.med.times.includes(slot)) return 'cancel';
        const { med, space } = hit;
        const tz = core.tz();
        const day = dayKeyOf(dueAt, tz);
        if (!isDueOn(med, day, slot)) return 'skip';
        if (new MedsRepo(core, space).doseAt(med.id, day, slot)) return 'skip';
        if (late) {
          const now = core.now();
          const next = nextDoseOf(med, now, tz);
          if (next && next.getTime() - now.getTime() < MED_CATCH_UP_GAP_MS) return 'skip';
        }
        return 'send';
      } catch (e) {
        log.warn('medicine guard failed; sending', { event: 'life.med.guard_failed', kind: 'med', error: (e as Error)?.name ?? 'Error' });
        return 'send';
      }
    },

    push(rows, dueAt, late) {
      const slot = rows[0] ? slotOfSub(rows[0].sub) : hhmmOf(dueAt, core.tz());
      const n = rows.length;
      let body = `Tap to log · ${slot}`;
      // v0.12: the group's person (one sub, one space): her app and her devices.
      const person = rows[0]?.person;
      if (core.settings().lockScreenDetails) {
        try {
          const names = rows.map((r) => medAnySpace(core, r.ref)?.med ?? null).filter((m): m is StoredMedicine => m !== null).map(label).sort((a, b) => a.localeCompare(b));
          if (names.length) body = `${names.join(', ')} · ${slot}`;
        } catch {
          // The generic body still says when.
        }
      }
      const one = n === 1 ? rows[0] : undefined;
      const hhmm = slot.replace(':', '');
      const title = n === 1 ? 'Medicine due' : `Medicines due · ${n}`;
      const text = late ? `Not logged at ${slot} · ${body}` : body;
      if (person) {
        return {
          kind: 'med',
          title,
          body: text,
          url: one ? `/p/health?tab=meds&dose=${one.ref}@${hhmm}` : '/p/health?tab=meds',
          tag: one ? `life:med:${person}:${one.ref}` : `med:${person}|${slot}`,
          person,
        } satisfies LifePush;
      }
      return {
        kind: 'med',
        title,
        body: text,
        url: one ? `/today?dose=${one.ref}@${hhmm}` : '/today',
        tag: one ? `life:med:${one.ref}` : `med:${slot}`,
      } satisfies LifePush;
    },

    next(row, after) {
      const hit = medAnySpace(core, row.ref);
      const slot = slotOfSub(row.sub);
      if (!hit || hit.med.stoppedOn || !hit.med.times.includes(slot)) return null;
      return nextMedSlot(slotOf(hit.med), slot, after, core.tz());
    },

    resync() {
      const meds = allMedsAnySpace(core);
      // A stored row that no longer parses is left out of every read and loses its pings here: say how many.
      const unreadable = countMedsAnySpace(core) - meds.length;
      if (unreadable > 0) log.warn('unreadable medicines left out', { event: 'life.med.unreadable', count: unreadable });
      for (const m of meds) armMed(core, m.med, [], m.space);
      dropOrphans(core, 'med', meds);
      core.scheduler.poke();
    },
  };
}

export function refillPings(core: LifeCore, log: Logger): PingHandler {
  return {
    kind: 'refill',

    check(row) {
      try {
        const med = medAnySpace(core, row.ref)?.med;
        if (!med || med.stoppedOn || !med.pills) return 'cancel';
        return supplyOf(med, core.today())?.low ? 'send' : 'cancel';
      } catch (e) {
        log.warn('medicine guard failed; sending', { event: 'life.med.guard_failed', kind: 'refill', error: (e as Error)?.name ?? 'Error' });
        return 'send';
      }
    },

    push(rows: readonly PingRow[], dueAt, late) {
      const one = rows.length === 1 ? rows[0] : undefined;
      let body = 'Refill soon';
      if (one && core.settings().lockScreenDetails) {
        try {
          const med = medAnySpace(core, one.ref)?.med;
          const days = med ? supplyOf(med, core.today())?.daysLeft : null;
          if (med && days !== null && days !== undefined) body = `${med.name}: ${days === 1 ? '1 day' : `${days} days`} left`;
        } catch {
          // The generic body stands.
        }
      }
      const text = late ? `Missed at ${hhmmOf(dueAt, core.tz())} · ${body}` : body;
      const person = rows[0]?.person;
      if (person) {
        return { kind: 'med', title: 'Medicine running low', body: text, url: '/p/health?tab=meds', tag: one ? `life:refill:${person}:${one.ref}` : `life:refill:${person}`, person } satisfies LifePush;
      }
      return {
        kind: 'med',
        title: 'Medicine running low',
        body: text,
        url: one ? `/meds?med=${one.ref}` : '/meds',
        tag: one ? `life:refill:${one.ref}` : 'life:refill',
      } satisfies LifePush;
    },

    // A ring parks the row: the next one needs a new pill count (or a schedule edit).
    next: () => null,

    resync() {
      const meds = allMedsAnySpace(core);
      for (const m of meds) syncRefill(core, m.med, false, m.space);
      dropOrphans(core, 'refill', meds);
      core.scheduler.poke();
    },
  };
}
