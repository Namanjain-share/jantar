/**
 * The bytes a dialog answer types (spec 2.5, D3, D10): for every shared
 * fixture and every option, with every gate off, with the fixture's own
 * gates on and with the shipped gates (Up and tall on since SP14 and SP15),
 * the answer route's row rules and its one write
 * (controls/dialog.ts rowProblem and answerPress) go through the real
 * Terminal.app key path (terminal-app/keys.ts, the backend's `typeif` mode)
 * and reach osascript as exactly `- <tty> typeif <bytes> <block>`: Down runs
 * (Up only with DIALOG_GATES.up), then a text row's text, compared against
 * the dialog's raw block. Never a digit outside the text, Tab, Shift+Tab,
 * Left/Right, Ctrl+G or a Return of its own (Terminal adds the one Return).
 * A row the rules refuse is `null`, as the fixture says. Nothing runs
 * osascript: a fake exec answers.
 */
import { describe, expect, it } from 'vitest';
import { DIALOG_FIXTURES, SAMPLE_TEXT, dialogFixture, withGates, type DialogFixture } from '@jantar/fixtures';
import { DIALOG_GATES, SettingsSchema, type DialogGates, type Pane, type SessionDialogBody } from '@jantar/protocol';
import { createFakeExec, createTestContext, type ExecCall } from '../../src/core/testing.js';
import { answerPress, rowProblem } from '../../src/controls/dialog.js';
import { dialogOfScreen, rawSlice } from '../../src/terminal/dialog.js';
import { TERMINAL_APP_SCRIPT, TerminalAppBackend } from '../../src/terminal/terminal-app/index.js';

const TTY = '/dev/ttys003';
const pane: Pane = { id: 'terminal-app:ttys003', backend: 'terminal-app', handle: '4013:2', tty: TTY, foreground: 'claude' };
const OFF: DialogGates = { up: false, tall: false, noFirst: false };
const ALL_ON: DialogGates = { up: true, tall: true, noFirst: true };
const gatesOf = (f: DialogFixture): DialogGates => ({ ...OFF, ...Object.fromEntries((f.gates ?? []).map((g) => [g, true])) });

const DOWN = '\u001b[B';
const UP = '\u001b[A';

function rig() {
  const exec = createFakeExec((call: ExecCall) => {
    if (!call.file.endsWith('/osascript')) return undefined;
    if (call.args[0] !== '-' || call.opts.input !== TERMINAL_APP_SCRIPT || call.args[1] !== TTY) return { code: 99, stderr: 'contract broken' };
    return call.args[2] === 'typeif' ? { stdout: 'ok\n' } : { stdout: '__JANTAR_BAD_MODE__\n' };
  });
  const ctx = createTestContext({ exec, settings: SettingsSchema.parse({ controls: { escapeVerified: true, clearVerified: true } }) });
  return { exec, b: new TerminalAppBackend(ctx, { platform: 'darwin' }) };
}

/** The phone's body for row `i`: text on a text row, confirm on a hold row (as the dock sends them). */
function bodyFor(fingerprint: string, i: number, o: { role: string; hold?: string }): SessionDialogBody {
  return { fingerprint, option: i, ...(o.role === 'text' ? { text: SAMPLE_TEXT } : {}), ...(o.hold ? { confirm: true } : {}) };
}

/** Run every option of `f` read with `gates`; the write each one made, or null when it was refused. */
async function writesOf(f: DialogFixture, gates: DialogGates): Promise<{ writes: (string | null)[]; block: string | null }> {
  const { dialog, block } = dialogOfScreen(f.screen, gates);
  if (!dialog || !block) return { writes: [], block: null };
  const raw = rawSlice(f.screen, block.from, block.to);
  const writes: (string | null)[] = [];
  for (const [i, o] of dialog.options.entries()) {
    const { b, exec } = rig();
    const body = bodyFor(dialog.fingerprint, i, o);
    if (rowProblem(dialog, body, gates)) {
      writes.push(null);
      continue;
    }
    const press = answerPress(dialog, body, raw);
    expect(await b.pressKey(pane, press.key, press.opts), `${f.name} ${i}`).toEqual({ ok: true });
    const calls = exec.calls.filter((c) => c.file.endsWith('/osascript'));
    // One write, through typeif, with the dialog's raw block as the text it must still find.
    expect(calls.map((c) => c.args.slice(0, 3)), `${f.name} ${i}`).toEqual([['-', TTY, 'typeif']]);
    expect(calls[0]?.args[4], `${f.name} ${i}`).toBe(raw);
    writes.push(calls[0]?.args[3] as string);
  }
  return { writes, block: raw };
}

