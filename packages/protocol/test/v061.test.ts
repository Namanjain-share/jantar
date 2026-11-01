/**
 * v0.6.1: a session's background work (`Session.background`), the status the
 * board shows while it runs, and the words for it. Every name is made up.
 */
import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_NAME_MAX,
  BACKGROUND_TASKS_MAX,
  SessionBackgroundSchema,
  SessionOptionalKeySchema,
  SessionSchema,
  backgroundRunning,
  backgroundText,
  boardOrder,
  emptyState,
  parseEvent,
  reduceAll,
  sessionLabel,
  shownStatus,
  statusWord,
  type SessionBackground,
} from '../src/index.js';
import { T0, at, ev, resetSeq, session } from './helpers.js';

const FULL: SessionBackground = { workflows: 1, agents: 2, shells: 6, monitors: 1, since: T0, names: ['demo-sweep'] };

describe('SessionBackgroundSchema', () => {
  it('takes {} and a full value', () => {
    expect(SessionBackgroundSchema.parse({})).toEqual({});
    expect(SessionBackgroundSchema.parse(FULL)).toEqual(FULL);
    expect(SessionSchema.parse(session({ status: 'idle', background: FULL })).background).toEqual(FULL);
  });

  it('refuses 0 or too many, long names and more than 3 names', () => {
    for (const bad of [
      { workflows: 0 },
      { agents: BACKGROUND_TASKS_MAX + 1 },
      { shells: -1 },
      { monitors: 1.5 },
      { names: [] },
      { names: ['x'.repeat(BACKGROUND_NAME_MAX + 1)] },
      { names: ['a', 'b', 'c', 'd'] },
      { names: [''] },
      { since: 'yesterday' },
    ]) {
      expect(SessionBackgroundSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(SessionBackgroundSchema.safeParse({ workflows: BACKGROUND_TASKS_MAX, names: ['x'.repeat(BACKGROUND_NAME_MAX)] }).success).toBe(true);
  });

  it('an older parser drops a key it does not know', () => {
    const parsed = SessionSchema.parse({ ...session(), somethingNew: { workflows: 1 } });
    expect('somethingNew' in parsed).toBe(false);
  });

  it('is cleared by a patch, never unset (a 0.6.0 hub refuses an unset key it does not know)', () => {
    expect(SessionOptionalKeySchema.options).not.toContain('background');
    expect(() => parseEvent({ seq: 1, ts: T0, type: 'session.updated', sid: 'sid-a', data: { patch: {}, unset: ['background'] } })).toThrow();
    resetSeq();
    const s = reduceAll(emptyState(), [
      ev({ type: 'session.added', sid: 'sid-a', data: { session: session({ status: 'idle' }) } }),
      ev({ type: 'session.updated', sid: 'sid-a', data: { patch: { background: { workflows: 1, since: T0, names: ['demo-sweep'] } } } }),
      ev({ type: 'session.updated', sid: 'sid-a', data: { patch: { background: {} } } }),
    ]);
    expect(s.sessions['sid-a']?.background).toEqual({});
  });
});

describe('backgroundRunning and shownStatus', () => {
  it('count workflows and agents only, and never for an ended session', () => {
    expect(backgroundRunning(session({ background: FULL }))).toBe(3);
    expect(backgroundRunning(session({ background: { shells: 6, monitors: 1 } }))).toBe(0);
    expect(backgroundRunning(session({ background: {} }))).toBe(0);
    expect(backgroundRunning(session())).toBe(0);
    expect(backgroundRunning(session({ status: 'ended', background: FULL }))).toBe(0);
  });

  it('idle with work running reads as working; nothing else changes', () => {
    expect(shownStatus(session({ status: 'idle', background: { workflows: 1, since: T0 } }))).toBe('working');
    expect(shownStatus(session({ status: 'idle', background: { agents: 1, since: T0 } }))).toBe('working');
    expect(shownStatus(session({ status: 'idle', background: { shells: 6 } }))).toBe('idle');
    expect(shownStatus(session({ status: 'idle' }))).toBe('idle');
    expect(shownStatus(session({ status: 'waiting', background: FULL }))).toBe('waiting');
    expect(shownStatus(session({ status: 'compacting', background: FULL }))).toBe('compacting');
    expect(shownStatus(session({ status: 'ended', background: FULL }))).toBe('ended');
  });

  it('statusWord says Working', () => {
    const s = session({ status: 'idle', background: { workflows: 1, since: T0 } });
    expect(statusWord(s)).toBe('Working');
    expect(sessionLabel(s)).toBe('Working · alpha-app · fix login');
    expect(sessionLabel(session({ status: 'idle', background: { shells: 2 } }))).toBe('Done · alpha-app · fix login');
  });
});

describe('backgroundText', () => {
  const words = (background: SessionBackground, status: 'idle' | 'working' | 'ended' = 'idle') =>
    backgroundText(session({ status, background }));

  it('says what runs, singular and plural, both kinds', () => {
    expect(words({ workflows: 1, since: T0, names: ['demo-sweep'] })).toEqual({ running: '1 workflow running', name: 'demo-sweep', quiet: null });
    expect(words({ workflows: 2, since: T0 }).running).toBe('2 workflows running');
    expect(words({ agents: 1, since: T0 }).running).toBe('1 agent running');
    expect(words({ agents: 2, since: T0 }).running).toBe('2 agents running');
    expect(words({ workflows: 1, agents: 2, since: T0 }).running).toBe('1 workflow and 2 agents running');
  });

  it('names the newest workflow, "+N" for the others (by the count, not the names)', () => {
    expect(words({ workflows: 2, since: T0, names: ['demo-sweep', 'demo-older'] }).name).toBe('demo-sweep +1');
    expect(words({ workflows: 3, since: T0, names: ['demo-sweep'] }).name).toBe('demo-sweep +2');
    expect(words({ workflows: 1, since: T0 }).name).toBeNull();
    expect(words({ agents: 1, since: T0, names: ['demo-sweep'] }).name).toBeNull();
  });

  it('the quiet count, alone or beside running work', () => {
    expect(words({ shells: 6 })).toEqual({ running: null, name: null, quiet: '6 shells' });
    expect(words({ shells: 1, monitors: 1 }).quiet).toBe('1 shell · 1 monitor');
    expect(words({ monitors: 2 }).quiet).toBe('2 monitors');
    expect(words(FULL)).toEqual({ running: '1 workflow and 2 agents running', name: 'demo-sweep', quiet: '6 shells · 1 monitor' });
  });

  it('is all null with nothing, or for an ended session', () => {
    const none = { running: null, name: null, quiet: null };
    expect(words({})).toEqual(none);
    expect(backgroundText(session({ status: 'idle' }))).toEqual(none);
    expect(words(FULL, 'ended')).toEqual(none);
  });
});

describe('boardOrder', () => {
  it('puts an idle session with work running among the working ones', () => {
    resetSeq();
    const s = reduceAll(emptyState(), [
      ev({ type: 'session.added', sid: 'w', data: { session: session({ sid: 'w', status: 'working', statusSince: at(5) }) } }),
      ev({ type: 'session.added', sid: 'i', data: { session: session({ sid: 'i', status: 'idle', statusSince: at(1) }) } }),
      ev({
        type: 'session.added',
        sid: 'bg',
        data: { session: session({ sid: 'bg', status: 'idle', statusSince: at(7), background: { workflows: 1, since: at(0) } }) },
      }),
      ev({
        type: 'session.added',
        sid: 'sh',
        data: { session: session({ sid: 'sh', status: 'idle', statusSince: at(3), background: { shells: 6 } }) },
      }),
      ev({ type: 'session.added', sid: 'e', data: { session: session({ sid: 'e', status: 'ended', statusSince: at(9), background: FULL }) } }),
    ]);
    expect(boardOrder(s).map((x) => x.sid)).toEqual(['sh', 'i', 'bg', 'w', 'e']);
  });
});
