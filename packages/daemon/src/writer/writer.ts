/**
 * The writer: every prompt typed into a terminal goes through here.
 *
 * - One queue per pane (keyed by tty), held for a job's whole precheck ->
 *   type -> Enter -> proof sequence, so two prompts never interleave and no
 *   Enter can submit another job's half-typed text.
 * - `submit` answers at once: quick checks that need only state (session
 *   known, not waiting, no open card, no ccw move, a terminal tab found) give
 *   an immediate refusal; otherwise the job is queued and its progress
 *   arrives as `send.progress` events. Everything is checked again under the
 *   pane's lock before anything is typed.
 * - Idempotency-Key: a retried request gets the same job back instead of a
 *   second send. Keys survive a daemon restart (kept in the Db's kv store).
 * - Every stage emits `send.progress`. A failure is emitted the moment the
 *   writer gives up (and sent to any notifiers it was given) before any
 *   cleanup runs. The final outcome, proof included, goes to the audit log.
 * - Prompt text never leaves this module: jobs, events, logs and the audit
 *   log carry only its sha256 and length.
 */
import { SEND_FINAL_STAGES, type Pane, type SendJob, type SendStage } from '@jantar/protocol';
import type { Actor, DaemonContext, Notifier, SubmitRequest, SubmitResult, TimerId, Writer } from '../contracts.js';
import { actorId } from '../core/actor.js';
import { sha256Hex } from '../core/hash.js';
import { newSecretId } from '../core/ids.js';
import { sendFailedNotification } from './notification.js';
import { ccwCheck, lookupSession, stateBlocker } from './preconditions.js';
import { KeyedQueue } from './queue.js';
import { DEFAULT_TIMINGS, performSend, type PaneMemory, type SendOutcome, type SendTimings, type WriterDeps } from './send.js';
import { validatePromptText } from './text.js';

export interface WriterOptions extends Partial<SendTimings> {
  /**
   * Notifiers to alert directly when a send fails. Leave empty when the
   * notification router already pushes `send.progress` failures (the
   * default wiring), or the user gets two alerts.
   */
  notifiers?: readonly Notifier[];
  /** Jobs kept in memory for get()/wait(). Default 500. */
  maxJobs?: number;
  /** Idempotency keys are remembered this long. Default 24 h. */
  idempotencyTtlMs?: number;
  /** At most this many idempotency keys are remembered. Default 500. */
  maxIdempotencyKeys?: number;
}

interface JobRecord {
  job: SendJob;
  /** The prompt, held only until the job ends. */
  text: string;
  onDraft: 'refuse' | 'replace';
  actor: Actor;
  /** Accepted jobs are broadcast; a job refused inside submit() is only returned to the caller. */
  accepted: boolean;
  waiters: Set<(job: SendJob) => void>;
}

interface IdemEntry {
  jobId: string;
  sid: string;
  textHash: string;
  at: number;
  job: SendJob;
}

export const IDEMPOTENCY_KV_KEY = 'writer.idempotency.v1';

const FINAL: ReadonlySet<SendStage> = new Set(SEND_FINAL_STAGES);

export function isFinalStage(stage: SendStage): boolean {
  return FINAL.has(stage);
}

