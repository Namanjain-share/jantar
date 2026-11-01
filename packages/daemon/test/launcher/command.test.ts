/**
 * The typed command line (spec 4.5.2, U7) and security rule L1: no control
 * characters, and a folder name with `'`, `$( )`, `;` or a backtick is
 * quoted so the shell reads it as one word, while a newline is refused.
 * The shell test runs zsh with no rc files (-f), `cs` defined as a function
 * that prints where it ran and what it got, so nothing real is started.
 *
 * v0.4: LL2 (a resume types `--resume <uuid>` and no --session-id, and is
 * otherwise the v0.3 line: the quoting test runs over it too), LL5 (claude
 * mode types `cd -- <folder> && <absolute claude> ...` and refuses a missing
 * or relative claude), and the accounts-mode check behind LL6. The fixtures'
 * parseLaunchCommand, completeLaunch and "resume" flow (what wave 2's
 * fake-osascript runs build on) read back exactly these lines.
 *
 * v0.6 (a server whose accounts are config dirs): claude mode only, and
 * `env CLAUDE_CONFIG_DIR=<dir>` before claude for any dir but ~/.claude,
 * still with no `--`; sh and zsh hand the dir to claude intact. ~/.claude
 * is `env -u CLAUDE_CONFIG_DIR`, so an exported one never reaches claude.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LAUNCH_PID, LaunchScreenScript, completeLaunch, launchAccounts, makeFakeHome, parseLaunchCommand } from '@jantar/fixtures';
import { V03_LAUNCH_FLAGS, SettingsSchema, launchFlagArgs, type LaunchFlags, type Settings } from '@jantar/protocol';
import {
  CLAUDE_MISSING,
  CONFIG_DIR_CLAUDE_ONLY,
  CSWAP_MODE,
  NO_CSWAP_DIRS,
  NO_CSWAP_MODE,
  RESUME_KEEPS_NAME,
  accountsModeProblem,
  hasControlChars,
  launchCommand,
  nameFromFolder,
  q,
  uniqueName,
  type CommandParts,
} from '../../src/launcher/command.js';

const SID = '6b1e0c2a-4f3d-4c8e-9a71-2f5b8d3e9c10';
const PAST = '0b4e7c4e-1111-4111-8111-000000000001';
const CLAUDE = '/Users/you/.local/bin/claude';
const ZSH = '/bin/zsh';

/** Launch settings in cs-shell mode (v0.3's default; v0.4 starts in claude mode, WP-LA's). */
function launch(over: Partial<Settings['launch']> = {}): Settings['launch'] {
  return SettingsSchema.parse({ launch: { mode: 'cs-shell', ...over } }).launch;
}

function parts(over: Partial<CommandParts> = {}): CommandParts {
  return {
    folder: '/Users/you/Desktop/work/alpha-app',
    account: 7,
    args: launchFlagArgs(V03_LAUNCH_FLAGS),
    sid: SID,
    name: 'alpha-app',
    launch: launch(),
    cswap: '/opt/homebrew/bin/cswap',
    claude: CLAUDE,
    ...over,
  };
}

function built(over: Partial<CommandParts> = {}): string {
  const r = launchCommand(parts(over));
  if (!r.ok) throw new Error(r.reason);
  return r.command;
}

describe('q (shell quoting)', () => {
  it('leaves plain words alone and single-quotes everything else', () => {
    expect(q('--chrome')).toBe('--chrome');
    expect(q('/Users/you/Desktop/work/foo-1.2')).toBe('/Users/you/Desktop/work/foo-1.2');
    expect(q('my folder')).toBe("'my folder'");
    expect(q("it's")).toBe(`'it'\\''s'`);
    expect(q('$(touch x)')).toBe("'$(touch x)'");
    expect(q('~/bin')).toBe("'~/bin'");
    expect(q('=ls')).toBe("'=ls'");
    expect(q('a*')).toBe("'a*'");
    expect(q('')).toBe("''");
  });
});

