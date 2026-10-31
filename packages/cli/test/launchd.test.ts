/**
 * install / uninstall and the plist, against a synthetic HOME. launchctl is a
 * fake exec handler: nothing here loads or unloads a real LaunchAgent.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '@jantar/daemon';
import { onCommand } from '@jantar/daemon/core/testing';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import { LAUNCHD_LABEL } from '@jantar/protocol';
import install from '../src/commands/install.js';
import uninstall, { purgeTargetOk } from '../src/commands/uninstall.js';
import { CtlUnavailableError, type CtlClient } from '../src/ctl.js';
import { EXIT } from '../src/command.js';
import { memoryIo } from '../src/io.js';
import { LAUNCHCTL, isNotLoaded, plistFor, plistPath, renderPlist, xmlEscape } from '../src/lib/launchd.js';
import { argsOf, contextFor, fakePackages, testDeps } from './helpers.js';

const BASE = {
  nodePath: '/opt/synthetic/node/bin/node',
  daemonBin: '/opt/synthetic/repo/packages/daemon/bin/jantard.mjs',
  workingDirectory: '/Users/you/.jantar',
  stdoutPath: '/Users/you/.jantar/logs/daemon.out.log',
  stderrPath: '/Users/you/.jantar/logs/daemon.err.log',
};

describe('renderPlist', () => {
  it('runs the daemon by absolute node path with KeepAlive in the GUI session', () => {
    const xml = renderPlist({ ...BASE, env: { PATH: '/usr/bin:/bin', JANTAR_HOME: '/Users/you/state' } });
    expect(xml).toContain(`<key>Label</key>\n  <string>${LAUNCHD_LABEL}</string>`);
    expect(xml).toContain(`<array>\n    <string>${BASE.nodePath}</string>\n    <string>${BASE.daemonBin}</string>\n  </array>`);
    expect(xml).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(xml).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(xml).toContain('<key>LimitLoadToSessionType</key>\n  <string>Aqua</string>');
    expect(xml).toContain(`<key>StandardErrorPath</key>\n  <string>${BASE.stderrPath}</string>`);
    // env keys are sorted
    expect(xml.indexOf('<key>JANTAR_HOME</key>')).toBeLessThan(xml.indexOf('<key>PATH</key>'));
    expect(xml).not.toMatch(/com\.[a-z]+\.ccw/);
  });

  it('escapes XML and refuses relative paths or odd labels', () => {
    expect(xmlEscape(`a&b<c>"d"'e'`)).toBe('a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;');
    const xml = renderPlist({ ...BASE, workingDirectory: '/Users/you/A & B <x>' });
    expect(xml).toContain('<string>/Users/you/A &amp; B &lt;x&gt;</string>');
    expect(() => renderPlist({ ...BASE, nodePath: 'node' })).toThrow(/absolute/);
    expect(() => renderPlist({ ...BASE, label: 'bad label' })).toThrow(/label/);
    expect(() => renderPlist({ ...BASE, env: { 'BAD-NAME': 'x' } })).toThrow(/variable name/);
  });

  it.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/plutil'))('is a valid property list (plutil -lint)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jantar-test-plist-'));
    try {
      const file = join(dir, 'agent.plist');
      await writeFile(file, renderPlist({ ...BASE, env: { PATH: '/usr/bin', JANTAR_HOME: '/a & b' } }));
      expect(execFileSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' })).toMatch(/OK/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('pins only non-default locations in the environment', () => {
    const paths = resolvePaths({ env: { HOME: '/Users/you' } });
    const plain = plistFor({ paths, nodePath: BASE.nodePath, daemonBin: BASE.daemonBin, env: { HOME: '/Users/you' } });
    expect(plain).not.toContain('JANTAR_HOME');
    expect(plain).toContain('<string>/opt/synthetic/node/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>');
    const custom = plistFor({ paths, nodePath: BASE.nodePath, daemonBin: BASE.daemonBin, env: { HOME: '/Users/you', JANTAR_HOME: '/Users/you/s' } });
    expect(custom).toContain('<key>JANTAR_HOME</key>\n    <string>/Users/you/s</string>');
    // A state dir the old CCW_V2_HOME names is pinned under the new name.
    const legacy = plistFor({ paths, nodePath: BASE.nodePath, daemonBin: BASE.daemonBin, env: { HOME: '/Users/you', CCW_V2_HOME: '/Users/you/old' } });
    expect(legacy).toContain('<key>JANTAR_HOME</key>\n    <string>/Users/you/old</string>');
    expect(legacy).not.toContain('CCW_V2_HOME');
  });

  it('knows launchctl\'s "not loaded" answers', () => {
    const r = { code: 113, signal: null, stdout: '', stderr: 'Could not find service', timedOut: false, truncated: false, durationMs: 1 };
    expect(isNotLoaded(r)).toBe(true);
    expect(isNotLoaded({ ...r, code: 5, stderr: 'Input/output error' })).toBe(false);
  });
});

/** A control socket that comes up once launchctl bootstrap ran. */
function bootingCtl(state: { up: boolean }): CtlClient {
  return {
    socketPath: '/synthetic/ctl.sock',
    async request<T>(method: string, path: string) {
      if (!state.up) throw new CtlUnavailableError('/synthetic/ctl.sock', 'ENOENT');
      if (method === 'GET' && path === '/healthz') return { status: 200, body: { ok: true, protocol: 1, daemonVersion: '0.1.0' } as T };
      return { status: 404, body: { error: { code: 'not_found', message: 'x' } } };
    },
    async bytes() {
      if (!state.up) throw new CtlUnavailableError('/synthetic/ctl.sock', 'ENOENT');
      return { status: 404, type: 'application/json', body: Buffer.from('{"error":{"code":"not_found","message":"x"}}') };
    },
  };
}

