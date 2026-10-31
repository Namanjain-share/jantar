import { describe, expect, it } from 'vitest';
import type { Pane } from '@jantar/protocol';
import type { ScreenshotRequest, TerminalBackend, Writer } from '../src/contracts.js';
import { notBuiltParts } from '../src/core/testing.js';
import { NO_TERMINAL_REASON, NullTerminalBackend, READ_ONLY_REASON, readOnlyLauncher, readOnlyRewrite, readOnlyTerminal, readOnlyWriter } from '../src/modes.js';

const pane: Pane = { id: 'p1', backend: 'terminal-app', handle: '1:1', tty: 'ttys001', foreground: 'claude' };
const refused = { ok: false, code: 'unsupported', reason: READ_ONLY_REASON };

describe('v0.3 run modes', () => {
  it('--no-terminal: no new windows, keys or screenshots', async () => {
    const t = new NullTerminalBackend();
    for (const r of [await t.openWindow(), await t.pressKey(), await t.getScreenshot()]) {
      expect(r).toEqual({ ok: false, code: 'unsupported', reason: NO_TERMINAL_REASON });
    }
  });

  it('--read-only: keys and new windows never reach the backend; screenshots never select a tab', async () => {
    const calls: string[] = [];
    const asked: (ScreenshotRequest | undefined)[] = [];
    const inner = {
      kind: 'terminal-app',
      pressKey: async () => (calls.push('pressKey'), { ok: true }),
      openWindow: async () => (calls.push('openWindow'), { ok: true, tty: '/dev/ttys009', windowId: '1' }),
      getScreenshot: async (_p: Pane, o?: ScreenshotRequest) => (asked.push(o), { ok: false, code: 'not_visible', reason: 'x' }),
    } as unknown as TerminalBackend;
    const t = readOnlyTerminal(inner);
    expect(await t.pressKey?.(pane, 'interrupt')).toEqual(refused);
    expect(await t.openWindow?.('cd -- /tmp && cs 7')).toEqual(refused);
    await t.getScreenshot?.(pane, { select: 'if-safe', maxEdge: 800 });
    expect(asked).toEqual([{ select: 'never', maxEdge: 800 }]);
    expect(calls).toEqual([]);
    // A backend without screenshots stays without them.
    expect(readOnlyTerminal({ ...inner, getScreenshot: undefined } as TerminalBackend).getScreenshot).toBeUndefined();
  });

  it('--read-only: the pane lock passes through (it types nothing)', async () => {
    const inner = { withPaneLock: async (_p: Pane, task: () => Promise<number>) => task() } as unknown as Writer;
    expect(await readOnlyWriter(inner).withPaneLock(pane, async () => 7)).toBe(7);
  });

  it('--read-only: no Rewrite runs, no launches, answers, pins or new folders; reads pass through', async () => {
    const parts = notBuiltParts();
    const rewrite = readOnlyRewrite(parts.rewrite);
    expect(await rewrite.submit({ sid: 's', text: 'x' }, { kind: 'cli' })).toEqual({ ok: false, code: 'refused', reason: READ_ONLY_REASON });
    expect(() => rewrite.get('j', { kind: 'cli' })).toThrow(/not built yet/);
    const launcher = readOnlyLauncher(parts.launcher);
    const no = { ok: false, code: 'refused', reason: READ_ONLY_REASON };
    expect(await launcher.launch({} as never, { kind: 'cli' }, 'k')).toEqual(no);
    expect(await launcher.answer('l', { option: 0, title: 't' }, { kind: 'cli' })).toEqual(no);
    expect(await launcher.folders.pin({ root: 'r.x', path: '', pinned: true }, { kind: 'cli' })).toEqual(no);
    expect(await launcher.folders.create({ root: 'r.x', parent: '', name: 'n' }, { kind: 'cli' })).toEqual(no);
    expect(() => launcher.list({ active: false })).toThrow(/not built yet/);
  });
});
