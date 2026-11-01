/**
 * Medicine pings (v0.4 spec 1.3, 4.2, 4.5): one row per (medicine, dose
 * time) at its next slot; two medicines at 08:00 are one push (LS5); a dose
 * logged before the ping, Stop and Delete stop it (LS3); after sleep one
 * catch-up says "Not logged at 08:00" and the next ring is tomorrow, unless
 * that medicine's next time is under 3 hours away (LS2); a guard that fails
 * still sends; the lock screen names nothing unless details are on (LP4);
 * the refill ping rings at 10:00 once per box, even when a ring was missed
 * by more than 6 hours; a time moved after today's dose rings from tomorrow;
 * the times follow the zone across a DST change. v0.5.3: a dose ping that
 * could not leave the Mac waits for the network, and is still skipped once
 * that medicine's next time is under 3 hours away (real scheduler).
 *
 * The handlers run under a small stand-in for the scheduler (`sweep`) that
 * does what spec 4.2 says the real one does with them: rows due by now,
 * each moved to its latest occurrence at or before now (one catch-up after
 * sleep), grouped by kind, group and minute, `check` per row, one `push` per
 * group, then `next` from the later of now and the due time, and a ring's
 * time kept as last_sent_at; a row more than 6 hours late only advances. Its
 * rows live in the `pings` table, as the real scheduler's do, because the
 * refill producer and resync read it. One refill case runs under the real
 * LifeScheduler too.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { instantAt, shiftDay, weekdayOf } from '@jantar/life-core';
import { EXAMPLEX, PLACEBIN, doseBody, medBody } from '@jantar/fixtures';
import type { Actor, LifeCore, LifeResult, LifePush, MedicinesModule, PingHandler, PingKind, PingRow } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { RecordingScheduler, createPushSpy, createTestContext, createTestLifeCore, type TestContext, type TestLifeCore } from '../../src/core/testing.js';
import { buildMedicinesModule } from '../../src/life/medicines/module.js';
import { LifeScheduler } from '../../src/life/scheduler.js';
import { makeFakes } from '../api/fakes.js';

const TZ = 'Asia/Kolkata';
const DAY = '2026-10-30';
const PHONE: Actor = { kind: 'device', deviceId: 'dev-phone', scopes: ['read', 'control'] };
const at = (day: string, hhmm: string) => instantAt(day, hhmm, TZ);
const iso = (day: string, hhmm: string) => at(day, hhmm).toISOString();
const LATE_MS = 2 * 60_000;
const CATCH_UP_MS = 6 * 60 * 60_000;

/** A RecordingScheduler that also keeps the `pings` table, as the real one does. */
class TableScheduler extends RecordingScheduler {
  constructor(private readonly core: LifeCore) {
    super();
  }

  override set(kind: PingKind, ref: string, sub: string, nextAt: Date | null): void {
    super.set(kind, ref, sub, nextAt);
    this.core.db
      .prepare('INSERT INTO pings (id, kind, ref, sub, next_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (kind, ref, sub) DO UPDATE SET next_at = excluded.next_at, claimed_at = NULL, failures = 0')
      .run(`${kind}|${ref}|${sub}`, kind, ref, sub, nextAt ? nextAt.toISOString() : null);
  }

  override clear(kind: PingKind, ref: string, sub?: string): void {
    super.clear(kind, ref, sub);
    if (sub === undefined) this.core.db.prepare('DELETE FROM pings WHERE kind = ? AND ref = ?').run(kind, ref);
    else this.core.db.prepare('DELETE FROM pings WHERE kind = ? AND ref = ? AND sub = ?').run(kind, ref, sub);
  }

  /** A ring, kept as the real scheduler keeps it: last_sent_at. */
  sent(row: PingRow, at: Date): void {
    const key = `${row.kind}|${row.ref}|${row.sub}`;
    const cur = this.rows.get(key);
    if (cur) this.rows.set(key, { ...cur, lastSentAt: at.toISOString() });
    this.core.db.prepare('UPDATE pings SET last_sent_at = ? WHERE kind = ? AND ref = ? AND sub = ?').run(at.toISOString(), row.kind, row.ref, row.sub);
  }
}

interface Rig {
  core: TestLifeCore;
  ctx: TestContext;
  sched: TableScheduler;
  meds: MedicinesModule;
  /** One pass of the scheduler at the clock's now: the pushes it sent. */
  sweep(): LifePush[];
  handler(kind: PingKind): PingHandler;
}

let rig: Rig | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  rig?.core.close();
  rig = undefined;
});

