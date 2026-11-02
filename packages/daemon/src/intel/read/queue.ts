/**
 * The read queue (spec 2.4): in daemon memory only, one job at a time
 * daemon-wide, oldest first. On disk an unfinished item is `queued`; the
 * running states (fetching … summarising) live here only.
 *
 * - At most queueMax unfinished jobs; reads started per day perDay, of which
 *   Full fullPerDay (a day is the Mac's local date). Over a cap the item is
 *   saved failed with the plain reason by the caller.
 * - Each state change calls `changed` (the service's text-free
 *   `life.changed {}`, throttled to every 2 s).
 * - A job has a hard stop (jobMs, 8 minutes): it is aborted and ends failed
 *   "The read took too long."
 * - `stopAll` (reading off, Intel off, the daemon stopping) aborts the
 *   running job and writes every waiting one failed with the stopped
 *   sentence; nothing resumes after a restart (the store's start pass).
 * - `cancel` (Delete) drops a waiting job or aborts the running one; it then
 *   writes nothing (the item is gone).
 * - Finished jobs stay listed for a day, at most finishedMax.
 */
import { INTEL_READ_LIMITS, INTEL_READ_REASONS, type IntelDepth, type IntelJob, type IntelReadState, type IntelTier } from '@jantar/protocol';
import type { Clock, Logger, TimerId } from '../../contracts.js';
import type { CaptureLine } from './store.js';
import type { LinkKind } from './url.js';

/** What a job reads: the item and how. */
export interface JobSpec {
  rid: string;
  /** The canonical link (null: a note). */
  link: string | null;
  kind: LinkKind;
  depth: IntelDepth;
  /** The item's title while it is read (the pending title, or the item's). */
  title: string;
  note: string | null;
  /** The item's line as it is now: what is kept when the read fails. */
  base: CaptureLine;
  /** The user's own tags (a plain capture's), kept before Claude's. */
  userTags: string[];
  /** Read again of a saved item, or of a plain capture the user titled: a failed read keeps its title. */
  keepTitle?: boolean;
}

export type AbortWhy = 'stopped' | 'tooLong' | 'deleted';

export interface Job extends JobSpec {
  id: string;
  state: IntelReadState;
  tier?: IntelTier;
  reason?: string;
  notes: string[];
  queuedAt: string;
  startedAt?: string;
  endedAt?: string;
  endedMs?: number;
  abort: AbortController;
  /** Why it was aborted, once it was. */
  why?: AbortWhy;
}

export interface QueueDeps {
  clock: Clock;
  log: Logger;
  /** Run one job to its end; answers the item's last line (saved or failed), or null to write nothing. */
  run(job: Job, update: (state: IntelReadState, tier?: IntelTier) => void): Promise<CaptureLine | null>;
  /** Write a job's last line (the store). */
  write(line: CaptureLine): Promise<void>;
  /** The failed line of a job that never ran or was stopped. */
  failedLine(job: Job, reason: string): CaptureLine;
  changed(): void;
}

export type Refusal = 'queueFull' | 'daily';

