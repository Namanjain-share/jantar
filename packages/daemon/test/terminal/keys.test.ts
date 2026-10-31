/**
 * Terminal.app control keys (terminal-app/keys.ts): only KEY_BYTES, and
 * Clear draft's bytes for the rows its box showed, are ever typed outside a
 * prompt (C1, L5), through the backend's one constant script with the bytes
 * in argv (C7). Nothing here runs osascript: a fake answers.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ControlKeySchema, SettingsSchema, type ControlKey, type Pane } from '@jantar/protocol';
import { createFakeExec, createTestContext, type ExecCall } from '../../src/core/testing.js';
import {
  CLEAR_MAX_ROWS,
  CLEAR_ROWS_REASON,
  KEY_BYTES,
  MAX_KEY_REPEAT,
  clearCtrlUCount,
  clearEndCount,
  clearInputBytes,
  pressKeyImpl,
} from '../../src/terminal/terminal-app/keys.js';
import { TERMINAL_APP_SCRIPT, TerminalAppBackend, type TerminalAppHost } from '../../src/terminal/terminal-app/index.js';
import { CHANGED } from '../../src/terminal/terminal-app/script.js';

const TTY = '/dev/ttys003';
const pane: Pane = { id: 'terminal-app:ttys003', backend: 'terminal-app', handle: '4013:2', tty: TTY, foreground: 'claude' };
const END = '\u001b[F';
const CTRL_U = '\u0015';

function rig(escapeVerified = false, clearVerified = escapeVerified) {
  const typed: string[] = [];
  const exec = createFakeExec((call: ExecCall) => {
    if (!call.file.endsWith('/osascript')) return undefined;
    if (call.args[0] !== '-' || call.opts.input !== TERMINAL_APP_SCRIPT) return { code: 99, stderr: 'contract broken' };
    if (call.args[1] !== TTY) return { stdout: '__JANTAR_MISSING__\n' };
    if (call.args[2] === 'type') {
      typed.push(call.args[3] as string);
      return { stdout: 'ok\n' };
    }
    return { stdout: '__JANTAR_BAD_MODE__\n' };
  });
  const ctx = createTestContext({ exec, settings: SettingsSchema.parse({ controls: { escapeVerified, clearVerified } }) });
  return { exec, typed, b: new TerminalAppBackend(ctx, { platform: 'darwin' }) };
}

describe('pressKey on Terminal.app', () => {
  it('C1: types exactly the whitelisted bytes for each key, one write per press', async () => {
    const { b, typed } = rig(true);
    for (const key of ControlKeySchema.options) expect(await b.pressKey(pane, key, key === 'clearInput' ? { rows: 1 } : {}), key).toEqual({ ok: true });
    expect(typed).toEqual(ControlKeySchema.options.map((k) => (k === 'clearInput' ? clearInputBytes(1) : KEY_BYTES[k])));
    expect(KEY_BYTES).toEqual({
      up: '\u001b[A',
      down: '\u001b[B',
      enter: '', // Terminal's own Return picks (ccw's startup_answer)
      shiftTab: '\u001b[Z',
      interrupt: '\u0003',
      quit: '\u0003\u0003',
      escape: '\u001b[27u',
    });
  });

  it('Clear draft: End once per row and two more, then two Ctrl+U per row and six more, in one write (1, 2, 5 and 30 rows)', async () => {
    const { b, typed } = rig(true);
    for (const rows of [1, 2, 5, 30]) expect(await b.pressKey(pane, 'clearInput', { rows }), `${rows} rows`).toEqual({ ok: true });
    expect(typed).toEqual([
      // One row: the cursor's row and the break before it, padded.
      `${END.repeat(3)}${CTRL_U.repeat(8)}`,
      // Two rows: one Ctrl+U on the empty last row left the first for the Return to send (spike, 30 Oct 2026).
      `${END.repeat(4)}${CTRL_U.repeat(10)}`,
      `${END.repeat(7)}${CTRL_U.repeat(16)}`,
      `${END.repeat(32)}${CTRL_U.repeat(66)}`,
    ]);
    expect([1, 2, 5, 30].map(clearEndCount)).toEqual([3, 4, 7, 32]);
    expect([1, 2, 5, 30].map(clearCtrlUCount)).toEqual([8, 10, 16, 66]);
    // 30 rows is the longest write: 162 bytes.
    expect(clearInputBytes(CLEAR_MAX_ROWS)).toHaveLength(162);
    // An End per row reaches the last row from the first, and every row's text and the break before it is a
    // Ctrl+U each; the padding covers two rows typed at the Mac between the read and the write.
    for (let rows = 1; rows <= CLEAR_MAX_ROWS; rows++) {
      expect(clearEndCount(rows), `${rows} rows`).toBeGreaterThanOrEqual(rows + 2);
      expect(clearCtrlUCount(rows), `${rows} rows`).toBeGreaterThanOrEqual(2 * (rows + 2) - 1);
      expect(clearInputBytes(rows)).toBe(END.repeat(clearEndCount(rows)) + CTRL_U.repeat(clearCtrlUCount(rows)));
    }
  });

  it('Clear draft types nothing without a row count from 1 to 30 (31 rows, none, 0, 1.5): never typed blind', async () => {
    const { b, typed, exec } = rig(true);
    for (const opts of [{ rows: CLEAR_MAX_ROWS + 1 }, {}, undefined, { rows: 0 }, { rows: -1 }, { rows: 1.5 }, { rows: Number.NaN }, { rows: 2, repeat: 2 }]) {
      expect(await b.pressKey(pane, 'clearInput', opts), JSON.stringify(opts)).toMatchObject({ ok: false, code: 'unsupported' });
    }
    expect(await b.pressKey(pane, 'clearInput', { rows: 31 })).toEqual({ ok: false, code: 'unsupported', reason: CLEAR_ROWS_REASON });
    expect(clearInputBytes(31)).toBeNull();
    expect(clearInputBytes(undefined)).toBeNull();
    expect(typed).toEqual([]);
    expect(exec.calls).toEqual([]);
  });

  it('C1: refuses any name that is not a control key, and types nothing', async () => {
    const { b, typed, exec } = rig(true);
    for (const name of ['constructor', '__proto__', 'toString', 'a', '\u001b', 'enter\u001b[Z', '']) {
      expect(await b.pressKey(pane, name as ControlKey), JSON.stringify(name)).toMatchObject({ ok: false, code: 'unsupported' });
    }
    expect(typed).toEqual([]);
    expect(exec.calls).toEqual([]);
  });

  it('L5: free text with ESC is still refused by type(); only pressKey sends escape sequences', async () => {
    const { b, typed } = rig(true);
    expect(await b.type(pane, 'fine\u001b[Z')).toMatchObject({ ok: false, code: 'unsupported' });
    expect(await b.type(pane, '\u0003')).toMatchObject({ ok: false, code: 'unsupported' });
    expect(typed).toEqual([]);
  });

  it('refuses Escape while controls.escapeVerified is off, and Clear draft while controls.clearVerified is off', async () => {
    const off = rig(false);
    expect(await off.b.pressKey(pane, 'escape')).toMatchObject({ ok: false, code: 'unsupported', reason: expect.stringMatching(/escapeVerified/) });
    expect(await off.b.pressKey(pane, 'clearInput', { rows: 1 })).toMatchObject({ ok: false, code: 'unsupported', reason: expect.stringMatching(/clearVerified/) });
    expect(off.typed).toEqual([]);
  });

  it('repeats an arrow in one payload (its Return then picks the row); other keys never repeat', async () => {
    const { b, typed } = rig();
    expect(await b.pressKey(pane, 'down', { repeat: 3 })).toEqual({ ok: true });
    expect(typed).toEqual(['\u001b[B\u001b[B\u001b[B']);
    for (const [key, repeat] of [
      ['enter', 2],
      ['interrupt', 2],
      ['shiftTab', 3],
      ['up', 0],
      ['up', MAX_KEY_REPEAT + 1],
      ['down', 1.5],
    ] as [ControlKey, number][]) {
      expect(await b.pressKey(pane, key, { repeat }), `${key} x${repeat}`).toMatchObject({ ok: false, code: 'unsupported' });
    }
    expect(typed).toHaveLength(1);
  });

  it('C7: the bytes travel in argv; the script on stdin is always the same constant', async () => {
    const { b, exec } = rig(true);
    await b.pressKey(pane, 'shiftTab');
    await b.pressKey(pane, 'quit');
    await b.pressKey(pane, 'clearInput', { rows: 2 });
    const osa = exec.calls.filter((c) => c.file.endsWith('/osascript'));
    expect(osa.map((c) => c.args)).toEqual([
      ['-', TTY, 'type', '\u001b[Z'],
      ['-', TTY, 'type', '\u0003\u0003'],
      ['-', TTY, 'type', `${END.repeat(4)}${CTRL_U.repeat(10)}`],
    ]);
    for (const c of osa) expect(c.opts.input).toBe(TERMINAL_APP_SCRIPT);
  });

  it('C7: keys.ts holds no script and starts no program of its own', () => {
    const src = readFileSync(join(__dirname, '../../src/terminal/terminal-app/keys.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(src).not.toMatch(/tell application|do script|osascript/);
    expect(src).not.toMatch(/\bexec\(|runScript\(|spawn\(/);
    expect(src).toMatch(/host\.typeBytes\(pane, KEY_BYTES\[key\]\.repeat\(repeat\)\)/);
    expect(src).toMatch(/host\.typeBytes\(pane, bytes\)/);
    expect(src.match(/host\.typeBytes\(/g)).toHaveLength(2);
  });
});

/** A fake osascript that also answers `typeif`: `changed` makes it answer as the script does when the tab moved on. */
function ifRig(opts: { changed?: boolean } = {}) {
  const typed: string[] = [];
  const checked: { bytes: string; expect: string }[] = [];
  const exec = createFakeExec((call: ExecCall) => {
    if (!call.file.endsWith('/osascript')) return undefined;
    if (call.args[0] !== '-' || call.opts.input !== TERMINAL_APP_SCRIPT || call.args[1] !== TTY) return { code: 99, stderr: 'contract broken' };
    if (call.args[2] === 'type') {
      typed.push(call.args[3] as string);
      return { stdout: 'ok\n' };
    }
    if (call.args[2] === 'typeif') {
      checked.push({ bytes: call.args[3] as string, expect: call.args[4] as string });
      return { stdout: opts.changed ? `${CHANGED}\n` : 'ok\n' };
    }
    return { stdout: '__JANTAR_BAD_MODE__\n' };
  });
  const ctx = createTestContext({ exec, settings: SettingsSchema.parse({ controls: { escapeVerified: true, clearVerified: true } }) });
  return { exec, typed, checked, b: new TerminalAppBackend(ctx, { platform: 'darwin' }) };
}

