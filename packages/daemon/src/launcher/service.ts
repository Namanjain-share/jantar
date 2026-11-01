/**
 * The launcher (work package L): the folder browser, the start sheet's
 * preview, and launch jobs that open a new Terminal window (U3, U7, U8).
 *
 * - Folders: folders.ts, through FilesService.policy (works with Files off).
 * - Preview: the folder, the account (account.ts: Auto = most 5-hour room,
 *   never a held account), the flags (flags.ts: the phone's picks, else this
 *   actor's last start, else launch.defaultFlags), the --name (the one typed
 *   on the sheet, else a suggested one) and the exact command line
 *   (command.ts), with warnings ("name" when the typed one is taken).
 * - Launch: re-validates everything (switch, scope, rate, folder, name,
 *   prompt, account, flags) before a job exists, remembers this actor's
 *   flags, then runs the job in the background (launcher.ts). A retried
 *   start with the same Idempotency-Key gets the same job back, also after
 *   a restart (the keys are kept in db.kv).
 * - Limits: settings.launch.rate per actor (starts per 10 min and per day,
 *   at most `inFlight` unfinished), and one launch per account at a time.
 *   The API adds its own per-device limiter on top.
 * - Recovery: on start, an unfinished job before ready resumes watching
 *   (with no prompt) when its session runs or its window is known: a launch
 *   waiting on the trust card has no session file yet. Only while launching
 *   is on, and only a job younger than its longest wait (the ready clock or
 *   a card's dialogMin, plus a minute). One past ready whose session runs
 *   ends done (or done-no-prompt); any other one ends failed.
 *
 * v0.4 (spec 4.10, 4.11):
 * - Resume: a preview or start with `resume` checks the id against the
 *   folder's history (history.ts; 404 when it is not there, 409 while it
 *   runs or another start is resuming it), types `--resume <id>` with no
 *   --session-id, and expects the session under that id. A conversation in
 *   one profile's own projects dir pins its account (source "resume"); the
 *   preview marks every other account not selectable.
 * - Single-account mode (no cswap): Auto is account 0 with no hold, usage,
 *   group or busy logic, and launches only in claude mode. The accounts mode
 *   and launch.mode must agree (accountsModeProblem): a mismatch is refused
 *   before the folder is read, with the command that fixes it.
 */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  LaunchFlagsSchema,
  LaunchNameSchema,
  launchFlagArgs,
  launchFlagsDangerous,
  localSession,
  localSessions,
  type AccountId,
  type LaunchAccount,
  type LaunchAnswerBody,
  type LaunchJob,
  type LaunchPreview,
  type LaunchPreviewQuery,
  type LaunchStartBody,
  type LaunchWarning,
  type Settings,
} from '@jantar/protocol';
import type { Actor, DaemonContext, Factories, FileRefusal, Launcher, LaunchResult, Unsubscribe } from '../contracts.js';
import { actorId } from '../core/actor.js';
import { canonicalJson, sha256Hex } from '../core/hash.js';
import { newId } from '../core/ids.js';
import { hasScope } from '../auth/scopes.js';
import { acct, dur } from '../notify/format.js';
import { validatePromptText } from '../writer/text.js';
import { keptAccounts } from '../core/kept-accounts.js';
import {
  SINGLE_ACCOUNT,
  accountRows,
  groupAccount,
  isHeld,
  notSelectable,
  pickAuto,
  pickSingle,
  pinRows,
  pinnedReason,
  singleRows,
  usageLine,
  type AccountInputs,
} from './account.js';
import { dirsAccounts } from '../sources/cswap/dirs.js';
import { accountsModeProblem, launchCommand, nameFromFolder, uniqueName } from './command.js';
import { startingFlags } from './flags.js';
import { Folders, fail, isRefusal, refusalResult, type Failure } from './folders.js';
import { NOT_IN_HISTORY, RESUME_RUNNING, RESUME_STARTING, isLive, pastFile, type PastFile } from './history.js';
import { LaunchRun, RESTART_REASON, RUN_TIMINGS, isFinal, isPreReady, noWindows, type RunDeps, type RunTimings } from './launcher.js';

export type LauncherDeps = Parameters<Factories['launcher']>[1];

