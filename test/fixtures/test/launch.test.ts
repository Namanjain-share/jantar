import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { V03_LAUNCH_FLAGS, launchFlagArgs, type LaunchFlags } from '@jantar/protocol';
import {
  LAUNCH_AUTO_ACCOUNT,
  LAUNCH_HELD,
  LAUNCH_PID,
  LAUNCH_TTY,
  LAUNCH_WINDOW_ID,
  LaunchScreenScript,
  OPEN_SCRIPT_LINE,
  completeLaunch,
  dialogAnswerBytes,
  launchAccounts,
  launchMenu,
  launchOsascriptRules,
  launchProcesses,
  launchScreen,
  makeFakeHome,
  openWindowCommand,
  parseLaunchCommand,
  shellWords,
  watchLaunch,
  type FakeAccount,
  type FakeHome,
} from '../src/index.js';
import { sh } from './run.js';

/** The launcher's quoting (spec 4.5.2). */
const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

function csCommand(folder: string, account: number, flags: LaunchFlags, sid: string, name: string): string {
  return `cd -- ${q(folder)} && cs ${account} -- ${launchFlagArgs(flags).map(q).join(' ')} --session-id ${sid} --name ${q(name)}`;
}

/** The open script's shape (WP-L owns the real one): constant text, values in argv. */
const OPEN_SCRIPT = `on run argv\n\tset cmd to item 1 of argv\n\ttell application "Terminal"\n\t\t${OPEN_SCRIPT_LINE}\n\tend tell\nend run\n`;

