/**
 * The one Life scheduler (life/scheduler.ts), on an in-memory life.db and a
 * FakeClock, with fake handlers (each a daily time) and a recording sender:
 *
 * - LS1 claim: a sweep and the exact timer at the same instant send one
 *   push; another process's claim under 2 minutes old is honoured, an older
 *   one is not.
 * - LS2 catch-up once (scheduler part): the clock jumping 3 days over a
 *   daily 08:00 todo and medicine gives one push each, marked late for the
 *   latest missed 08:00, and the next ring is tomorrow; a catch-up past
 *   6 hours sends nothing and moves on.
 * - LS4 a medicine check that throws still sends; a todo's does not.
 * - LS6 every device failing: retried each sweep, given up after 5 with the
 *   row moved on; no device to send to counts as sent. v0.5.3: a push that
 *   never left the Mac (offline) waits for the network, counting nothing
 *   and logged once, then goes once, late (`waited`); more than 6 hours of
 *   it moves the row on unsent; one device offline and another refused
 *   counts a failure.
 * - LS7 (scheduler part) a daily 01:30 timed todo in America/New_York rings
 *   once on the day clocks go back, a 02:30 one once at 03:30 on the day
 *   they go forward; Asia/Kolkata is unchanged.
 * - LS8 a sender that never answers ends the send at 30 s as a failure, and
 *   the sweeps at 30 s, 60 s and 150 s never claim that row again.
 * - v0.5.3: a sweep whose read fails still arms the exact timer, so the
 *   next row rings on time, not at the next sweep; one that cannot read the
 *   earliest row either keeps the timer it had. A producer's new time for a
 *   waiting row is a new wait (logged again; sent with none, not `waited`).
 * Plus: rows due in the same minute with one group key go out as one push;
 * a muted reminder waits, and a pile of them never keeps a medicine row
 * from being read; cancel deletes, skip moves on; a module that is off
 * rings nothing.
 */
import { dayKeyOf, hhmmOf, instantAt, shiftDay } from '@jantar/life-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Clock, LifeCore, LifePush, PingHandler, PingKind, PingRow } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { memoryLogger } from '../../src/core/log.js';
import { MemorySettingsStore } from '../../src/config.js';
import { CLAIM_LEASE_MS, MAX_FAILURES, PingsRepo, SWEEP_LIMIT } from '../../src/life/pings.js';
import type { LifeSend, LifeSendResult } from '../../src/life/push.js';
import { LifeScheduler } from '../../src/life/scheduler.js';
import { buildTodosModule } from '../../src/life/todos/module.js';
import { makeFakes } from '../api/fakes.js';
import { createTestContext, createTestLifeCore } from '../../src/core/testing.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface Sent {
  push: LifePush;
  at: string;
}

interface Recorder {
  sent: Sent[];
  result: LifeSendResult;
  hang: boolean;
  send: LifeSend;
}

/** A sender that records each push with the clock's time and answers `result` (or never, while `hang`). */
function recorder(clock: Pick<Clock, 'iso'>): Recorder {
  const sent: Sent[] = [];
  const r: Recorder = {
    sent,
    result: { delivered: 1, failed: 0 },
    hang: false,
    send: async (push) => {
      sent.push({ push, at: clock.iso() });
      if (r.hang) return new Promise<LifeSendResult>(() => {});
      return { ...r.result };
    },
  };
  return r;
}

/** A clock whose `now()` can jump ahead without running timers (a Mac asleep), on top of a FakeClock. */
function sleepyClock(start: string) {
  const fake = new FakeClock(start);
  let skew = 0;
  const clock: Clock = {
    now: () => fake.now() + skew,
    iso: (ms) => new Date(ms ?? fake.now() + skew).toISOString(),
    setTimeout: (fn, ms) => fake.setTimeout(fn, ms),
    clearTimeout: (id) => fake.clearTimeout(id),
    setInterval: (fn, ms) => fake.setInterval(fn, ms),
    clearInterval: (id) => fake.clearInterval(id),
    sleep: (ms, signal) => fake.sleep(ms, signal),
  };
  return {
    clock,
    fake,
    /** Time passes with no timer running, then the Mac wakes. */
    sleep(ms: number) {
      skew += ms;
    },
    async tick(ms: number) {
      await fake.tick(ms);
    },
  };
}

function rig(start = '2026-01-15T07:00:00.000Z', opts: { kinds?: () => readonly PingKind[] } = {}) {
  // The test core's in-memory life.db; time comes from the sleepy clock below.
  const db = createTestLifeCore().db;
  const sleepy = sleepyClock(start);
  const log = memoryLogger();
  const rec = recorder(sleepy.clock);
  const sched = new LifeScheduler(sleepy.clock, log, () => db, { send: rec.send, ...(opts.kinds ? { kinds: opts.kinds } : {}) });
  const repo = new PingsRepo(() => db);
  const settle = async (ms = 0) => {
    await sleepy.tick(ms);
    await sched.settled();
    await sleepy.tick(0);
  };
  return { db, sleepy, clock: sleepy.clock, log, rec, sched, repo, settle };
}