export interface LauncherOptions {
  /** Shorter waits for tests. */
  timings?: Partial<RunTimings>;
}

export const LAUNCH_OFF = 'Starting sessions from the phone is off. Turn it on at your Mac: jantar launch on';
export const NO_LAUNCH_SCOPE = "This device can't start sessions. On your Mac run: jantar devices grant <device> launch";

/**
 * Who may start a session or answer its start dialog: the CLI, or a device
 * with launch. An allow-list, so an actor kind it does not name (the
 * system, v0.5's extension) is refused.
 */
export function mayLaunch(actor: Actor): boolean {
  return actor.kind === 'cli' || (actor.kind === 'device' && hasScope(actor.scopes, 'launch'));
}
export const IDEMPOTENCY_KV_KEY = 'launcher.idempotency.v1';
const IDEM_TTL_MS = 24 * 60 * 60_000;
const IDEM_MAX = 200;
/** A booking stands for a new session's first half hour of burn. */
const BOOKING_SPAN_MS = 30 * 60_000;
/** Usage older than this adds a "stale" warning. */
const STALE_MS = 10 * 60_000;
const TEN_MIN_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const TAILS_MAX = 50;
/** A job left before ready is resumed only if its longest wait, plus this, has not run out. */
const RESUME_GRACE_MS = 60_000;

type Choice = { ok: true; pick: AccountId | null; source: LaunchJob['accountSource']; reason: string; warnings: LaunchWarning[] };
type IdemEntry = { jobId: string; bodyHash: string; at: number };
/** ccw's view of autoswitch while it runs, else settings.autoswitch and settings.groups. */
type CcwView = { hold: readonly number[]; groups: string[][]; ceiling: number; weeklyCeiling: number };

const nameTaken = (name: string) => `A session named ${name} is already running or starting`;
/** v0.6, config dirs: the account's ~/.claude-<name> lost its .claude.json since the roster was listed. */
const dirGone = (id: AccountId) => `${acct(id)}'s config dir is no longer on this machine (no .claude.json in it)`;

/** Why the command line can't be built: the Mac's launch setup, or something about this folder. */
function commandFailure(cmd: { reason: string; setup?: true }): Failure {
  if (cmd.setup) return fail('unavailable', `This Mac isn't set up to start sessions from the phone: ${cmd.reason}`);
  return fail('invalid_request', `This folder can't be started from the phone: ${cmd.reason}`);
}

export function buildLauncher(ctx: DaemonContext, deps: LauncherDeps, opts: LauncherOptions = {}): Launcher {
  return new LauncherService(ctx, deps, opts);
}

export class LauncherService implements Launcher {
  readonly folders: Folders;
  private readonly runs = new Map<string, LaunchRun>();
  private readonly tails = new Map<string, string>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly runDeps: RunDeps;
  private unsubscribe: Unsubscribe | null = null;
  private unsettings: Unsubscribe | null = null;
  /** ccw runs but its switch.json can't be read: said once in the log (the kept accounts still hold). */
  private switchUnread = false;

  constructor(
    private readonly ctx: DaemonContext,
    private readonly deps: LauncherDeps,
    opts: LauncherOptions = {},
  ) {
    this.folders = new Folders(ctx, () => deps.files.policy, (actor, root, rel, r) => deps.files.denied(actor, root, rel, r.refused));
    this.runDeps = {
      ctx,
      terminal: deps.terminal,
      writer: deps.writer,
      ccwLegacy: deps.ccwLegacy,
      policy: () => deps.files.policy,
      notifiers: deps.notifiers,
      timings: { ...RUN_TIMINGS, ...opts.timings },
      track: (p) => this.track(p),
    };
  }

