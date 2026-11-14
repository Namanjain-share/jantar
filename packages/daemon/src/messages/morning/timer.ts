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
 * - A morning time the Mac slept through, or the daemon was down for, runs
 *   once on wake while within waitForWhatsAppMs of it; a wake later than
 *   that leaves the day (the next run reads from where the last good one
 *   stopped). So does a sleep in the middle of a wait that wakes after its
 *   end (more than READY_POLL_MS late): the next morning due is the one run,
 *   never two close together.
 * - Once a day: a day `lastDay()` names (messages.db's mark of a timer run
 *   that went well) or this timer already started a run for is never run
 *   again.
 * - No time set: idle, no timer at all. `rearm()` when the time or the zone
 *   changes; while waiting for WhatsApp it starts over from the new time.
 * - `run` is the service's (it keeps one run at a time); a throw from it is
 *   logged by name. Nothing here logs more.
 */
import { dayKeyOf, instantAt, shiftDay } from '@jantar/life-core';
import { MESSAGES_LIMITS, type HhMm } from '@jantar/protocol';
import type { Clock, Logger, TimerId } from '../../contracts.js';
import { BACKUP_CHECK_MS } from '../../life/backup.js';

/** How often a due morning asks whether WhatsApp is ready. */
export const READY_POLL_MS = BACKUP_CHECK_MS;
/** The days looked at for the next morning: yesterday's (a late time's six hours can pass midnight) to the day after tomorrow. */
const FIRST_DAY = -1;
const LAST_DAY = 2;

/** WhatsApp as the reader sees it: open, and how long since it last wrote (its -wal file). */
export interface WhatsAppReady {
  running: boolean;
  walQuietMs: number;
}

export interface MorningTimerOptions {
  /** The Life zone. */
  tz: () => string;
  /** The morning time (HH:MM), or null: off. */
  at: () => HhMm | null;
  /** The newest day (Life zone) a timer run went well on (messages.db meta morning.last_day). */
  lastDay: () => string | null;
  ready: () => Promise<WhatsAppReady>;
  /** The run; `day`: the Life-zone day whose morning it is. */
  run: (stale: boolean, day: string) => Promise<unknown>;
}

/** The morning a timer waits for: its day and when it is due (epoch ms). */
export interface NextMorning {
  day: string;
  dueAt: number;
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
  /** Moved on by stop() and rearm(): a ready() answer from before them is dropped. */
  private epoch = 0;
  private next: NextMorning | null = null;
  /** The day this timer last started a run for. */
  private fired: string | null = null;
  /** A run is going; its end arms again. */
  private inRun = false;

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

  /** The time or the zone changed. */
  rearm(): void {
    if (!this.running) return;
    this.epoch += 1;
    if (!this.inRun) this.arm();
  }

  private clear(): void {
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    this.clear();
    this.next = null;
    const at = this.opts.at();
    if (at === null) return;
    const last = this.opts.lastDay();
    this.next = nextMorning(this.clock.now(), at, this.opts.tz(), (day) => day === last || day === this.fired);
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
    if (ready || now >= until) return this.go(next.day, !ready);
    this.timer = this.clock.setTimeout(() => void this.poll(next, epoch), Math.min(READY_POLL_MS, until - now));
  }

  private go(day: string, stale: boolean): void {
    this.clear();
    this.next = null;
    this.fired = day;
    this.inRun = true;
    void this.opts
      .run(stale, day)
      .catch((e: unknown) => this.log.error('messages: the morning run failed', { event: 'messages.morning', error: e instanceof Error ? e.name : 'unknown' }))
      .finally(() => {
        this.inRun = false;
        if (this.running) this.arm();
      });
  }
}
