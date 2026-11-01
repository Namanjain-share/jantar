/**
 * v0.6 native Windows (preview): the hooks installer writes exec form on
 * win32, tested here with `platform: 'win32'` injected (the real installer
 * on a real Windows settings file runs only on windows-latest, W2 in
 * test/windows). macOS and Linux keep the shell form byte for byte.
 *
 * Exec form: Claude starts the program with its arguments, no shell, and a
 * hook that fails lets Claude's own dialog carry on (`onFailure: "continue"`).
 */
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { HOOK_CLIENT_PATH } from '@jantar/hook';
import { HOOK_EVENT_NAMES } from '@jantar/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ASYNC_TIMEOUT_S,
  BLOCKING_TIMEOUT_S,
  MIN_CLAUDE_WINDOWS,
  desiredGroup,
  execFormHook,
  guardRealFilesForTests,
  hooksStatus,
  installHookClient,
  installHooks,
  planInstall,
  uninstallHooks,
  windowsClaudeLine,
  type HooksFailure,
} from '../../src/hooks/installer.js';
import { tempDir } from './helpers.js';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const HOOK_BIN = 'C:\\Users\\Sam Smith\\.jantar\\bin\\jantar-hook';
const WIN = { node: NODE, hookBin: HOOK_BIN, platform: 'win32' } as const;

/** A Windows user's settings: another tool's hooks, one of them in exec form too. */
const SETTINGS = {
  cleanupPeriodDays: 30,
  env: { SYNTHETIC_FLAG: '1' },
  permissions: { allow: ['PowerShell(Get-ChildItem:*)'], defaultMode: 'default' },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'C:\\tools\\guard.exe', args: ['--check'] }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'C:\\tools\\notify.exe', args: ['C:\\tools\\jantar-hook-notes.txt'] }] }],
  },
  theme: 'dark',
};
const ORIGINAL = `${JSON.stringify(SETTINGS, null, 2)}\n`;
const NOW = () => new Date('2026-01-15T10:00:00.000Z');

let tmp: Awaited<ReturnType<typeof tempDir>>;
let settings: string;

function ok<T extends { ok: boolean }>(r: T | HooksFailure): T {
  if (!r.ok) throw new Error(`expected success, got ${(r as HooksFailure).code}: ${(r as HooksFailure).message}`);
  return r as T;
}

beforeEach(async () => {
  tmp = await tempDir('jantar-win-hooks-');
  settings = join(tmp.dir, 'settings.json');
  await writeFile(settings, ORIGINAL, { mode: 0o600 });
});

afterEach(async () => {
  await tmp.cleanup();
});