const BLOCK = ' Do you want to create b.txt?\n ❯ 1. Yes\n   2. No';

describe('pressKey compare-and-type (v0.4.2, D10)', () => {
  it('with expect, one typeif write carries the bytes and the text it must still find, both in argv', async () => {
    const { b, exec, typed, checked } = ifRig();
    expect(await b.pressKey(pane, 'down', { repeat: 2, text: 'teal', expect: BLOCK })).toEqual({ ok: true });
    expect(await b.pressKey(pane, 'enter', { expect: BLOCK })).toEqual({ ok: true });
    expect(await b.pressKey(pane, 'escape', { expect: BLOCK })).toEqual({ ok: true });
    expect(checked).toEqual([
      { bytes: '\u001b[B\u001b[Bteal', expect: BLOCK },
      { bytes: '', expect: BLOCK },
      { bytes: '\u001b[27u', expect: BLOCK },
    ]);
    expect(typed).toEqual([]);
    const osa = exec.calls.filter((c) => c.file.endsWith('/osascript'));
    expect(osa[0]?.args).toEqual(['-', TTY, 'typeif', '\u001b[B\u001b[Bteal', BLOCK]);
    for (const c of osa) expect(c.opts.input).toBe(TERMINAL_APP_SCRIPT);
  });

  it('a tab that no longer shows the text answers `changed`, and nothing was typed', async () => {
    const { b, typed } = ifRig({ changed: true });
    expect(await b.pressKey(pane, 'down', { expect: BLOCK })).toEqual({ ok: false, code: 'changed', reason: 'the terminal changed before Jantar typed' });
    expect(typed).toEqual([]);
  });

  it('an empty expect, or one holding NUL, is refused before osascript runs', async () => {
    const { b, exec } = ifRig();
    for (const expectText of ['', 'a\u0000b', '\u0000']) {
      expect(await b.pressKey(pane, 'down', { expect: expectText }), JSON.stringify(expectText)).toMatchObject({ ok: false, code: 'unsupported' });
    }
    expect(exec.calls).toEqual([]);
  });

  it("a host that can't compare as it types refuses an expect write instead of typing blind", async () => {
    const plain: string[] = [];
    const host: TerminalAppHost = {
      ctx: createTestContext(),
      osascriptTimeoutMs: 1000,
      typeBytes: async (_p, payload) => {
        plain.push(payload);
        return { ok: true };
      },
      runScript: async () => ({ ok: false, code: 'failed', reason: 'not used' }),
      checkPane: () => null,
    };
    expect(await pressKeyImpl(host, pane, 'down', { expect: BLOCK })).toMatchObject({ ok: false, code: 'unsupported' });
    expect(await pressKeyImpl(host, pane, 'enter', { text: 'teal', expect: BLOCK })).toMatchObject({ ok: false, code: 'unsupported' });
    expect(plain).toEqual([]);
  });
});