  async start(): Promise<void> {
    // Folders sessions run in are noted (a realpath each) only while launching is on: a switched-off
    // feature touches no disk, and a path outside the roots may raise a macOS privacy prompt.
    // v0.6: never a paired server's session (its folder is no path here; folders_seen is the Mac's).
    this.unsubscribe = this.ctx.store.subscribe((ev) => {
      if (ev.type === 'session.added' && ev.data.session.node === undefined && this.ctx.settings.get().launch.enabled) {
        this.track(this.folders.noteSession(ev.data.session));
      }
    });
    this.unsettings = this.ctx.settings.subscribe((next, prev) => {
      if (!prev.launch.enabled && next.launch.enabled) this.noteLive();
      if (prev.launch.enabled && !next.launch.enabled) this.switchedOff();
    });
    if (this.ctx.settings.get().launch.enabled) this.noteLive();
    this.recover();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsettings?.();
    this.unsettings = null;
    const runs = [...this.runs.values()];
    for (const r of runs) r.abort();
    await Promise.allSettled([...runs.map((r) => r.done), ...this.pending]);
  }

  // ---- preview ---------------------------------------------------------------

  async preview(q: LaunchPreviewQuery, actor: Actor): Promise<LaunchResult<{ preview: LaunchPreview }>> {
    const s = this.ctx.settings.get();
    const single = this.single();
    const mismatch = accountsModeProblem(this.ctx.accountsMode(), s.launch.mode);
    if (mismatch) return fail('unavailable', mismatch);
    const dir = await this.deps.files.policy.resolveDir(q.root, q.path);
    if (isRefusal(dir)) return this.refused(actor, q.root, q.path, dir);
    const past = q.resume === undefined ? null : await this.resumable(dir.real, q.resume);
    if (past && !past.ok) return past;
    const picks: Parameters<typeof startingFlags>[0] = {};
    if (q.permission !== undefined) picks.permission = q.permission;
    if (q.chrome !== undefined) picks.chrome = q.chrome;
    if (q.effort !== undefined) picks.effort = q.effort;
    if (q.model !== undefined) picks.model = q.model;
    const flags = startingFlags(picks, this.ctx.db.launchFlags.get(actorId(actor)), s.launch.defaultFlags);
    const folderName = basename(dir.real);
    const view = await this.ccwView();
    const jobs = this.recentJobs();
    const taken = this.takenNames(jobs);
    // The Name typed on the sheet, so the command shown is the one a start types.
    const name = q.name ?? uniqueName(nameFromFolder(folderName), taken);
    const inputs = this.accountInputs(view, jobs);
    const pinned = past?.file.account ?? null;
    const choice = this.choose(q.account, inputs, folderName, name, view.groups, pinned);
    if (!choice.ok) return choice;
    const warnings = [...choice.warnings];
    if (q.name !== undefined && taken.has(q.name)) warnings.push({ kind: 'name', text: nameTaken(q.name) });
    // Single mode reads no usage and has no account moves; nor do config dirs (fetchedAt is when they were listed).
    if (!single && inputs.mode !== 'dirs') {
      const fetchedAt = Date.parse(this.ctx.store.getState().usage.fetchedAt ?? '');
      if (Number.isFinite(fetchedAt) && inputs.nowMs - fetchedAt > STALE_MS) {
        warnings.push({ kind: 'stale', text: `Based on usage readings ${dur(inputs.nowMs - fetchedAt)} old` });
      }
      // Only the legacy ccw tool moves sessions between accounts (and restarts them with --effort ultracode).
      if (flags.effort !== 'ultracode' && this.deps.ccwLegacy.present()) {
        warnings.push({ kind: 'effort', text: 'An account move restarts it with ultracode effort (ccw adds --effort ultracode)' });
      }
    }
    const args = launchFlagArgs(flags);
    const configDir = this.configDirFor(choice.pick);
    if (configDir === undefined && choice.pick !== null) return fail('refused', dirGone(choice.pick));
    const cmd = launchCommand({
      folder: dir.real,
      account: choice.pick,
      args,
      sid: past ? past.file.id : null,
      resume: past !== null,
      name,
      launch: s.launch,
      cswap: this.ctx.bins.cswap,
      claude: this.ctx.bins.claude,
      configDir,
      dirs: inputs.mode === 'dirs',
    });
    if (!cmd.ok) return commandFailure(cmd);
    let accounts: LaunchAccount[] = single ? singleRows(inputs.sessions) : accountRows(inputs);
    if (pinned !== null && !single) accounts = pinRows(accounts, pinned);
    return {
      ok: true,
      preview: {
        root: dir.root.id,
        path: dir.rel,
        display: dir.display,
        account: { pick: choice.pick, source: choice.source, reason: choice.reason },
        accounts,
        flags,
        defaults: { ...s.launch.defaultFlags },
        args,
        command: cmd.command,
        name,
        warnings,
      },
    };
  }