type Rig = ReturnType<typeof rig>;
let open: Rig[] = [];
afterEach(() => {
  for (const r of open) {
    r.sched.stop();
    r.db.close();
  }
  open = [];
});
function make(...args: Parameters<typeof rig>): Rig {
  const r = rig(...args);
  open.push(r);
  return r;
}

const pushKind = (k: PingKind): LifePush['kind'] => (k === 'med' || k === 'refill' ? 'med' : 'life');

/** A handler for a thing that rings every day at `hhmm` UTC. */
function daily(kind: PingKind, hhmm: string, over: Partial<PingHandler> = {}): PingHandler & { checks: { ref: string; dueAt: string; late: boolean }[] } {
  const checks: { ref: string; dueAt: string; late: boolean }[] = [];
  return {
    kind,
    checks,
    check(row, dueAt, late) {
      checks.push({ ref: row.ref, dueAt: dueAt.toISOString(), late });
      return 'send';
    },
    push(rows, dueAt, late) {
      const time = hhmmOf(dueAt, 'UTC');
      const lead = late ? `${kind === 'med' ? 'Not logged' : 'Missed'} at ${time} · ` : '';
      return {
        kind: pushKind(kind),
        title: rows.length > 1 ? `Due · ${rows.length}` : 'Due',
        body: `${lead}Tap to open · ${time}`,
        url: '/today',
        tag: rows.length > 1 ? `med:${time}` : `life:${kind}:${rows[0]?.ref}`,
      };
    },
    next(_row, after) {
      const day = dayKeyOf(after, 'UTC');
      const today = instantAt(day, hhmm, 'UTC');
      return today.getTime() > after.getTime() ? today : instantAt(shiftDay(day, 1), hhmm, 'UTC');
    },
    resync() {},
    ...over,
  };
}

const at = (iso: string) => new Date(iso);

describe('LS1: claim before send', () => {
  it('a sweep and the exact timer at the same instant send one push', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    r.sched.register(daily('todo', '08:00'));
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.sched.start(); // the start sweep claims it; its push is on its way
    r.sched.sweep(); // the exact timer, the same instant
    r.sched.sweep(); // and the interval
    await r.settle();
    expect(r.rec.sent).toHaveLength(1);
  });

  it('the interval sweep and the near timer both due at 08:00 ring once', async () => {
    const r = make('2026-01-15T07:59:30.000Z');
    r.sched.register(daily('todo', '08:00'));
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.sched.start();
    // The interval sweep (every 30 s) and the near timer both fall on 08:00:00.
    await r.settle(30_000);
    expect(r.rec.sent).toHaveLength(1);
    expect(r.rec.sent[0]?.at).toBe('2026-01-15T08:00:00.000Z');
    expect(r.repo.get('todo', 'T1')?.nextAt).toBe('2026-01-16T08:00:00.000Z');
    expect(r.repo.get('todo', 'T1')?.lastSentAt).toBe('2026-01-15T08:00:00.000Z');
  });

  it('the exact timer rings on the minute between two sweeps', async () => {
    const r = make('2026-01-15T07:59:00.000Z');
    r.sched.register(daily('todo', '08:00'));
    r.sched.start();
    r.sched.set('todo', 'T1', '', at('2026-01-15T07:59:45.000Z'));
    r.sched.poke();
    await r.settle(45_000);
    expect(r.rec.sent.map((s) => s.at)).toEqual(['2026-01-15T07:59:45.000Z']);
  });

  it("another process's claim under 2 minutes old is honoured; an older one is not", async () => {
    const a = make('2026-01-15T08:00:00.000Z');
    a.sched.register(daily('todo', '08:00'));
    a.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    // A sweep of a process that died mid-send claimed it 1 minute ago.
    a.db.prepare("UPDATE pings SET claimed_at = '2026-01-15T07:59:00.000Z'").run();
    a.sched.start();
    await a.settle();
    expect(a.rec.sent).toHaveLength(0);
    // Once the claim is older than the lease, the row is ours.
    await a.settle(CLAIM_LEASE_MS);
    expect(a.rec.sent).toHaveLength(1);
  });

  it('two schedulers on one database at the same instant: one claim wins, one push', async () => {
    const a = make('2026-01-15T08:00:00.000Z');
    const h = daily('todo', '08:00');
    a.sched.register(h);
    a.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    const sent: LifePush[] = [];
    const b = new LifeScheduler(a.clock, a.log, () => a.db, { send: async (p) => (sent.push(p), { delivered: 1, failed: 0 }) });
    b.register(h);
    a.sched.start();
    b.start();
    await a.settle();
    await b.settled();
    expect(a.rec.sent.length + sent.length).toBe(1);
    b.stop();
  });
});