describe('exec-form hooks (win32)', () => {
  it('the blocking PermissionRequest hook and an async one, key for key', () => {
    expect(JSON.stringify(execFormHook(WIN, true))).toBe(
      '{"type":"command","command":"C:\\\\Program Files\\\\nodejs\\\\node.exe","args":["C:\\\\Users\\\\Sam Smith\\\\.jantar\\\\bin\\\\jantar-hook","--wait"],"onFailure":"continue","timeout":86400}',
    );
    expect(JSON.stringify(execFormHook(WIN, false))).toBe(
      '{"type":"command","command":"C:\\\\Program Files\\\\nodejs\\\\node.exe","args":["C:\\\\Users\\\\Sam Smith\\\\.jantar\\\\bin\\\\jantar-hook"],"onFailure":"continue","async":true,"timeout":5}',
    );
    expect(BLOCKING_TIMEOUT_S).toBe(86_400);
    expect(ASYNC_TIMEOUT_S).toBe(5);
  });

  it('every event gets its group in exec form, matchers as on the Mac', () => {
    for (const ev of HOOK_EVENT_NAMES) {
      const group = desiredGroup(ev, WIN);
      const hook = ev === 'PermissionRequest' ? execFormHook(WIN, true) : execFormHook(WIN, false);
      const mac = desiredGroup(ev, { node: '/synthetic/node', hookBin: '/synthetic/home/.jantar/bin/jantar-hook', platform: 'darwin' });
      expect(group).toEqual({ ...('matcher' in mac ? { matcher: mac.matcher } : {}), hooks: [hook] });
    }
  });

  it('takes any full Windows path (spaces, $ and backquotes need no quoting without a shell), and refuses the rest', async () => {
    for (const spec of [
      { node: 'D:\\node\\NODE.EXE', hookBin: 'C:/Users/user/.jantar/bin/jantar-hook' },
      { node: NODE, hookBin: 'C:\\Users\\$am`x\\.jantar\\bin\\jantar-hook' },
      { node: NODE, hookBin: '\\\\server\\share\\jantar\\bin\\jantar-hook' },
    ]) {
      expect(ok(await planInstall({ settingsPath: settings, ...spec, platform: 'win32' })).changed).toBe(true);
    }
    for (const [node, hookBin] of [
      ['node.exe', HOOK_BIN],
      ['/usr/local/bin/node', HOOK_BIN],
      ['C:\\Program Files\\nodejs\\node', HOOK_BIN],
      ['C:\\Users\\Sam\\AppData\\Roaming\\npm\\node.cmd', HOOK_BIN],
      [NODE, '\\Users\\Sam\\.jantar\\bin\\jantar-hook'],
      [NODE, 'C:jantar-hook'],
      [NODE, 'C:\\Users\\Sam\\.jantar\\bin\\jantar-hook"'],
      [NODE, 'C:\\Users\\Sam\\.jantar\\bin\\jantar-hook\n'],
      [NODE, ''],
    ] as const) {
      const r = await installHooks({ settingsPath: settings, node, hookBin, platform: 'win32', now: NOW });
      expect(r.ok, `${node} ${hookBin}`).toBe(false);
      expect((r as HooksFailure).code).toBe('unsafe_path');
    }
    expect(await readFile(settings, 'utf8')).toBe(ORIGINAL);
  });
});

