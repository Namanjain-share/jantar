/**
 * Rule R8 with real processes: a Rewrite run is one `cswap run ... -- -p`
 * that jantard spawns through its real exec (core/exec.ts), here the fake
 * cswap handing over in-process to the fake claude in mode `slow`. A cancel
 * from the phone, the run's timeout, a claude that ignores SIGTERM (exec
 * sends SIGKILL a second later), and a daemon stop with a run going each
 * leave no process behind: the pid the fake claude recorded is gone, and no
 * process of the fake home's bin/ is left running.
 *
 * Nothing here runs the real claude or cswap.
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LAUNCH_HELD,
  DICTATED,
  claudeCalls,
  claudeSignals,
  launchAccounts,
  processAlive,
  setFakeClaude,
  type ClaudeCall,
  type FakeHome,
} from '@jantar/fixtures';
import { DEVICE_COOKIE, type PairStartResponse, type RewriteDetail, type RewriteJob, type SessionsResponse } from '@jantar/protocol';
import { callDaemon, createCtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret } from './http.js';

const SID = '52525252-5252-4525-8525-525252525252';
const TIMEOUT_S = 5;

/** A Rewrite run of this fake home that is still running (`node <root>/bin/cswap run ... -- -p ...`), from ps. */
function runsLeft(home: FakeHome): string[] {
  const out = execFileSync('/bin/ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((l) => l.includes(`${home.root}/bin/`) && l.includes(' run ') && l.includes(' -p'))
    .map((l) => l.trim());
}

async function boot(): Promise<{ d: Daemon; phone: string }> {
  const d = await bootDaemon({
    home: { accounts: launchAccounts(), sessions: [{ sid: SID, pid: 52001, account: 5, project: 'demo-app', status: 'idle', tty: 'ttys052', transcript: [] }] },
    settings: { rewrite: { enabled: true, timeoutS: TIMEOUT_S }, autoswitch: { hold: [...LAUNCH_HELD] } },
  });
  try {
    const ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    await eventually(async () => (await callDaemon<SessionsResponse>(ctl, 'GET', '/v1/sessions')).sessions.some((s) => s.sid === SID), 15_000, 'the session');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'orphans', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'orphans phone' } });
    expect(claim.status, claim.text).toBe(200);
    const phone = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(phone, claim.body);
    return { d, phone };
  } catch (e) {
    await d.stop();
    throw e;
  }
}

/** Start a Rewrite and wait until its fake claude is running; the run's pid. */
async function startRun(d: Daemon, phone: string): Promise<{ jobId: string; claude: ClaudeCall }> {
  const before = (await claudeCalls(d.home)).length;
  const r = await http(d.port, 'POST', `/v1/sessions/${SID}/rewrite`, { cookie: phone, body: { text: DICTATED.hinglish } });
  expect(r.status, r.text).toBe(202);
  const jobId = (r.body as { jobId: string }).jobId;
  const claude = await eventually(async () => (await claudeCalls(d.home))[before] ?? null, 15_000, 'the fake claude to start');
  expect(processAlive(claude.pid)).toBe(true);
  // ps sees it (so an empty list later means something)
  expect(runsLeft(d.home).map((l) => Number(l.split(/\s+/)[0]))).toEqual([claude.pid]);
  return { jobId, claude };
}

async function job(d: Daemon, phone: string, jobId: string): Promise<RewriteJob> {
  const r = await http(d.port, 'GET', `/v1/rewrite/${jobId}`, { cookie: phone });
  expect(r.status, r.text).toBe(200);
  return (r.body as RewriteDetail).job;
}

describe('R8: no orphaned claude after a Rewrite run ends early (real processes)', () => {
  let d: Daemon;
  let phone: string;

  beforeAll(async () => {
    ({ d, phone } = await boot());
  }, 60_000);

  afterAll(async () => {
    await d?.stop();
  }, 30_000);

  it('a cancel from the phone: SIGTERM, the process is gone, the job cancelled', async () => {
    await setFakeClaude(d.home, { mode: 'slow', slowMs: 120_000 });
    const { jobId, claude } = await startRun(d, phone);
    const del = await http(d.port, 'DELETE', `/v1/rewrite/${jobId}`, { cookie: phone });
    expect(del.status, del.text).toBe(200);
    expect((del.body as { job: RewriteJob }).job.state).toBe('cancelled');
    await eventually(async () => !processAlive(claude.pid), 5_000, 'the cancelled run to exit');
    expect((await claudeSignals(d.home)).filter((s) => s.pid === claude.pid)).toEqual([{ signal: 'SIGTERM', pid: claude.pid, ts: expect.any(Number) }]);
    expect(runsLeft(d.home)).toEqual([]);
    expect((await job(d, phone, jobId)).state).toBe('cancelled');
  }, 30_000);

  it(`the run's timeout (${TIMEOUT_S} s): SIGTERM, the process is gone, the job failed with timeout`, async () => {
    await setFakeClaude(d.home, { mode: 'slow', slowMs: 120_000 });
    const { jobId, claude } = await startRun(d, phone);
    const failed = await eventually(
      async () => {
        const j = await job(d, phone, jobId);
        return j.state === 'failed' ? j : null;
      },
      (TIMEOUT_S + 10) * 1000,
      'the run to time out',
    );
    expect(failed.failure).toBe('timeout');
    await eventually(async () => !processAlive(claude.pid), 5_000, 'the timed-out run to exit');
    expect((await claudeSignals(d.home)).filter((s) => s.pid === claude.pid).map((s) => s.signal)).toEqual(['SIGTERM']);
    // never a retry after a timeout
    expect((await claudeCalls(d.home)).filter((c) => c.pid === claude.pid)).toHaveLength(1);
    expect(runsLeft(d.home)).toEqual([]);
  }, 40_000);

  it('a claude that ignores SIGTERM is killed a second later all the same', async () => {
    await setFakeClaude(d.home, { mode: 'slow', slowMs: 120_000, ignoreSignals: ['SIGINT', 'SIGTERM'] });
    const { jobId, claude } = await startRun(d, phone);
    const del = await http(d.port, 'DELETE', `/v1/rewrite/${jobId}`, { cookie: phone });
    expect(del.status, del.text).toBe(200);
    // SIGTERM is on record and ignored; SIGKILL can't be recorded, the process is simply gone.
    await eventually(async () => (await claudeSignals(d.home)).some((s) => s.pid === claude.pid), 5_000, 'the SIGTERM');
    expect(processAlive(claude.pid)).toBe(true);
    await eventually(async () => !processAlive(claude.pid), 5_000, 'the SIGKILL');
    expect((await claudeSignals(d.home)).filter((s) => s.pid === claude.pid)).toEqual([{ signal: 'SIGTERM', pid: claude.pid, ts: expect.any(Number), ignored: true }]);
    expect(runsLeft(d.home)).toEqual([]);
  }, 30_000);
});

describe('R8: a daemon stop with a Rewrite run going', () => {
  it('stop() kills the run and waits for it: nothing is left running', async () => {
    const { d, phone } = await boot();
    let stopped = false;
    try {
      await setFakeClaude(d.home, { mode: 'slow', slowMs: 120_000, ignoreSignals: ['SIGTERM'] });
      const { claude } = await startRun(d, phone);
      const home = d.home;
      // stop() removes the fake home at the end, so read what is needed from it first.
      await d.running.stop();
      stopped = true;
      expect(processAlive(claude.pid)).toBe(false);
      expect(runsLeft(home)).toEqual([]);
    } finally {
      if (stopped) await d.home.cleanup();
      else await d.stop();
    }
  }, 60_000);
});
