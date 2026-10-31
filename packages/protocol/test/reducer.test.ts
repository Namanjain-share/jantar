import { beforeEach, describe, expect, it } from 'vitest';
import {
  ALERTS_CAP,
  EVENT,
  SENDS_CAP,
  emptyState,
  hasGap,
  reduce,
  reduceAll,
  type State,
} from '../src/index.js';
import { account, alert, at, ev, job, move, pending, resetSeq, session } from './helpers.js';

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

describe('reduce', () => {
  beforeEach(() => resetSeq());

  it('adds, updates, unsets and removes sessions', () => {
    let s = reduce(emptyState(), ev({ type: 'session.added', sid: 'sid-a', data: { session: session() } }));
    expect(s.seq).toBe(1);
    expect(s.sessions['sid-a']?.status).toBe('working');

    s = reduce(
      s,
      ev({
        type: 'session.updated',
        sid: 'sid-a',
        data: {
          patch: { status: 'idle', statusSource: 'hook', now: { kind: 'said', text: 'done' } },
        },
      }),
    );
    expect(s.sessions['sid-a']).toMatchObject({ status: 'idle', statusSource: 'hook', sid: 'sid-a' });
    expect(s.sessions['sid-a']?.now?.text).toBe('done');

    s = reduce(s, ev({ type: 'session.updated', sid: 'sid-a', data: { patch: {}, unset: ['now', 'name'] } }));
    expect(s.sessions['sid-a']?.now).toBeUndefined();
    expect(s.sessions['sid-a']?.name).toBeUndefined();
    expect('now' in (s.sessions['sid-a'] ?? {})).toBe(false);

    s = reduce(s, ev({ type: 'session.removed', sid: 'sid-a', data: { reason: 'ended' } }));
    expect(s.sessions['sid-a']).toBeUndefined();
    expect(s.seq).toBe(4);
  });

  it('ignores updates for unknown sessions but still advances seq', () => {
    const s = reduce(emptyState(), ev({ type: 'session.updated', sid: 'nope', data: { patch: { status: 'idle' } } }));
    expect(s.sessions).toEqual({});
    expect(s.seq).toBe(1);
  });

  it('never mutates its input', () => {
    const base = deepFreeze(
      reduceAll(emptyState(), [
        ev({ type: 'session.added', sid: 'sid-a', data: { session: session() } }),
        ev({ type: 'pending.opened', sid: 'sid-a', data: { pending: pending() } }),
      ]),
    );
    const snapshot = JSON.stringify(base);
    const next = reduceAll(base, [
      ev({ type: 'session.updated', sid: 'sid-a', data: { patch: { status: 'waiting' }, unset: ['name'] } }),
      ev({ type: 'pending.resolved', sid: 'sid-a', data: { id: pending().id, state: 'closed' } }),
      ev({ type: 'alert.limit', sid: 'sid-a', data: { alert: alert() } }),
      ev({ type: 'send.progress', sid: 'sid-a', data: { job: job() } }),
      ev({ type: 'move.saving', sid: 'sid-a', data: { move: move() } }),
      ev({ type: 'session.removed', sid: 'sid-a', data: {} }),
    ]);
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(next).not.toBe(base);
  });

  it('skips events at or below the current seq (safe replay)', () => {
    const e1 = ev({ type: 'session.added', sid: 'sid-a', data: { session: session() } });
    const e2 = ev({ type: 'session.updated', sid: 'sid-a', data: { patch: { status: 'idle' } } });
    const s = reduceAll(emptyState(), [e1, e2]);
    const replayed = reduceAll(s, [e1, e2]);
    expect(replayed).toBe(s);
  });

  it('detects gaps', () => {
    const s: State = { ...emptyState(), seq: 5 };
    expect(hasGap(s, ev({ type: 'session.removed', sid: 'x', data: {} }, 6))).toBe(false);
    expect(hasGap(s, ev({ type: 'session.removed', sid: 'x', data: {} }, 8))).toBe(true);
  });

  it('opens, decides and closes pending cards', () => {
    const p = pending();
    let s = reduce(emptyState(), ev({ type: 'pending.opened', sid: 'sid-a', data: { pending: p } }));
    expect(s.pending[p.id]?.state).toBe('open');

    s = reduce(
      s,
      ev({
        type: 'pending.resolved',
        sid: 'sid-a',
        data: { id: p.id, state: 'decided', decidedBy: 'device:d1', decision: { behavior: 'allow' } },
      }),
    );
    expect(s.pending[p.id]).toMatchObject({ state: 'decided', decidedBy: 'device:d1' });

    for (const final of ['confirmed', 'handled-in-terminal', 'closed'] as const) {
      const opened = reduce(s, ev({ type: 'pending.opened', sid: 'sid-a', data: { pending: p } }));
      const closed = reduce(opened, ev({ type: 'pending.resolved', sid: 'sid-a', data: { id: p.id, state: final } }));
      expect(closed.pending[p.id]).toBeUndefined();
    }
  });

  it('drops a removed session’s cards', () => {
    const s = reduceAll(emptyState(), [
      ev({ type: 'session.added', sid: 'sid-a', data: { session: session() } }),
      ev({ type: 'session.added', sid: 'sid-b', data: { session: session({ sid: 'sid-b' }) } }),
      ev({ type: 'pending.opened', sid: 'sid-a', data: { pending: pending({ id: 'p'.repeat(30) }) } }),
      ev({ type: 'pending.opened', sid: 'sid-b', data: { pending: pending({ id: 'q'.repeat(30), sid: 'sid-b' }) } }),
      ev({ type: 'session.removed', sid: 'sid-a', data: {} }),
    ]);
    expect(Object.keys(s.pending)).toEqual(['q'.repeat(30)]);
  });

  it('replaces accounts on usage.updated', () => {
    let s = reduce(
      emptyState(),
      ev({
        type: 'usage.updated',
        data: { accounts: [account(), account({ id: 3 })], activeAccount: 1, fetchedAt: at(1), source: 'cache' },
      }),
    );
    expect(Object.keys(s.accounts).sort()).toEqual(['2', '3']);
    expect(s.activeAccount).toBe(1);
    expect(s.usage).toEqual({ fetchedAt: at(1), source: 'cache' });

    s = reduce(
      s,
      ev({ type: 'usage.updated', data: { accounts: [account({ id: 4 })], activeAccount: null, fetchedAt: at(2), source: 'cli' } }),
    );
    expect(Object.keys(s.accounts)).toEqual(['4']);
    expect(s.activeAccount).toBeNull();
  });

  it('tracks moves on the state and on the session, and drops finished ones', () => {
    let s = reduce(emptyState(), ev({ type: 'session.added', sid: 'sid-a', data: { session: session() } }));
    s = reduce(s, ev({ type: 'move.saving', sid: 'sid-a', data: { move: move() } }));
    expect(s.moves['sid-a']?.step).toBe('saving');
    expect(s.sessions['sid-a']?.move?.step).toBe('saving');

    s = reduce(s, ev({ type: 'move.parked', sid: 'sid-a', data: { move: move({ step: 'parked', to: undefined }) } }));
    expect(s.moves['sid-a']?.step).toBe('parked');

    for (const type of [EVENT.MOVE_SWITCHED, EVENT.MOVE_RESUMED] as const) {
      const done = reduce(s, ev({ type, sid: 'sid-a', data: { move: move() } }));
      expect(done.moves['sid-a']).toBeUndefined();
      expect(done.sessions['sid-a']?.move).toBeUndefined();
    }
    const cleared = reduce(s, ev({ type: 'move.cleared', sid: 'sid-a', data: {} }));
    expect(cleared.moves).toEqual({});

    // a move for a session we don't know yet is still tracked
    const orphan = reduce(emptyState(), ev({ type: 'move.stuck', sid: 'zzz', data: { move: move({ sid: 'zzz', step: 'stuck' }) } }));
    expect(orphan.moves['zzz']?.step).toBe('stuck');
  });

  it('appends alerts newest first, deduped and capped', () => {
    let s = emptyState();
    for (let i = 0; i < ALERTS_CAP + 5; i++) {
      s = reduce(s, ev({ type: 'alert.error', data: { alert: alert({ id: `al-${i}`, kind: 'error' }) } }));
    }
    expect(s.alerts).toHaveLength(ALERTS_CAP);
    expect(s.alerts[0]?.id).toBe(`al-${ALERTS_CAP + 4}`);
    s = reduce(s, ev({ type: 'alert.blocked', data: { alert: alert({ id: 'al-10', kind: 'blocked', what: 'again' }) } }));
    expect(s.alerts.filter((a) => a.id === 'al-10')).toHaveLength(1);
    expect(s.alerts[0]?.what).toBe('again');
  });

  it('tracks send jobs and prunes old finished ones past the cap', () => {
    let s = emptyState();
    for (let i = 0; i < SENDS_CAP + 3; i++) {
      s = reduce(
        s,
        ev({
          type: 'send.progress',
          sid: 'sid-a',
          data: { job: job({ id: `job-${i}`, stage: i < 10 ? 'proven' : 'typed', updatedAt: at(i) }) },
        }),
      );
    }
    expect(Object.keys(s.sends)).toHaveLength(SENDS_CAP);
    expect(s.sends['job-0']).toBeUndefined();
    expect(s.sends['job-3']).toBeDefined();
    expect(s.sends[`job-${SENDS_CAP + 2}`]?.stage).toBe('typed');
  });

  it('records daemon info and leaves state alone for moment events', () => {
    let s = reduce(emptyState(), ev({ type: 'session.added', sid: 'sid-a', data: { session: session() } }));
    s = reduce(s, ev({ type: 'daemon.version', data: { protocol: 1, daemonVersion: '0.1.0', webHash: null } }));
    expect(s.daemon).toEqual({ protocol: 1, daemonVersion: '0.1.0', webHash: null });

    const before = s;
    const after = reduceAll(s, [
      ev({ type: 'session.done', sid: 'sid-a', data: { lastReply: { text: 'hi', at: at(1) } } }),
      ev({ type: 'session.waiting', sid: 'sid-a', data: { waitingFor: 'permission' } }),
      ev({ type: 'session.reminder', sid: 'sid-a', data: { afterMin: 10, waitingSince: at(0) } }),
      ev({ type: 'usage.threshold', account: 2, data: { window: 'five_hour', pct: 81, threshold: 80 } }),
      ev({ type: 'planner.no_room', data: { sids: ['sid-a'], why: 'all full' } }),
      ev({ type: 'device.pending', data: { pairId: 'p1', expiresAt: at(10) } }),
    ]);
    expect({ ...after, seq: before.seq }).toEqual(before);
    expect(after.seq).toBe(before.seq + 6);
  });
});
