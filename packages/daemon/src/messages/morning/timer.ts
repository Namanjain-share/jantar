/**
 * The morning run's timer (0.15 Messages): once a day at the owner's
 * morning time (prefs morningAt) in the Life zone, on Life's backup timer's
 * wall-clock loop (life/backup.ts BackupTimer): the due time is a wall-clock
 * instant looked at again at least every BACKUP_CHECK_MS, because Node's
 * timers stop while the Mac sleeps.
 *
 * - Due: it asks `ready()` (the reader's status) every READY_POLL_MS until
 *   WhatsApp is running and has written nothing for quietMs (synced), then
 *   runs; waitForWhatsAppMs after the due time it runs anyway, `stale` (the
 *   report says how fresh WhatsApp's data was). A reader that doesn't
 *   answer is not ready.
 * - A run the service refuses (another run going, Messages unavailable) is
 *   asked for again READY_POLL_MS later, while that wait lasts.
 * - A morning time the Mac slept through, or the daemon was down for, runs
 *   once on wake while within waitForWhatsAppMs of it; a wake later than
 *   that leaves the day (the next run reads from where the last good one
 *   stopped). So does a sleep in the middle of a wait that wakes after its
 *   end (more than READY_POLL_MS late): the next morning due is the one run,
 *   never two close together.
 * - Once a day: a morning is done when `lastAt()` (messages.db's mark of a
 *   timer run that went well, or of a morning a new time left) or a run
 *   this timer started was for a morning on that day. Both are instants, read as days in the Life zone as it is
 *   now, so a move west never takes the next morning there; a big move east
 *   (the US to Japan) skips the first one there, never two runs hours apart.
 * - No time set: idle, no timer at all. `rearm()` when the zone changes,
 *   `retime()` when the time does; while waiting for WhatsApp it starts
 *   over from the new time. A new time already past today counts as done
 *   for today (no run at once), unless that day's morning was already due;
 *   `passed()` saves that mark (messages.db), so a restart inside that
 *   morning's wait leaves it too (lastAt() reads it back).
 * - `run` is the service's (it keeps one run at a time); a throw from it is
 *   logged by name. Nothing here logs more.
 */
import { dayKeyOf, instantAt, shiftDay } from '@jantar/life-core';
import { MESSAGES_LIMITS, type HhMm } from '@jantar/protocol';
import type { Clock, Logger, TimerId } from '../../contracts.js';
import { BACKUP_CHECK_MS } from '../../life/backup.js';

/** How often a due morning asks whether WhatsApp is ready, or asks again for a run the service refused. */
export const READY_POLL_MS = BACKUP_CHECK_MS;
/** The days looked at for the next morning: yesterday's (a late time's six hours can pass midnight) to the day after tomorrow. */
const FIRST_DAY = -1;
const LAST_DAY = 2;

/** WhatsApp as the reader sees it: open, and how long since it last wrote (its -wal file). */
export interface WhatsAppReady {
  running: boolean;
  walQuietMs: number;
}

/** The morning a timer waits for: its day and when it is due (epoch ms). */
export interface NextMorning {
  day: string;
  dueAt: number;
}

export interface MorningTimerOptions {
  /** The Life zone. */
  tz: () => string;
  /** The morning time (HH:MM), or null: off. */
  at: () => HhMm | null;
  /** When the newest morning marked done was due (epoch ms; messages.db meta: a timer run that went well, or passed()), or null. */
  lastAt: () => number | null;
  /** A new time left the morning due at `dueAt` (epoch ms) as done: saved for lastAt() after a restart. Never throws. */
  passed: (dueAt: number) => void;
  ready: () => Promise<WhatsAppReady>;
  /** The run for `morning`: true once it started (whatever its end), false when the service refused it. */
  run: (stale: boolean, morning: NextMorning) => Promise<boolean>;
}

/** The next morning at `now` whose waitForWhatsAppMs isn't over and that isn't `done`. */
export function nextMorning(now: number, at: HhMm, tz: string, done: (day: string) => boolean): NextMorning {
  const today = dayKeyOf(new Date(now), tz);
  let pick: NextMorning = { day: today, dueAt: 0 };
  for (let d = FIRST_DAY; d <= LAST_DAY; d++) {
    const day = shiftDay(today, d);
    pick = { day, dueAt: instantAt(day, at, tz).getTime() };
    if (now < pick.dueAt + MESSAGES_LIMITS.waitForWhatsAppMs && !done(day)) return pick;
  }
  return pick;
}