function setup(start: string = iso(DAY, '07:00'), over: { lockScreenDetails?: boolean } = {}): Rig {
  const clock = new FakeClock(start);
  const core = createTestLifeCore({ clock, tz: TZ, settings: { medicines: true, ...over } });
  const sched = new TableScheduler(core);
  core.scheduler = sched;
  const ctx = createTestContext({ clock });
  const f = makeFakes(ctx);
  const meds = buildMedicinesModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
  const handler = (kind: PingKind) => {
    const h = sched.handlers.get(kind);
    if (!h) throw new Error(`no ${kind} handler`);
    return h;
  };
  const sweep = (): LifePush[] => {
    const now = core.now();
    const groups = new Map<string, { h: PingHandler; dueAt: Date; rows: PingRow[] }>();
    for (const row of sched.list()) {
      if (row.nextAt === null || Date.parse(row.nextAt) > now.getTime()) continue;
      const h = handler(row.kind);
      let dueAt = new Date(row.nextAt);
      for (let n = h.next(row, dueAt); n && n.getTime() <= now.getTime(); n = h.next(row, n)) dueAt = n;
      const key = `${row.kind}|${h.group?.(row) ?? row.id}|${dueAt.toISOString().slice(0, 16)}`;
      const g = groups.get(key) ?? { h, dueAt, rows: [] };
      g.rows.push(row);
      groups.set(key, g);
    }
    const sent: LifePush[] = [];
    for (const { h, dueAt, rows } of groups.values()) {
      const lateBy = now.getTime() - dueAt.getTime();
      const late = lateBy > LATE_MS;
      const kept: PingRow[] = [];
      const send: PingRow[] = [];
      for (const row of rows) {
        const verdict = late && lateBy > CATCH_UP_MS ? 'skip' : h.check(row, dueAt, late);
        if (verdict === 'cancel') {
          sched.clear(row.kind, row.ref, row.sub);
          continue;
        }
        kept.push(row);
        if (verdict === 'send') send.push(row);
      }
      if (send.length) sent.push(h.push(send, dueAt, late));
      const from = new Date(Math.max(now.getTime(), dueAt.getTime()));
      for (const row of kept) sched.set(row.kind, row.ref, row.sub, h.next(row, from));
      for (const row of send) sched.sent(row, now);
    }
    return sent;
  };
  rig = { core, ctx, sched, meds, sweep, handler };
  return rig;
}

function ok<T>(r: LifeResult<T>): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return r.value;
}

const nextAt = (r: Rig, kind: PingKind, ref: string, sub = '') => r.sched.row(kind, ref, sub)?.nextAt;

/** No medicine name or dose anywhere in a push (title, body, tag, url). */
function generic(p: LifePush): void {
  const text = JSON.stringify(p);
  for (const word of ['Testamol', 'Placebin', 'Examplex', '500 mg', '10 mg', '1000 IU']) expect(text, word).not.toContain(word);
}