describe('LS2: catch-up once', () => {
  it('3 days asleep over a daily 08:00 todo and medicine: one push each for the latest 08:00, late; next is tomorrow', async () => {
    const r = make('2026-01-15T07:00:00.000Z');
    const todo = daily('todo', '08:00');
    const med = daily('med', '08:00', { group: (row) => row.sub });
    r.sched.register(todo);
    r.sched.register(med);
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.sched.set('med', 'M1', '08:00', at('2026-01-15T08:00:00.000Z'));
    r.sched.start();
    // The lid shuts at 07:00 and opens three days later at 09:10.
    r.sleepy.sleep(3 * DAY + 2 * HOUR + 10 * MIN);
    await r.settle(30_000);
    expect(r.rec.sent).toHaveLength(2);
    const medPush = r.rec.sent.find((s) => s.push.kind === 'med')?.push;
    const todoPush = r.rec.sent.find((s) => s.push.kind === 'life')?.push;
    expect(medPush?.body).toMatch(/^Not logged at 08:00 · /);
    expect(todoPush?.body).toMatch(/^Missed at 08:00 · /);
    expect(med.checks).toEqual([{ ref: 'M1', dueAt: '2026-01-18T08:00:00.000Z', late: true }]);
    expect(r.repo.get('todo', 'T1')?.nextAt).toBe('2026-01-19T08:00:00.000Z');
    expect(r.repo.get('med', 'M1', '08:00')?.nextAt).toBe('2026-01-19T08:00:00.000Z');
    // And nothing more until then.
    await r.settle(10 * MIN);
    expect(r.rec.sent).toHaveLength(2);
  });

  it('a restart over a missed ring: the start sweep sends it once, late', async () => {
    const r = make('2026-01-15T09:30:00.000Z');
    const h = daily('todo', '08:00');
    r.sched.register(h);
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.sched.start();
    await r.settle();
    expect(r.rec.sent).toHaveLength(1);
    expect(r.rec.sent[0]?.push.body).toBe('Missed at 08:00 · Tap to open · 08:00');
    expect(h.checks[0]?.late).toBe(true);
    await r.settle(5 * MIN);
    expect(r.rec.sent).toHaveLength(1);
  });

  it('a catch-up more than 6 hours late is not sent; the row moves on', async () => {
    const r = make('2026-01-15T07:00:00.000Z');
    const h = daily('todo', '08:00');
    r.sched.register(h);
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.sched.start();
    r.sleepy.sleep(8 * HOUR); // wakes at 15:00, 7 hours after 08:00
    await r.settle(30_000);
    expect(r.rec.sent).toHaveLength(0);
    expect(h.checks).toHaveLength(0);
    expect(r.repo.get('todo', 'T1')?.nextAt).toBe('2026-01-16T08:00:00.000Z');
  });

  it('a row under 2 minutes behind is on time, not late', async () => {
    const r = make('2026-01-15T08:01:00.000Z');
    const h = daily('todo', '08:00');
    r.sched.register(h);
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.sched.start();
    await r.settle();
    expect(h.checks).toEqual([{ ref: 'T1', dueAt: '2026-01-15T08:00:00.000Z', late: false }]);
    expect(r.rec.sent[0]?.push.body).toBe('Tap to open · 08:00');
  });
});

describe('checks', () => {
  it('LS4: a medicine check that throws still sends (fails open); a todo check that throws skips', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    const boom = () => {
      throw new Error('source unreadable');
    };
    r.sched.register(daily('med', '08:00', { check: boom }));
    r.sched.register(daily('todo', '08:00', { check: boom }));
    r.sched.register(daily('refill', '08:00', { check: boom }));
    r.sched.set('med', 'M1', '08:00', at('2026-01-15T08:00:00.000Z'));
    r.sched.set('refill', 'M1', '', at('2026-01-15T08:00:00.000Z'));
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.sched.start();
    await r.settle();
    expect(r.rec.sent.map((s) => s.push.tag).sort()).toEqual(['life:med:M1', 'life:refill:M1']);
    // The skipped todo moved on to its next time without a send.
    expect(r.repo.get('todo', 'T1')).toMatchObject({ nextAt: '2026-01-16T08:00:00.000Z', lastSentAt: null });
    // The log has the kinds, never the message.
    expect(JSON.stringify(r.log.records)).not.toContain('source unreadable');
  });

  it('cancel deletes the row; skip moves it on without a send', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    r.sched.register(daily('bill', '08:00', { check: () => 'cancel' }));
    r.sched.register(daily('todo', '08:00', { check: () => 'skip' }));
    r.sched.set('bill', 'B1', '', at('2026-01-15T08:00:00.000Z'));
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.sched.start();
    await r.settle();
    expect(r.rec.sent).toHaveLength(0);
    expect(r.repo.get('bill', 'B1')).toBeUndefined();
    expect(r.repo.get('todo', 'T1')?.nextAt).toBe('2026-01-16T08:00:00.000Z');
  });

  it('a next() of null parks the row: nothing rings until its producer sets it again', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    r.sched.register(daily('todo', '08:00', { next: () => null }));
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.sched.start();
    await r.settle();
    expect(r.repo.get('todo', 'T1')?.nextAt).toBeNull();
    await r.settle(DAY);
    expect(r.rec.sent).toHaveLength(1);
  });
});

