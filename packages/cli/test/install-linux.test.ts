/**
 * v0.6: `jantar install` / `uninstall` on a server, against a synthetic HOME:
 * the systemd user unit (exact text, with and without --read-only;
 * KillMode=process), systemctl and loginctl by absolute path through a fake
 * exec (never the real systemd), lingering refused, an old systemd, the
 * read-only choice kept across an update, the printed Windows task lines,
 * the LaunchAgent's --read-only, and the guard on the real unit's folder.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '@jantar/daemon';
import { onCommand } from '@jantar/daemon/core/testing';
import { linuxHome, makeFakeHome, writeHomeLayout, type FakeHome } from '@jantar/fixtures';
import install from '../src/commands/install.js';
import uninstall from '../src/commands/uninstall.js';
import { EXIT } from '../src/command.js';
import type { CtlClient } from '../src/ctl.js';
import { plistFor } from '../src/lib/launchd.js';
import { schtasksLines, schtasksText } from '../src/lib/service.js';
import { renderUnit, serviceIsReadOnly, unitFor, unitPath, writeUnit } from '../src/lib/systemd.js';
import { argsOf, contextFor, fakeCtl, fakePackages, ok, testDeps } from './helpers.js';

const SYSTEMCTL = '/usr/bin/systemctl';
const LOGINCTL = '/usr/bin/loginctl';

describe('the systemd unit', () => {
  it('is exact for a server, with and without --read-only', () => {
    const o = {
      nodePath: '/home/sam/.nvm/versions/node/v22.15.0/bin/node',
      daemonBin: '/home/sam/jantar/packages/daemon/bin/jantard.mjs',
      stdoutPath: '/home/sam/.jantar/logs/daemon.out.log',
      stderrPath: '/home/sam/.jantar/logs/daemon.err.log',
      env: { PATH: '/home/sam/.nvm/versions/node/v22.15.0/bin:/usr/local/bin:/usr/bin:/bin' },
    };
    expect(renderUnit(o)).toBe(
      [
        '[Unit]',
        'Description=Jantar (jantard)',
        'After=network-online.target',
        '',
        '[Service]',
        'ExecStart=/home/sam/.nvm/versions/node/v22.15.0/bin/node /home/sam/jantar/packages/daemon/bin/jantard.mjs',
        'Restart=always',
        'RestartSec=5',
        'KillMode=process',
        'Environment=PATH=/home/sam/.nvm/versions/node/v22.15.0/bin:/usr/local/bin:/usr/bin:/bin',
        'StandardOutput=append:/home/sam/.jantar/logs/daemon.out.log',
        'StandardError=append:/home/sam/.jantar/logs/daemon.err.log',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
    );
    const ro = renderUnit({ ...o, readOnly: true });
    expect(ro).toContain('ExecStart=/home/sam/.nvm/versions/node/v22.15.0/bin/node /home/sam/jantar/packages/daemon/bin/jantard.mjs --read-only\n');
    expect(serviceIsReadOnly(ro)).toBe(true);
    expect(serviceIsReadOnly(renderUnit(o))).toBe(false);
  });

  it('quotes a path with a space, doubles % and $, and refuses a relative path or a newline', () => {
    const unit = renderUnit({
      nodePath: '/opt/my node/bin/node',
      daemonBin: '/srv/jan$tar/100%/jantard.mjs',
      stdoutPath: '/srv/logs/out.log',
      stderrPath: '/srv/logs/err.log',
    });
    expect(unit).toContain('ExecStart="/opt/my node/bin/node" /srv/jan$$tar/100%%/jantard.mjs\n');
    expect(() => renderUnit({ nodePath: 'node', daemonBin: '/a', stdoutPath: '/b', stderrPath: '/c' })).toThrow(/absolute/);
    expect(() => renderUnit({ nodePath: '/a\nExecStartPre=/bin/sh', daemonBin: '/a', stdoutPath: '/b', stderrPath: '/c' })).toThrow(/control/);
  });

  it('pins a state dir that is not the default, as the LaunchAgent does', () => {
    const paths = resolvePaths({ env: { HOME: '/home/sam', JANTAR_HOME: '/srv/jantar' } });
    const unit = unitFor({ paths, nodePath: '/usr/bin/node', daemonBin: '/home/sam/jantar/packages/daemon/bin/jantard.mjs', env: { JANTAR_HOME: '/srv/jantar' } });
    expect(unit).toContain('Environment=PATH=/usr/bin:/usr/local/bin:/usr/bin:/bin\nEnvironment=JANTAR_HOME=/srv/jantar\n');
    expect(unit).toContain('StandardOutput=append:/srv/jantar/logs/daemon.out.log\n');
    expect(unitPath(paths)).toBe('/home/sam/.config/systemd/user/jantar.service');
    expect(unitPath(paths, { XDG_CONFIG_HOME: '/home/sam/cfg' })).toBe('/home/sam/cfg/systemd/user/jantar.service');
  });

  it("the guard refuses the real user's unit folder under a test runner", async () => {
    const real = join(userInfo().homedir, '.config', 'systemd', 'user', 'jantar.service');
    await expect(writeUnit(real, '[Unit]\n')).rejects.toThrow(/refusing to touch the systemd unit/);
  });
});

describe('the LaunchAgent with --read-only', () => {
  it('adds --read-only to the program arguments, after the daemon', () => {
    const paths = resolvePaths({ env: { HOME: '/Users/user' } });
    const xml = plistFor({ paths, nodePath: '/opt/node/bin/node', daemonBin: '/opt/jantar/packages/daemon/bin/jantard.mjs', env: {}, readOnly: true });
    expect(xml).toContain('    <string>/opt/jantar/packages/daemon/bin/jantard.mjs</string>\n    <string>--read-only</string>\n  </array>');
    expect(plistFor({ paths, nodePath: '/opt/node/bin/node', daemonBin: '/opt/jantar/packages/daemon/bin/jantard.mjs', env: {} })).not.toContain('--read-only');
  });
});

describe('the Windows task lines', () => {
  const win = {
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    daemonBin: 'C:\\Users\\sam\\jantar\\packages\\daemon\\bin\\jantard.mjs',
    env: {},
  };

  it('are exact, for cmd.exe', () => {
    expect(schtasksLines(win)).toEqual({
      tr: '\\"C:\\Program Files\\nodejs\\node.exe\\" \\"C:\\Users\\sam\\jantar\\packages\\daemon\\bin\\jantard.mjs\\" --log-files',
      create:
        'schtasks /Create /TN Jantar /SC ONLOGON /RL LIMITED /F /TR "\\"C:\\Program Files\\nodejs\\node.exe\\" \\"C:\\Users\\sam\\jantar\\packages\\daemon\\bin\\jantard.mjs\\" --log-files"',
      run: 'schtasks /Run /TN Jantar',
      end: 'schtasks /End /TN Jantar',
      remove: 'schtasks /Delete /TN Jantar /F',
    });
  });

  it('carry --read-only, a non-default state dir and another task name (the CI runs them as Jantar-CI-<run>)', () => {
    const l = schtasksLines({ ...win, env: { JANTAR_HOME: 'D:\\jantar' }, readOnly: true, task: 'Jantar-CI-42' });
    expect(l.create).toBe(
      'schtasks /Create /TN Jantar-CI-42 /SC ONLOGON /RL LIMITED /F /TR "\\"C:\\Program Files\\nodejs\\node.exe\\" \\"C:\\Users\\sam\\jantar\\packages\\daemon\\bin\\jantard.mjs\\" --log-files --home \\"D:\\jantar\\" --read-only"',
    );
    expect(l.run).toBe('schtasks /Run /TN Jantar-CI-42');
    expect(() => schtasksLines({ ...win, task: 'Jantar & calc' })).toThrow(/task name/);
    expect(() => schtasksLines({ ...win, nodePath: 'C:\\a"b\\node.exe' })).toThrow(/quote/);
  });
});

/** A server's fake home: Linux config dirs, and node.json (so roleOf says node). */
async function serverHome(): Promise<FakeHome> {
  const home = await makeFakeHome({ sessions: [] });
  await writeHomeLayout(home.home, linuxHome());
  await mkdir(join(home.jantarHome, 'node'), { recursive: true, mode: 0o700 });
  await writeFile(join(home.jantarHome, 'node', 'node.json'), '{}\n', { mode: 0o600 });
  return home;
}

