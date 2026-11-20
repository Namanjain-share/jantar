/**
 * The morning run's timer and its part of the service (0.15 Messages):
 * - MorningTimer (morning/timer.ts) on a FakeClock: once a day at the
 *   morning time in the Life zone, by the wall clock (a time the Mac slept
 *   through runs once on wake, within waitForWhatsAppMs of it, and a wait
 *   slept through to its end is left, the next morning the one run); it waits for
 *   WhatsApp to be running and quiet, and after waitForWhatsAppMs runs
 *   anyway, stale; no time set is idle; a new time or zone rearms it;
 * - the service's MorningApi (messages/service.ts) against a fake reader and
 *   a fake claude: a timer run's report says stale when WhatsApp never got
 *   ready; the cursor moves only after a run that went well (never a failed
 *   or dry one); the push says counts only; one run at a time, none under
 *   --read-only; a 1:1 still waiting is read again but never drafted twice;
 *   Life refusing the todos is in the report; Today, drafts, Undo and the times;
 *   a morning time after the call-back time still rings each call-back; a
 *   skip takes what the morning made from that chat off Today, out of the
 *   reports and out of Life, and stops a run going that read it (only); a
 *   skip while Life's todos refuse holds at once, says its todos leave
 *   later, and they leave once Life answers (life.db opening, Today),
 *   across a restart too; a skip removes its own chat's todos as whoever
 *   skipped it, another owed chat's as the system; a restored Life backup
 *   made before a skip doesn't bring that chat's todos back (life.db or
 *   messages.db opening takes them again, until the chat is unskipped),
 *   but one done at the skip and reopened since stays the owner's;
 *   each run of the day that made something keeps its summary, todos and
 *   Undo on Today (a later Run now, an empty timer run or a failed one
 *   never hides or takes the morning's); a reader of another build fails a
 *   run with the update-needed sentence; a Claude run that takes minutes
 *   still leaves every call-back ringing; Todos off drafts replies only;
 *   Run now and a dry run log their reads under their caller; a timer run
 *   refused by a dry run runs after it; a time set after it passed waits
 *   for tomorrow, across a daemon restart too (messages.db keeps the mark);
 *   a draft the owner answered in WhatsApp leaves Today.
 * Synthetic chat keys, fake numbers and invented names only.
 */
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { instantAt } from '@jantar/life-core';
import { MESSAGES_LIMITS, SettingsSchema, type Settings } from '@jantar/protocol';
import type { Call, ChatOwner, Message, MorningAnswer } from '@jantar/protocol/messages';
import { ApiError } from '../../src/api/errors.js';
import { resolvePaths } from '../../src/config.js';
import type { Actor, Clock, LifeService, MessagesService, Paths } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { createFakeExec, createPushSpy, createTestContext, createTestLifeCore, type ExecCall, type ExecHandler, type PushSpy, type TestContext, type TestLifeCore } from '../../src/core/testing.js';
import { BACKUP_CHECK_MS } from '../../src/life/backup.js';
import { buildTodosModule } from '../../src/life/todos/module.js';
import { SKIP_OWED_KEY } from '../../src/messages/db.js';
import { buildMessagesService } from '../../src/messages/index.js';
import { MorningTimer, READY_POLL_MS, type WhatsAppReady } from '../../src/messages/morning/timer.js';
import { READER_VERSION, type ReaderStatus } from '../../src/messages/reader-protocol.js';
import { MESSAGES_SAYS } from '../../src/messages/says.js';
import { FakeCcwLegacy, FakeUsage, makeFakes } from '../api/fakes.js';
import { readerError, startFakeReader, type FakeHandlers, type FakeReader } from './fake-reader.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const WAIT = MESSAGES_LIMITS.waitForWhatsAppMs;
const READY: WhatsAppReady = { running: true, walQuietMs: MESSAGES_LIMITS.quietMs };

/** Lets every promise callback run (a ready() answer, a run's end) before the clock moves again. */
const flush = () => new Promise<void>((r) => setImmediate(r));
/** Move `clock` on by `ms` (running the timers that fall due), then flush. */
async function step(clock: FakeClock, ms: number): Promise<void> {
  clock.advance(ms);
  await flush();
}
/** Move `clock` to `iso`, then flush. */
async function setTo(clock: FakeClock, iso: string): Promise<void> {
  clock.set(iso);
  await flush();
}

// ---------------------------------------------------------------- the timer

/** A Mac that sleeps: Node's timers run on `awake` and stop while asleep, while now() also counts the time asleep. */
function sleepyClock(start: string): { awake: FakeClock; clock: Clock; sleep: (ms: number) => void } {
  const awake = new FakeClock(start);
  let slept = 0;
  const clock: Clock = {
    now: () => awake.now() + slept,
    iso: (ms) => new Date(ms ?? awake.now() + slept).toISOString(),
    setTimeout: (fn, ms) => awake.setTimeout(fn, ms),
    clearTimeout: (id) => awake.clearTimeout(id),
    setInterval: (fn, ms) => awake.setInterval(fn, ms),
    clearInterval: (id) => awake.clearInterval(id),
    sleep: (ms, signal) => awake.sleep(ms, signal),
  };
  return { awake, clock, sleep: (ms) => (slept += ms) };
}

interface Fired {
  at: string;
  stale: boolean;
  day: string;
}

/**
 * A timer on `clock` whose runs are recorded; `state` is what its callbacks read. `refuse`: the service refuses
 * the run (another run going), so it never started; `tried` has every run asked for, `fired` those that started.
 */
function timerOn(
  clock: Clock,
  state: { at: string | null; tz: string; lastAt: number | null; ready: () => WhatsAppReady | Promise<WhatsAppReady>; refuse?: () => boolean },
) {
  const fired: Fired[] = [];
  const tried: string[] = [];
  const asked: string[] = [];
  /** The mornings a new time left as done (what the service saves in messages.db). */
  const passed: string[] = [];
  const timer = new MorningTimer(clock, createTestContext().log, {
    tz: () => state.tz,
    at: () => state.at,
    lastAt: () => state.lastAt,
    passed: (dueAt) => passed.push(new Date(dueAt).toISOString()),
    ready: async () => {
      asked.push(clock.iso());
      return state.ready();
    },
    run: async (stale, morning) => {
      tried.push(clock.iso());
      if (state.refuse?.()) return false;
      fired.push({ at: clock.iso(), stale, day: morning.day });
      return true;
    },
  });
  return { timer, fired, asked, tried, passed };
}