describe('groups', () => {
  it('rows due in the same minute with one group key go out as one push', async () => {
    const r = make('2026-01-15T07:59:00.000Z');
    const med = daily('med', '08:00', { group: (row) => row.sub });
    r.sched.register(med);
    r.sched.set('med', 'M1', '08:00', at('2026-01-15T08:00:00.000Z'));
    r.sched.set('med', 'M2', '08:00', at('2026-01-15T08:00:00.000Z'));
    r.sched.set('med', 'M3', '21:00', at('2026-01-15T21:00:00.000Z'));
    r.sched.start();
    await r.settle(MIN);
    expect(r.rec.sent).toHaveLength(1);
    expect(r.rec.sent[0]?.push).toMatchObject({ kind: 'med', title: 'Due · 2', tag: 'med:08:00' });
    expect(r.repo.get('med', 'M1', '08:00')?.nextAt).toBe('2026-01-16T08:00:00.000Z');
    expect(r.repo.get('med', 'M2', '08:00')?.nextAt).toBe('2026-01-16T08:00:00.000Z');
  });

  it('without a group key, each row is its own push', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    r.sched.register(daily('todo', '08:00'));
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.sched.set('todo', 'T2', '', at('2026-01-15T08:00:00.000Z'));
    r.sched.start();
    await r.settle();
    expect(r.rec.sent).toHaveLength(2);
  });
});

describe('LS6: failures', () => {
  it('every device failing: retried each sweep, given up after 5 with the row moved on and a log line', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    r.sched.register(daily('todo', '08:00'));
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.rec.result = { delivered: 0, failed: 2 };
    r.sched.start();
    await r.settle();
    expect(r.rec.sent).toHaveLength(1);
    expect(r.repo.get('todo', 'T1')).toMatchObject({ nextAt: '2026-01-15T08:00:00.000Z', claimedAt: null, failures: 1 });
    for (let i = 2; i <= MAX_FAILURES; i++) await r.settle(30_000);
    expect(r.rec.sent).toHaveLength(MAX_FAILURES);
    expect(r.repo.get('todo', 'T1')).toMatchObject({ nextAt: '2026-01-16T08:00:00.000Z', failures: 0, lastSentAt: null });
    expect(r.log.records.some((e) => e.fields.event === 'life.ping.gave_up' && e.fields.kind === 'todo')).toBe(true);
    await r.settle(30_000);
    expect(r.rec.sent).toHaveLength(MAX_FAILURES);
  });

  it('one device delivered while another failed counts as sent', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    r.sched.register(daily('todo', '08:00'));
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.rec.result = { delivered: 1, failed: 1 };
    r.sched.start();
    await r.settle();
    expect(r.repo.get('todo', 'T1')).toMatchObject({ nextAt: '2026-01-16T08:00:00.000Z', failures: 0 });
  });

  it('no device to send to counts as sent', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    r.sched.register(daily('todo', '08:00'));
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.rec.result = { delivered: 0, failed: 0 };
    r.sched.start();
    await r.settle();
    expect(r.repo.get('todo', 'T1')).toMatchObject({ nextAt: '2026-01-16T08:00:00.000Z', lastSentAt: '2026-01-15T08:00:00.000Z' });
    await r.settle(30_000);
    expect(r.rec.sent).toHaveLength(1);
  });

  it('a sender that throws is a failure, retried', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    let calls = 0;
    const sched = new LifeScheduler(r.clock, r.log, () => r.db, {
      send: async () => {
        calls += 1;
        throw new Error('network');
      },
    });
    sched.register(daily('todo', '08:00'));
    sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    sched.start();
    await r.sleepy.tick(0);
    await sched.settled();
    expect(r.repo.get('todo', 'T1')?.failures).toBe(1);
    await r.sleepy.tick(30_000);
    await sched.settled();
    expect(calls).toBe(2);
    sched.stop();
  });

  it('a muted reminder keeps its time and counts nothing, then goes once the mute ends', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    r.sched.register(daily('todo', '08:00'));
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.rec.result = { delivered: 0, failed: 0, muted: true };
    r.sched.start();
    await r.settle();
    await r.settle(30_000);
    expect(r.repo.get('todo', 'T1')).toMatchObject({ nextAt: '2026-01-15T08:00:00.000Z', failures: 0, claimedAt: null });
    r.rec.result = { delivered: 1, failed: 0 };
    await r.settle(30_000);
    expect(r.repo.get('todo', 'T1')?.nextAt).toBe('2026-01-16T08:00:00.000Z');
    expect(r.rec.sent).toHaveLength(3);
  });
});

