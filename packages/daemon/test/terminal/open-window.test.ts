/**
 * New Terminal windows for launches (terminal-app/open-window.ts and its
 * constant open-script.ts), security rules L4 (the AppleScript is constant
 * and the command reaches osascript only through argv) and L5 (no way to
 * type ESC through text; the launcher's keys are fixed bytes). A fake exec
 * stands in for osascript: nothing opens a window.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Pane } from '@jantar/protocol';
import type { ExecResult } from '../../src/contracts.js';
import { createFakeExec, createTestContext, type ExecCall } from '../../src/core/testing.js';
import { KEY_BYTES, TerminalAppBackend } from '../../src/terminal/terminal-app/index.js';
import { TERMINAL_OPEN_SCRIPT } from '../../src/terminal/terminal-app/open-script.js';
import { NO_WINDOW_REASON, OPEN_TIMEOUT_MS, openWindowImpl } from '../../src/terminal/terminal-app/open-window.js';

const COMMAND = "cd -- '/Users/you/Desktop/work/it'\\''s' && cs 7 -- --chrome --session-id 6b1e0c2a-4f3d-4c8e-9a71-2f5b8d3e9c10 --name its";

function rig(answer: (call: ExecCall) => Partial<ExecResult>) {
  const exec = createFakeExec((call) => (call.file.endsWith('/osascript') ? answer(call) : undefined));
  const ctx = createTestContext({ exec });
  return { exec, ctx, b: new TerminalAppBackend(ctx, { platform: 'darwin' }) };
}

describe('openWindow', () => {
  it('runs the constant open script once, the command in argv only, and reads tty and window id', async () => {
    const { exec, b } = rig(() => ({ stdout: 'ok\n/dev/ttys014\n9001\n' }));
    expect(await b.openWindow(COMMAND)).toEqual({ ok: true, tty: '/dev/ttys014', windowId: '9001' });
    expect(exec.calls).toHaveLength(1);
    const call = exec.calls[0] as ExecCall;
    expect(call.file).toBe('/fake/bin/osascript');
    expect(call.args).toEqual(['-', COMMAND]);
    expect(call.opts.input).toBe(TERMINAL_OPEN_SCRIPT);
    expect(call.opts.timeoutMs).toBe(OPEN_TIMEOUT_MS);
  });

  it('runs one open script at a time, daemon-wide, so each puts back the window the user had in front', async () => {
    const finish: (() => void)[] = [];
    let running = 0;
    let most = 0;
    const exec = createFakeExec((call) => {
      if (!call.file.endsWith('/osascript')) return undefined;
      running += 1;
      most = Math.max(most, running);
      return new Promise<Partial<ExecResult>>((resolve) =>
        finish.push(() => {
          running -= 1;
          resolve({ stdout: `ok\n/dev/ttys01${finish.length}\n900${finish.length}` });
        }),
      );
    });
    const b = new TerminalAppBackend(createTestContext({ exec }), { platform: 'darwin' });
    const one = b.openWindow(COMMAND);
    const two = b.openWindow(COMMAND);
    await new Promise((r) => setImmediate(r));
    expect(exec.calls).toHaveLength(1);
    finish.shift()?.();
    expect((await one).ok).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(exec.calls).toHaveLength(2);
    finish.shift()?.();
    expect((await two).ok).toBe(true);
    expect(most).toBe(1);
  });

  it('L4: AppleScript-looking text in the command stays in argv; the script never changes', async () => {
    const evil = 'cd -- \'/x" & (do shell script "touch /tmp/pwned") & "\' && cs 7 -- --name x';
    const { exec, b } = rig(() => ({ stdout: 'ok\n/dev/ttys014\n9001' }));
    await b.openWindow(evil);
    expect(exec.calls[0]?.opts.input).toBe(TERMINAL_OPEN_SCRIPT);
    expect(exec.calls[0]?.args).toEqual(['-', evil]);
  });

  it('L4: the script is a constant with nothing interpolated, opens a new window and puts the old front one back', () => {
    expect(TERMINAL_OPEN_SCRIPT).not.toContain('${');
    const source = readFileSync(fileURLToPath(new URL('../../src/terminal/terminal-app/open-script.ts', import.meta.url)), 'utf8');
    const literal = /TERMINAL_OPEN_SCRIPT = `([\s\S]*?)`;/u.exec(source)?.[1];
    expect(literal).toBe(TERMINAL_OPEN_SCRIPT);
    expect(literal).not.toContain('${');
    expect(TERMINAL_OPEN_SCRIPT).toContain('set cmd to item 1 of argv');
    // A new window: `do script` never names a tab or window to type into.
    expect(TERMINAL_OPEN_SCRIPT).toMatch(/set t to do script cmd\n/);
    expect(TERMINAL_OPEN_SCRIPT).not.toMatch(/do script cmd in/);
    expect(TERMINAL_OPEN_SCRIPT).toContain('set index of window id prevWid to 1');
    expect(TERMINAL_OPEN_SCRIPT).not.toContain('activate');
  });

  it('a window Terminal could not find by its tty still ran the command: the tty comes back, the window id empty', async () => {
    // The script returns "ok\n<tty>\n"; osascript adds a line feed, which runScript takes off.
    const { b } = rig(() => ({ stdout: 'ok\n/dev/ttys014\n\n' }));
    expect(await b.openWindow(COMMAND)).toEqual({ ok: true, tty: '/dev/ttys014', windowId: '' });
  });

  it('anything but "ok, a /dev/ttys tty and a window id (or none)" is a failure', async () => {
    for (const out of ['ok\n/dev/ttys14\n9001', 'ok\n/dev/ttys014', 'ok\n/dev/ttys014\n9001\nmore', 'ok\n/dev/ttys014\nx', 'ok\n/dev/pts/3\n9001', '__JANTAR_MISSING__', '']) {
      const { b } = rig(() => ({ stdout: out }));
      expect(await b.openWindow(COMMAND), JSON.stringify(out)).toEqual({ ok: false, code: 'failed', reason: NO_WINDOW_REASON });
    }
  });

  it('osascript failures come back classified: Automation permission, timeout, could not start', async () => {
    expect(await rig(() => ({ code: 1, stderr: 'execution error: Not authorized to send Apple events to Terminal. (-1743)' })).b.openWindow(COMMAND)).toMatchObject({
      ok: false,
      code: 'permission',
    });
    expect(await rig(() => ({ code: null, timedOut: true })).b.openWindow(COMMAND)).toMatchObject({ ok: false, code: 'timeout' });
    expect(await rig(() => ({ code: null, spawnError: 'ENOENT' })).b.openWindow(COMMAND)).toMatchObject({ ok: false, code: 'failed' });
  });

  it('refuses a command with a control character, an empty one or an over-long one, and runs nothing', async () => {
    const { exec, b } = rig(() => ({ stdout: 'ok\n/dev/ttys014\n9001' }));
    for (const bad of ['cs 7\nrm -rf ~', 'cs 7\r', 'cs\u001b[A', 'cs\u0000', ' ', 'x'.repeat(5000)]) {
      expect((await b.openWindow(bad)).ok, JSON.stringify(bad.slice(0, 20))).toBe(false);
    }
    expect(exec.calls).toEqual([]);
  });

  it('never logs the command', async () => {
    const { ctx, b } = rig(() => ({ code: 1, stderr: 'boom (-600)' }));
    await b.openWindow(COMMAND);
    const { ctx: ctx2, b: b2 } = rig(() => ({ stdout: 'garbage' }));
    await b2.openWindow(COMMAND);
    for (const c of [ctx, ctx2]) expect(JSON.stringify((c.log as unknown as { records: unknown[] }).records)).not.toContain('cs 7');
  });

  it('openWindowImpl takes its host: the backend lends runScript, never a way to type text', async () => {
    const seen: { script: string; args: readonly string[] }[] = [];
    const host = {
      ctx: createTestContext(),
      osascriptTimeoutMs: 15_000,
      typeBytes: async () => ({ ok: true as const }),
      runScript: async (script: string, args: readonly string[]) => {
        seen.push({ script, args });
        return { ok: true as const, out: 'ok\n/dev/ttys1234\n42' };
      },
      checkPane: () => null,
    };
    expect(await openWindowImpl(host, 'cs 7')).toEqual({ ok: true, tty: '/dev/ttys1234', windowId: '42' });
    expect(seen).toEqual([{ script: TERMINAL_OPEN_SCRIPT, args: ['cs 7'] }]);
  });
});

describe('L5: keys', () => {
  const pane: Pane = { id: 'terminal-app:ttys014', backend: 'terminal-app', handle: '9001:1', tty: '/dev/ttys014', foreground: 'claude' };

  it('type() still refuses ESC and other control characters: arrows cannot be smuggled in as text', async () => {
    const { exec, b } = rig(() => ({ stdout: 'ok' }));
    for (const text of ['\u001b[A', '\u001b[B', 'yes\u001b[B', '\u0003', '\u009b']) {
      expect(await b.type(pane, text)).toMatchObject({ ok: false, code: 'unsupported' });
    }
    expect(exec.calls).toEqual([]);
  });

  it('the launcher’s keys are fixed bytes: up, down and enter', () => {
    expect(KEY_BYTES.up).toBe('\u001b[A');
    expect(KEY_BYTES.down).toBe('\u001b[B');
    // an empty write: Terminal's own Return is the one Return (never two)
    expect(KEY_BYTES.enter).toBe('');
  });
});
