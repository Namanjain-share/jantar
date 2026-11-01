/**
 * v0.8: the iOS Shortcut at the Mac, on a synthetic HOME with a fake
 * ctl.sock (synthetic keys and hosts only).
 *
 * - `jantar doctor`: once the shelf is on and a Shortcut key exists, where
 *   the capture door is: closed in loopback and lan mode, Tailscale, or
 *   Cloudflare, where one credential-less probe of /v1/capture/save must be
 *   answered by Access (403), never by Jantar or with a login page. No key
 *   (or the shelf off): no line and no probe.
 * - `jantar intel shortcut add | list | revoke`: the key printed once with
 *   the door and the steps (or why the door is closed), the list never
 *   holding a key, revoke by id or --all, usage errors for the rest.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onCommand } from '@jantar/daemon/core/testing';
import { FLEET_HUB_URL, makeFakeHome, type FakeHome } from '@jantar/fixtures';
import { applySettingsPatch, defaultSettings, type CaptureKeyAddReply, type Settings } from '@jantar/protocol';
import { doctorReport } from '../src/commands/doctor.js';
import { shortcutSteps } from '../src/commands/intel-shortcut.js';
import type { DoctorCheck, DoctorReport, ProbeResult } from '../src/lib/doctor.js';
import { EXIT, main } from '../src/index.js';
import { contextFor, fakeCtl, fakePackages, ok, testDeps } from './helpers.js';

const KEY_ID = '01JSYNTHCAPTVREKEY00000000';
const KEY = `jcap_${'S'.repeat(43)}`;
const ROW = { id: KEY_ID, name: 'iphone', createdAt: '2026-01-15T10:00:00.000Z', lastSeenAt: null };

function settingsWith(patch: Record<string, unknown>): Settings {
  const r = applySettingsPatch(defaultSettings(), patch);
  if (!r.ok) throw new Error(r.error);
  return r.settings;
}

function find(r: DoctorReport, id: string): DoctorCheck | undefined {
  return r.checks.find((x) => x.id === id);
}

describe('jantar doctor: the Shortcut door', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
  });
  afterEach(async () => {
    await home.cleanup();
  });

  async function run(o: { remote?: Record<string, unknown>; intel?: boolean; keys?: number; probe?: ProbeResult | null } = {}) {
    const settings = settingsWith({ remote: o.remote ?? { mode: 'cloudflare', publicUrl: FLEET_HUB_URL }, intel: { enabled: o.intel ?? true } });
    const deps = testDeps({
      locations: await fakePackages(home.root),
      bins: { cswap: home.bins.cswap, osascript: home.bins.osascript },
      handlers: [onCommand(home.bins.cswap, { stdout: 'claude-swap 0.26.0\n' })],
    });
    const keys = Array.from({ length: o.keys ?? 1 }, (_, n) => ({ ...ROW, id: `${KEY_ID.slice(0, -1)}${n}` }));
    const ctl = fakeCtl({
      'GET /healthz': ok({ ok: true, protocol: 3, daemonVersion: '0.8.0' }),
      'GET /ctl/status': ok({ role: 'hub', daemonVersion: '0.8.0' }),
      'GET /v1/settings': ok({ settings }),
      'GET /v1/intel/capture-keys': ok({ keys }),
    });
    const probes: string[] = [];
    const { ctx } = contextFor(home, { deps, ctl });
    const report = await doctorReport(ctx, {
      probe: async (url) => {
        probes.push(url);
        return o.probe === undefined ? { status: 403, location: null, jantar: false } : o.probe;
      },
    });
    return { report, probes, ctl };
  }

  it('Cloudflare with Access in front: ok, from one credential-less probe of the door', async () => {
    const { report, probes } = await run();
    expect(find(report, 'capture-door')).toMatchObject({
      status: 'ok',
      detail: '1 Shortcut key; Cloudflare Access refuses jantar.example.com/v1/capture/* without a service token (403), as it should',
    });
    expect(probes).toEqual(['https://jantar.example.com/v1/capture/save']);
  });

  it('warns when Jantar answers (no Access), when Access sends a login page, or nothing answers', async () => {
    const open = await run({ probe: { status: 404, location: null, jantar: true } });
    expect(find(open.report, 'capture-door')).toMatchObject({ status: 'warn', detail: expect.stringContaining('reaches Jantar with no Access in front') });
    expect(find(open.report, 'capture-door')?.fix).toContain('jantar.example.com/v1/capture/* with one Service Auth policy');
    const login = await run({ probe: { status: 302, location: 'https://example.cloudflareaccess.com/cdn-cgi/access/login', jantar: false } });
    expect(find(login.report, 'capture-door')).toMatchObject({ status: 'warn', detail: expect.stringContaining("login page, which the Shortcut can't pass") });
    const down = await run({ probe: null });
    expect(find(down.report, 'capture-door')).toMatchObject({ status: 'warn', detail: 'https://jantar.example.com/v1/capture/save did not answer from this Mac' });
  });

  it('Tailscale: an info line, no probe', async () => {
    const { report, probes } = await run({ remote: { mode: 'tailscale', publicUrl: 'https://mac.tail0.ts.net' }, keys: 2 });
    expect(find(report, 'capture-door')).toMatchObject({ status: 'info', detail: '2 Shortcut keys; the iPhone reaches https://mac.tail0.ts.net/v1/capture/save while its Tailscale is on' });
    expect(probes).toEqual([]);
  });

  it('loopback and lan: the door is closed, a warning with the way to open it', async () => {
    for (const remote of [{ mode: 'loopback' }, { mode: 'lan' }]) {
      const { report, probes } = await run({ remote });
      expect(find(report, 'capture-door'), remote.mode).toMatchObject({ status: 'warn', detail: expect.stringContaining('the door is closed'), fix: expect.stringContaining('jantar remote setup') });
      expect(probes).toEqual([]);
    }
  });

  it('no key, or the shelf off: no line, no probe, and the shelf off asks nothing', async () => {
    const none = await run({ keys: 0 });
    expect(find(none.report, 'capture-door')).toBeUndefined();
    expect(none.probes).toEqual([]);
    const off = await run({ intel: false });
    expect(find(off.report, 'capture-door')).toBeUndefined();
    expect(off.ctl.calls.some((c) => c.path === '/v1/intel/capture-keys')).toBe(false);
  });
});

describe('jantar intel shortcut', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
  });
  afterEach(async () => {
    await home.cleanup();
  });

  function cli(settings: Settings, over: Record<string, unknown> = {}) {
    const added: CaptureKeyAddReply = { id: KEY_ID, key: KEY, name: 'iphone', saveUrl: settings.remote.mode === 'cloudflare' || settings.remote.mode === 'tailscale' ? `${settings.remote.publicUrl}/v1/capture/save` : null };
    const ctl = fakeCtl({
      'GET /v1/settings': ok({ settings }),
      'POST /v1/intel/capture-keys': (call) => ok({ ...added, name: (call.body as { name?: string }).name ?? 'iphone' }),
      'GET /v1/intel/capture-keys': ok({ keys: [ROW] }),
      'POST /v1/intel/capture-keys/revoke': (call) => ok({ revoked: 'all' in (call.body as object) ? 2 : (call.body as { id: string }).id === KEY_ID ? 1 : 0 }),
      ...over,
    });
    const { ctx, io } = contextFor(home, { ctl });
    return { ctx, io, ctl, run: (argv: string[]) => main(['intel', 'shortcut', ...argv], { io, context: ctx }) };
  }

  it('add on Cloudflare: the key once, the door, the steps with the Access headers', async () => {
    const c = cli(settingsWith({ remote: { mode: 'cloudflare', publicUrl: FLEET_HUB_URL }, intel: { enabled: true } }));
    expect(await c.run(['add', '--name', 'iphone'])).toBe(EXIT.ok);
    expect(c.ctl.calls.find((x) => x.method === 'POST')?.body).toEqual({ name: 'iphone' });
    const out = c.io.stdout;
    expect(out.split(KEY)).toHaveLength(2);
    expect(out).toContain('The door: POST https://jantar.example.com/v1/capture/save');
    expect(out).toContain('CF-Access-Client-Id and CF-Access-Client-Secret');
    expect(out).toContain('docs/shortcut.md#cloudflare-access');
    expect(out).toContain(`jantar intel shortcut revoke ${KEY_ID}`);
    expect(c.io.stderr).toBe('');
  });

  it('add on Tailscale: the steps without Access headers', async () => {
    const c = cli(settingsWith({ remote: { mode: 'tailscale', publicUrl: 'https://mac.tail0.ts.net' }, intel: { enabled: true } }));
    expect(await c.run(['add'])).toBe(EXIT.ok);
    expect(c.io.stdout).toContain(shortcutSteps('https://mac.tail0.ts.net/v1/capture/save', false));
    expect(c.io.stdout).not.toContain('CF-Access');
  });

  it('add in loopback or lan: the key, and why the door is closed', async () => {
    for (const mode of ['loopback', 'lan'] as const) {
      const c = cli(settingsWith({ remote: { mode }, intel: { enabled: true } }));
      expect(await c.run(['add'])).toBe(EXIT.ok);
      expect(c.io.stdout).toContain('The door is closed:');
      expect(c.io.stdout).toContain(mode === 'lan' ? 'plain http' : 'loopback');
      expect(c.io.stdout).not.toContain('Get Contents of URL');
    }
  });

  it("add with the shelf off says the daemon's sentence and fails", async () => {
    const c = cli(settingsWith({}), {
      'POST /v1/intel/capture-keys': { status: 403, body: { error: { code: 'forbidden', message: 'The Intel shelf is off. Turn it on at your Mac: jantar intel on' } } },
    });
    expect(await c.run(['add'])).toBe(EXIT.failed);
    expect(c.io.stderr).toContain('The Intel shelf is off');
    expect(c.io.stdout).toBe('');
  });

  it('list: ids, names and when, never a key', async () => {
    const c = cli(settingsWith({}));
    expect(await c.run(['list'])).toBe(EXIT.ok);
    expect(c.io.stdout).toContain('1 Shortcut key:');
    expect(c.io.stdout).toContain(`${KEY_ID}  iphone`);
    expect(c.io.stdout).toContain('never used');
    expect(c.io.stdout).not.toContain('jcap_');
    const empty = cli(settingsWith({}), { 'GET /v1/intel/capture-keys': ok({ keys: [] }) });
    expect(await empty.run(['list'])).toBe(EXIT.ok);
    expect(empty.io.stdout).toBe('No Shortcut keys. Make one: jantar intel shortcut add\n');
  });

  it('revoke by id, --all, an unknown id fails, and the usage errors', async () => {
    const c = cli(settingsWith({}));
    expect(await c.run(['revoke', KEY_ID])).toBe(EXIT.ok);
    expect(c.io.stdout).toContain('Revoked 1 Shortcut key.');
    expect(await c.run(['revoke', '--all'])).toBe(EXIT.ok);
    expect(c.io.stdout).toContain('Revoked 2 Shortcut keys.');
    const unknown = cli(settingsWith({}));
    expect(await unknown.run(['revoke', '01JSYNTHCAPTVREKEY0000000Z'])).toBe(EXIT.failed);
    expect(unknown.io.stderr).toContain('No active Shortcut key');
    for (const argv of [['revoke'], ['revoke', 'nope'], ['revoke', KEY_ID, '--all'], ['add', 'extra'], ['add', '--name', 'a\nb'], ['list', 'x'], ['frob'], []]) {
      const u = cli(settingsWith({}));
      expect(await u.run(argv), argv.join(' ')).toBe(EXIT.usage);
      expect(u.ctl.calls.filter((x) => x.method === 'POST')).toEqual([]);
    }
  });
});