describe('med rows', () => {
  it('one per dose time at its next slot in the Life zone; Stop and Delete remove them (LS3)', () => {
    const r = setup();
    const id = ok(r.meds.create(medBody(), PHONE)).id;
    expect(nextAt(r, 'med', id, '08:00')).toBe(iso(DAY, '08:00'));
    expect(nextAt(r, 'med', id, '21:00')).toBe(iso(DAY, '21:00'));
    expect(r.sched.pokes).toBeGreaterThan(0);
    ok(r.meds.stopTaking(id, PHONE));
    expect(r.sched.list().filter((x) => x.ref === id)).toEqual([]);
    const other = ok(r.meds.create(PLACEBIN, PHONE)).id;
    expect(r.sched.list('med').map((x) => x.ref)).toEqual([other]);
    ok(r.meds.remove(other, PHONE));
    expect(r.sched.list()).toEqual([]);
  });

  it('a times edit moves the rows: a removed time loses its row, a new one gets one', () => {
    const r = setup();
    const id = ok(r.meds.create(medBody(), PHONE)).id;
    ok(r.meds.update(id, { times: ['09:00', '21:00'] }, PHONE));
    expect(r.sched.list('med').map((x) => [x.sub, x.nextAt])).toEqual([
      ['21:00', iso(DAY, '21:00')],
      ['09:00', iso(DAY, '09:00')],
    ]);
  });

  it('next skips the days the schedule skips, honours an every-N start, and ends at a stop', () => {
    const r = setup();
    const monday = [1];
    const weekly = ok(r.meds.create({ ...EXAMPLEX, schedule: { freq: 'weekly', byWeekday: monday } }, PHONE)).id;
    const row = r.sched.row('med', weekly, '08:00') as PingRow;
    const first = new Date(row.nextAt as string);
    expect(weekdayOf(first.toISOString().slice(0, 10))).toBe(1);
    const after = r.handler('med').next(row, first) as Date;
    expect(after.getTime() - first.getTime()).toBe(7 * 86_400_000);

    const every3 = ok(r.meds.create({ ...PLACEBIN, schedule: { freq: 'interval', interval: 3, startDay: shiftDay(DAY, 1) } }, PHONE)).id;
    expect(nextAt(r, 'med', every3, '08:00')).toBe(iso(shiftDay(DAY, 1), '08:00'));
    expect(r.handler('med').next(r.sched.row('med', every3, '08:00') as PingRow, at(shiftDay(DAY, 1), '08:00'))?.toISOString()).toBe(iso(shiftDay(DAY, 4), '08:00'));

    ok(r.meds.stopTaking(weekly, PHONE));
    expect(r.handler('med').next(row, first)).toBeNull();
  });

  it('keeps 08:00 on the wall clock across a DST change, one ring a day', () => {
    const r = setup();
    r.core.setSettings({ timezone: 'America/New_York' });
    const id = ok(r.meds.create(PLACEBIN, PHONE)).id;
    // US clocks fall back on 2026-11-01: 08:00 there is 12:00 UTC before it and 13:00 UTC after.
    const rings: string[] = [];
    for (let i = 0; i < 4; i++) {
      const due = nextAt(r, 'med', id, '08:00') as string;
      rings.push(due);
      r.core.clock.set(due);
      expect(r.sweep()).toHaveLength(1);
    }
    expect(rings).toEqual(['2026-10-30T12:00:00.000Z', '2026-10-31T12:00:00.000Z', '2026-11-01T13:00:00.000Z', '2026-11-02T13:00:00.000Z']);
  });
});

describe('LS5 and LP4: one push per dose time', () => {
  it('two medicines at 08:00 are one push "Medicines due · 2" with no names; one alone opens its dose sheet', () => {
    const r = setup();
    const testamol = ok(r.meds.create(medBody(), PHONE)).id;
    ok(r.meds.create(PLACEBIN, PHONE));
    r.core.clock.set(iso(DAY, '08:00'));
    const at8 = r.sweep();
    expect(at8).toEqual([{ kind: 'med', title: 'Medicines due · 2', body: 'Tap to log · 08:00', url: '/today', tag: 'med:08:00' }]);
    generic(at8[0] as LifePush);
    expect(r.sweep()).toEqual([]);

    r.core.clock.set(iso(DAY, '21:00'));
    const at21 = r.sweep();
    expect(at21).toEqual([{ kind: 'med', title: 'Medicine due', body: 'Tap to log · 21:00', url: `/today?dose=${testamol}@2100`, tag: `life:med:${testamol}` }]);
    generic(at21[0] as LifePush);
    expect(nextAt(r, 'med', testamol, '08:00')).toBe(iso(shiftDay(DAY, 1), '08:00'));
    expect(nextAt(r, 'med', testamol, '21:00')).toBe(iso(shiftDay(DAY, 1), '21:00'));
  });

  it('with lock-screen details on at the Mac, the push names them and their doses', () => {
    const r = setup(iso(DAY, '07:00'), { lockScreenDetails: true });
    const testamol = ok(r.meds.create(medBody(), PHONE)).id;
    ok(r.meds.create(PLACEBIN, PHONE));
    r.core.clock.set(iso(DAY, '08:00'));
    expect(r.sweep().map((p) => p.body)).toEqual(['Placebin 10 mg, Testamol 500 mg · 08:00']);
    r.core.clock.set(iso(DAY, '21:00'));
    expect(r.sweep()).toEqual([{ kind: 'med', title: 'Medicine due', body: 'Testamol 500 mg · 21:00', url: `/today?dose=${testamol}@2100`, tag: `life:med:${testamol}` }]);
  });
});

