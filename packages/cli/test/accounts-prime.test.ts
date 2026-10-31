/**
 * jantar accounts prime (docs/primer.md): the Mac-only switch
 * accounts.prime (and primeKept with --kept) through the daemon or, with
 * the daemon down, in config.json; what `accounts` and `accounts prime` say
 * about who primes (Jantar, ccw unless its switch.json says "prime": false,
 * or nobody) and Jantar's last prime. Synthetic HOME and account numbers.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import { NO_FEATURES, PROTOCOL_VERSION, emptyState, type AccountsMode, type PrimerStatus } from '@jantar/protocol';
import accounts from '../src/commands/accounts.js';
import { EXIT } from '../src/command.js';
import { contextFor, fakeCtl, fakeSettings, ok, testDeps, T0 } from './helpers.js';

const RULE = 'When an account has no 5-hour window running, one tiny Haiku run starts its clock (at most once per 5 hours).';

/** GET /v1/state as a daemon in `mode` answers it, with its primer status. */
function stateIn(mode: AccountsMode, primer?: PrimerStatus) {
  const state = emptyState();
  state.daemon = { protocol: PROTOCOL_VERSION, daemonVersion: '0.4.0', webHash: null, features: { ...NO_FEATURES }, accountsMode: mode };
  if (primer) state.primer = primer;
  return ok({ seq: 1, epoch: 'e1', state });
}

const health = ok({ ok: true, protocol: PROTOCOL_VERSION, daemonVersion: '0.4.0' });