describe('LS6: a push that never left the Mac waits for the network (v0.5.3)', () => {
  const waitingLines = (r: Rig) => r.log.records.filter((e) => e.msg === 'life push waiting for the network');

  it('offline for more sweeps than MAX_FAILURES: still due, nothing counted, one log line; then it goes once, late', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    r.sched.register(daily('todo', '08:00'));
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.rec.result = { delivered: 0, failed: 1, offline: 1 };
    r.sched.start();
    await r.settle();
    for (let i = 0; i < MAX_FAILURES + 2; i++) await r.settle(30_000);
    expect(r.rec.sent).toHaveLength(MAX_FAILURES + 3);
    expect(r.repo.get('todo', 'T1')).toMatchObject({ nextAt: '2026-01-15T08:00:00.000Z', claimedAt: null, failures: 0, lastSentAt: null });
    expect(r.log.records.some((e) => e.fields.event === 'life.ping.gave_up')).toBe(false);
    expect(r.log.records.some((e) => e.msg === 'life push not delivered')).toBe(false);
    expect(waitingLines(r).map((e) => e.fields)).toEqual([{ kind: 'todo', rows: 1 }]);
    // The network is back: one push, marked late, and the row moves on.
    r.rec.result = { delivered: 1, failed: 0 };
    await r.settle(30_000);
    expect(r.rec.sent).toHaveLength(MAX_FAILURES + 4);
    expect(r.rec.sent.at(-1)?.push.body).toBe('Missed at 08:00 · Tap to open · 08:00');
    expect(r.repo.get('todo', 'T1')).toMatchObject({ nextAt: '2026-01-16T08:00:00.000Z', failures: 0, lastSentAt: r.clock.iso() });
    expect(r.log.records.find((e) => e.msg === 'life push sent')?.fields).toMatchObject({ kind: 'todo', late: true, waited: true });
    await r.settle(5 * MIN);
    expect(r.rec.sent).toHaveLength(MAX_FAILURES + 4);
  });

  it('a Mac asleep with no network: each dark wake waits; once more than 6 hours behind, the row moves on unsent', async () => {
    const r = make('2026-01-15T07:59:00.000Z');
    r.sched.register(daily('med', '08:00', { group: (row) => row.sub }));
    r.sched.set('med', 'M1', '08:00', at('2026-01-15T08:00:00.000Z'));
    r.rec.result = { delivered: 0, failed: 1, offline: 1 };
    r.sched.start();
    await r.settle(MIN);
    // Dark wakes, each one sweep, from 08:00 to 13:50.
    for (let i = 0; i < 7; i++) {
      r.sleepy.sleep(50 * MIN);
      await r.settle(30_000);
    }
    expect(r.repo.get('med', 'M1', '08:00')).toMatchObject({ nextAt: '2026-01-15T08:00:00.000Z', failures: 0 });
    const tries = r.rec.sent.length;
    expect(tries).toBeGreaterThan(MAX_FAILURES);
    r.sleepy.sleep(30 * MIN); // 14:21: more than 6 hours behind
    await r.settle(30_000);
    expect(r.rec.sent).toHaveLength(tries);
    expect(r.repo.get('med', 'M1', '08:00')).toMatchObject({ nextAt: '2026-01-16T08:00:00.000Z', failures: 0, lastSentAt: null });
    expect(r.log.records.some((e) => e.msg === 'life ping too late to send' && e.fields.kind === 'med')).toBe(true);
    expect(waitingLines(r)).toHaveLength(1);
  });

  it('one device offline and another refusing counts a failure, as before', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    r.sched.register(daily('todo', '08:00'));
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.rec.result = { delivered: 0, failed: 2, offline: 1 };
    r.sched.start();
    await r.settle();
    expect(r.repo.get('todo', 'T1')).toMatchObject({ nextAt: '2026-01-15T08:00:00.000Z', failures: 1 });
    expect(waitingLines(r)).toEqual([]);
    expect(r.log.records.some((e) => e.msg === 'life push not delivered')).toBe(true);
  });

  it('a row that waited, then failed for real, counts from there; a second wait is not logged again', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    r.sched.register(daily('todo', '08:00'));
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.rec.result = { delivered: 0, failed: 1, offline: 1 };
    r.sched.start();
    await r.settle();
    r.rec.result = { delivered: 0, failed: 1 };
    await r.settle(30_000);
    expect(r.repo.get('todo', 'T1')?.failures).toBe(1);
    r.rec.result = { delivered: 0, failed: 1, offline: 1 };
    await r.settle(30_000);
    expect(r.repo.get('todo', 'T1')?.failures).toBe(1);
    expect(waitingLines(r)).toHaveLength(1);
  });

  it("a producer's new time is a new wait, logged again; sent there with no wait, it is not marked waited", async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    r.sched.register(daily('todo', '08:00'));
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.rec.result = { delivered: 0, failed: 1, offline: 1 };
    r.sched.start();
    await r.settle();
    // Snoozed to 08:02 (the todo's set): still no network there.
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:02:00.000Z'));
    await r.settle(2 * MIN);
    expect(waitingLines(r)).toHaveLength(2);
    // Snoozed again to 08:05, and the network is back by then.
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:05:00.000Z'));
    r.rec.result = { delivered: 1, failed: 0 };
    await r.settle(3 * MIN);
    const sent = r.log.records.filter((e) => e.msg === 'life push sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.fields).not.toHaveProperty('waited');
  });

  it('a waiting row its producer clears (a todo done or deleted offline) waits no more; another row still does', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    r.sched.register(daily('todo', '08:00'));
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.sched.set('todo', 'T2', '', at('2026-01-15T08:00:00.000Z'));
    r.rec.result = { delivered: 0, failed: 1, offline: 1 };
    r.sched.start();
    await r.settle();
    const waiting = (r.sched as unknown as { waiting: Map<string, string> }).waiting;
    const t2 = r.repo.get('todo', 'T2')?.id;
    expect(waiting.size).toBe(2);
    r.sched.clear('todo', 'T1');
    expect([...waiting.keys()]).toEqual([t2]);
  });
});

