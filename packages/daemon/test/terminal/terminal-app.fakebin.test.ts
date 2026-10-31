/**
 * The Terminal.app backend and the writer against the fixtures' fake
 * `osascript` and `ps` executables, spawned for real through the real
 * ExecFile. Proves the process-level contract (script on stdin, text only
 * in argv) and a whole send-with-proof on real timers. No real Terminal,
 * osascript or ps is ever run: PATH and every binary path point into a
 * synthetic home.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SAMPLE_TEXT, dialogFixture, formatLstart, makeFakeHome, makeSession, type FakeHome } from '@jantar/fixtures';
import type { ExecFile } from '../../src/contracts.js';
import { systemClock } from '../../src/core/clock.js';
import { createExecFile } from '../../src/core/exec.js';
import { createTestContext, fixedProbe } from '../../src/core/testing.js';
import { buildControlsService } from '../../src/controls/service.js';
import { dialogOfScreen, rawSlice } from '../../src/terminal/dialog.js';
import { TERMINAL_APP_SCRIPT, TerminalAppBackend } from '../../src/terminal/index.js';
import { createWriterWith } from '../../src/writer/index.js';
import { LockingWriter } from '../controls/helpers.js';
import { FakeCcw, FakeHooks, FakeSessions, FakeTranscripts, userEntry } from '../writer/helpers.js';

const RULE = '─'.repeat(60);
const SCREEN = ['⏺ Ready.', '', RULE, '❯ Try "write a test"', RULE, '  ⏵⏵ accept edits on (shift+tab to cycle)'].join('\n');
const SID = '11111111-1111-4111-8111-111111111111';
const PID = 41001;
const TTY = '/dev/ttys003';
const CWD = '/synthetic/home/work/alpha-app';

let home: FakeHome | null = null;
afterEach(async () => {
  await home?.cleanup();
  home = null;
});

/** The fake osascript's answers, with `screen` as the tab's contents. */
function osascriptRules(screen: string) {
  return [
    { match: { argsPrefix: ['-', TTY, 'find'] }, stdout: 'ok\n7\n1\nalpha-app — claude\n' },
    { match: { argsPrefix: ['-', TTY, 'contents'] }, stdout: `ok\n24\n${screen}\n` },
    { match: { argsPrefix: ['-', TTY, 'type'] }, stdout: 'ok\n' },
    { match: { argsPrefix: ['-', TTY, 'focus'] }, stdout: 'ok\n' },
  ];
}
const MISSING = { stdout: '__JANTAR_MISSING__\n' };

async function setup() {
  home = await makeFakeHome({ sessions: [] });
  const startMs = Date.now() - 3600_000;
  await home.setProcesses([
    { pid: 900, ppid: 1, tty: 'ttys003', stat: 'Ss', comm: 'login', args: 'login -pf tester', startMs, pcpu: 0, user: 'tester' },
    { pid: PID, ppid: 900, tty: 'ttys003', stat: 'S+', comm: '/synthetic/bin/claude', args: 'claude', startMs, pcpu: 1, user: 'tester' },
  ]);
  await home.setRules('osascript', osascriptRules(SCREEN), MISSING);
  const env = { ...home.env, TZ: 'UTC' };
  const realExec = createExecFile({ env });
  const ctx = createTestContext({
    userHome: home.home,
    env,
    exec: realExec,
    proc: fixedProbe([PID]),
    bins: { osascript: home.bins.osascript, ps: home.bins.ps },
  });
  return { home, ctx, realExec, startMs };
}

