/**
 * The window primer (v0.4 wave 2, docs/primer.md) in the production wiring:
 * jantard in-process on a synthetic HOME with the fixtures' fake cswap and
 * claude. Account 2's 5-hour window has reset; account 1's still runs, 3 is
 * disabled and 4's usage is unavailable.
 *
 * 1. Booted with priming off, nothing runs. `jantar accounts prime on`
 *    (the real CLI over ctl.sock) turns it on, and the daemon primes
 *    account 2 alone: `cswap run --share-history 2 -- -p ...`, handed to
 *    claude on that account in <home>/primer/work. state.primer and
 *    `jantar accounts prime` report it; primed.json is 0600.
 * 2. Under --read-only the primer says "off" and never runs cswap, with
 *    priming on.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeCalls, defaultAccounts, type FakeHome } from '@jantar/fixtures';
import type { StateResponse } from '@jantar/protocol';
import { primeArgv } from '@jantar/daemon/primer/rules';
import { callDaemon, createCtlClient, defaultDeps, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, type Daemon } from './harness.js';
import { eventually } from './http.js';

/** The fixtures' four accounts, with account 2's 5-hour window reset five minutes ago. */
const accounts = () => defaultAccounts().map((a) => (a.id === 2 ? { ...a, fiveHourResetMin: -5 } : a));

async function cswapRuns(home: FakeHome) {
  return (await home.calls('cswap')).filter((c) => c.args[0] === 'run');
}

describe('the window primer in jantard', () => {
  let d: Daemon;
  let ctl: CtlClient;

  async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const io = memoryIo(d.home.env);
    const code = await main(argv, { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } });
    return { code, out: io.stdout, err: io.stderr };
  }

  const primerState = async () => (await callDaemon<StateResponse>(ctl, 'GET', '/v1/state')).state.primer;

  beforeAll(async () => {
    d = await bootDaemon({ home: { accounts: accounts(), sessions: [] } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
  }, 30_000);

  afterAll(async () => {
    await d?.stop();
  }, 30_000);

  it('primes nothing while off', async () => {
    expect(await primerState()).toMatchObject({ by: 'off', running: null, last: null });
    expect(await cswapRuns(d.home)).toEqual([]);
  });

  it('`jantar accounts prime on` primes the one free window, and only that one', async () => {
    const on = await cli('accounts', 'prime', 'on');
    expect(on.code, on.err).toBe(0);

    const primer = await eventually(async () => {
      const p = await primerState();
      return p?.last ? p : null;
    }, 20_000, 'the first prime');
    expect(primer).toMatchObject({ by: 'jantar', running: null, last: { account: 2, ok: true } });

    const runs = await cswapRuns(d.home);
    expect(runs.map((r) => r.args)).toEqual([primeArgv(2)]);
    const claude = await claudeCalls(d.home);
    expect(claude.map((c) => [c.account, c.via, c.args.slice(0, 2)])).toEqual([[2, 'cswap', ['-p', 'Reply with only: ok']]]);

    // The primer shows the prime first and then writes primed.json.
    const primed = await eventually(() => stat(join(d.ctx.paths.home, 'primer', 'primed.json')).catch(() => null), 5_000, 'primed.json');
    expect(primed.mode & 0o777).toBe(0o600);
    expect((await stat(join(d.ctx.paths.home, 'primer', 'work'))).mode & 0o777).toBe(0o700);

    const shown = await cli('accounts', 'prime');
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toContain('Last prime: account 2');
    // The run's reply never reaches the log.
    expect(d.log.records.some((r) => JSON.stringify(r).includes('Reply with only'))).toBe(false);
  }, 30_000);
});

describe('the window primer under --read-only', () => {
  let d: Daemon;

  beforeAll(async () => {
    d = await bootDaemon({ home: { accounts: accounts(), sessions: [] }, readOnly: true, settings: { accounts: { prime: true } } });
  }, 30_000);

  afterAll(async () => {
    await d?.stop();
  }, 30_000);

  it('says off and runs nothing', async () => {
    const ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const { state } = await callDaemon<StateResponse>(ctl, 'GET', '/v1/state');
    expect(state.primer).toMatchObject({ by: 'off', running: null });
    expect(await cswapRuns(d.home)).toEqual([]);
  });
});
