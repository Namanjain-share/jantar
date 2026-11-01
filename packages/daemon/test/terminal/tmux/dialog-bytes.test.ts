/**
 * v0.6 Fleet, lane L2: a dialog answer sends the same bytes through tmux as
 * through Terminal.app (spec 9.3 L2's done-when). For every shared dialog
 * fixture and every option, with every gate off and with the shipped gates,
 * the answer route's one write (controls/dialog.ts answerPress) goes through
 * both backends:
 *
 * - Terminal.app: osascript gets `- <tty> typeif <bytes> <block>`, and its
 *   `do script` adds the one Return.
 * - tmux: the pane gets the key bytes from `send-keys -H`, a text row's text
 *   from the buffer (load-buffer on stdin), then one `send-keys Enter`, in
 *   one gated step whose `#{C:}` lines come from the same block.
 *
 * The pane's bytes are Terminal's bytes plus that one Return, every time. A
 * row the rules refuse is refused by both. Nothing runs osascript or tmux:
 * fakes answer.
 */
import { describe, expect, it } from 'vitest';
import { DIALOG_FIXTURES, SAMPLE_TEXT, type DialogFixture } from '@jantar/fixtures';
import { DIALOG_GATES, SettingsSchema, type DialogGates, type Pane, type SessionDialogBody } from '@jantar/protocol';
import { createFakeExec, createTestContext, type ExecCall } from '../../../src/core/testing.js';
import { answerPress, rowProblem } from '../../../src/controls/dialog.js';
import { dialogOfScreen, rawExpect, readDialog } from '../../../src/terminal/dialog.js';
import { TERMINAL_APP_SCRIPT, TerminalAppBackend } from '../../../src/terminal/terminal-app/index.js';
import { TmuxBackend } from '../../../src/terminal/tmux/index.js';
import { SOCKET, TMUX_BIN, createFakeTmux } from './fake-tmux.js';

const MAC_TTY = '/dev/ttys003';
const PTS = '/dev/pts/3';
const OFF: DialogGates = { up: false, tall: false, noFirst: false };
const SETTINGS = SettingsSchema.parse({ controls: { escapeVerified: true, clearVerified: true } });

function bodyFor(fingerprint: string, i: number, o: { role: string; hold?: string }): SessionDialogBody {
  return { fingerprint, option: i, ...(o.role === 'text' ? { text: SAMPLE_TEXT } : {}), ...(o.hold ? { confirm: true } : {}) };
}

/** Terminal.app: the bytes of its one typeif write (its Return not included). */
async function terminalBytes(press: ReturnType<typeof answerPress>): Promise<string> {
  const exec = createFakeExec((call: ExecCall) => {
    if (!call.file.endsWith('/osascript')) return undefined;
    if (call.opts.input !== TERMINAL_APP_SCRIPT || call.args[1] !== MAC_TTY || call.args[2] !== 'typeif') return { code: 99 };
    return { stdout: 'ok\n' };
  });
  const b = new TerminalAppBackend(createTestContext({ exec, settings: SETTINGS }), { platform: 'darwin' });
  const pane: Pane = { id: 'terminal-app:ttys003', backend: 'terminal-app', handle: '4013:2', tty: MAC_TTY, foreground: 'claude' };
  expect(await b.pressKey(pane, press.key, press.opts)).toEqual({ ok: true });
  const calls = exec.calls.filter((c) => c.file.endsWith('/osascript'));
  expect(calls.length).toBe(1);
  return calls[0]?.args[3] as string;
}

/** tmux: what the pane got, the do-string of the one gated step and the text that went in on stdin. */
async function tmuxBytes(f: DialogFixture, press: ReturnType<typeof answerPress>) {
  const fake = createFakeTmux();
  const p = fake.addPane({ id: '%3', tty: PTS, screen: f.screen });
  const exec = createFakeExec(fake.handler);
  const b = new TmuxBackend(createTestContext({ exec, settings: SETTINGS, bins: { tmux: TMUX_BIN } }), { socket: SOCKET });
  const pane: Pane = { id: 'tmux:%3', backend: 'tmux', handle: '%3', tty: PTS, foreground: 'claude' };
  expect(await b.pressKey(pane, press.key, press.opts), f.name).toEqual({ ok: true });
  const gated = fake.calls.filter((c) => c[0] === 'if-shell');
  expect(gated.length).toBe(1);
  expect(fake.shellRuns).toEqual([]);
  expect(fake.buffers.size).toBe(0);
  return { input: p.input, run: gated[0]?.[5] as string, gate: gated[0]?.[4] as string, stdin: fake.inputs };
}

async function compare(f: DialogFixture, gates: DialogGates): Promise<number> {
  const { dialog, block } = dialogOfScreen(f.screen, gates);
  if (!dialog || !block) return 0;
  const raw = rawExpect(f.screen, block.from, block.to, readDialog(f.screen, gates).countdown);
  let compared = 0;
  for (const [i, o] of dialog.options.entries()) {
    const body = bodyFor(dialog.fingerprint, i, o);
    if (rowProblem(dialog, body, gates)) continue;
    const press = answerPress(dialog, body, raw);
    const mac = await terminalBytes(press);
    const t = await tmuxBytes(f, press);
    const label = `${f.name} ${i}`;
    // Terminal's bytes, then its one Return.
    expect(t.input, label).toBe(`${mac}\r`);
    // Exactly one Enter, last; the text (if any) only through the buffer.
    expect(t.run.match(/send-keys -t %3 Enter/gu)?.length, label).toBe(1);
    expect(t.run.endsWith('send-keys -t %3 Enter'), label).toBe(true);
    expect(t.stdin, label).toEqual(o.role === 'text' ? [SAMPLE_TEXT] : []);
    expect(t.gate, label).toContain('#{C:');
    compared++;
  }
  return compared;
}

describe('dialog answers: tmux bytes equal Terminal.app\'s (L2)', () => {
  for (const f of DIALOG_FIXTURES) {
    it(`${f.name}: gates off and the shipped gates`, async () => {
      await compare(f, OFF);
      await compare(f, DIALOG_GATES);
    });
  }

  it('covers every answerable row of the fixtures', async () => {
    let total = 0;
    for (const f of DIALOG_FIXTURES) total += await compare(f, DIALOG_GATES);
    // the shipped gates answer most rows of most fixtures: a guard against a table that silently tests nothing
    expect(total).toBeGreaterThan(40);
  });
});