describe('Terminal.app backend through real (fake) executables', () => {
  it('runs `osascript -` with the constant script on stdin and the text only in argv', async () => {
    const { home: h, ctx } = await setup();
    const backend = new TerminalAppBackend(ctx, { platform: 'darwin' });
    const pane = await backend.findPane({ tty: 'ttys003', pid: PID });
    expect(pane).toMatchObject({ id: 'terminal-app:ttys003', handle: '7:1', foreground: 'claude' });
    const screen = await backend.readScreen(pane!, { lines: 3 });
    expect(screen.ok && screen.text.split('\n')).toEqual(['❯ Try "write a test"', RULE, '  ⏵⏵ accept edits on (shift+tab to cycle)']);
    // The contents mode's first line is the tab's height.
    expect(screen).toMatchObject({ ok: true, tabRows: 24 });
    const marker = 'end tell" & do shell script "zq7-never-run';
    expect(await backend.type(pane!, marker)).toEqual({ ok: true });
    expect(await backend.focus(pane!)).toEqual({ ok: true });

    const calls = await h.calls('osascript');
    expect(calls.length).toBe(4);
    for (const c of calls) {
      expect(c.args[0]).toBe('-');
      expect(c.stdin).toBe(TERMINAL_APP_SCRIPT);
      expect(c.stdin).not.toContain('zq7-never-run');
    }
    expect(calls[2]?.args).toEqual(['-', TTY, 'type', marker]);
    const psCalls = await h.calls('ps');
    expect(psCalls.some((c) => c.args.join(' ') === '-t ttys003 -o pid=,stat=,comm=' && c.env.LC_ALL === 'C')).toBe(true);
  });

  it('sends a prompt end to end and proves it from the transcript', async () => {
    const { ctx, realExec, startMs } = await setup();
    const transcripts = new FakeTranscripts();
    const path = `${CWD}/${SID}.jsonl`;
    transcripts.create(SID, path, []);
    const prompt = 'run the synthetic tests and report back';
    // The typed text shows in the box; Claude takes it when it gets a carriage return. Modelled on the exec
    // layer, after the real spawn.
    const typed = SCREEN.replace('❯ Try "write a test"', `❯ ${prompt}`);
    const exec: ExecFile = async (file, args, opts) => {
      const r = await realExec(file, args, opts);
      if (file.endsWith('/osascript') && args[2] === 'type' && args[3] === prompt) {
        await home!.setRules('osascript', osascriptRules(typed), MISSING);
      }
      if (file.endsWith('/osascript') && args[2] === 'type' && args[3] === '\r') {
        await home!.setRules('osascript', osascriptRules(SCREEN), MISSING);
        transcripts.append(SID, [userEntry({ sessionId: SID, cwd: CWD, at: new Date().toISOString() }, prompt)]);
      }
      return r;
    };
    const live = { ...ctx, exec, clock: systemClock };
    live.store.emit({
      type: 'session.added',
      sid: SID,
      data: { session: makeSession({ sid: SID, pid: PID, procStart: formatLstart(startMs), tty: TTY, status: 'idle', cwd: CWD }) },
    });
    const writer = createWriterWith(
      live,
      {
        sessions: new FakeSessions(),
        terminal: new TerminalAppBackend(live, { platform: 'darwin' }),
        transcripts,
        hooks: new FakeHooks(),
        ccwLegacy: new FakeCcw(),
      },
      { enterDelayMs: 150, enterIntervalMs: 150, proofPollMs: 25, maxEnters: 4 },
    );
    await writer.start();
    const r = await writer.submit({ sid: SID, text: prompt, onDraft: 'refuse', actor: { kind: 'cli' } });
    expect(r.ok).toBe(true);
    const job = await writer.wait(r.ok ? r.job.id : '', 12_000);
    await writer.stop();
    expect(job?.stage).toBe('proven');
    expect(job?.proof?.kind).toBe('user');
    expect(job?.attempts).toBe(1);
    const calls = await home!.calls('osascript');
    expect(calls.filter((c) => c.args[2] === 'type').map((c) => c.args[3])).toEqual([prompt, '\r']);
    expect(calls.every((c) => c.stdin === TERMINAL_APP_SCRIPT)).toBe(true);
    // procStart was checked with ps in UTC.
    const lstart = (await home!.calls('ps')).find((c) => c.args[1] === 'lstart=');
    expect(lstart?.env.TZ).toBe('UTC');
  });
});

