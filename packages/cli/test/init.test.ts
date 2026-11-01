/**
 * jantar init (spec 7.1, O6, O13) on a synthetic HOME: scripted answers and
 * --yes, a Mac with cswap and one without, an existing config, a running
 * daemon of this version and of another. init runs no program and writes
 * only inside the state dir; a config it wrote boots the daemon with no cswap.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startDaemon } from '@jantar/daemon/daemon';
import { memoryLogger } from '@jantar/daemon';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import { DEFAULT_LAUNCH_FLAGS, PROTOCOL_VERSION, SETTINGS_VERSION, SettingsSchema } from '@jantar/protocol';
import init from '../src/commands/init.js';
import { EXIT } from '../src/command.js';
import { PERMISSION_CHOICES, initPatch, launchModeFor, nextSteps, parseAccountList } from '../src/lib/init/plan.js';
import { contextFor, fakeCtl, fakeSettings, fail, ok, testDeps } from './helpers.js';

/** Every folder and file under `dir` (a file with its size and mtime), relative to `dir`. */
async function snapshot(dir: string, skip: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (p === skip) continue;
      if (e.isDirectory()) {
        out.set(`${relative(dir, p)}/`, 'dir');
        await walk(p);
      } else {
        const s = await stat(p);
        out.set(relative(dir, p), `${s.size}|${s.mtimeMs}`);
      }
    }
  };
  await walk(dir);
  return out;
}

async function readConfig(home: FakeHome) {
  const path = join(home.jantarHome, 'config.json');
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  return { raw, settings: SettingsSchema.parse(raw), mode: (await stat(path)).mode & 0o777 };
}