describe('hooks install and uninstall on a Windows settings file', () => {
  it("adds ours to every event beside the other tool's exec-form hooks, idempotently, and uninstall gives the file back byte for byte", async () => {
    const res = ok(await installHooks({ settingsPath: settings, ...WIN, now: NOW }));
    expect(res.written).toBe(true);
    expect([...res.events].sort()).toEqual([...HOOK_EVENT_NAMES].sort());
    const after = JSON.parse(await readFile(settings, 'utf8'));
    expect(after.hooks.PreToolUse[0]).toEqual(SETTINGS.hooks.PreToolUse[0]);
    expect(after.hooks.Stop).toEqual([SETTINGS.hooks.Stop[0], { hooks: [execFormHook(WIN, false)] }]);
    expect(after.hooks.PermissionRequest).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: NODE, args: [HOOK_BIN, '--wait'], onFailure: 'continue', timeout: 86400 }] },
    ]);
    for (const ev of HOOK_EVENT_NAMES) expect(after.hooks[ev].at(-1)).toEqual(desiredGroup(ev, WIN));

    const again = ok(await installHooks({ settingsPath: settings, ...WIN, now: NOW }));
    expect(again.changed).toBe(false);
    expect(again.written).toBe(false);

    const st = await hooksStatus({ settingsPath: settings, ...WIN });
    expect(st.state).toBe('installed');
    expect(st.events.every((e) => e.state === 'ok')).toBe(true);
    expect(st.command).toBe(`"${NODE}" "${HOOK_BIN}"`);
    expect(st.minClaude).toBe(MIN_CLAUDE_WINDOWS);

    const removed = ok(await uninstallHooks({ settingsPath: settings, platform: 'win32', now: NOW }));
    expect([...removed.events].sort()).toEqual([...HOOK_EVENT_NAMES].sort());
    expect(await readFile(settings, 'utf8')).toBe(ORIGINAL);
    expect((await hooksStatus({ settingsPath: settings, ...WIN })).state).toBe('not-installed');
  });

  it("an exec-form entry running the old ccw-v2-hook is Jantar's: install replaces it, uninstall removes it", async () => {
    const legacyBin = 'C:\\Users\\Sam\\.ccw-v2\\bin\\ccw-v2-hook';
    const legacy = structuredClone(SETTINGS) as Omit<typeof SETTINGS, 'hooks'> & { hooks: Record<string, unknown[]> };
    legacy.hooks.PermissionRequest = [{ matcher: '*', hooks: [{ type: 'command', command: NODE, args: [legacyBin, '--wait'], timeout: 86400 }] }];
    legacy.hooks.Stop = [...SETTINGS.hooks.Stop, { hooks: [{ type: 'command', command: NODE, args: [legacyBin], async: true }] }];
    await writeFile(settings, `${JSON.stringify(legacy, null, 2)}\n`);
    const before = await hooksStatus({ settingsPath: settings, ...WIN });
    expect(before.events.find((e) => e.event === 'PermissionRequest')?.state).toBe('outdated');
    expect(before.events.find((e) => e.event === 'Stop')?.state).toBe('outdated');

    ok(await installHooks({ settingsPath: settings, ...WIN, now: NOW }));
    const after = JSON.parse(await readFile(settings, 'utf8'));
    expect(after.hooks.PermissionRequest).toEqual([desiredGroup('PermissionRequest', WIN)]);
    expect(after.hooks.Stop).toEqual([SETTINGS.hooks.Stop[0], desiredGroup('Stop', WIN)]);
    expect(JSON.stringify(after)).not.toContain('ccw-v2-hook');
    expect((await hooksStatus({ settingsPath: settings, ...WIN })).state).toBe('installed');

    await writeFile(settings, `${JSON.stringify(legacy, null, 2)}\n`);
    ok(await uninstallHooks({ settingsPath: settings, platform: 'win32', now: NOW }));
    expect(await readFile(settings, 'utf8')).toBe(ORIGINAL);
  });

  it('with a node path the exec form refuses (a .cmd shim), the status has no command, every installed event reads outdated, and still names the minimum Claude', async () => {
    ok(await installHooks({ settingsPath: settings, ...WIN, now: NOW }));
    const st = await hooksStatus({ settingsPath: settings, ...WIN, node: 'C:\\Users\\Sam\\AppData\\Roaming\\npm\\node.cmd' });
    expect(st.command).toBe('');
    expect(st.events.every((e) => e.state === 'outdated')).toBe(true);
    expect(st.state).toBe('outdated');
    expect(st.minClaude).toBe(MIN_CLAUDE_WINDOWS);
  });

  it('a moved node.exe reads as outdated, and install brings it up to date', async () => {
    ok(await installHooks({ settingsPath: settings, ...WIN, now: NOW }));
    const moved = { ...WIN, node: 'C:\\nvm\\v22.13.0\\node.exe' };
    expect((await hooksStatus({ settingsPath: settings, ...moved })).state).toBe('outdated');
    ok(await installHooks({ settingsPath: settings, ...moved, now: NOW }));
    expect((await hooksStatus({ settingsPath: settings, ...moved })).state).toBe('installed');
  });

  it("recognises both forms as Jantar's on any platform: either replaces the other, and uninstall anywhere removes both", async () => {
    const shell = { node: '/synthetic/node', hookBin: '/synthetic/home/.jantar/bin/jantar-hook', platform: 'linux' } as const;
    ok(await installHooks({ settingsPath: settings, ...shell, now: NOW }));
    ok(await installHooks({ settingsPath: settings, ...WIN, now: NOW }));
    const after = JSON.parse(await readFile(settings, 'utf8'));
    for (const ev of HOOK_EVENT_NAMES) {
      const ours = after.hooks[ev].flatMap((g: { hooks: Array<{ args?: string[]; command: string }> }) => g.hooks).filter((h: { command: string }) => h.command === NODE || h.command.includes('jantar-hook'));
      expect(ours, ev).toEqual([ev === 'PermissionRequest' ? execFormHook(WIN, true) : execFormHook(WIN, false)]);
    }
    // Back to the shell form (a WSL install of the same file), then removed from a Mac.
    ok(await installHooks({ settingsPath: settings, ...shell, now: NOW }));
    expect((await hooksStatus({ settingsPath: settings, ...shell })).state).toBe('installed');
    ok(await uninstallHooks({ settingsPath: settings, platform: 'darwin', now: NOW }));
    expect(await readFile(settings, 'utf8')).toBe(ORIGINAL);
  });
});