describe('LS3: a guard re-reads the medicine before each send', () => {
  it('a dose logged before 08:00 stops its ping; the other medicine still rings, alone', () => {
    const r = setup();
    const testamol = ok(r.meds.create(medBody(), PHONE)).id;
    const placebin = ok(r.meds.create(PLACEBIN, PHONE)).id;
    r.core.clock.set(iso(DAY, '07:30'));
    ok(r.meds.logDose(testamol, doseBody({ day: DAY, slot: '08:00' }), PHONE));
    r.core.clock.set(iso(DAY, '08:00'));
    expect(r.sweep()).toEqual([{ kind: 'med', title: 'Medicine due', body: 'Tap to log · 08:00', url: `/today?dose=${placebin}@0800`, tag: `life:med:${placebin}` }]);
    // The logged row still moves on, so it rings again tomorrow.
    expect(nextAt(r, 'med', testamol, '08:00')).toBe(iso(shiftDay(DAY, 1), '08:00'));
  });

  it('a skipped dose stops it too; both logged send nothing', () => {
    const r = setup();
    const testamol = ok(r.meds.create(medBody(), PHONE)).id;
    const placebin = ok(r.meds.create(PLACEBIN, PHONE)).id;
    ok(r.meds.logDose(testamol, doseBody({ status: 'skipped' }), PHONE));
    ok(r.meds.logDose(placebin, doseBody({ status: 'taken' }), PHONE));
    r.core.clock.set(iso(DAY, '08:00'));
    expect(r.sweep()).toEqual([]);
  });

  it('cancels the row of a medicine stopped or deleted behind its back, and skips a day it is not due', () => {
    const r = setup();
    const id = ok(r.meds.create(medBody(), PHONE)).id;
    const row = r.sched.row('med', id, '08:00') as PingRow;
    const h = r.handler('med');
    expect(h.check(row, at(DAY, '08:00'), false)).toBe('send');
    expect(h.check({ ...row, sub: '06:00' }, at(DAY, '06:00'), false)).toBe('cancel');
    expect(h.check(row, at(shiftDay(DAY, -1), '08:00'), false)).toBe('skip');
    const weekly = ok(r.meds.create({ ...EXAMPLEX, schedule: { freq: 'weekly', byWeekday: [weekdayOf(shiftDay(DAY, 1))] } }, PHONE)).id;
    expect(h.check({ ...row, ref: weekly }, at(DAY, '08:00'), false)).toBe('skip');
    r.core.db.prepare('DELETE FROM medicines WHERE id = ?').run(id);
    expect(h.check(row, at(DAY, '08:00'), false)).toBe('cancel');
    expect(h.next(row, at(DAY, '08:00'))).toBeNull();
  });

  it("a time moved after today's dose was taken rings from tomorrow, not tonight; moved before it, it rings tonight", () => {
    const r = setup(iso(DAY, '08:05'));
    const taken = ok(r.meds.create(PLACEBIN, PHONE)).id;
    ok(r.meds.logDose(taken, doseBody(), PHONE));
    const open = ok(r.meds.create(PLACEBIN, PHONE)).id;
    r.core.clock.set(iso(DAY, '12:00'));
    ok(r.meds.update(taken, { times: ['21:00'] }, PHONE));
    ok(r.meds.update(open, { times: ['21:00'] }, PHONE));
    r.core.clock.set(iso(DAY, '21:00'));
    expect(r.sweep()).toEqual([{ kind: 'med', title: 'Medicine due', body: 'Tap to log · 21:00', url: `/today?dose=${open}@2100`, tag: `life:med:${open}` }]);
    expect(nextAt(r, 'med', taken, '21:00')).toBe(iso(shiftDay(DAY, 1), '21:00'));
    r.core.clock.set(iso(shiftDay(DAY, 1), '21:00'));
    expect(r.sweep().map((p) => p.title)).toEqual(['Medicines due · 2']);
  });

  it('fails open: a guard that cannot read the medicine sends, and logs only the kind', () => {
    const r = setup();
    const id = ok(r.meds.create(medBody(), PHONE)).id;
    const med = r.sched.row('med', id, '08:00') as PingRow;
    const refill = r.sched.row('refill', id) as PingRow;
    vi.spyOn(r.core.db, 'prepare').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    expect(r.handler('med').check(med, at(DAY, '08:00'), false)).toBe('send');
    expect(r.handler('refill').check(refill, at(DAY, '10:00'), false)).toBe('send');
    // The push itself still says when, without the names it could not read.
    r.core.setSettings({ lockScreenDetails: true });
    expect(r.handler('med').push([med], at(DAY, '08:00'), false).body).toBe('Tap to log · 08:00');
    const warned = r.ctx.log.records.filter((x) => x.fields?.event === 'life.med.guard_failed');
    expect(warned.map((x) => x.fields?.kind)).toEqual(['med', 'refill']);
    expect(JSON.stringify(warned)).not.toContain('Testamol');
  });
});

