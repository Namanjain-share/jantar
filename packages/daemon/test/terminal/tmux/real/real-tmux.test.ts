/**
 * v0.6 Fleet, lane L2: the tmux backend against REAL tmux (spec 4.2, S21,
 * S22). Runs only with JANTAR_REAL_TMUX=1, which run.sh sets inside a
 * throwaway node:22-bookworm container: never on the build Mac (the user's
 * own tmux server lives there). Every server here is private (`-S <tmp>`)
 * and its panes run keylog.mjs, which logs every byte it gets.
 *
 * - S21: `echo hi;`, a lone `;`, `a\;`, quotes and `#{` arrive byte for
 *   byte, then one Return 250 ms later in its own chunk; a two-line prompt
 *   arrives bracketed; a checked line `#(touch <file>)` runs nothing while
 *   tmux itself would run it in a format; copy mode entered between the
 *   capture and the write types nothing; a screen that changed between the
 *   capture and the write gives `changed`, nothing typed.
 * - S22: a second server with the same %0, and a pane id reused after a
 *   server restart: refused, nothing typed anywhere.
 * - Down Down Enter arrives as one chunk; every dialog fixture's answer
 *   reaches the pane as Terminal.app's bytes plus one Return; openWindow
 *   makes a 200x50 pane running a shell; findPane by tty and by pid
 *   ancestry; the tick sets paneId.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DIALOG_FIXTURES, SAMPLE_TEXT } from '@jantar/fixtures';
import { DIALOG_GATES, SettingsSchema, type Pane, type SessionDialogBody } from '@jantar/protocol';
import type { DaemonContext } from '../../../../src/contracts.js';
import { systemClock } from '../../../../src/core/clock.js';
import { createExecFile } from '../../../../src/core/exec.js';
import { createFakeExec, createTestContext, type ExecCall, type TestContext } from '../../../../src/core/testing.js';
import { answerPress, rowProblem } from '../../../../src/controls/dialog.js';
import { dialogOfScreen, rawExpect, readDialog } from '../../../../src/terminal/dialog.js';
import { TERMINAL_APP_SCRIPT, TerminalAppBackend } from '../../../../src/terminal/terminal-app/index.js';
import { TICK_MS, TmuxBackend, tmuxWrite } from '../../../../src/terminal/tmux/index.js';

const REAL = process.env.JANTAR_REAL_TMUX === '1';
const TMUX = process.env.JANTAR_TMUX_BIN ?? '/usr/bin/tmux';
const PS = '/usr/bin/ps';
const KEYLOG = join(dirname(fileURLToPath(import.meta.url)), 'keylog.mjs');
const SETTINGS = SettingsSchema.parse({ controls: { escapeVerified: true, clearVerified: true } });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** tmux on a private socket, argv only. */
function tmux(sock: string, ...args: string[]): string {
  return execFileSync(TMUX, ['-S', sock, ...args], { encoding: 'utf8' });
}

interface Logged {
  at: number;
  bytes: string;
}

async function chunks(log: string): Promise<Logged[]> {
  if (!existsSync(log)) return [];
  const text = await readFile(log, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { at: number; hex: string })
    .map((c) => ({ at: c.at, bytes: Buffer.from(c.hex, 'hex').toString('latin1') }));
}

async function bytesOf(log: string): Promise<string> {
  return (await chunks(log)).map((c) => c.bytes).join('');
}

/** UTF-8 text as the latin1 byte string the log gives back. */
const asBytes = (s: string) => Buffer.from(s, 'utf8').toString('latin1');

/** Wait until the log holds `want` (or `ms` pass); then a little longer, so a stray byte would show. */
async function until(log: string, want: string, ms = 3000): Promise<string> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await bytesOf(log);
    if (got.length >= want.length || Date.now() > end) {
      await wait(150);
      return bytesOf(log);
    }
    await wait(25);
  }
}

interface Server {
  sock: string;
  log: string;
  pane: Pane;
  pid: number;
}

let dir: string;
let n = 0;