describe('jantar install / uninstall (synthetic HOME, fake launchctl)', () => {
  let home: FakeHome;
  let settingsBefore: string;

  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
    settingsBefore = await readFile(home.paths.claudeSettings, 'utf8');
  });
  afterEach(async () => {
    // Claude's settings are never touched by install or uninstall.
    expect(await readFile(home.paths.claudeSettings, 'utf8')).toBe(settingsBefore);
    await home.cleanup();
  });

  async function setup(launchctl: Parameters<typeof onCommand>[1] = { code: 0 }) {
    const locations = await fakePackages(home.root);
    const daemon = { up: false };
    const deps = testDeps({
      locations,
      handlers: [
        onCommand(LAUNCHCTL, (call) => {
          if (call.args[0] === 'bootstrap') daemon.up = true;
          return typeof launchctl === 'function' ? launchctl(call) : launchctl;
        }),
      ],
    });
    const { ctx, io } = contextFor(home, { deps, ctl: bootingCtl(daemon) });
    return { ctx, io, deps, daemon, locations, plist: plistPath(ctx.paths) };
  }

  it('--print shows the plist and changes nothing', async () => {
    const { ctx, io, deps, plist } = await setup();
    expect(await install.run(['--print'], ctx)).toBe(EXIT.ok);
    expect(io.stdout).toContain('<key>Label</key>');
    expect(io.stdout).toContain(deps.nodePath);
    expect(io.stdout).toContain(`<string>${home.jantarHome}</string>`);
    expect(deps.exec.calls).toHaveLength(0);
    expect(existsSync(plist)).toBe(false);
    expect(existsSync(join(home.jantarHome, 'config.json'))).toBe(false);
  });

  it('writes the plist, records binaries, copies the hook client and loads the agent', async () => {
    const { ctx, io, deps, plist, locations } = await setup();
    expect(await install.run(['--no-doctor'], ctx)).toBe(EXIT.ok);

    const xml = await readFile(plist, 'utf8');
    expect(xml).toContain(`<string>${deps.nodePath}</string>`);
    expect(xml).toContain(`<string>${locations.daemonBin}</string>`);
    expect(xml).toContain(`<key>JANTAR_HOME</key>\n    <string>${home.jantarHome}</string>`);
    expect((await stat(plist)).mode & 0o777).toBe(0o644);

    expect(argsOf(deps.exec.calls, LAUNCHCTL)).toEqual([
      ['bootout', `gui/501/${LAUNCHD_LABEL}`],
      ['bootstrap', 'gui/501', plist],
    ]);
    // launchctl is the only program install runs
    expect(deps.exec.calls.every((c) => c.file === LAUNCHCTL)).toBe(true);

    expect((await stat(home.jantarHome)).mode & 0o777).toBe(0o700);
    const config = JSON.parse(await readFile(join(home.jantarHome, 'config.json'), 'utf8'));
    expect(config.bins.node).toBe(deps.nodePath);
    expect(config.bins.cswap).toBe(home.bins.cswap);
    expect(config.bins.osascript).toBe(home.bins.osascript);
    expect(config.autoswitch.on).toBe(false);
    expect((await stat(join(home.jantarHome, 'config.json'))).mode & 0o777).toBe(0o600);

    const hookBin = join(home.jantarHome, 'bin', 'jantar-hook');
    expect(await readFile(hookBin, 'utf8')).toBe(await readFile(locations.hookClient, 'utf8'));
    expect((await stat(hookBin)).mode & 0o777).toBe(0o700);

    expect(io.stdout).toContain('Daemon: jantard 0.1.0 is running.');
    expect(io.stdout).toContain('jantar hooks install');
  });

  it('is idempotent and treats "not loaded" from bootout as fine', async () => {
    const { ctx, deps } = await setup((call) => (call.args[0] === 'bootout' ? { code: 113, stderr: 'Could not find service' } : { code: 0 }));
    expect(await install.run(['--no-doctor'], ctx)).toBe(EXIT.ok);
    const second = contextFor(home, { deps, ctl: ctx.ctl });
    expect(await install.run(['--no-doctor'], second.ctx)).toBe(EXIT.ok);
    expect(second.io.stdout).toContain('(unchanged)');
    expect(argsOf(deps.exec.calls, LAUNCHCTL).filter((a) => a[0] === 'bootstrap')).toHaveLength(2);
  });

  it('reports a failed bootstrap', async () => {
    const { ctx, io } = await setup((call) => (call.args[0] === 'bootstrap' ? { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' } : { code: 0 }));
    expect(await install.run(['--no-doctor'], ctx)).toBe(EXIT.failed);
    expect(io.stderr).toContain('Bootstrap failed');
  });

  it('--no-start writes files without calling launchctl', async () => {
    const { ctx, deps, plist } = await setup();
    expect(await install.run(['--no-start', '--no-doctor'], ctx)).toBe(EXIT.ok);
    expect(existsSync(plist)).toBe(true);
    expect(deps.exec.calls).toHaveLength(0);
  });

  it('refuses off macOS and when the daemon is not built', async () => {
    const { ctx } = await setup();
    const linux = contextFor(home, { deps: { ...testDeps({ locations: ctx.deps.locations }), platform: 'linux' } });
    expect(await install.run([], linux.ctx)).toBe(EXIT.failed);
    expect(linux.io.stderr).toContain('macOS LaunchAgent');

    const unbuilt = contextFor(home, {
      deps: testDeps({ locations: { daemonBin: join(home.root, 'nowhere', 'bin', 'jantard.mjs'), hookClient: ctx.deps.locations.hookClient } }),
    });
    expect(await install.run([], unbuilt.ctx)).toBe(EXIT.failed);
    expect(unbuilt.io.stderr).toContain('not built');
    expect(existsSync(plistPath(ctx.paths))).toBe(false);
  });

  it("refuses while ccw-v2's LaunchAgent is installed, and writes nothing", async () => {
    const { ctx, io, deps, plist } = await setup();
    const agents = join(home.home, 'Library', 'LaunchAgents');
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, 'dev.ccw-v2.daemon.plist'), '<plist/>\n');
    expect(await install.run(['--no-doctor'], ctx)).toBe(EXIT.failed);
    expect(io.stderr).toContain(`jantar install: ccw-v2's daemon is still installed (${join(agents, 'dev.ccw-v2.daemon.plist')}) and holds the port. Run ccw-v2 uninstall first`);
    expect(deps.exec.calls).toHaveLength(0);
    expect(existsSync(plist)).toBe(false);
  });

  it('install runs doctor at the end', async () => {
    const { ctx, io } = await setup();
    const code = await install.run([], ctx);
    expect(io.stdout).toContain('jantar doctor');
    expect([EXIT.ok, EXIT.failed]).toContain(code);
  });

  it('uninstall unloads and removes the agent but keeps the state dir', async () => {
    const { ctx, deps, plist } = await setup();
    expect(await install.run(['--no-doctor'], ctx)).toBe(EXIT.ok);
    const un = contextFor(home, { deps });
    expect(await uninstall.run([], un.ctx)).toBe(EXIT.ok);
    expect(existsSync(plist)).toBe(false);
    expect(existsSync(home.jantarHome)).toBe(true);
    expect(argsOf(deps.exec.calls, LAUNCHCTL).at(-1)).toEqual(['bootout', `gui/501/${LAUNCHD_LABEL}`]);
    expect(un.io.stdout).toContain('Kept');
  });

  it('uninstall --purge asks (or needs --yes) and deletes only the state dir', async () => {
    const { ctx, deps } = await setup();
    expect(await install.run(['--no-doctor'], ctx)).toBe(EXIT.ok);

    const noTty = contextFor(home, { deps });
    expect(await uninstall.run(['--purge'], noTty.ctx)).toBe(EXIT.failed);
    expect(existsSync(home.jantarHome)).toBe(true);

    const no = contextFor(home, { deps, ioOptions: { answers: ['n'] } });
    expect(await uninstall.run(['--purge'], no.ctx)).toBe(EXIT.ok);
    expect(existsSync(home.jantarHome)).toBe(true);

    const yes = contextFor(home, { deps, ioOptions: { answers: ['y'] } });
    expect(await uninstall.run(['--purge'], yes.ctx)).toBe(EXIT.ok);
    expect(yes.io.questions[0]).toContain(home.jantarHome);
    expect(existsSync(home.jantarHome)).toBe(false);
    expect(existsSync(home.home)).toBe(true);
  });

  it('uninstall --purge refuses while Claude hooks still call the hook client', async () => {
    const { ctx, deps } = await setup();
    expect(await install.run(['--no-doctor'], ctx)).toBe(EXIT.ok);
    // A synthetic settings file that mentions the installed hook client (restored afterwards).
    const hookBin = join(home.jantarHome, 'bin', 'jantar-hook');
    const s = JSON.parse(settingsBefore);
    s.hooks.Stop = [{ hooks: [{ type: 'command', command: `"/opt/node" "${hookBin}"`, async: true }] }];
    await writeFile(home.paths.claudeSettings, JSON.stringify(s));
    try {
      const un = contextFor(home, { deps });
      expect(await uninstall.run(['--purge', '--yes'], un.ctx)).toBe(EXIT.failed);
      expect(un.io.stderr).toContain('hooks uninstall --apply');
      expect(existsSync(home.jantarHome)).toBe(true);

      const plain = contextFor(home, { deps });
      expect(await uninstall.run([], plain.ctx)).toBe(EXIT.ok);
      expect(plain.io.stdout).toContain('hooks still point at');

      const forced = contextFor(home, { deps });
      expect(await uninstall.run(['--purge', '--yes', '--force'], forced.ctx)).toBe(EXIT.ok);
      expect(existsSync(home.jantarHome)).toBe(false);
    } finally {
      await writeFile(home.paths.claudeSettings, settingsBefore);
    }
  });

  it('only ever purges a directory that is clearly Jantar state', () => {
    const io = memoryIo({});
    const p = (home: string, userHome = '/Users/you') => resolvePaths({ env: {}, home, userHome });
    expect(purgeTargetOk({ io, paths: p('/Users/you/.jantar') }).ok).toBe(true);
    expect(purgeTargetOk({ io, paths: p('/Users/you') }).ok).toBe(false);
    expect(purgeTargetOk({ io, paths: p('/') }).ok).toBe(false);
    expect(purgeTargetOk({ io, paths: p('/Users') }).ok).toBe(false);
    expect(purgeTargetOk({ io, paths: p('/Users/you/Documents') }).ok).toBe(false);
    expect(purgeTargetOk({ io: memoryIo({ JANTAR_HOME: '/srv/state' }), paths: p('/srv/state') }).ok).toBe(true);
    // The old CCW_V2_HOME never makes a folder purgeable: it may be ccw-v2's own.
    expect(purgeTargetOk({ io: memoryIo({ CCW_V2_HOME: '/Users/you/.ccw-v2' }), paths: p('/Users/you/.ccw-v2') }).ok).toBe(false);
  });
});