  // ---- launch ----------------------------------------------------------------

  async launch(body: LaunchStartBody, actor: Actor, idempotencyKey: string): Promise<LaunchResult<{ job: LaunchJob; duplicate: boolean }>> {
    const s = this.ctx.settings.get();
    if (!s.launch.enabled) return fail('forbidden', LAUNCH_OFF);
    if (!mayLaunch(actor)) return fail('forbidden', NO_LAUNCH_SCOPE);
    const mismatch = accountsModeProblem(this.ctx.accountsMode(), s.launch.mode);
    if (mismatch) return fail('unavailable', mismatch);
    const single = this.single();
    const who = actorId(actor);
    const bodyHash = sha256Hex(canonicalJson(body));
    const prior = this.idemGet(who, idempotencyKey);
    if (prior) {
      if (prior.bodyHash !== bodyHash) return fail('conflict', 'This Idempotency-Key was already used for a different start');
      const job = this.runs.get(prior.jobId)?.snapshot() ?? this.ctx.db.launches.get(prior.jobId);
      if (job) return { ok: true, job, duplicate: true };
    }
    const flagsOk = LaunchFlagsSchema.safeParse(body.flags);
    if (!flagsOk.success) return fail('invalid_request', 'Pick the flags from the lists on the start sheet');
    const flags = flagsOk.data;
    const limited = this.rateCheck(who, s, this.recentJobs());
    if (limited) return limited;

    const dir = await this.deps.files.policy.resolveDir(body.root, body.path);
    if (isRefusal(dir)) return this.refused(actor, body.root, body.path, dir);
    // Re-validated here, as the folder is: the id must still be in this folder's history and not running.
    const past = body.resume === undefined ? null : await this.resumable(dir.real, body.resume);
    if (past && !past.ok) return past;
    let prompt: string | null = null;
    if (body.prompt !== undefined) {
      const p = validatePromptText(body.prompt);
      if (!p.ok) return fail('invalid_request', `The first prompt can't be sent: ${p.reason}`);
      prompt = p.text;
    }
    const folderName = basename(dir.real);
    const view = await this.ccwView();
    if (!this.deps.terminal.openWindow || !(await this.deps.terminal.available())) {
      return fail('unavailable', noWindows(this.deps.terminal));
    }

    // Nothing below waits, so two starts cannot both pass the checks for one account or one name.
    const jobs = this.recentJobs();
    const again = this.rateCheck(who, s, jobs);
    if (again) return again;
    if (past) {
      // It may have started at the Mac, or from another start, while the checks above waited.
      if (isLive(this.ctx, past.file.id)) return fail('conflict', RESUME_RUNNING);
      if (jobs.some((j) => j.resumed && j.sid === past.file.id && !isFinal(j.stage))) return fail('conflict', RESUME_STARTING);
    }
    const taken = this.takenNames(jobs);
    let name: string;
    if (body.name !== undefined) {
      if (!LaunchNameSchema.safeParse(body.name).success) return fail('invalid_request', 'A session name may use letters, digits, ".", "_" and "-" only');
      if (taken.has(body.name)) return fail('conflict', nameTaken(body.name));
      name = body.name;
    } else {
      name = uniqueName(nameFromFolder(folderName), taken);
    }
    const inputs = this.accountInputs(view, jobs);
    const choice = this.choose(body.account, inputs, folderName, name, view.groups, past?.file.account ?? null);
    if (!choice.ok) return choice;
    if (choice.pick === null) return fail('refused', choice.reason);
    let accountId: AccountId = SINGLE_ACCOUNT;
    // Single mode: the one login, with no roster, hold or busy checks (spec 4.11).
    if (!single) {
      const account = inputs.accounts.find((a) => a.id === choice.pick);
      if (!account) return fail('invalid_request', `There is no account ${acct(choice.pick)}`);
      // A resume's pinned account is checked as a manual pick is.
      if (body.account !== 'auto' || choice.source === 'resume') {
        const why = notSelectable(account, inputs);
        if (why) {
          const relogin = account.usageStatus === 'relogin_required' || account.usageStatus === 'token_expired';
          return fail('refused', relogin ? `${acct(account.id)} needs a re-login on the Mac (cswap)` : `${acct(account.id)} can't be used: ${why}`);
        }
        if (isHeld(account, inputs) && body.confirmHeld !== true) {
          return fail('conflict', `${acct(account.id)} is held for other work: confirm to start there anyway`);
        }
      }
      if (inputs.busy.has(account.id)) return fail('conflict', `A session is already starting on ${acct(account.id)}; wait for it to be ready`);
      accountId = account.id;
    }

    // A resume expects the session under the conversation's own id (launcher.ts matches it, or falls back by window).
    const sid = past ? past.file.id : randomUUID();
    // A config dir that lost its .claude.json since the roster was listed: never start it on ~/.claude instead.
    const configDir = this.configDirFor(accountId);
    if (configDir === undefined) return fail('refused', dirGone(accountId));
    const cmd = launchCommand({
      folder: dir.real,
      account: accountId,
      args: launchFlagArgs(flags),
      sid,
      resume: past !== null,
      name,
      launch: s.launch,
      cswap: this.ctx.bins.cswap,
      claude: this.ctx.bins.claude,
      configDir,
      dirs: inputs.mode === 'dirs',
    });
    if (!cmd.ok) return commandFailure(cmd);
    const at = this.ctx.clock.iso();
    const job: LaunchJob = {
      id: newId(),
      createdAt: at,
      updatedAt: at,
      actor: who,
      rootId: dir.root.id,
      folder: dir.real,
      display: dir.display,
      account: accountId,
      accountSource: choice.source,
      requested: body.account,
      flags,
      dangerous: launchFlagsDangerous(flags),
      name,
      sid,
      stage: 'queued',
      // One login has no account to name.
      steps: [{ at, stage: 'queued', detail: single ? 'Queued' : `Queued · ${acct(accountId)} · ${choice.source}` }],
    };
    if (past) job.resumed = true;
    if (prompt !== null) job.prompt = { hash: sha256Hex(prompt), length: prompt.length };
    this.ctx.db.launchFlags.set(who, flags, at);
    this.idemSet(who, idempotencyKey, job.id, bodyHash);
    const run = new LaunchRun(this.runDeps, job, { kind: 'new', command: cmd.command, rel: dir.rel, prompt, actor });
    run.save();
    this.begin(run, job.id);
    return { ok: true, job: run.snapshot(), duplicate: false };
  }