describe('launchCommand', () => {
  it('cs-shell: cd, then cs N with the allowlisted flags, our session id and the name', () => {
    expect(built()).toBe(
      `cd -- /Users/you/Desktop/work/alpha-app && cs 7 -- --dangerously-skip-permissions --chrome --effort ultracode --session-id ${SID} --name alpha-app`,
    );
  });

  it('flags come from launchFlagArgs only, in its order', () => {
    const flags: LaunchFlags = { permission: 'acceptEdits', chrome: false, effort: 'default', model: 'sonnet' };
    expect(built({ args: launchFlagArgs(flags) })).toContain(' 7 -- --permission-mode acceptEdits --model sonnet --session-id ');
    const manual: LaunchFlags = { permission: 'manual', chrome: false, effort: 'default', model: 'default' };
    expect(built({ args: launchFlagArgs(manual) })).toContain(' 7 -- --permission-mode manual --session-id ');
  });

  it('cswap-run: the absolute cswap path, --share-history and the pre-launch argv with {n}', () => {
    const cmd = built({
      launch: launch({ mode: 'cswap-run', preLaunchArgv: ['/usr/bin/python3', '-I', '/Users/you/bin/adopt.py', 'adopt', '{n}'] }),
    });
    expect(cmd).toBe(
      'cd -- /Users/you/Desktop/work/alpha-app && /usr/bin/python3 -I /Users/you/bin/adopt.py adopt 7 && ' +
        `/opt/homebrew/bin/cswap run --share-history 7 -- --dangerously-skip-permissions --chrome --effort ultracode --session-id ${SID} --name alpha-app`,
    );
    expect(built({ launch: launch({ mode: 'cswap-run', shareHistory: false }) })).toContain('/opt/homebrew/bin/cswap run 7 --');
    expect(launchCommand(parts({ launch: launch({ mode: 'cswap-run' }), cswap: null }))).toEqual({
      ok: false,
      reason: 'cswap was not found (install it, or on the Mac run: jantar launch mode cs-shell)',
      setup: true,
    });
  });

  it('never exec, exit or a positional prompt: the shell outlives Claude for ccw moves', () => {
    const cmd = built();
    expect(cmd).not.toMatch(/\bexec\b|;\s*exit|\bexit\b/);
    expect(cmd.endsWith('--name alpha-app')).toBe(true);
  });

  it('the preview shows placeholders for the account and session id', () => {
    expect(built({ account: null, sid: null })).toContain('cs <account> -- --dangerously-skip-permissions --chrome --effort ultracode --session-id <session id> --name alpha-app');
  });

  it('L1: refuses any control character anywhere (a line feed in do script runs a second command)', () => {
    for (const bad of ['line\nfeed', 'car\rriage', 'bell\u0007', 'tab\there', 'del\u007f', 'csi\u009b']) {
      const r = launchCommand(parts({ folder: `/Users/you/${bad}` }));
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    const pre = launchCommand(parts({ launch: launch({ mode: 'cswap-run', preLaunchArgv: ['/bin/echo', 'a\nb'] }) }));
    expect(pre.ok).toBe(false);
    expect(hasControlChars('fine')).toBe(false);
  });

  it('refuses a cs command that is not a plain word, a bad session id, a bad name or an odd flag', () => {
    expect(launchCommand(parts({ launch: launch({ csCommand: 'cs; rm -rf ~' }) })).ok).toBe(false);
    expect(launchCommand(parts({ sid: 'not-a-uuid' })).ok).toBe(false);
    expect(launchCommand(parts({ name: 'two words' })).ok).toBe(false);
    expect(launchCommand(parts({ args: ['--settings', '/tmp/x.json'] })).ok).toBe(false);
    expect(launchCommand(parts({ folder: 'relative/path' })).ok).toBe(false);
    expect(launchCommand(parts({ account: -1 })).ok).toBe(false);
  });
});

describe('v0.4: resume (LL2)', () => {
  it('types --resume <uuid> and no --session-id; the rest is the v0.3 line', () => {
    expect(RESUME_KEEPS_NAME).toBe(true);
    const fresh = built();
    const resumed = built({ sid: PAST, resume: true });
    expect(resumed).toBe(
      `cd -- /Users/you/Desktop/work/alpha-app && cs 7 -- --dangerously-skip-permissions --chrome --effort ultracode --resume ${PAST} --name alpha-app`,
    );
    expect(resumed).not.toContain('--session-id');
    expect(resumed).toBe(fresh.replace(`--session-id ${SID}`, `--resume ${PAST}`));
    // Every mode: cswap-run and claude carry the same session part.
    expect(built({ sid: PAST, resume: true, launch: launch({ mode: 'cswap-run' }) })).toMatch(new RegExp(`cswap run --share-history 7 -- .* --resume ${PAST} --name alpha-app$`));
    expect(built({ sid: PAST, resume: true, launch: launch({ mode: 'claude' }) })).toMatch(new RegExp(` --effort ultracode --resume ${PAST} --name alpha-app$`));
  });

  it('the preview of a resume shows the real id (it is known), never the placeholder', () => {
    const r = built({ account: null, sid: PAST, resume: true });
    expect(r).toContain(`cs <account> -- --dangerously-skip-permissions --chrome --effort ultracode --resume ${PAST} --name alpha-app`);
    expect(r).not.toContain('<session id>');
  });

  it('refuses a resume without an id, or with one that is not a UUID', () => {
    expect(launchCommand(parts({ sid: null, resume: true }))).toEqual({ ok: false, reason: 'a resume needs the id of the conversation' });
    for (const bad of ['last', `${PAST} --fork-session`, `${PAST}\n`, '../../etc/passwd', PAST.toUpperCase()]) {
      expect(launchCommand(parts({ sid: bad, resume: true })).ok, bad).toBe(false);
    }
  });
});

describe('v0.4: claude mode (LL5)', () => {
  it('types cd -- <folder> && <absolute claude> <flags> <session part>: no account, no --', () => {
    const cmd = built({ launch: launch({ mode: 'claude' }) });
    expect(cmd).toBe(`cd -- /Users/you/Desktop/work/alpha-app && ${CLAUDE} --dangerously-skip-permissions --chrome --effort ultracode --session-id ${SID} --name alpha-app`);
    // The only `--` is cd's own: claude takes the flags itself.
    expect(cmd.split(' && ')[1]).not.toMatch(/(?:^| )--(?: |$)/);
    // The preview: the session id is a placeholder; no account appears at all.
    expect(built({ launch: launch({ mode: 'claude' }), account: null, sid: null })).toBe(
      `cd -- /Users/you/Desktop/work/alpha-app && ${CLAUDE} --dangerously-skip-permissions --chrome --effort ultracode --session-id <session id> --name alpha-app`,
    );
    // A claude path with a space is one quoted word.
    expect(built({ launch: launch({ mode: 'claude' }), claude: '/Applications/My Tools/claude' })).toContain("&& '/Applications/My Tools/claude' --dangerously-skip-permissions");
    // Manual permissions name their mode too (with no flag the account's settings would pick one).
    const manual: LaunchFlags = { permission: 'manual', chrome: false, effort: 'default', model: 'default' };
    expect(built({ launch: launch({ mode: 'claude' }), args: launchFlagArgs(manual) })).toBe(
      `cd -- /Users/you/Desktop/work/alpha-app && ${CLAUDE} --permission-mode manual --session-id ${SID} --name alpha-app`,
    );
  });

  it('refuses a missing or relative claude as a setup problem', () => {
    for (const claude of [null, 'claude', './claude', '~/bin/claude', '']) {
      expect(launchCommand(parts({ launch: launch({ mode: 'claude' }), claude })), String(claude)).toEqual({ ok: false, reason: CLAUDE_MISSING, setup: true });
    }
    // The other modes do not need it.
    expect(launchCommand(parts({ claude: null })).ok).toBe(true);
  });
});

describe('v0.4: the accounts mode and launch.mode must agree (LL6)', () => {
  it('single mode starts in claude mode only; cswap mode never in claude mode', () => {
    expect(accountsModeProblem('single', 'claude')).toBeNull();
    expect(accountsModeProblem('single', 'cs-shell')).toBe(NO_CSWAP_MODE);
    expect(accountsModeProblem('single', 'cswap-run')).toBe(NO_CSWAP_MODE);
    expect(accountsModeProblem('cswap', 'claude')).toBe(CSWAP_MODE);
    expect(accountsModeProblem('cswap', 'cs-shell')).toBeNull();
    expect(accountsModeProblem('cswap', 'cswap-run')).toBeNull();
    expect(NO_CSWAP_MODE).toBe('This Mac has no cswap. Run: jantar launch mode claude');
    expect(CSWAP_MODE).toBe('This Mac has cswap. Pick how to start sessions: jantar launch mode cswap-run');
  });
});

describe("v0.4: the fixtures read these lines back (wave 2's fake-osascript runs)", () => {
  it('parseLaunchCommand: a resume in every mode, and claude mode with no account and no --', () => {
    expect(parseLaunchCommand(built({ sid: PAST, resume: true }))).toMatchObject({
      mode: 'cs-shell',
      folder: '/Users/you/Desktop/work/alpha-app',
      account: 7,
      sessionId: null,
      resume: PAST,
      name: 'alpha-app',
    });
    const pre = launch({ mode: 'cswap-run', preLaunchArgv: ['/usr/bin/python3', '-I', '/Users/you/bin/adopt.py', 'adopt', '{n}'] });
    expect(parseLaunchCommand(built({ sid: PAST, resume: true, launch: pre }))).toMatchObject({
      mode: 'cswap-run',
      account: 7,
      sessionId: null,
      resume: PAST,
      preLaunch: [['/usr/bin/python3', '-I', '/Users/you/bin/adopt.py', 'adopt', '7']],
    });
    const claude = parseLaunchCommand(built({ launch: launch({ mode: 'claude' }), claude: '/Applications/My Tools/claude' }));
    expect(claude).toMatchObject({ mode: 'claude', folder: '/Users/you/Desktop/work/alpha-app', account: null, sessionId: SID, resume: null, name: 'alpha-app', preLaunch: [] });
    expect(claude.claudeArgs).toEqual([...launchFlagArgs(V03_LAUNCH_FLAGS), '--session-id', SID, '--name', 'alpha-app']);
    expect(parseLaunchCommand(built({ sid: PAST, resume: true, launch: launch({ mode: 'claude' }) }))).toMatchObject({ mode: 'claude', account: null, sessionId: null, resume: PAST });
  });

  it('completeLaunch: a resume comes up under the resumed id; claude mode on the default login', async () => {
    const home = await makeFakeHome({ accounts: launchAccounts(), sessions: [] });
    try {
      const folder = join(home.home, 'Desktop', 'work', 'alpha-app');
      await mkdir(folder, { recursive: true });
      const resumed = await completeLaunch(home, { command: built({ folder, sid: PAST, resume: true }) });
      expect(resumed).toMatchObject({ sid: PAST, configDir: home.configDirFor(7) });
      const other = '0b4e7c4e-2222-4222-8222-000000000002';
      const login = home.accounts.find((a) => a.profile === null);
      const claude = await completeLaunch(home, { command: built({ folder, sid: other, resume: true, launch: launch({ mode: 'claude' }) }), pid: LAUNCH_PID + 1, tty: '/dev/ttys015' });
      expect(claude).toMatchObject({ sid: other, configDir: home.configDirFor(login!.id) });
    } finally {
      await home.cleanup();
    }
  });

  it('the "resume" flow: the shell, the Keep-model menu until it is answered, then ready', () => {
    const s = new LaunchScreenScript('resume', { folder: '/synthetic/work/alpha-app' });
    expect(s.state).toBe('shell');
    s.screen();
    expect(s.state).toBe('keepModel');
    expect(s.screen()).toContain('Keep current model');
    expect(s.state).toBe('keepModel');
    s.press('enter');
    expect(s.state).toBe('ready');
    expect(s.answers).toEqual([{ screen: 'keepModel', option: 0 }]);
  });
});

describe('names', () => {
  it('a --name from the folder basename: no spaces, at most 48 characters', () => {
    expect(nameFromFolder('alpha-app')).toBe('alpha-app');
    expect(nameFromFolder('My Project (v2)')).toBe('My-Project-v2');
    expect(nameFromFolder('.hidden')).toBe('hidden');
    expect(nameFromFolder('Café')).toBe('Cafe');
    expect(nameFromFolder('日本')).toBe('session');
    expect(nameFromFolder('x'.repeat(80))).toHaveLength(48);
  });

  it('adds -2, -3 when a live session already has the name', () => {
    expect(uniqueName('foo', new Set())).toBe('foo');
    expect(uniqueName('foo', new Set(['foo']))).toBe('foo-2');
    expect(uniqueName('foo', new Set(['foo', 'foo-2']))).toBe('foo-3');
    expect(uniqueName('y'.repeat(48), new Set(['y'.repeat(48)]))).toBe(`${'y'.repeat(46)}-2`);
  });
});

/** Each zsh run, and each shell test (it runs one per hostile name): generous, as a loaded machine is slow to spawn. */
const SHELL_MS = 15_000;
const SHELL_TEST_MS = 60_000;

describe.skipIf(!existsSync(ZSH))('L1 shell test: zsh reads hostile folder names as one word', { timeout: SHELL_TEST_MS }, () => {
  let tmp: string;
  const names = [`it's`, '$(touch PWNED)', 'a;b', 'back`touch PWNED2`tick', '$HOME', 'star*', '~tilde', '=ls', 'semi && echo hi', 'quote"d', 'bang!x'];

  beforeAll(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'ccw-cmd-')));
    for (const n of names) await mkdir(join(tmp, n));
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  /** Run the typed line in zsh -f with `cs` as a recording function; return its output lines. */
  function typed(command: string): string[] {
    const script = 'cs() { print -r -- "$PWD"; print -rl -- "$@"; }; eval "$1"';
    const out = execFileSync(ZSH, ['-f', '-c', script, 'zsh', command], {
      cwd: tmp,
      env: { PATH: '/usr/bin:/bin', HOME: tmp, LC_ALL: 'C' },
      encoding: 'utf8',
      timeout: SHELL_MS,
    });
    return out.replace(/\n$/, '').split('\n');
  }

  it('zsh -n parses every command, and cd lands in exactly that folder with the args intact', async () => {
    for (const n of names) {
      const folder = join(tmp, n);
      const cmd = built({ folder });
      expect(() => execFileSync(ZSH, ['-f', '-n', '-c', cmd], { env: { PATH: '/usr/bin:/bin', HOME: tmp }, timeout: SHELL_MS }), n).not.toThrow();
      const [pwd, ...args] = typed(cmd);
      expect(pwd, n).toBe(folder);
      expect(args, n).toEqual(['7', '--', '--dangerously-skip-permissions', '--chrome', '--effort', 'ultracode', '--session-id', SID, '--name', 'alpha-app']);
    }
    // Nothing in a name ran.
    expect((await readdir(tmp)).filter((f) => f.startsWith('PWNED'))).toEqual([]);
    expect(existsSync(join(process.cwd(), 'PWNED'))).toBe(false);
  });

  it('LL2: a resume line is quoted the same: cd lands in the folder, and --resume carries the id intact', async () => {
    for (const n of names) {
      const folder = join(tmp, n);
      const cmd = built({ folder, sid: PAST, resume: true });
      const [pwd, ...args] = typed(cmd);
      expect(pwd, n).toBe(folder);
      expect(args, n).toEqual(['7', '--', '--dangerously-skip-permissions', '--chrome', '--effort', 'ultracode', '--resume', PAST, '--name', 'alpha-app']);
    }
    expect((await readdir(tmp)).filter((f) => f.startsWith('PWNED'))).toEqual([]);
  });

  it('LL5: claude mode is quoted the same: the absolute claude runs in the folder with the args intact', async () => {
    // A recording "claude" at an absolute path with a space in it.
    const bin = join(tmp, 'bin dir');
    await mkdir(bin, { recursive: true });
    const claude = join(bin, 'claude');
    await writeFile(claude, '#!/bin/zsh -f\nprint -r -- "$PWD"; print -rl -- "$@"\n', { mode: 0o755 });
    for (const n of names) {
      const folder = join(tmp, n);
      const cmd = built({ folder, launch: launch({ mode: 'claude' }), claude });
      const out = execFileSync(ZSH, ['-f', '-c', cmd], { cwd: tmp, env: { PATH: '/usr/bin:/bin', HOME: tmp, LC_ALL: 'C' }, encoding: 'utf8', timeout: SHELL_MS });
      const [pwd, ...args] = out.replace(/\n$/, '').split('\n');
      expect(pwd, n).toBe(folder);
      expect(args, n).toEqual(['--dangerously-skip-permissions', '--chrome', '--effort', 'ultracode', '--session-id', SID, '--name', 'alpha-app']);
    }
    expect((await readdir(tmp)).filter((f) => f.startsWith('PWNED'))).toEqual([]);
  });

  it('a newline in a folder name is refused, never typed', async () => {
    const r = launchCommand(parts({ folder: join(tmp, 'two\nlines') }));
    expect(r).toEqual({ ok: false, reason: 'the folder or a setting holds a control character' });
  });
});