describe('jantar accounts prime', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
  });
  afterEach(async () => {
    await home.cleanup();
  });

  const withCswap = () => testDeps({ bins: { cswap: home.bins.cswap } });

  async function writeSwitch(json: unknown) {
    await mkdir(home.paths.ccwDir, { recursive: true });
    await writeFile(join(home.paths.ccwDir, 'switch.json'), JSON.stringify(json));
  }

  it('on, then on --kept, then off: one patch each, through the daemon', async () => {
    const s = fakeSettings();
    const ctl = fakeCtl({ ...s.routes, 'GET /healthz': health, 'GET /v1/state': stateIn('cswap') });

    const on = contextFor(home, { deps: withCswap(), ctl });
    expect(await accounts.run(['prime', 'on'], on.ctx), on.io.stderr).toBe(EXIT.ok);
    expect(on.io.stdout).toBe(`Priming free 5-hour windows is on. ${RULE} Kept and held accounts are left out.\n`);
    expect(s.settings.accounts).toMatchObject({ prime: true, primeKept: false });

    const kept = contextFor(home, { deps: withCswap(), ctl });
    expect(await accounts.run(['prime', 'on', '--kept'], kept.ctx), kept.io.stderr).toBe(EXIT.ok);
    expect(kept.io.stdout).toBe(`Priming free 5-hour windows is on. ${RULE} Kept and held accounts too.\n`);
    expect(s.settings.accounts).toMatchObject({ prime: true, primeKept: true });

    const off = contextFor(home, { deps: withCswap(), ctl });
    expect(await accounts.run(['prime', 'off'], off.ctx), off.io.stderr).toBe(EXIT.ok);
    expect(off.io.stdout).toBe('Priming free 5-hour windows is off.\n');
    expect(s.patches).toEqual([
      { accounts: { prime: true, primeKept: false } },
      { accounts: { prime: true, primeKept: true } },
      { accounts: { prime: false, primeKept: false } },
    ]);
  });

  it('says when ccw primes them itself, or when one login has nothing to prime', async () => {
    const s = fakeSettings();
    await writeSwitch({ prime: true, hold: [6] });
    const ccw = contextFor(home, { deps: withCswap(), ctl: fakeCtl({ ...s.routes, 'GET /v1/state': stateIn('cswap') }) });
    expect(await accounts.run(['prime', 'on'], ccw.ctx), ccw.io.stderr).toBe(EXIT.ok);
    expect(ccw.io.stdout).toContain(
      'Note: ccw primes them itself; Jantar leaves them to ccw while it does. To have Jantar prime instead, put "prime": false in ccw\'s switch.json.',
    );

    await writeSwitch({ prime: true, dry_run: true });
    const single = contextFor(home, { deps: withCswap(), ctl: fakeCtl({ ...s.routes, 'GET /v1/state': stateIn('single') }) });
    expect(await accounts.run(['prime', 'on'], single.ctx), single.io.stderr).toBe(EXIT.ok);
    expect(single.io.stdout).toContain('Note: one Claude login has nothing to prime. It applies once cswap is set up.');
    expect(single.io.stdout).not.toContain('ccw');
  });

  it('with the daemon down, writes config.json', async () => {
    const { ctx, io } = contextFor(home, { deps: withCswap() });
    expect(await accounts.run(['prime', 'on', '--kept'], ctx), io.stderr).toBe(EXIT.ok);
    expect(io.stdout).toContain('Saved to config.json; the daemon picks it up when it starts.');
    const saved = JSON.parse(await readFile(join(home.jantarHome, 'config.json'), 'utf8')) as { version: number; accounts: Record<string, unknown> };
    expect(saved.version).toBe(2);
    expect(saved.accounts).toEqual({ kept: [], prime: true, primeKept: true });
  });

  it('refuses what it cannot read, and changes nothing', async () => {
    const s = fakeSettings();
    const ctl = fakeCtl(s.routes);
    for (const bad of [['prime', 'yes'], ['prime', 'on', 'now'], ['prime', 'off', '--kept'], ['prime', '--kept'], ['--kept'], ['keep', '3', '--kept'], ['prime', 'on', '--none']]) {
      const c = contextFor(home, { deps: withCswap(), ctl });
      expect(await accounts.run(bad, c.ctx), bad.join(' ')).toBe(EXIT.usage);
      expect(c.io.stderr).toContain('usage: jantar accounts');
    }
    expect(s.patches).toEqual([]);
  });

  it('accounts prime: the switch, who primes, and the last prime', async () => {
    const last = { account: 4, at: new Date(T0 - 12 * 60_000).toISOString(), ok: true };
    const s = fakeSettings({ accounts: { prime: true } });
    const ctl = fakeCtl({ ...s.routes, 'GET /healthz': health, 'GET /v1/state': stateIn('cswap', { by: 'jantar', running: null, last }) });
    const c = contextFor(home, { deps: withCswap(), ctl });
    expect(await accounts.run(['prime'], c.ctx), c.io.stderr).toBe(EXIT.ok);
    expect(c.io.stdout).toBe(`Free 5-hour windows: primed. ${RULE} Kept and held accounts are left out.\nLast prime: account 4, 12m ago, its window started.\n`);
    expect(ctl.calls.every((x) => x.method === 'GET')).toBe(true);

    const failed = fakeCtl({ ...s.routes, 'GET /v1/state': stateIn('cswap', { by: 'jantar', running: null, last: { ...last, ok: false } }) });
    const f = contextFor(home, { deps: withCswap(), ctl: failed });
    expect(await accounts.run(['prime'], f.ctx)).toBe(EXIT.ok);
    expect(f.io.stdout).toContain('Last prime: account 4, 12m ago, failed (tried again after 30 min).');
  });

  it('accounts: one line on priming, off by default; ccw priming named', async () => {
    const off = fakeSettings();
    const a = contextFor(home, { deps: withCswap(), ctl: fakeCtl({ ...off.routes, 'GET /healthz': health, 'GET /v1/state': stateIn('cswap') }) });
    expect(await accounts.run([], a.ctx), a.io.stderr).toBe(EXIT.ok);
    expect(a.io.stdout).toContain('Free 5-hour windows: not primed (jantar accounts prime on).');

    await writeSwitch({ prime: true });
    const b = contextFor(home, { deps: withCswap(), ctl: fakeCtl({ ...off.routes, 'GET /healthz': health, 'GET /v1/state': stateIn('cswap') }) });
    expect(await accounts.run([], b.ctx), b.io.stderr).toBe(EXIT.ok);
    expect(b.io.stdout).toContain('Free 5-hour windows: ccw primes them, so Jantar leaves them to ccw. To have Jantar prime instead, put "prime": false in ccw\'s switch.json.');

    // No "prime" key: ccw primes by default, as the installed ccw reads its file.
    await writeSwitch({ hold: [6] });
    const nokey = contextFor(home, { deps: withCswap(), ctl: fakeCtl({ ...off.routes, 'GET /healthz': health, 'GET /v1/state': stateIn('cswap') }) });
    expect(await accounts.run([], nokey.ctx), nokey.io.stderr).toBe(EXIT.ok);
    expect(nokey.io.stdout).toContain('Free 5-hour windows: ccw primes them, so Jantar leaves them to ccw.');

    // ccw's autoswitch off: ccw only says what it would prime, so Jantar's own switch counts.
    await writeSwitch({ prime: true, on: false });
    const on = fakeSettings({ accounts: { prime: true } });
    const c = contextFor(home, { deps: withCswap(), ctl: fakeCtl({ ...on.routes, 'GET /healthz': health, 'GET /v1/state': stateIn('cswap') }) });
    expect(await accounts.run([], c.ctx), c.io.stderr).toBe(EXIT.ok);
    expect(c.io.stdout).toContain(`Free 5-hour windows: primed. ${RULE} Kept and held accounts are left out.`);

    const d = contextFor(home, { deps: withCswap(), ctl: fakeCtl({ ...on.routes, 'GET /healthz': health, 'GET /v1/state': stateIn('single') }) });
    expect(await accounts.run([], d.ctx), d.io.stderr).toBe(EXIT.ok);
    expect(d.io.stdout).toContain('Free 5-hour windows: priming is on, but one Claude login has nothing to prime. It applies once cswap is set up.');
  });
});