describe('MorningTimer', () => {
  it('fires at the set time once a day', async () => {
    const clock = new FakeClock('2026-11-14T06:00:00.000Z');
    const state = { at: '08:00', tz: 'UTC', lastAt: null as number | null, ready: () => READY };
    const { timer, fired } = timerOn(clock, state);
    timer.start();
    await flush();
    try {
      await step(clock, HOUR + 59 * MIN);
      expect(fired).toEqual([]);
      await step(clock, MIN);
      expect(fired).toEqual([{ at: '2026-11-14T08:00:00.000Z', stale: false, day: '2026-11-14' }]);
      // The rest of the day, and the next morning up to 07:59: nothing more.
      await step(clock, 23 * HOUR + 59 * MIN);
      expect(fired).toHaveLength(1);
      await step(clock, MIN);
      expect(fired.map((f) => f.at)).toEqual(['2026-11-14T08:00:00.000Z', '2026-11-15T08:00:00.000Z']);
    } finally {
      timer.stop();
    }
    expect(clock.pending()).toBe(0);

    // A timer started later the same day (the daemon restarted at 09:00) leaves a day messages.db says ran.
    const late = new FakeClock('2026-11-16T09:00:00.000Z');
    const again = timerOn(late, { ...state, lastAt: Date.parse('2026-11-16T08:00:00.000Z') });
    again.timer.start();
    await flush();
    try {
      await step(late, 22 * HOUR);
      expect(again.fired).toEqual([]);
      await step(late, HOUR);
      expect(again.fired.map((f) => f.day)).toEqual(['2026-11-17']);
    } finally {
      again.timer.stop();
    }
  });

  it('after sleep runs once on wake within 6h', async () => {
    const { awake, clock, sleep } = sleepyClock('2026-11-13T20:00:00.000Z');
    const { timer, fired } = timerOn(clock, { at: '08:00', tz: 'UTC', lastAt: null, ready: () => READY });
    timer.start();
    await flush();
    try {
      sleep(13 * HOUR); // the lid closes at 20:00 and opens at 09:00, an hour after the morning time
      await step(awake, BACKUP_CHECK_MS);
      expect(fired).toEqual([{ at: '2026-11-14T09:01:00.000Z', stale: false, day: '2026-11-14' }]);
      await step(awake, 4 * HOUR);
      expect(fired).toHaveLength(1);
      // Asleep from 13:01 to 15:01 the next day: past that morning's six hours, so that day is left.
      sleep(26 * HOUR);
      await step(awake, BACKUP_CHECK_MS);
      await step(awake, HOUR);
      expect(fired).toHaveLength(1);
      // The morning after runs.
      await step(awake, 16 * HOUR);
      expect(fired.map((f) => f.day)).toEqual(['2026-11-14', '2026-11-16']);
    } finally {
      timer.stop();
    }
    expect(awake.pending()).toBe(0);
  });

  it('asleep while it waits, past the next morning: that morning runs, once', async () => {
    const { awake, clock, sleep } = sleepyClock('2026-11-14T07:59:00.000Z');
    let ready: WhatsAppReady = { running: false, walQuietMs: 0 };
    const { timer, fired } = timerOn(clock, { at: '08:00', tz: 'UTC', lastAt: null, ready: () => ready });
    timer.start();
    await flush();
    try {
      // 08:00: WhatsApp isn't up, so it waits.
      await step(awake, MIN);
      expect(fired).toEqual([]);
      // The lid closes and opens two days later at 10:00, WhatsApp syncing: Saturday's wait is over, Monday's morning is due.
      sleep(2 * 24 * HOUR + 2 * HOUR);
      ready = { running: true, walQuietMs: 0 };
      await step(awake, READY_POLL_MS);
      expect(fired).toEqual([]);
      ready = READY;
      await step(awake, READY_POLL_MS);
      expect(fired).toEqual([{ at: '2026-11-16T10:02:00.000Z', stale: false, day: '2026-11-16' }]);
      await step(awake, 8 * HOUR);
      expect(fired).toHaveLength(1);
    } finally {
      timer.stop();
    }
    expect(awake.pending()).toBe(0);
  });

  it('asleep through the end of its wait, awake before the next morning: that day is left, the next runs once at its time', async () => {
    const { awake, clock, sleep } = sleepyClock('2026-11-14T07:59:00.000Z');
    let ready: WhatsAppReady = { running: false, walQuietMs: 0 };
    const { timer, fired } = timerOn(clock, { at: '08:00', tz: 'UTC', lastAt: null, ready: () => ready });
    timer.start();
    await flush();
    try {
      await step(awake, MIN);
      expect(fired).toEqual([]);
      // The lid closes after Saturday's 08:00 ask and opens Sunday 07:00, WhatsApp ready: Saturday's wait ended at 14:00.
      sleep(23 * HOUR - MIN);
      ready = READY;
      await step(awake, READY_POLL_MS);
      expect(fired).toEqual([]);
      await step(awake, 59 * MIN);
      expect(fired).toEqual([]);
      // Sunday's morning is the one run.
      await step(awake, MIN);
      expect(fired).toEqual([{ at: '2026-11-15T08:00:00.000Z', stale: false, day: '2026-11-15' }]);
      await step(awake, 8 * HOUR);
      expect(fired).toHaveLength(1);
    } finally {
      timer.stop();
    }
    expect(awake.pending()).toBe(0);
  });

  it("asleep through the end of its wait and the next morning's whole wait: neither day runs", async () => {
    const { awake, clock, sleep } = sleepyClock('2026-11-14T07:59:00.000Z');
    let ready: WhatsAppReady = { running: false, walQuietMs: 0 };
    const { timer, fired } = timerOn(clock, { at: '08:00', tz: 'UTC', lastAt: null, ready: () => ready });
    timer.start();
    await flush();
    try {
      await step(awake, MIN);
      // The lid opens Monday 15:00: Saturday's wait and Monday's are both over.
      sleep(2 * 24 * HOUR + 7 * HOUR - MIN);
      ready = READY;
      await step(awake, READY_POLL_MS);
      await step(awake, 16 * HOUR);
      expect(fired).toEqual([]);
      // Tuesday's morning runs.
      await step(awake, HOUR);
      expect(fired).toEqual([{ at: '2026-11-17T08:00:00.000Z', stale: false, day: '2026-11-17' }]);
    } finally {
      timer.stop();
    }
    expect(awake.pending()).toBe(0);
  });

  it('waits for whatsapp then runs stale', async () => {
    const clock = new FakeClock('2026-11-14T07:30:00.000Z');
    const state = { at: '08:00', tz: 'UTC', lastAt: null as number | null, ready: (): WhatsAppReady | Promise<WhatsAppReady> => ({ running: false, walQuietMs: 0 }) };
    const { timer, fired, asked } = timerOn(clock, state);
    timer.start();
    await flush();
    try {
      await step(clock, 30 * MIN);
      expect(asked).toEqual(['2026-11-14T08:00:00.000Z']);
      // Asked again each minute; nothing runs before the six hours are up.
      for (let i = 0; i < WAIT / MIN - 1; i++) await step(clock, MIN);
      expect(fired).toEqual([]);
      expect(asked).toHaveLength(WAIT / MIN);
      await step(clock, MIN);
      expect(fired).toEqual([{ at: '2026-11-14T14:00:00.000Z', stale: true, day: '2026-11-14' }]);
      await step(clock, 3 * HOUR);
      expect(fired).toHaveLength(1);

      // The next morning WhatsApp is open but still writing (syncing): it runs once WhatsApp has been quiet for quietMs.
      let quiet = 0;
      state.ready = () => ({ running: true, walQuietMs: quiet });
      await setTo(clock, '2026-11-15T08:00:00.000Z');
      await step(clock, MIN);
      expect(fired).toHaveLength(1);
      quiet = MESSAGES_LIMITS.quietMs;
      await step(clock, MIN);
      expect(fired.at(-1)).toEqual({ at: '2026-11-15T08:02:00.000Z', stale: false, day: '2026-11-15' });

      // A reader that doesn't answer is not ready either.
      state.ready = () => Promise.reject(new Error('down'));
      await setTo(clock, '2026-11-16T08:00:00.000Z');
      await step(clock, WAIT - MIN);
      expect(fired).toHaveLength(2);
      await step(clock, MIN);
      expect(fired.at(-1)).toEqual({ at: '2026-11-16T14:00:00.000Z', stale: true, day: '2026-11-16' });
    } finally {
      timer.stop();
    }
    expect(clock.pending()).toBe(0);
  });

  it('no time set → never fires', async () => {
    const clock = new FakeClock('2026-11-14T06:00:00.000Z');
    const { timer, fired, asked } = timerOn(clock, { at: null, tz: 'UTC', lastAt: null, ready: () => READY });
    timer.start();
    await flush();
    try {
      expect(clock.pending()).toBe(0);
      await step(clock, 3 * 24 * HOUR);
      expect([fired, asked]).toEqual([[], []]);
    } finally {
      timer.stop();
    }
  });

  it('prefs change rearms', async () => {
    const clock = new FakeClock('2026-11-14T06:00:00.000Z');
    const state = { at: null as string | null, tz: 'UTC', lastAt: null as number | null, ready: () => READY };
    const { timer, fired } = timerOn(clock, state);
    timer.start();
    await flush();
    try {
      state.at = '09:00';
      timer.retime();
      await step(clock, 3 * HOUR - MIN);
      expect(fired).toEqual([]);
      await step(clock, MIN);
      expect(fired.map((f) => f.at)).toEqual(['2026-11-14T09:00:00.000Z']);

      // Earlier the next day: 07:00.
      state.at = '07:00';
      timer.retime();
      await setTo(clock, '2026-11-15T07:00:00.000Z');
      expect(fired.map((f) => f.at)).toEqual(['2026-11-14T09:00:00.000Z', '2026-11-15T07:00:00.000Z']);

      // The zone moves to India: 07:00 there is 01:30 UTC.
      state.tz = 'Asia/Kolkata';
      timer.rearm();
      await setTo(clock, '2026-11-16T01:29:00.000Z');
      expect(fired).toHaveLength(2);
      await step(clock, MIN);
      expect(fired.at(-1)).toEqual({ at: '2026-11-16T01:30:00.000Z', stale: false, day: '2026-11-16' });

      // Off again: idle.
      state.at = null;
      timer.retime();
      expect(clock.pending()).toBe(0);
      await step(clock, 2 * 24 * HOUR);
      expect(fired).toHaveLength(3);
    } finally {
      timer.stop();
    }
  });

  it('a new time while it waits for WhatsApp starts over from that time', async () => {
    const clock = new FakeClock('2026-11-14T08:00:00.000Z');
    let ready: WhatsAppReady = { running: false, walQuietMs: 0 };
    const state = { at: '08:00' as string | null, tz: 'UTC', lastAt: null as number | null, ready: () => ready };
    const { timer, fired } = timerOn(clock, state);
    timer.start();
    await flush();
    try {
      await step(clock, 10 * MIN);
      expect(fired).toEqual([]);
      // Moved to 09:00 while waiting: today's run is at 09:00 (not run yet), WhatsApp now ready.
      state.at = '09:00';
      timer.retime();
      ready = READY;
      await step(clock, 49 * MIN);
      expect(fired).toEqual([]);
      await step(clock, MIN);
      expect(fired).toEqual([{ at: '2026-11-14T09:00:00.000Z', stale: false, day: '2026-11-14' }]);
    } finally {
      timer.stop();
    }
  });

  it('a run the service refuses (another run going) is asked for again each minute while its wait lasts', async () => {
    const clock = new FakeClock('2026-11-14T07:59:00.000Z');
    let refusals = 2;
    const state = { at: '08:00', tz: 'UTC', lastAt: null as number | null, ready: () => READY, refuse: () => refusals-- > 0 };
    const { timer, fired, tried } = timerOn(clock, state);
    timer.start();
    await flush();
    try {
      await step(clock, MIN);
      await step(clock, MIN);
      expect(fired).toEqual([]);
      // The third time it starts: that day is done.
      await step(clock, MIN);
      expect(tried).toEqual(['2026-11-14T08:00:00.000Z', '2026-11-14T08:01:00.000Z', '2026-11-14T08:02:00.000Z']);
      expect(fired).toEqual([{ at: '2026-11-14T08:02:00.000Z', stale: false, day: '2026-11-14' }]);
      await step(clock, 23 * HOUR);
      expect(tried).toHaveLength(3);

      // Refused all morning: asked for until its wait is over (and a minute's grace), then the day is left.
      state.refuse = () => true;
      await setTo(clock, '2026-11-15T07:59:00.000Z');
      for (let i = 0; i < WAIT / MIN + 3; i++) await step(clock, MIN);
      const sunday = tried.slice(3);
      expect(sunday[0]).toBe('2026-11-15T08:00:00.000Z');
      expect(sunday.at(-1)).toBe('2026-11-15T14:01:00.000Z');
      await step(clock, 17 * HOUR);
      expect(tried.slice(3)).toEqual(sunday);
      // The next morning is asked for again.
      state.refuse = () => false;
      await setTo(clock, '2026-11-16T08:00:00.000Z');
      expect(fired.map((f) => f.at)).toEqual(['2026-11-14T08:02:00.000Z', '2026-11-16T08:00:00.000Z']);
    } finally {
      timer.stop();
    }
    expect(clock.pending()).toBe(0);
  });

  it('a morning time set after it has passed today starts tomorrow; one already due, or slept through, still runs', async () => {
    // 10:00, the morning off: set to 08:00, it waits for tomorrow.
    const clock = new FakeClock('2026-11-14T10:00:00.000Z');
    let ready: WhatsAppReady = READY;
    const state = { at: null as string | null, tz: 'UTC', lastAt: null as number | null, ready: () => ready };
    const { timer, fired, tried } = timerOn(clock, state);
    timer.start();
    await flush();
    try {
      state.at = '08:00';
      timer.retime();
      await flush();
      await step(clock, MIN);
      expect(tried).toEqual([]);
      await step(clock, 21 * HOUR + 58 * MIN);
      expect(tried).toEqual([]);
      await step(clock, MIN);
      expect(fired.map((f) => f.at)).toEqual(['2026-11-15T08:00:00.000Z']);

      // After the morning ran, a later time the same day doesn't run it again.
      await setTo(clock, '2026-11-15T10:00:00.000Z');
      state.at = '20:00';
      timer.retime();
      await flush();
      await step(clock, 12 * HOUR);
      expect(fired).toHaveLength(1);
      await setTo(clock, '2026-11-16T20:00:00.000Z');
      expect(fired.map((f) => f.at)).toEqual(['2026-11-15T08:00:00.000Z', '2026-11-16T20:00:00.000Z']);

      // Waiting for WhatsApp since 20:00 on the 17th, moved to 19:00 at 20:10: that morning still runs, once WhatsApp is ready.
      ready = { running: false, walQuietMs: 0 };
      await setTo(clock, '2026-11-17T20:00:00.000Z');
      await step(clock, 10 * MIN);
      state.at = '19:00';
      ready = READY;
      timer.retime();
      await step(clock, MIN);
      expect(fired.at(-1)).toEqual({ at: '2026-11-17T20:11:00.000Z', stale: false, day: '2026-11-17' });
    } finally {
      timer.stop();
    }

    // The daemon (or the Mac) was down at the time: it still runs on start, within its wait.
    const late = new FakeClock('2026-11-18T09:00:00.000Z');
    const again = timerOn(late, { at: '08:00', tz: 'UTC', lastAt: null, ready: () => READY });
    again.timer.start();
    await flush();
    try {
      await step(late, MIN);
      expect(again.fired.map((f) => f.at)).toEqual(['2026-11-18T09:00:00.000Z']);
    } finally {
      again.timer.stop();
    }
  });

  it("a morning a new time left as done is handed to passed(), and a new timer reading it back waits for tomorrow", async () => {
    // 10:00, set to 08:00: today's morning is left, and saved as done.
    const clock = new FakeClock('2026-11-14T10:00:00.000Z');
    const state = { at: null as string | null, tz: 'UTC', lastAt: null as number | null, ready: () => READY };
    const first = timerOn(clock, state);
    first.timer.start();
    await flush();
    state.at = '08:00';
    first.timer.retime();
    first.timer.stop();
    expect(first.passed).toEqual(['2026-11-14T08:00:00.000Z']);
    // Restarted at 10:05, inside that morning's wait: lastAt is the saved mark.
    await step(clock, 5 * MIN);
    const again = timerOn(clock, { ...state, lastAt: Date.parse(first.passed[0]!) });
    again.timer.start();
    await flush();
    try {
      await step(clock, MIN);
      expect(again.tried).toEqual([]);
      await setTo(clock, '2026-11-15T08:00:00.000Z');
      expect(again.fired.map((f) => f.at)).toEqual(['2026-11-15T08:00:00.000Z']);
      // A time already due, or none passed: nothing is saved.
      expect(again.passed).toEqual([]);
    } finally {
      again.timer.stop();
    }
  });

  it('after the Life zone moves west, the next morning there still runs', async () => {
    // The timer ran at 08:00 in India on the 15th (02:30 UTC); a minute later the zone is Los Angeles, where it is still the 14th.
    const clock = new FakeClock('2026-11-15T02:31:00.000Z');
    const { timer, fired } = timerOn(clock, { at: '08:00', tz: 'America/Los_Angeles', lastAt: Date.parse('2026-11-15T02:30:00.000Z'), ready: () => READY });
    timer.start();
    await flush();
    try {
      await step(clock, 29 * MIN);
      for (let i = 0; i < 48; i++) await step(clock, HOUR);
      // 08:00 there on the 15th and the 16th.
      expect(fired.map((f) => f.at)).toEqual(['2026-11-15T16:00:00.000Z', '2026-11-16T16:00:00.000Z']);
    } finally {
      timer.stop();
    }

    // Moving east (Los Angeles to India) after its morning: India's next morning runs too, once.
    const east = new FakeClock('2026-11-15T16:01:00.000Z');
    const e = timerOn(east, { at: '08:00', tz: 'Asia/Kolkata', lastAt: Date.parse('2026-11-15T16:00:00.000Z'), ready: () => READY });
    e.timer.start();
    await flush();
    try {
      await step(east, 29 * MIN);
      for (let i = 0; i < 24; i++) await step(east, HOUR);
      expect(e.fired.map((f) => f.at)).toEqual(['2026-11-16T02:30:00.000Z']);
    } finally {
      e.timer.stop();
    }
  });

  it('after a big move east (Los Angeles to Tokyo), the first morning there is skipped: never two runs hours apart (docs/messages.md)', async () => {
    // Los Angeles' 08:00 on the 15th ran (16:00 UTC), already the 16th in Tokyo; Tokyo's 08:00 on the 16th (23:00 UTC) is 7 hours on.
    const clock = new FakeClock('2026-11-15T16:01:00.000Z');
    const { timer, fired } = timerOn(clock, { at: '08:00', tz: 'Asia/Tokyo', lastAt: Date.parse('2026-11-15T16:00:00.000Z'), ready: () => READY });
    timer.start();
    await flush();
    try {
      await step(clock, 59 * MIN);
      for (let i = 0; i < 56; i++) await step(clock, HOUR);
      // Tokyo's 17th and 18th: the first run there is 31 hours after Los Angeles' last.
      expect(fired.map((f) => f.at)).toEqual(['2026-11-16T23:00:00.000Z', '2026-11-17T23:00:00.000Z']);
    } finally {
      timer.stop();
    }
  });
});