describe('v0.6: config dirs (accountsMode "dirs", spec 5)', () => {
  const HOME_DIR = '/home/sam';
  const WORK = `${HOME_DIR}/.claude-work`;
  const FOLDER = `${HOME_DIR}/code/api-server`;
  const LINUX_CLAUDE = `${HOME_DIR}/.local/bin/claude`;
  const dirs = (over: Partial<CommandParts> = {}) =>
    parts({ folder: FOLDER, account: 1, name: 'api-server', claude: LINUX_CLAUDE, cswap: null, launch: launch({ mode: 'claude' }), configDir: WORK, ...over });

  it('starts in claude mode only: cs-shell and cswap-run say what to run', () => {
    expect(accountsModeProblem('dirs', 'claude')).toBeNull();
    expect(accountsModeProblem('dirs', 'cs-shell')).toBe(NO_CSWAP_DIRS);
    expect(accountsModeProblem('dirs', 'cswap-run')).toBe(NO_CSWAP_DIRS);
    expect(NO_CSWAP_DIRS).toBe('This machine has no cswap: its accounts are config dirs. Run: jantar launch mode claude');
  });

  it('~/.claude-work: env CLAUDE_CONFIG_DIR=<dir> before the absolute claude, and still no --', () => {
    const r = launchCommand(dirs());
    expect(r).toEqual({
      ok: true,
      command: `cd -- ${FOLDER} && env CLAUDE_CONFIG_DIR=${WORK} ${LINUX_CLAUDE} --dangerously-skip-permissions --chrome --effort ultracode --session-id ${SID} --name api-server`,
    });
    expect(r.ok && r.command.split(' && ')[1]).not.toMatch(/(?:^| )--(?: |$)/);
  });

  it('~/.claude (no config dir) is the plain claude line', () => {
    const plain = `cd -- ${FOLDER} && ${LINUX_CLAUDE} --dangerously-skip-permissions --chrome --effort ultracode --session-id ${SID} --name api-server`;
    expect(launchCommand(dirs({ configDir: null }))).toEqual({ ok: true, command: plain });
    const { configDir: _gone, ...absent } = dirs();
    expect(launchCommand(absent)).toEqual({ ok: true, command: plain });
  });

  it('~/.claude in dirs mode: env -u CLAUDE_CONFIG_DIR first, so one the shell exports cannot move it', () => {
    expect(launchCommand(dirs({ configDir: null, dirs: true }))).toEqual({
      ok: true,
      command: `cd -- ${FOLDER} && env -u CLAUDE_CONFIG_DIR ${LINUX_CLAUDE} --dangerously-skip-permissions --chrome --effort ultracode --session-id ${SID} --name api-server`,
    });
    // another dir sets its own
    expect(launchCommand(dirs({ dirs: true }))).toMatchObject({ command: expect.stringContaining(`&& env CLAUDE_CONFIG_DIR=${WORK} ${LINUX_CLAUDE} `) });
    expect(launchCommand(dirs({ configDir: null, dirs: true, launch: launch({ mode: 'cs-shell' }) }))).toEqual({ ok: false, reason: CONFIG_DIR_CLAUDE_ONLY, setup: true });
  });

  it('a resume and the preview carry the same prefix', () => {
    expect(launchCommand(dirs({ sid: PAST, resume: true }))).toMatchObject({
      command: `cd -- ${FOLDER} && env CLAUDE_CONFIG_DIR=${WORK} ${LINUX_CLAUDE} --dangerously-skip-permissions --chrome --effort ultracode --resume ${PAST} --name api-server`,
    });
    expect(launchCommand(dirs({ sid: null, account: null }))).toMatchObject({ command: expect.stringContaining(`env CLAUDE_CONFIG_DIR=${WORK} ${LINUX_CLAUDE} `) });
  });

  it('a dir with a space or a quote is one quoted word; a relative dir, a control character or another mode is refused', () => {
    expect(launchCommand(dirs({ configDir: `${HOME_DIR}/.claude-it's mine` }))).toMatchObject({
      command: expect.stringContaining(`&& env 'CLAUDE_CONFIG_DIR=${HOME_DIR}/.claude-it'\\''s mine' ${LINUX_CLAUDE} `),
    });
    expect(launchCommand(dirs({ configDir: '.claude-work' }))).toEqual({ ok: false, reason: 'the config dir is not an absolute path' });
    expect(launchCommand(dirs({ configDir: `${WORK}\nrm -rf ~` }))).toEqual({ ok: false, reason: 'the folder or a setting holds a control character' });
    for (const mode of ['cs-shell', 'cswap-run'] as const) {
      expect(launchCommand(dirs({ launch: launch({ mode }), cswap: '/usr/local/bin/cswap' })), mode).toEqual({ ok: false, reason: CONFIG_DIR_CLAUDE_ONLY, setup: true });
    }
  });
});

