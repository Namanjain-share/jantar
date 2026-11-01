/**
 * v0.6 Fleet, config.ts: the paths a hub and a node use, the role, cswap's
 * folder per platform, the named pipes that stand for the Unix sockets on
 * Windows (one name for every spelling of the state dir, as the hook client
 * derives it), the accounts mode on a node, and state dirs whose chmod
 * fails on Windows.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cswapRootFor, ensureStateDirs, isPipePath, pipePath, resolveAccountsMode, resolvePaths, roleOf, socketPathOk } from '../../src/config.js';

const failChmod = vi.hoisted(() => ({ on: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    chmod: async (...args: Parameters<typeof real.chmod>) => {
      if (failChmod.on) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return real.chmod(...args);
    },
  };
});

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'jantar-v06-paths-')));
  failChmod.on = false;
});
afterEach(async () => {
  failChmod.on = false;
  await rm(dir, { recursive: true, force: true });
});

describe('v0.6: pipe names on Windows', () => {
  it('give one name for every spelling of the state dir, one per kind', () => {
    const spellings = ['C:\\Users\\Sam\\.jantar', 'c:/users/sam/.jantar/', 'C:\\Users\\Sam\\.jantar\\', 'c:\\USERS\\sam\\.JANTAR', 'C:/Users/user/../Sam/.jantar'];
    const hooks = new Set(spellings.map((s) => pipePath(s, 'hooks')));
    const ctl = new Set(spellings.map((s) => pipePath(s, 'ctl')));
    expect(hooks.size).toBe(1);
    expect(ctl.size).toBe(1);
    const [h] = [...hooks];
    const [c] = [...ctl];
    expect(h).toMatch(/^\\\\\.\\pipe\\jantar-[0-9a-f]{16}-hooks$/);
    expect(c).toMatch(/^\\\\\.\\pipe\\jantar-[0-9a-f]{16}-ctl$/);
    expect(h?.slice(0, -'hooks'.length)).toBe(c?.slice(0, -'ctl'.length));
    // Another state dir, another name.
    expect(pipePath('C:\\Users\\Sam\\.jantar-test', 'hooks')).not.toBe(h);
    expect(isPipePath(h ?? '')).toBe(true);
    expect(isPipePath('/tmp/x/run/hooks.sock')).toBe(false);
    expect(socketPathOk(`${h}${'x'.repeat(200)}`)).toBe(true);
  });

  it('are the sockets resolvePaths gives on win32 only', () => {
    const env = { HOME: '/synthetic/home', JANTAR_HOME: '/synthetic/home/.jantar' };
    const win = resolvePaths({ env, platform: 'win32' });
    expect(isPipePath(win.hooksSock)).toBe(true);
    expect(isPipePath(win.ctlSock)).toBe(true);
    const mac = resolvePaths({ env, platform: 'darwin' });
    expect(mac.hooksSock).toBe('/synthetic/home/.jantar/run/hooks.sock');
    expect(mac.ctlSock).toBe('/synthetic/home/.jantar/run/ctl.sock');
    expect(resolvePaths({ env, platform: 'linux' }).ctlSock).toBe(mac.ctlSock);
  });
});

describe("v0.6: cswap's folder per platform", () => {
  it('is ~/.claude-swap-backup on macOS and Windows', () => {
    expect(cswapRootFor('/home/sam', {}, 'darwin')).toBe('/home/sam/.claude-swap-backup');
    expect(cswapRootFor('/home/sam', {}, 'win32')).toBe('/home/sam/.claude-swap-backup');
  });

  it("on Linux is ${XDG_DATA_HOME:-~/.local/share}/claude-swap while it exists, else as before", async () => {
    const home = join(dir, 'home');
    await mkdir(join(home, '.claude-swap-backup'), { recursive: true });
    expect(cswapRootFor(home, {}, 'linux')).toBe(join(home, '.claude-swap-backup'));
    await mkdir(join(home, '.local', 'share', 'claude-swap'), { recursive: true });
    expect(cswapRootFor(home, {}, 'linux')).toBe(join(home, '.local', 'share', 'claude-swap'));
    const xdg = join(dir, 'xdg');
    await mkdir(join(xdg, 'claude-swap'), { recursive: true });
    expect(cswapRootFor(home, { XDG_DATA_HOME: xdg }, 'linux')).toBe(join(xdg, 'claude-swap'));
    // A relative XDG_DATA_HOME is ignored, as the spec says.
    expect(cswapRootFor(home, { XDG_DATA_HOME: 'rel' }, 'linux')).toBe(join(home, '.local', 'share', 'claude-swap'));
    const paths = resolvePaths({ env: { HOME: home }, platform: 'linux' });
    expect(paths.cswapRoot).toBe(join(home, '.local', 'share', 'claude-swap'));
    expect(paths.cswapProfiles).toBe(join(home, '.local', 'share', 'claude-swap', 'sessions'));
  });
});

describe('v0.6: Fleet paths and the role', () => {
  it('keeps the hub key and the node file under the state dir', () => {
    const p = resolvePaths({ env: { HOME: '/synthetic/home', JANTAR_HOME: '/synthetic/state' } });
    expect(p.fleetDir).toBe('/synthetic/state/fleet');
    expect(p.hubKeyFile).toBe('/synthetic/state/fleet/hub-key.pem');
    expect(p.nodeDir).toBe('/synthetic/state/node');
    expect(p.nodeFile).toBe('/synthetic/state/node/node.json');
  });

  it('is a node when node.json exists, else the hub', async () => {
    const p = resolvePaths({ env: { HOME: dir, JANTAR_HOME: join(dir, 'state') } });
    expect(roleOf(p)).toBe('hub');
    await mkdir(p.nodeDir, { recursive: true });
    await writeFile(p.nodeFile, '{}');
    expect(roleOf(p)).toBe('node');
  });
});

describe('v0.6: the accounts mode on a node', () => {
  it('is dirs on Windows, dirs on Linux without cswap, cswap with it; the hub keeps its rule', async () => {
    const profiles = join(dir, 'profiles');
    const none = { cswapProfiles: join(dir, 'missing') };
    expect(resolveAccountsMode({ cswap: null }, none, {}, { role: 'node', platform: 'win32' })).toBe('dirs');
    expect(resolveAccountsMode({ cswap: '/usr/bin/cswap' }, none, {}, { role: 'node', platform: 'win32' })).toBe('dirs');
    expect(resolveAccountsMode({ cswap: null }, none, {}, { role: 'node', platform: 'linux' })).toBe('dirs');
    await mkdir(profiles);
    expect(resolveAccountsMode({ cswap: '/usr/bin/cswap' }, { cswapProfiles: profiles }, {}, { role: 'node', platform: 'linux' })).toBe('cswap');
    expect(resolveAccountsMode({ cswap: null }, none, {}, { role: 'node', platform: 'darwin' })).toBe('single');
    expect(resolveAccountsMode({ cswap: null }, none, {}, { role: 'hub', platform: 'linux' })).toBe('single');
    expect(resolveAccountsMode({ cswap: null }, none, {})).toBe('single');
    expect(resolveAccountsMode({ cswap: '/usr/bin/cswap' }, { cswapProfiles: profiles }, { JANTAR_ACCOUNTS: 'single' }, { role: 'node', platform: 'linux' })).toBe('single');
  });
});

describe('v0.6: state dirs on Windows', () => {
  it('a failing chmod is no error there, and still one elsewhere', async () => {
    const paths = resolvePaths({ env: { HOME: dir, JANTAR_HOME: join(dir, 'state') } });
    failChmod.on = true;
    await expect(ensureStateDirs(paths, 'win32')).resolves.toBeUndefined();
    await expect(ensureStateDirs(paths, 'linux')).rejects.toThrow(/EPERM/);
  });
});