/** A private server whose first pane runs keylog with `banner` on screen. */
async function server(name: string, banner = '', opts: { bracketed?: boolean; sock?: string } = {}): Promise<Server> {
  const sock = opts.sock ?? join(dir, `${name}.sock`);
  const log = join(dir, `${name}-${n++}.log`);
  const bannerFile = `${log}.banner`;
  await writeFile(bannerFile, banner);
  const cmd = `exec node ${KEYLOG} ${log} --banner ${bannerFile}${opts.bracketed ? ' --bracketed' : ''}`;
  tmux(sock, '-f', '/dev/null', 'new-session', '-d', '-s', `t${n}`, '-x', '200', '-y', '50', cmd);
  const end = Date.now() + 10_000;
  while (!existsSync(`${log}.ready`)) {
    if (Date.now() > end) throw new Error('keylog did not start');
    await wait(25);
  }
  const pid = Number(await readFile(`${log}.ready`, 'utf8'));
  const [id = '', tty = ''] = tmux(sock, 'list-panes', '-t', `t${n}`, '-F', '#{pane_id} #{pane_tty}').trim().split(' ');
  return { sock, log, pid, pane: { id: `tmux:${id}`, backend: 'tmux', handle: id, tty, foreground: 'claude', pid } };
}

function backendFor(sock: string, ctxOver: Partial<DaemonContext> = {}): { b: TmuxBackend; ctx: TestContext } {
  const ctx = createTestContext({ exec: createExecFile(), bins: { tmux: TMUX, ps: PS }, settings: SETTINGS, env: { ...process.env } as Record<string, string> });
  const real = { ...ctx, clock: systemClock, ...ctxOver } as TestContext;
  return { b: new TmuxBackend(real, { socket: sock }), ctx: real };
}