describe('the near timer after a failed read (v0.5.3)', () => {
  it('a sweep whose read throws still arms the timer: the next row rings on time, not at the next sweep', async () => {
    const r = make('2026-01-15T07:59:40.000Z');
    r.sched.register(daily('todo', '08:00'));
    r.sched.set('todo', 'T1', '', at('2026-01-15T07:59:57.000Z'));
    r.sched.set('todo', 'T2', '', at('2026-01-15T08:00:00.000Z'));
    r.sched.start(); // the near timer for 07:59:57; the interval sweeps at 08:00:10 and 08:00:40
    const due = vi.spyOn(PingsRepo.prototype, 'due').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    await r.settle(17_000); // 07:59:57: the timer's sweep cannot read
    expect(due).toHaveBeenCalled();
    expect(r.log.records.some((e) => e.msg === 'life sweep failed')).toBe(true);
    expect(r.rec.sent).toHaveLength(0);
    await r.settle(3_000); // 08:00:00
    expect(r.rec.sent.map((x) => [x.at, x.push.tag])).toEqual([
      ['2026-01-15T08:00:00.000Z', 'life:todo:T1'],
      ['2026-01-15T08:00:00.000Z', 'life:todo:T2'],
    ]);
  });

  it('a sweep that cannot find the earliest row either keeps the timer it had: that row still rings on time', async () => {
    const r = make('2026-01-15T07:59:00.000Z');
    r.sched.register(daily('todo', '08:00'));
    r.sched.set('todo', 'T1', '', at('2026-01-15T07:59:50.000Z'));
    r.sched.start(); // the near timer for 07:59:50; the interval sweeps at 07:59:30 and 08:00:00
    const locked = (): never => {
      throw new Error('database is locked');
    };
    vi.spyOn(PingsRepo.prototype, 'due').mockImplementationOnce(locked);
    const earliest = vi.spyOn(PingsRepo.prototype, 'earliest').mockImplementationOnce(locked);
    await r.settle(30_000); // 07:59:30: neither read works
    expect(earliest).toHaveBeenCalled();
    expect(r.rec.sent).toHaveLength(0);
    await r.settle(20_000); // 07:59:50
    expect(r.rec.sent.map((x) => [x.at, x.push.tag])).toEqual([['2026-01-15T07:59:50.000Z', 'life:todo:T1']]);
  });
});

describe('stop and detach', () => {
  it('a send in flight across stop() and start() (the last module off, then on) rings once', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    let answer: (res: LifeSendResult) => void = () => {};
    const sent: string[] = [];
    const sched = new LifeScheduler(r.clock, r.log, () => r.db, {
      send: (p) => {
        sent.push(`${r.clock.iso()} ${p.title}`);
        return new Promise<LifeSendResult>((ok) => (answer = ok));
      },
    });
    sched.register(daily('todo', '08:00'));
    sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    sched.start();
    await r.sleepy.tick(0);
    expect(sent).toHaveLength(1);
    sched.stop();
    answer({ delivered: 1, failed: 0 });
    await sched.settled();
    // Delivered while stopped: the row has moved on to tomorrow all the same.
    expect(r.repo.get('todo', 'T1')).toMatchObject({ nextAt: '2026-01-16T08:00:00.000Z', claimedAt: null, lastSentAt: '2026-01-15T08:00:00.000Z' });
    await r.sleepy.tick(10_000);
    sched.start();
    await r.sleepy.tick(CLAIM_LEASE_MS + 60_000);
    await sched.settled();
    expect(sent).toHaveLength(1);
    sched.stop();
  });

  it('after detach() (the handle closing) a delivery in flight writes nothing', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    let answer: (res: LifeSendResult) => void = () => {};
    const sched = new LifeScheduler(r.clock, r.log, () => r.db, { send: () => new Promise<LifeSendResult>((ok) => (answer = ok)) });
    sched.register(daily('todo', '08:00'));
    sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    sched.start();
    await r.sleepy.tick(0);
    sched.stop();
    sched.detach();
    answer({ delivered: 1, failed: 0 });
    await sched.settled();
    expect(r.repo.get('todo', 'T1')?.nextAt).toBe('2026-01-15T08:00:00.000Z');
  });
});

describe('the sweep read', () => {
  it('a pile of muted reminders (still due) never keeps a medicine row out of the sweep', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    const sent: LifePush['kind'][] = [];
    const sched = new LifeScheduler(r.clock, r.log, () => r.db, {
      send: async (p) => {
        sent.push(p.kind);
        return p.kind === 'med' ? { delivered: 1, failed: 0 } : { delivered: 0, failed: 0, muted: true };
      },
    });
    sched.register(daily('todo', '08:00'));
    sched.register(daily('med', '08:05', { group: (row) => row.sub }));
    for (let i = 0; i < SWEEP_LIMIT; i++) sched.set('todo', `T${i}`, '', at('2026-01-15T08:00:00.000Z'));
    sched.set('med', 'M1', '08:05', at('2026-01-15T08:05:00.000Z'));
    sched.start();
    for (let i = 0; i < 12; i++) {
      await r.sleepy.tick(30_000);
      await sched.settled();
    }
    expect(sent.filter((k) => k === 'med')).toHaveLength(1);
    expect(r.repo.get('med', 'M1', '08:05')?.nextAt).toBe('2026-01-16T08:05:00.000Z');
    sched.stop();
  });
});