// ---------------------------------------------------------------- the service's morning

const TZ = 'Asia/Kolkata';
/** Sat 08:30 in the Life zone. */
const NOW = '2026-11-14T03:00:00.000Z';
const ASHA = 'ca1b2c3d4e5f6a7b8';
const RAVI = 'cb2c3d4e5f6a7b8c9';
const DECK = 'Can you send the deck by Friday 5pm?';
const VENUE = 'Please check the venue booking';
const CLI: Actor = { kind: 'cli' };
const PHONE: Actor = { kind: 'device', deviceId: 'dev1', scopes: ['control'] };

const chatOf = (chatKey: string, name: string, phone: string): ChatOwner => ({
  chatKey,
  name,
  kind: 'dm',
  lastAt: '2026-11-13T19:00:00.000Z',
  unread: 1,
  lastFromMe: false,
  archived: false,
  phone,
});
const asha = chatOf(ASHA, 'Asha Test', '919990000001');
const ravi = chatOf(RAVI, 'Ravi Test', '919990000002');
const deck: Message = { msgKey: `${ASHA}.3EB0A1`, at: '2026-11-13T18:00:00.000Z', fromMe: false, sender: 'Asha Test', kind: 'text', text: DECK };
const venue: Message = { msgKey: `${RAVI}.3EB0B1`, at: '2026-11-13T19:00:00.000Z', fromMe: false, sender: 'Ravi Test', kind: 'text', text: VENUE };
const missed: Call = { callKey: 'k0a1b2c3d4e5f6a7b', at: '2026-11-13T10:00:00.000Z', who: 'Ravi Test', chatKey: RAVI, via: 'whatsapp', incoming: true, missed: true, video: false, durationS: 0 };

const STATUS: ReaderStatus = {
  whatsapp: { found: true, running: true, schemaOk: true, contactsOk: true, newestAt: '2026-11-13T19:00:00.000Z', walMtime: '2026-11-13T19:00:01.000Z' },
  phone: { readable: false },
  skipped: 0,
  skipOk: true,
  version: READER_VERSION,
};

/** What a reader with Asha's and Ravi's new lines and Ravi's missed call answers; `pk` is where its feed gets to. */
function readerOf(o: { pk: () => number; running?: () => boolean }): FakeHandlers {
  return {
    status: () => ({ ...STATUS, whatsapp: { ...STATUS.whatsapp, running: o.running?.() ?? true } }),
    newSince: () => ({
      chats: [
        { chat: ravi, messages: [venue], earlier: [] },
        { chat: asha, messages: [deck], earlier: [] },
      ],
      nextCursor: { pk: o.pk(), at: venue.at },
      truncated: false,
      reset: false,
    }),
    waCalls: () => ({ calls: [missed] }),
    phoneCalls: () => {
      throw readerError('no_access', "the iPhone call log isn't on this Mac");
    },
    lastFromMe: (args) => Object.fromEntries((args.chatKeys as string[]).map((k) => [k, null])),
    // Both wrote last, and both have new lines: nothing more to read.
    chats: () => ({ chats: [ravi, asha], total: 2 }),
  };
}

/** The input's id that `re` finds (an m, c or k id). */
function idIn(text: string, re: RegExp): string {
  const m = re.exec(text);
  if (!m?.[1]) throw new Error(`no id for ${String(re)}`);
  return m[1];
}

/** What a compliant model answers on this input: two todos, a reply to Asha, a call-back to Ravi. */
function fullAnswer(text: string): MorningAnswer {
  const deckId = idIn(text, /<m id="(m\d+)"[^>]*>Can you send the deck/);
  return {
    summary: 'Asha wants the deck by Friday 5pm; Ravi asked about the venue and called.',
    todos: [
      { title: 'Send Asha the deck', ref: deckId },
      { title: 'Check the venue booking', ref: idIn(text, /<m id="(m\d+)"[^>]*>Please check the venue/) },
    ],
    replies: [{ chat: idIn(text, /<chat id="(c\d+)" name="Asha Test"/), ref: deckId, they_asked: 'The deck by Friday 5pm', draft: 'Sending it tonight.' }],
    callbacks: [{ ref: idIn(text, /<call id="(k\d+)"/), who: 'Ravi Test', why: 'Missed his call' }],
  };
}

const EMPTY: MorningAnswer = { summary: 'Quiet night.', todos: [], replies: [], callbacks: [] };
const RESULT = (r: unknown) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: typeof r === 'string' ? r : JSON.stringify(r) });
const INIT = JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] });

/** The input's text from a run's stdin (stream-json: the first text block). */
function inputOf(c: ExecCall): string {
  const line = JSON.parse(c.opts.input ?? '{}') as { message?: { content?: { type: string; text?: string }[] } };
  return line.message?.content?.find((b) => b.type === 'text')?.text ?? '';
}

let dir: string;
const cleanups: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  // Short: the reader's socket path must stay under 104 bytes.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'jmt-')));
  chmodSync(dir, 0o700);
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  rmSync(dir, { recursive: true, force: true });
});

interface Morning {
  ctx: TestContext;
  svc: MessagesService;
  clock: FakeClock;
  reader: FakeReader;
  push: PushSpy;
  life: LifeService;
  exec: ReturnType<typeof createFakeExec>;
  paths: Paths;
  /** Life's core (its scheduler: when each todo rings). */
  core: TestLifeCore;
  /** Life's todos: the real module, or (lifeClosed) a stand-in that refuses every call, as Life's while life.db is closed. */
  lifeClosed(closed: boolean): void;
  /** life.db opens again: what each part gave LifeService.onOpen runs. */
  lifeOpened(): void;
}

/** The part on Messages on, messages.db in memory, Life's todos in memory, a fake reader and a fake claude answering `claude`. */
let setups = 0;
async function morningSetup(o: { handlers: FakeHandlers; claude: ExecHandler; readOnly?: boolean; now?: string; life?: Partial<Settings['life']>; dbFile?: string }): Promise<Morning> {
  setups += 1;
  const paths: Paths = { ...resolvePaths({ env: { HOME: dir }, userHome: dir, home: join(dir, `j${setups}`) }), messagesReaderSock: join(dir, `r${setups}.sock`) };
  const clock = new FakeClock(o.now ?? NOW);
  const exec = createFakeExec(o.claude);
  const lifeOn = { todos: true, ...o.life };
  const ctx = createTestContext({ paths, clock, exec, accountsMode: 'single', settings: SettingsSchema.parse({ messages: { enabled: true }, life: lifeOn }) });
  const core = createTestLifeCore({ clock, tz: TZ, settings: lifeOn });
  const f = makeFakes(ctx);
  const todos = buildTodosModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
  // Life's zone: its setting once set (as Life takes it), else TZ. Closed, its todos answer as Life's closed module does.
  const closed = new Proxy({}, { get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : () => ({ ok: false, code: 'unavailable', reason: 'Life is not open right now.' })) });
  const onOpen: (() => void)[] = [];
  const life = { todos, status: () => ({ timezone: ctx.settings.get().life.timezone || TZ }), onOpen: (fn: () => void) => onOpen.push(fn) } as unknown as LifeService;
  const lifeClosed = (c: boolean) => Object.assign(life, { todos: c ? closed : todos });
  const lifeOpened = () => {
    for (const fn of onOpen) fn();
  };
  const reader = await startFakeReader(paths.messagesReaderSock, o.handlers);
  const push = createPushSpy();
  const svc = buildMessagesService(ctx, { life, usage: new FakeUsage(), ccwLegacy: new FakeCcwLegacy() }, { dbFile: o.dbFile ?? ':memory:', send: push.send, readOnly: o.readOnly === true });
  await svc.start();
  cleanups.push(() => reader.close());
  cleanups.push(() => svc.stop());
  cleanups.push(() => core.close());
  return { ctx, svc, clock, reader, push, life, exec, paths, core, lifeClosed, lifeOpened };
}