describe.skipIf(!REAL)('real tmux (JANTAR_REAL_TMUX=1, in a container)', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jantar-real-tmux-'));
  });
  afterEach(async () => {
    for (const f of ['a', 'b', 'c', 'main'].map((x) => join(dir, `${x}.sock`))) {
      try {
        execFileSync(TMUX, ['-S', f, 'kill-server'], { stdio: 'ignore' });
      } catch {
        // not running
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('tmux is 3.2 or later and the backend says available', async () => {
    const s = await server('main');
    expect(await backendFor(s.sock).b.available()).toBe(true);
  });

  describe('S21: text arrives byte for byte, never through argv', () => {
    for (const text of ['echo hi;', ';', 'a\\;', `it's "quoted" and \`ticked\``, 'x #{pane_id} y', 'tab\tinside', 'naïve 漢字 ❯']) {
      it(JSON.stringify(text), async () => {
        const s = await server('main');
        const { b } = backendFor(s.sock);
        expect(await b.type(s.pane, text)).toEqual({ ok: true });
        const want = `${asBytes(text)}\r`;
        expect(await until(s.log, want)).toBe(want);
        // the Return came in its own chunk, after the text and past Claude's paste window
        const cs = await chunks(s.log);
        const last = cs[cs.length - 1] as Logged;
        expect(last.bytes).toBe('\r');
        expect(last.at - (cs[0] as Logged).at).toBeGreaterThanOrEqual(200);
      });
    }

    it('a two-line prompt arrives as one bracketed paste, its line feed kept, then the Return', async () => {
      const s = await server('main', '', { bracketed: true });
      const { b } = backendFor(s.sock);
      expect(await b.type(s.pane, 'line one\nline two')).toEqual({ ok: true });
      const want = '\u001b[200~line one\nline two\u001b[201~\r';
      expect(await until(s.log, want)).toBe(want);
    });

    it('premise: tmux eats a trailing ; in an argv item (why text never goes there)', async () => {
      const s = await server('main');
      tmux(s.sock, 'send-keys', '-t', s.pane.handle, '-l', '--', 'echo hi;');
      expect(await until(s.log, 'echo hi;', 800)).toBe('echo hi');
    });

    it('a checked line #(touch <file>) runs nothing, while tmux would run it in a format', async () => {
      const pwned = join(dir, 'pwned');
      const premise = join(dir, 'premise');
      const line = `  #(touch ${pwned}) {a,b} [x] *y? \\z`;
      const s = await server('main', `Run this?\n${line}\n❯ 1. Yes\n  2. No\n`);
      // the hazard is real: a format with #() runs a shell command
      tmux(s.sock, 'display-message', '-p', '-t', s.pane.handle, `#(touch ${premise})`);
      const end = Date.now() + 3000;
      while (!existsSync(premise) && Date.now() < end) await wait(50);
      expect(existsSync(premise)).toBe(true);
      const { b } = backendFor(s.sock);
      const screen = await b.readScreen(s.pane);
      expect(screen.ok && screen.raw).toContain(line);
      expect(await b.pressKey(s.pane, 'enter', { expect: `Run this?\n${line}\n❯ 1. Yes` })).toEqual({ ok: true });
      expect(await until(s.log, '\r')).toBe('\r');
      await wait(500);
      expect(existsSync(pwned)).toBe(false);
    });

    it('copy mode entered between the capture and the write: nothing typed', async () => {
      const s = await server('main', 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n');
      const { b, ctx } = backendFor(s.sock);
      const screen = await b.readScreen(s.pane);
      expect(screen.ok).toBe(true);
      tmux(s.sock, 'copy-mode', '-t', s.pane.handle);
      // the gated step itself, with the lines the capture showed
      expect(await tmuxWrite(ctx, { socket: s.sock }, s.pane, { keys: '\u001b[B', enter: true, expect: 'Do you want to proceed?\n❯ 1. Yes' })).toMatchObject({ ok: false, code: 'changed' });
      // ungated: the refusal is named
      const r = await b.pressEnter(s.pane);
      expect(r).toMatchObject({ ok: false, code: 'unsupported' });
      expect(r.ok ? '' : r.reason).toMatch(/copy mode/u);
      tmux(s.sock, 'send-keys', '-t', s.pane.handle, '-X', 'cancel');
      await wait(300);
      expect(await bytesOf(s.log)).toBe('');
      // out of copy mode, the same write goes through
      expect(await b.pressEnter(s.pane)).toEqual({ ok: true });
      expect(await until(s.log, '\r')).toBe('\r');
    });

    it('a screen that changed between the capture and the write gives changed, nothing typed, no buffer left', async () => {
      const s = await server('main', 'Which colour?\n❯ 1. Red\n  2. Type something.\n');
      const { ctx } = backendFor(s.sock);
      const r = await tmuxWrite(ctx, { socket: s.sock }, s.pane, { keys: '\u001b[B', text: SAMPLE_TEXT, enter: true, expect: 'Which colour?\n❯ 1. Blue' });
      expect(r).toMatchObject({ ok: false, code: 'changed' });
      await wait(300);
      expect(await bytesOf(s.log)).toBe('');
      expect(tmux(s.sock, 'list-buffers', '-F', '#{buffer_name}').trim()).toBe('');
    });
  });

  describe('S22: a write reaches only the session\'s own pane', () => {
    it('a second server with the same %0: not found, refused, nothing typed in either', async () => {
      const a = await server('a');
      const other = await server('b');
      expect(a.pane.handle).toBe(other.pane.handle);
      expect(a.pane.tty).not.toBe(other.pane.tty);
      const { b, ctx } = backendFor(a.sock);
      // a session running in the other server's pane
      expect(await b.findPane({ tty: other.pane.tty, pid: other.pid })).toBeNull();
      expect(await tmuxWrite(ctx, { socket: a.sock }, other.pane, { text: 'stray', enter: true })).toMatchObject({ ok: false, code: 'not_found' });
      await wait(300);
      expect(await bytesOf(a.log)).toBe('');
      expect(await bytesOf(other.log)).toBe('');
    });

    it('a pane id reused after a server restart: refused, nothing typed', async () => {
      const first = await server('a');
      tmux(first.sock, 'kill-server');
      await wait(300);
      // another server takes the freed tty, so the restarted %0 gets a new one
      const holder = await server('c');
      const again = await server('a');
      expect(again.pane.handle).toBe(first.pane.handle);
      expect(again.pane.tty).not.toBe(first.pane.tty);
      const { ctx } = backendFor(again.sock);
      expect(await tmuxWrite(ctx, { socket: again.sock }, first.pane, { text: 'stray', enter: true })).toMatchObject({ ok: false, code: 'not_found' });
      await wait(300);
      expect(await bytesOf(again.log)).toBe('');
      expect(await bytesOf(holder.log)).toBe('');
      expect(tmux(again.sock, 'list-buffers', '-F', '#{buffer_name}').trim()).toBe('');
    });
  });

  it('Down Down Enter arrives as one chunk', async () => {
    const s = await server('main');
    const { b } = backendFor(s.sock);
    expect(await b.pressKey(s.pane, 'down', { repeat: 2 })).toEqual({ ok: true });
    await until(s.log, '\u001b[B\u001b[B\r');
    expect((await chunks(s.log)).map((c) => c.bytes)).toEqual(['\u001b[B\u001b[B\r']);
  });

  it('every dialog fixture\'s answer reaches the pane as Terminal.app\'s bytes plus one Return', async () => {
    let answered = 0;
    for (const f of DIALOG_FIXTURES) {
      const probe = await server('main', f.screen);
      const { b } = backendFor(probe.sock);
      const screen = await b.readScreen(probe.pane, { lines: 400 });
      if (!screen.ok) throw new Error(`${f.name}: ${screen.reason}`);
      tmux(probe.sock, 'kill-server');
      const raw = screen.raw;
      const { dialog, block } = dialogOfScreen(raw, DIALOG_GATES);
      if (!dialog || !block) continue;
      const expectText = rawExpect(raw, block.from, block.to, readDialog(raw, DIALOG_GATES).countdown);
      for (const [i, o] of dialog.options.entries()) {
        const body: SessionDialogBody = { fingerprint: dialog.fingerprint, option: i, ...(o.role === 'text' ? { text: SAMPLE_TEXT } : {}), ...(o.hold ? { confirm: true } : {}) };
        if (rowProblem(dialog, body, DIALOG_GATES)) continue;
        const press = answerPress(dialog, body, expectText);
        const mac = await terminalPayload(press);
        const s = await server('main', f.screen);
        const t = backendFor(s.sock);
        expect(await t.b.pressKey(s.pane, press.key, press.opts), `${f.name} ${i}`).toEqual({ ok: true });
        const want = `${asBytes(mac)}\r`;
        expect(await until(s.log, want), `${f.name} ${i}`).toBe(want);
        tmux(s.sock, 'kill-server');
        answered++;
      }
    }
    expect(answered).toBeGreaterThan(20);
  }, 300_000);

  it('openWindow makes a 200x50 pane running a shell, and types the line into it', async () => {
    const sock = join(dir, 'main.sock');
    const { b } = backendFor(sock);
    const marker = join(dir, 'opened');
    const r = await b.openWindow(`touch ${marker} && echo JANTAR-OPENED`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.windowId).toMatch(/^%\d+$/u);
    expect(r.tty).toMatch(/^\/dev\/pts\/\d+$/u);
    const end = Date.now() + 5000;
    while (!existsSync(marker) && Date.now() < end) await wait(50);
    expect(existsSync(marker)).toBe(true);
    const info = tmux(sock, 'display-message', '-p', '-t', r.windowId, '#{pane_width}x#{pane_height} #{pane_current_command}').trim();
    expect(info).toMatch(/^200x50 (?:bash|sh|dash|zsh)$/u);
    const pane = await b.findPane({ tty: r.tty });
    expect(pane?.handle).toBe(r.windowId);
    expect(pane?.foreground).toBe('shell');
  });

  it('findPane by tty and, with no tty, by pid ancestry (real /proc); foreground is exact with the pid', async () => {
    const s = await server('main');
    const { b } = backendFor(s.sock);
    expect(await b.findPane({ tty: s.pane.tty, pid: s.pid })).toMatchObject({ handle: s.pane.handle, tty: s.pane.tty, foreground: 'claude', pid: s.pid });
    expect((await b.findPane({ pid: s.pid }))?.handle).toBe(s.pane.handle);
  });

  it('the tick sets paneId on a local session in the pane', async () => {
    const s = await server('main');
    const { b, ctx } = backendFor(s.sock);
    ctx.store.emit({
      type: 'session.added',
      sid: 'real-1',
      account: 0,
      data: {
        session: {
          sid: 'real-1', pid: s.pid, procStart: '', account: 0, configDir: '/root/.claude', cwd: '/', folder: '/', entrypoint: 'cli',
          status: 'idle', statusSource: 'session-file', statusSince: '2026-01-15T10:00:00.000Z', subagentsRunning: 0, tty: s.pane.tty.replace('/dev/', ''),
        },
      },
    });
    await b.start();
    try {
      expect(ctx.store.getState().sessions['real-1']?.paneId).toBe(s.pane.handle);
      expect(TICK_MS).toBe(10_000);
    } finally {
      await b.stop();
    }
  });
});

/** Terminal.app's bytes for a press (a fake osascript; nothing runs). */
async function terminalPayload(press: ReturnType<typeof answerPress>): Promise<string> {
  const exec = createFakeExec((call: ExecCall) => (call.file.endsWith('/osascript') && call.opts.input === TERMINAL_APP_SCRIPT ? { stdout: 'ok\n' } : undefined));
  const b = new TerminalAppBackend(createTestContext({ exec, settings: SETTINGS }), { platform: 'darwin' });
  const pane: Pane = { id: 'terminal-app:ttys003', backend: 'terminal-app', handle: '1:1', tty: '/dev/ttys003', foreground: 'claude' };
  expect(await b.pressKey(pane, press.key, press.opts)).toEqual({ ok: true });
  return exec.calls.find((c) => c.file.endsWith('/osascript'))?.args[3] as string;
}