describe('LS8: the send deadline', () => {
  it('a sender that never answers fails at 30 s; sweeps at 30 s, 60 s and 150 s never claim the row again', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    r.sched.register(daily('med', '08:00'));
    r.sched.set('med', 'M1', '08:00', at('2026-01-15T08:00:00.000Z'));
    r.rec.hang = true;
    r.sched.start();
    await r.sleepy.tick(0);
    expect(r.rec.sent).toHaveLength(1);
    expect(r.repo.get('med', 'M1', '08:00')?.claimedAt).toBe('2026-01-15T08:00:00.000Z');
    await r.sleepy.tick(30_000);
    // The deadline passed: a failure, the claim released, next_at kept.
    expect(r.repo.get('med', 'M1', '08:00')).toMatchObject({ failures: 1, claimedAt: null, nextAt: '2026-01-15T08:00:00.000Z' });
    await r.sleepy.tick(30_000); // 60 s
    await r.sleepy.tick(90_000); // 150 s: past the claim lease too
    expect(r.rec.sent).toHaveLength(1);
    expect(r.log.records.some((e) => e.fields.why === 'deadline')).toBe(true);
  });

  it('once the slow send ends, the next sweep may retry the row', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    let release: (v: LifeSendResult) => void = () => {};
    let calls = 0;
    const sched = new LifeScheduler(r.clock, r.log, () => r.db, {
      send: () => {
        calls += 1;
        return calls === 1 ? new Promise<LifeSendResult>((res) => (release = res)) : Promise.resolve({ delivered: 1, failed: 0 });
      },
    });
    sched.register(daily('med', '08:00'));
    sched.set('med', 'M1', '08:00', at('2026-01-15T08:00:00.000Z'));
    sched.start();
    await r.sleepy.tick(60_000);
    expect(calls).toBe(1);
    release({ delivered: 0, failed: 1 });
    await r.sleepy.tick(0); // the send ends: the row leaves `sending`
    await r.sleepy.tick(30_000);
    await sched.settled();
    expect(calls).toBe(2);
    expect(r.repo.get('med', 'M1', '08:00')?.nextAt).toBe('2026-01-16T08:00:00.000Z');
    sched.stop();
  });

  it('a slow send that ends past the deadline but delivered moves the row on then: the next sweep never sends it twice', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    let release: (v: LifeSendResult) => void = () => {};
    let calls = 0;
    const sched = new LifeScheduler(r.clock, r.log, () => r.db, {
      send: () => {
        calls += 1;
        return calls === 1 ? new Promise<LifeSendResult>((res) => (release = res)) : Promise.resolve({ delivered: 1, failed: 0 });
      },
    });
    sched.register(daily('med', '08:00'));
    sched.set('med', 'M1', '08:00', at('2026-01-15T08:00:00.000Z'));
    sched.start();
    await r.sleepy.tick(40_000);
    // The deadline passed: counted as a failure, next_at kept.
    expect(r.repo.get('med', 'M1', '08:00')).toMatchObject({ failures: 1, claimedAt: null, nextAt: '2026-01-15T08:00:00.000Z' });
    release({ delivered: 1, failed: 0 });
    await r.sleepy.tick(0);
    expect(r.repo.get('med', 'M1', '08:00')).toMatchObject({ nextAt: '2026-01-16T08:00:00.000Z', claimedAt: null, failures: 0, lastSentAt: r.clock.iso() });
    expect(r.log.records.find((e) => e.msg === 'life push sent after its deadline')?.fields).toEqual({ kind: 'med', rows: 1, delivered: 1 });
    await r.sleepy.tick(5 * MIN);
    await sched.settled();
    expect(calls).toBe(1);
    sched.stop();
  });

  it('a late end that delivered leaves alone a row its producer moved meanwhile', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    let release: (v: LifeSendResult) => void = () => {};
    const sched = new LifeScheduler(r.clock, r.log, () => r.db, { send: () => new Promise<LifeSendResult>((res) => (release = res)) });
    sched.register(daily('todo', '08:00'));
    sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    sched.start();
    await r.sleepy.tick(40_000);
    sched.set('todo', 'T1', '', at('2026-01-15T09:00:00.000Z')); // snoozed after the deadline, before the send ended
    release({ delivered: 1, failed: 0 });
    await r.sleepy.tick(0);
    expect(r.repo.get('todo', 'T1')).toMatchObject({ nextAt: '2026-01-15T09:00:00.000Z', lastSentAt: null });
    expect(r.log.records.some((e) => e.msg === 'life push sent after its deadline')).toBe(false);
    sched.stop();
  });
});

