/**
 * The Rewrite service (U5, U6): typed or dictated text turned into a proper
 * prompt by one throwaway headless Claude run, reviewed on the phone, then
 * sent through the writer with `rewriteJobId`.
 *
 * - `submit` answers at once with the queued job; at most two runs go at a
 *   time and each device has at most four jobs unfinished.
 * - A run: pick the account (account.ts), adopt it once (adopt.ts), build the
 *   context (context.ts), run `cswap run ... -- -p` (run.ts), check the
 *   output (guards.ts). With one Claude login (accounts mode "single") the
 *   run is `claude -p` on account 0, with no adopt and no account to retry. One retry on another account after a startup or
 *   login failure (that account then sits out 10 min); never a retry after
 *   the model itself failed or the run timed out.
 * - Flag drift: when claude refuses an option the run can do without
 *   (run.ts DROPPABLE_OPTIONS), that option is left out of this run's retry
 *   and of every later run until the daemon restarts, with one alert per
 *   option (run.ts runDroppingRefused, shared with Ask Claude). A refused isolation option (or one that can't be read) ends the
 *   job flags_rejected: nothing less isolated ever runs.
 * - Turning Rewrite off at the Mac cancels every queued and writing job.
 * - The states: queued -> writing -> ready | failed | cancelled; ready ->
 *   sent (the prompt, an edit of it or what the user said, sent with
 *   `rewriteJobId`). Every change goes out as `rewrite.progress` without
 *   text; the texts stay in jobs.ts. A send claims its ready job
 *   (originFor) until the writer takes it (markSent) or not
 *   (releaseOrigin): a second send meanwhile types nothing.
 * - A failure's `reason` is one of the fixed sentences below, never model
 *   output. A written prompt longer than a prompt may be (16,000 chars)
 *   fails too, so Send never meets a 400.
 * - Each run writes a `rewrite_runs` row and each job one `rewrite.run`
 *   audit row ({sid, jobId, account, model, ms, outcome}; ms is the whole
 *   writing time), never text. RewriteJob.ms is the last run's own time,
 *   spawn to result.
 */
import {
  REWRITE_TEXT_MAX,
  type Account,
  type AccountId,
  type Alert,
  type RewriteDetail,
  type RewriteFailure,
  type RewriteJob,
  type RewriteModel,
  type SendOrigin,
} from '@jantar/protocol';
import type { Actor, DaemonContext, Factories, Logger, RewriteService, RewriteSubmitResult } from '../contracts.js';
import { actorId } from '../core/actor.js';
import { keptAccounts } from '../core/kept-accounts.js';
import { sha256Hex } from '../core/hash.js';
import { newId } from '../core/ids.js';
import { MAX_PROMPT_CHARS } from '../writer/text.js';
import { AccountChooser, PENALTY_MS, pickRunAccount } from './account.js';
import { Adopter } from './adopt.js';
import { ContextBuilder, type BuiltContext } from './context.js';
import { checkPrompt, normaliseOutput } from './guards.js';
import { RewriteJobs, isFinal, type JobRecord } from './jobs.js';
import { DROPPABLE_OPTIONS, PROMPT_VERSION, execRewrite, prepareRunDir, refusedBy, runDroppingRefused, type RunDir, type RunOutcome, type RunVia } from './run.js';

export type RewriteDeps = Parameters<Factories['rewrite']>[1];

/** What the sheet shows on failed: fixed daemon text, never model output or user text. */
export const FAILURE_REASON: Readonly<Record<RewriteFailure, string>> = {
  no_account: 'No account has room for the prompt writer. Send what you said, or edit it.',
  unavailable: "The prompt writer can't run on the Mac right now (cswap or claude is missing). Send what you said, or edit it.",
  failed: "The prompt writer couldn't run. Send what you said, or try again.",
  timeout: 'The prompt writer timed out. Send what you said, or try again.',
  flags_rejected: "This Claude Code version refused the prompt writer's options. Send what you said; Jantar needs an update on the Mac.",
  empty: "Didn't catch anything to send.",
};
/** A written prompt longer than POST /prompt takes. */
export const TOO_LONG_REASON = 'The written prompt came out longer than a prompt can be. Send what you said, or try again.';