describe('jantar install / uninstall on a Linux server (fake systemctl and loginctl)', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await serverHome();
  });
  afterEach(async () => {
    await home.cleanup();
  });

  async function setup(o: { linger?: number; systemd?: string; restart?: number } = {}) {
    const locations = await fakePackages(home.root);
    const daemon = { up: false };
    const deps = testDeps({
      platform: 'linux',
      uid: 1000,
      locations,
      handlers: [
        onCommand(SYSTEMCTL, { stdout: o.systemd ?? 'systemd 252 (252.22-1~deb12u1)\n+PAM +AUDIT\n' }, ['--version']),
        onCommand(SYSTEMCTL, (call) => {
          if (call.args[1] === 'restart') {
            if (o.restart) return { code: o.restart, stderr: 'Failed to connect to bus: No medium found\n' };
            daemon.up = true;
          }
          return { code: 0 };
        }, ['--user']),
        onCommand(LOGINCTL, () => (o.linger ? { code: o.linger, stderr: 'Could not enable linger: Access denied\n' } : { code: 0 }), ['enable-linger']),
      ],
    });
    const health = fakeCtl({ 'GET /healthz': ok({ ok: true, protocol: 3, daemonVersion: '0.6.0' }) });
    const ctl: CtlClient = {
      ...health,
      request: <T>(...a: Parameters<CtlClient['request']>) => (daemon.up ? health : fakeCtl({}, { down: true })).request<T>(...a),
    };
    const { ctx, io } = contextFor({ env: { ...home.env, USER: 'sam' } }, { deps, ctl });
    return { ctx, io, deps, daemon, locations, unit: unitPath(ctx.paths) };
  }

  it('writes the unit, starts it with systemctl --user, turns lingering on, and waits for the daemon', async () => {
    const { ctx, io, deps, unit, locations } = await setup();
    expect(await install.run(['--no-doctor'], ctx), io.stderr).toBe(EXIT.ok);
    const text = await readFile(unit, 'utf8');
    expect(text).toBe(unitFor({ paths: ctx.paths, nodePath: deps.nodePath, daemonBin: locations.daemonBin, env: ctx.io.env }));
    expect(text).toContain('KillMode=process\n');
    expect(text).toContain(`Environment=JANTAR_HOME=${home.jantarHome}\n`);
    expect((await stat(unit)).mode & 0o777).toBe(0o644);
    expect(argsOf(deps.exec.calls, SYSTEMCTL)).toEqual([
      ['--version'],
      ['--user', 'daemon-reload'],
      ['--user', 'enable', 'jantar.service'],
      ['--user', 'restart', 'jantar.service'],
    ]);
    expect(argsOf(deps.exec.calls, LOGINCTL)).toEqual([['enable-linger', 'sam']]);
    // Every program by absolute path.
    expect(deps.exec.calls.every((c) => c.file.startsWith('/'))).toBe(true);
    expect(io.stdout).toContain('Service: systemd user unit jantar.service, started. Lingering is on, so it keeps running after you log out.\n');
    expect(io.stdout).toContain('Daemon: jantard 0.6.0 is running.\n');
    expect(io.stdout).toContain('jantar node status');
    expect(io.stdout).not.toContain('jantar remote setup');
    // The hook client copy and the recorded node path, as on a Mac.
    expect(existsSync(join(home.jantarHome, 'bin', 'jantar-hook'))).toBe(true);
    expect(JSON.parse(await readFile(join(home.jantarHome, 'config.json'), 'utf8')).bins.node).toBe(deps.nodePath);
  });

  it('prints the sudo line when lingering is refused', async () => {
    const { ctx, io } = await setup({ linger: 1 });
    expect(await install.run(['--no-doctor'], ctx)).toBe(EXIT.ok);
    expect(io.stdout).toContain('Lingering is off, so it stops when you log out. Turn it on: sudo loginctl enable-linger sam\n');
  });

  it('refuses systemd older than 240 and writes no unit', async () => {
    const { ctx, io, unit } = await setup({ systemd: 'systemd 237\n' });
    expect(await install.run(['--no-doctor'], ctx)).toBe(EXIT.failed);
    expect(io.stderr).toContain('systemd 237 is older than 240');
    expect(existsSync(unit)).toBe(false);
  });

  it('says how to turn systemd on when systemctl --user fails (WSL without systemd)', async () => {
    const { ctx, io } = await setup({ restart: 1 });
    expect(await install.run(['--no-doctor'], ctx)).toBe(EXIT.failed);
    expect(io.stderr).toContain('Failed to connect to bus');
    expect(io.stderr).toContain('[boot] systemd=true in /etc/wsl.conf');
  });

  it('--read-only goes into ExecStart, and an update without the flag keeps it; --no-read-only drops it', async () => {
    const first = await setup();
    expect(await install.run(['--no-doctor', '--read-only'], first.ctx)).toBe(EXIT.ok);
    expect(await readFile(first.unit, 'utf8')).toMatch(/^ExecStart=.* --read-only$/m);
    expect(first.io.stdout).toContain('Read-only: the daemon runs with --read-only (watch only).');

    const update = await setup();
    expect(await install.run(['--no-doctor'], update.ctx)).toBe(EXIT.ok);
    expect(await readFile(update.unit, 'utf8')).toMatch(/^ExecStart=.* --read-only$/m);
    expect(update.io.stdout).toContain('Read-only: kept from the installed service');

    const widen = await setup();
    expect(await install.run(['--no-doctor', '--no-read-only'], widen.ctx)).toBe(EXIT.ok);
    expect(await readFile(widen.unit, 'utf8')).not.toContain('--read-only');
  });

  it('--print shows the unit and changes nothing; --no-start writes it without systemctl', async () => {
    const { ctx, io, deps, unit } = await setup();
    expect(await install.run(['--print', '--read-only'], ctx)).toBe(EXIT.ok);
    expect(io.stdout).toContain('KillMode=process');
    expect(io.stdout).toContain('--read-only');
    expect(io.stderr).toContain(`(not written; "jantar install" writes it to ${unit})`);
    expect(existsSync(unit)).toBe(false);
    expect(deps.exec.calls).toHaveLength(0);

    const quiet = await setup();
    expect(await install.run(['--no-start', '--no-doctor'], quiet.ctx)).toBe(EXIT.ok);
    expect(existsSync(unit)).toBe(true);
    expect(argsOf(quiet.deps.exec.calls, SYSTEMCTL)).toEqual([['--version']]);
    expect(quiet.io.stdout).toContain('Start it: systemctl --user enable --now jantar.service');
  });

  it('uninstall disables and stops the unit, removes it, and keeps the state dir', async () => {
    const { ctx, deps, unit } = await setup();
    expect(await install.run(['--no-doctor'], ctx)).toBe(EXIT.ok);
    const un = contextFor({ env: { ...home.env, USER: 'sam' } }, { deps });
    expect(await uninstall.run([], un.ctx)).toBe(EXIT.ok);
    expect(existsSync(unit)).toBe(false);
    expect(existsSync(home.jantarHome)).toBe(true);
    expect(argsOf(deps.exec.calls, SYSTEMCTL).slice(-2)).toEqual([
      ['--user', 'disable', '--now', 'jantar.service'],
      ['--user', 'daemon-reload'],
    ]);
    expect(un.io.stdout).toContain(`Service: removed ${unit}`);
  });

  it('uninstall is fine when no unit was ever installed', async () => {
    const locations = await fakePackages(home.root);
    const deps = testDeps({
      platform: 'linux',
      locations,
      handlers: [onCommand(SYSTEMCTL, { code: 5, stderr: 'Failed to disable unit: Unit file jantar.service does not exist.\n' })],
    });
    const { ctx, io } = contextFor({ env: home.env }, { deps });
    expect(await uninstall.run([], ctx)).toBe(EXIT.ok);
    expect(io.stdout).toContain('Daemon: was not installed\nService: not installed\n');
  });
});

