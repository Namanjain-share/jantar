/**
 * Acceptance gate 3: the installer, run against a copy of a realistic
 * settings.json in a temp dir (never the real ~/.claude/settings.json).
 *
 * The fixture mirrors the shape of a real Claude settings file (keys, nesting,
 * a PreToolUse hook of another tool, 2-space indent, mode 0600) with every
 * value made up.
 */
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { HOOK_CLIENT_PATH } from '@jantar/hook';
import { HOOK_EVENT_NAMES } from '@jantar/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../../src/config.js';
import type { Paths } from '../../src/contracts.js';
import { runHooksCommand } from '../../src/hooks/cli.js';
import {
  desiredGroup,
  hookCommandLine,
  hooksStatus,
  installHookClient,
  installHooks,
  isOurCommand,
  listBackups,
  planInstall,
  uninstallHooks,
  type HooksFailure,
  type HooksWritten,
} from '../../src/hooks/installer.js';
import { tempDir } from './helpers.js';

const REALISTIC = {
  cleanupPeriodDays: 3650,
  env: { SYNTHETIC_FLAG: '1', SYNTHETIC_OTHER_SETTING: 'value-for-tests' },
  attribution: { commit: '', pr: '', sessionUrl: false },
  permissions: {
    allow: ['Bash(npm test:*)', 'Bash(git status)', 'WebFetch(domain:example.com)', 'Read(//synthetic/home/work/**)'],
    defaultMode: 'acceptEdits',
  },
  model: 'synthetic-model',
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }],
  },
  enabledPlugins: { 'example-plugin@example-marketplace': true, 'other-plugin@example-marketplace': false },
  extraKnownMarketplaces: { 'example-marketplace': { source: { source: 'github', repo: 'example-org/example-plugins' } } },
  effortLevel: 'high',
  modelSettings: { 'synthetic-model': { effortLevel: 'high' } },
  tui: 'default',
  skipDangerousModePermissionPrompt: true,
  skipWorkflowUsageWarning: true,
  theme: 'dark',
  switchModelsOnFlag: false,
  agentPushNotifEnabled: false,
  autoMode: { environment: ['SYNTHETIC_ENV_ONE', 'SYNTHETIC_ENV_TWO'] },
};
const ORIGINAL = `${JSON.stringify(REALISTIC, null, 2)}\n`;
const NOW = () => new Date('2026-01-15T10:00:00.000Z');

let tmp: Awaited<ReturnType<typeof tempDir>>;
let home: string;
let settings: string;
let profiles: string;
let paths: Paths;
const node = process.execPath;
let hookBin: string;

function ok<T extends { ok: boolean }>(r: T | HooksFailure): T {
  if (!r.ok) throw new Error(`expected success, got ${(r as HooksFailure).code}: ${(r as HooksFailure).message}`);
  return r as T;
}

/** Remove our entries from a parsed settings object (independent of the code under test). */
function withoutOurs(data: Record<string, unknown>): Record<string, unknown> {
  const hooks = data.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  const out: Record<string, unknown> = {};
  for (const [ev, groups] of Object.entries(hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((x) => !x.command.includes('/bin/jantar-hook')) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) out[ev] = kept;
  }
  return { ...data, hooks: out };
}

beforeEach(async () => {
  tmp = await tempDir('jantar-inst-');
  home = join(tmp.dir, 'home');
  paths = resolvePaths({ env: { HOME: home }, userHome: home, home: join(tmp.dir, 'state') });
  settings = paths.claudeSettings;
  profiles = paths.cswapProfiles;
  hookBin = paths.hookBin;
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(settings, ORIGINAL, { mode: 0o600 });
  await chmod(settings, 0o600);
  // cswap profiles: three share the settings file through a symlink, one has its own
  for (const name of ['2-profile-b', '3-profile-c', '4-profile-d', '5-profile-e']) {
    await mkdir(join(profiles, name), { recursive: true });
    if (name === '5-profile-e') await writeFile(join(profiles, name, 'settings.json'), '{}\n');
    else await symlink(settings, join(profiles, name, 'settings.json'));
  }
});