describe('the shell form stays as it was on macOS and Linux', () => {
  it('byte for byte, and the status names no minimum Claude', async () => {
    const spec = { node: '/synthetic/node/bin/node', hookBin: '/synthetic/home/.jantar/bin/jantar-hook' };
    for (const platform of ['darwin', 'linux'] as const) {
      expect(JSON.stringify(desiredGroup('PermissionRequest', { ...spec, platform }))).toBe(
        '{"matcher":"*","hooks":[{"type":"command","command":"\\"/synthetic/node/bin/node\\" \\"/synthetic/home/.jantar/bin/jantar-hook\\" --wait","timeout":86400}]}',
      );
      expect(JSON.stringify(desiredGroup('Stop', { ...spec, platform }))).toBe(
        '{"hooks":[{"type":"command","command":"\\"/synthetic/node/bin/node\\" \\"/synthetic/home/.jantar/bin/jantar-hook\\"","async":true,"timeout":5}]}',
      );
    }
    // With no platform given, this host's own (darwin or linux here) is the shell form.
    expect(desiredGroup('PreToolUse', spec)).toEqual(desiredGroup('PreToolUse', { ...spec, platform: 'linux' }));
    const st = await hooksStatus({ settingsPath: settings, ...spec, platform: 'darwin' });
    expect(st.command).toBe('"/synthetic/node/bin/node" "/synthetic/home/.jantar/bin/jantar-hook"');
    expect('minClaude' in st).toBe(false);
  });
});

describe('Windows details', () => {
  it('names the minimum Claude Code, and says when the one there is older', () => {
    expect(MIN_CLAUDE_WINDOWS).toBe('2.1.310');
    const fine = 'On Windows the cards need Claude Code 2.1.310 or later.';
    for (const v of [undefined, null, '', 'unknown', '2.1.310 (Claude Code)', '2.1.311', '2.2.0', '3.0.0', '10.0.0']) expect(windowsClaudeLine(v), String(v)).toBe(fine);
    for (const v of ['2.1.300 (Claude Code)', '2.1.31', '2.0.999', '1.9.400']) {
      expect(windowsClaudeLine(v)).toBe(`Claude Code ${v.split(' ')[0]} is too old for the cards on Windows: they need 2.1.310 or later (claude update).`);
    }
  });

  it('the copied hook client counts as current whatever its mode, as Windows has none', async () => {
    const hookBin = join(tmp.dir, 'bin', 'jantar-hook');
    expect((await installHookClient({ hookBin, source: HOOK_CLIENT_PATH, platform: 'win32' })).changed).toBe(true);
    await chmod(hookBin, 0o644);
    expect((await installHookClient({ hookBin, source: HOOK_CLIENT_PATH, platform: 'win32' })).changed).toBe(false);
    // Elsewhere the mode is put back to 0700.
    expect((await installHookClient({ hookBin, source: HOOK_CLIENT_PATH, platform: 'linux' })).changed).toBe(true);
  });

  it("a test run refuses the real user's Claude settings in a Windows spelling too", () => {
    const home = userInfo().homedir;
    expect(() => guardRealFilesForTests(`${join(home, '.claude')}\\settings.json`, 'Claude settings')).toThrow(/refusing to write/);
    expect(() => guardRealFilesForTests(join(tmp.dir, 'settings.json'), 'Claude settings')).not.toThrow();
  });
});
