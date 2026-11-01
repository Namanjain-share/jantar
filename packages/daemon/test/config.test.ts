import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '@jantar/protocol';
import {
  FileSettingsStore,
  MAX_SOCKET_PATH,
  ensureStateDirs,
  legacyHomeWarning,
  loadSettings,
  resolveBins,
  resolvePaths,
  saveSettings,
  socketPathOk,
  writeFileAtomic,
} from '../src/config.js';

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'jantar-test-')));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('resolvePaths', () => {
  it('derives everything from the user home by default', () => {
    const p = resolvePaths({ env: { HOME: '/synthetic/home' } });
    expect(p.home).toBe('/synthetic/home/.jantar');
    expect(p.configFile).toBe('/synthetic/home/.jantar/config.json');
    expect(p.dbFile).toBe('/synthetic/home/.jantar/jantar.db');
    expect(p.hooksSock).toBe('/synthetic/home/.jantar/run/hooks.sock');
    expect(p.ctlSock).toBe('/synthetic/home/.jantar/run/ctl.sock');
    expect(p.hookBin).toBe('/synthetic/home/.jantar/bin/jantar-hook');
    expect(p.vapidFile).toBe('/synthetic/home/.jantar/push/vapid.json');
    expect(p.claudeSettings).toBe('/synthetic/home/.claude/settings.json');
    expect(p.claudeProjects).toBe('/synthetic/home/.claude/projects');
    expect(p.cswapProfiles).toBe('/synthetic/home/.claude-swap-backup/sessions');
    expect(p.cswapSequence).toBe('/synthetic/home/.claude-swap-backup/sequence.json');
    expect(p.cswapUsageCache).toBe('/synthetic/home/.claude-swap-backup/cache/usage.json');
    expect(p.ccwSwitchJson).toBe('/synthetic/home/.config/ccw/switch.json');
    expect(p.ccwBurnJson).toBe('/synthetic/home/.config/ccw/switch/burn.json');
    expect(p.webDist.endsWith('/packages/web/dist')).toBe(true);
  });

  it('honours JANTAR_HOME and JANTAR_WEB_DIST', () => {
    const p = resolvePaths({ env: { HOME: '/synthetic/home', JANTAR_HOME: '/tmp/x-state', JANTAR_WEB_DIST: '/tmp/web' } });
    expect(p.home).toBe('/tmp/x-state');
    expect(p.userHome).toBe('/synthetic/home');
    expect(p.webDist).toBe('/tmp/web');
  });

  it('takes the old CCW_V2_HOME when JANTAR_HOME is unset, with a one-line deprecation warning', () => {
    const env = { HOME: '/synthetic/home', CCW_V2_HOME: '/tmp/old-state' };
    expect(resolvePaths({ env }).home).toBe('/tmp/old-state');
    expect(legacyHomeWarning(env)).toBe('CCW_V2_HOME is deprecated: set JANTAR_HOME instead (using /tmp/old-state for now).');
    const both = { ...env, JANTAR_HOME: '/tmp/x-state' };
    expect(resolvePaths({ env: both }).home).toBe('/tmp/x-state');
    expect(legacyHomeWarning(both)).toBeNull();
    expect(legacyHomeWarning({ HOME: '/synthetic/home' })).toBeNull();
  });

  it('checks socket path length', () => {
    expect(socketPathOk('/a/run/hooks.sock')).toBe(true);
    expect(socketPathOk(`/${'x'.repeat(MAX_SOCKET_PATH)}`)).toBe(false);
  });
});