describe('LS2: one catch-up after sleep', () => {
  it('the clock jumped 3 days over 08:00: one push "Not logged at 08:00", and the next ring is tomorrow', () => {
    const r = setup();
    const id = ok(r.meds.create(PLACEBIN, PHONE)).id;
    r.core.clock.set(iso(shiftDay(DAY, 3), '09:00'));
    const sent = r.sweep();
    expect(sent).toEqual([{ kind: 'med', title: 'Medicine due', body: 'Not logged at 08:00 · Tap to log · 08:00', url: `/today?dose=${id}@0800`, tag: `life:med:${id}` }]);
    expect(nextAt(r, 'med', id, '08:00')).toBe(iso(shiftDay(DAY, 4), '08:00'));
    expect(r.sweep()).toEqual([]);
    r.core.clock.set(iso(shiftDay(DAY, 4), '08:00'));
    expect(r.sweep().map((p) => p.body)).toEqual(['Tap to log · 08:00']);
  });

  it("checks the time it is given: the row's own stale time is a catch-up too", () => {
    const r = setup();
    const id = ok(r.meds.create(PLACEBIN, PHONE)).id;
    r.core.clock.set(iso(shiftDay(DAY, 3), '09:00'));
    const row = r.sched.row('med', id, '08:00') as PingRow;
    expect(r.handler('med').check(row, at(DAY, '08:00'), true)).toBe('send');
    expect(r.handler('med').push([row], at(DAY, '08:00'), true).body.startsWith('Not logged at 08:00')).toBe(true);
    expect(r.handler('med').next(row, r.core.now())?.toISOString()).toBe(iso(shiftDay(DAY, 4), '08:00'));
  });

  it('a late row sends nothing when that medicine has another time under 3 hours away, which then rings on time', () => {
    const r = setup();
    const id = ok(r.meds.create({ ...PLACEBIN, times: ['08:00', '10:30'] }, PHONE)).id;
    r.core.clock.set(iso(shiftDay(DAY, 3), '09:00'));
    expect(r.sweep()).toEqual([]);
    expect(nextAt(r, 'med', id, '08:00')).toBe(iso(shiftDay(DAY, 4), '08:00'));
    expect(nextAt(r, 'med', id, '10:30')).toBe(iso(shiftDay(DAY, 3), '10:30'));
    r.core.clock.set(iso(shiftDay(DAY, 3), '10:30'));
    expect(r.sweep().map((p) => p.body)).toEqual(['Tap to log · 10:30']);
  });

  it('a next time more than 3 hours away lets the catch-up through; on time, a near next time does not matter', () => {
    const r = setup();
    ok(r.meds.create({ ...PLACEBIN, times: ['08:00', '12:05'] }, PHONE));
    r.core.clock.set(iso(DAY, '09:00'));
    expect(r.sweep().map((p) => p.body)).toEqual(['Not logged at 08:00 · Tap to log · 08:00']);
    const s = setup();
    ok(s.meds.create({ ...PLACEBIN, times: ['08:00', '09:00'] }, PHONE));
    s.core.clock.set(iso(DAY, '08:00'));
    expect(s.sweep().map((p) => p.body)).toEqual(['Tap to log · 08:00']);
  });
});

describe('LS6: a catch-up whose send fails is retried', () => {
  it('under the real scheduler: the start sweep\'s failed catch-up is not moved on by the resync after it, and the next sweep sends it', async () => {
    const clock = new FakeClock(iso(DAY, '07:00'));
    const core = createTestLifeCore({ clock, tz: TZ, settings: { medicines: true } });
    const ctx = createTestContext({ clock });
    const spy = createPushSpy({ delivered: 0, failed: 1 });
    const sched = new LifeScheduler(clock, ctx.log, () => core.db, { send: spy.send });
    (core as LifeCore).scheduler = sched;
    const f = makeFakes(ctx);
    const meds = buildMedicinesModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
    const morning = () => sched.rows('med').find((x) => x.sub === '08:00');
    try {
      const id = ok(meds.create(medBody(), PHONE)).id;
      // The Mac sleeps over 08:00; at 09:00 start() sweeps (the catch-up), then resyncs every row.
      clock.set(iso(DAY, '09:00'));
      sched.start();
      await sched.settled();
      expect(spy.pushes.map((p) => p.body)).toEqual(['Not logged at 08:00 · Tap to log · 08:00']);
      expect(morning()).toMatchObject({ ref: id, nextAt: iso(DAY, '08:00'), claimedAt: null, failures: 1 });
      // A times edit that keeps 08:00 leaves its due row alone too.
      ok(meds.update(id, { times: ['08:00', '22:00'] }, PHONE));
      expect(morning()?.nextAt).toBe(iso(DAY, '08:00'));

      spy.result = { delivered: 1, failed: 0 };
      sched.sweep();
      await sched.settled();
      expect(spy.pushes.map((p) => p.body)).toEqual(['Not logged at 08:00 · Tap to log · 08:00', 'Not logged at 08:00 · Tap to log · 08:00']);
      expect(morning()?.nextAt).toBe(iso(shiftDay(DAY, 1), '08:00'));
    } finally {
      sched.stop();
      core.close();
    }
  });
});

