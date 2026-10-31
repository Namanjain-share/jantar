/**
 * The adopt step before an account's first Rewrite run (spec 4.3 "adopt"):
 * `launch.preLaunchArgv` with "{n}" replaced by the account (an adopt
 * script such as `~/bin/adopt.sh {n}`), through `ctx.exec` with a 30 s
 * timeout. It runs once per account per daemon life, not per rewrite: adopt
 * reads every cswap slot
 * from the Keychain. A failure is not cached, so the account is tried again
 * once its penalty is over. No preLaunchArgv: nothing to do.
 *
 * One adopt can serve several jobs, so a job's cancel only stops that job
 * waiting; `stop()` (daemon shutdown) kills the adopt itself.
 *
 * While ccw is restarting a session (a move: it runs cswap's adopt too, and
 * the two may not lock against each other) the adopt waits, as a launch
 * does (launcher.ts waitForCcw), for up to CCW_RESTART_WAIT_MS; a move
 * stuck longer than that is logged and no longer waited for.
 */
import { isAbsolute } from 'node:path';
import type { AccountId } from '@jantar/protocol';
import type { DaemonContext } from '../contracts.js';
import { CSWAP_SCRUB_ENV, scrubEnv } from '../core/exec.js';

export const ADOPT_TIMEOUT_MS = 30_000;
/** How long an adopt waits for ccw to finish restarting a session. */
export const CCW_RESTART_WAIT_MS = 2 * 60_000;
const CCW_WAIT_STEP_MS = 1_000;

export class Adopter {
  private readonly done = new Map<AccountId, Promise<boolean>>();
  /** Aborts every adopt still running (stop). */
  private kill = new AbortController();

  constructor(private readonly ctx: Pick<DaemonContext, 'exec' | 'env' | 'settings' | 'log' | 'store' | 'clock'>) {}

  /**
   * True when the account is ready: adopted in this daemon's life (now or
   * before), or no adopt step is set. False at once when `signal` aborts
   * (the adopt goes on for any other job waiting on it).
   */
  async adopt(account: AccountId, signal?: AbortSignal): Promise<boolean> {
    const argv = this.ctx.settings.get().launch.preLaunchArgv;
    if (!argv) return true;
    let run = this.done.get(account);
    if (!run) {
      const started = this.run(argv, account);
      run = started;
      this.done.set(account, started);
      // Registered before any waiter: a failure is forgotten before anyone sees it.
      const forget = () => {
        if (this.done.get(account) === started) this.done.delete(account);
      };
      void started.then((ok) => (ok ? undefined : forget()), forget);
    }
    return signal ? untilAborted(run, signal) : run;
  }

  /** Kill every adopt still running and forget every result (daemon stop). */
  stop(): void {
    this.kill.abort();
    this.kill = new AbortController();
    this.done.clear();
  }

  private async run(argv: readonly string[], account: AccountId): Promise<boolean> {
    const [file, ...args] = argv.map((a) => a.replaceAll('{n}', String(account)));
    if (!file || !isAbsolute(file)) {
      this.ctx.log.warn('rewrite: launch.preLaunchArgv must start with an absolute path; adopt skipped as failed', { account });
      return false;
    }
    const kill = this.kill.signal;
    if (!(await this.ccwSettled(kill))) return false;
    const res = await this.ctx.exec(file, args, { env: scrubEnv(this.ctx.env, CSWAP_SCRUB_ENV), timeoutMs: ADOPT_TIMEOUT_MS, signal: kill });
    if (res.code === 0) return true;
    this.ctx.log.warn('rewrite: adopt failed', { account, code: res.code, timedOut: res.timedOut, spawnError: res.spawnError });
    return false;
  }

  /** Wait while ccw restarts a session (at most CCW_RESTART_WAIT_MS). False when stop() came first. */
  private async ccwSettled(kill: AbortSignal): Promise<boolean> {
    const until = this.ctx.clock.now() + CCW_RESTART_WAIT_MS;
    while (Object.values(this.ctx.store.getState().moves).some((m) => m.step === 'restarting')) {
      if (this.ctx.clock.now() >= until) {
        this.ctx.log.warn('rewrite: ccw has been restarting a session for 2 minutes; adopting anyway');
        return true;
      }
      try {
        await this.ctx.clock.sleep(CCW_WAIT_STEP_MS, kill);
      } catch {
        return false;
      }
    }
    return !kill.aborted;
  }
}

/** `p`, or false as soon as `signal` aborts. */
function untilAborted(p: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