afterEach(async () => {
  await tmp.cleanup();
});

describe('hooks install', () => {
  it('keeps every key and the other tool\'s PreToolUse entry, and adds ours to every event', async () => {
    const res = ok(await installHooks({ settingsPath: settings, node, hookBin, now: NOW }));
    expect(res.written).toBe(true);
    expect([...res.events].sort()).toEqual([...HOOK_EVENT_NAMES].sort());
    const after = JSON.parse(await readFile(settings, 'utf8'));

    expect(Object.keys(after)).toEqual(Object.keys(REALISTIC));
    expect(after.cleanupPeriodDays).toBe(3650);
    expect(withoutOurs(after)).toEqual(REALISTIC);
    expect(after.hooks.PreToolUse[0]).toEqual(REALISTIC.hooks.PreToolUse[0]);

    const cmd = `"${node}" "${hookBin}"`;
    expect(hookCommandLine({ node, hookBin })).toBe(cmd);
    for (const ev of HOOK_EVENT_NAMES) {
      const groups = after.hooks[ev];
      const ours = groups.at(-1);
      expect(ours).toEqual(desiredGroup(ev, { node, hookBin }));
    }
    expect(after.hooks.PermissionRequest).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: `${cmd} --wait`, timeout: 86400 }] },
    ]);
    expect(after.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: cmd, async: true, timeout: 5 }] }]);
    expect(after.hooks.PreToolUse[1]).toEqual({ matcher: '*', hooks: [{ type: 'command', command: cmd, async: true, timeout: 5 }] });
    for (const ev of ['PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'Notification']) expect(after.hooks[ev][0].matcher).toBe('*');
    for (const ev of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact']) {
      expect(after.hooks[ev][0].matcher).toBeUndefined();
    }
  });

  it('writes the real file atomically: profile symlinks keep resolving to it, mode and format are kept', async () => {
    const before = await stat(settings);
    ok(await installHooks({ settingsPath: settings, node, hookBin, now: NOW }));
    const st = await lstat(settings);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.ino).not.toBe(before.ino); // replaced by rename, not edited in place
    const text = await readFile(settings, 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.split('\n')[1]).toBe('  "cleanupPeriodDays": 3650,');
    for (const name of ['2-profile-b', '3-profile-c', '4-profile-d']) {
      const link = join(profiles, name, 'settings.json');
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await realpath(link)).toBe(await realpath(settings));
      expect(await readFile(link, 'utf8')).toBe(text);
    }
    expect(await readFile(join(profiles, '5-profile-e', 'settings.json'), 'utf8')).toBe('{}\n');
    // no temp files left behind
    expect((await readdir(join(home, '.claude'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('backs up the exact original bytes (0600) before writing', async () => {
    const res = ok(await installHooks({ settingsPath: settings, node, hookBin, now: NOW }));
    expect(res.backupPath).toBe(`${await realpath(settings)}.jantar-backup-2026-01-15T10-00-00-000Z`);
    expect(await readFile(res.backupPath as string, 'utf8')).toBe(ORIGINAL);
    expect((await stat(res.backupPath as string)).mode & 0o777).toBe(0o600);
  });

  it('shows a diff that only adds lines (plus commas and brackets)', async () => {
    const plan = ok(await planInstall({ settingsPath: settings, node, hookBin }));
    expect(plan.changed).toBe(true);
    expect(await readFile(settings, 'utf8')).toBe(ORIGINAL); // planning writes nothing
    const lines = plan.diff.split('\n');
    expect(lines[0]).toMatch(/^--- .*settings\.json \(current\)$/);
    expect(lines[1]).toMatch(/^\+\+\+ .*settings\.json \(after install\)$/);
    const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---'));
    for (const l of removed) expect(l).toMatch(/^-\s*[\]}],?$/);
    expect(lines.filter((l) => l.startsWith('+') && l.includes('jantar-hook')).length).toBe(HOOK_EVENT_NAMES.length);
    expect(plan.diff).toContain('--wait');
  });

  it('is idempotent: a second install changes nothing and makes no backup', async () => {
    ok(await installHooks({ settingsPath: settings, node, hookBin, now: NOW }));
    const text = await readFile(settings, 'utf8');
    const again = ok(await installHooks({ settingsPath: settings, node, hookBin, now: NOW }));
    expect(again.changed).toBe(false);
    expect(again.written).toBe(false);
    expect(await readFile(settings, 'utf8')).toBe(text);
    expect(await listBackups(settings)).toHaveLength(1);
  });

  it('replaces our own outdated entries (new node path) and removes strays, leaving one entry per event', async () => {
    ok(await installHooks({ settingsPath: settings, node: '/old/node/bin/node', hookBin, now: NOW }));
    const data = JSON.parse(await readFile(settings, 'utf8'));
    data.hooks.FutureEvent = [{ hooks: [{ type: 'command', command: `"/old/node/bin/node" "${hookBin}"`, async: true, timeout: 5 }] }];
    data.hooks.Stop.push({ hooks: [{ type: 'command', command: `"/old/node/bin/node" "${hookBin}"` }] });
    await writeFile(settings, `${JSON.stringify(data, null, 2)}\n`);
    let st = await hooksStatus({ settingsPath: settings, node, hookBin });
    expect(st.state).toBe('outdated');
    expect(st.strayEntries).toBe(1);
    expect(st.events.find((e) => e.event === 'Stop')?.state).toBe('duplicate');

    ok(await installHooks({ settingsPath: settings, node, hookBin, now: NOW }));
    const after = JSON.parse(await readFile(settings, 'utf8'));
    expect(after.hooks.FutureEvent).toBeUndefined();
    expect(after.hooks.PreToolUse).toHaveLength(2);
    expect(after.hooks.PreToolUse[0]).toEqual(REALISTIC.hooks.PreToolUse[0]);
    for (const ev of HOOK_EVENT_NAMES) {
      const ours = after.hooks[ev].flatMap((g: { hooks: { command: string }[] }) => g.hooks).filter((x: { command: string }) => isOurCommand(x.command));
      expect(ours).toHaveLength(1);
      expect(ours[0].command.startsWith(`"${node}"`)).toBe(true);
    }
    st = await hooksStatus({ settingsPath: settings, node, hookBin });
    expect(st.state).toBe('installed');
  });

  it('replaces the entries ccw-v2 (the old name) installed, and an uninstall removes them too', async () => {
    // What v0.3 wrote: the same groups, calling <home>/.ccw-v2/bin/ccw-v2-hook.
    const legacyBin = join(home, '.ccw-v2', 'bin', 'ccw-v2-hook');
    ok(await installHooks({ settingsPath: settings, node, hookBin: legacyBin, now: NOW }));
    const st = await hooksStatus({ settingsPath: settings, node, hookBin });
    expect(st.state).toBe('outdated');
    expect(st.events.every((e) => e.state === 'outdated')).toBe(true);

    const res = ok(await installHooks({ settingsPath: settings, node, hookBin, now: NOW }));
    expect([...res.events].sort()).toEqual([...HOOK_EVENT_NAMES].sort());
    const text = await readFile(settings, 'utf8');
    expect(text).not.toContain('ccw-v2-hook');
    const after = JSON.parse(text);
    expect(withoutOurs(after)).toEqual(REALISTIC);
    for (const ev of HOOK_EVENT_NAMES) expect(after.hooks[ev].at(-1)).toEqual(desiredGroup(ev, { node, hookBin }));
    expect((await hooksStatus({ settingsPath: settings, node, hookBin })).state).toBe('installed');

    // Left alone, old entries are still ours to remove.
    ok(await installHooks({ settingsPath: settings, node, hookBin: legacyBin, now: NOW }));
    ok(await uninstallHooks({ settingsPath: settings, now: NOW }));
    expect(await readFile(settings, 'utf8')).toBe(ORIGINAL);
  });

  it('follows a profile symlink to the real file and keeps the link', async () => {
    const link = join(profiles, '3-profile-c', 'settings.json');
    const res = ok(await installHooks({ settingsPath: link, node, hookBin, now: NOW }));
    expect(res.isSymlink).toBe(true);
    expect(res.realPath).toBe(await realpath(settings));
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(settings, 'utf8')).hooks.Stop).toBeDefined();
  });

  it('creates a missing settings file (0600) with only the hooks', async () => {
    const fresh = join(tmp.dir, 'fresh', '.claude', 'settings.json');
    const res = ok(await installHooks({ settingsPath: fresh, node, hookBin, now: NOW }));
    expect(res.written).toBe(true);
    expect(res.backupPath).toBeUndefined();
    expect(Object.keys(JSON.parse(await readFile(fresh, 'utf8')))).toEqual(['hooks']);
    expect((await stat(fresh)).mode & 0o777).toBe(0o600);
    ok(await uninstallHooks({ settingsPath: fresh, now: NOW }));
    expect(JSON.parse(await readFile(fresh, 'utf8'))).toEqual({});
  });

  it('keeps tab indentation, a minified file, and a missing trailing newline', async () => {
    const tabbed = `${JSON.stringify(REALISTIC, null, '\t')}`;
    await writeFile(settings, tabbed);
    ok(await installHooks({ settingsPath: settings, node, hookBin, now: NOW }));
    const t = await readFile(settings, 'utf8');
    expect(t.split('\n')[1]).toBe('\t"cleanupPeriodDays": 3650,');
    expect(t.endsWith('}')).toBe(true);
    ok(await uninstallHooks({ settingsPath: settings, now: NOW }));
    expect(await readFile(settings, 'utf8')).toBe(tabbed);

    const mini = `${JSON.stringify(REALISTIC)}\n`;
    await writeFile(settings, mini);
    ok(await installHooks({ settingsPath: settings, node, hookBin, now: NOW }));
    expect((await readFile(settings, 'utf8')).split('\n')).toHaveLength(2);
    ok(await uninstallHooks({ settingsPath: settings, now: NOW }));
    expect(await readFile(settings, 'utf8')).toBe(mini);
  });
});