/** The write with a text row's text taken off its end. */
function keysOf(write: string): string {
  return write.endsWith(SAMPLE_TEXT) ? write.slice(0, -SAMPLE_TEXT.length) : write;
}

describe('dialog answer bytes (D3)', () => {
  for (const f of DIALOG_FIXTURES) {
    it(`${f.name}: gates off`, async () => {
      const { writes } = await writesOf(f, OFF);
      expect(writes).toEqual(f.bytes);
      for (const w of writes) if (w !== null) expect(keysOf(w)).toMatch(/^(?:\u001b\[B)*$/u);
    });
    if (f.bytesOpen) {
      it(`${f.name}: gates ${(f.gates ?? []).join(', ')} on`, async () => {
        expect((await writesOf(f, gatesOf(f))).writes).toEqual(f.bytesOpen);
        // Gates the fixture doesn't list change nothing.
        expect((await writesOf(f, ALL_ON)).writes).toEqual(f.bytesOpen);
      });
    }
    it(`${f.name}: the shipped gates`, async () => {
      expect((await writesOf(f, DIALOG_GATES)).writes).toEqual(withGates(f, DIALOG_GATES).bytes);
    });
  }

  it('every write is arrows of one direction then, on a text row only, the text: no digit, Tab, Shift+Tab, Left/Right, Ctrl+G or Return', async () => {
    for (const f of DIALOG_FIXTURES) {
      for (const gates of [OFF, gatesOf(f), DIALOG_GATES, ALL_ON]) {
        const { dialog } = dialogOfScreen(f.screen, gates);
        const { writes } = await writesOf(f, gates);
        for (const [i, w] of writes.entries()) {
          if (w === null) continue;
          const keys = keysOf(w);
          const label = `${f.name} ${i} ${JSON.stringify(gates)}`;
          expect(keys === '' || /^(?:\u001b\[B)+$/u.test(keys) || (gates.up && /^(?:\u001b\[A)+$/u.test(keys)), label).toBe(true);
          expect(w !== keys, label).toBe(dialog?.options[i]?.role === 'text');
          expect(keys, label).not.toMatch(/[\d\t\r\n\u0007]|\u001b\[[CDZ]/u);
        }
      }
    }
  });

  it('the arrows count from the pointer read, not from the top: a moved pointer moves the same row by fewer keys', async () => {
    const f = dialogFixture('Q_MULTI_TICKED');
    // The pointer is on row 2 (Cherry): Submit (row 4) is two Downs, Chat about this three.
    const { writes } = await writesOf(f, OFF);
    expect(writes[4]).toBe(DOWN.repeat(2));
    expect(writes[5]).toBe(DOWN.repeat(3));
    // With the up gate on, rows above the pointer are Ups from it.
    expect((await writesOf(f, { ...OFF, up: true })).writes.slice(0, 2)).toEqual([UP.repeat(2), UP]);
  });

  it('an input row reached with no arrow (the pointer on it) is the text alone, so Terminal\'s Return submits it', async () => {
    const screen = dialogFixture('Q_SINGLE').screen.replace('❯ 1. Red', '  1. Red').replace('  4. Type something.', '❯ 4. Type something.');
    const f: DialogFixture = { ...dialogFixture('Q_SINGLE'), name: 'pointer on Type something', screen };
    const { writes } = await writesOf(f, ALL_ON);
    expect(writes[3]).toBe(SAMPLE_TEXT);
    expect(writes[4]).toBe(DOWN);
  });
});