/** "2026-11-02" in the Mac's own zone. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class ReadQueue {
  private readonly waiting: Job[] = [];
  private running: Job | null = null;
  private runningDone: Promise<void> | null = null;
  private readonly finished: Job[] = [];
  private day = '';
  private reads = 0;
  private fulls = 0;
  /** No new job starts (stopping). */
  private paused = false;

  constructor(private readonly d: QueueDeps) {}

  /** Reads started today: every depth, and Full. */
  today(): { reads: number; full: number } {
    this.roll();
    return { reads: this.reads, full: this.fulls };
  }

  counts(): { waiting: number; running: number } {
    return { waiting: this.waiting.length, running: this.running ? 1 : 0 };
  }

  /** Whether a read at `depth` may be queued now. */
  refusal(depth: IntelDepth): Refusal | null {
    this.roll();
    if (this.waiting.length + (this.running ? 1 : 0) >= INTEL_READ_LIMITS.queueMax) return 'queueFull';
    if (this.reads >= INTEL_READ_LIMITS.perDay) return 'daily';
    if (depth === 'full' && this.fulls >= INTEL_READ_LIMITS.fullPerDay) return 'daily';
    return null;
  }

  /** Whether `rid` has a job queued or running. */
  busy(rid: string): boolean {
    return this.running?.rid === rid || this.waiting.some((j) => j.rid === rid);
  }

  /** Queue a job (the caller checked `refusal` and `busy`) and kick the queue. */
  push(spec: JobSpec): Job {
    this.roll();
    this.reads += 1;
    if (spec.depth === 'full') this.fulls += 1;
    const job: Job = { ...spec, id: `captures:${spec.rid}`, state: 'queued', notes: [], queuedAt: this.d.clock.iso(), abort: new AbortController() };
    this.waiting.push(job);
    this.d.changed();
    this.kick();
    return job;
  }

  /** Delete: drop a waiting job, or abort the running one; nothing is written for it. */
  cancel(rid: string): void {
    const at = this.waiting.findIndex((j) => j.rid === rid);
    if (at >= 0) this.waiting.splice(at, 1);
    if (this.running?.rid === rid) this.abort(this.running, 'deleted');
    this.d.changed();
  }

  /** Abort the running job and fail every waiting one ("Stopped before it finished."); waits for the running one to end (≤ 5 s). */
  async stopAll(): Promise<void> {
    this.paused = true;
    const waiting = this.waiting.splice(0);
    const running = this.running;
    if (running) this.abort(running, 'stopped');
    for (const j of waiting) {
      this.end(j, 'failed', INTEL_READ_REASONS.stopped);
      await this.d.write(this.d.failedLine(j, INTEL_READ_REASONS.stopped)).catch((e: unknown) => this.logError(e));
    }
    if (this.runningDone) {
      let timer: TimerId | undefined;
      await Promise.race([this.runningDone, new Promise<void>((r) => (timer = this.d.clock.setTimeout(r, 5_000)))]);
      this.d.clock.clearTimeout(timer);
    }
    this.paused = false;
    if (waiting.length || running) this.d.changed();
  }

  /** Unfinished jobs oldest first, then the finished ones of the last day (newest first). */
  list(): IntelJob[] {
    const now = this.d.clock.now();
    while (this.finished.length && now - (this.finished[0]?.endedMs ?? now) > INTEL_READ_LIMITS.finishedKeepMs) this.finished.shift();
    const open = [...(this.running ? [this.running] : []), ...this.waiting];
    return [...open, ...[...this.finished].reverse()].slice(0, INTEL_READ_LIMITS.jobsMax).map(view);
  }

  // -------------------------------------------------------------------------

  private roll(): void {
    const day = localDay(this.d.clock.now());
    if (day === this.day) return;
    this.day = day;
    this.reads = 0;
    this.fulls = 0;
  }

  private abort(job: Job, why: AbortWhy): void {
    if (job.why) return;
    job.why = why;
    job.abort.abort();
  }

  private end(job: Job, state: 'saved' | 'failed', reason?: string): void {
    job.state = state;
    if (reason !== undefined) job.reason = reason;
    job.endedAt = this.d.clock.iso();
    job.endedMs = this.d.clock.now();
    if (job.why === 'deleted') return;
    this.finished.push(job);
    while (this.finished.length > INTEL_READ_LIMITS.finishedMax) this.finished.shift();
  }

  private kick(): void {
    if (this.running || this.paused) return;
    const job = this.waiting.shift();
    if (!job) return;
    this.running = job;
    job.startedAt = this.d.clock.iso();
    const hardStop = this.d.clock.setTimeout(() => this.abort(job, 'tooLong'), INTEL_READ_LIMITS.jobMs);
    const update = (state: IntelReadState, tier?: IntelTier) => {
      if (job.why) return;
      job.state = state;
      if (tier !== undefined) job.tier = tier;
      this.d.changed();
    };
    // Never inside the caller's own turn: the request that queued it answers first.
    this.runningDone = Promise.resolve()
      .then(() => this.d.run(job, update))
      .then(async (line) => {
        if (job.why === 'deleted') return;
        if (job.why) {
          // Stopped or past its hard stop: what was gathered is in the failed line the run gave back.
          const reason = job.why === 'tooLong' ? INTEL_READ_REASONS.tooLong : INTEL_READ_REASONS.stopped;
          await this.d.write(line && (line.read as { state?: string } | undefined)?.state === 'failed' ? line : this.d.failedLine(job, reason));
          this.end(job, 'failed', reason);
          return;
        }
        if (!line) return;
        await this.d.write(line);
        // The Reading strip names the job as the item is now called (the title the read found).
        if (typeof line.title === 'string' && line.title) job.title = line.title.slice(0, 300);
        const read = line.read as { state?: string; reason?: string; notes?: string[] } | undefined;
        if (read?.notes) job.notes = read.notes;
        this.end(job, read?.state === 'saved' ? 'saved' : 'failed', read?.reason);
      })
      .catch(async (e: unknown) => {
        this.logError(e);
        if (job.why === 'deleted') return;
        const reason = job.why === 'tooLong' ? INTEL_READ_REASONS.tooLong : INTEL_READ_REASONS.stopped;
        await this.d.write(this.d.failedLine(job, reason)).catch((e2: unknown) => this.logError(e2));
        this.end(job, 'failed', reason);
      })
      .finally(() => {
        this.d.clock.clearTimeout(hardStop);
        this.running = null;
        this.runningDone = null;
        this.d.changed();
        this.kick();
      });
  }

  private logError(e: unknown): void {
    const code = (e as { code?: unknown } | null)?.code;
    this.d.log.error('intel read failed', { error: typeof code === 'string' ? code : e instanceof Error ? e.name : 'error' });
  }
}

function view(j: Job): IntelJob {
  return {
    id: j.id,
    title: j.title,
    ...(j.link ? { url: j.link } : {}),
    platform: j.kind.platform,
    depth: j.depth,
    state: j.state,
    ...(j.tier ? { tier: j.tier } : {}),
    ...(j.reason ? { reason: j.reason } : {}),
    ...(j.notes.length ? { notes: j.notes.slice(0, 3) } : {}),
    queuedAt: j.queuedAt,
    ...(j.startedAt ? { startedAt: j.startedAt } : {}),
    ...(j.endedAt ? { endedAt: j.endedAt } : {}),
  };
}