describe('hooks uninstall', () => {
  it('restores the file byte for byte (minus our entries), and the symlinks still resolve', async () => {
    ok(await installHooks({ settingsPath: settings, node, hookBin, now: NOW }));
    const res = ok<HooksWritten>(await uninstallHooks({ settingsPath: settings, now: () => new Date('2026-01-15T10:05:00.000Z') }));
    expect(res.written).toBe(true);
    expect([...res.events].sort()).toEqual([...HOOK_EVENT_NAMES].sort());
    expect(await readFile(settings, 'utf8')).toBe(ORIGINAL);
    expect((await stat(settings)).mode & 0o777).toBe(0o600);
    for (const name of ['2-profile-b', '3-profile-c', '4-profile-d']) {
      expect(await readFile(join(profiles, name, 'settings.json'), 'utf8')).toBe(ORIGINAL);
    }
    expect(await listBackups(settings)).toHaveLength(2);
    expect((await hooksStatus({ settingsPath: settings, node, hookBin })).state).toBe('not-installed');
    // nothing left to remove
    const again = ok(await uninstallHooks({ settingsPath: settings, now: NOW }));
    expect(again.changed).toBe(false);
  });

  it('removes the hooks key it created, and only our hooks from a shared group', async () => {
    const noHooks = { ...REALISTIC } as Record<string, unknown>;
    delete noHooks.hooks;
    const text = `${JSON.stringify(noHooks, null, 2)}\n`;
    await writeFile(settings, text);
    ok(await installHooks({ settingsPath: settings, node, hookBin, now: NOW }));
    const data = JSON.parse(await readFile(settings, 'utf8'));
    expect(Object.keys(data).at(-1)).toBe('hooks');
    // the user later adds their own hook into our Stop group
    data.hooks.Stop[0].hooks.push({ type: 'command', command: 'synthetic-notify --done' });
    await writeFile(settings, `${JSON.stringify(data, null, 2)}\n`);
    ok(await uninstallHooks({ settingsPath: settings, now: NOW }));
    const after = JSON.parse(await readFile(settings, 'utf8'));
    expect(after.hooks).toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'synthetic-notify --done' }] }] });
    expect(withoutOurs(after)).toEqual({ ...noHooks, hooks: after.hooks });
  });
});