export class MorningTimer {
  private timer: TimerId | undefined;
  private running = false;
  /** Moved on by stop(), rearm() and retime(): a ready() answer from before them is dropped. */
  private epoch = 0;
  private next: NextMorning | null = null;
  /** When the morning this timer last started a run for was due, or one a new time left as done (epoch ms). */
  private fired: number | null = null;
  /** A run is going; its end arms again. */
  private inRun = false;
  /** The time changed: the next arm() leaves a morning already past, but for this day (one already due when it changed). */
  private retimed: { keep: string | null } | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly opts: MorningTimerOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.arm();
  }

  stop(): void {
    this.running = false;
    this.epoch += 1;
    this.clear();
    this.next = null;
  }

  /** The zone changed. */
  rearm(): void {
    if (!this.running) return;
    this.epoch += 1;
    if (!this.inRun) this.arm();
  }

  /** The morning time changed (prefs): one already past today waits for tomorrow. */
  retime(): void {
    if (!this.running) return;
    const due = this.next !== null && this.clock.now() >= this.next.dueAt ? this.next.day : null;
    this.retimed = { keep: due };
    this.rearm();
  }

  private clear(): void {
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    this.clear();
    this.next = null;
    const retimed = this.retimed;
    this.retimed = null;
    const at = this.opts.at();
    if (at === null) return;
    const tz = this.opts.tz();
    const ran = (ms: number | null, day: string) => ms !== null && dayKeyOf(new Date(ms), tz) === day;
    const done = (day: string) => ran(this.opts.lastAt(), day) || ran(this.fired, day);
    const now = this.clock.now();
    let next = nextMorning(now, at, tz, done);
    // Set after it had passed: that morning counts as done, after a restart too.
    if (retimed && next.dueAt <= now && next.day !== retimed.keep) {
      this.fired = next.dueAt;
      this.opts.passed(next.dueAt);
      next = nextMorning(now, at, tz, done);
    }
    this.next = next;
    this.wait();
  }

  /** Ask once the wall clock has reached the due time; until then look again in at most BACKUP_CHECK_MS. */
  private wait(): void {
    this.clear();
    const next = this.next;
    if (!next) return;
    const now = this.clock.now();
    // Asleep through the whole wait: that day is left.
    if (now >= next.dueAt + MESSAGES_LIMITS.waitForWhatsAppMs) return this.arm();
    if (now >= next.dueAt) return void this.poll(next, this.epoch);
    this.timer = this.clock.setTimeout(() => this.wait(), Math.min(next.dueAt - now, BACKUP_CHECK_MS));
  }

  private async poll(next: NextMorning, epoch: number): Promise<void> {
    this.clear();
    let r: WhatsAppReady | null;
    try {
      r = await this.opts.ready();
    } catch {
      r = null;
    }
    if (!this.running || epoch !== this.epoch) return;
    const ready = r !== null && r.running && r.walQuietMs >= MESSAGES_LIMITS.quietMs;
    const until = next.dueAt + MESSAGES_LIMITS.waitForWhatsAppMs;
    const now = this.clock.now();
    // Asleep through the end of this wait: that day is left, as in wait().
    if (now - until > READY_POLL_MS) return this.arm();
    if (ready || now >= until) return this.go(next, !ready);
    this.timer = this.clock.setTimeout(() => void this.poll(next, epoch), Math.min(READY_POLL_MS, until - now));
  }

  private go(next: NextMorning, stale: boolean): void {
    this.clear();
    this.inRun = true;
    const epoch = this.epoch;
    void this.opts
      .run(stale, next)
      .catch((e: unknown) => {
        this.log.error('messages: the morning run failed', { event: 'messages.morning', error: e instanceof Error ? e.name : 'unknown' });
        return true;
      })
      .then((started) => {
        this.inRun = false;
        if (started) this.fired = next.dueAt;
        if (!this.running) return;
        // Refused: asked for again in a minute, while its wait lasts (poll() leaves the day after it).
        if (started || epoch !== this.epoch) return this.arm();
        this.timer = this.clock.setTimeout(() => void this.poll(next, epoch), READY_POLL_MS);
      });
  }
}
