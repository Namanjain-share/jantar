import { describe, expect, it } from 'vitest';
import type { DaemonEvent, EventOf, Session } from '@jantar/protocol';
import { FakeClock, MemoryStore, memoryLogger } from '../src/core/index.js';

function session(sid: string, over: Partial<Session> = {}): Session {
  return {
    sid,
    pid: 41001,
    procStart: 'Thu Jan 15 09:00:00 2026',
    account: 2,
    configDir: '/synthetic/home/.claude',
    cwd: '/synthetic/home/work/alpha-app',
    folder: 'alpha-app',
    entrypoint: 'cli',
    status: 'working',
    statusSource: 'session-file',
    statusSince: '2026-01-15T10:00:00.000Z',
    subagentsRunning: 0,
    ...over,
  };
}

describe('MemoryStore', () => {
  it('assigns seq and ts, validates, and applies the reducer', () => {
    const clock = new FakeClock('2026-01-15T10:00:00.000Z');
    const store = new MemoryStore({ clock });
    expect(store.seq).toBe(0);
    const ev: EventOf<'session.added'> = store.emit({ type: 'session.added', sid: 'a', data: { session: session('a') } });
    expect(ev.seq).toBe(1);
    expect(ev.ts).toBe('2026-01-15T10:00:00.000Z');
    expect(ev.data.session.sid).toBe('a');
    clock.advance(1000);
    const ev2 = store.emit({ type: 'session.updated', sid: 'a', data: { patch: { status: 'idle' } } });
    expect(ev2.seq).toBe(2);
    expect(ev2.ts).toBe('2026-01-15T10:00:01.000Z');
    expect(store.getState().sessions.a?.status).toBe('idle');
    expect(store.snapshot().seq).toBe(2);
    expect(store.getState().seq).toBe(2);
    // explicit ts is kept
    expect(store.emit({ type: 'session.removed', sid: 'a', ts: '2026-01-15T09:59:00.000Z', data: {} }).ts).toBe(
      '2026-01-15T09:59:00.000Z',
    );
  });

  it('rejects invalid events without consuming a seq', () => {
    const store = new MemoryStore();
    expect(() => store.emit({ type: 'session.removed', data: {} } as never)).toThrow(/requires sid/);
    expect(() =>
      store.emit({ type: 'session.added', sid: 'a', data: { session: { sid: 'a' } } } as never),
    ).toThrow(/invalid event/);
    expect(store.seq).toBe(0);
  });

  it('delivers to subscribers in seq order, even with nested emits', () => {
    const store = new MemoryStore();
    const seenA: number[] = [];
    const seenB: number[] = [];
    store.subscribe((ev) => {
      seenA.push(ev.seq);
      if (ev.type === 'session.added') {
        store.emit({ type: 'session.updated', sid: ev.sid as string, data: { patch: { status: 'idle' } } });
      }
    });
    store.subscribe((ev) => seenB.push(ev.seq));
    store.emit({ type: 'session.added', sid: 'a', data: { session: session('a') } });
    expect(seenA).toEqual([1, 2]);
    expect(seenB).toEqual([1, 2]);
    expect(store.getState().sessions.a?.status).toBe('idle');
  });

  it('isolates subscriber errors and supports unsubscribe', () => {
    const log = memoryLogger();
    const store = new MemoryStore({ log });
    const seen: DaemonEvent[] = [];
    store.subscribe(() => {
      throw new Error('boom');
    });
    const off = store.subscribe((ev) => seen.push(ev));
    store.emit({ type: 'session.removed', sid: 'x', data: {} });
    off();
    store.emit({ type: 'session.removed', sid: 'y', data: {} });
    expect(seen.map((e) => e.sid)).toEqual(['x']);
    expect(log.records.some((r) => r.level === 'error' && r.msg.includes('subscriber threw'))).toBe(true);
  });

  it('replays from the ring or falls back to a snapshot', () => {
    const store = new MemoryStore({ ringSize: 3 });
    for (const sid of ['a', 'b', 'c', 'd', 'e']) store.emit({ type: 'session.removed', sid, data: {} });
    expect(store.seq).toBe(5);

    const r1 = store.replay(3);
    expect(r1.kind).toBe('events');
    if (r1.kind === 'events') expect(r1.events.map((e) => e.seq)).toEqual([4, 5]);

    const r2 = store.replay(2); // oldest in ring is 3, so after=2 is still complete
    expect(r2.kind === 'events' && r2.events.map((e) => e.seq)).toEqual([3, 4, 5]);

    expect(store.replay(1).kind).toBe('snapshot'); // 2 fell out of the ring
    expect(store.replay(5)).toEqual({ kind: 'events', events: [] });
    expect(store.replay(9).kind).toBe('snapshot'); // client is ahead: daemon restarted
    expect(store.replay(-1).kind).toBe('snapshot');
    const snap = store.replay(0);
    expect(snap.kind === 'snapshot' && snap.seq).toBe(5);
  });

  it('continues numbering after a restart', () => {
    const store = new MemoryStore({ startSeq: 41, epoch: 'e-test' });
    expect(store.seq).toBe(41);
    expect(store.epoch).toBe('e-test');
    expect(store.replay(41)).toEqual({ kind: 'events', events: [] });
    expect(store.replay(10).kind).toBe('snapshot');
    expect(store.emit({ type: 'session.removed', sid: 'a', data: {} }).seq).toBe(42);
    expect(store.replay(41).kind).toBe('events');
  });

  it('gives each store its own epoch', () => {
    expect(new MemoryStore().epoch).not.toBe(new MemoryStore().epoch);
  });
});