function clip(s: string, n = 300): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export class SendWriter implements Writer {
  private readonly timings: SendTimings;
  private readonly notifiers: readonly Notifier[];
  private readonly maxJobs: number;
  private readonly idemTtl: number;
  private readonly maxIdem: number;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly queue = new KeyedQueue();
  private readonly memory = new Map<string, PaneMemory>();
  private readonly running = new Map<string, { ac: AbortController; done: Promise<void> }>();
  private idem: Map<string, IdemEntry> | null = null;
  private stopped = false;

  constructor(
    private readonly ctx: DaemonContext,
    private readonly deps: WriterDeps,
    opts: WriterOptions = {},
  ) {
    const { notifiers, maxJobs, idempotencyTtlMs, maxIdempotencyKeys, ...timings } = opts;
    this.timings = { ...DEFAULT_TIMINGS, ...stripUndefined(timings) };
    this.notifiers = notifiers ?? [];
    this.maxJobs = maxJobs ?? 500;
    this.idemTtl = idempotencyTtlMs ?? 24 * 3600_000;
    this.maxIdem = maxIdempotencyKeys ?? 500;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.loadIdem();
  }

  /** Abort every running job (each ends as failed or refused, and says so) and accept no more. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const r of this.running.values()) r.ac.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.done));
  }

  get(jobId: string): SendJob | undefined {
    return this.jobs.get(jobId)?.job;
  }

  /** The pane's send queue, for work that must not interleave with a send (key presses, mode steps, screenshots). */
  withPaneLock<T>(pane: Pane, task: () => Promise<T>): Promise<T> {
    return this.queue.run(`tty:${pane.tty}`, task);
  }

  wait(jobId: string, timeoutMs?: number): Promise<SendJob | undefined> {
    const rec = this.jobs.get(jobId);
    if (!rec) return Promise.resolve(undefined);
    if (isFinalStage(rec.job.stage)) return Promise.resolve(rec.job);
    return new Promise((resolve) => {
      let timer: TimerId | undefined;
      const done = (job: SendJob) => {
        this.ctx.clock.clearTimeout(timer);
        rec.waiters.delete(done);
        resolve(job);
      };
      rec.waiters.add(done);
      if (timeoutMs !== undefined) timer = this.ctx.clock.setTimeout(() => done(rec.job), Math.max(0, timeoutMs));
    });
  }

  async submit(req: SubmitRequest): Promise<SubmitResult> {
    const v = validatePromptText(req.text);
    const text = v.ok ? v.text : req.text.replace(/\r\n?/g, '\n');
    const textHash = sha256Hex(text);

    if (req.idempotencyKey) {
      const prior = this.lookupIdem(req.idempotencyKey);
      if (prior) {
        if (prior.sid !== req.sid || prior.textHash !== textHash) {
          return { ok: false, code: 'refused', reason: 'that Idempotency-Key was already used for a different prompt' };
        }
        const job = this.jobs.get(prior.jobId)?.job ?? prior.job;
        if (job.stage === 'refused' && !this.jobs.get(prior.jobId)?.accepted) {
          return { ok: false, code: 'refused', reason: job.reason ?? 'refused', job };
        }
        return { ok: true, job, duplicate: true };
      }
    }

    const now = this.ctx.clock.iso();
    const job: SendJob = {
      id: newSecretId(),
      sid: req.sid,
      textHash,
      textLength: text.length,
      stage: 'queued',
      attempts: 0,
      actor: actorId(req.actor),
      createdAt: now,
      updatedAt: now,
    };
    if (req.idempotencyKey) job.idempotencyKey = req.idempotencyKey;
    if (req.origin) job.origin = req.origin;
    const rec: JobRecord = { job, text, onDraft: req.onDraft, actor: req.actor, accepted: false, waiters: new Set() };
    this.jobs.set(job.id, rec);
    this.pruneJobs();
    if (req.idempotencyKey) this.rememberIdem(req.idempotencyKey, rec);

    const refuseNow = (reason: string, code: 'refused' | 'not_found' = 'refused'): SubmitResult => {
      this.finish(rec, { stage: 'refused', reason });
      return { ok: false, code, reason: rec.job.reason ?? reason, job: rec.job };
    };

    if (this.stopped) return refuseNow('the daemon is stopping');
    if (!v.ok) return refuseNow(v.reason);
    const session = lookupSession(this.ctx, req.sid);
    if (!session) return refuseNow('no such session is running', 'not_found');
    const blocker = stateBlocker(this.ctx, this.deps.hooks, session);
    if (blocker) return refuseNow(blocker);
    const ccw = await ccwCheck(this.deps.ccwLegacy, req.sid);
    if (ccw.blocker) return refuseNow(ccw.blocker);
    const pane = await this.deps.terminal.findPane({
      ...(session.tty ? { tty: session.tty } : {}),
      pid: session.pid,
      sid: session.sid,
    });
    if (!pane) {
      const why = (this.deps.terminal as { lastError?: { reason?: string } | null }).lastError?.reason;
      return refuseNow(why ? `no terminal tab found for this session (${why})` : 'no terminal tab found for this session');
    }
    if (this.stopped) return refuseNow('the daemon is stopping');

    rec.accepted = true;
    this.update(rec, { paneId: pane.id });
    const ac = new AbortController();
    const done = this.queue
      .run(`tty:${pane.tty}`, () => this.runJob(rec, ac.signal))
      .catch((e: unknown) => {
        this.ctx.log.error('send job crashed', { jobId: job.id, sid: job.sid, error: e instanceof Error ? e.name : 'unknown' });
      })
      .finally(() => this.running.delete(job.id));
    this.running.set(job.id, { ac, done });
    return { ok: true, job: rec.job, duplicate: false };
  }

  // -------------------------------------------------------------------------

  private async runJob(rec: JobRecord, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      this.finish(rec, { stage: 'refused', reason: 'the daemon is stopping' });
      return;
    }
    let outcome: SendOutcome;
    try {
      outcome = await performSend(this.ctx, this.deps, this.timings, {
        job: () => rec.job,
        text: rec.text,
        onDraft: rec.onDraft,
        progress: (patch) => this.update(rec, patch),
        signal,
        memory: this.memory,
      });
    } catch (e) {
      this.ctx.log.error('send failed with an internal error', {
        jobId: rec.job.id,
        sid: rec.job.sid,
        error: e instanceof Error ? e.name : 'unknown',
      });
      const typed = rec.job.stage === 'typed' || rec.job.stage === 'enter';
      outcome = typed
        ? { stage: 'failed', reason: 'an internal error stopped the send; the prompt was not proven sent' }
        : { stage: 'refused', reason: 'an internal error stopped the send before anything was typed' };
    }
    this.finish(rec, outcome);
    if (outcome.stage === 'failed' && outcome.cleanup && !this.stopped) await outcome.cleanup();
  }

  /** Apply a change to a job and, for accepted jobs, broadcast it. */
  private update(rec: JobRecord, patch: Partial<SendJob>): void {
    if (isFinalStage(rec.job.stage)) return;
    const next: SendJob = { ...rec.job, updatedAt: this.ctx.clock.iso() };
    for (const [k, v] of Object.entries(patch) as [keyof SendJob, unknown][]) {
      if (v === undefined) delete (next as Partial<SendJob>)[k];
      else (next as Record<string, unknown>)[k] = v;
    }
    rec.job = next;
    if (rec.accepted) this.emit(next);
  }

  private emit(job: SendJob): void {
    const session = lookupSession(this.ctx, job.sid);
    const account = session?.account;
    this.ctx.store.emit({
      type: 'send.progress',
      sid: job.sid,
      ...(typeof account === 'number' ? { account } : {}),
      data: { job },
    });
  }

  /** Final stage: emit it (the alert goes out here, before any cleanup), notify, audit, drop the text. */
  private finish(rec: JobRecord, outcome: SendOutcome): void {
    if (isFinalStage(rec.job.stage)) return;
    const patch: Partial<SendJob> = { stage: outcome.stage };
    if ('proof' in outcome) {
      patch.proof = outcome.proof;
      if (outcome.notes.length) patch.reason = clip(outcome.notes.join('; '));
    } else {
      patch.reason = clip(outcome.reason);
    }
    this.update(rec, patch);
    rec.text = '';
    const job = rec.job;

    const alert = job.stage === 'failed' || (job.stage === 'refused' && rec.accepted);
    if (alert) this.notify(job);

    this.ctx.log[job.stage === 'failed' ? 'warn' : 'info']('send finished', {
      jobId: job.id,
      sid: job.sid,
      stage: job.stage,
      attempts: job.attempts,
      ...(job.reason ? { reason: job.reason } : {}),
    });
    this.audit(rec);
    if (job.idempotencyKey) this.rememberIdem(job.idempotencyKey, rec);
    for (const w of [...rec.waiters]) w(job);
  }

  private notify(job: SendJob): void {
    if (this.notifiers.length === 0) return;
    const n = sendFailedNotification(job, lookupSession(this.ctx, job.sid), this.ctx.clock.iso());
    for (const notifier of this.notifiers) {
      void notifier.send(n).catch((e: unknown) => {
        this.ctx.log.warn('send-failed alert could not be delivered', {
          channel: notifier.channel,
          error: e instanceof Error ? e.name : 'unknown',
        });
      });
    }
  }

  private audit(rec: JobRecord): void {
    const job = rec.job;
    const result = job.stage === 'refused' ? 'refused' : job.stage === 'failed' ? 'failed' : 'ok';
    const params: Record<string, unknown> = {
      jobId: job.id,
      textHash: job.textHash,
      textLength: job.textLength,
      stage: job.stage,
      attempts: job.attempts,
    };
    if (job.paneId) params.paneId = job.paneId;
    if (job.proof) params.proof = job.proof;
    if (job.idempotencyKey) params.idempotent = true;
    try {
      this.ctx.db.audit.append({
        ts: this.ctx.clock.iso(),
        actor: actorId(rec.actor),
        action: 'session.prompt',
        target: job.sid,
        params,
        result,
        ...(job.reason ? { detail: job.reason } : {}),
      });
    } catch (e) {
      this.ctx.log.error('audit append failed', { jobId: job.id, error: e instanceof Error ? e.name : 'unknown' });
    }
  }

  private pruneJobs(): void {
    if (this.jobs.size <= this.maxJobs) return;
    for (const [id, r] of this.jobs) {
      if (this.jobs.size <= this.maxJobs) break;
      if (isFinalStage(r.job.stage) && r.waiters.size === 0) this.jobs.delete(id);
    }
  }

  // --- idempotency -----------------------------------------------------------

  private loadIdem(): Map<string, IdemEntry> {
    if (this.idem) return this.idem;
    const map = new Map<string, IdemEntry>();
    try {
      const stored = this.ctx.db.kv.get<Record<string, IdemEntry>>(IDEMPOTENCY_KV_KEY);
      if (stored && typeof stored === 'object') {
        for (const [k, e] of Object.entries(stored)) {
          if (e && typeof e.jobId === 'string' && typeof e.at === 'number' && e.job) {
            // A job that was still running when the daemon stopped did not end well.
            const job = isFinalStage(e.job.stage)
              ? e.job
              : { ...e.job, stage: 'failed' as const, reason: 'the daemon restarted before the prompt was proven sent' };
            map.set(k, { ...e, job });
          }
        }
      }
    } catch (err) {
      this.ctx.log.warn('idempotency keys could not be loaded', { error: err instanceof Error ? err.name : 'unknown' });
    }
    this.idem = map;
    return map;
  }

  private lookupIdem(key: string): IdemEntry | undefined {
    const map = this.loadIdem();
    const e = map.get(key);
    if (!e) return undefined;
    if (this.ctx.clock.now() - e.at > this.idemTtl) {
      map.delete(key);
      return undefined;
    }
    return e;
  }

  private rememberIdem(key: string, rec: JobRecord): void {
    const map = this.loadIdem();
    const prev = map.get(key);
    map.set(key, {
      jobId: rec.job.id,
      sid: rec.job.sid,
      textHash: rec.job.textHash,
      at: prev?.at ?? this.ctx.clock.now(),
      job: rec.job,
    });
    const now = this.ctx.clock.now();
    for (const [k, e] of map) if (now - e.at > this.idemTtl) map.delete(k);
    while (map.size > this.maxIdem) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
    try {
      this.ctx.db.kv.set(IDEMPOTENCY_KV_KEY, Object.fromEntries(map));
    } catch (err) {
      this.ctx.log.warn('idempotency keys could not be saved', { error: err instanceof Error ? err.name : 'unknown' });
    }
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