  // ---- reads -----------------------------------------------------------------

  get(id: string): { job: LaunchJob; screenTail?: string } | null {
    const run = this.runs.get(id);
    const job = run?.snapshot() ?? this.ctx.db.launches.get(id);
    if (!job) return null;
    const tail = run ? run.tail : this.tails.get(id);
    // The tail is for failures and dialogs only, and only here (never in events).
    const shows = job.stage === 'dialog' || job.stage === 'failed' || job.stage === 'stalled';
    return tail && shows ? { job, screenTail: tail } : { job };
  }

  list(opts: { active: boolean }): LaunchJob[] {
    return this.ctx.db.launches.list({ limit: 50, unfinished: opts.active });
  }

  async answer(id: string, body: LaunchAnswerBody, actor: Actor): Promise<LaunchResult<{ job: LaunchJob }>> {
    if (!mayLaunch(actor)) return fail('forbidden', NO_LAUNCH_SCOPE);
    const run = this.runs.get(id);
    if (!run) return this.ctx.db.launches.get(id) ? fail('conflict', 'This start is not waiting on a dialog') : fail('not_found', 'No such launch');
    return run.answer(body, actor);
  }

  // ---- internals ---------------------------------------------------------------

  /** A path refusal, audited by Files (files.denied, the probe alarm), as the answer. */
  private refused(actor: Actor, root: string, rel: string, r: FileRefusal): Failure {
    this.deps.files.denied(actor, root, rel, r.refused);
    return refusalResult(r);
  }

  private noteLive(): void {
    for (const s of Object.values(localSessions(this.ctx.store.getState()))) this.track(this.folders.noteSession(s));
  }

