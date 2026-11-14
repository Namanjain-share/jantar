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
 *   reports and out of Life, and stops a run going; a later Run now, or a
 *   failed run, keeps the morning's summary, todos and Undo on Today.
 * Synthetic chat keys, fake numbers and invented names only.
 */
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES_LIMITS, SettingsSchema } from '@jantar/protocol';
import type { Call, ChatOwner, Message, MorningAnswer } from '@jantar/protocol/messages';
import { ApiError } from '../../src/api/errors.js';
import { resolvePaths } from '../../src/config.js';
import type { Actor, Clock, LifeService, MessagesService, Paths } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { createFakeExec, createPushSpy, createTestContext, createTestLifeCore, type ExecCall, type ExecHandler, type PushSpy, type TestContext, type TestLifeCore } from '../../src/core/testing.js';
import { BACKUP_CHECK_MS } from '../../src/life/backup.js';
import { buildTodosModule } from '../../src/life/todos/module.js';
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

/** A timer on `clock` whose runs are recorded; `state` is what its callbacks read. */
function timerOn(clock: Clock, state: { at: string | null; tz: string; lastDay: string | null; ready: () => WhatsAppReady | Promise<WhatsAppReady> }) {
  const fired: Fired[] = [];
  const asked: string[] = [];
  const timer = new MorningTimer(clock, createTestContext().log, {
    tz: () => state.tz,
    at: () => state.at,
    lastDay: () => state.lastDay,
    ready: async () => {
      asked.push(clock.iso());
      return state.ready();
    },
    run: async (stale, day) => {
      fired.push({ at: clock.iso(), stale, day });
    },
  });
  return { timer, fired, asked };
}