export const REWRITE_OFF_REASON = 'Rewrite is off. Turn it on at your Mac: jantar rewrite on';

export interface RewriteOptions {
  /** Runs at once across the daemon (default 2). */
  maxRunning?: number;
  /** Unfinished jobs per actor (default 4). */
  maxActivePerActor?: number;
  /** Jobs kept in memory (default 500). */
  maxJobs?: number;
  /** How long an account sits out after a startup or login failure (default 10 min). */
  penaltyMs?: number;
  /** How long texts and jobs are kept after a run ends (default REWRITE_TTL_MS). */
  ttlMs?: number;
}

/** The time of the last run a job made (RewriteJob.ms). */
interface LastRun {
  ms: number | undefined;
}

type Written =
  | { ok: true; text: string; preface: boolean; known: string[] }
  | { ok: false; failure: RewriteFailure; reason?: string }
  | { ok: false; failure: 'cancelled' };

/** What one run's outcome means for the job; "account" means try another account. */
function settle(o: RunOutcome, known: string[]): Written | 'account' {
  switch (o.kind) {
    case 'ok': {
      const n = normaliseOutput(o.result);
      if (!n.text) return { ok: false, failure: 'empty' };
      if (n.text.length > MAX_PROMPT_CHARS) return { ok: false, failure: 'failed', reason: TOO_LONG_REASON };
      return { ok: true, text: n.text, preface: n.preface, known };
    }
    case 'cancelled':
      return { ok: false, failure: 'cancelled' };
    case 'timeout':
      return { ok: false, failure: 'timeout' };
    case 'unavailable':
      return { ok: false, failure: 'unavailable' };
    case 'flags':
      return { ok: false, failure: 'flags_rejected' };
    case 'model':
      return { ok: false, failure: 'failed' };
    case 'account':
      return 'account';
  }
}