describe('LS6 (v0.5.3): a dose ping waiting for the network', () => {
  /** The real scheduler over a medicines module, its pushes answered by `spy`. */
  function realRig(start: string) {
    const clock = new FakeClock(start);
    const core = createTestLifeCore({ clock, tz: TZ, settings: { medicines: true } });
    const ctx = createTestContext({ clock });
    const spy = createPushSpy({ delivered: 0, failed: 1, offline: 1 });
    const sched = new LifeScheduler(clock, ctx.log, () => core.db, { send: spy.send });
    (core as LifeCore).scheduler = sched;
    const f = makeFakes(ctx);
    const meds = buildMedicinesModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
    /** `ms` on the clock, a sweep (30 s) at a time, each send answered before the next. */
    const settle = async (ms: number) => {
      for (let left = ms; left > 0; left -= 30_000) {
        await clock.tick(Math.min(left, 30_000));
        await sched.settled();
        await clock.tick(0);
      }
    };
    return { clock, core, ctx, spy, sched, meds, settle, row: (sub: string) => sched.rows('med').find((x) => x.sub === sub) };
  }

  it('goes out late once the network is back, while the next time is more than 3 hours away', async () => {
    const r = realRig(iso(DAY, '07:59'));
    try {
      ok(r.meds.create({ ...PLACEBIN, times: ['08:00', '12:05'] }, PHONE));
      r.sched.start();
      await r.settle(60 * 60_000); // 08:00 to 08:59, offline every sweep
      expect(r.spy.pushes.length).toBeGreaterThan(5);
      expect(r.row('08:00')).toMatchObject({ nextAt: iso(DAY, '08:00'), failures: 0 });
      r.spy.result = { delivered: 1, failed: 0 };
      await r.settle(30_000);
      expect(r.spy.pushes.at(-1)?.body).toBe('Not logged at 08:00 · Tap to log · 08:00');
      expect(r.row('08:00')?.nextAt).toBe(iso(shiftDay(DAY, 1), '08:00'));
    } finally {
      r.sched.stop();
      r.core.close();
    }
  });

  it('is skipped, unsent, once that medicine is due again in under 3 hours; that one then rings on time', async () => {
    const r = realRig(iso(DAY, '07:59'));
    try {
      ok(r.meds.create({ ...PLACEBIN, times: ['08:00', '12:00'] }, PHONE));
      r.sched.start();
      await r.settle(70 * 60_000); // offline until 09:09, when 12:00 is under 3 hours away
      const tries = r.spy.pushes.length;
      expect(r.spy.pushes.at(-1)?.body).toBe('Not logged at 08:00 · Tap to log · 08:00');
      r.spy.result = { delivered: 1, failed: 0 };
      await r.settle(30_000);
      expect(r.spy.pushes).toHaveLength(tries);
      expect(r.row('08:00')?.nextAt).toBe(iso(shiftDay(DAY, 1), '08:00'));
      await r.settle(3 * 60 * 60_000);
      expect(r.spy.pushes.slice(tries).map((p) => p.body)).toEqual(['Tap to log · 12:00']);
    } finally {
      r.sched.stop();
      r.core.close();
    }
  });
});