describe('v0.6 shell test: the config dir reaches claude as CLAUDE_CONFIG_DIR, in sh and zsh', { timeout: SHELL_TEST_MS }, () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'jantar-dirs-cmd-')));
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('cd lands in the folder; claude gets the dir in its env and the args intact; nothing in a name runs', async () => {
    const claude = join(tmp, 'bin dir', 'claude');
    await mkdir(join(tmp, 'bin dir'), { recursive: true });
    await writeFile(claude, '#!/bin/sh\nprintf \'%s\\n\' "$PWD" "$CLAUDE_CONFIG_DIR" "$@"\n', { mode: 0o755 });
    const folder = join(tmp, 'a;b');
    const configDir = join(tmp, ".claude-it's $(touch PWNED)");
    await mkdir(folder);
    await mkdir(configDir);
    const cmd = built({ folder, account: 1, launch: launch({ mode: 'claude' }), claude, configDir });
    for (const shell of ['/bin/sh', ZSH].filter((s) => existsSync(s))) {
      const out = execFileSync(shell, ['-c', cmd], { cwd: tmp, env: { PATH: '/usr/bin:/bin', HOME: tmp, LC_ALL: 'C' }, encoding: 'utf8', timeout: SHELL_MS });
      const [pwd, dir, ...args] = out.replace(/\n$/, '').split('\n');
      expect(pwd, shell).toBe(folder);
      expect(dir, shell).toBe(configDir);
      expect(args, shell).toEqual(['--dangerously-skip-permissions', '--chrome', '--effort', 'ultracode', '--session-id', SID, '--name', 'alpha-app']);
    }
    expect((await readdir(tmp)).filter((f) => f.startsWith('PWNED'))).toEqual([]);
  });

  it('~/.claude: a CLAUDE_CONFIG_DIR the shell exports does not reach claude', async () => {
    const claude = join(tmp, 'claude-env');
    await writeFile(claude, '#!/bin/sh\nprintf \'[%s]\\n\' "${CLAUDE_CONFIG_DIR-unset}"\n', { mode: 0o755 });
    const cmd = built({ folder: tmp, account: 0, launch: launch({ mode: 'claude' }), claude, configDir: null, dirs: true });
    for (const shell of ['/bin/sh', ZSH].filter((s) => existsSync(s))) {
      const env = { PATH: '/usr/bin:/bin', HOME: tmp, LC_ALL: 'C', CLAUDE_CONFIG_DIR: join(tmp, '.claude-work') };
      expect(execFileSync(shell, ['-c', cmd], { cwd: tmp, env, encoding: 'utf8', timeout: SHELL_MS }), shell).toBe('[unset]\n');
    }
  });
});