describe('compare-and-type through the fake osascript (v0.4.2, D10)', () => {
  const PLAN = dialogFixture('PLAN_80COL').screen;
  const WORKING = ['● Writing the plan out.', '', RULE, '❯ ', RULE, '  ⏸ manual mode on · ? for shortcuts'].join('\n');

  it('typeif types only while the tab still shows the expected text, case and spaces counted', async () => {
    const { home: h, ctx } = await setup();
    await h.setRules('osascript', osascriptRules(PLAN), MISSING);
    const backend = new TerminalAppBackend(ctx, { platform: 'darwin' });
    const pane = await backend.findPane({ tty: 'ttys003', pid: PID });
    const read = await backend.readScreen(pane!, { lines: 60 });
    // The tab's text as Terminal gave it (the runner drops osascript's own last newline).
    expect(read.ok && read.raw).toBe(PLAN);
    const { block } = dialogOfScreen(read.ok ? (read.raw ?? '') : '');
    const expectText = rawSlice(read.ok ? (read.raw ?? '') : '', block!.from, block!.to);
    expect(await backend.pressKey(pane!, 'down', { repeat: 2, text: SAMPLE_TEXT, expect: expectText })).toEqual({ ok: true });
    // Another case, another space, or the text gone: nothing typed.
    for (const other of [expectText.replace('Ready to code?', 'ready to code?'), expectText.replace('❯ 1.', '❯  1.'), 'not on the screen']) {
      expect(await backend.pressKey(pane!, 'enter', { expect: other })).toEqual({ ok: false, code: 'changed', reason: 'the terminal changed before Jantar typed' });
    }
    const calls = (await h.calls('osascript')).filter((c) => c.args[2] === 'typeif');
    expect(calls.map((c) => c.args)).toEqual([
      ['-', TTY, 'typeif', '\u001b[B\u001b[Bteal', expectText],
      ['-', TTY, 'typeif', '', expectText.replace('Ready to code?', 'ready to code?')],
      ['-', TTY, 'typeif', '', expectText.replace('❯ 1.', '❯  1.')],
      ['-', TTY, 'typeif', '', 'not on the screen'],
    ]);
    for (const c of calls) expect(c.stdin).toBe(TERMINAL_APP_SCRIPT);
    // No plain `type` ever ran.
    expect((await h.calls('osascript')).some((c) => c.args[2] === 'type')).toBe(false);
  });

  it('a whole dialog answer: the guarded read, one typeif write with the raw block, then the reads that see it gone', async () => {
    const { home: h, ctx, realExec, startMs } = await setup();
    await h.setRules('osascript', osascriptRules(PLAN), MISSING);
    // Claude takes the answer: the tab shows it at work once the typeif write has run.
    const exec: ExecFile = async (file, args, opts) => {
      const r = await realExec(file, args, opts);
      if (file.endsWith('/osascript') && args[2] === 'typeif' && r.stdout.startsWith('ok')) await h.setRules('osascript', osascriptRules(WORKING), MISSING);
      return r;
    };
    const live = { ...ctx, exec, clock: systemClock };
    live.store.emit({
      type: 'session.added',
      sid: SID,
      data: { session: makeSession({ sid: SID, pid: PID, procStart: formatLstart(startMs), tty: TTY, status: 'waiting', cwd: CWD }) },
    });
    const terminal = new TerminalAppBackend(live, { platform: 'darwin' });
    const controls = buildControlsService(live, {
      sessions: new FakeSessions(),
      terminal,
      writer: new LockingWriter(),
      hooks: new FakeHooks(),
      transcripts: new FakeTranscripts(),
      ccwLegacy: new FakeCcw(),
    });
    const shown = dialogOfScreen(PLAN).dialog!;
    const r = await controls.answerDialog(SID, { fingerprint: shown.fingerprint, option: 2, text: SAMPLE_TEXT }, { kind: 'device', deviceId: 'dev-1', scopes: ['read', 'control'] });
    expect(r).toEqual({ ok: true, outcome: 'done', dialog: null, kind: 'plan', role: 'text', options: 3 });
    const calls = await h.calls('osascript');
    const writes = calls.filter((c) => c.args[2] === 'typeif' || c.args[2] === 'type');
    const { block } = dialogOfScreen(PLAN);
    expect(writes.map((c) => c.args)).toEqual([['-', TTY, 'typeif', '\u001b[B\u001b[Bteal', rawSlice(PLAN, block!.from, block!.to)]]);
    // Read under the lock before the write, and twice after it.
    const typeAt = calls.findIndex((c) => c.args[2] === 'typeif');
    expect(calls.slice(0, typeAt).some((c) => c.args[2] === 'contents')).toBe(true);
    expect(calls.slice(typeAt + 1).filter((c) => c.args[2] === 'contents').length).toBeGreaterThanOrEqual(2);
  });
});