describe('resync', () => {
  it('rebuilds every row from the medicines and drops rows whose medicine or time is gone', () => {
    const r = setup();
    const id = ok(r.meds.create(medBody(), PHONE)).id;
    const stopped = ok(r.meds.create(PLACEBIN, PHONE)).id;
    ok(r.meds.stopTaking(stopped, PHONE));
    r.sched.clear('med', id);
    r.sched.set('med', '01JFZ8X8Y3T0V5G9WQK2M4N6PR', '08:00', at(DAY, '08:00'));
    r.sched.set('med', id, '06:00', at(DAY, '06:00'));
    r.sched.set('med', stopped, '08:00', at(DAY, '08:00'));
    r.sched.set('refill', '01JFZ8X8Y3T0V5G9WQK2M4N6PR', '', at(DAY, '10:00'));
    r.handler('med').resync();
    r.handler('refill').resync();
    expect(r.sched.list('med').map((x) => [x.ref, x.sub, x.nextAt]).sort()).toEqual(
      [
        [id, '08:00', iso(DAY, '08:00')],
        [id, '21:00', iso(DAY, '21:00')],
      ].sort(),
    );
    expect(r.sched.list('refill').map((x) => x.ref)).toEqual([id]);
  });

  it('says how many stored medicines it cannot read, and nothing from them', () => {
    const r = setup();
    ok(r.meds.create(PLACEBIN, PHONE));
    r.core.db
      .prepare('INSERT INTO medicines (id, stopped_on, updated_at, json) VALUES (?, NULL, ?, ?)')
      .run('01JFZ8X8Y3T0V5G9WQK2M4N6PZ', iso(DAY, '07:00'), JSON.stringify({ name: 'Testamol' }));
    r.handler('med').resync();
    const warned = r.ctx.log.records.filter((x) => x.fields?.event === 'life.med.unreadable');
    expect(warned.map((x) => x.fields?.count)).toEqual([1]);
    expect(JSON.stringify(warned)).not.toContain('Testamol');
  });

  it('follows a new Life zone', () => {
    const r = setup();
    const id = ok(r.meds.create(PLACEBIN, PHONE)).id;
    r.core.setSettings({ timezone: 'UTC' });
    r.handler('med').resync();
    expect(nextAt(r, 'med', id, '08:00')).toBe(`${DAY}T08:00:00.000Z`);
  });
});