  /**
   * Launching turned off at the Mac: every run stops where it stands and
   * types nothing more (no dialog answer, no first prompt). A launch before
   * ready ends failed; its window is left to the Mac. launchAnswer is off
   * now too, so a card could never be answered.
   */
  private switchedOff(): void {
    for (const run of this.runs.values()) this.track(run.switchedOff());
  }

  private track(p: Promise<unknown>): void {
    const q = p.catch((e: unknown) => this.ctx.log.warn('launcher task failed', { error: String(e) }));
    this.pending.add(q);
    void q.finally(() => this.pending.delete(q));
  }

  private begin(run: LaunchRun, id: string): void {
    this.runs.set(id, run);
    run.start();
    void run.done.finally(() => {
      if (this.runs.get(id) !== run) return;
      this.runs.delete(id);
      if (run.tail) {
        this.tails.set(id, run.tail);
        while (this.tails.size > TAILS_MAX) {
          const first = this.tails.keys().next().value;
          if (first === undefined) break;
          this.tails.delete(first);
        }
      }
    });
  }

  /**
   * Unfinished jobs from before a restart. Before ready: watched again when
   * the session runs or the window's tty is known (Claude writes its session
   * file only past the trust dialog, so a launch waiting on that card has
   * none yet); the watch itself fails it if the window is gone or is not the
   * one this launch opened (LaunchRun.resume). Never while launching is off,
   * and never once its waits have run out: macOS hands a closed tab's tty to
   * the next one, and a resumed run answers dialogs on it.
   */
  private recover(): void {
    const launch = this.ctx.settings.get().launch;
    const maxAgeMs = Math.max(launch.timeouts.readyS * 1000, launch.timeouts.dialogMin * 60_000) + RESUME_GRACE_MS;
    const now = this.ctx.clock.now();
    for (const job of this.ctx.db.launches.list({ unfinished: true, limit: 100 })) {
      if (this.runs.has(job.id)) continue;
      const running = Boolean(localSession(this.ctx.store.getState(), job.sid));
      const run = new LaunchRun(this.runDeps, job, { kind: 'resume' });
      const age = now - Date.parse(job.updatedAt);
      const live = launch.enabled && Number.isFinite(age) && age <= maxAgeMs;
      if (isPreReady(job.stage) && live && (running || job.tty)) {
        this.begin(run, job.id);
      } else if (running) {
        // Ready or prompting: the prompt lived only in memory.
        run.settle(job.prompt ? 'done-no-prompt' : 'done', job.prompt ? 'The daemon restarted before the first prompt was confirmed. Check the session and send it again if needed.' : undefined);
      } else {
        run.settle('failed', RESTART_REASON);
      }
    }
  }

  /**
   * Jobs in memory and in the db, newest stored ones after the live ones. The
   * table is read whole (LaunchRepo.list parses every row), so each operation
   * reads it once and hands the list down.
   */
  private recentJobs(): LaunchJob[] {
    const live = new Map([...this.runs.values()].map((r) => r.snapshot()).map((j) => [j.id, j]));
    const stored = this.ctx.db.launches.list({ limit: 1000 }).filter((j) => !live.has(j.id));
    return [...live.values(), ...stored];
  }

  /** settings.launch.rate for one actor; counts accepted starts only. */
  private rateCheck(who: string, s: Settings, jobs: readonly LaunchJob[]): Failure | null {
    const now = this.ctx.clock.now();
    const rate = s.launch.rate;
    const mine = jobs.filter((j) => j.actor === who);
    if (mine.filter((j) => !isFinal(j.stage)).length >= rate.inFlight) {
      return fail('rate_limited', `At most ${rate.inFlight} starts at a time; wait for one to finish`, 30_000);
    }
    for (const [span, max, words] of [
      [TEN_MIN_MS, rate.perTenMin, 'in 10 minutes'],
      [DAY_MS, rate.perDay, 'a day'],
    ] as const) {
      const times = mine.map((j) => Date.parse(j.createdAt)).filter((t) => t > now - span);
      if (times.length >= max) {
        const oldest = Math.min(...times);
        return fail('rate_limited', `At most ${max} starts ${words}; try again later`, Math.max(1, oldest + span - now));
      }
    }
    return null;
  }

