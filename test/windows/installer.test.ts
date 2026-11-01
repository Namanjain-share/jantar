/**
 * W2 (v0.6 native Windows, preview): `jantar hooks install|status|uninstall`
 * on a temp settings.json, for real. The hooks are exec form: the absolute
 * node.exe as `command`, the installed client (and `--wait` for
 * PermissionRequest) as `args`, `onFailure: "continue"`, the usual
 * timeouts. Installing twice changes nothing; uninstalling gives the file
 * back byte for byte, other tools' hooks included.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOOK_CLIENT_PATH } from '@jantar/hook';
import { HOOK_EVENT_NAMES } from '@jantar/protocol';
import type { Paths } from '@jantar/daemon';
import { resolvePaths } from '@jantar/daemon/config';
import { runHooksCommand } from '@jantar/daemon/hooks/cli';
import { MIN_CLAUDE_WINDOWS } from '@jantar/daemon/hooks/installer';
import { WINDOWS } from './helpers.js';

const SETTINGS = {
  cleanupPeriodDays: 30,
  hooks: { PreToolUse: [{ matcher: 'PowerShell', hooks: [{ type: 'command', command: 'C:\\tools\\guard.exe', args: ['--check'] }] }] },
  theme: 'dark',
};
const ORIGINAL = `${JSON.stringify(SETTINGS, null, 2)}\n`;

describe.skipIf(!WINDOWS)('W2: the exec-form hooks installer on Windows', () => {
  let root: string;
  let settings: string;
  let paths: Paths;
  let out = '';

  const hooks = (args: string[]) => {
    out = '';
    return runHooksCommand(args, {
      io: { out: (t) => (out += t), err: (t) => (out += t), env: { JANTAR_HOME: paths.home }, isTTY: false },
      paths,
      node: process.execPath,
    });
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'jantar-w2-'));
    paths = resolvePaths({ env: { HOME: root, USERPROFILE: root, JANTAR_HOME: join(root, '.jantar') } });
    settings = join(root, 'settings.json');
    await writeFile(settings, ORIGINAL);
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('install writes exec form beside the other hooks, and copies the client', async () => {
    expect(await hooks(['install', '--yes', '--settings', settings]), out).toBe(0);
    const after = JSON.parse(await readFile(settings, 'utf8'));
    expect(after.hooks.PreToolUse[0]).toEqual(SETTINGS.hooks.PreToolUse[0]);
    expect(after.hooks.PermissionRequest).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: process.execPath, args: [paths.hookBin, '--wait'], onFailure: 'continue', timeout: 86400 }] },
    ]);
    expect(after.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: process.execPath, args: [paths.hookBin], onFailure: 'continue', async: true, timeout: 5 }] }]);
    for (const ev of HOOK_EVENT_NAMES) expect(after.hooks[ev], ev).toHaveLength(ev === 'PreToolUse' ? 2 : 1);
    expect(process.execPath).toMatch(/^[A-Za-z]:\\.*\.exe$/i);
    expect((await readFile(paths.hookBin)).equals(await readFile(HOOK_CLIENT_PATH))).toBe(true);
  });

  it('install again changes nothing, and status says installed and names the minimum Claude', async () => {
    const before = await readFile(settings, 'utf8');
    expect(await hooks(['install', '--yes', '--settings', settings]), out).toBe(0);
    expect(out).toContain('already installed');
    expect(await readFile(settings, 'utf8')).toBe(before);
    expect(await hooks(['status', '--json', '--settings', settings]), out).toBe(0);
    const st = JSON.parse(out);
    expect(st.state).toBe('installed');
    expect(st.minClaude).toBe(MIN_CLAUDE_WINDOWS);
    expect(st.hookBinCurrent).toBe(true);
  });

  it("uninstall removes exactly Jantar's groups", async () => {
    expect(await hooks(['uninstall', '--yes', '--settings', settings]), out).toBe(0);
    expect(await readFile(settings, 'utf8')).toBe(ORIGINAL);
  });
});