describe('refusals', () => {
  it('refuses a file that does not parse, and writes nothing', async () => {
    const broken = '{ "cleanupPeriodDays": 3650, ';
    await writeFile(settings, broken);
    for (const r of [
      await installHooks({ settingsPath: settings, node, hookBin, now: NOW }),
      await uninstallHooks({ settingsPath: settings, now: NOW }),
    ]) {
      expect(r).toMatchObject({ ok: false, code: 'parse_error' });
    }
    expect(await readFile(settings, 'utf8')).toBe(broken);
    expect(await listBackups(settings)).toEqual([]);
    expect((await hooksStatus({ settingsPath: settings, node, hookBin })).state).toBe('unreadable');
  });

  it('refuses unexpected shapes', async () => {
    for (const bad of ['[]', '{"hooks": []}', '{"hooks": {"PreToolUse": {"matcher": "Bash"}}}', '"text"']) {
      await writeFile(settings, bad);
      const r = await installHooks({ settingsPath: settings, node, hookBin, now: NOW });
      expect(r).toMatchObject({ ok: false, code: 'invalid_shape' });
      expect(await readFile(settings, 'utf8')).toBe(bad);
    }
  });

  it('refuses when the file changed after the diff was made', async () => {
    const plan = ok(await planInstall({ settingsPath: settings, node, hookBin }));
    await writeFile(settings, ORIGINAL.replace('3650', '30'));
    const r = await installHooks({ settingsPath: settings, node, hookBin, expectedBefore: plan.before, now: NOW });
    expect(r).toMatchObject({ ok: false, code: 'changed' });
    expect(await readFile(settings, 'utf8')).toBe(ORIGINAL.replace('3650', '30'));
  });

  it('refuses unsafe or relative paths in the hook command', async () => {
    for (const [n, b] of [['/bad"node', hookBin], [node, '/tmp/$(evil)/jantar-hook'], ['node', hookBin]]) {
      const r = await installHooks({ settingsPath: settings, node: n as string, hookBin: b as string, now: NOW });
      expect(r).toMatchObject({ ok: false, code: 'unsafe_path' });
    }
    expect(await readFile(settings, 'utf8')).toBe(ORIGINAL);
  });

  it('a test run can never write under the real home', async () => {
    const { guardRealFilesForTests } = await import('../../src/hooks/installer.js');
    const realHome = userInfo().homedir;
    expect(() => guardRealFilesForTests(join(realHome, '.claude', 'settings.json'), 'x')).toThrow(/refusing/);
    expect(() => guardRealFilesForTests(join(realHome, '.jantar', 'bin', 'jantar-hook'), 'x')).toThrow(/refusing/);
    expect(() => guardRealFilesForTests(join(realHome, '.ccw-v2', 'bin', 'ccw-v2-hook'), 'x')).toThrow(/refusing/);
    expect(() => guardRealFilesForTests(settings, 'x')).not.toThrow();
  });
});

