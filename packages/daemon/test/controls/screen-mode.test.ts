/**
 * The mode chip follows a Shift+Tab pressed at the Mac (which fires no
 * hook): every text peek (GET /v1/sessions/:sid/screen) reads the mode off
 * the screen it returns and publishes it as session.mode when it changed.
 * Only the mode goes out; the screen's text stays in the read reply.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonEvent } from '@jantar/protocol';
import { noteScreenMode } from '../../src/controls/modes.js';
import { createTestContext } from '../../src/core/testing.js';
import { h, makeApi, makeSession, pairCookie, type TestApi } from '../api/fakes.js';
import { SCREEN_SECRET, claudeScreen, dialogScreen } from './helpers.js';

const SID = 'sess-aaaa-1111';
let api: TestApi;
afterEach(async () => {
  await api?.close();
});

describe('the text peek publishes the mode the screen shows', () => {
  it('a Shift+Tab at the Mac reaches session.mode on the next peek; the text never reaches an event', async () => {
    api = await makeApi({ sessions: [makeSession({ sid: SID, mode: 'default' })] });
    const { cookie } = await pairCookie(api);
    const events: DaemonEvent[] = [];
    api.ctx.store.subscribe((ev) => events.push(ev));
    const peek = async () => {
      const res = await api.tcp.inject({ method: 'GET', url: `/v1/sessions/${SID}/screen?lines=40`, headers: h(cookie) });
      expect(res.statusCode).toBe(200);
      return res.json() as { text: string };
    };
    const modes = () => events.filter((e) => e.type === 'session.updated').map((e) => (e.data as { patch: { mode?: string } }).patch.mode);

    // The screen agrees with the hook's mode: nothing to say.
    api.fakes.terminal.screen = claudeScreen({ mode: 'default', above: [SCREEN_SECRET] });
    await peek();
    expect(modes()).toEqual([]);

    // Shift+Tab twice at the Mac: plan mode, read on the next peek, published once.
    api.fakes.terminal.screen = claudeScreen({ mode: 'plan', above: [SCREEN_SECRET] });
    expect((await peek()).text).toContain(SCREEN_SECRET);
    await peek();
    expect(modes()).toEqual(['plan']);
    expect(api.ctx.store.getState().sessions[SID]?.mode).toBe('plan');

    // No mode on screen (a dialog over the footer, a narrow window): the mode stands.
    api.fakes.terminal.screen = dialogScreen();
    await peek();
    api.fakes.terminal.screen = claudeScreen({ mode: null });
    await peek();
    expect(modes()).toEqual(['plan']);

    // Accept edits, then bypass: each change once.
    for (const mode of ['acceptEdits', 'acceptEdits', 'bypassPermissions'] as const) {
      api.fakes.terminal.screen = claudeScreen({ mode });
      await peek();
    }
    expect(modes()).toEqual(['plan', 'acceptEdits', 'bypassPermissions']);
    expect(JSON.stringify(events)).not.toContain(SCREEN_SECRET);
    // A read is not audited, whatever it published.
    expect(api.ctx.db.audit.list().filter((a) => a.action === 'getScreen')).toEqual([]);
  });

  it('a mode line above the input box (Claude quoting one) is not the mode', async () => {
    api = await makeApi({ sessions: [makeSession({ sid: SID, mode: 'default' })] });
    const { cookie } = await pairCookie(api);
    api.fakes.terminal.screen = claudeScreen({ mode: null, above: ['  ⏸ plan mode on (shift+tab to cycle)'] });
    expect((await api.tcp.inject({ method: 'GET', url: `/v1/sessions/${SID}/screen`, headers: h(cookie) })).statusCode).toBe(200);
    expect(api.ctx.store.getState().sessions[SID]?.mode).toBe('default');
  });
});

describe('noteScreenMode', () => {
  it('only for a live session, by its own key, and never throws', () => {
    const ctx = createTestContext();
    const events: DaemonEvent[] = [];
    ctx.store.subscribe((ev) => events.push(ev));
    for (const sid of ['nope', 'constructor', '__proto__']) noteScreenMode(ctx, sid, claudeScreen({ mode: 'plan' }));
    expect(events).toEqual([]);
    ctx.store.emit({ type: 'session.added', sid: SID, data: { session: makeSession({ sid: SID }) } });
    noteScreenMode(ctx, SID, claudeScreen({ mode: 'auto' }));
    expect(ctx.store.getState().sessions[SID]?.mode).toBe('auto');
    expect(() => noteScreenMode(ctx, SID, '\u0000'.repeat(10))).not.toThrow();
  });
});