export class RewriteServiceImpl implements RewriteService {
  private readonly log: Logger;
  private readonly jobs: RewriteJobs;
  private readonly chooser: AccountChooser;
  private readonly adopter: Adopter;
  private readonly context: ContextBuilder;
  private readonly maxRunning: number;
  private readonly maxActive: number;
  private readonly queue: string[] = [];
  private readonly inflight = new Set<Promise<void>>();
  /** Jobs whose run is going (stop() aborts them). */
  private readonly runningJobs = new Set<JobRecord>();
  private running = 0;
  private stopped = false;
  private dir: Promise<RunDir> | null = null;
  /** Options claude refused that runs can do without: left out of every run until the daemon restarts. */
  private readonly dropped = new Set<string>();
  /** Refused options already alerted on ("" for one that couldn't be read). */
  private readonly alerted = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly ctx: DaemonContext,
    private readonly deps: RewriteDeps,
    opts: RewriteOptions = {},
  ) {
    this.log = ctx.log.child({ part: 'rewrite' });
    const jobOpts: { ttlMs?: number; maxJobs?: number } = {};
    if (opts.ttlMs !== undefined) jobOpts.ttlMs = opts.ttlMs;
    if (opts.maxJobs !== undefined) jobOpts.maxJobs = opts.maxJobs;
    this.jobs = new RewriteJobs({ clock: ctx.clock, store: ctx.store, log: this.log }, jobOpts);
    this.chooser = new AccountChooser(opts.penaltyMs ?? PENALTY_MS);
    this.adopter = new Adopter({ exec: ctx.exec, env: ctx.env, settings: ctx.settings, log: this.log, store: ctx.store, clock: ctx.clock });
    this.context = new ContextBuilder({ ...ctx, log: this.log }, deps);
    this.maxRunning = opts.maxRunning ?? 2;
    this.maxActive = opts.maxActivePerActor ?? 4;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.unsubscribe?.();
    // Rewrite off at the Mac: the routes answer 403, so nobody could read what a queued run writes.
    this.unsubscribe = this.ctx.settings.subscribe((next, prev) => {
      if (prev.rewrite.enabled && !next.rewrite.enabled) this.cancelUnfinished();
    });
  }

  /** Kill every run (and adopt) and forget every job and text. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.queue.length = 0;
    for (const rec of this.runningJobs) rec.abort?.abort();
    this.adopter.stop();
    await Promise.allSettled([...this.inflight]);
    this.jobs.clear();
  }

  async submit(req: { sid: string; text: string; model?: RewriteModel }, actor: Actor): Promise<RewriteSubmitResult> {
    if (this.stopped) return { ok: false, code: 'unavailable', reason: 'Rewrite is not running' };
    const settings = this.ctx.settings.get().rewrite;
    if (!settings.enabled) return { ok: false, code: 'refused', reason: REWRITE_OFF_REASON };
    const session = this.ctx.store.getState().sessions[req.sid];
    if (!session) return { ok: false, code: 'not_found', reason: 'no such session' };
    const text = req.text.trim();
    if (!text) return { ok: false, code: 'refused', reason: 'There is nothing to rewrite.' };
    if (text.length > REWRITE_TEXT_MAX) return { ok: false, code: 'refused', reason: 'That is too long to rewrite. Send it as it is, or split it.' };
    const owner = actorId(actor);
    if (this.jobs.activeFor(owner) >= this.maxActive) {
      // The route adds a retry-after.
      return { ok: false, code: 'rate_limited', reason: 'Wait for your other rewrites to finish.' };
    }
    const rec = this.jobs.create({
      sid: req.sid,
      owner,
      deviceId: actor.kind === 'device' ? actor.deviceId : null,
      model: req.model ?? settings.model,
      input: text,
      session,
    });
    const job = rec.job;
    this.queue.push(job.id);
    this.pump();
    return { ok: true, job };
  }

  get(jobId: string, actor: Actor): RewriteDetail | null {
    const rec = this.owned(jobId, actor);
    if (!rec) return null;
    const d: RewriteDetail = { state: rec.job.state, job: rec.job };
    if (rec.input !== null) d.input = rec.input;
    if (rec.prompt !== null) {
      d.prompt = rec.prompt;
      if (rec.newTokens.length > 0) d.newTokens = [...rec.newTokens];
    }
    if (rec.job.state === 'failed' && rec.job.reason) d.error = rec.job.reason;
    return d;
  }

  cancel(jobId: string, actor: Actor): RewriteJob | 'claimed' | null {
    const rec = this.owned(jobId, actor);
    if (!rec) return null;
    // A send holds the job: the prompt is on its way to the terminal, and the job ends "sent".
    if (rec.claimed && !isFinal(rec.job.state)) return 'claimed';
    // Failed is final: the texts go, the job stays as it is.
    if (isFinal(rec.job.state)) {
      this.jobs.dropTexts(rec);
      return rec.job;
    }
    rec.abort?.abort();
    return this.jobs.closed(rec, { state: 'cancelled' });
  }

  /**
   * Only a ready job of this actor and session (the phone sends plainly,
   * without the id, once a job failed or expired), and one send at a time:
   * the origin claims the job until markSent or releaseOrigin.
   */
  originFor(jobId: string, sid: string, textHash: string, actor: Actor): SendOrigin | 'claimed' | null {
    const rec = this.owned(jobId, actor);
    if (!rec || rec.job.sid !== sid || rec.job.state !== 'ready' || rec.input === null) return null;
    if (rec.claimed) return 'claimed';
    rec.claimed = true;
    if (textHash === rec.job.prompt?.hash) return 'rewrite';
    if (textHash === rec.job.input.hash) return 'rewrite-raw';
    return 'rewrite-edited';
  }

  markSent(jobId: string, sendJobId: string): void {
    const rec = this.jobs.get(jobId);
    // Final states never change (a failed job is sent plainly, without its id).
    if (!rec || isFinal(rec.job.state)) return;
    rec.claimed = false;
    rec.abort?.abort();
    this.jobs.closed(rec, { state: 'sent', sendJobId });
  }

  releaseOrigin(jobId: string): void {
    const rec = this.jobs.get(jobId);
    if (rec) rec.claimed = false;
  }

  // ------------------------------------------------------------------ runs

  private owned(jobId: string, actor: Actor): JobRecord | null {
    const rec = this.jobs.get(jobId);
    return rec && rec.owner === actorId(actor) ? rec : null;
  }

  /** Rewrite went off: every queued or writing job ends cancelled (texts dropped, runs killed). */
  private cancelUnfinished(): void {
    this.queue.length = 0;
    for (const rec of this.jobs.unfinished()) {
      rec.abort?.abort();
      this.jobs.closed(rec, { state: 'cancelled' });
    }
    this.log.info('rewrite: turned off; unfinished jobs cancelled');
  }

  private pump(): void {
    while (!this.stopped && this.running < this.maxRunning && this.queue.length > 0) {
      const rec = this.jobs.get(this.queue.shift() as string);
      if (!rec || rec.job.state !== 'queued') continue;
      this.running++;
      const p: Promise<void> = this.run(rec)
        .catch((e: unknown) => this.log.error('rewrite run crashed', { jobId: rec.job.id, error: String(e) }))
        .finally(() => {
          this.running--;
          this.inflight.delete(p);
          this.pump();
        });
      this.inflight.add(p);
    }
  }

  private async run(rec: JobRecord): Promise<void> {
    // Off since it was queued (the settings listener normally got there first).
    if (!this.ctx.settings.get().rewrite.enabled) {
      this.jobs.closed(rec, { state: 'cancelled' });
      return;
    }
    const abort = new AbortController();
    rec.abort = abort;
    this.runningJobs.add(rec);
    this.jobs.update(rec, { state: 'writing', promptVersion: PROMPT_VERSION });
    const started = this.ctx.clock.now();
    const last: LastRun = { ms: undefined };
    let w: Written;
    try {
      w = await this.write(rec, abort.signal, last);
    } catch (e) {
      this.log.error('rewrite run failed unexpectedly', { jobId: rec.job.id, error: String(e) });
      w = { ok: false, failure: 'failed' };
    } finally {
      rec.abort = null;
      this.runningJobs.delete(rec);
    }
    const ms = Math.max(0, this.ctx.clock.now() - started);
    // Cancelled or sent meanwhile (or the daemon is stopping): that state stands.
    if (rec.job.state !== 'writing' || this.stopped) {
      this.audit(rec, ms, rec.job.state === 'writing' ? 'stopped' : rec.job.state);
      return;
    }
    // RewriteJob.ms: the last run, spawn to result (none when no run started).
    const runMs = last.ms === undefined ? {} : { ms: last.ms };
    if (w.ok) {
      const g = checkPrompt({ input: rec.input ?? '', output: w.text, context: w.known });
      rec.prompt = w.text;
      rec.newTokens = g.newTokens;
      this.jobs.ended(rec, {
        state: 'ready',
        ...runMs,
        prompt: { hash: sha256Hex(w.text), length: w.text.length, flags: { ...g.flags, preface: w.preface } },
      });
      this.audit(rec, ms, 'ready');
      return;
    }
    const failure: RewriteFailure = w.failure === 'cancelled' ? 'failed' : w.failure;
    const reason = 'reason' in w && w.reason ? w.reason : FAILURE_REASON[failure];
    this.jobs.ended(rec, { state: 'failed', failure, reason, ...runMs });
    this.audit(rec, ms, failure);
  }

  /** The attempts of one job: the written text, or why there is none. `last.ms` gets each run's time. */
  private async write(rec: JobRecord, signal: AbortSignal, last: LastRun): Promise<Written> {
    const single = this.ctx.accountsMode() === 'single';
    const program = single ? this.ctx.bins.claude : this.ctx.bins.cswap;
    if (!program) return { ok: false, failure: 'unavailable' };
    const via: RunVia = single ? { claude: program } : { cswap: program };
    let dir: RunDir;
    try {
      dir = await this.runDir();
    } catch (e) {
      this.log.error('rewrite: could not prepare its folder', { error: String(e) });
      return { ok: false, failure: 'unavailable' };
    }
    const settings = this.ctx.settings.get().rewrite;
    const tried = new Set<AccountId>();
    let built: BuiltContext | null = null;
    let accountRetries = 1;
    for (;;) {
      const account = await this.pickAccount(tried);
      if (account === null) return { ok: false, failure: tried.size === 0 ? 'no_account' : 'failed' };
      tried.add(account);
      if (rec.job.account !== account) this.jobs.update(rec, { account });

      let w: Written | 'account';
      // One Claude login: nothing to adopt.
      const adopted = single || (await this.adopter.adopt(account, signal));
      // Cancelled while adopt ran: the account did nothing wrong.
      if (signal.aborted) return { ok: false, failure: 'cancelled' };
      if (!adopted) {
        w = 'account';
      } else {
        // Built once, and only once an account is there to run it.
        if (!built) {
          const session = this.ctx.store.getState().sessions[rec.job.sid] ?? rec.session;
          built = await this.context.build(rec.job.sid, session, rec.input ?? '');
        }
        if (signal.aborted) return { ok: false, failure: 'cancelled' };
        const message = built.message;
        const known = built.known;
        let previous: { outcome: RunOutcome; ms: number } | null = null;
        const once = async (dropped: ReadonlySet<string>) => {
          // Run again without a refused option: the refused run gets its own row.
          if (previous) this.recordRun(rec, account, previous, 'flags_rejected');
          const r = await execRewrite(this.ctx, {
            via,
            flags: { account: single ? null : account, model: rec.job.model, fallbackModel: settings.fallbackModel, effort: settings.effort, systemPromptFile: dir.systemPromptFile, dropped },
            input: message,
            cwd: dir.cwd,
            timeoutMs: settings.timeoutS * 1000,
            signal,
          });
          last.ms = r.ms;
          previous = r;
          return r;
        };
        // Each refused option this attempt still passed and runs can do without: drop it, run again.
        // Any other refusal stands (flags_rejected); at most one run more per droppable option.
        const r = await runDroppingRefused(once, this.dropped, (option) => this.flagsRefused(option), signal);
        w = settle(r.outcome, known);
        this.recordRun(rec, account, r, w === 'account' ? 'failed' : w.ok ? 'ready' : w.failure);
        // Nothing started: prepare the run dir again next time (it may have been removed).
        if (r.outcome.kind === 'unavailable') this.dir = null;
      }
      if (w !== 'account') return w;
      // One login has no other account to try, and sitting it out would only block the next rewrite.
      if (single) return { ok: false, failure: 'failed' };
      this.chooser.penalize(account, this.ctx.clock.now());
      this.log.warn('rewrite: account failed to start or log in; it sits out a while', { jobId: rec.job.id, account });
      if (accountRetries-- > 0 && !signal.aborted) continue;
      return { ok: false, failure: 'failed' };
    }
  }

  /** One `rewrite_runs` row per run: account, model, time, tokens and outcome ("ready" or a failure code), never text. */
  private recordRun(rec: JobRecord, account: AccountId, r: { outcome: RunOutcome; ms: number }, outcome: string): void {
    const o = r.outcome;
    const usage = o.kind === 'ok' || o.kind === 'model' ? o : { inputTokens: null, outputTokens: null };
    try {
      this.ctx.db.rewriteRuns.record({
        id: newId(),
        at: this.ctx.clock.iso(),
        account,
        model: rec.job.model,
        ok: outcome === 'ready',
        ms: r.ms,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        promptVersion: PROMPT_VERSION,
        outcome,
      });
    } catch (e) {
      this.log.error('rewrite: could not record a run', { jobId: rec.job.id, error: String(e) });
    }
    if (outcome !== 'ready') this.log.info('rewrite run ended without a prompt', { jobId: rec.job.id, account, outcome, run: o.kind, ms: r.ms });
  }

  private async pickAccount(skip: ReadonlySet<AccountId>): Promise<AccountId | null> {
    const s = this.ctx.settings.get();
    const nowMs = this.ctx.clock.now();
    const mode = this.ctx.accountsMode();
    if (mode === 'single') {
      return pickRunAccount({ accounts: [], hold: new Set(), ceilingPct: s.rewrite.ceilingPct, weeklyCeiling: s.autoswitch.weekly_ceiling, nowMs, penalized: skip, mode, kept: new Set() });
    }
    const hold = new Set<AccountId>([...s.autoswitch.hold, ...s.rewrite.excludeAccounts, ...(await this.ccwHold())]);
    return this.chooser.pick(
      { accounts: this.accounts(), hold, kept: keptAccounts(s), ceilingPct: s.rewrite.ceilingPct, weeklyCeiling: s.autoswitch.weekly_ceiling, nowMs, mode },
      s.rewrite.stickyMin * 60_000,
      skip,
    );
  }

  private accounts(): Account[] {
    return this.deps.usage.latest()?.accounts ?? Object.values(this.ctx.store.getState().accounts);
  }

  /** ccw's hold list while ccw is around. */
  private async ccwHold(): Promise<AccountId[]> {
    try {
      if (!this.deps.ccwLegacy.present()) return [];
      return (await this.deps.ccwLegacy.switchConfig())?.hold ?? [];
    } catch (e) {
      this.log.warn("rewrite: could not read ccw's hold list", { error: String(e) });
      return [];
    }
  }

  private runDir(): Promise<RunDir> {
    if (!this.dir) {
      this.dir = prepareRunDir(this.ctx.paths).then((d) => {
        if (d.workEntries > 0) this.log.warn('rewrite: its work folder is not empty', { entries: d.workEntries });
        return { cwd: d.cwd, systemPromptFile: d.systemPromptFile };
      });
      // Try again next time if it failed.
      this.dir.catch(() => {
        this.dir = null;
      });
    }
    return this.dir;
  }

  /**
   * cswap or claude refused an option: a droppable one is left out of every
   * later run; either way one alert per option for the daemon's life.
   */
  private flagsRefused(option: string | null): void {
    const droppable = option !== null && DROPPABLE_OPTIONS.includes(option);
    if (droppable) this.dropped.add(option);
    const key = option ?? '';
    if (this.alerted.has(key)) return;
    this.alerted.add(key);
    const program = refusedBy(option);
    this.log.warn('rewrite: an option of the prompt writer was refused', { option, program, dropped: droppable });
    const ts = this.ctx.clock.iso();
    const alert: Alert = {
      id: `al_rewrite_flags_${sha256Hex(`${ts} ${key}`).slice(0, 12)}`,
      ts,
      kind: 'error',
      label: 'Rewrite · prompt writer',
      what: option === null ? "cswap or claude refused one of the prompt writer's options" : `${program} refused the prompt writer's ${option}`,
      why: droppable
        ? 'Rewrite runs without it until the daemon restarts; update Jantar on the Mac'
        : "Rewrite can't run without it; update Jantar on the Mac",
    };
    try {
      this.ctx.store.emit({ type: 'alert.error', data: { alert } });
    } catch (e) {
      this.log.error('could not publish the rewrite flags alert', { error: String(e) });
    }
  }

  private audit(rec: JobRecord, ms: number, outcome: string): void {
    const j = rec.job;
    const params: Record<string, unknown> = { sid: j.sid, jobId: j.id, model: j.model, ms, outcome };
    if (j.account !== undefined) params.account = j.account;
    try {
      this.ctx.db.audit.append({
        ts: this.ctx.clock.iso(),
        actor: rec.owner,
        action: 'rewrite.run',
        target: j.id,
        params,
        result: outcome === 'ready' || outcome === 'sent' || outcome === 'cancelled' ? 'ok' : 'failed',
      });
    } catch (e) {
      this.log.error('rewrite: audit write failed', { error: String(e) });
    }
  }
}

export function buildRewriteService(ctx: DaemonContext, deps: RewriteDeps, opts: RewriteOptions = {}): RewriteService {
  return new RewriteServiceImpl(ctx, deps, opts);
}
