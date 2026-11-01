/**
 * v0.6: `jantar doctor` with Fleet, on a synthetic HOME with a fake exec (no
 * real pmset, tmux, ps, loginctl, systeminfo or claude ever runs). On the
 * Mac: the front door servers dial (one credential-less probe), a quick
 * tunnel refused, the Tailscale grant, and sleep on power. On a server: its
 * link, WSL1 and WSL2, tmux 3.1, procps, lingering, virtualization and
 * Claude 2.1.300 on Windows, and the hooks in each config dir.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onCommand, type ExecHandler } from '@jantar/daemon/core/testing';
import { FLEET_HUB_URL, linuxHome, makeFakeHome, writeHomeLayout, type FakeHome } from '@jantar/fixtures';
import type { NodeFile } from '@jantar/daemon';
import { doctorReport } from '../src/commands/doctor.js';
import {
  closeFix,
  closeWords,
  fleetDoor,
  nodeOsOf,
  parseAcSleep,
  parseTmuxVersion,
  psKind,
  systeminfoVirtualization,
  wslKind,
  type CtlStatusView,
  type DoctorCheck,
  type DoctorInput,
  type DoctorReport,
  type ProbeResult,
} from '../src/lib/doctor.js';
import { defaultSettings, applySettingsPatch, type Settings } from '@jantar/protocol';
import { contextFor, fakeCtl, fakePackages, ok, testDeps } from './helpers.js';

const PMSET = '/usr/bin/pmset';
const TMUX = '/usr/bin/tmux';
const PS = '/usr/bin/ps';
const LOGINCTL = '/usr/bin/loginctl';
const CLAUDE_WIN = 'C:\\Users\\sam\\.local\\bin\\claude.exe';
const SYSTEMINFO = 'C:\\Windows\\System32\\systeminfo.exe';

const PMSET_CUSTOM = (ac: number) =>
  ['Battery Power:', ' lidwake              1', ' sleep                1', ' displaysleep         2', 'AC Power:', ' lidwake              1', ` sleep                ${ac}`, ' displaysleep         10', ''].join('\n');

function check(r: DoctorReport, id: string): DoctorCheck {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id} in ${r.checks.map((x) => x.id).join(', ')}`);
  return c;
}

function settingsWith(patch: Record<string, unknown>): Settings {
  const r = applySettingsPatch(defaultSettings(), patch);
  if (!r.ok) throw new Error(r.error);
  return r.settings;
}

describe('the Fleet parsers', () => {
  it('reads AC sleep from pmset -g custom (and a desktop Mac with no battery)', () => {
    expect(parseAcSleep(PMSET_CUSTOM(10))).toBe(10);
    expect(parseAcSleep(PMSET_CUSTOM(0))).toBe(0);
    expect(parseAcSleep('AC Power:\n sleep                0 (sleep prevented by powerd)\n')).toBe(0);
    expect(parseAcSleep('nothing here\n')).toBeNull();
  });

  it('tells WSL1 from WSL2 and the OS a server reports', () => {
    expect(wslKind('5.15.153.1-microsoft-standard-WSL2\n')).toBe('wsl2');
    expect(wslKind('4.4.0-19041-Microsoft\n')).toBe('wsl1');
    expect(wslKind('6.1.0-18-amd64\n')).toBeNull();
    expect(wslKind(null)).toBeNull();
    expect(nodeOsOf('linux', '5.15.153.1-microsoft-standard-WSL2')).toBe('wsl');
    expect(nodeOsOf('linux', '6.1.0-18-amd64')).toBe('linux');
    expect(nodeOsOf('win32', null)).toBe('windows');
    expect(nodeOsOf('darwin', null)).toBe('macos');
  });

  it('reads tmux, ps and systeminfo', () => {
    expect(parseTmuxVersion('tmux 3.3a')).toEqual([3, 3]);
    expect(parseTmuxVersion('tmux next-3.4')).toEqual([3, 4]);
    expect(parseTmuxVersion('tmux master')).toBeNull();
    expect(psKind('ps from procps-ng 3.3.17')).toBe('procps');
    expect(psKind("ps: unrecognized option: version\nBusyBox v1.36.1 (2024-06-10) multi-call binary.")).toBe('busybox');
    expect(systeminfoVirtualization('Hyper-V Requirements:      A hypervisor has been detected. Features required for Hyper-V will not be displayed.')).toBe('hypervisor');
    expect(systeminfoVirtualization('Hyper-V Requirements:      VM Monitor Mode Extensions: Yes\n                           Virtualization Enabled In Firmware: No')).toBe('off');
    expect(systeminfoVirtualization('Virtualization Enabled In Firmware: Yes')).toBe('on');
    expect(systeminfoVirtualization('')).toBeNull();
  });

  it('refuses every door servers cannot keep using', () => {
    const door = (remote: Record<string, unknown>) => fleetDoor(settingsWith({ remote }));
    expect(door({})).toEqual({ ok: false, why: 'it is loopback only' });
    expect(door({ mode: 'lan' })).toMatchObject({ ok: false });
    expect(door({ mode: 'cloudflare', publicUrl: null })).toEqual({ ok: false, why: 'no public address is set' });
    expect(door({ mode: 'cloudflare', publicUrl: 'http://jantar.example.com' })).toEqual({ ok: false, why: 'its address is not https' });
    expect(door({ mode: 'cloudflare', publicUrl: 'https://quiet-river-1234.trycloudflare.com' })).toMatchObject({ ok: false, why: expect.stringContaining('quick tunnel') });
    expect(door({ mode: 'cloudflare', publicUrl: FLEET_HUB_URL })).toEqual({ ok: true, url: FLEET_HUB_URL, host: 'jantar.example.com', kind: 'cloudflare' });
    expect(door({ mode: 'tailscale', publicUrl: 'https://mac.tailnet-0000.ts.net' })).toMatchObject({ ok: true, kind: 'tailscale' });
  });

  it('names close codes and what to do about them', () => {
    expect(closeWords(403)).toBe('Cloudflare Access refused the connection (403): the service token may have expired or been revoked');
    expect(closeWords(4401)).toBe('removed from the hub (4401)');
    expect(closeWords(1006)).toBe('the connection dropped (1006)');
    expect(closeWords(4426)).toBe('the link versions differ (4426)');
    expect(closeWords(502)).toContain('is the Mac awake');
    expect(closeFix(403)).toContain('jantar node access');
    expect(closeFix(4401)).toBe('Removed from the hub: run jantar node leave, then jantar node join with a new line');
    expect(closeFix(1006)).toBeUndefined();
  });
});

describe('jantar doctor at the Mac, with Fleet', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
  });
  afterEach(async () => {
    await home.cleanup();
  });

  async function run(o: { remote?: Record<string, unknown>; fleet?: boolean; handlers?: ExecHandler[]; probe?: ProbeResult | null; nodes?: { paired: number; online: number } } = {}) {
    const settings = settingsWith({ remote: o.remote ?? { mode: 'cloudflare', publicUrl: FLEET_HUB_URL }, fleet: { enabled: o.fleet ?? true } });
    const deps = testDeps({
      locations: await fakePackages(home.root),
      bins: { cswap: home.bins.cswap, osascript: home.bins.osascript },
      handlers: [...(o.handlers ?? []), onCommand(home.bins.cswap, { stdout: 'claude-swap 0.26.0\n' })],
    });
    const status: CtlStatusView = { role: 'hub', nodes: o.nodes ?? { paired: 3, online: 2 }, daemonVersion: '0.6.0' };
    const ctl = fakeCtl({
      'GET /healthz': ok({ ok: true, protocol: 3, daemonVersion: '0.6.0' }),
      'GET /ctl/status': ok(status),
      'GET /v1/settings': ok({ settings }),
    });
    const probes: string[] = [];
    const { ctx } = contextFor(home, { deps, ctl });
    const report = await doctorReport(ctx, {
      probe: async (url) => {
        probes.push(url);
        return o.probe === undefined ? { status: 403, location: null, jantar: false } : o.probe;
      },
    });
    return { report, deps, probes };
  }

  it('Fleet off: no Fleet lines and no pmset', async () => {
    const { report, deps, probes } = await run({ fleet: false });
    expect(report.checks.some((c) => c.id.startsWith('fleet') || c.id === 'sleep')).toBe(false);
    expect(deps.exec.calls.some((c) => c.file === PMSET)).toBe(false);
    expect(probes).toEqual([]);
  });

  it('on, Access in front, a Mac that never sleeps on power: all fine, and pmset only read', async () => {
    const { report, deps, probes } = await run({ handlers: [onCommand(PMSET, { stdout: PMSET_CUSTOM(0) }, ['-g', 'custom'])] });
    expect(check(report, 'fleet')).toMatchObject({ status: 'ok', detail: 'on: servers dial https://jantar.example.com/v1/node/link; 2 of 3 servers online' });
    expect(check(report, 'fleet-door')).toMatchObject({ status: 'ok', detail: 'Cloudflare Access refuses jantar.example.com/v1/node/* without a service token (403), as it should' });
    expect(check(report, 'sleep').status).toBe('ok');
    expect(probes).toEqual(['https://jantar.example.com/v1/node/pair']);
    expect(deps.exec.calls.filter((c) => c.file === PMSET).map((c) => c.args)).toEqual([['-g', 'custom']]);
  });

  it('warns when the Mac sleeps on power, with how to stop it', async () => {
    const { report } = await run({ handlers: [onCommand(PMSET, { stdout: PMSET_CUSTOM(10) })] });
    expect(check(report, 'sleep')).toMatchObject({
      status: 'warn',
      detail: "This Mac sleeps after 10 minutes on power, and the phone can't reach any server while it sleeps",
      fix: expect.stringContaining('sudo pmset -c sleep 0'),
    });
    expect(check(report, 'sleep').fix).toContain('Prevent automatic sleeping on power adapter');
  });

  it('warns when Jantar itself answers the node path (no Access in front), when Access sends it to a login, or nothing answers', async () => {
    const open = await run({ probe: { status: 404, location: null, jantar: true } });
    expect(check(open.report, 'fleet-door')).toMatchObject({ status: 'warn', detail: expect.stringContaining('only the handshake guards it') });
    expect(check(open.report, 'fleet-door').fix).toContain('jantar.example.com/v1/node/* with one Service Auth policy');
    const login = await run({ probe: { status: 302, location: 'https://example.cloudflareaccess.com/cdn-cgi/access/login', jantar: false } });
    expect(check(login.report, 'fleet-door')).toMatchObject({ status: 'warn', detail: expect.stringContaining("to a login page, which servers can't pass") });
    const down = await run({ probe: null });
    expect(check(down.report, 'fleet-door')).toMatchObject({ status: 'warn', detail: expect.stringContaining('did not answer') });
  });

  it('fails a quick tunnel, and gives the Tailscale tag and grant when servers are paired', async () => {
    const quick = await run({ remote: { mode: 'cloudflare', publicUrl: 'https://quiet-river-1234.trycloudflare.com' } });
    expect(check(quick.report, 'fleet')).toMatchObject({ status: 'fail', fix: 'jantar remote setup' });
    expect(quick.report.ok).toBe(false);
    expect(quick.probes).toEqual([]);

    const ts = await run({ remote: { mode: 'tailscale', publicUrl: 'https://mac.tailnet-0000.ts.net' } });
    expect(check(ts.report, 'fleet-door')).toMatchObject({ status: 'info', detail: expect.stringContaining('tag:jantar-node') });
    expect(check(ts.report, 'fleet-door').detail).toContain('tcp:443');
    expect(ts.probes).toEqual([]);
    const none = await run({ remote: { mode: 'tailscale', publicUrl: 'https://mac.tailnet-0000.ts.net' }, nodes: { paired: 0, online: 0 } });
    expect(none.report.checks.some((c) => c.id === 'fleet-door')).toBe(false);
  });
});

const NODE: NodeFile = {
  v: 1,
  url: FLEET_HUB_URL,
  nodeId: '01JF1EETN0DEBV11D1000000A1',
  name: 'build-1',
  hubKey: 'A'.repeat(43),
  privateKey: `${'-----'}BEGIN PRIVATE KEY-----\nsynthetic\n${'-----'}END PRIVATE KEY-----\n`,
  cfAccess: { clientId: '3f2a0000000000000000000000000000.access', clientSecret: 'synthetic-secret-never-printed' },
};

describe('jantar doctor on a server', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
    await writeHomeLayout(home.home, linuxHome());
    await mkdir(join(home.jantarHome, 'node'), { recursive: true });
    await writeFile(join(home.jantarHome, 'node', 'node.json'), '{}\n');
  });
  afterEach(async () => {
    await home.cleanup();
  });

  type Opts = {
    platform?: NodeJS.Platform;
    osrelease?: string | null;
    tmux?: string | null;
    ps?: string | null;
    linger?: string | null;
    systeminfo?: string;
    claude?: string;
    link?: CtlStatusView['node'] | 'down';
    over?: Partial<DoctorInput>;
  };

  async function run(o: Opts = {}) {
    const platform = o.platform ?? 'linux';
    const handlers: ExecHandler[] = [];
    if (o.tmux !== null) handlers.push(onCommand(TMUX, { stdout: `${o.tmux ?? 'tmux 3.3a'}\n` }, ['-V']));
    if (o.ps !== null) handlers.push(onCommand(PS, { stdout: `${o.ps ?? 'ps from procps-ng 3.3.17'}\n` }, ['--version']));
    handlers.push(onCommand(LOGINCTL, o.linger === null ? { code: 1, stderr: 'Failed to connect to bus\n' } : { stdout: `${o.linger ?? 'yes'}\n` }, ['show-user']));
    handlers.push(onCommand(SYSTEMINFO, { stdout: o.systeminfo ?? 'Hyper-V Requirements: A hypervisor has been detected.' }));
    handlers.push(onCommand(CLAUDE_WIN, { stdout: `${o.claude ?? '2.1.316'} (Claude Code)\n` }, ['--version']));
    const deps = testDeps({
      platform,
      uid: 1000,
      locations: await fakePackages(home.root),
      bins: {
        cswap: null,
        tmux: o.tmux === null ? null : TMUX,
        ps: o.ps === null ? null : PS,
        loginctl: LOGINCTL,
        claude: platform === 'win32' ? CLAUDE_WIN : null,
      },
      handlers,
    });
    const link = o.link ?? { name: 'build-1', hubHost: 'jantar.example.com', link: 'linked', lastClose: null, accessRefused: 0 };
    const ctl =
      link === 'down'
        ? fakeCtl({}, { down: true })
        : fakeCtl({ 'GET /healthz': ok({ ok: true, protocol: 3, daemonVersion: '0.6.0' }), 'GET /ctl/status': ok({ role: 'node', node: link } satisfies CtlStatusView) });
    const { ctx } = contextFor({ env: { ...home.env, USER: 'sam' } }, { deps, ctl });
    const report = await doctorReport(ctx, {
      nodeFile: NODE,
      readText: async () => (o.osrelease === undefined ? '6.1.0-18-amd64\n' : o.osrelease),
      exists: async () => false,
      ...o.over,
    });
    return { report, deps };
  }

  it('a healthy Linux server: linked, tmux, procps, lingering; no port, Automation, Tailscale or Fleet-door lines', async () => {
    const { report, deps } = await run();
    expect(check(report, 'platform')).toMatchObject({ status: 'ok', detail: 'Linux server (systemd, tmux)' });
    expect(check(report, 'node-link')).toMatchObject({ status: 'ok', detail: 'build-1 of jantar.example.com: linked' });
    expect(check(report, 'tmux')).toMatchObject({ status: 'ok', detail: expect.stringContaining('tmux 3.3 (/usr/bin/tmux); no tmux server runs yet') });
    expect(check(report, 'procps').status).toBe('ok');
    expect(check(report, 'linger').status).toBe('ok');
    for (const id of ['port', 'automation', 'tailscale', 'cloudflared', 'wsl', 'fleet', 'sleep']) expect(report.checks.some((c) => c.id === id), id).toBe(false);
    // Read-only: only version and status commands.
    expect(deps.exec.calls.map((c) => [c.file, ...c.args])).toEqual([
      [TMUX, '-V'],
      [PS, '--version'],
      [LOGINCTL, 'show-user', 'sam', '--property=Linger', '--value'],
    ]);
    // The Access secret never shows.
    expect(JSON.stringify(report)).not.toContain('synthetic-secret');
  });

  it('WSL1 fails; WSL2 gets the keep-alive and virtualization lines', async () => {
    const one = await run({ osrelease: '4.4.0-19041-Microsoft' });
    expect(check(one.report, 'wsl')).toMatchObject({ status: 'fail', detail: 'WSL1: Claude Code needs WSL2', fix: 'in Windows: wsl --set-version <distro> 2' });
    const two = await run({ osrelease: '5.15.153.1-microsoft-standard-WSL2' });
    const wsl = check(two.report, 'wsl');
    expect(wsl.status).toBe('info');
    expect(wsl.detail).toContain('instanceIdleTimeout=-1');
    expect(wsl.detail).toContain('vmIdleTimeout=-1');
    expect(wsl.detail).toContain('%USERPROFILE%\\.wslconfig');
    expect(wsl.detail).toContain('nested virtualization');
  });

  it('tmux 3.1 fails, no tmux warns, BusyBox ps and no ps fail, lingering off warns with the sudo line', async () => {
    expect(check((await run({ tmux: 'tmux 3.1c' })).report, 'tmux')).toMatchObject({ status: 'fail', detail: "tmux 3.1 is older than 3.2: the phone can't type into its panes" });
    expect(check((await run({ tmux: null })).report, 'tmux')).toMatchObject({ status: 'warn', detail: expect.stringContaining("can't type into them") });
    expect(check((await run({ ps: 'BusyBox v1.36.1 (2024-06-10) multi-call binary.' })).report, 'procps')).toMatchObject({ status: 'fail', fix: 'apk add procps' });
    expect(check((await run({ ps: null })).report, 'procps')).toMatchObject({ status: 'fail', fix: expect.stringContaining('procps') });
    expect(check((await run({ linger: 'no' })).report, 'linger')).toMatchObject({ status: 'warn', detail: 'off: Jantar stops when you log out', fix: 'sudo loginctl enable-linger sam' });
    expect(check((await run({ linger: null })).report, 'linger')).toMatchObject({ status: 'warn', detail: expect.stringContaining('systemd=true') });
  });

  it('says why the link is down and what to do: Access refused, removed, or the daemon not running', async () => {
    const at = new Date(Date.parse('2026-01-15T10:00:00.000Z') - 12 * 60_000).toISOString();
    const access = await run({ link: { name: 'build-1', hubHost: 'jantar.example.com', link: 'waiting', lastClose: { code: 403, at }, accessRefused: 3 } });
    expect(check(access.report, 'node-link')).toMatchObject({
      status: 'warn',
      detail:
        'build-1 of jantar.example.com: waiting to retry: last Cloudflare Access refused the connection (403): the service token may have expired or been revoked, 12m ago; 3 Cloudflare Access refusals since the last link',
      fix: expect.stringContaining('jantar node access'),
    });
    const removed = await run({ link: { name: 'build-1', hubHost: 'jantar.example.com', link: 'waiting', lastClose: { code: 4401, at }, accessRefused: 0 } });
    expect(check(removed.report, 'node-link').fix).toBe('Removed from the hub: run jantar node leave, then jantar node join with a new line');
    const down = await run({ link: 'down' });
    expect(check(down.report, 'node-link')).toMatchObject({ status: 'warn', fix: 'jantar install', detail: expect.stringContaining('the daemon is not running') });
  });

  it('lists the config dirs without hooks', async () => {
    const { report } = await run();
    const hooks = check(report, 'hooks');
    expect(hooks.status).toBe('info');
    expect(hooks.detail).toContain('~/.claude-work');
    expect(hooks.detail).not.toContain('.claude-scratch');
    expect(hooks.fix).toMatch(/^jantar hooks install --settings ~\/\.claude.*\/settings\.json --apply/);
  });

  it('native Windows: the preview line, no virtualization, and Claude 2.1.300 fails for cards', async () => {
    const off = await run({ platform: 'win32', systeminfo: 'Hyper-V Requirements:      Virtualization Enabled In Firmware: No', claude: '2.1.300' });
    expect(check(off.report, 'platform')).toMatchObject({ status: 'ok', detail: expect.stringContaining('Windows server, preview') });
    expect(check(off.report, 'windows')).toMatchObject({ status: 'warn', detail: expect.stringContaining("Virtualization is off here, so WSL2 can't run") });
    expect(check(off.report, 'claude-windows')).toMatchObject({ status: 'fail', detail: expect.stringContaining('2.1.300 is older than 2.1.310'), fix: 'claude update' });
    expect(off.report.checks.some((c) => ['tmux', 'procps', 'linger', 'cswap', 'automation'].includes(c.id))).toBe(false);
    const good = await run({ platform: 'win32' });
    expect(check(good.report, 'windows')).toMatchObject({ status: 'info', detail: expect.stringContaining('WSL2 can run here') });
    expect(check(good.report, 'claude-windows').status).toBe('ok');
  });
});
