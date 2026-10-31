import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountSchema,
  AlertSchema,
  MoveSchema,
  PendingRequestSchema,
  SendJobSchema,
  SessionSchema,
} from '@jantar/protocol';
import {
  DEFAULT_LIVE_SIDS,
  SECRET_MARKER,
  assistantText,
  encodeProjectDir,
  formatLstart,
  formatLstartLocal,
  makeAccount,
  makeAlert,
  makeFakeHome,
  makeMove,
  makePending,
  makeSendJob,
  makeSession,
  queueOperation,
  queuedCommand,
  slashCommand,
  slugifyEmail,
  timeline,
  userPrompt,
  type FakeHome,
} from '../src/index.js';

async function sh(home: FakeHome, file: string, args: string[], input?: string) {
  const child = execFile(file, args, { env: home.env });
  if (input !== undefined) child.stdin?.end(input);
  else child.stdin?.end();
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => (stdout += d));
  child.stderr?.on('data', (d) => (stderr += d));
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  return { code, stdout, stderr };
}

describe('makeFakeHome', () => {
  let home: FakeHome;
  beforeAll(async () => {
    home = await makeFakeHome({ ccw: true });
  });
  afterAll(async () => {
    await home.cleanup();
  });

  it('lives in a fresh temp dir and exports an isolated env', async () => {
    expect(home.root.startsWith(await realpath(tmpdir()))).toBe(true);
    expect(home.env.HOME).toBe(home.home);
    expect(home.env.JANTAR_HOME).toBe(home.jantarHome);
    expect(home.env.PATH.split(':')[0]).toBe(home.binDir);
    expect(home.env.LC_ALL).toBe('C');
    expect(await readdir(home.jantarHome)).toEqual([]);
  });

  it('lays out ~/.claude and three cswap profiles with symlinked settings', async () => {
    expect(existsSync(home.paths.claudeSettings)).toBe(true);
    const settings = JSON.parse(await readFile(home.paths.claudeSettings, 'utf8'));
    expect(settings.cleanupPeriodDays).toBe(3650);
    expect(settings.hooks.PreToolUse).toHaveLength(1);

    const profiles = (await readdir(home.paths.cswapProfiles)).sort();
    expect(profiles).toEqual(['2-bravo_example.com', '3-charlie_example.org', '4-delta_example.net']);
    for (const p of profiles) {
      const link = join(home.paths.cswapProfiles, p, 'settings.json');
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readlink(link)).toBe(home.paths.claudeSettings);
      expect(existsSync(join(home.paths.cswapProfiles, p, 'sessions'))).toBe(true);
    }
    expect(home.configDirFor(1)).toBe(home.paths.claudeHome);
    expect(home.configDirFor(2)).toBe(join(home.paths.cswapProfiles, '2-bravo_example.com'));
  });

  it('writes synthetic cswap state (sequence.json, usage cache schema 2)', async () => {
    const seq = JSON.parse(await readFile(home.paths.sequenceJson, 'utf8'));
    expect(seq.activeAccountNumber).toBe(1);
    expect(seq.sequence).toEqual([1, 2, 3, 4]);
    expect(seq.accounts['2']).toMatchObject({ email: 'bravo@example.com', alias: 'team-b' });
    expect(seq.accounts['3'].disabled).toBe(true);

    const usage = JSON.parse(await readFile(home.paths.usageJson, 'utf8'));
    expect(usage.schemaVersion).toBe(2);
    expect(usage.accounts['1'].lastGood.five_hour.pct).toBe(42);
    expect(usage.accounts['1'].email).toBe('alpha@example.com');
    expect(usage.accounts['3'].lastGood).toBeUndefined();
    expect(usage.accounts['4'].lastError).toBe('http-429');
    for (const a of home.accounts) expect(a.email).toMatch(/@example\.(com|org|net)$/);
  });

  it('creates session files for every case discovery must handle', async () => {
    expect(home.sessions).toHaveLength(7);
    const live = home.sessions.filter((s) => s.alive && !s.reused && s.entrypoint === 'cli').map((s) => s.sid);
    expect(live.sort()).toEqual([...DEFAULT_LIVE_SIDS].sort());

    const alpha = home.session(DEFAULT_LIVE_SIDS[0]);
    expect(alpha.file).toBe(join(home.paths.claudeSessions, '41001.json'));
    const json = await home.readSessionFile(alpha.sid);
    expect(json).toMatchObject({ pid: 41001, sessionId: alpha.sid, status: 'busy', entrypoint: 'cli', kind: 'interactive' });
    expect(json.procStart).toBe(alpha.procStart);
    expect(await readFile(alpha.keyFile, 'utf8')).toContain(SECRET_MARKER);

    const sdk = home.sessions.find((s) => s.entrypoint === 'sdk-cli');
    expect(sdk?.alive).toBe(true);
    expect(home.probe.isAlive(41006)).toBe(false);
    expect(home.probe.isAlive(41005)).toBe(true);
  });

  it('writes transcripts in the shared projects dir, or the profile dir when private', async () => {
    const bravo = home.session(DEFAULT_LIVE_SIDS[1]);
    expect(bravo.transcriptPath).toBe(join(home.paths.claudeProjects, encodeProjectDir(bravo.cwd), `${bravo.sid}.jsonl`));
    const lines = (await readFile(bravo.transcriptPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const types = lines.map((l) => l.type);
    expect(types).toEqual(['permission-mode', 'user', 'assistant', 'attachment', 'queue-operation', 'assistant', 'system']);
    expect(lines[3].attachment).toEqual({ type: 'queued_command', prompt: 'also update the changelog' });
    expect(lines[4]).toMatchObject({ operation: 'enqueue', content: 'and bump the version' });

    const delta = home.session(DEFAULT_LIVE_SIDS[3]);
    expect(delta.transcriptPath.startsWith(join(home.configDirFor(4), 'projects'))).toBe(true);
  });

  it('appends transcript entries and reports byte offsets', async () => {
    const sid = DEFAULT_LIVE_SIDS[0];
    const tl = timeline(home.now, sid, home.session(sid).cwd);
    const r = await home.appendTranscript(sid, [userPrompt(tl.next(), 'hello'), assistantText(tl.next(), 'hi')]);
    expect(r.after).toBeGreaterThan(r.before);
    expect(await home.transcriptSize(sid)).toBe(r.after);
    const tail = (await readFile(home.session(sid).transcriptPath, 'utf8')).slice(r.before);
    expect(tail.trim().split('\n').map((l) => JSON.parse(l).type)).toEqual(['user', 'assistant']);
  });

  it('runs a fake cswap that serves list --json and records the env it got', async () => {
    const r = await sh(home, home.bins.cswap, ['list', '--json']);
    expect(r.code).toBe(0);
    const list = JSON.parse(r.stdout);
    expect(list.schemaVersion).toBe(1);
    expect(list.accounts.map((a: { number: number }) => a.number)).toEqual([1, 2, 3, 4]);
    expect(list.accounts[2]).toMatchObject({ usageStatus: 'relogin_required', usage: null, disabled: true });
    expect(list.accounts[3].lastGoodUsage.fiveHour.pct).toBe(97);

    const bad = await sh(home, home.bins.cswap, ['switch', '2', '--json']);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.stdout).error.type).toBe('FakeError');

    const calls = await home.calls('cswap');
    expect(calls.map((c) => c.args)).toEqual([['list', '--json'], ['switch', '2', '--json']]);
    expect(calls[0]?.env.HOME).toBe(home.home);
    expect(calls[0]?.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    // names only, sorted (macOS may add its own, such as __CF_USER_TEXT_ENCODING)
    expect(calls[0]?.envKeys).toEqual(expect.arrayContaining(Object.keys(home.env)));
    expect(calls[0]?.envKeys).toEqual([...(calls[0]?.envKeys ?? [])].sort());
    expect(calls[0]?.envMarkers).toEqual([]);
  });

  it('runs a table-driven fake ps', async () => {
    // like the real ps, lstart is local time; procStart in the session file is UTC
    const alpha = home.session(DEFAULT_LIVE_SIDS[0]);
    const one = await sh(home, home.bins.ps, ['-o', 'lstart=', '-p', '41001']);
    expect(one.stdout.trim()).toBe(formatLstartLocal(alpha.startMs));
    expect(alpha.procStart).toBe(formatLstart(alpha.startMs));
    const old = home.sessions.find((s) => s.pid === 41005);
    const reused = await sh(home, home.bins.ps, ['-o', 'lstart=', '-p', '41005']);
    expect(reused.stdout.trim()).not.toBe(formatLstartLocal(old?.startMs ?? 0));
    const dead = await sh(home, home.bins.ps, ['-o', 'lstart=', '-p', '41006']);
    expect(dead.code).toBe(1);
    expect(dead.stdout).toBe('');
    const byTty = await sh(home, home.bins.ps, ['-t', 'ttys001', '-o', 'stat=,comm=']);
    expect(byTty.stdout.trim().split('\n')).toContain('S+ claude');
    const all = await sh(home, home.bins.ps, ['-axo', 'pid=,ppid=,comm=']);
    expect(all.stdout).toContain('41001 40001 claude');
    const withHeader = await sh(home, home.bins.ps, ['-o', 'pid,tty', '-p', '41002']);
    expect(withHeader.stdout.split('\n')[0]).toBe('PID TTY');
  });

  it('runs a fake osascript that records the script from stdin and the argv', async () => {
    await home.setRules('osascript', [{ match: { stdinIncludes: 'contents of' }, stdout: 'screen text\n' }]);
    const r = await sh(home, home.bins.osascript, ['-', 'user text stays in argv'], 'tell application "Terminal" to get contents of tab 1');
    expect(r.stdout).toBe('screen text\n');
    const other = await sh(home, home.bins.osascript, ['-'], 'something else');
    expect(other.stdout).toBe('');
    expect(other.code).toBe(0);
    const calls = await home.calls('osascript');
    expect(calls[0]?.args).toEqual(['-', 'user text stays in argv']);
    expect(calls[0]?.stdin).toContain('contents of tab 1');
    await home.clearCalls();
    expect(await home.calls('osascript')).toEqual([]);
  });

  it('fakes lsof lock holders and supports rule fallbacks and delays', async () => {
    const lock = join(home.paths.ccwSwitchDir, 'x.lock');
    expect((await sh(home, home.bins.lsof, [lock])).code).toBe(1);
    await home.setLsofOpen({ [lock]: 4242 });
    const held = await sh(home, home.bins.lsof, [lock]);
    expect(held.code).toBe(0);
    expect(held.stdout).toContain('4242');

    await home.setRules('terminal-notifier', [], { code: 3, stderr: 'nope' });
    expect((await sh(home, home.bins.terminalNotifier, ['-message', 'x'])).code).toBe(3);
    await home.setRules('screencapture', [{ match: { argsPrefix: ['-l'] }, delayMs: 300, code: 0 }]);
    const t0 = Date.now();
    await sh(home, home.bins.screencapture, ['-l', '1', '/dev/null']);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it('simulates clean exits, crashes and new sessions', async () => {
    const sid = DEFAULT_LIVE_SIDS[1];
    await home.updateSessionFile(sid, { status: 'busy', statusUpdatedAt: home.now });
    expect((await home.readSessionFile(sid)).status).toBe('busy');

    await home.killSession(sid);
    expect(home.probe.isAlive(home.session(sid).pid)).toBe(false);
    expect(existsSync(home.session(sid).file)).toBe(true);

    const added = await home.addSession({ sid: '88888888-8888-4888-8888-888888888888', pid: 41008, account: 2, project: 'echo-svc', status: 'idle' });
    expect(home.probe.isAlive(41008)).toBe(true);
    expect(existsSync(added.transcriptPath)).toBe(true);
    await home.removeSessionFile(added.sid);
    expect(existsSync(added.file)).toBe(false);
    expect(home.probe.isAlive(41008)).toBe(false);
  });

  it('refuses a session cwd outside its root and creates nothing there', async () => {
    const spec = { sid: '99999999-9999-4999-8999-999999999999', pid: 41009, account: 2, project: 'x' };
    await expect(home.addSession({ ...spec, cwd: '/Users/Shared/jantar-never' })).rejects.toThrow(/outside the fake home/);
    expect(existsSync('/Users/Shared/jantar-never')).toBe(false);
    await expect(home.addSession({ ...spec, cwd: `${home.home}/../../jantar-escaped` })).rejects.toThrow(/outside the fake home/);
    expect(home.sessions.some((x) => x.sid === spec.sid)).toBe(false);
    const inside = await home.addSession({ ...spec, cwd: join(home.home, 'Desktop', 'new-dir'), startedAt: home.now - 5_000 });
    expect(inside).toMatchObject({ cwd: join(home.home, 'Desktop', 'new-dir'), startMs: home.now - 5_000 });
  });

  it('writes legacy ccw files when asked', async () => {
    const sw = JSON.parse(await readFile(join(home.paths.ccwDir, 'switch.json'), 'utf8'));
    expect(sw).toMatchObject({ on: false, dry_run: true, hold: [3] });
    const burn = JSON.parse(await readFile(join(home.paths.ccwSwitchDir, 'burn.json'), 'utf8'));
    expect(Object.keys(burn).length).toBeGreaterThan(0);
    const p = await home.writeCcwMove({ sid: 'abc', step: 'parked', since: home.now / 1000, from: 2, to: null, why: 'synthetic' });
    expect(existsSync(p)).toBe(true);
    expect(existsSync(join(home.paths.ccwSwitchDir, 'abc.lock'))).toBe(true);
    await home.removeCcwMove('abc');
    expect(existsSync(p)).toBe(false);
  });
});

describe('cleanup', () => {
  it('removes only its own root', async () => {
    const h = await makeFakeHome({ sessions: [] });
    expect(h.sessions).toEqual([]);
    await h.cleanup();
    expect(existsSync(h.root)).toBe(false);
  });
});

describe('builders', () => {
  it('formats lstart like ps in UTC', () => {
    expect(formatLstart(Date.parse('2026-01-05T09:03:07Z'))).toBe('Mon Jan  5 09:03:07 2026');
    expect(formatLstart(Date.parse('2026-01-15T10:00:00Z'))).toBe('Thu Jan 15 10:00:00 2026');
  });

  it('slugs emails and encodes project dirs like the real tools', () => {
    expect(slugifyEmail('first.last+tag@example.com')).toBe('first.last_tag_example.com');
    expect(encodeProjectDir('/home/test/work/my.app')).toBe('-home-test-work-my-app');
  });

  it('builds entries the daemon recognises', () => {
    const tl = timeline('2026-01-15T10:00:00Z', 'sid', '/w');
    expect(slashCommand(tl.next(), 'compact').message).toMatchObject({ content: expect.stringContaining('<command-name>/compact</command-name>') });
    expect(queuedCommand(tl.next(), 'p')).toMatchObject({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'p' } });
    expect(queueOperation(tl.next(), 'enqueue', 'q')).toMatchObject({ type: 'queue-operation', operation: 'enqueue', content: 'q' });
    expect(tl.now()).toBe('2026-01-15T10:00:03.000Z');
  });

  it('makes model objects that pass the protocol schemas', () => {
    expect(SessionSchema.safeParse(makeSession()).success).toBe(true);
    expect(PendingRequestSchema.safeParse(makePending()).success).toBe(true);
    expect(AccountSchema.safeParse(makeAccount()).success).toBe(true);
    expect(MoveSchema.safeParse(makeMove()).success).toBe(true);
    expect(SendJobSchema.safeParse(makeSendJob()).success).toBe(true);
    expect(AlertSchema.safeParse(makeAlert()).success).toBe(true);
    expect(makeSession({ status: 'idle' }).status).toBe('idle');
  });
});

