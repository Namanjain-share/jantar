/**
 * jantar accounts (spec 3.10): the accounts mode, the kept accounts
 * (accounts.kept, synthetic numbers only) and ccw's live hold list, against
 * an in-memory daemon and with the daemon down (config.json on a synthetic
 * HOME, migrated from version 1 first).
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import { NO_FEATURES, PROTOCOL_VERSION, emptyState, type AccountsMode } from '@jantar/protocol';
import accounts from '../src/commands/accounts.js';
import { EXIT } from '../src/command.js';
import { main, memoryIo } from '../src/index.js';
import { contextFor, fail, fakeCtl, fakeSettings, ok, testDeps } from './helpers.js';

/** GET /v1/state as a daemon in `mode` answers it. */
function stateIn(mode: AccountsMode) {
  const state = emptyState();
  state.daemon = { protocol: PROTOCOL_VERSION, daemonVersion: '0.4.0', webHash: null, features: { ...NO_FEATURES }, accountsMode: mode };
  return ok({ seq: 1, epoch: 'e1', state });
}

const health = ok({ ok: true, protocol: PROTOCOL_VERSION, daemonVersion: '0.4.0' });

describe('jantar accounts', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
  });
  afterEach(async () => {
    await home.cleanup();
  });

  const withCswap = () => testDeps({ bins: { cswap: home.bins.cswap } });

  it('daemon down, no cswap: single mode, nothing kept, ccw optional', async () => {
    await rm(home.paths.cswapRoot, { recursive: true, force: true });
    const { ctx, io } = contextFor(home, { deps: testDeps({ bins: { cswap: null } }) });
    expect(await accounts.run([], ctx), io.stderr).toBe(EXIT.ok);
    expect(io.stdout).toContain('Accounts: single, one Claude login (no cswap; decided when the daemon starts).');
    expect(io.stdout).toContain('Usage and account moves need cswap (optional).');
    // Nothing to keep with one login: no "accounts keep" hint.
    expect(io.stdout).toContain('Kept for other work: none (with one login there is nothing to keep).');
    expect(io.stdout).not.toContain('accounts keep');
    expect(io.stdout).toContain('ccw: no hold list (ccw is optional; its switch.json is read only when it exists).');
    expect(io.stdout).toContain('No config.json yet');
  });

  it('a configured cswap that cannot run counts as none, as the daemon sees it', async () => {
    await writeFile(join(home.jantarHome, 'config.json'), JSON.stringify({ version: 2, bins: { cswap: join(home.root, 'not-installed', 'cswap') } }), { mode: 0o600 });
    const { ctx, io } = contextFor(home, { deps: withCswap() });
    expect(await accounts.run([], ctx), io.stderr).toBe(EXIT.ok);
    expect(io.stdout).toContain('Accounts: single, one Claude login (no cswap; decided when the daemon starts).');
  });

  it("the running daemon's mode, the kept accounts, autoswitch's hold and ccw's live hold list", async () => {
    await mkdir(home.paths.ccwDir, { recursive: true });
    await writeFile(join(home.paths.ccwDir, 'switch.json'), JSON.stringify({ on: false, hold: [6, 2] }));
    const s = fakeSettings({ accounts: { kept: [4, 7] }, autoswitch: { hold: [9] } });
    const ctl = fakeCtl({ ...s.routes, 'GET /healthz': health, 'GET /v1/state': stateIn('cswap') });
    const { ctx, io } = contextFor(home, { deps: withCswap(), ctl });
    expect(await accounts.run([], ctx), io.stderr).toBe(EXIT.ok);
    expect(io.stdout).toMatch(/^Accounts: cswap, \d+ accounts \(cswap at .+, the running daemon\)\.$/m);
    expect(io.stdout).toContain('Kept for other work: 4, 7. Auto, Rewrite and Ask Claude never pick them; a manual start still can, after a confirm.');
    expect(io.stdout).toContain('Held by autoswitch: 9');
    expect(io.stdout).toContain("ccw's hold list (read live): 6, 2");
    expect(ctl.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('says single when the daemon decided single, even with cswap here (JANTAR_ACCOUNTS=single)', async () => {
    const s = fakeSettings({ accounts: { kept: [4] } });
    const ctl = fakeCtl({ ...s.routes, 'GET /healthz': health, 'GET /v1/state': stateIn('single') });
    const env = { ...home.env, JANTAR_ACCOUNTS: 'single' };
    const { ctx, io } = contextFor({ env }, { deps: withCswap(), ctl });
    expect(await accounts.run([], ctx), io.stderr).toBe(EXIT.ok);
    expect(io.stdout).toContain('Accounts: single, one Claude login (JANTAR_ACCOUNTS=single; the running daemon).');
    expect(io.stdout).toContain('Kept for other work: 4. They apply once cswap is set up.');
    expect(io.stdout).not.toContain('never pick them');
  });

  it('keep with one login: no "cswap has no account" note, and the list waits for cswap', async () => {
    const s = fakeSettings();
    const ctl = fakeCtl({
      ...s.routes,
      'GET /healthz': health,
      'GET /v1/state': stateIn('single'),
      'GET /v1/accounts': ok({ accounts: [{ id: 0 }], activeAccount: 0, fetchedAt: null, source: 'cache' }),
    });
    const { ctx, io } = contextFor(home, { deps: withCswap(), ctl });
    expect(await accounts.run(['keep', '3'], ctx), io.stderr).toBe(EXIT.ok);
    expect(s.settings.accounts.kept).toEqual([3]);
    expect(io.stdout).toBe('Kept for other work: 3. They apply once cswap is set up.\n');
    expect(ctl.calls.some((c) => c.path === '/v1/accounts')).toBe(false);
  });

  it('refuses a daemon of another version (v0.3 has no accounts setting), as init does, and changes nothing', async () => {
    // What a protocol-2 daemon answers: version-1 settings, no "accounts".
    const v1 = { version: 1, launch: { mode: 'cs-shell' }, autoswitch: { hold: [] } };
    const old = fakeCtl({
      'GET /healthz': ok({ ok: true, protocol: 2, daemonVersion: '0.3.0' }),
      'GET /v1/settings': ok({ settings: v1 }),
      'PATCH /v1/settings': fail('invalid_request', 'unknown setting: accounts', 400),
    });
    for (const argv of [[], ['keep', '3'], ['keep', '--none']]) {
      const { ctx, io } = contextFor(home, { deps: withCswap(), ctl: old });
      expect(await accounts.run(argv, ctx), argv.join(' ')).toBe(EXIT.failed);
      expect(io.stderr).toContain('jantar accounts: a Jantar daemon of another version (0.3.0, protocol 2) is running for');
      expect(io.stderr).toContain('Stop it first, or point JANTAR_HOME at a new folder.');
      expect(io.stdout).toBe('');
    }
    expect(old.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /healthz', 'GET /healthz', 'GET /healthz']);
  });

  it('keep sets the list (sorted, once each) through the daemon, and --none clears it', async () => {
    const s = fakeSettings();
    const ctl = fakeCtl({
      ...s.routes,
      'GET /healthz': health,
      'GET /v1/state': stateIn('cswap'),
      'GET /v1/accounts': ok({ accounts: [1, 2, 3, 4, 7].map((id) => ({ id })), activeAccount: 1, fetchedAt: null, source: 'cache' }),
    });
    const keep = contextFor(home, { deps: withCswap(), ctl });
    expect(await accounts.run(['keep', '7', '4', '7'], keep.ctx), keep.io.stderr).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ accounts: { kept: [4, 7] } }]);
    expect(keep.io.stdout).toBe('Kept for other work: 4, 7. Auto, Rewrite and Ask Claude never pick them; a manual start still can, after a confirm.\n');

    const unknown = contextFor(home, { deps: withCswap(), ctl });
    expect(await accounts.run(['keep', '4', '12'], unknown.ctx)).toBe(EXIT.ok);
    expect(unknown.io.stdout).toContain('Note: cswap has no account 12 right now; kept anyway.');
    expect(s.settings.accounts.kept).toEqual([4, 12]);

    const none = contextFor(home, { deps: withCswap(), ctl });
    expect(await accounts.run(['keep', '--none'], none.ctx)).toBe(EXIT.ok);
    expect(none.io.stdout).toBe('No account is kept for other work.\n');
    expect(s.settings.accounts.kept).toEqual([]);
  });

  it('refuses what it cannot read, and changes nothing', async () => {
    const s = fakeSettings({ accounts: { kept: [4] } });
    const ctl = fakeCtl(s.routes);
    for (const bad of [['keep'], ['keep', 'x'], ['keep', '-1'], ['keep', '2.5'], ['keep', '3', '--none'], ['--none'], ['hold', '3'], ['keep', ...Array.from({ length: 51 }, (_, i) => String(i))]]) {
      const c = contextFor(home, { deps: withCswap(), ctl });
      expect(await accounts.run(bad, c.ctx), bad.join(' ')).toBe(EXIT.usage);
      expect(c.io.stderr).toContain('usage: jantar accounts');
    }
    expect(s.patches).toEqual([]);
    expect(s.settings.accounts.kept).toEqual([4]);
  });

  it('with the daemon down, keep writes config.json after migrating a v0.3 file (config.json.v1 kept)', async () => {
    const path = join(home.jantarHome, 'config.json');
    const v1 = `${JSON.stringify({ version: 1, launch: { mode: 'cs-shell' } }, null, 2)}\n`;
    await writeFile(path, v1, { mode: 0o600 });
    const { ctx, io } = contextFor(home, { deps: withCswap() });
    expect(await accounts.run(['keep', '4', '7'], ctx), io.stderr).toBe(EXIT.ok);
    expect(io.stdout).toContain('Kept for other work: 4, 7.');
    expect(io.stdout).toContain('Saved to config.json; the daemon picks it up when it starts.');
    const saved = JSON.parse(await readFile(path, 'utf8')) as { version: number; accounts: { kept: number[] }; launch: { mode: string } };
    expect(saved.version).toBe(2);
    expect(saved.accounts.kept).toEqual([4, 7]);
    expect(saved.launch.mode).toBe('cs-shell');
    expect(await readFile(`${path}.v1`, 'utf8')).toBe(v1);
  });

  it('is a real command now: help names keep and prime', async () => {
    const io = memoryIo(home.env);
    expect(await main(['accounts', '--help'], { io })).toBe(EXIT.ok);
    expect(io.stdout).toContain('usage: jantar accounts [keep <n...>|keep --none|prime [on|off] [--kept]]');
    expect(io.stdout).toContain('accounts keep --none');
    expect(io.stdout).toContain('accounts prime on --kept');
  });
});