describe('launchAccounts', () => {
  const accounts = launchAccounts();
  const five = (a: FakeAccount) => a.fiveHourPct;

  it('has 11 accounts with profiles for 2 to 11', () => {
    expect(accounts.map((a) => a.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(accounts[0]?.profile).toBeNull();
    expect(accounts.slice(1).every((a) => a.profile === `${a.id}-${a.email.replace('@', '_')}`)).toBe(true);
    expect(accounts.every((a) => /@example\.(com|org|net)$/.test(a.email))).toBe(true);
  });

  it('makes the held accounts the emptiest, so a picker that ignores the hold list is caught', () => {
    const held = accounts.filter((a) => (LAUNCH_HELD as readonly number[]).includes(a.id));
    const rest = accounts.filter((a) => !(LAUNCH_HELD as readonly number[]).includes(a.id) && a.usageStatus === 'ok' && !a.disabled);
    expect(Math.max(...held.map(five))).toBeLessThan(Math.min(...rest.map(five)));
  });

  it('Auto (spec 4.5.4) and the prompt writer (U5) both pick account 7', () => {
    const now = 0;
    const usable = (a: FakeAccount, ceiling: number, maxAgeS = Infinity) =>
      !a.disabled && a.usageStatus === 'ok' && !(LAUNCH_HELD as readonly number[]).includes(a.id) && a.fiveHourPct < ceiling && a.sevenDayPct < 95 && a.ageS <= maxAgeS;
    const eff = (a: FakeAccount) => (a.fiveHourResetMin * 60_000 - now <= 15 * 60_000 ? 0 : a.fiveHourPct);
    const pick = (list: FakeAccount[]) => [...list].sort((a, b) => eff(a) - eff(b) || a.sevenDayPct - b.sevenDayPct || a.id - b.id)[0]?.id;
    expect(pick(accounts.filter((a) => usable(a, 97)))).toBe(LAUNCH_AUTO_ACCOUNT);
    expect(pick(accounts.filter((a) => usable(a, 85, 900)))).toBe(LAUNCH_AUTO_ACCOUNT);
    // each other case is excluded for its own reason
    const byId = (id: number) => accounts.find((a) => a.id === id) as FakeAccount;
    expect(usable(byId(9), 97)).toBe(false); // 5-hour ceiling
    expect(usable(byId(10), 97)).toBe(false); // weekly ceiling
    expect(usable(byId(11), 85, 900)).toBe(false); // stale for the prompt writer
    expect(usable(byId(3), 97) || usable(byId(4), 97)).toBe(false); // disabled, unavailable
  });
});

describe('LaunchScreenScript', () => {
  const folder = '/synthetic/home/Desktop/work/foo';

  it('trust: the shell, then the dialog until it is answered, then Claude ready', () => {
    const s = new LaunchScreenScript('trust', { folder });
    expect(s.state).toBe('shell');
    expect(s.screen()).toContain('tester@synthetic-mac ~ %');
    expect(s.state).toBe('trust');
    for (let i = 0; i < 3; i++) expect(s.screen()).toContain('Yes, I trust this folder');
    s.press('enter');
    expect(s.state).toBe('ready');
    expect(s.screen()).toContain('❯ Try "write a test for send.ts"');
    expect(s.state).toBe('ready'); // the last step stays
    expect(s.keys).toEqual(['enter']);
  });

  it("an arrow picks too: Terminal's Return after every key write is the selection (pressKey contract)", () => {
    const s = new LaunchScreenScript('bypass', { folder });
    s.screen();
    expect(s.screen()).toMatch(/❯ 1\. No, exit/);
    s.press('down');
    expect(s.state).toBe('ready');
    expect(s.answers).toEqual([{ screen: 'bypassWarning', option: 1 }]);

    const enter = new LaunchScreenScript('bypass', { folder });
    enter.screen();
    enter.press('enter'); // picks the highlighted "No, exit"
    expect(enter.state).toBe('claudeExited');
    expect(enter.screen()).toContain('Bye!');

    const no = new LaunchScreenScript('trust', { folder });
    no.screen();
    no.press('down', 3); // clamped to the last option, then picked
    expect(no.answers).toEqual([{ screen: 'trust', option: 1 }]);
    expect(no.state).toBe('claudeExited');
    expect(no.keys).toEqual(['down', 'down', 'down']);
  });

  it('appendedReturn: false keeps arrows pointer-only (until spike S1 settles it)', () => {
    const s = new LaunchScreenScript('bypass', { folder, appendedReturn: false });
    s.screen();
    s.press('down');
    expect(s.current).toBe(1);
    expect(s.state).toBe('bypassWarning');
    expect(s.screen()).toMatch(/❯ 2\. Yes, I accept/);
    s.press('down'); // stops at the last option
    expect(s.current).toBe(1);
    s.press('enter');
    expect(s.state).toBe('ready');
  });

  it("doubleEnter: Enter's second Return answers the dialog that follows (trust-then-chrome)", () => {
    const once = new LaunchScreenScript('trust-then-chrome', { folder });
    once.screen();
    once.press('enter');
    expect(once.state).toBe('chromeIntro'); // default: the second Return is lost

    const twice = new LaunchScreenScript('trust-then-chrome', { folder, doubleEnter: true });
    twice.screen();
    twice.press('enter');
    expect(twice.answers).toEqual([
      { screen: 'trust', option: 0 },
      { screen: 'chromeIntro', option: 0 },
    ]);
    expect(twice.state).toBe('ready');

    const bypass = new LaunchScreenScript([{ screen: 'shell' }, { screen: 'trust', until: 'answer' }, { screen: 'bypassWarning', until: 'answer' }, { screen: 'ready' }], {
      folder,
      doubleEnter: true,
    });
    bypass.screen();
    bypass.press('enter'); // trusted, then "No, exit" on the bypass warning
    expect(bypass.state).toBe('claudeExited');
  });

  it('failure flows: cs not found, a login screen, Claude exits', () => {
    expect(new LaunchScreenScript('cs-not-found', { folder }).screen()).toContain('zsh: command not found: cs');
    const login = new LaunchScreenScript('login', { folder });
    login.screen();
    login.press('enter'); // no step to answer: the login screen stays
    expect(login.screen()).toContain('Select login method:');
    const exits = new LaunchScreenScript('claude-exits', { folder, command: 'cd -- /x && cs 7 -- --chrome' });
    exits.screen();
    expect(exits.state).toBe('claudeExited');
    expect(exits.screen()).toContain('cs 7 -- --chrome');
  });

  it('honours `times` and custom flows', () => {
    const s = new LaunchScreenScript([{ screen: 'shell', times: 3 }, { screen: 'ready' }], { folder });
    s.screen();
    s.screen();
    expect(s.state).toBe('shell');
    s.screen();
    expect(s.state).toBe('ready');
    expect(() => new LaunchScreenScript([], { folder })).toThrow();
  });

  it('names its options the way the screen shows them', () => {
    expect(launchMenu('trust')).toEqual(['1. Yes, I trust this folder', '2. No, exit']);
    expect(launchMenu('ready')).toBeNull();
    expect(launchMenu('chromeIntro')).toBeNull(); // a notice: nothing to pick
    expect(launchScreen('ready', { folder, name: 'foo-2' })).toMatch(/─ foo-2 ──\n/);
  });

  it("the ready screen's status line shows the mode the command typed, or the one given", () => {
    const sid = randomUUID();
    const line = (o: { command?: string; mode?: 'plan' }) => launchScreen('ready', { folder, ...o }).trimEnd().split('\n').at(-1);
    expect(line({})).toBe('  ⏵⏵ bypass permissions on (shift+tab to cycle)');
    expect(line({ command: csCommand(folder, 7, { ...V03_LAUNCH_FLAGS }, sid, 'foo') })).toContain('bypass permissions on');
    expect(line({ command: csCommand(folder, 7, { ...V03_LAUNCH_FLAGS, permission: 'manual' }, sid, 'foo') })).toBe('  ⏸ manual mode on (shift+tab to cycle)');
    expect(line({ command: csCommand(folder, 7, { ...V03_LAUNCH_FLAGS, permission: 'plan' }, sid, 'foo') })).toBe('  ⏸ plan mode on (shift+tab to cycle)');
    expect(line({ command: csCommand(folder, 7, { ...V03_LAUNCH_FLAGS, permission: 'acceptEdits' }, sid, 'foo') })).toContain('⏵⏵ accept edits on');
    expect(line({ command: csCommand(folder, 7, { ...V03_LAUNCH_FLAGS, permission: 'auto' }, sid, 'foo') })).toContain('⏵⏵ auto mode on');
    expect(line({ mode: 'plan' })).toContain('plan mode on');
  });
});

describe('the command and the launched session', () => {
  it('parses what the launcher types, through every quoting case (L1)', () => {
    const sid = randomUUID();
    const folder = "/synthetic/it's $(x); `y` dir";
    const cmd = csCommand(folder, 7, { ...V03_LAUNCH_FLAGS }, sid, 'foo-2');
    const p = parseLaunchCommand(cmd);
    expect(p).toMatchObject({ mode: 'cs-shell', folder, account: 7, sessionId: sid, name: 'foo-2', preLaunch: [] });
    expect(p.claudeArgs.slice(0, 4)).toEqual(['--dangerously-skip-permissions', '--chrome', '--effort', 'ultracode']);

    const run = `cd -- ${q('/w/foo')} && ${q('/opt/adopt')} ${q('7')} && ${q('/bin/cswap')} run --share-history 7 -- --permission-mode plan --session-id ${sid} --name ${q('foo')}`;
    expect(parseLaunchCommand(run)).toMatchObject({ mode: 'cswap-run', folder: '/w/foo', account: 7, preLaunch: [['/opt/adopt', '7']] });
    expect(shellWords(`a "b \\"c\\"" d\\ e`)).toEqual(['a', 'b "c"', 'd e']);
    expect(() => parseLaunchCommand('cd -- /x')).toThrow();
  });

  let home: FakeHome;
  let folder: string;
  beforeEach(async () => {
    home = await makeFakeHome({ accounts: launchAccounts(), sessions: [] });
    folder = join(home.home, 'Desktop', 'work', 'foo');
    await mkdir(folder, { recursive: true });
  });
  afterEach(async () => {
    await home.cleanup();
  });

  it('the fake osascript opens the window, plays the trust flow and holds the dialog until a key is typed', async () => {
    const sid = randomUUID();
    const command = csCommand(folder, 7, { ...V03_LAUNCH_FLAGS }, sid, 'foo');
    await home.setRules('osascript', launchOsascriptRules({ flow: 'trust', folder, command }));
    const open = await sh(home, home.bins.osascript, ['-', command, ''], OPEN_SCRIPT);
    expect(open.stdout.replace(/\n$/, '')).toMatch(/^ok\n\/dev\/ttys\d{3,4}\n\d+$/);
    expect(open.stdout).toBe(`ok\n${LAUNCH_TTY}\n${LAUNCH_WINDOW_ID}\n`);

    const read = async () => (await sh(home, home.bins.osascript, ['-', LAUNCH_TTY, 'contents'], 'script')).stdout;
    // The contents mode answers the tab's height first, then its text.
    expect(await read()).toMatch(/^ok\n24\nLast login: .*\ntester@synthetic-mac ~ % cd -- /);
    expect(await read()).toContain('Yes, I trust this folder');
    expect(await read()).toContain('Yes, I trust this folder');
    expect(await sh(home, home.bins.osascript, ['-', LAUNCH_TTY, 'type', dialogAnswerBytes(0)], 'script')).toMatchObject({ stdout: 'ok\n' });
    expect(await read()).toContain('❯ Try "write a test for send.ts"');
    expect((await sh(home, home.bins.osascript, ['-', LAUNCH_TTY, 'find'], 'script')).stdout).toBe(`ok\n${LAUNCH_WINDOW_ID}\n1\nfoo — claude\n`);

    // the session file appears with the typed --session-id, under account 7
    expect(openWindowCommand(await home.calls('osascript'))).toBe(command);
    const s = await completeLaunch(home);
    expect(s).toMatchObject({ sid, account: 7, cwd: folder, tty: 'ttys099', pid: LAUNCH_PID });
    expect(s.file.startsWith(home.configDirFor(7))).toBe(true);
    expect(JSON.parse(await readFile(s.file, 'utf8'))).toMatchObject({ sessionId: sid, cwd: folder, name: 'foo', pid: LAUNCH_PID });
    expect(home.probe.isAlive(LAUNCH_PID)).toBe(true);
    expect(existsSync(s.transcriptPath)).toBe(true);
  });

  it('the fake osascript answers a dialog by the keys typed: the option they pick decides, other keys leave it up', async () => {
    const contents = async () => (await sh(home, home.bins.osascript, ['-', LAUNCH_TTY, 'contents'], 'script')).stdout;
    const type = (bytes: string) => sh(home, home.bins.osascript, ['-', LAUNCH_TTY, 'type', bytes], 'script');
    const play = async (flow: 'bypass' | 'trust', keys: string[]) => {
      await home.setRules('osascript', launchOsascriptRules({ flow, folder }));
      await contents(); // the shell
      await contents(); // the dialog
      for (const k of keys) await type(k);
      return contents();
    };
    expect(dialogAnswerBytes(0)).toBe('');
    expect(dialogAnswerBytes(2)).toBe('\u001b[B\u001b[B');
    expect(await play('bypass', [dialogAnswerBytes(1)])).toContain('❯ Try "write a test for send.ts"');
    expect(await play('bypass', [dialogAnswerBytes(0)])).toContain('Bye!'); // Enter picks "No, exit"
    expect(await play('trust', [dialogAnswerBytes(1)])).toContain('Bye!');
    expect(await play('trust', ['hello'])).toContain('Yes, I trust this folder'); // not an answer
    const exited = await play('bypass', [dialogAnswerBytes(0)]);
    expect(await contents()).toBe(exited); // Claude stays gone
  });

  it('the same rules set again start over (a second launch in one home)', async () => {
    const contents = async () => (await sh(home, home.bins.osascript, ['-', LAUNCH_TTY, 'contents'], 'script')).stdout;
    const rules = launchOsascriptRules({ flow: 'trust', folder });
    for (let launch = 0; launch < 2; launch++) {
      await home.setRules('osascript', rules);
      expect(await contents()).toMatch(/tester@synthetic-mac ~ % $/m);
      expect(await contents()).toContain('Yes, I trust this folder');
      await sh(home, home.bins.osascript, ['-', LAUNCH_TTY, 'type', dialogAnswerBytes(0)], 'script');
      expect(await contents()).toContain('❯ Try');
    }
  });

  it('the -1743 Automation refusal', async () => {
    await home.setRules('osascript', launchOsascriptRules({ flow: 'trust', folder, denied: true }));
    const r = await sh(home, home.bins.osascript, ['-', 'cd -- /x && cs 7 -- --chrome', ''], OPEN_SCRIPT);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/\(-1743\)\n$/);
  });

  it('a different account plays a config-dir mismatch', async () => {
    const command = csCommand(folder, 7, { ...V03_LAUNCH_FLAGS }, randomUUID(), 'foo');
    const s = await completeLaunch(home, { command, account: 8 });
    expect(s.configDir).toBe(home.configDirFor(8));
    expect(await realpath(s.cwd)).toBe(await realpath(folder));
  });

  it('a fresh session: an empty transcript and the start time given (home.now by default)', async () => {
    const command = csCommand(folder, 7, { ...V03_LAUNCH_FLAGS }, randomUUID(), 'foo');
    const s = await completeLaunch(home, { command });
    expect(await readFile(s.transcriptPath, 'utf8')).toBe('');
    expect(s.startMs).toBe(home.now);
    const at = Date.now();
    const t = await completeLaunch(home, { command: csCommand(folder, 7, { ...V03_LAUNCH_FLAGS }, randomUUID(), 'foo'), startedAt: at, pid: LAUNCH_PID + 1 });
    expect(t.startMs).toBe(at);
    expect((await home.readSessionFile(t.sid)).startedAt).toBe(at);
  });

  it('never creates a folder outside the fake home from the typed command', async () => {
    const never = '/Users/Shared/jantar-never';
    const command = csCommand(never, 7, { ...V03_LAUNCH_FLAGS }, randomUUID(), 'never');
    await expect(completeLaunch(home, { command })).rejects.toThrow(/outside the fake home/);
    expect(existsSync(never)).toBe(false);
    await expect(completeLaunch(home, { command: csCommand(join(home.root, '..', 'escaped'), 7, { ...V03_LAUNCH_FLAGS }, randomUUID(), 'x') })).rejects.toThrow(
      /outside the fake home/,
    );
    expect(existsSync(join(home.root, '..', 'escaped'))).toBe(false);
    expect(home.sessions).toHaveLength(0);
  });

  it('watchLaunch completes the launch once the dialog is answered', async () => {
    const sid = randomUUID();
    const command = csCommand(folder, 7, { ...V03_LAUNCH_FLAGS, permission: 'manual' }, sid, 'foo');
    await home.setRules('osascript', launchOsascriptRules({ flow: 'trust', folder, command }));
    const w = watchLaunch(home, { pollMs: 20 });
    await sh(home, home.bins.osascript, ['-', command, ''], OPEN_SCRIPT);
    await sh(home, home.bins.osascript, ['-', LAUNCH_TTY, 'contents'], 'script');
    await new Promise((r) => setTimeout(r, 100));
    expect(home.sessions).toHaveLength(0); // not before the answer
    await sh(home, home.bins.osascript, ['-', LAUNCH_TTY, 'type', dialogAnswerBytes(0)], 'script');
    const s = await w.session;
    expect(s.sid).toBe(sid);
    w.stop();

    const stopped = watchLaunch(home, { after: 'open', tty: '/dev/ttys777' });
    stopped.stop();
    await expect(stopped.session).rejects.toThrow(/stopped/);
  });

  it("watchLaunch takes the newest window opened after it started, not an earlier launch's", async () => {
    const first = csCommand(folder, 7, { ...V03_LAUNCH_FLAGS }, randomUUID(), 'first');
    await home.setRules('osascript', launchOsascriptRules({ flow: 'clean', folder }));
    await sh(home, home.bins.osascript, ['-', first, ''], OPEN_SCRIPT);
    await new Promise((r) => setTimeout(r, 20));
    const w = watchLaunch(home, { after: 'open', pollMs: 20, pid: LAUNCH_PID + 2 });
    const sid = randomUUID();
    await sh(home, home.bins.osascript, ['-', csCommand(folder, 8, { ...V03_LAUNCH_FLAGS }, sid, 'second'), ''], OPEN_SCRIPT);
    expect(await w.session).toMatchObject({ sid, account: 8, pid: LAUNCH_PID + 2 });
  });

  it('watchLaunch stops polling once the home is cleaned up', async () => {
    const h = await makeFakeHome({ sessions: [] });
    const w = watchLaunch(h, { pollMs: 20, timeoutMs: 60_000 });
    await h.cleanup();
    await expect(w.session).rejects.toThrow(/cleaned up/);
  });

  it('launchProcesses puts claude in the foreground of the launch tty', async () => {
    await home.setProcesses(launchProcesses({ startMs: home.now }));
    const r = await sh(home, home.bins.ps, ['-t', 'ttys099', '-o', 'pid=,stat=,comm=']);
    expect(r.stdout).toContain(`${LAUNCH_PID} S+ claude`);
  });
});