describe('jantar init', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
  });
  afterEach(async () => {
    await home.cleanup();
  });

  /** A Mac with one Claude login: no cswap binary, no profiles. */
  async function noCswap() {
    await rm(home.paths.cswapRoot, { recursive: true, force: true });
    return testDeps({ bins: { claude: home.bins.claude, cswap: null } });
  }
  const withCswap = () => testDeps({ bins: { claude: home.bins.claude, cswap: home.bins.cswap } });

  it('--yes on a Mac without cswap writes safe single-account settings, only inside the state dir, and runs nothing', async () => {
    const deps = await noCswap();
    const before = await snapshot(home.root, home.jantarHome);
    const { ctx, io } = contextFor(home, { deps });
    expect(await init.run(['--yes'], ctx), io.stderr).toBe(EXIT.ok);

    const { raw, settings, mode } = await readConfig(home);
    expect(raw.version).toBe(SETTINGS_VERSION);
    expect(mode).toBe(0o600);
    expect(settings.launch.mode).toBe('claude');
    expect(settings.launch.enabled).toBe(false);
    expect(settings.launch.defaultFlags).toEqual(DEFAULT_LAUNCH_FLAGS);
    expect(settings.launch.defaultFlags.permission).toBe('manual');
    expect(settings.accounts.kept).toEqual([]);
    expect(settings.folders.roots).toEqual([]);
    expect(settings.life.currency).toBeNull();

    // Nothing outside the state dir changed; init ran no program at all.
    expect(await snapshot(home.root, home.jantarHome)).toEqual(before);
    expect(deps.exec.calls).toEqual([]);

    const out = io.stdout;
    expect(out).toContain('1. This Mac');
    expect(out).toContain('cswap     not found (optional');
    expect(out).toContain('2. Accounts\n  One Claude login: single-account mode.');
    expect(out).toContain('3. Launching and folders');
    expect(out).toContain('Sessions start with: claude (types: cd -- <folder> && claude <flags>)');
    expect(out).toContain('4. Next, at this Mac:');
    for (const cmd of ['jantar install', 'jantar remote setup', 'jantar pair', 'jantar life on', 'jantar life set currency <code>', 'jantar intel source add <file.jsonl>']) {
      expect(out).toContain(cmd);
    }
    // O13: cs-shell is never offered, and no maintainer tool is named.
    expect(out).not.toContain('cs-shell');
    expect(io.stderr).toBe('');
  });

  it('--yes on a Mac with cswap: multi-account mode, cswap-run, nothing kept', async () => {
    const { ctx, io } = contextFor(home, { deps: withCswap() });
    expect(await init.run(['--yes'], ctx), io.stderr).toBe(EXIT.ok);
    const { settings } = await readConfig(home);
    expect(settings.launch.mode).toBe('cswap-run');
    expect(settings.accounts.kept).toEqual([]);
    expect(io.stdout).toMatch(/Found cswap with \d+ accounts: multi-account mode\./);
    expect(io.stdout).toContain('Sessions start with: cswap-run');
    expect(io.stdout).not.toContain('cs-shell');
  });

  it('asks each question in order and writes the answers', async () => {
    await mkdir(join(home.home, 'Desktop'));
    await mkdir(join(home.home, 'work', 'site'), { recursive: true });
    const answers = [
      '5 3 5', // kept
      '2', // accept edits
      'y', // phones may start sessions
      'y', // ~/Desktop
      '/', // refused: never a root
      '~/work/site', // added
      '', // done
    ];
    const { ctx, io } = contextFor(home, { deps: withCswap(), ioOptions: { answers } });
    expect(await init.run([], ctx), io.stderr).toBe(EXIT.ok);

    expect(io.questions.map((q) => q.trim().split('\n')[0])).toEqual([
      expect.stringMatching(/^Accounts to keep for other work .* \[none\]:$/),
      'How should a new session start?',
      expect.stringMatching(/^Let paired phones start new sessions .*\[y\/N\]$/),
      'Let the phone browse and start sessions in ~/Desktop? [y/N]',
      expect.stringMatching(/^Another folder for the phone/),
      expect.stringMatching(/^Another folder for the phone/),
      expect.stringMatching(/^Another folder for the phone/),
    ]);
    // The offered starting modes: the four permission picks, never cs-shell.
    const offered = io.questions[1] ?? '';
    for (const c of PERMISSION_CHOICES) expect(offered).toContain(c.label);
    expect(offered).toContain('1. Ask before tools (default)');
    expect(io.questions.join('\n')).not.toContain('cs-shell');

    expect(io.stderr).toContain('Not added: / is');
    const { settings } = await readConfig(home);
    expect(settings.accounts.kept).toEqual([3, 5]);
    expect(settings.launch.defaultFlags).toEqual({ ...DEFAULT_LAUNCH_FLAGS, permission: 'acceptEdits' });
    expect(settings.launch.enabled).toBe(true);
    expect(settings.launch.mode).toBe('cswap-run');
    expect(settings.folders.roots.map((r) => r.id)).toEqual(['desktop', 'site']);
    expect(io.stdout).toContain('kept for other work  3, 5');
    expect(io.stdout).toContain('jantar devices grant <device> launch');
  });

  it('asks again after an answer it cannot use, then keeps the default', async () => {
    const { ctx, io } = contextFor(home, { deps: withCswap(), ioOptions: { answers: ['three', '4', '9', 'maybe', 'x', 'perhaps', ''] } });
    expect(await init.run([], ctx), io.stderr).toBe(EXIT.ok);
    expect(io.stderr).toContain('"three" is not an account number');
    expect(io.stderr).toContain('pick a number from 1 to 4');
    expect(io.stderr).toContain('Answer y or n.');
    const { settings } = await readConfig(home);
    expect(settings.accounts.kept).toEqual([4]);
    // "9", "maybe" and "x" were refused: the default (Ask before tools) stood after the third try
    expect(settings.launch.defaultFlags.permission).toBe('manual');
    expect(settings.launch.enabled).toBe(false);
  });

  it('never changes an existing config without asking: --yes and "n" leave it byte for byte', async () => {
    const path = join(home.jantarHome, 'config.json');
    const text = `${JSON.stringify({ version: 2, launch: { enabled: true } }, null, 2)}\n`;
    await writeFile(path, text, { mode: 0o600 });

    const yes = contextFor(home, { deps: withCswap() });
    expect(await init.run(['--yes'], yes.ctx)).toBe(EXIT.ok);
    expect(yes.io.stdout).toContain('A config exists; it is left as it is.');
    expect(await readFile(path, 'utf8')).toBe(text);

    const no = contextFor(home, { deps: withCswap(), ioOptions: { answers: ['n'] } });
    expect(await init.run([], no.ctx)).toBe(EXIT.ok);
    expect(no.io.questions[0]).toContain('A config exists. Change it? [y/N]');
    expect(no.io.questions).toHaveLength(1);
    expect(await readFile(path, 'utf8')).toBe(text);
  });

  it('changes an existing v0.3 config when asked: the v1 copy is kept and its cs-shell stays', async () => {
    const path = join(home.jantarHome, 'config.json');
    const v1 = `${JSON.stringify({ version: 1, launch: { mode: 'cs-shell', csCommand: 'cs' } }, null, 2)}\n`;
    await writeFile(path, v1, { mode: 0o600 });
    const { ctx, io } = contextFor(home, { deps: withCswap(), ioOptions: { answers: ['y', '', '', '', ''] } });
    expect(await init.run([], ctx), io.stderr).toBe(EXIT.ok);
    expect(await readFile(`${path}.v1`, 'utf8')).toBe(v1);
    const { raw, settings } = await readConfig(home);
    expect(raw.version).toBe(SETTINGS_VERSION);
    expect(settings.launch.mode).toBe('cs-shell');
    expect(io.stdout).toContain('Sessions start with: cs-shell');
  });

  it('refuses a config it cannot read rather than replacing it', async () => {
    const path = join(home.jantarHome, 'config.json');
    await writeFile(path, '{ not json', { mode: 0o600 });
    const { ctx, io } = contextFor(home, { deps: withCswap(), ioOptions: { answers: ['y'] } });
    expect(await init.run([], ctx)).toBe(EXIT.failed);
    expect(io.stderr).toContain('Fix it or move it aside');
    expect(await readFile(path, 'utf8')).toBe('{ not json');
  });

  it('needs a terminal to ask, or --yes', async () => {
    const { ctx, io } = contextFor(home, { deps: withCswap() });
    expect(await init.run([], ctx)).toBe(EXIT.usage);
    expect(io.stderr).toContain('run it in a terminal, or add --yes');
    await expect(stat(join(home.jantarHome, 'config.json'))).rejects.toThrow();
  });

  it('honours JANTAR_ACCOUNTS=single on a Mac with cswap', async () => {
    const { ctx, io } = contextFor({ env: { ...home.env, JANTAR_ACCOUNTS: 'single' } }, { deps: withCswap() });
    expect(await init.run(['--yes'], ctx), io.stderr).toBe(EXIT.ok);
    expect(io.stdout).toContain('(JANTAR_ACCOUNTS=single: one account)');
    expect((await readConfig(home)).settings.launch.mode).toBe('claude');
  });

  it('writes through a running daemon of this version, and refuses one of another version', async () => {
    const s = fakeSettings();
    const ctl = fakeCtl({ ...s.routes, 'GET /healthz': ok({ ok: true, protocol: PROTOCOL_VERSION, daemonVersion: '0.4.0' }) });
    const live = contextFor(home, { deps: withCswap(), ctl });
    expect(await init.run(['--yes'], live.ctx), live.io.stderr).toBe(EXIT.ok);
    expect(s.patches).toEqual([
      { accounts: { kept: [] }, launch: { mode: 'cswap-run', enabled: false, defaultFlags: DEFAULT_LAUNCH_FLAGS }, folders: { roots: [] } },
    ]);
    expect(live.io.stdout).toContain('Daemon    running (0.4.0)');
    expect(live.io.stdout).toContain('Saved through the running daemon.');
    await expect(stat(join(home.jantarHome, 'config.json'))).rejects.toThrow();

    const old = fakeSettings();
    const oldCtl = fakeCtl({ ...old.routes, 'GET /healthz': ok({ ok: true, protocol: 2, daemonVersion: '0.3.0' }) });
    const refused = contextFor(home, { deps: withCswap(), ctl: oldCtl });
    expect(await init.run(['--yes'], refused.ctx)).toBe(EXIT.failed);
    expect(refused.io.stderr).toContain('a Jantar daemon of another version (0.3.0, protocol 2)');
    expect(old.patches).toEqual([]);

    const broken = fakeCtl({ 'GET /healthz': fail('internal', 'boom', 500) });
    expect(await init.run(['--yes'], contextFor(home, { deps: withCswap(), ctl: broken }).ctx)).toBe(EXIT.failed);
  });

  it('boots the daemon on the config init --yes wrote, with no cswap: one account, account 0', async () => {
    await rm(home.bins.cswap, { force: true });
    const deps = await noCswap();
    const { ctx, io } = contextFor(home, { deps });
    expect(await init.run(['--yes'], ctx), io.stderr).toBe(EXIT.ok);

    const running = await startDaemon({ env: home.env, port: 0, terminal: false, usePath: true, proc: home.probe, rotateLogs: false, log: memoryLogger() });
    try {
      expect(running.ctx.accountsMode()).toBe('single');
      expect(running.ctx.bins.cswap).toBeNull();
      const port = running.address()?.port;
      const health = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { ok: boolean; protocol: number };
      expect(health).toMatchObject({ ok: true, protocol: PROTOCOL_VERSION });
      expect(Object.keys(running.ctx.store.getState().accounts)).toEqual(['0']);
      expect(running.ctx.store.getState().daemon?.accountsMode).toBe('single');
    } finally {
      await running.stop();
    }
    expect(await home.calls('cswap')).toEqual([]);
  }, 30_000);
});