describe('jantar install on a Windows server (preview: lines printed, nothing run)', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await serverHome();
  });
  afterEach(async () => {
    await home.cleanup();
  });

  it('prints the task lines to run in Command Prompt and runs nothing', async () => {
    const locations = await fakePackages(home.root);
    const deps = testDeps({ platform: 'win32', locations });
    const { ctx, io } = contextFor({ env: home.env }, { deps });
    expect(await install.run(['--no-doctor', '--read-only'], ctx), io.stderr).toBe(EXIT.ok);
    expect(deps.exec.calls).toHaveLength(0);
    expect(io.stdout).toContain(schtasksText(ctx, true));
    const l = schtasksLines({ nodePath: deps.nodePath, daemonBin: locations.daemonBin, env: home.env, readOnly: true });
    expect(io.stdout).toContain(`In Command Prompt (cmd.exe), run:\n  ${l.create}\n  ${l.run}\n`);
    expect(l.create).toContain('--log-files');
    expect(l.create).toContain('--read-only');
    expect(io.stdout).toContain(`To stop it, then remove it:\n  ${l.end}\n  ${l.remove}\n`);
  });

  it('as the windows-latest job runs it (no node.json, no flags): each line at a line start, exit 0, doctor left for later', async () => {
    const fresh = await makeFakeHome({ sessions: [] });
    try {
      const locations = await fakePackages(fresh.root);
      const deps = testDeps({ platform: 'win32', locations });
      const { ctx, io } = contextFor(fresh, { deps });
      expect(await install.run([], ctx), io.stderr).toBe(EXIT.ok);
      expect(deps.exec.calls).toHaveLength(0);
      expect(io.stderr).toContain('This machine has not joined a Mac yet: jantar node join <line from the Mac> pairs it and prints these lines too.\n');
      // What the job does: trim each printed line, find the one that starts with each verb.
      const printed = `${io.stdout}${io.stderr}`.split(/\r?\n/).map((x) => x.trim());
      for (const verb of ['Create', 'Run', 'End', 'Delete']) expect(printed.filter((x) => x.startsWith(`schtasks /${verb} `))).toHaveLength(1);
      expect(printed.find((x) => x.startsWith('schtasks /Create '))).toMatch(/\/SC ONLOGON .*\/TR ".*jantard.*--log-files.*"$/);
      // The daemon can't be up before the lines run: doctor is left for later, not failed.
      expect(io.stdout).not.toContain('Daemon:');
      expect(io.stdout).toContain('Then: jantar doctor, to see what this machine still needs.\n');
      expect(io.stdout).toContain('Next: jantar node join <line from jantar node pair at the Mac>\n');
      expect(io.stdout).not.toContain('jantar remote setup');
    } finally {
      await fresh.cleanup();
    }
  });

  it('notes a task command over the 261 characters schtasks takes', async () => {
    const long = `/synthetic/${'x'.repeat(240)}`;
    const deps = testDeps({ platform: 'win32', locations: { daemonBin: `${long}/jantard.mjs`, hookClient: '/synthetic/hook' } });
    const { ctx } = contextFor({ env: home.env }, { deps });
    expect(schtasksText(ctx, false)).toMatch(/takes 261 at most: move the repository to a shorter path/);
  });
});

describe('jantar install on Linux before joining a Mac', () => {
  it('refuses: the hub is a Mac, and a server gets its service from jantar node join', async () => {
    const home = await makeFakeHome({ sessions: [] });
    try {
      const deps = testDeps({ platform: 'linux', locations: await fakePackages(home.root) });
      const { ctx, io } = contextFor(home, { deps });
      expect(await install.run([], ctx)).toBe(EXIT.failed);
      expect(io.stderr).toContain('jantar node join');
      expect(deps.exec.calls).toHaveLength(0);
    } finally {
      await home.cleanup();
    }
  });
});
