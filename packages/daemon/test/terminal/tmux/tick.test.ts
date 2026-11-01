/**
 * v0.6 Fleet, lane L2: the tmux backend's pane tick (spec 4.2). Every 10 s,
 * and when a session of this machine's own appears, one `list-panes -a` ties
 * live local sessions to panes by tty and sets `session.paneId` (what the
 * phone's canType reads), or unsets it when the pane is gone. A paired
 * server's session (with `node`, on a hub's state) is never touched. tmux
 * that can't be asked changes nothing; no server running unsets every pane.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '@jantar/protocol';
import { createFakeExec, createTestContext, onCommand } from '../../../src/core/testing.js';
import { TICK_MS, TmuxBackend } from '../../../src/terminal/tmux/index.js';
import { SOCKET, TMUX_BIN, createFakeTmux } from './fake-tmux.js';

function session(over: Partial<Session> & Pick<Session, 'sid'>): Session {
  return {
    pid: 202,
    procStart: 'Thu Jan 15 09:00:00 2026',
    account: 0,
    configDir: '/home/sam/.claude',
    cwd: '/home/sam/code/api-server',
    folder: 'api-server',
    entrypoint: 'cli',
    status: 'idle',
    statusSource: 'session-file',
    statusSince: '2026-01-15T10:00:00.000Z',
    subagentsRunning: 0,
    ...over,
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

function rig() {
  const fake = createFakeTmux();
  /** Set to make every tmux call time out (tmux can't be asked). */
  const broken = { on: false };
  const exec = createFakeExec(() => (broken.on ? { timedOut: true, code: null } : undefined), fake.handler, onCommand('ps', { code: 0, stdout: '' }));
  const ctx = createTestContext({ exec, bins: { tmux: TMUX_BIN } });
  const b = new TmuxBackend(ctx, { socket: SOCKET });
  return { fake, ctx, b, broken };
}

describe('the pane tick: session.paneId', () => {
  let stop: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await stop?.();
    stop = null;
  });

  it('ties local sessions to their panes by tty at start, and leaves a session outside tmux and a node\'s session alone', async () => {
    const { fake, ctx, b } = rig();
    fake.addPane({ id: '%3', tty: '/dev/pts/3' });
    fake.addPane({ id: '%4', tty: '/dev/pts/4' });
    ctx.store.emit({ type: 'session.added', sid: 'a', account: 0, data: { session: session({ sid: 'a', tty: 'pts/3' }) } });
    ctx.store.emit({ type: 'session.added', sid: 'b', account: 1, data: { session: session({ sid: 'b', pid: 203, tty: 'pts/7' }) } });
    // a paired server's session, as a hub would hold it: never this machine's to tie
    ctx.store.emit({ type: 'session.added', sid: 'n', account: 0, data: { session: session({ sid: 'n', pid: 204, tty: 'pts/4', node: '01JF1EETN0DEBV11D1000000A1' }) } });
    stop = () => b.stop();
    await b.start();
    const s = ctx.store.getState().sessions;
    expect(s.a?.paneId).toBe('%3');
    expect(s.b?.paneId).toBeUndefined();
    expect(s.n?.paneId).toBeUndefined();
  });

  it('a new local session is tied at once, not at the next tick', async () => {
    const { fake, ctx, b } = rig();
    fake.addPane({ id: '%3', tty: '/dev/pts/3' });
    stop = () => b.stop();
    await b.start();
    ctx.store.emit({ type: 'session.added', sid: 'a', account: 0, data: { session: session({ sid: 'a', tty: 'pts/3' }) } });
    await flush();
    expect(ctx.store.getState().sessions.a?.paneId).toBe('%3');
  });

  it('every 10 s: a pane that went away unsets paneId, a new pane sets it, nothing changed emits nothing', async () => {
    const { fake, ctx, b } = rig();
    fake.addPane({ id: '%3', tty: '/dev/pts/3' });
    ctx.store.emit({ type: 'session.added', sid: 'a', account: 0, data: { session: session({ sid: 'a', tty: 'pts/3' }) } });
    stop = () => b.stop();
    await b.start();
    expect(ctx.store.getState().sessions.a?.paneId).toBe('%3');
    const events: string[] = [];
    const off = ctx.store.subscribe((ev) => {
      if (ev.type === 'session.updated') events.push(JSON.stringify(ev.data));
    });
    ctx.clock.advance(TICK_MS);
    await flush();
    expect(events).toEqual([]);
    fake.panes.length = 0;
    ctx.clock.advance(TICK_MS);
    await flush();
    expect(ctx.store.getState().sessions.a?.paneId).toBeUndefined();
    expect(events).toEqual([JSON.stringify({ patch: {}, unset: ['paneId'] })]);
    // the same tty, now in a pane with another id (a restarted server): the new id
    fake.addPane({ id: '%0', tty: '/dev/pts/3' });
    ctx.clock.advance(TICK_MS);
    await flush();
    expect(ctx.store.getState().sessions.a?.paneId).toBe('%0');
    off();
  });

  it('tmux that cannot be asked changes nothing; no server running unsets', async () => {
    const { fake, ctx, b, broken } = rig();
    fake.addPane({ id: '%3', tty: '/dev/pts/3' });
    ctx.store.emit({ type: 'session.added', sid: 'a', account: 0, data: { session: session({ sid: 'a', tty: 'pts/3' }) } });
    stop = () => b.stop();
    await b.start();
    expect(ctx.store.getState().sessions.a?.paneId).toBe('%3');
    // a timeout: keep what we have
    broken.on = true;
    ctx.clock.advance(TICK_MS);
    await flush();
    expect(ctx.store.getState().sessions.a?.paneId).toBe('%3');
    broken.on = false;
    fake.noServer = true;
    ctx.clock.advance(TICK_MS);
    await flush();
    expect(ctx.store.getState().sessions.a?.paneId).toBeUndefined();
  });

  it('stop ends the tick; without tmux there is no tick at all', async () => {
    const { fake, ctx, b } = rig();
    await b.start();
    await b.stop();
    const before = fake.calls.length;
    ctx.clock.advance(TICK_MS * 3);
    await flush();
    expect(fake.calls.length).toBe(before);
    const none = createTestContext({ bins: { tmux: null } });
    const nb = new TmuxBackend(none);
    await nb.start();
    expect(none.clock.pending()).toBe(0);
    await nb.stop();
  });
});