describe('MorningTimer', () => {
  it('fires at the set time once a day', async () => {
    const clock = new FakeClock('2026-11-14T06:00:00.000Z');
    const state = { at: '08:00', tz: 'UTC', lastDay: null as string | null, ready: () => READY };
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
    const again = timerOn(late, { ...state, lastDay: '2026-11-16' });
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
    const { timer, fired } = timerOn(clock, { at: '08:00', tz: 'UTC', lastDay: null, ready: () => READY });
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
    const { timer, fired } = timerOn(clock, { at: '08:00', tz: 'UTC', lastDay: null, ready: () => ready });
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
    const { timer, fired } = timerOn(clock, { at: '08:00', tz: 'UTC', lastDay: null, ready: () => ready });
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
    const { timer, fired } = timerOn(clock, { at: '08:00', tz: 'UTC', lastDay: null, ready: () => ready });
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
    const state = { at: '08:00', tz: 'UTC', lastDay: null as string | null, ready: (): WhatsAppReady | Promise<WhatsAppReady> => ({ running: false, walQuietMs: 0 }) };
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
    const { timer, fired, asked } = timerOn(clock, { at: null, tz: 'UTC', lastDay: null, ready: () => READY });
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
    const state = { at: null as string | null, tz: 'UTC', lastDay: null as string | null, ready: () => READY };
    const { timer, fired } = timerOn(clock, state);
    timer.start();
    await flush();
    try {
      state.at = '09:00';
      timer.rearm();
      await step(clock, 3 * HOUR - MIN);
      expect(fired).toEqual([]);
      await step(clock, MIN);
      expect(fired.map((f) => f.at)).toEqual(['2026-11-14T09:00:00.000Z']);

      // Earlier the next day: 07:00.
      state.at = '07:00';
      timer.rearm();
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
      timer.rearm();
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
    const state = { at: '08:00' as string | null, tz: 'UTC', lastDay: null as string | null, ready: () => ready };
    const { timer, fired } = timerOn(clock, state);
    timer.start();
    await flush();
    try {
      await step(clock, 10 * MIN);
      expect(fired).toEqual([]);
      // Moved to 09:00 while waiting: today's run is at 09:00 (not run yet), WhatsApp now ready.
      state.at = '09:00';
      timer.rearm();
      ready = READY;
      await step(clock, 49 * MIN);
      expect(fired).toEqual([]);
      await step(clock, MIN);
      expect(fired).toEqual([{ at: '2026-11-14T09:00:00.000Z', stale: false, day: '2026-11-14' }]);
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
}

/** The part on Messages on, messages.db in memory, Life's todos in memory, a fake reader and a fake claude answering `claude`. */
let setups = 0;
async function morningSetup(o: { handlers: FakeHandlers; claude: ExecHandler; readOnly?: boolean; now?: string }): Promise<Morning> {
  setups += 1;
  const paths: Paths = { ...resolvePaths({ env: { HOME: dir }, userHome: dir, home: join(dir, `j${setups}`) }), messagesReaderSock: join(dir, `r${setups}.sock`) };
  const clock = new FakeClock(o.now ?? NOW);
  const exec = createFakeExec(o.claude);
  const ctx = createTestContext({ paths, clock, exec, accountsMode: 'single', settings: SettingsSchema.parse({ messages: { enabled: true } }) });
  const core = createTestLifeCore({ clock, tz: TZ, settings: { todos: true } });
  const f = makeFakes(ctx);
  const todos = buildTodosModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
  // Life's zone: its setting once set (as Life takes it), else TZ.
  const life = { todos, status: () => ({ timezone: ctx.settings.get().life.timezone || TZ }) } as unknown as LifeService;
  const reader = await startFakeReader(paths.messagesReaderSock, o.handlers);
  const push = createPushSpy();
  const svc = buildMessagesService(ctx, { life, usage: new FakeUsage(), ccwLegacy: new FakeCcwLegacy() }, { dbFile: ':memory:', send: push.send, readOnly: o.readOnly === true });
  await svc.start();
  cleanups.push(() => reader.close());
  cleanups.push(() => svc.stop());
  cleanups.push(() => core.close());
  return { ctx, svc, clock, reader, push, life, exec, paths, core };
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
    expect(t.svc.morning.today()).toEqual({ run: null, made: null, drafts: [], callbacks: [] });
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
    expect(await t.svc.skip.add(ASHA, PHONE)).toEqual({ ok: true, value: true });
    let today = t.svc.morning.today();
    // Asha's draft is off Today, and the summary that read her chat is gone from every report.
    expect(today.drafts).toEqual([]);
    expect(today.run).not.toHaveProperty('summary');
    expect(today.made).not.toHaveProperty('summary');
    expect(t.svc.morning.last()).not.toHaveProperty('summary');
    expect(today.callbacks.map((c) => c.who)).toEqual(['Ravi Test']);

    expect(await t.svc.skip.add(RAVI, PHONE)).toEqual({ ok: true, value: true });
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
        expect(await svc!.skip.add(ASHA, PHONE)).toEqual({ ok: true, value: true });
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
    expect(t.svc.morning.today()).toMatchObject({ run: morning, made: morning });

    // After lunch: Run now finds nothing new, then one fails.
    fresh = false;
    t.clock.advance(4 * HOUR);
    const noon = await t.svc.morning.run({ trigger: 'now' });
    expect(noon).toMatchObject({ state: 'ok', counts: { todos: 0, replies: 0, callbacks: 0 } });
    let today = t.svc.morning.today();
    // The newest run for its line; the morning's for its summary, its todos and Undo.
    expect(today.run).toEqual(noon);
    expect(today.made).toEqual(morning);
    down = true;
    t.clock.advance(HOUR);
    const failed = await t.svc.morning.run({ trigger: 'now' });
    expect(failed.state).toBe('failed');
    today = t.svc.morning.today();
    expect(today.run).toEqual(failed);
    expect(today.made).toEqual(morning);
    // Its Undo still works.
    expect(t.svc.morning.undo(today.made!.id, PHONE)).toEqual({ ok: true, value: true });
    const open = t.life.todos.listTodos({ done: false });
    expect(open.ok && open.value.todos).toEqual([]);

    // The next morning's timer run made nothing: yesterday's isn't this morning's.
    down = false;
    t.clock.advance(19 * HOUR);
    const tomorrow = await t.svc.morning.run({ trigger: 'timer' });
    expect(tomorrow.state).toBe('ok');
    expect(t.svc.morning.today()).toMatchObject({ run: tomorrow, made: null });
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