  private single(): boolean {
    return this.ctx.accountsMode() === 'single';
  }

  /**
   * v0.6, accountsMode "dirs": the config dir an account stands for (null for
   * ~/.claude, and in every other mode); undefined when it is no longer listed
   * (its .claude.json went since the roster was), so the start is refused.
   */
  private configDirFor(account: AccountId | null): string | null | undefined {
    if (account === null || account === SINGLE_ACCOUNT || this.ctx.accountsMode() !== 'dirs') return null;
    return dirsAccounts(this.ctx.paths, this.ctx.db.kv).find((a) => a.id === account)?.dir;
  }

  /**
   * A resume's conversation, checked against `folder`'s history (a realpath):
   * one of its transcripts (else 404; looked up by id, so an entry pushed
   * past the newest 20 since it was listed still starts) and not running
   * (else 409). Only its id and account are needed, so no file is opened.
   */
  private async resumable(folder: string, id: string): Promise<{ ok: true; file: PastFile } | Failure> {
    const file = await pastFile({ ctx: this.ctx, sessions: this.deps.sessions }, folder, id);
    if (!file) return fail('not_found', NOT_IN_HISTORY);
    if (isLive(this.ctx, id)) return fail('conflict', RESUME_RUNNING);
    return { ok: true, file };
  }

  /** ccw's hold list, groups and ceilings while it runs (it owns autoswitch then, as /v1/plan reports them), else ours. */
  private async ccwView(): Promise<CcwView> {
    const s = this.ctx.settings.get();
    const view: CcwView = { hold: [], groups: s.groups, ceiling: s.autoswitch.ceiling, weeklyCeiling: s.autoswitch.weekly_ceiling };
    const ccw = this.deps.ccwLegacy;
    // Single mode has no holds, groups or ceilings to read.
    if (this.single() || !ccw.present()) return view;
    const sw = await ccw.switchConfig().catch(() => null);
    if (!sw && !this.switchUnread) this.ctx.log.warn("can't read ccw's switch.json: Auto holds the kept accounts and settings.autoswitch.hold only");
    this.switchUnread = !sw;
    const plan = await ccw.plan().catch(() => null);
    return {
      hold: sw?.hold ?? [],
      groups: sw?.groups ?? view.groups,
      ceiling: plan?.ceiling ?? view.ceiling,
      weeklyCeiling: plan?.weeklyCeiling ?? view.weeklyCeiling,
    };
  }

  /** What the account choice needs: the roster, the hold list, and the bookings and busy accounts from `jobs`. */
  private accountInputs(view: CcwView, jobs: readonly LaunchJob[]): AccountInputs {
    const st = this.ctx.store.getState();
    const s = this.ctx.settings.get();
    const now = this.ctx.clock.now();
    const bookings = new Map<AccountId, number>();
    const busy = new Set<AccountId>();
    for (const j of jobs) {
      // One launch per account at a time: an account is busy until its launch is ready.
      if (isPreReady(j.stage)) busy.add(j.account);
      if (j.stage === 'failed' || j.stage === 'refused' || j.stage === 'stalled') continue;
      if (Date.parse(j.createdAt) <= now - BOOKING_SPAN_MS) continue;
      bookings.set(j.account, (bookings.get(j.account) ?? 0) + 1);
    }
    return {
      accounts: Object.values(st.accounts),
      // v0.6: Auto counts this Mac's own sessions on its own accounts.
      sessions: Object.values(localSessions(st)),
      nowMs: now,
      hold: new Set([...s.autoswitch.hold, ...view.hold]),
      kept: keptAccounts(s),
      ceiling: view.ceiling,
      weeklyCeiling: view.weeklyCeiling,
      burnPerMin: s.autoswitch.burn_default,
      bookings,
      busy,
      timeZone: this.ctx.env.TZ,
      mode: this.ctx.accountsMode(),
    };
  }