describe('pressKey text rules (v0.4.2, D4)', () => {
  it('takes text only after up, down or enter, and only in a compare-and-type write', async () => {
    const { b, exec } = ifRig();
    for (const key of ['shiftTab', 'interrupt', 'escape', 'quit', 'clearInput'] as ControlKey[]) {
      expect(await b.pressKey(pane, key, { text: 'teal', expect: BLOCK, rows: 1 }), key).toMatchObject({ ok: false, code: 'unsupported' });
    }
    expect(await b.pressKey(pane, 'down', { text: 'teal' })).toMatchObject({ ok: false, code: 'unsupported' });
    expect(exec.calls).toEqual([]);
  });

  it('refuses control characters, line breaks, tabs, 1 or 701 characters, a leading / ! # @ or a space, and @ after a space', async () => {
    const { b, exec } = ifRig();
    const bad = [
      'te\u0007al',
      'two\nlines',
      'two\rlines',
      'a\ttab',
      'esc \u001b[B',
      'del\u007f',
      'c1 \u0085 next line',
      'x',
      'y'.repeat(701),
      '/clear',
      '!ls',
      '#note',
      '@file.txt',
      'look at @file.txt',
      ' leading space',
      'trailing space ',
    ];
    for (const text of bad) expect(await b.pressKey(pane, 'down', { repeat: 3, text, expect: BLOCK }), JSON.stringify(text)).toMatchObject({ ok: false, code: 'unsupported' });
    expect(exec.calls).toEqual([]);
  });

  it('types 2 and 700 plain characters, and digits and an e-mail-like @ inside the text, after the arrows in the same write', async () => {
    const { b, checked } = ifRig();
    for (const text of ['12', 'w'.repeat(700), 'red, then blue. 3 coats; mail me@home is fine']) {
      expect(await b.pressKey(pane, 'down', { repeat: 3, text, expect: BLOCK }), text.slice(0, 20)).toEqual({ ok: true });
    }
    expect(checked.map((c) => c.bytes)).toEqual([
      `${'\u001b[B'.repeat(3)}12`,
      `${'\u001b[B'.repeat(3)}${'w'.repeat(700)}`,
      `${'\u001b[B'.repeat(3)}red, then blue. 3 coats; mail me@home is fine`,
    ]);
  });
});