describe('recognising our entries', () => {
  it('matches the client by its path, under any node and install location', () => {
    expect(isOurCommand(`"${node}" "${hookBin}"`)).toBe(true);
    expect(isOurCommand(`"${node}" "${hookBin}" --wait`)).toBe(true);
    expect(isOurCommand('/usr/local/bin/node /somewhere/else/.jantar/bin/jantar-hook')).toBe(true);
    expect(isOurCommand('jantar-hook --wait')).toBe(true);
    expect(isOurCommand('"/usr/local/bin/node" "/synthetic/home/.ccw-v2/bin/ccw-v2-hook" --wait')).toBe(true);
    expect(isOurCommand('/x/bin/my-ccw-v2-hook')).toBe(false);
    expect(isOurCommand('rtk hook claude')).toBe(false);
    expect(isOurCommand('/x/.ccw/bin/ccw-hook')).toBe(false);
    expect(isOurCommand('/x/bin/jantar-hooks')).toBe(false);
    expect(isOurCommand('/x/bin/my-jantar-hook')).toBe(false);
  });
});

describe('status and the client file', () => {
  it('reports installed / not installed, the client copy and which profiles share the file', async () => {
    let st = await hooksStatus({ settingsPath: settings, node, hookBin, profilesDir: profiles });
    expect(st).toMatchObject({ ok: true, state: 'not-installed', hookBinPresent: false, isSymlink: false });
    expect(st.profiles).toEqual([
      { name: '2-profile-b', settings: 'linked' },
      { name: '3-profile-c', settings: 'linked' },
      { name: '4-profile-d', settings: 'linked' },
      { name: '5-profile-e', settings: 'separate' },
    ]);
    ok(await installHooks({ settingsPath: settings, node, hookBin, now: NOW }));
    const c = await installHookClient({ hookBin });
    expect(c.changed).toBe(true);
    expect((await stat(hookBin)).mode & 0o777).toBe(0o700);
    expect(await readFile(hookBin, 'utf8')).toBe(await readFile(HOOK_CLIENT_PATH, 'utf8'));
    expect((await installHookClient({ hookBin })).changed).toBe(false);
    st = await hooksStatus({ settingsPath: settings, node, hookBin });
    expect(st).toMatchObject({ state: 'installed', hookBinPresent: true, hookBinCurrent: true });
    expect(st.events.every((e) => e.state === 'ok')).toBe(true);

    // the installed, extensionless copy runs and fails open with no daemon
    const started = Date.now();
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(node, [hookBin], { env: { PATH: '', HOME: home, JANTAR_HOME: paths.home }, stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('close', resolve);
      child.stdin.end('{"hook_event_name":"Stop","session_id":"s"}');
    });
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('jantar hooks (command)', () => {
  function io(isTTY = false) {
    const o = {
      stdout: '',
      stderr: '',
      env: {},
      isTTY,
      out: (t: string) => {
        o.stdout += t;
      },
      err: (t: string) => {
        o.stderr += t;
      },
    };
    return o;
  }

  it('prints help and rejects bad usage', async () => {
    const a = io();
    expect(await runHooksCommand(['--help'], { io: a, paths, node })).toBe(0);
    expect(a.stdout).toContain('usage: jantar hooks <install|uninstall|status>');
    expect(await runHooksCommand([], { io: io(), paths, node })).toBe(2);
    expect(await runHooksCommand(['frob'], { io: io(), paths, node })).toBe(2);
    expect(await runHooksCommand(['install', '--force'], { io: io(), paths, node })).toBe(2);
    expect(await runHooksCommand(['install', '--settings'], { io: io(), paths, node })).toBe(2);
    expect(await runHooksCommand(['status', 'extra'], { io: io(), paths, node })).toBe(2);
    // "--" ends the options (the CLI wrapper may pass it through)
    const s = io();
    expect(await runHooksCommand(['--json', '--', 'status'], { io: s, paths, node })).toBe(0);
    expect(JSON.parse(s.stdout).state).toBe('not-installed');
  });

  it('install shows the diff and writes nothing without a yes', async () => {
    const a = io();
    expect(await runHooksCommand(['install'], { io: a, paths, node })).toBe(1);
    expect(a.stdout).toContain('+++ ');
    expect(a.stderr).toContain('Re-run with --yes');
    expect(await readFile(settings, 'utf8')).toBe(ORIGINAL);
    await expect(stat(hookBin)).rejects.toThrow();

    const asked: string[] = [];
    const b = io(true);
    expect(await runHooksCommand(['install'], { io: b, paths, node, ask: async (q) => (asked.push(q), false) })).toBe(1);
    expect(asked[0]).toMatch(/^Write these changes to .*settings\.json\? \[y\/N\] $/);
    expect(await readFile(settings, 'utf8')).toBe(ORIGINAL);

    const dry = io();
    expect(await runHooksCommand(['install', '--dry-run'], { io: dry, paths, node })).toBe(0);
    expect(dry.stdout).toContain('Dry run: nothing was written.');
    expect(await readFile(settings, 'utf8')).toBe(ORIGINAL);
  });

  it('install (after a yes), status, uninstall --yes', async () => {
    const a = io(true);
    expect(await runHooksCommand(['install'], { io: a, paths, node, now: NOW, ask: async () => true })).toBe(0);
    expect(a.stdout).toContain(`Installed the hook client at ${hookBin}`);
    expect(a.stdout).toContain('Backed up the previous file to ');
    expect(a.stdout).toContain(`Installed jantar hooks for ${HOOK_EVENT_NAMES.length} events.`);
    expect((await hooksStatus({ settingsPath: settings, node, hookBin })).state).toBe('installed');

    const again = io();
    expect(await runHooksCommand(['install'], { io: again, paths, node })).toBe(0);
    expect(again.stdout).toContain('already installed');

    const s = io();
    expect(await runHooksCommand(['status'], { io: s, paths, node })).toBe(0);
    expect(s.stdout).toContain('Hooks: installed');
    expect(s.stdout).toContain('Hook client: ');
    expect(s.stdout).toContain('cswap profiles: 3 of 4 share this settings file; slot 5 uses its own file and gets no hooks');
    expect(s.stdout).not.toContain('profile-e');

    const j = io();
    expect(await runHooksCommand(['status', '--json'], { io: j, paths, node })).toBe(0);
    expect(JSON.parse(j.stdout)).toMatchObject({ state: 'installed', hookBinPresent: true });

    const u = io();
    expect(await runHooksCommand(['uninstall', '--yes'], { io: u, paths, node, now: NOW })).toBe(0);
    expect(u.stdout).toContain(`Removed Jantar's hook entries from ${HOOK_EVENT_NAMES.length} events.`);
    expect(await readFile(settings, 'utf8')).toBe(ORIGINAL);
    const u2 = io();
    expect(await runHooksCommand(['uninstall', '--yes'], { io: u2, paths, node })).toBe(0);
    expect(u2.stdout).toContain('nothing to remove');
  });

  it('warns when a non-default state dir would be written into the shared ~/.claude/settings.json', async () => {
    // paths.home (<tmp>/state) is not <HOME>/.jantar: e.g. JANTAR_HOME=/tmp/jantar-try from the README trial.
    const a = io();
    expect(await runHooksCommand(['install', '--dry-run'], { io: a, paths, node })).toBe(0);
    expect(a.stderr).toContain(`the hooks will run the client in ${paths.binDir}`);
    expect(a.stderr).toContain('every cswap profile');
    expect(a.stderr).toContain('jantar hooks uninstall');

    // Another settings file, or the default state dir: no warning.
    const other = io();
    const copy = join(tmp.dir, 'copy-settings.json');
    await writeFile(copy, ORIGINAL);
    expect(await runHooksCommand(['install', '--dry-run', '--settings', copy], { io: other, paths, node })).toBe(0);
    expect(other.stderr).toBe('');
    const def = io();
    const defaults = resolvePaths({ env: { HOME: home }, userHome: home });
    expect(await runHooksCommand(['install', '--dry-run'], { io: def, paths: defaults, node })).toBe(0);
    expect(def.stderr).toBe('');
  });

  it('--settings edits another file, following its symlink', async () => {
    const link = join(profiles, '2-profile-b', 'settings.json');
    const a = io();
    expect(await runHooksCommand(['install', '--yes', `--settings=${link}`], { io: a, paths, node, now: NOW })).toBe(0);
    expect(a.stdout).toContain(`(linked from ${link})`);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect((await hooksStatus({ settingsPath: settings, node, hookBin })).state).toBe('installed');
  });

  it('reports a broken settings file without touching it', async () => {
    await writeFile(settings, '{ nope');
    const a = io();
    expect(await runHooksCommand(['install', '--yes'], { io: a, paths, node })).toBe(1);
    expect(a.stderr).toContain('is not valid JSON');
    const s = io();
    expect(await runHooksCommand(['status'], { io: s, paths, node })).toBe(1);
    expect(s.stdout).toContain('could not be read');
    expect(await readFile(settings, 'utf8')).toBe('{ nope');
  });
});