describe('switches and producers', () => {
  it('a kind whose module is off rings nothing; on again, it rings', async () => {
    let kinds: PingKind[] = ['med'];
    const r = make('2026-01-15T08:00:00.000Z', { kinds: () => kinds });
    r.sched.register(daily('todo', '08:00'));
    r.sched.register(daily('med', '08:00'));
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.sched.start();
    await r.settle(30_000);
    expect(r.rec.sent).toHaveLength(0);
    kinds = ['med', 'todo'];
    await r.settle(30_000);
    expect(r.rec.sent).toHaveLength(1);
  });

  it('set clears a claim and failures; clear removes one row or all of a source', () => {
    const r = make();
    r.sched.set('med', 'M1', '08:00', at('2026-01-15T08:00:00.000Z'));
    r.sched.set('med', 'M1', '21:00', at('2026-01-15T21:00:00.000Z'));
    r.db.prepare("UPDATE pings SET claimed_at = 'x', failures = 3").run();
    r.sched.set('med', 'M1', '08:00', at('2026-01-16T08:00:00.000Z'));
    expect(r.repo.get('med', 'M1', '08:00')).toMatchObject({ nextAt: '2026-01-16T08:00:00.000Z', claimedAt: null, failures: 0 });
    r.sched.clear('med', 'M1', '21:00');
    expect(r.sched.rows('med')).toHaveLength(1);
    r.sched.clear('med', 'M1');
    expect(r.sched.rows()).toHaveLength(0);
  });

  it('a producer setting a row mid-send wins over the send: the row keeps the new time', async () => {
    const r = make('2026-01-15T08:00:00.000Z');
    let release: (v: LifeSendResult) => void = () => {};
    const sched = new LifeScheduler(r.clock, r.log, () => r.db, { send: () => new Promise<LifeSendResult>((res) => (release = res)) });
    sched.register(daily('todo', '08:00'));
    sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    sched.start();
    await r.sleepy.tick(0);
    sched.set('todo', 'T1', '', at('2026-01-15T09:00:00.000Z')); // snoozed while the push is on its way
    release({ delivered: 1, failed: 0 });
    await sched.settled();
    expect(r.repo.get('todo', 'T1')?.nextAt).toBe('2026-01-15T09:00:00.000Z');
    sched.stop();
  });

  it('start sweeps, then resyncs every handler; stop clears every timer', () => {
    const r = make('2026-01-15T08:00:00.000Z');
    const order: string[] = [];
    r.sched.register(
      daily('todo', '08:00', {
        check: () => (order.push('check'), 'send'),
        resync: () => {
          order.push('resync');
        },
      }),
    );
    r.sched.set('todo', 'T1', '', at('2026-01-15T08:00:00.000Z'));
    r.sched.start();
    expect(order).toEqual(['check', 'resync']);
    r.sched.stop();
    expect(r.sleepy.fake.pending()).toBe(1); // only the deadline of the push in flight
  });
});

describe('LS7: time zones with the todos module', () => {
  /** createTestLifeCore with the real scheduler in place of the recording one. */
  function todosRig(tz: string, start: string) {
    const test = createTestLifeCore({ tz, settings: { todos: true, timezone: tz } });
    test.clock.set(start);
    const rec = recorder(test.clock);
    const sched = new LifeScheduler(test.clock, memoryLogger(), () => test.db, { send: rec.send });
    const core: LifeCore = { ...test, scheduler: sched };
    const ctx = createTestContext({ clock: test.clock });
    const f = makeFakes(ctx);
    const todos = buildTodosModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
    sched.start();
    cores.push({ stop: () => sched.stop(), close: () => test.close() });
    const settle = async (ms: number) => {
      await test.clock.tick(ms);
      await sched.settled();
    };
    return { rec, todos, settle };
  }
  const cores: { stop(): void; close(): void }[] = [];
  afterEach(() => {
    for (const c of cores.splice(0)) {
      c.stop();
      c.close();
    }
  });
  const actor = { kind: 'cli' } as const;

  it('America/New_York, clocks back on 2026-11-01: a daily 01:30 rings once', async () => {
    const t = todosRig('America/New_York', '2026-11-01T04:00:00.000Z'); // 00:00 EDT
    const made = t.todos.createTodo({ title: 'Example todo', due: { day: '2026-11-01', time: '01:30' }, repeat: { freq: 'daily' } }, actor);
    expect(made.ok).toBe(true);
    for (let i = 0; i < 4 * 60; i++) await t.settle(MIN); // through 04:00 EST
    expect(t.rec.sent.map((s) => s.at)).toEqual(['2026-11-01T05:30:00.000Z']);
  });

  it('America/New_York, clocks forward on 2026-03-08: a 02:30 rings once, at 03:30', async () => {
    const t = todosRig('America/New_York', '2026-03-08T05:00:00.000Z'); // 00:00 EST
    t.todos.createTodo({ title: 'Example todo', due: { day: '2026-03-08', time: '02:30' }, repeat: { freq: 'daily' } }, actor);
    for (let i = 0; i < 4 * 60; i++) await t.settle(MIN);
    expect(t.rec.sent.map((s) => s.at)).toEqual(['2026-03-08T07:30:00.000Z']);
    expect(t.rec.sent[0]?.push.body).toMatch(/· 03:30$/);
  });

  it('Asia/Kolkata on the same day: 01:30 is 20:00 UTC the day before, once', async () => {
    const t = todosRig('Asia/Kolkata', '2026-10-31T19:00:00.000Z');
    t.todos.createTodo({ title: 'Example todo', due: { day: '2026-11-01', time: '01:30' }, repeat: { freq: 'daily' } }, actor);
    for (let i = 0; i < 3 * 60; i++) await t.settle(MIN);
    expect(t.rec.sent.map((s) => s.at)).toEqual(['2026-10-31T20:00:00.000Z']);
  });
});

/** Every row as stored, for a failing test's message. */
export function dump(rows: PingRow[]): string {
  return rows.map((r) => `${r.kind}|${r.ref}|${r.sub}|${r.nextAt}|${r.claimedAt}|${r.failures}`).join('\n');
}