  /**
   * The account for a preview or a start: Auto (always the most room, U3), or
   * the one asked for. A folder in a ccw group whose live members are on
   * another account gets the "group" warning, whose quick choice is a manual
   * pick of that account (source "group").
   *
   * v0.4: single mode is account 0, asked for or Auto. A resume `pinned` to a
   * profile's account takes it whatever was asked for (source "resume").
   */
  private choose(
    requested: AccountId | 'auto',
    inputs: AccountInputs,
    folderName: string,
    name: string,
    groups: string[][],
    pinned: AccountId | null,
  ): Choice | Failure {
    if (this.single()) {
      if (requested !== 'auto' && requested !== SINGLE_ACCOUNT) return fail('invalid_request', `There is no account ${acct(requested)}`);
      return { ok: true, ...pickSingle(), source: requested === 'auto' ? 'auto' : 'manual', warnings: [] };
    }
    if (pinned !== null) {
      const a = inputs.accounts.find((x) => x.id === pinned);
      if (!a) return fail('refused', `${pinnedReason(pinned)}, which cswap no longer lists`);
      const warnings: LaunchWarning[] = [];
      if (isHeld(a, inputs)) {
        warnings.push({ kind: 'held', text: `Held for other work. ccw will never move this session, even when ${acct(a.id)} fills up.`, account: a.id });
      }
      const why = notSelectable(a, inputs);
      return { ok: true, pick: a.id, source: 'resume', reason: why ? `${pinnedReason(a.id)} · ${why}` : pinnedReason(a.id), warnings };
    }
    const group = groupAccount(folderName, name, groups, inputs.sessions);
    const warnings: LaunchWarning[] = [];
    const groupWarning = (pick: AccountId | null) => {
      if (!group || pick === group.account) return;
      warnings.push({
        kind: 'group',
        text: `Group ${group.label} is on ${acct(group.account)}. Starting ${pick === null ? 'elsewhere' : `on ${acct(pick)}`} splits it; ccw may move it.`,
        account: group.account,
      });
    };
    if (requested === 'auto') {
      const auto = pickAuto(inputs);
      groupWarning(auto.pick);
      return { ok: true, pick: auto.pick, source: 'auto', reason: auto.reason, warnings };
    }
    const a = inputs.accounts.find((x) => x.id === requested);
    if (!a) return fail('invalid_request', `There is no account ${acct(requested)}`);
    if (isHeld(a, inputs)) {
      warnings.push({ kind: 'held', text: `Held for other work. ccw will never move this session, even when ${acct(a.id)} fills up.`, account: a.id });
    }
    groupWarning(a.id);
    const joins = group !== null && group.account === a.id;
    const why = notSelectable(a, inputs);
    const reason = why
      ? `${acct(a.id)} · ${why}`
      : joins
        ? `joins group ${group.label} on ${acct(a.id)} · ${usageLine(a, inputs)}`
        : `you picked ${acct(a.id)} · ${usageLine(a, inputs)}`;
    return { ok: true, pick: a.id, source: joins ? 'group' : 'manual', reason, warnings };
  }

  /** Names a new session may not take: live sessions' and those of launches still going. */
  private takenNames(jobs: readonly LaunchJob[]): Set<string> {
    const out = new Set<string>();
    for (const s of Object.values(localSessions(this.ctx.store.getState()))) if (s.name && s.status !== 'ended') out.add(s.name);
    for (const j of jobs) if (!isFinal(j.stage)) out.add(j.name);
    return out;
  }

  private idemMap(): Record<string, IdemEntry> {
    const raw = this.ctx.db.kv.get<Record<string, IdemEntry>>(IDEMPOTENCY_KV_KEY);
    return raw && typeof raw === 'object' ? raw : {};
  }

  private idemGet(who: string, key: string): IdemEntry | null {
    const e = this.idemMap()[`${who}\u0000${key}`];
    return e && this.ctx.clock.now() - e.at < IDEM_TTL_MS ? e : null;
  }

  private idemSet(who: string, key: string, jobId: string, bodyHash: string): void {
    const now = this.ctx.clock.now();
    const kept = Object.entries(this.idemMap())
      .filter(([, e]) => now - e.at < IDEM_TTL_MS)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, IDEM_MAX - 1);
    this.ctx.db.kv.set(IDEMPOTENCY_KV_KEY, Object.fromEntries([[`${who}\u0000${key}`, { jobId, bodyHash, at: now }], ...kept]));
  }
}