describe('refill pings', () => {
  it('ring at the next 10:00 once supply is 7 days or less, name nothing, and park', () => {
    const r = setup();
    const id = ok(r.meds.create(medBody(), PHONE)).id;
    expect(nextAt(r, 'refill', id)).toBe(iso(DAY, '10:00'));
    r.core.clock.set(iso(DAY, '08:00'));
    r.sweep();
    r.core.clock.set(iso(DAY, '10:00'));
    const sent = r.sweep();
    expect(sent).toEqual([{ kind: 'med', title: 'Medicine running low', body: 'Refill soon', url: `/meds?med=${id}`, tag: `life:refill:${id}` }]);
    generic(sent[0] as LifePush);
    expect(r.sched.row('refill', id)).toMatchObject({ nextAt: null });
  });

  it('ring once per box: the next days and their doses do not re-arm it; a new pill count does', () => {
    const r = setup();
    const id = ok(r.meds.create(medBody(), PHONE)).id;
    r.core.clock.set(iso(DAY, '10:00'));
    expect(r.sweep().filter((p) => p.title === 'Medicine running low')).toHaveLength(1);
    const tomorrow = shiftDay(DAY, 1);
    r.core.clock.set(iso(tomorrow, '08:05'));
    ok(r.meds.logDose(id, doseBody({ day: tomorrow, slot: '08:00' }), PHONE));
    r.core.clock.set(iso(tomorrow, '10:00'));
    expect(r.sweep().filter((p) => p.title === 'Medicine running low')).toEqual([]);
    expect(r.sched.row('refill', id)?.nextAt).toBeNull();

    ok(r.meds.update(id, { pills: { left: 60 } }, PHONE));
    expect(r.sched.row('refill', id)).toBeUndefined();
    ok(r.meds.update(id, { pills: { left: 12 } }, PHONE));
    expect(nextAt(r, 'refill', id)).toBe(iso(shiftDay(DAY, 2), '10:00'));
  });

  it('a ring missed by more than 6 hours sends nothing and parks; the next dose arms the next 10:00, which rings once', () => {
    const r = setup();
    const id = ok(r.meds.create(medBody(), PHONE)).id;
    const refills = (sent: LifePush[]) => sent.filter((p) => p.title === 'Medicine running low');
    // The Mac sleeps from 07:00 to 17:00: 10:00 is 7 hours gone.
    r.core.clock.set(iso(DAY, '17:00'));
    expect(refills(r.sweep())).toEqual([]);
    expect(r.sched.row('refill', id)).toMatchObject({ nextAt: null, lastSentAt: null });
    const tomorrow = shiftDay(DAY, 1);
    r.core.clock.set(iso(tomorrow, '08:05'));
    ok(r.meds.logDose(id, doseBody({ day: tomorrow, slot: '08:00' }), PHONE));
    expect(nextAt(r, 'refill', id)).toBe(iso(tomorrow, '10:00'));
    r.core.clock.set(iso(tomorrow, '10:00'));
    expect(refills(r.sweep())).toHaveLength(1);
    // Rung: neither the next dose nor a resync arms it again for this box.
    r.core.clock.set(iso(tomorrow, '21:05'));
    ok(r.meds.logDose(id, doseBody({ day: tomorrow, slot: '21:00' }), PHONE));
    r.handler('refill').resync();
    expect(r.sched.row('refill', id)?.nextAt).toBeNull();
    r.core.clock.set(iso(shiftDay(DAY, 2), '10:00'));
    expect(refills(r.sweep())).toEqual([]);
  });

  it('under the real scheduler: a restart after a ring missed by more than 6 hours arms the next 10:00, and the box rings once', async () => {
    const clock = new FakeClock(iso(DAY, '07:00'));
    const core = createTestLifeCore({ clock, tz: TZ, settings: { medicines: true } });
    const ctx = createTestContext({ clock });
    const spy = createPushSpy();
    const sched = new LifeScheduler(clock, ctx.log, () => core.db, { send: spy.send });
    (core as LifeCore).scheduler = sched;
    const f = makeFakes(ctx);
    const meds = buildMedicinesModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
    const tomorrow = shiftDay(DAY, 1);
    const refills = () => spy.pushes.filter((p) => p.title === 'Medicine running low');
    const row = () => sched.rows('refill')[0];
    // The Mac is off in between: start() sweeps once (the catch-up), then resyncs.
    const restartAt = async (t: string) => {
      sched.stop();
      clock.set(t);
      sched.start();
      await sched.settled();
    };
    try {
      const id = ok(meds.create(medBody(), PHONE)).id;
      sched.start();
      await restartAt(iso(DAY, '17:00'));
      expect(refills()).toEqual([]);
      expect(row()).toMatchObject({ ref: id, nextAt: iso(tomorrow, '10:00'), lastSentAt: null });
      await restartAt(iso(tomorrow, '10:00'));
      expect(refills()).toHaveLength(1);
      expect(row()).toMatchObject({ nextAt: null });
      expect(row()?.lastSentAt).not.toBeNull();
      ok(meds.logDose(id, doseBody({ day: tomorrow, slot: '08:00' }), PHONE));
      await restartAt(iso(shiftDay(DAY, 2), '10:00'));
      expect(refills()).toHaveLength(1);
    } finally {
      sched.stop();
      core.close();
    }
  });

  it('a supply no longer low by 10:00 is not pinged; a count with no supply problem arms nothing', () => {
    const r = setup();
    const id = ok(r.meds.create(medBody({ pills: { left: 16, perDose: 1 } }), PHONE)).id;
    expect(r.sched.row('refill', id)).toBeUndefined();
    r.core.clock.set(iso(DAY, '08:05'));
    const dose = ok(r.meds.logDose(id, doseBody(), PHONE)).id;
    expect(nextAt(r, 'refill', id)).toBe(iso(DAY, '10:00'));
    ok(r.meds.undoDose(id, dose, PHONE));
    r.core.clock.set(iso(DAY, '10:00'));
    expect(r.sweep().filter((p) => p.title === 'Medicine running low')).toEqual([]);
    expect(r.sched.row('refill', id)).toBeUndefined();
    const none = ok(r.meds.create(PLACEBIN, PHONE)).id;
    expect(r.sched.row('refill', none)).toBeUndefined();
  });

  it('with details on, say how many days are left; a catch-up says when it was missed', () => {
    const r = setup(iso(DAY, '07:00'), { lockScreenDetails: true });
    const id = ok(r.meds.create(medBody(), PHONE)).id;
    const row = r.sched.row('refill', id) as PingRow;
    expect(r.handler('refill').push([row], at(DAY, '10:00'), false).body).toBe('Testamol: 5 days left');
    r.core.setSettings({ lockScreenDetails: false });
    expect(r.handler('refill').push([row], at(DAY, '10:00'), true).body).toBe('Missed at 10:00 · Refill soon');
  });

  it('end with Stop and Delete', () => {
    const r = setup();
    const a = ok(r.meds.create(medBody(), PHONE)).id;
    const b = ok(r.meds.create(medBody(), PHONE)).id;
    const row = r.sched.row('refill', a) as PingRow;
    ok(r.meds.stopTaking(a, PHONE));
    ok(r.meds.remove(b, PHONE));
    expect(r.sched.list('refill')).toEqual([]);
    expect(r.handler('refill').check(row, at(DAY, '10:00'), false)).toBe('cancel');
  });
});
