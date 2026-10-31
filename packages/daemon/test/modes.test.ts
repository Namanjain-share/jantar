import { describe, expect, it } from 'vitest';
import { defaultSettings, type Pane } from '@jantar/protocol';
import { MemorySettingsStore } from '../src/config.js';
import type { HooksBridge, TerminalBackend, UsageSource, Writer } from '../src/contracts.js';
import {
  NO_TERMINAL_REASON,
  NullTerminalBackend,
  READ_ONLY_REASON,
  readOnlyHooks,
  readOnlySettings,
  readOnlyTerminal,
  readOnlyUsage,
  readOnlyWriter,
} from '../src/modes.js';

const pane: Pane = { id: 'p1', backend: 'terminal-app', handle: '1:1', tty: 'ttys001', foreground: 'claude' };

describe('NullTerminalBackend (--no-terminal)', () => {
  it('finds nothing and refuses every operation', async () => {
    const t = new NullTerminalBackend();
    expect(await t.available()).toBe(false);
    expect(await t.findPane()).toBeNull();
    expect(await t.foregroundOf()).toBe('gone');
    for (const r of [await t.readScreen(), await t.readInputBox(), await t.type(), await t.pressEnter(), await t.clearInput(), await t.focus()]) {
      expect(r).toEqual({ ok: false, code: 'unsupported', reason: NO_TERMINAL_REASON });
    }
  });
});

describe('read-only wrappers', () => {
  it('terminal: reads pass through, writes are refused without reaching the backend', async () => {
    const calls: string[] = [];
    const inner: TerminalBackend = {
      kind: 'terminal-app',
      available: async () => (calls.push('available'), true),
      findPane: async () => (calls.push('findPane'), pane),
      readScreen: async () => (calls.push('readScreen'), { ok: true, text: 'x', at: 'now' }),
      readInputBox: async () => (calls.push('readInputBox'), { ok: true, text: '', styled: false }),
      type: async () => (calls.push('type'), { ok: true }),
      pressEnter: async () => (calls.push('pressEnter'), { ok: true }),
      clearInput: async () => (calls.push('clearInput'), { ok: true }),
      focus: async () => (calls.push('focus'), { ok: true }),
      foregroundOf: async () => (calls.push('foregroundOf'), 'claude'),
    };
    const t = readOnlyTerminal(inner);
    expect(await t.available()).toBe(true);
    expect(await t.findPane({ sid: 's' })).toBe(pane);
    expect(await t.readScreen(pane)).toMatchObject({ ok: true });
    expect(await t.readInputBox(pane)).toMatchObject({ ok: true });
    expect(await t.foregroundOf(pane)).toBe('claude');
    for (const r of [await t.type(pane, 'hi'), await t.pressEnter(pane), await t.clearInput!(pane), await t.focus(pane)]) {
      expect(r).toEqual({ ok: false, code: 'unsupported', reason: READ_ONLY_REASON });
    }
    expect(calls).toEqual(['available', 'findPane', 'readScreen', 'readInputBox', 'foregroundOf']);
  });

  it('writer: submit is refused, lookups and lifecycle pass through', async () => {
    const calls: string[] = [];
    const inner = {
      start: async () => void calls.push('start'),
      stop: async () => void calls.push('stop'),
      get: () => (calls.push('get'), undefined),
      wait: async () => (calls.push('wait'), undefined),
      submit: async () => {
        calls.push('submit');
        throw new Error('must not be called');
      },
    } as unknown as Writer;
    const w = readOnlyWriter(inner);
    await w.start();
    expect(await w.submit({ sid: 's', text: 't', onDraft: 'refuse', actor: { kind: 'cli' } })).toEqual({
      ok: false,
      code: 'refused',
      reason: READ_ONLY_REASON,
    });
    w.get('j');
    await w.wait('j', 1);
    await w.stop();
    expect(calls).toEqual(['start', 'get', 'wait', 'stop']);
  });

  it('hooks: decide is forbidden, everything else passes through', async () => {
    let decided = 0;
    const inner = {
      socketPath: '/x/hooks.sock',
      start: async () => {},
      stop: async () => {},
      open: () => [],
      get: () => undefined,
      decide: async () => {
        decided += 1;
        throw new Error('must not be called');
      },
      onHookEvent: () => () => {},
      hasHooks: (sid: string) => sid === 'yes',
    } as unknown as HooksBridge;
    const h = readOnlyHooks(inner);
    expect(h.socketPath).toBe('/x/hooks.sock');
    expect(h.hasHooks('yes')).toBe(true);
    expect(h.open()).toEqual([]);
    expect(await h.decide('id', { behavior: 'allow' }, { kind: 'cli' })).toEqual({ ok: false, code: 'forbidden', message: READ_ONLY_REASON });
    expect(decided).toBe(0);
  });

  it('usage: refresh is never queued', () => {
    let asked = 0;
    const inner = {
      requestRefresh: () => {
        asked += 1;
        return { queued: true, nextAllowedAt: null };
      },
      latest: () => null,
      isPolling: () => false,
    } as unknown as UsageSource;
    const u = readOnlyUsage(inner);
    expect(u.requestRefresh('test')).toEqual({ queued: false, reason: 'read-only', nextAllowedAt: null });
    expect(u.latest()).toBeNull();
    expect(asked).toBe(0);
  });

  it('settings: the poller reads as off and every patch is refused', async () => {
    const base = defaultSettings();
    base.usage.poller = 'on';
    const inner = new MemorySettingsStore(base);
    const s = readOnlySettings(inner);
    expect(s.get().usage.poller).toBe('off');
    expect(s.get().remote.port).toBe(base.remote.port);
    expect(await s.patch({ notify: { webpush: false } })).toEqual({ ok: false, error: READ_ONLY_REASON });
    expect(inner.get().notify.webpush).toBe(base.notify.webpush);
    const seen: string[] = [];
    s.subscribe((next) => seen.push(next.usage.poller));
    await inner.patch({ usage: { interval_s: 300 } });
    expect(seen).toEqual(['off']);
  });
});
