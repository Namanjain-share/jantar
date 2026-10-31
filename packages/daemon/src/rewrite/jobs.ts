/**
 * Rewrite jobs, in daemon memory only (U6). A job's public shape
 * (RewriteJob: hashes, lengths, flags, never text) goes out as
 * `rewrite.progress` on every change; its texts (what the user said, the
 * written prompt, the new tokens) stay here, for the owner only:
 *
 * - dropped at once when the job is sent or cancelled;
 * - otherwise dropped REWRITE_TTL_MS after the run ended (ready or failed),
 *   together with the job itself (a later GET or send is a 404).
 *
 * Nothing here persists: a daemon restart forgets every job.
 */
import { REWRITE_FINAL_STATES, REWRITE_TTL_MS, type RewriteJob, type RewriteModel, type RewriteState, type Session } from '@jantar/protocol';
import type { DaemonContext, TimerId } from '../contracts.js';
import { sha256Hex } from '../core/hash.js';
import { newSecretId } from '../core/ids.js';

export interface JobRecord {
  job: RewriteJob;
  /** actorId() of the actor that started it: the only one who may read, cancel or send it. */
  owner: string;
  /** What the user said (trimmed); null once dropped. */
  input: string | null;
  /** The written prompt; null until ready and once dropped. */
  prompt: string | null;
  /** The tokens counted in prompt.flags.newTokens. */
  newTokens: string[];
  /** The session as it was at submit (the context falls back to it if the session ended). */
  session: Session;
  /** Aborts the run while it is going. */
  abort: AbortController | null;
  /** A send with this job is on its way to the writer (originFor until markSent or releaseOrigin). */
  claimed: boolean;
  expiry: TimerId | undefined;
}

export interface NewJob {
  sid: string;
  owner: string;
  deviceId: string | null;
  model: RewriteModel;
  input: string;
  session: Session;
}

export function isFinal(state: RewriteState): boolean {
  return REWRITE_FINAL_STATES.includes(state);
}

export class RewriteJobs {
  private readonly records = new Map<string, JobRecord>();

  constructor(
    private readonly ctx: Pick<DaemonContext, 'clock' | 'store' | 'log'>,
    private readonly opts: { ttlMs?: number; maxJobs?: number } = {},
  ) {}

  private get ttlMs(): number {
    return this.opts.ttlMs ?? REWRITE_TTL_MS;
  }

  create(n: NewJob): JobRecord {
    const at = this.ctx.clock.iso();
    const rec: JobRecord = {
      job: {
        id: newSecretId(),
        sid: n.sid,
        deviceId: n.deviceId,
        state: 'queued',
        model: n.model,
        input: { hash: sha256Hex(n.input), length: n.input.length },
        createdAt: at,
        updatedAt: at,
      },
      owner: n.owner,
      input: n.input,
      prompt: null,
      newTokens: [],
      session: n.session,
      abort: null,
      claimed: false,
      expiry: undefined,
    };
    this.records.set(rec.job.id, rec);
    this.trim();
    this.emit(rec);
    return rec;
  }

  get(id: string): JobRecord | undefined {
    return this.records.get(id);
  }

  /** The owner's jobs that have not ended (queued or writing). */
  activeFor(owner: string): number {
    return this.unfinished().filter((r) => r.owner === owner).length;
  }

  /** Every job that has not ended (queued or writing). */
  unfinished(): JobRecord[] {
    return [...this.records.values()].filter((r) => r.job.state === 'queued' || r.job.state === 'writing');
  }

  /** Apply a change, stamp updatedAt and emit. Each change is a new object, so emitted jobs never change under a listener. */
  update(rec: JobRecord, patch: Partial<RewriteJob>): RewriteJob {
    rec.job = { ...rec.job, ...patch, updatedAt: this.ctx.clock.iso() };
    this.emit(rec);
    return rec.job;
  }

  /** The run ended (ready or failed): the texts and the job go REWRITE_TTL_MS from now. */
  ended(rec: JobRecord, patch: Partial<RewriteJob>): RewriteJob {
    const job = this.update(rec, { ...patch, expiresAt: this.ctx.clock.iso(this.ctx.clock.now() + this.ttlMs) });
    this.scheduleDrop(rec);
    return job;
  }

  /** Sent or cancelled: the texts go now, the text-free job at its expiry. */
  closed(rec: JobRecord, patch: Partial<RewriteJob>): RewriteJob {
    this.dropTexts(rec);
    const job = this.update(rec, { ...patch, expiresAt: rec.job.expiresAt ?? this.ctx.clock.iso(this.ctx.clock.now() + this.ttlMs) });
    if (rec.expiry === undefined) this.scheduleDrop(rec);
    return job;
  }

  dropTexts(rec: JobRecord): void {
    rec.input = null;
    rec.prompt = null;
    rec.newTokens = [];
  }

  /** Forget every job (daemon stop). */
  clear(): void {
    for (const r of this.records.values()) {
      this.ctx.clock.clearTimeout(r.expiry);
      this.dropTexts(r);
    }
    this.records.clear();
  }

  private scheduleDrop(rec: JobRecord): void {
    this.ctx.clock.clearTimeout(rec.expiry);
    const at = rec.job.expiresAt ? Date.parse(rec.job.expiresAt) : this.ctx.clock.now() + this.ttlMs;
    rec.expiry = this.ctx.clock.setTimeout(() => this.remove(rec.job.id), Math.max(0, at - this.ctx.clock.now()));
  }

  private remove(id: string): void {
    const rec = this.records.get(id);
    if (!rec) return;
    this.ctx.clock.clearTimeout(rec.expiry);
    this.dropTexts(rec);
    this.records.delete(id);
  }

  /** Over maxJobs: forget the oldest jobs that have ended. */
  private trim(): void {
    const max = this.opts.maxJobs ?? 500;
    if (this.records.size <= max) return;
    for (const r of this.records.values()) {
      if (this.records.size <= max) break;
      if (r.job.state !== 'queued' && r.job.state !== 'writing') this.remove(r.job.id);
    }
  }

  private emit(rec: JobRecord): void {
    try {
      this.ctx.store.emit({ type: 'rewrite.progress', sid: rec.job.sid, data: { job: rec.job } });
    } catch (e) {
      this.ctx.log.error('could not publish a rewrite job', { jobId: rec.job.id, error: String(e) });
    }
  }
}