describe('init plan', () => {
  it('picks the launch mode the Mac can start sessions with', () => {
    expect(launchModeFor('single', 'cs-shell')).toBe('claude');
    expect(launchModeFor('single', 'cswap-run')).toBe('claude');
    expect(launchModeFor('cswap', 'claude')).toBe('cswap-run');
    expect(launchModeFor('cswap', 'cswap-run')).toBe('cswap-run');
    expect(launchModeFor('cswap', 'cs-shell')).toBe('cs-shell');
  });

  it('reads kept accounts as numbers, once each, sorted', () => {
    expect(parseAccountList('5 3,5')).toEqual({ ok: true, value: [3, 5] });
    expect(parseAccountList('', [2])).toEqual({ ok: true, value: [2] });
    expect(parseAccountList('none', [2])).toEqual({ ok: true, value: [] });
    expect(parseAccountList('0')).toEqual({ ok: true, value: [0] });
    for (const bad of ['-1', '1.5', 'x', '3 y']) expect(parseAccountList(bad).ok, bad).toBe(false);
    expect(parseAccountList(Array.from({ length: 51 }, (_, i) => i).join(' ')).ok).toBe(false);
  });

  it('patches accounts, launching and folders only, keeping chrome, effort and model', () => {
    const current = SettingsSchema.parse({ launch: { defaultFlags: { permission: 'skip', chrome: true, effort: 'high', model: 'default' } } });
    const patch = initPatch(current, { kept: [3], mode: 'cswap-run', permission: 'manual', launchOn: false, roots: [] });
    expect(Object.keys(patch).sort()).toEqual(['accounts', 'folders', 'launch']);
    expect(patch.launch).toEqual({ mode: 'cswap-run', enabled: false, defaultFlags: { permission: 'manual', chrome: true, effort: 'high', model: 'default' } });
    expect(nextSteps({ launchOn: false })).not.toContain('devices grant');
    // The window primer is offered only with cswap's accounts.
    expect(nextSteps({ launchOn: false })).not.toContain('accounts prime');
    expect(nextSteps({ launchOn: false }, true)).toContain('  jantar accounts prime on                                    start idle 5-hour windows early (kept and held accounts left out)\n');
  });
});