describe('state dirs and atomic writes', () => {
  it('creates the state dirs with mode 0700', async () => {
    const paths = resolvePaths({ env: { HOME: dir } });
    await ensureStateDirs(paths);
    for (const d of [paths.home, paths.runDir, paths.logsDir, paths.pushDir, paths.binDir]) {
      expect((await stat(d)).mode & 0o777).toBe(0o700);
    }
  });

  it('writes atomically with mode 0600 and leaves no temp files', async () => {
    const f = join(dir, 'a.json');
    await writeFileAtomic(f, '{"a":1}');
    await writeFileAtomic(f, '{"a":2}');
    expect(await readFile(f, 'utf8')).toBe('{"a":2}');
    expect((await stat(f)).mode & 0o777).toBe(0o600);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('can write through a symlink so other links keep pointing at the target', async () => {
    const target = join(dir, 'real.json');
    const link = join(dir, 'link.json');
    await writeFile(target, 'old');
    await symlink(target, link);
    await writeFileAtomic(link, 'new', { followSymlink: true, mode: 0o644 });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(target);
    expect(await readFile(target, 'utf8')).toBe('new');

    // without followSymlink the link itself is replaced by a file
    await writeFileAtomic(link, 'replaced');
    expect((await lstat(link)).isSymbolicLink()).toBe(false);
    expect(await readFile(target, 'utf8')).toBe('new');
  });
});

describe('settings', () => {
  it('returns defaults when config.json is missing', async () => {
    const r = await loadSettings({ configFile: join(dir, 'config.json') });
    expect(r).toEqual({ settings: defaultSettings(), exists: false });
  });

  it('returns defaults plus an error for bad JSON or a bad shape, and leaves the file alone', async () => {
    const configFile = join(dir, 'config.json');
    await writeFile(configFile, '{ nope');
    const bad = await loadSettings({ configFile });
    expect(bad.error).toMatch(/not valid JSON/);
    expect(bad.settings).toEqual(defaultSettings());
    expect(await readFile(configFile, 'utf8')).toBe('{ nope');

    await writeFile(configFile, JSON.stringify({ remote: { port: 'x' } }));
    expect((await loadSettings({ configFile })).error).toMatch(/remote\.port/);
  });

  it('round-trips through saveSettings with mode 0600', async () => {
    const configFile = join(dir, 'state', 'config.json');
    const s = defaultSettings();
    s.autoswitch.hold = [3];
    await saveSettings({ configFile }, s);
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
    expect((await loadSettings({ configFile })).settings.autoswitch.hold).toEqual([3]);
  });

  it('serializes concurrent patches and notifies subscribers', async () => {
    const configFile = join(dir, 'config.json');
    const store = await FileSettingsStore.open({ configFile });
    const seen: number[][] = [];
    store.subscribe((next) => seen.push(next.autoswitch.hold));
    const [a, b, c] = await Promise.all([
      store.patch({ autoswitch: { hold: [1] } }),
      store.patch({ notify: { mac: true } }),
      store.patch({ autoswitch: { bogus: true } }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(c).toMatchObject({ ok: false, path: 'autoswitch.bogus' });
    expect(store.get().autoswitch.hold).toEqual([1]);
    expect(store.get().notify.mac).toBe(true);
    expect(seen).toEqual([[1], [1]]);
    const reloaded = await loadSettings({ configFile });
    expect(reloaded.settings.notify.mac).toBe(true);
    expect(reloaded.settings.autoswitch.hold).toEqual([1]);
  });
});

describe('resolveBins', () => {
  it('prefers configured paths, then PATH, and reports missing tools as null', async () => {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    for (const name of ['cswap', 'osascript']) {
      await writeFile(join(bin, name), '#!/bin/sh\nexit 0\n');
      await chmod(join(bin, name), 0o755);
    }
    await writeFile(join(bin, 'lsof'), 'not executable');
    const settings = defaultSettings();
    const userHome = join(dir, 'home');
    const bins = await resolveBins({ settings, env: { PATH: bin }, userHome });
    expect(bins.cswap).toBe(join(bin, 'cswap'));
    expect(bins.osascript).toBe(join(bin, 'osascript'));
    expect(bins.node).toBe(process.execPath);
    expect(typeof bins.ps).toBe('string');

    settings.bins.cswap = join(dir, 'missing-cswap');
    const configured = await resolveBins({ settings, env: { PATH: bin }, userHome });
    expect(configured.cswap).toBeNull();

    const noPath = await resolveBins({ settings: defaultSettings(), env: { PATH: bin }, userHome, usePath: false });
    expect(noPath.cswap).not.toBe(join(bin, 'cswap'));
  });

  it("on Windows, claude.exe before npm's extensionless shim in the same folder", async () => {
    const bin = join(dir, 'winbin');
    await mkdir(bin);
    for (const name of ['claude', 'claude.exe']) {
      await writeFile(join(bin, name), '#!/bin/sh\nexit 0\n');
      await chmod(join(bin, name), 0o755);
    }
    const userHome = join(dir, 'home');
    expect((await resolveBins({ settings: defaultSettings(), env: { PATH: bin }, userHome, platform: 'win32' })).claude).toBe(join(bin, 'claude.exe'));
    expect((await resolveBins({ settings: defaultSettings(), env: { PATH: bin }, userHome, platform: 'linux' })).claude).toBe(join(bin, 'claude'));
  });

  it('finds Claude Code\'s older "local" install, which only a shell alias reaches', async () => {
    const userHome = join(dir, 'home');
    await mkdir(join(userHome, '.claude', 'local'), { recursive: true });
    await writeFile(join(userHome, '.claude', 'local', 'claude'), '#!/bin/sh\nexit 0\n');
    await chmod(join(userHome, '.claude', 'local', 'claude'), 0o755);
    const bins = await resolveBins({ settings: defaultSettings(), env: { PATH: join(dir, 'empty') }, userHome });
    expect(bins.claude).toBe(join(userHome, '.claude', 'local', 'claude'));
  });
});
