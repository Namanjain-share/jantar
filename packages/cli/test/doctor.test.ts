/**
 * Doctor checks with an injected exec and binary finder, on a synthetic HOME.
 * Doctor is read-only: these tests also check it runs nothing but
 * `--version` / status commands.
 */
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '@jantar/daemon';
import { onCommand, type ExecHandler } from '@jantar/daemon/core/testing';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import { defaultSettings } from '@jantar/protocol';
import doctor, { doctorReport } from '../src/commands/doctor.js';
import { EXIT } from '../src/command.js';
import { coexistenceProblems, formatReport, parseVersion, type DoctorCheck, type DoctorReport } from '../src/lib/doctor.js';
import { contextFor, fakeCtl, fakePackages, ok, testDeps, type TestDepsOptions } from './helpers.js';

const TS = '/opt/synthetic/bin/tailscale';
const CF = '/opt/synthetic/bin/cloudflared';
const PGREP = '/usr/bin/pgrep';

function check(r: DoctorReport, id: string): DoctorCheck {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
}

const tsStatus = (state: string, dns = 'mac.tailnet-0000.ts.net.') =>
  onCommand(TS, { stdout: JSON.stringify({ BackendState: state, Self: { DNSName: dns } }) }, ['status', '--json']);
const tsServe = (json: unknown) => onCommand(TS, { stdout: JSON.stringify(json) }, ['serve', 'status', '--json']);
const serving = (port = 7420, extra: Record<string, unknown> = {}) => ({
  TCP: { '443': { HTTPS: true } },
  Web: { 'mac.tailnet-0000.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } },
  ...extra,
});

describe('jantar doctor', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
  });
  afterEach(async () => {
    await home.cleanup();
  });

  async function run(o: TestDepsOptions & { handlers?: ExecHandler[]; env?: Record<string, string>; ctlUp?: boolean } = {}) {
    const locations = await fakePackages(home.root);
    const deps = testDeps({
      locations,
      bins: { cswap: home.bins.cswap, pgrep: PGREP, osascript: home.bins.osascript, ...o.bins },
      handlers: [...(o.handlers ?? []), onCommand(PGREP, { code: 1 })],
      ...(o.portFree ? { portFree: o.portFree } : {}),
      ...(o.httpJson ? { httpJson: o.httpJson } : {}),
      ...(o.nodeVersion ? { nodeVersion: o.nodeVersion } : {}),
      ...(o.platform ? { platform: o.platform } : {}),
    });
    deps.exec.handle(onCommand(home.bins.cswap, { stdout: 'claude-swap 0.26.0\n' }, ['--version']));
    const ctl = o.ctlUp ? fakeCtl({ 'GET /healthz': ok({ ok: true, protocol: 1, daemonVersion: '0.1.0' }) }) : fakeCtl({}, { down: true });
    const { ctx, io } = contextFor({ env: { ...home.env, ...o.env } }, { deps, ctl });
    const report = await doctorReport(ctx);
    return { report, deps, ctx, io };
  }

  it('passes on a healthy synthetic Mac and only runs read-only commands', async () => {
    const { report, deps } = await run({ env: { CLAUDE_CONFIG_DIR: '/should/not/leak' } });
    expect(check(report, 'node').status).toBe('ok');
    expect(check(report, 'cswap')).toMatchObject({ status: 'ok' });
    expect(check(report, 'cswap').detail).toContain('0.26.0');
    expect(check(report, 'cswap').detail).toContain('3 profile dirs');
    expect(report.checks.some((c) => c.id === 'ccw-bot')).toBe(false);
    expect(check(report, 'daemon').status).toBe('warn');
    expect(check(report, 'port').status).toBe('ok');
    expect(check(report, 'state-dir').status).toBe('ok');
    expect(check(report, 'sockets').status).toBe('ok');
    expect(check(report, 'automation').status).toBe('info');
    expect(check(report, 'tailscale').status).toBe('info');
    expect(check(report, 'hooks').status).toBe('info');
    expect(check(report, 'config').detail).toContain('defaults');
    // cswap ran with the profile env stripped; nothing else but pgrep ran
    const cswap = deps.exec.calls.find((c) => c.file === home.bins.cswap);
    expect(cswap?.args).toEqual(['--version']);
    expect(cswap?.opts.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(new Set(deps.exec.calls.map((c) => c.file))).toEqual(new Set([home.bins.cswap, PGREP]));
    expect(deps.exec.calls.find((c) => c.file === PGREP)?.args).toEqual(['-f', 'ccw --telegram']);
  });

  it('fails on an old Node and warns off macOS', async () => {
    const { report } = await run({ nodeVersion: 'v20.11.1', platform: 'linux' });
    expect(check(report, 'node').status).toBe('fail');
    expect(check(report, 'platform')).toMatchObject({ status: 'warn', detail: 'linux: Jantar supports macOS only (launchd agent, Terminal.app)' });
    expect(report.ok).toBe(false);
    expect(parseVersion('v22.13.0')).toEqual([22, 13, 0]);
    expect((await run({ nodeVersion: 'v22.13.0' })).report.checks.find((c) => c.id === 'node')?.status).toBe('ok');
  });

  it('checks the cswap series, and finds a uv install when --version does not answer', async () => {
    const newer = await run({ handlers: [onCommand(home.bins.cswap, { stdout: 'claude-swap 0.27.1\n' }, ['--version'])] });
    expect(check(newer.report, 'cswap').status).toBe('warn');
    expect(check(newer.report, 'cswap').detail).toContain('0.27.1');

    const site = join(home.home, '.local', 'share', 'uv', 'tools', 'claude-swap', 'lib', 'python3.12', 'site-packages');
    await mkdir(join(site, 'claude_swap-0.26.0.dist-info'), { recursive: true });
    const uv = await run({ handlers: [onCommand(home.bins.cswap, { code: 1, stderr: 'boom' }, ['--version'])] });
    expect(check(uv.report, 'cswap')).toMatchObject({ status: 'ok' });
    expect(check(uv.report, 'cswap').detail).toContain('uv tool install');
  });

  it('warns when cswap is missing', async () => {
    const { report } = await run({ bins: { cswap: null } });
    expect(check(report, 'cswap').status).toBe('warn');
    expect(check(report, 'cswap').fix).toContain('claude-swap');
  });

  it('notes a Mac with one Claude login: no cswap and no profiles is single-account mode, not a warning', async () => {
    await rm(home.paths.cswapRoot, { recursive: true, force: true });
    const { report } = await run({ bins: { cswap: null } });
    const c = check(report, 'cswap');
    expect(c.status).toBe('info');
    expect(c.detail).toContain('single-account mode');
    expect(c.detail).toContain('cswap is optional');
    expect(c.fix).toContain('optional');
    expect(report.ok).toBe(true);
  });

  it('shows no ccw row on a Mac without ccw (O11): no ccw files, no bot', async () => {
    const { report } = await run();
    expect(report.checks.some((c) => c.id === 'ccw-bot')).toBe(false);
    expect(report.ok).toBe(true);
    const nopgrep = await run({ bins: { pgrep: null } });
    expect(nopgrep.report.checks.some((c) => c.id === 'ccw-bot')).toBe(false);
  });

  it('says ccw is optional when it is installed but its bot is not running', async () => {
    await home.cleanup();
    home = await makeFakeHome({ sessions: [], ccw: true });
    const { report } = await run();
    expect(check(report, 'ccw-bot')).toMatchObject({ status: 'ok', detail: 'not running (ccw is optional; Jantar only reads its files)' });
    expect(check(report, 'ccw-bot').detail).not.toMatch(/v0\.2/);
  });

  it('reads the Claude version from the native installer symlink without running claude', async () => {
    const versions = join(home.home, '.local', 'share', 'claude', 'versions');
    await mkdir(versions, { recursive: true });
    await writeFile(join(versions, '2.1.300'), '#!/bin/sh\n', { mode: 0o755 });
    await mkdir(join(home.home, '.local', 'bin'), { recursive: true });
    const link = join(home.home, '.local', 'bin', 'claude');
    await symlink(join(versions, '2.1.300'), link);
    const { report, deps } = await run({ bins: { claude: link } });
    expect(check(report, 'claude')).toMatchObject({ status: 'ok' });
    expect(check(report, 'claude').detail).toContain('2.1.300');
    expect(deps.exec.calls.some((c) => c.file === link)).toBe(false);
  });

  it('checks coexistence with a running ccw bot', async () => {
    const running = onCommand(PGREP, { code: 0, stdout: '4242\n' });
    const good = await run({ handlers: [running] });
    expect(check(good.report, 'ccw-bot').status).toBe('ok');

    const deps = testDeps({ locations: await fakePackages(home.root), bins: { pgrep: PGREP, cswap: home.bins.cswap }, handlers: [running] });
    await writeFile(join(home.jantarHome, 'config.json'), JSON.stringify({ notify: { telegram: true }, usage: { poller: 'on' } }));
    const { ctx } = contextFor(home, { deps });
    const bad = await doctorReport(ctx);
    const c = check(bad, 'ccw-bot');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('pid 4242');
    expect(c.detail).toContain('Telegram');
    expect(c.detail).toContain('usage.poller');

    const fine = { ...testDeps({ locations: deps.locations, bins: { pgrep: PGREP }, handlers: [running] }) };
    await writeFile(join(home.jantarHome, 'config.json'), '{}');
    const okReport = await doctorReport(contextFor(home, { deps: fine }).ctx);
    expect(check(okReport, 'ccw-bot')).toMatchObject({ status: 'ok' });
    expect(check(okReport, 'ccw-bot').detail).toContain('coexistence mode');

    expect(coexistenceProblems(defaultSettings())).toEqual([]);
  });

  it('reports Tailscale states', async () => {
    const none = await run();
    expect(check(none.report, 'tailscale').status).toBe('info');

    const loggedOut = await run({ bins: { tailscale: TS }, handlers: [tsStatus('NeedsLogin')] });
    expect(check(loggedOut.report, 'tailscale').status).toBe('warn');

    const noServe = await run({ bins: { tailscale: TS }, handlers: [tsStatus('Running'), tsServe({})] });
    expect(check(noServe.report, 'tailscale')).toMatchObject({ status: 'info', fix: 'jantar remote setup' });

    const serveNoUrl = await run({ bins: { tailscale: TS }, handlers: [tsStatus('Running'), tsServe(serving())] });
    expect(check(serveNoUrl.report, 'tailscale')).toMatchObject({ status: 'warn', fix: 'jantar remote url https://mac.tailnet-0000.ts.net' });

    await writeFile(join(home.jantarHome, 'config.json'), JSON.stringify({ remote: { publicUrl: 'https://mac.tailnet-0000.ts.net', mode: 'tailscale' } }));
    const good = await run({ bins: { tailscale: TS }, handlers: [tsStatus('Running'), tsServe(serving())] });
    expect(check(good.report, 'tailscale').status).toBe('ok');

    const funnel = await run({
      bins: { tailscale: TS },
      handlers: [tsStatus('Running'), tsServe(serving(7420, { AllowFunnel: { 'mac.tailnet-0000.ts.net:443': true } }))],
    });
    expect(check(funnel.report, 'tailscale').status).toBe('fail');

    // only read-only tailscale commands
    for (const c of funnel.deps.exec.calls.filter((x) => x.file === TS)) {
      expect([['status', '--json'], ['serve', 'status', '--json']]).toContainEqual(c.args);
    }
  });

  it('notes cloudflared', async () => {
    expect(check((await run({ bins: { cloudflared: CF } })).report, 'cloudflared').detail).toContain(CF);
    expect(check((await run()).report, 'cloudflared').detail).toContain('not installed');
  });

  it('checks state dir permissions', async () => {
    await chmod(home.jantarHome, 0o755);
    const loose = await run();
    expect(check(loose.report, 'state-dir')).toMatchObject({ status: 'fail' });
    expect(check(loose.report, 'state-dir').fix).toContain('chmod 700');

    await chmod(home.jantarHome, 0o700);
    await writeFile(join(home.jantarHome, 'config.json'), '{}', { mode: 0o644 });
    const file = await run();
    expect(check(file.report, 'state-dir').detail).toContain('should be 0600');
  });

  it('reports a missing state dir as a note', async () => {
    const env = { ...home.env, JANTAR_HOME: join(home.root, 'not-yet') };
    const deps = testDeps({ locations: await fakePackages(home.root), bins: { pgrep: PGREP }, handlers: [onCommand(PGREP, { code: 1 })] });
    const report = await doctorReport(contextFor({ env }, { deps }).ctx);
    expect(check(report, 'state-dir').status).toBe('info');
  });

  it('fails on an invalid config.json', async () => {
    await writeFile(join(home.jantarHome, 'config.json'), '{not json', { mode: 0o600 });
    expect(check((await run()).report, 'config').status).toBe('fail');
  });

  it('fails when the socket path is too long for macOS', async () => {
    const long = join(home.root, 'x'.repeat(90));
    const deps = testDeps({ locations: await fakePackages(home.root), bins: { pgrep: PGREP }, handlers: [onCommand(PGREP, { code: 1 })] });
    const report = await doctorReport(contextFor({ env: { ...home.env, JANTAR_HOME: long } }, { deps }).ctx);
    expect(check(report, 'sockets').status).toBe('fail');
  });

  it('tells our daemon apart from another program on the port', async () => {
    const taken = await run({ portFree: async () => false, httpJson: async () => null });
    expect(check(taken.report, 'port')).toMatchObject({ status: 'fail' });
    expect(check(taken.report, 'port').fix).toContain('lsof');

    const ours = await run({ ctlUp: true, portFree: async () => false, httpJson: async () => ({ ok: true, protocol: 1, daemonVersion: '0.1.0' }) });
    expect(check(ours.report, 'port').status).toBe('ok');
    expect(check(ours.report, 'daemon').status).toBe('ok');
    expect(check(ours.report, 'daemon').detail).toContain('0.1.0');

    // A jantard answers on the port, but this home's daemon is not running: another JANTAR_HOME's.
    const other = await run({ portFree: async () => false, httpJson: async () => ({ ok: true, protocol: 1, daemonVersion: '0.1.0' }) });
    expect(check(other.report, 'daemon').status).toBe('warn');
    expect(check(other.report, 'port')).toMatchObject({ status: 'warn', detail: expect.stringContaining('another Jantar daemon') });
    expect(check(other.report, 'port').fix).toContain('--port');
  });

  it("warns while ccw-v2's LaunchAgent is still installed: its daemon takes the port at login", async () => {
    expect((await run()).report.checks.some((c) => c.id === 'legacy-agent')).toBe(false);
    const agents = join(home.home, 'Library', 'LaunchAgents');
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, 'dev.ccw-v2.daemon.plist'), '<plist/>\n');
    const { report } = await run();
    expect(check(report, 'legacy-agent')).toMatchObject({
      status: 'warn',
      detail: `ccw-v2's daemon is still installed (${join(agents, 'dev.ccw-v2.daemon.plist')}) and holds the port`,
      fix: 'ccw-v2 uninstall (it keeps ~/.ccw-v2), then jantar import-ccw-v2',
    });
  });

  it('flags hooks that call a missing hook client', async () => {
    const paths = resolvePaths({ env: home.env });
    const s = { hooks: { Stop: [{ hooks: [{ type: 'command', command: `"/opt/node" "${paths.hookBin}"`, async: true }] }] } };
    const original = await readFile(home.paths.claudeSettings, 'utf8');
    await writeFile(home.paths.claudeSettings, JSON.stringify(s));
    try {
      expect(check((await run()).report, 'hooks').status).toBe('fail');
      await mkdir(paths.binDir, { recursive: true });
      await writeFile(paths.hookBin, '// client\n');
      expect(check((await run()).report, 'hooks').status).toBe('ok');
    } finally {
      await writeFile(home.paths.claudeSettings, original);
    }
  });

  it('spots a refused Automation permission in the daemon log', async () => {
    const paths = resolvePaths({ env: home.env });
    await mkdir(paths.logsDir, { recursive: true });
    await writeFile(join(paths.logsDir, 'daemon.err.log'), '{"level":"warn","msg":"osascript failed","error":"execution error: Not authorized to send Apple events to Terminal. (-1743)"}\n');
    const c = check((await run()).report, 'automation');
    expect(c.status).toBe('warn');
    expect(c.fix).toContain('Privacy & Security');
  });

  it('flags a daemon build that is missing', async () => {
    const deps = testDeps({
      locations: { daemonBin: join(home.root, 'none', 'bin', 'jantard.mjs'), hookClient: join(home.root, 'none.mjs') },
      bins: { pgrep: PGREP },
      handlers: [onCommand(PGREP, { code: 1 })],
    });
    const report = await doctorReport(contextFor(home, { deps }).ctx);
    expect(check(report, 'build').status).toBe('fail');
  });

  it('prints a table and exits 1 only when something fails', async () => {
    const locations = await fakePackages(home.root);
    const deps = testDeps({ locations, bins: { pgrep: PGREP, osascript: home.bins.osascript }, handlers: [onCommand(PGREP, { code: 1 })] });
    const { ctx, io } = contextFor(home, { deps });
    const code = await doctor.run([], ctx);
    expect(io.stdout).toMatch(/^jantar doctor\n/);
    expect(io.stdout).toMatch(/\d+ ok, \d+ warnings?, \d+ failures?, \d+ notes?\n$/);
    expect(code).toBe(EXIT.ok);

    const json = contextFor(home, { deps: { ...deps, nodeVersion: 'v18.0.0' } });
    expect(await doctor.run(['--json'], json.ctx)).toBe(EXIT.failed);
    const parsed = JSON.parse(json.io.stdout) as DoctorReport;
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.find((c) => c.id === 'node')?.status).toBe('fail');

    const text = formatReport(parsed);
    expect(text).toContain('FAIL');
    expect(text).toContain('-> install Node 22 LTS');
  });
});