const claudeSays = (answer: (input: string) => MorningAnswer | string): ExecHandler => (c) => {
  if (!c.file.endsWith('claude')) return undefined;
  return { stdout: `${INIT}\n${RESULT(answer(inputOf(c)))}\n` };
};

/** Real time for the reader's socket while the fake clock stands still: until `fn` says yes (5 s at most). */
async function eventually<T>(fn: () => T | null | undefined | false): Promise<T> {
  const end = Date.now() + 5_000;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('not in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const cursorsAsked = (r: FakeReader) => r.calls.filter((c) => c.op === 'newSince').map((c) => (c.args.cursor as { pk: number } | null)?.pk ?? null);

describe('the morning run', () => {
  it('waits for whatsapp then runs stale: the report says so', async () => {
    // 07:59 in the Life zone, the morning time 08:00.
    const t = await morningSetup({ handlers: readerOf({ pk: () => 42, running: () => false }), claude: claudeSays(() => EMPTY), now: '2026-11-14T02:29:00.000Z' });
    expect(t.svc.morning.setPrefs({ morningAt: '08:00' }, CLI)).toEqual({ ok: true, value: true });
    expect(t.svc.morning.prefs()).toEqual({ morningAt: '08:00', callbackAt: '11:00' });
    t.clock.advance(MIN);
    // It asks the reader whether WhatsApp is up: it isn't.
    await eventually(() => t.reader.calls.some((c) => c.op === 'status'));
    await new Promise((r) => setTimeout(r, 20));
    expect(t.svc.morning.last()).toBeNull();
    t.clock.advance(WAIT);
    const run = await eventually(() => {
      const r = t.svc.morning.last();
      return r && r.state !== 'running' ? r : null;
    });
    expect(run).toMatchObject({ trigger: 'timer', state: 'ok', stale: true, newestAt: STATUS.whatsapp.newestAt, at: '2026-11-14T08:30:00.000Z' });
    expect(t.svc.morning.today().run).toEqual(run);
    await expect(t.svc.status().then((s) => s.morning)).resolves.toEqual({ at: '08:00', lastRunAt: run.at });
    // Nothing to say: no push.
    expect(t.push.pushes).toEqual([]);
  });

  it('a failed run keeps the cursor', async () => {
    let pk = 42;
    let answer: (text: string) => MorningAnswer | string = () => EMPTY;
    const t = await morningSetup({ handlers: readerOf({ pk: () => pk }), claude: claudeSays((text) => answer(text)) });
    expect(await t.svc.morning.run({ trigger: 'now' })).toMatchObject({ state: 'ok' });
    // Claude answers what the schema refuses: the run failed, the cursor stays at 42.
    pk = 99;
    answer = () => 'Here are your todos!';
    const failed = await t.svc.morning.run({ trigger: 'now' });
    expect(failed).toMatchObject({ trigger: 'now', state: 'failed', why: MESSAGES_SAYS.morningUnreadable, todoIds: [] });
    // A dry run that goes well doesn't move it either.
    pk = 120;
    answer = () => EMPTY;
    expect(await t.svc.morning.run({ trigger: 'dry' })).toMatchObject({ trigger: 'dry', state: 'ok' });
    // A reader that is down fails the run with its sentence, and keeps it too.
    const down = await morningSetupDown();
    expect(down).toMatchObject({ state: 'failed', why: MESSAGES_SAYS.down });
    expect(await t.svc.morning.run({ trigger: 'now' })).toMatchObject({ state: 'ok' });
    await t.svc.morning.run({ trigger: 'now' });
    expect(cursorsAsked(t.reader)).toEqual([null, 42, 42, 42, 120]);
  });

  it('push says counts only', async () => {
    const t = await morningSetup({ handlers: readerOf({ pk: () => 42 }), claude: claudeSays(fullAnswer) });
    const run = await t.svc.morning.run({ trigger: 'now' });
    expect(run).toMatchObject({
      trigger: 'now',
      state: 'ok',
      stale: false,
      summary: 'Asha wants the deck by Friday 5pm; Ravi asked about the venue and called.',
      counts: { chats: 2, messages: 2, calls: 1, todos: 2, replies: 1, callbacks: 1, dropped: 0 },
      dropped: [],
    });
    // The iPhone call log wasn't read (no Full Disk Access): the report says so, and keeps it.
    expect(run.phoneCalls).toBe(false);
    expect(run).not.toHaveProperty('waCalls');
    expect(run).not.toHaveProperty('lifeRefused');
    expect(t.svc.morning.today().run).toMatchObject({ id: run.id, phoneCalls: false });
    expect(run.todoIds).toHaveLength(2);
    expect(run.preview).toBeUndefined();
    await eventually(() => t.push.pushes.length > 0);
    expect(t.push.pushes).toEqual([{ kind: 'life', title: 'Messages', body: 'Morning: 2 todos, 1 replies waiting, 1 call-backs', url: '/messages', tag: 'life:morning' }]);
    // The same lines again make nothing (made), so there is nothing to say; a dry run never pushes.
    expect((await t.svc.morning.run({ trigger: 'now' })).counts).toMatchObject({ todos: 0, replies: 0, callbacks: 0 });
    expect((await t.svc.morning.run({ trigger: 'dry' })).trigger).toBe('dry');
    await new Promise((r) => setTimeout(r, 20));
    expect(t.push.pushes).toHaveLength(1);
  });

  it("Life refusing the run's todos: the report says so, and Today keeps it", async () => {
    const t = await morningSetup({ handlers: readerOf({ pk: () => 42 }), claude: claudeSays(fullAnswer) });
    // Life closed under the run: it takes no todo.
    vi.spyOn(t.life.todos, 'createTodo').mockReturnValue({ ok: false, code: 'unavailable', reason: 'Life is closed.' });
    const run = await t.svc.morning.run({ trigger: 'now' });
    expect(run).toMatchObject({ state: 'ok', lifeRefused: 'life_refused', counts: { todos: 0, callbacks: 0, replies: 1 } });
    expect(t.svc.morning.today().run).toMatchObject({ id: run.id, lifeRefused: 'life_refused' });
  });

  it('a push the mute holds is not tried again; the report keeps the counts', async () => {
    const t = await morningSetup({ handlers: readerOf({ pk: () => 42 }), claude: claudeSays(fullAnswer) });
    // The owner's mute: nothing goes out (life/push.ts holds a life push), and the morning never sends it again.
    t.push.result = { delivered: 0, failed: 0 };
    const run = await t.svc.morning.run({ trigger: 'now' });
    await eventually(() => t.push.pushes.length > 0);
    t.clock.advance(24 * HOUR);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.push.pushes).toHaveLength(1);
    expect(t.svc.morning.today().run).toMatchObject({ id: run.id, state: 'ok', counts: { todos: 2, replies: 1, callbacks: 1 } });
  });

  it("a waiting 1:1 with no new lines is still waiting, and isn't drafted twice", async () => {
    let night = 1;
    const handlers: FakeHandlers = {
      ...readerOf({ pk: () => 41 }),
      // The second night nothing new came: Asha is still on the reader's waiting list.
      newSince: () => ({ chats: night === 1 ? [{ chat: asha, messages: [deck], earlier: [] }] : [], nextCursor: { pk: 41, at: deck.at }, truncated: false, reset: false }),
      waCalls: () => ({ calls: [] }),
      chats: () => ({ chats: [asha], total: 1 }),
      read: () => ({ chat: asha, messages: [deck], more: false }),
    };
    const inputs: string[] = [];
    const answer = (text: string): MorningAnswer => {
      inputs.push(text);
      const m = idIn(text, /<m id="(m\d+)"[^>]*>Can you send the deck/);
      return { ...EMPTY, todos: [{ title: 'Send Asha the deck', ref: m }], replies: [{ chat: idIn(text, /<chat id="(c\d+)" name="Asha Test"/), ref: m, they_asked: 'The deck by Friday 5pm', draft: 'Sending it tonight.' }] };
    };
    const t = await morningSetup({ handlers, claude: claudeSays(answer) });
    const first = await t.svc.morning.run({ trigger: 'now' });
    expect(first.counts).toMatchObject({ chats: 1, messages: 1, todos: 1, replies: 1 });

    night = 2;
    t.clock.advance(24 * HOUR);
    const second = await t.svc.morning.run({ trigger: 'now' });
    // Claude reads her again, still waiting: her ask, from before this run, with an id to answer.
    expect(inputs[1]).toContain('<chat id="c1" name="Asha Test" kind="dm" waiting="yes">');
    expect(inputs[1]).toMatch(/<m id="m1" at="[^"]+" from="Asha Test" earlier="yes">Can you send the deck/);
    expect(t.reader.calls.filter((c) => c.op === 'read').map((c) => c.args)).toEqual([{ chatKey: ASHA, limit: MESSAGES_LIMITS.dmContext }]);
    // Nothing new, nothing made twice: the first night's draft is the one Today shows.
    expect(second).toMatchObject({ state: 'ok', counts: { chats: 1, messages: 0, todos: 0, replies: 0 } });
    expect(t.svc.morning.today().drafts).toEqual([expect.objectContaining({ runId: first.id, chatKey: ASHA, draft: 'Sending it tonight.' })]);
    const open = t.life.todos.listTodos({ done: false });
    expect(open.ok && open.value.todos.map((x) => x.title)).toEqual(['Send Asha the deck']);
  });

  it('a change of the Life zone moves the morning time', async () => {
    // 06:30 in India (01:00 UTC); the morning time 08:00 is 02:30 UTC there.
    const t = await morningSetup({ handlers: readerOf({ pk: () => 42 }), claude: claudeSays(() => EMPTY), now: '2026-11-14T01:00:00.000Z' });
    expect(t.svc.morning.setPrefs({ morningAt: '08:00' }, CLI).ok).toBe(true);
    // The zone moves to UTC: 08:00 is now 08:00 UTC.
    await t.ctx.settings.patch({ life: { timezone: 'UTC' } });
    await flush();
    t.clock.advance(HOUR + 31 * MIN);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.reader.calls.filter((c) => c.op === 'status')).toEqual([]);
    expect(t.svc.morning.last()).toBeNull();
    t.clock.advance(5 * HOUR + 29 * MIN);
    const run = await eventually(() => {
      const r = t.svc.morning.last();
      return r && r.state !== 'running' ? r : null;
    });
    expect(run).toMatchObject({ trigger: 'timer', state: 'ok', at: '2026-11-14T08:00:00.000Z' });
  });

  it('a dry run writes nothing and answers what it would make', async () => {
    const t = await morningSetup({ handlers: readerOf({ pk: () => 42 }), claude: claudeSays(fullAnswer) });
    const dry = await t.svc.morning.run({ trigger: 'dry' });
    expect(dry).toMatchObject({ trigger: 'dry', state: 'ok', todoIds: [], counts: { todos: 2, replies: 1, callbacks: 1 } });
    expect(dry.preview).toEqual({
      todos: [{ title: 'Send Asha the deck' }, { title: 'Check the venue booking' }],
      callbacks: [{ who: 'Ravi Test', at: '2026-11-14T05:30:00.000Z' }],
      replies: [{ chatName: 'Asha Test', theyAsked: 'The deck by Friday 5pm', draft: 'Sending it tonight.' }],
      dropped: [],
    });
    // Nothing in Life, no draft, no call-back; Today's run is the newest real one (none).
    const open = t.life.todos.listTodos({ done: false });
    expect(open.ok && open.value.todos).toEqual([]);
    expect(t.svc.morning.today()).toEqual({ run: null, made: [], drafts: [], callbacks: [] });
    // last() is the newest report, the dry one included (stored without its preview).
    expect(t.svc.morning.last()).toEqual({ ...dry, preview: undefined });
    expect(JSON.stringify(t.svc.morning.last())).not.toContain('preview');
  });

  it('one run at a time (409), none under --read-only, none while Messages is off', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow: ExecHandler = async (c) => {
      if (!c.file.endsWith('claude')) return undefined;
      await gate;
      return { stdout: `${INIT}\n${RESULT(EMPTY)}\n` };
    };
    const t = await morningSetup({ handlers: readerOf({ pk: () => 42 }), claude: slow });
    const first = t.svc.morning.run({ trigger: 'now' });
    await eventually(() => t.exec.calls.length > 0);
    for (const trigger of ['now', 'dry'] as const) {
      const busy = await t.svc.morning.run({ trigger }).catch((e: unknown) => e);
      expect(busy).toBeInstanceOf(ApiError);
      expect(busy).toMatchObject({ code: 'conflict', message: MESSAGES_SAYS.morningBusy });
    }
    // Today shows it going.
    expect(t.svc.morning.today().run).toMatchObject({ state: 'running', trigger: 'now' });
    release();
    expect(await first).toMatchObject({ state: 'ok' });

    const ro = await morningSetup({ handlers: readerOf({ pk: () => 42 }), claude: claudeSays(() => EMPTY), readOnly: true });
    const refused = await ro.svc.morning.run({ trigger: 'now' }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'forbidden', message: MESSAGES_SAYS.morningReadOnly });
    // Its timer never runs either, whatever the time says.
    expect(ro.svc.morning.setPrefs({ morningAt: '08:00' }, CLI).ok).toBe(true);
    ro.clock.advance(2 * 24 * HOUR);
    await new Promise((r) => setTimeout(r, 20));
    expect(ro.exec.calls).toEqual([]);
    expect(ro.reader.calls.filter((c) => c.op === 'newSince')).toEqual([]);
    // Not even whether WhatsApp is ready: the timer never started.
    expect(ro.reader.calls.filter((c) => c.op === 'status')).toEqual([]);

    await t.svc.stop();
    const off = await t.svc.morning.run({ trigger: 'now' }).catch((e: unknown) => e);
    expect(off).toMatchObject({ code: 'messages_unavailable', message: MESSAGES_SAYS.off });
  });

  it('today: the newest run, open drafts and open call-backs; drafts, undo and times', async () => {
    const t = await morningSetup({ handlers: readerOf({ pk: () => 42 }), claude: claudeSays(fullAnswer) });
    const run = await t.svc.morning.run({ trigger: 'now' });
    const today = t.svc.morning.today();
    expect(today.run).toEqual(run);
    expect(today.drafts).toEqual([
      expect.objectContaining({ runId: run.id, chatKey: ASHA, chatName: 'Asha Test', phone: '919990000001', theyAsked: 'The deck by Friday 5pm', draft: 'Sending it tonight.', at: deck.at, state: 'open' }),
    ]);
    // Ravi's call-back rings at the call-back time (11:00 in the Life zone).
    expect(today.callbacks).toEqual([{ todoId: expect.any(String), who: 'Ravi Test', at: '2026-11-14T05:30:00.000Z' }]);

    const draftId = today.drafts[0]!.id;
    expect(t.svc.morning.setDraft(draftId, 'done', CLI)).toEqual({ ok: true, value: true });
    expect(t.svc.morning.today().drafts).toEqual([]);
    expect(t.svc.morning.setDraft('01JNOSUCHDRAFT000000000000', 'done', CLI)).toMatchObject({ ok: false, code: 'not_found', reason: MESSAGES_SAYS.noDraft });
    expect(t.svc.morning.setDraft(draftId, 'open', CLI).ok).toBe(true);

    // A call-back done in Life leaves Today.
    expect(t.life.todos.setDone(today.callbacks[0]!.todoId, true, CLI).ok).toBe(true);
    expect(t.svc.morning.today().callbacks).toEqual([]);

    // Undo: this run's open todos go, its drafts are dismissed.
    expect(t.svc.morning.undo(run.id, CLI)).toEqual({ ok: true, value: true });
    const open = t.life.todos.listTodos({ done: false });
    expect(open.ok && open.value.todos).toEqual([]);
    expect(t.svc.morning.today().drafts).toEqual([]);
    expect(t.svc.morning.undo('01JNOSUCHRUN00000000000000', CLI)).toMatchObject({ ok: false, code: 'not_found', reason: MESSAGES_SAYS.noRun });

    // The times: only the keys sent change; null turns one off.
    expect(t.svc.morning.setPrefs({ callbackAt: null }, CLI).ok).toBe(true);
    expect(t.svc.morning.setPrefs({ morningAt: '07:15' }, CLI).ok).toBe(true);
    expect(t.svc.morning.prefs()).toEqual({ morningAt: '07:15', callbackAt: null });
  });

  it('a morning time after the call-back time: each call-back still rings, at the next quarter hour', async () => {
    const t = await morningSetup({ handlers: readerOf({ pk: () => 42 }), claude: claudeSays(fullAnswer) });
    expect(t.svc.morning.setPrefs({ morningAt: '11:30' }, CLI).ok).toBe(true);
    expect(t.svc.morning.prefs().callbackAt).toBe('11:00');
    // 11:30 in the Life zone.
    t.clock.advance(3 * HOUR);
    const run = await eventually(() => {
      const r = t.svc.morning.last();
      return r && r.state !== 'running' ? r : null;
    });
    expect(run).toMatchObject({ trigger: 'timer', state: 'ok', counts: { callbacks: 1 } });
    const ringsAt = '2026-11-14T06:15:00.000Z'; // 11:45 there
    expect(t.svc.morning.today().callbacks).toEqual([{ todoId: expect.any(String), who: 'Ravi Test', at: ringsAt }]);
    expect(t.core.scheduler.row('todo', t.svc.morning.today().callbacks[0]!.todoId)?.nextAt).toBe(ringsAt);
  });

  it('skipping a chat takes what the morning made from it off Today, out of the reports and out of Life', async () => {
    // Ravi has more new lines than a 1:1 keeps: the report lists him as cut for size.
    const filler = Array.from({ length: 59 }, (_, i): Message => ({ msgKey: `${RAVI}.F${i}`, at: `2026-11-13T18:${String(i).padStart(2, '0')}:00.000Z`, fromMe: false, sender: 'Ravi Test', kind: 'text', text: `line ${i}` }));
    const handlers: FakeHandlers = {
      ...readerOf({ pk: () => 42 }),
      newSince: () => ({ chats: [{ chat: ravi, messages: [...filler, venue], earlier: [] }, { chat: asha, messages: [deck], earlier: [] }], nextCursor: { pk: 42, at: venue.at }, truncated: false, reset: false }),
      read: (args) => ({ chat: args.chatKey === ASHA ? asha : ravi, messages: [], more: false }),
    };
    const t = await morningSetup({ handlers, claude: claudeSays(fullAnswer) });
    const run = await t.svc.morning.run({ trigger: 'now' });
    expect(run).toMatchObject({ state: 'ok', counts: { todos: 2, replies: 1, callbacks: 1 } });
    expect(run.summary).toBeTruthy();
    expect(run.dropped.map((d) => d.chatName)).toEqual(['Ravi Test']);
    const titles = (done: boolean) => {
      const r = t.life.todos.listTodos({ done });
      return r.ok ? r.value.todos.map((x) => x.title).sort() : r;
    };
    expect(titles(false)).toEqual(['Call back Ravi Test', 'Check the venue booking', 'Send Asha the deck']);
    // The owner did Asha's todo already: a done todo stays his.
    const deckTodo = run.todoIds.find((id) => {
      const r = t.life.todos.listTodos({ done: false });
      return r.ok && r.value.todos.some((x) => x.id === id && x.title === 'Send Asha the deck');
    })!;
    expect(t.life.todos.setDone(deckTodo, true, CLI).ok).toBe(true);

    // Skipped from the phone: Asha, then Ravi.
    expect(await t.svc.skip.add(ASHA, PHONE)).toEqual({ ok: true, value: {} });
    let today = t.svc.morning.today();
    // Asha's draft is off Today, and the summary that read her chat is gone from every report.
    expect(today.drafts).toEqual([]);
    expect(today.run).not.toHaveProperty('summary');
    expect(today.made[0]).not.toHaveProperty('summary');
    expect(t.svc.morning.last()).not.toHaveProperty('summary');
    expect(today.callbacks.map((c) => c.who)).toEqual(['Ravi Test']);

    expect(await t.svc.skip.add(RAVI, PHONE)).toEqual({ ok: true, value: {} });
    today = t.svc.morning.today();
    expect(today.callbacks).toEqual([]);
    expect(today.run?.dropped).toEqual([]);
    expect(t.svc.morning.last()?.dropped).toEqual([]);
    // Their open todos and call-backs are gone from Life, as Undo takes them; the one he did stays.
    expect(titles(false)).toEqual([]);
    expect(titles(true)).toEqual(['Send Asha the deck']);
    // Nothing anywhere in messages.db's reports still names them.
    const db = (t.svc as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }).db;
    const stored = JSON.stringify(db.prepare("SELECT json FROM runs").all());
    expect(stored).not.toContain('Asha');
    expect(stored).not.toContain('Ravi');
    expect(db.prepare("SELECT state FROM drafts").all()).toEqual([{ state: 'dismissed' }]);
  });

  it("a skip while Life's todos refuse: skipped at once, the answer says its todos leave later, and they leave once Life answers, across a restart too", async () => {
    const dbFile = join(dir, 'owed.db');
    const handlers: FakeHandlers = { ...readerOf({ pk: () => 42 }), read: (args) => ({ chat: args.chatKey === ASHA ? asha : ravi, messages: [], more: false }) };
    const t = await morningSetup({ handlers, claude: claudeSays(fullAnswer), dbFile });
    expect(await t.svc.morning.run({ trigger: 'now' })).toMatchObject({ state: 'ok', counts: { todos: 2, replies: 1, callbacks: 1 } });
    const real = t.life.todos;
    const titles = () => {
      const r = real.listTodos({ done: false });
      return r.ok ? r.value.todos.map((x) => x.title).sort() : r;
    };
    expect(titles()).toEqual(['Call back Ravi Test', 'Check the venue booking', 'Send Asha the deck']);
    const LATER = { ok: true, value: { note: MESSAGES_SAYS.skipTodosLater } };

    // Life closes (every Life module off, or Life broken). Asha is skipped on the phone: at once, and it says her todos wait.
    t.lifeClosed(true);
    expect(await t.svc.skip.add(ASHA, PHONE)).toEqual(LATER);
    expect(t.svc.skip.list().map((e) => e.chatKey)).toEqual([ASHA]);
    expect(t.svc.morning.today().drafts).toEqual([]);
    await t.svc.status();
    // Asked again, it still says so; nothing has left Life yet.
    expect(await t.svc.skip.add(ASHA, PHONE)).toEqual(LATER);
    expect(titles()).toEqual(['Call back Ravi Test', 'Check the venue booking', 'Send Asha the deck']);
    // life.db opens again: her todo leaves before anything else runs, and a skip of her says nothing more.
    t.lifeClosed(false);
    t.lifeOpened();
    expect(titles()).toEqual(['Call back Ravi Test', 'Check the venue booking']);
    expect(await t.svc.skip.add(ASHA, PHONE)).toEqual({ ok: true, value: {} });

    // Closed again, Ravi is skipped: owed across a daemon restart (messages.db on disk) that comes while Life is still closed.
    t.lifeClosed(true);
    expect(await t.svc.skip.add(RAVI, CLI)).toEqual(LATER);
    await t.svc.stop();
    const again = buildMessagesService(t.ctx, { life: t.life, usage: new FakeUsage(), ccwLegacy: new FakeCcwLegacy() }, { dbFile, send: t.push.send });
    await again.start();
    cleanups.push(() => again.stop());
    expect(await again.skip.add(RAVI, CLI)).toEqual(LATER);
    expect(titles()).toEqual(['Call back Ravi Test', 'Check the venue booking']);
    // Life answers again: the next read of Today takes them, and they never show there.
    t.lifeClosed(false);
    expect(again.morning.today().callbacks).toEqual([]);
    expect(titles()).toEqual([]);
    expect(await again.skip.add(RAVI, CLI)).toEqual({ ok: true, value: {} });
    // Nothing is owed any more.
    const db = (again as unknown as { db: { meta(k: string): string | undefined } }).db;
    expect(db.meta(SKIP_OWED_KEY)).toBeUndefined();
  });

  it("a restored Life backup from before a skip doesn't bring the chat's todos back: they leave as life.db opens, or as Messages opens after", async () => {
    const dbFile = join(dir, 'restored.db');
    const handlers: FakeHandlers = { ...readerOf({ pk: () => 42 }), read: (args) => ({ chat: args.chatKey === ASHA ? asha : ravi, messages: [], more: false }) };
    const t = await morningSetup({ handlers, claude: claudeSays(fullAnswer), dbFile });
    expect(await t.svc.morning.run({ trigger: 'now' })).toMatchObject({ state: 'ok', counts: { todos: 2, replies: 1, callbacks: 1 } });
    const titles = () => {
      const r = t.life.todos.listTodos({ done: false });
      return r.ok ? r.value.todos.map((x) => x.title).sort() : r;
    };
    const ALL = ['Call back Ravi Test', 'Check the venue booking', 'Send Asha the deck'];
    expect(titles()).toEqual(ALL);
    // A Life backup made before the skip: putting it back brings its todos rows back, as they were.
    const backup = t.core.db.prepare('SELECT * FROM todos').all() as Record<string, SQLInputValue>[];
    const restore = () => {
      t.core.db.prepare('DELETE FROM todos').run();
      for (const row of backup) {
        const cols = Object.keys(row);
        t.core.db.prepare(`INSERT INTO todos (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]!));
      }
    };
    expect(await t.svc.skip.add(RAVI, PHONE)).toEqual({ ok: true, value: {} });
    expect(titles()).toEqual(['Send Asha the deck']);

    // Restored: Ravi's todo and call-back are back until life.db opens on the restored file (before its first sweep).
    restore();
    expect(titles()).toEqual(ALL);
    t.lifeOpened();
    expect(titles()).toEqual(['Send Asha the deck']);

    // Restored again while Messages is off: they leave once Messages is on again.
    await t.ctx.settings.patch({ messages: { enabled: false } });
    restore();
    t.lifeOpened();
    expect(titles()).toEqual(ALL);
    await t.ctx.settings.patch({ messages: { enabled: true } });
    expect(titles()).toEqual(['Send Asha the deck']);
    // A chat no longer skipped is left alone: its todos are the owner's again.
    expect(t.svc.skip.remove(RAVI, CLI)).toEqual({ ok: true, value: true });
    restore();
    t.lifeOpened();
    expect(titles()).toEqual(ALL);
  });

  it('a skipped chat\'s todo done at the skip stays the owner\'s: reopened or changed later, no Life or Messages open takes it', async () => {
    const handlers: FakeHandlers = { ...readerOf({ pk: () => 42 }), read: (args) => ({ chat: args.chatKey === ASHA ? asha : ravi, messages: [], more: false }) };
    const t = await morningSetup({ handlers, claude: claudeSays(fullAnswer) });
    expect(await t.svc.morning.run({ trigger: 'now' })).toMatchObject({ state: 'ok', counts: { todos: 2, replies: 1, callbacks: 1 } });
    const list = (done: boolean) => {
      const r = t.life.todos.listTodos({ done });
      if (!r.ok) throw new Error(r.reason);
      return r.value.todos;
    };
    const titles = () => list(false).map((x) => x.title).sort();
    const venue = list(false).find((x) => x.title === 'Check the venue booking')!;
    expect(t.life.todos.setDone(venue.id, true, CLI).ok).toBe(true);
    t.clock.advance(MIN);
    // The skip takes Ravi's open call-back; the todo he already did stays.
    expect(await t.svc.skip.add(RAVI, PHONE)).toEqual({ ok: true, value: {} });
    expect(titles()).toEqual(['Send Asha the deck']);
    t.clock.advance(MIN);
    // He reopens it: his, not one a restored backup brought back.
    expect(t.life.todos.setDone(venue.id, false, CLI).ok).toBe(true);
    t.lifeOpened();
    expect(titles()).toEqual(['Check the venue booking', 'Send Asha the deck']);
    await t.ctx.settings.patch({ messages: { enabled: false } });
    await t.ctx.settings.patch({ messages: { enabled: true } });
    expect(titles()).toEqual(['Check the venue booking', 'Send Asha the deck']);
  });

  it("a skip removes its own chat's todos as whoever skipped it, and other chats' still owed to Life as the system", async () => {
    const handlers: FakeHandlers = { ...readerOf({ pk: () => 42 }), read: (args) => ({ chat: args.chatKey === ASHA ? asha : ravi, messages: [], more: false }) };
    const LATER = { ok: true, value: { note: MESSAGES_SAYS.skipTodosLater } };
    /** A run made Asha's todo and Ravi's todo and call-back; `removedBy`: who Life is told removed each, by title, once `watch()`ed. */
    const setup = async () => {
      const t = await morningSetup({ handlers, claude: claudeSays(fullAnswer) });
      expect(await t.svc.morning.run({ trigger: 'now' })).toMatchObject({ state: 'ok', counts: { todos: 2, replies: 1, callbacks: 1 } });
      const real = t.life.todos;
      const listed = real.listTodos({ done: false });
      if (!listed.ok) throw new Error(listed.reason);
      const titleOf = new Map(listed.value.todos.map((x) => [x.id, x.title]));
      const removedBy: [string, Actor['kind']][] = [];
      const watched = new Proxy(real, {
        get(target, key) {
          if (key === 'removeTodo') {
            return (id: string, actor: Actor) => {
              removedBy.push([titleOf.get(id) ?? id, actor.kind]);
              return target.removeTodo(id, actor);
            };
          }
          const v = Reflect.get(target, key, target) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      // Life answers again (no open of life.db: nothing has settled what is owed yet).
      const watch = () => Object.assign(t.life, { todos: watched });
      return { t, removedBy, watch };
    };

    // Asha skipped from the phone while Life is closed: owed. Then Ravi skipped at the Mac: his as the CLI, Asha's as the system.
    const a = await setup();
    a.t.lifeClosed(true);
    expect(await a.t.svc.skip.add(ASHA, PHONE)).toEqual(LATER);
    a.watch();
    expect(await a.t.svc.skip.add(RAVI, CLI)).toEqual({ ok: true, value: {} });
    expect(a.removedBy.sort()).toEqual([
      ['Call back Ravi Test', 'cli'],
      ['Check the venue booking', 'cli'],
      ['Send Asha the deck', 'system'],
    ]);

    // Both owed; Asha skipped again (already on the list) at the Mac: hers as the CLI, Ravi's (the phone's skip) as the system.
    const b = await setup();
    b.t.lifeClosed(true);
    expect(await b.t.svc.skip.add(ASHA, PHONE)).toEqual(LATER);
    expect(await b.t.svc.skip.add(RAVI, PHONE)).toEqual(LATER);
    b.watch();
    expect(await b.t.svc.skip.add(ASHA, CLI)).toEqual({ ok: true, value: {} });
    expect(b.removedBy.sort()).toEqual([
      ['Call back Ravi Test', 'system'],
      ['Check the venue booking', 'system'],
      ['Send Asha the deck', 'cli'],
    ]);
  });

  it('a skip while a run is going stops it: nothing is made, and the next run reads without that chat', async () => {
    let svc: MessagesService | null = null;
    const skipped = new Set<string>();
    const base = readerOf({ pk: () => 42 });
    const handlers: FakeHandlers = {
      ...base,
      newSince: () => ({ chats: [{ chat: ravi, messages: [venue], earlier: [] }, { chat: asha, messages: [deck], earlier: [] }].filter((c) => !skipped.has(c.chat.chatKey)), nextCursor: { pk: 42, at: venue.at }, truncated: false, reset: false }),
      chats: () => ({ chats: [ravi, asha].filter((c) => !skipped.has(c.chatKey)), total: 2 }),
      read: (args) => ({ chat: args.chatKey === ASHA ? asha : ravi, messages: [], more: false }),
    };
    let skips = 0;
    const claude: ExecHandler = async (c) => {
      if (!c.file.endsWith('claude')) return undefined;
      const text = inputOf(c);
      // The owner skips Asha on the phone while Claude is answering the first run.
      if (skips === 0) {
        skips += 1;
        expect(await svc!.skip.add(ASHA, PHONE)).toEqual({ ok: true, value: {} });
        skipped.add(ASHA);
        return { stdout: `${INIT}\n${RESULT(fullAnswer(text))}\n` };
      }
      return { stdout: `${INIT}\n${RESULT({ ...EMPTY, todos: [{ title: 'Check the venue booking', ref: idIn(text, /<m id="(m\d+)"[^>]*>Please check the venue/) }] })}\n` };
    };
    const t = await morningSetup({ handlers, claude });
    svc = t.svc;
    const stopped = await t.svc.morning.run({ trigger: 'now' });
    expect(stopped).toMatchObject({ state: 'failed', why: MESSAGES_SAYS.morningSkipped, todoIds: [], counts: { todos: 0, replies: 0, callbacks: 0 } });
    expect(t.svc.morning.today()).toMatchObject({ drafts: [], callbacks: [] });
    const open = t.life.todos.listTodos({ done: false });
    expect(open.ok && open.value.todos).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.push.pushes).toEqual([]);
    // The cursor stayed: the next run reads the night again, Asha left out.
    const next = await t.svc.morning.run({ trigger: 'now' });
    expect(next).toMatchObject({ state: 'ok', counts: { chats: 1, todos: 1 } });
    expect(cursorsAsked(t.reader)).toEqual([null, null]);
    expect(inputOf(t.exec.calls.filter((c) => c.file.endsWith('claude')).at(-1)!)).not.toContain('Asha');
  });

  it("a Run now after the morning, or a run that failed, keeps the morning's summary, its todos and its Undo on Today", async () => {
    let fresh = true;
    let down = false;
    const base = readerOf({ pk: () => 42 });
    const quiet = { chats: [], nextCursor: { pk: 42, at: venue.at }, truncated: false, reset: false };
    const handlers: FakeHandlers = {
      ...base,
      status: (a) => {
        if (down) throw readerError('busy');
        return base.status!(a);
      },
      newSince: (a) => (fresh ? base.newSince!(a) : quiet),
      waCalls: (a) => (fresh ? base.waCalls!(a) : { calls: [] }),
      chats: (a) => (fresh ? base.chats!(a) : { chats: [], total: 0 }),
    };
    const t = await morningSetup({ handlers, claude: claudeSays(fullAnswer) });
    const morning = await t.svc.morning.run({ trigger: 'timer' });
    expect(morning).toMatchObject({ state: 'ok', counts: { todos: 2 } });
    expect(t.svc.morning.today()).toMatchObject({ run: morning, made: [morning] });

    // After lunch: Run now finds nothing new, then one fails.
    fresh = false;
    t.clock.advance(4 * HOUR);
    const noon = await t.svc.morning.run({ trigger: 'now' });
    expect(noon).toMatchObject({ state: 'ok', counts: { todos: 0, replies: 0, callbacks: 0 } });
    let today = t.svc.morning.today();
    // The newest run for its line; the morning's for its summary, its todos and Undo.
    expect(today.run).toEqual(noon);
    expect(today.made).toEqual([morning]);
    down = true;
    t.clock.advance(HOUR);
    const failed = await t.svc.morning.run({ trigger: 'now' });
    expect(failed.state).toBe('failed');
    today = t.svc.morning.today();
    expect(today.run).toEqual(failed);
    expect(today.made).toEqual([morning]);
    // Its Undo still works.
    expect(t.svc.morning.undo(today.made[0]!.id, PHONE)).toEqual({ ok: true, value: true });
    const open = t.life.todos.listTodos({ done: false });
    expect(open.ok && open.value.todos).toEqual([]);

    // The next morning's timer run made nothing: yesterday's isn't this morning's.
    down = false;
    t.clock.advance(19 * HOUR);
    const tomorrow = await t.svc.morning.run({ trigger: 'timer' });
    expect(tomorrow.state).toBe('ok');
    expect(t.svc.morning.today()).toMatchObject({ run: tomorrow, made: [] });
  });

  it("every run today that made something keeps its own Undo: an earlier Run now after an empty timer run, a later one beside the morning's", async () => {
    let phase: 'night' | 'quiet' | 'noon' = 'night';
    const base = readerOf({ pk: () => 42 });
    const charger: Message = { msgKey: `${ASHA}.3EB0A2`, at: '2026-11-14T07:00:00.000Z', fromMe: false, sender: 'Asha Test', kind: 'text', text: 'Bring the charger too' };
    const page = (chats: { chat: ChatOwner; messages: Message[]; earlier: Message[] }[]) => ({ chats, nextCursor: { pk: 42, at: venue.at }, truncated: false, reset: false });
    const handlers: FakeHandlers = {
      ...base,
      newSince: (a) => (phase === 'night' ? base.newSince!(a) : phase === 'noon' ? page([{ chat: asha, messages: [charger], earlier: [] }]) : page([])),
      waCalls: (a) => (phase === 'night' ? base.waCalls!(a) : { calls: [] }),
      chats: (a) => (phase === 'night' ? base.chats!(a) : { chats: [], total: 0 }),
    };
    const answer = (text: string): MorningAnswer =>
      text.includes('Bring the charger') ? { ...EMPTY, todos: [{ title: 'Bring the charger', ref: idIn(text, /<m id="(m\d+)"[^>]*>Bring the charger/) }] } : fullAnswer(text);
    // Sat 07:00 in the Life zone: a Run now makes the night's todos, draft and call-back.
    const t = await morningSetup({ handlers, claude: claudeSays(answer), now: '2026-11-14T01:30:00.000Z' });
    const early = await t.svc.morning.run({ trigger: 'now' });
    expect(early).toMatchObject({ state: 'ok', counts: { todos: 2, replies: 1, callbacks: 1 } });

    // 08:30: the timer's run finds nothing new. The 07:00 run keeps its place, its summary and its Undo.
    phase = 'quiet';
    t.clock.advance(90 * MIN);
    const timer = await t.svc.morning.run({ trigger: 'timer' });
    expect(timer).toMatchObject({ state: 'ok', counts: { todos: 0, replies: 0, callbacks: 0 } });
    expect(t.svc.morning.today()).toMatchObject({ run: timer, made: [early] });

    // 13:00: a Run now makes one more todo. Both runs are listed, newest first, each with its own Undo.
    phase = 'noon';
    t.clock.advance(4 * HOUR + 30 * MIN);
    const noon = await t.svc.morning.run({ trigger: 'now' });
    expect(noon).toMatchObject({ state: 'ok', counts: { todos: 1 } });
    expect(t.svc.morning.today()).toMatchObject({ run: noon, made: [noon, early] });
    const open = () => {
      const r = t.life.todos.listTodos({ done: false });
      return r.ok ? r.value.todos.map((x) => x.title).sort() : r;
    };
    expect(open()).toEqual(['Bring the charger', 'Call back Ravi Test', 'Check the venue booking', 'Send Asha the deck']);
    // The morning's Undo takes only the morning's; the noon one's stays, and has its own.
    expect(t.svc.morning.undo(early.id, PHONE)).toEqual({ ok: true, value: true });
    expect(open()).toEqual(['Bring the charger']);
    expect(t.svc.morning.undo(noon.id, PHONE)).toEqual({ ok: true, value: true });
    expect(open()).toEqual([]);

    // Tomorrow: yesterday's runs aren't today's.
    t.clock.advance(12 * HOUR);
    expect(t.svc.morning.today().made).toEqual([]);
  });

  it("a reader of another build fails the run with the update-needed sentence, not WhatsApp's", async () => {
    const t = await morningSetup({ handlers: { ...readerOf({ pk: () => 42 }), newSince: () => ({ rows: [] }) }, claude: claudeSays(fullAnswer) });
    const run = await t.svc.morning.run({ trigger: 'now' });
    expect(run).toMatchObject({ state: 'failed', why: MESSAGES_SAYS.updateNeeded });
  });

  it('a Claude run that takes minutes: each call-back and timed todo still rings, or keeps its day (time_passed)', async () => {
    // Run now at 12:44:30 in the Life zone; Claude answers four minutes later, past 12:45 and Life's two minutes' grace.
    const slow = (answer: (text: string) => MorningAnswer): ExecHandler => (c) => {
      if (!c.file.endsWith('claude')) return undefined;
      clock!.advance(4 * MIN);
      return { stdout: `${INIT}\n${RESULT(answer(inputOf(c)))}\n` };
    };
    let clock: FakeClock | null = null;
    const answer = (text: string): MorningAnswer => {
      const a = fullAnswer(text);
      // A time the deck's line states ("5pm"), as the model put it: 12:46 today, gone by the time it applies.
      return { ...a, todos: [{ ...a.todos[0]!, due_day: '2026-11-14', due_time: '12:46' }, a.todos[1]!] };
    };
    const at = '2026-11-14T07:14:30.000Z';
    const t = await morningSetup({ handlers: readerOf({ pk: () => 42 }), claude: slow(answer), now: at });
    clock = t.clock;
    const run = await t.svc.morning.run({ trigger: 'now' });
    expect(run).toMatchObject({ state: 'ok', counts: { todos: 2, callbacks: 1 } });
    // The call-back rings at the quarter hour after the answer came (13:00), not 12:45.
    const ringsAt = instantAt('2026-11-14', '13:00', TZ).toISOString();
    const [cb] = t.svc.morning.today().callbacks;
    expect(cb).toEqual({ todoId: expect.any(String), who: 'Ravi Test', at: ringsAt });
    expect(t.core.scheduler.row('todo', cb!.todoId)?.nextAt).toBe(ringsAt);
    // Every todo with a time has its ring; the deck's time had gone, so it keeps its day only.
    const open = t.life.todos.listTodos({ done: false });
    const todos = open.ok ? open.value.todos : [];
    expect(todos.find((x) => x.title === 'Send Asha the deck')?.due).toEqual({ day: '2026-11-14' });
    for (const x of todos) if (x.due?.time) expect(t.core.scheduler.row('todo', x.id)?.nextAt, x.title).toBe(instantAt(x.due.day, x.due.time, TZ).toISOString());

    // A dry run says so: both time_passed.
    let dryClock: FakeClock | null = null;
    const d = await morningSetup({ handlers: readerOf({ pk: () => 42 }), claude: (c) => {
      if (!c.file.endsWith('claude')) return undefined;
      dryClock!.advance(4 * MIN);
      return { stdout: `${INIT}\n${RESULT(answer(inputOf(c)))}\n` };
    }, now: at });
    dryClock = d.clock;
    const dry = await d.svc.morning.run({ trigger: 'dry' });
    expect(dry.preview?.callbacks).toEqual([{ who: 'Ravi Test', at: ringsAt }]);
    expect(dry.preview?.dropped.map((x) => [x.kind, x.why])).toEqual([
      ['todo', 'time_passed'],
      ['callback', 'time_passed'],
    ]);
  });

  it("a skip of a chat the run didn't read doesn't stop it", async () => {
    const NEEL = 'cc3d4e5f6a7b8c9d0';
    const neel = chatOf(NEEL, 'Neel Test', '919990000004');
    let svc: MessagesService | null = null;
    const base = readerOf({ pk: () => 42 });
    const handlers: FakeHandlers = { ...base, read: (args) => ({ chat: args.chatKey === NEEL ? neel : args.chatKey === ASHA ? asha : ravi, messages: [], more: false }) };
    const claude: ExecHandler = async (c) => {
      if (!c.file.endsWith('claude')) return undefined;
      // The owner skips Neel on the phone while Claude is answering: Neel isn't in this run.
      expect(await svc!.skip.add(NEEL, PHONE)).toEqual({ ok: true, value: {} });
      return { stdout: `${INIT}\n${RESULT(fullAnswer(inputOf(c)))}\n` };
    };
    const t = await morningSetup({ handlers, claude });
    svc = t.svc;
    const run = await t.svc.morning.run({ trigger: 'now' });
    expect(run).toMatchObject({ state: 'ok', counts: { todos: 2, replies: 1, callbacks: 1 } });
    expect(run.summary).toBeTruthy();
    expect(t.svc.skip.list().map((e) => e.chatKey)).toEqual([NEEL]);
    await eventually(() => t.push.pushes.length > 0);
  });

  it("Life's Todos off (another Life module on): replies are drafted, todos and call-backs aren't, and the report says why", async () => {
    const t = await morningSetup({ handlers: readerOf({ pk: () => 42 }), claude: claudeSays(fullAnswer), life: { todos: false, medicines: true } });
    const run = await t.svc.morning.run({ trigger: 'now' });
    expect(run).toMatchObject({ state: 'ok', lifeRefused: 'life_refused', counts: { todos: 0, callbacks: 0, replies: 1 }, todoIds: [] });
    const open = t.life.todos.listTodos({ done: false });
    expect(open.ok && open.value.todos).toEqual([]);
    const projects = t.life.todos.listProjects();
    expect(projects.ok && projects.value.projects).toEqual([]);
    expect(t.svc.morning.today()).toMatchObject({ drafts: [expect.objectContaining({ chatKey: ASHA })], callbacks: [] });
  });

  it('Run now and a dry run log their reads under who asked (the CLI, a session, the phone); the timer under the morning run', async () => {
    const t = await morningSetup({ handlers: readerOf({ pk: () => 42 }), claude: claudeSays(() => EMPTY), now: '2026-11-14T02:29:00.000Z' });
    const morningReads = () => t.svc.reads(100).filter((r) => r.op === 'morning').map((r) => [r.via, r.chatKey ?? 'calls', r.pid ?? null, r.folder ?? null]);
    await t.svc.morning.run({ trigger: 'dry', by: { via: 'cli' } });
    expect(morningReads()).toEqual([
      ['cli', 'calls', null, null],
      ['cli', ASHA, null, null],
      ['cli', RAVI, null, null],
    ]);
    await t.svc.morning.run({ trigger: 'now', by: { via: 'mcp', pid: 4242, folder: '/synthetic/home/proj' } });
    expect(morningReads().slice(0, 3)).toEqual([
      ['mcp', 'calls', 4242, 'proj'],
      ['mcp', ASHA, 4242, 'proj'],
      ['mcp', RAVI, 4242, 'proj'],
    ]);
    // The timer's own run, at 08:00.
    expect(t.svc.morning.setPrefs({ morningAt: '08:00' }, CLI).ok).toBe(true);
    t.clock.advance(MIN);
    await eventually(() => t.svc.morning.last()?.trigger === 'timer' && t.svc.morning.last()?.state === 'ok');
    // (The missed call came before where Run now got to: two chats this time.)
    expect(morningReads().slice(0, 3).map((r) => r.slice(0, 2))).toEqual([
      ['morning', ASHA],
      ['morning', RAVI],
      ['mcp', 'calls'],
    ]);
  });

  it('a timer run refused while a dry run is going runs a minute after it ends; the morning is then marked done', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const claude: ExecHandler = async (c) => {
      if (!c.file.endsWith('claude')) return undefined;
      runs += 1;
      // The first (the dry run at 07:59) waits for the test.
      if (runs === 1) await gate;
      return { stdout: `${INIT}\n${RESULT(fullAnswer(inputOf(c)))}\n` };
    };
    // 07:59 in the Life zone, the morning time 08:00.
    const t = await morningSetup({ handlers: readerOf({ pk: () => 42 }), claude, now: '2026-11-14T02:29:00.000Z' });
    expect(t.svc.morning.setPrefs({ morningAt: '08:00' }, CLI).ok).toBe(true);
    const dry = t.svc.morning.run({ trigger: 'dry', by: { via: 'cli' } });
    await eventually(() => runs === 1);
    // 08:00: the timer's run is refused (one run at a time).
    t.clock.advance(MIN);
    await eventually(() => t.ctx.log.records.some((r) => r.msg === 'messages: the morning run did not start'));
    release();
    expect(await dry).toMatchObject({ trigger: 'dry', state: 'ok' });
    // A minute later it asks again, and runs.
    t.clock.advance(MIN);
    const run = await eventually(() => {
      const r = t.svc.morning.last();
      return r?.trigger === 'timer' && r.state !== 'running' ? r : null;
    });
    expect(run).toMatchObject({ state: 'ok', at: '2026-11-14T02:31:00.000Z', counts: { todos: 2 } });
    await eventually(() => t.push.pushes.length > 0);
    // Marked done: the morning that was due at 08:00.
    const db = (t.svc as unknown as { db: { meta(k: string): string | undefined } }).db;
    expect(db.meta('morning.last_at')).toBe('2026-11-14T02:30:00.000Z');
    t.clock.advance(3 * HOUR);
    await new Promise((r) => setTimeout(r, 20));
    expect(runs).toBe(2);
  });

  it('a morning time set after it has passed today waits for tomorrow', async () => {
    // 10:00 in the Life zone.
    const t = await morningSetup({ handlers: readerOf({ pk: () => 42 }), claude: claudeSays(() => EMPTY), now: '2026-11-14T04:30:00.000Z' });
    expect(t.svc.morning.setPrefs({ morningAt: '08:00' }, CLI).ok).toBe(true);
    t.clock.advance(MIN);
    await new Promise((r) => setTimeout(r, 30));
    expect(t.reader.calls.filter((c) => c.op === 'status')).toEqual([]);
    expect(t.svc.morning.last()).toBeNull();
    // Tomorrow at 08:00 it runs.
    t.clock.set('2026-11-15T02:30:00.000Z');
    const run = await eventually(() => {
      const r = t.svc.morning.last();
      return r && r.state !== 'running' ? r : null;
    });
    expect(run).toMatchObject({ trigger: 'timer', state: 'ok', at: '2026-11-15T02:30:00.000Z' });
  });

  it('a morning time set after it has passed stays done for today after a daemon restart', async () => {
    // 10:00 in the Life zone, messages.db on disk: set to 08:00, today's morning is left.
    const dbFile = join(dir, 'restart.db');
    const t = await morningSetup({ handlers: readerOf({ pk: () => 42 }), claude: claudeSays(() => EMPTY), now: '2026-11-14T04:30:00.000Z', dbFile });
    expect(t.svc.morning.setPrefs({ morningAt: '08:00' }, CLI).ok).toBe(true);
    t.clock.advance(5 * MIN);
    await t.svc.stop();
    // The daemon starts again at 10:05, inside that morning's 6-hour wait: a new part (and timer) on the same messages.db.
    const again = buildMessagesService(t.ctx, { life: t.life, usage: new FakeUsage(), ccwLegacy: new FakeCcwLegacy() }, { dbFile, send: t.push.send });
    await again.start();
    cleanups.push(() => again.stop());
    expect(again.morning.prefs().morningAt).toBe('08:00');
    t.clock.advance(MIN);
    await new Promise((r) => setTimeout(r, 30));
    expect(t.reader.calls.filter((c) => c.op === 'status')).toEqual([]);
    expect(again.morning.last()).toBeNull();
    // Tomorrow at 08:00 it runs.
    t.clock.set('2026-11-15T02:30:00.000Z');
    const run = await eventually(() => {
      const r = again.morning.last();
      return r && r.state !== 'running' ? r : null;
    });
    expect(run).toMatchObject({ trigger: 'timer', state: 'ok', at: '2026-11-15T02:30:00.000Z' });
  });

  it('a draft the owner answered in WhatsApp itself leaves Today at the next run', async () => {
    let night = 1;
    const answered: Message = { msgKey: `${ASHA}.3EB0A2`, at: '2026-11-14T05:00:00.000Z', fromMe: true, sender: 'Me', kind: 'text', text: 'Sent it' };
    const base = readerOf({ pk: () => 42 });
    const handlers: FakeHandlers = {
      ...base,
      newSince: () => ({ chats: night === 1 ? [{ chat: asha, messages: [deck], earlier: [] }] : [{ chat: asha, messages: [answered], earlier: [deck] }], nextCursor: { pk: 42, at: deck.at }, truncated: false, reset: false }),
      waCalls: () => ({ calls: [] }),
      lastFromMe: (args) => Object.fromEntries((args.chatKeys as string[]).map((k) => [k, night === 2 && k === ASHA ? answered.at : null])),
      chats: () => ({ chats: night === 1 ? [asha] : [], total: night === 1 ? 1 : 0 }),
    };
    const answer = (text: string): MorningAnswer =>
      night === 1 ? { ...EMPTY, replies: [{ chat: idIn(text, /<chat id="(c\d+)" name="Asha Test"/), ref: idIn(text, /<m id="(m\d+)"[^>]*>Can you send the deck/), they_asked: 'The deck', draft: 'Sending it tonight.' }] } : EMPTY;
    const t = await morningSetup({ handlers, claude: claudeSays(answer) });
    await t.svc.morning.run({ trigger: 'now' });
    expect(t.svc.morning.today().drafts).toEqual([expect.objectContaining({ chatKey: ASHA, state: 'open' })]);
    // He replied in WhatsApp: the next run sees his line, and the draft goes.
    night = 2;
    t.clock.advance(24 * HOUR);
    expect(await t.svc.morning.run({ trigger: 'now' })).toMatchObject({ state: 'ok' });
    expect(t.svc.morning.today().drafts).toEqual([]);
    const db = (t.svc as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }).db;
    expect(db.prepare('SELECT state FROM drafts').all()).toEqual([{ state: 'dismissed' }]);
  });
});

/** A part whose reader isn't there: Run now fails with the down sentence (and is stored as failed). */
async function morningSetupDown() {
  const paths: Paths = { ...resolvePaths({ env: { HOME: dir }, userHome: dir, home: join(dir, 'd') }), messagesReaderSock: join(dir, 'none.sock') };
  const ctx = createTestContext({ paths, clock: new FakeClock(NOW), settings: SettingsSchema.parse({ messages: { enabled: true } }) });
  const life = { todos: null, status: () => ({ timezone: TZ }) } as unknown as LifeService;
  const svc = buildMessagesService(ctx, { life, usage: new FakeUsage(), ccwLegacy: new FakeCcwLegacy() }, { dbFile: ':memory:' });
  await svc.start();
  cleanups.push(() => svc.stop());
  const run = await svc.morning.run({ trigger: 'now' });
  expect(svc.morning.last()).toEqual(run);
  return run;
}
