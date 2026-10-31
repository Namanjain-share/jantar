/**
 * Wave-2 additions: the per-session files.changed counter in state
 * (`fileTicks`, so the Files views refresh on every write) and the folder
 * listing's `total` ("Showing 500 of 812").
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FoldersListResponseSchema, StateSchema, emptyState, reduce, reduceAll, type DaemonEvent, type State } from '../src/index.js';
import { T0, ev, resetSeq, session } from './helpers.js';

const change = { changeId: 'c1', path: '/w/a.ts', tool: 'Edit', at: T0, status: 'ok', opId: 'o1', transcriptOffset: 0, byAgent: false } as const;
const changed = (sid: string) => ev({ type: 'files.changed', sid, data: change });

function withSessions(...sids: string[]): State {
  return reduceAll(
    emptyState(),
    sids.map((sid) => ev({ type: 'session.added', sid, data: { session: session({ sid }) } })),
  );
}

describe('fileTicks', () => {
  beforeEach(() => resetSeq());

  it('starts empty and parses', () => {
    expect(emptyState().fileTicks).toEqual({});
    expect(StateSchema.safeParse(emptyState()).success).toBe(true);
  });

  it('counts every files.changed per session, one session at a time', () => {
    const s = reduceAll(withSessions('sid-a', 'sid-b'), [changed('sid-a'), changed('sid-a'), changed('sid-b'), changed('sid-a')]);
    expect(s.fileTicks).toEqual({ 'sid-a': 3, 'sid-b': 1 });
    expect(StateSchema.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('holds a count only: nothing of the path or the tool reaches the state', () => {
    const s = reduce(withSessions('sid-a'), changed('sid-a'));
    const text = JSON.stringify(s);
    expect(text).not.toContain('/w/a.ts');
    expect(text).not.toContain('"c1"');
    expect(s.sessions['sid-a']).toEqual(withSessions('sid-a').sessions['sid-a']);
  });

  it('ignores a session the state does not know, and prototype names', () => {
    const base = withSessions('sid-a');
    for (const sid of ['nope', '__proto__', 'constructor', 'toString']) {
      const s = reduce(base, changed(sid));
      expect(s.fileTicks, sid).toEqual({});
    }
  });

  it('counts for a session called "constructor" from zero, not from Object.prototype', () => {
    const s = reduceAll(withSessions('constructor'), [changed('constructor'), changed('constructor')]);
    expect(Object.hasOwn(s.fileTicks ?? {}, 'constructor')).toBe(true);
    expect(s.fileTicks?.constructor).toBe(2);
  });

  it("drops a removed session's counter and keeps the others", () => {
    let s = reduceAll(withSessions('sid-a', 'sid-b'), [changed('sid-a'), changed('sid-b')]);
    s = reduce(s, ev({ type: 'session.removed', sid: 'sid-a', data: {} }));
    expect(s.fileTicks).toEqual({ 'sid-b': 1 });
  });

  it('works on a snapshot from a daemon without the field', () => {
    const old = { ...withSessions('sid-a') } as State;
    delete (old as Partial<State>).fileTicks;
    expect(StateSchema.safeParse(old).success).toBe(true);
    expect(reduce(old, changed('sid-a')).fileTicks).toEqual({ 'sid-a': 1 });
    const removed = reduce(old, ev({ type: 'session.removed', sid: 'sid-a', data: {} }));
    expect(removed.fileTicks).toBeUndefined();
  });

  it('a replayed event (seq not past the state) counts once', () => {
    const base = withSessions('sid-a');
    const e: DaemonEvent = changed('sid-a');
    const once = reduce(base, e);
    expect(reduce(once, e)).toBe(once);
    expect(once.fileTicks).toEqual({ 'sid-a': 1 });
  });
});

describe('FoldersListResponse.total', () => {
  const listing = { root: 'r.work', path: '', display: '~/Desktop/work', entries: [], next: 'd0499', hiddenProtected: 0, truncated: false };

  it('carries the count over every page, and may be absent (an older daemon)', () => {
    expect(FoldersListResponseSchema.parse({ ...listing, total: 812 }).total).toBe(812);
    expect(FoldersListResponseSchema.parse(listing).total).toBeUndefined();
  });

  it('is a whole number, zero or more', () => {
    for (const total of [-1, 1.5, '812']) expect(FoldersListResponseSchema.safeParse({ ...listing, total }).success, String(total)).toBe(false);
    expect(FoldersListResponseSchema.safeParse({ ...listing, total: 0 }).success).toBe(true);
  });
});
