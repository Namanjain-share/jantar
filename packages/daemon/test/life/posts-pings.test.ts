/**
 * Post pings (v0.7, life/posts/pings.ts): a post with a day and a time rings
 * like a todo, through the todo ring's own rules (armRing), with the real
 * scheduler on a FakeClock:
 *
 * - it rings once at its time; an edited time re-arms; posted, skipped and
 *   deleted posts clear their row; a past time from an edit never rings; a
 *   post added 20 s after its time rings; resync arms every open timed post
 *   and clears the rest;
 * - the push follows life.lockScreenDetails: off "Tap to open · 19:30", on
 *   "Post on Reddit · r/exampletools · 19:30"; posts due in the same minute
 *   are one push "Posts due · 2" (url /posts, tag posts:19:30), with both
 *   labels when details are on; a catch-up says "Missed at";
 * - no title, text or notes in any push, whatever the switch.
 * Synthetic values only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LIFE_MARKER, postBody } from '@jantar/fixtures';
import type { PostBody } from '@jantar/protocol';
import type { Actor, LifeCore, LifePush, PostsModule } from '../../src/contracts.js';
import { createTestContext, createTestLifeCore } from '../../src/core/testing.js';
import { memoryLogger } from '../../src/core/log.js';
import { buildPostsModule } from '../../src/life/posts/module.js';
import { postPush } from '../../src/life/posts/pings.js';
import { LifeScheduler } from '../../src/life/scheduler.js';
import { makeFakes } from '../api/fakes.js';

const PHONE: Actor = { kind: 'device', deviceId: 'dev-phone', scopes: ['read', 'control'] };
const MIN = 60_000;
const DAY = '2026-11-02';

function ok<T>(r: { ok: true; value: T } | { ok: false; code: string; reason: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return r.value;
}

const rigs: { stop(): void; close(): void }[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) {
    r.stop();
    r.close();
  }
});

/** createTestLifeCore with the real scheduler; every push it sends is kept. */
function realRig(start: string, tz = 'Asia/Kolkata') {
  const test = createTestLifeCore({ tz, settings: { posts: true, timezone: tz } });
  test.clock.set(start);
  const sent: (LifePush & { at: string })[] = [];
  const sched = new LifeScheduler(test.clock, memoryLogger(), () => test.db, {
    send: async (p) => {
      sent.push({ ...p, at: test.clock.iso() });
      return { delivered: 1, failed: 0 };
    },
  });
  const core: LifeCore = { ...test, scheduler: sched };
  const ctx = createTestContext({ clock: test.clock });
  const f = makeFakes(ctx);
  const posts = buildPostsModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
  sched.start();
  rigs.push({ stop: () => sched.stop(), close: () => test.close() });
  const settle = async (ms: number) => {
    await test.clock.tick(ms);
    await sched.settled();
    await test.clock.tick(0);
  };
  return {
    test,
    sched,
    posts,
    sent,
    clock: test.clock,
    row: (id: string) => sched.rows('post').find((r) => r.ref === id),
    add: (time: string | undefined, over: Partial<PostBody> = {}, day = DAY) => ok(posts.create(postBody({ ...(time ? { due: { day, time } } : {}), ...over }, { marked: true }), PHONE)).id,
    settle,
    /** `n` minutes, one at a time, so a send settles before its deadline comes round. */
    run: async (n: number) => {
      for (let i = 0; i < n; i++) await settle(MIN);
    },
  };
}

// 19:30 IST is 14:00 UTC.
const AT_1930 = '2026-11-02T14:00:00.000Z';

describe('a post rings like a todo', () => {
  it('rings once at its time, with the generic body while lock-screen details are off', async () => {
    const r = realRig('2026-11-02T13:55:00.000Z');
    const id = r.add('19:30');
    expect(r.row(id)?.nextAt).toBe(AT_1930);
    await r.run(4);
    expect(r.sent).toEqual([]);
    await r.run(2);
    expect(r.sent).toEqual([{ kind: 'life', title: 'Post due', body: 'Tap to open · 19:30', url: `/posts?id=${id}`, tag: `life:post:${id}`, at: expect.any(String) }]);
    await r.run(60);
    expect(r.sent).toHaveLength(1);
    expect(r.row(id)?.nextAt).toBeNull();
  });

  it('an edited time re-arms; posted, skipped and deleted clear the row; a past time from an edit never rings', async () => {
    const r = realRig('2026-11-02T13:00:00.000Z');
    const id = r.add('19:30');
    ok(r.posts.update(id, { due: { day: DAY, time: '20:00' } }, PHONE));
    expect(r.row(id)?.nextAt).toBe('2026-11-02T14:30:00.000Z');
    ok(r.posts.update(id, { status: 'posted' }, PHONE));
    expect(r.row(id)).toBeUndefined();
    ok(r.posts.update(id, { status: 'ready' }, PHONE));
    expect(r.row(id)?.nextAt).toBe('2026-11-02T14:30:00.000Z');
    ok(r.posts.update(id, { status: 'skipped' }, PHONE));
    expect(r.row(id)).toBeUndefined();
    ok(r.posts.update(id, { status: 'idea' }, PHONE));
    ok(r.posts.remove(id, PHONE));
    expect(r.row(id)).toBeUndefined();
    // An edit to a time already gone (18:00 IST is 12:30 UTC, half an hour ago) sets no row.
    const past = r.add('19:30');
    ok(r.posts.update(past, { due: { day: DAY, time: '18:00' } }, PHONE));
    expect(r.row(past)).toBeUndefined();
    // A day alone never rings.
    const dayOnly = ok(r.posts.create({ platform: 'reddit', due: { day: DAY } }, PHONE)).id;
    expect(r.row(dayOnly)).toBeUndefined();
    await r.run(120);
    expect(r.sent).toEqual([]);
  });

  it('a post added 20 s after its time rings; one minutes late does not; Undo after the ring sends nothing again', async () => {
    const r = realRig('2026-11-02T14:00:20.000Z');
    const id = r.add('19:30');
    expect(r.row(id)?.nextAt).toBe(AT_1930);
    const gone = r.add('19:25');
    expect(r.row(gone)).toBeUndefined();
    await r.settle(30_000);
    expect(r.sent.map((p) => p.body)).toEqual(['Tap to open · 19:30']);
    ok(r.posts.update(id, { status: 'posted' }, PHONE));
    ok(r.posts.update(id, { status: 'ready' }, PHONE));
    expect(r.row(id)).toBeUndefined();
    await r.run(10);
    expect(r.sent).toHaveLength(1);
  });

  it('resync arms every open timed post and clears the rest', async () => {
    const r = realRig('2026-11-02T13:00:00.000Z');
    const a = r.add('19:30');
    const b = r.add('20:00');
    ok(r.posts.update(b, { status: 'posted' }, PHONE));
    r.test.db.prepare("INSERT INTO pings (id, kind, ref, sub, next_at) VALUES ('x1', 'post', 'gone', '', ?)").run(AT_1930);
    r.test.db.prepare("INSERT INTO pings (id, kind, ref, sub, next_at) VALUES ('x2', 'post', ?, '', ?)").run(b, AT_1930);
    r.sched.clear('post', a);
    r.sched.resyncAll(new Set(['post']));
    expect(r.sched.rows('post').map((x) => [x.ref, x.nextAt])).toEqual([[a, AT_1930]]);
  });

  it('a catch-up after a sleep says "Missed at"', async () => {
    const r = realRig('2026-11-02T13:55:00.000Z');
    r.add('19:30');
    r.sched.stop();
    r.clock.set('2026-11-02T15:00:00.000Z');
    r.sched.start();
    await r.settle(0);
    expect(r.sent.map((p) => p.body)).toEqual(['Missed at 19:30 · Tap to open · 19:30']);
  });
});

describe('the push', () => {
  it('with lock-screen details on, one post names its kind, platform and where; never its title, text or notes', async () => {
    const r = realRig('2026-11-02T13:55:00.000Z');
    r.test.setSettings({ lockScreenDetails: true });
    const id = ok(r.posts.create(postBody({ where: 'r/exampletools', due: { day: DAY, time: '19:30' }, title: `T ${LIFE_MARKER}`, text: `X ${LIFE_MARKER}`, notes: `N ${LIFE_MARKER}` }), PHONE)).id;
    await r.run(6);
    expect(r.sent.map((p) => [p.title, p.body, p.url])).toEqual([['Post due', 'Post on Reddit · r/exampletools · 19:30', `/posts?id=${id}`]]);
    expect(JSON.stringify(r.sent)).not.toContain(LIFE_MARKER);
  });

  it('two posts in the same minute are one push "Posts due · 2" at /posts, tagged by the time; with details on, both labels', async () => {
    const r = realRig('2026-11-02T13:55:00.000Z');
    r.add('19:30', { where: 'r/exampletools' });
    r.add('19:30', { platform: 'instagram', kind: 'reel', where: '@example.studio' });
    await r.run(6);
    expect(r.sent.map((p) => [p.title, p.body, p.url, p.tag])).toEqual([['Posts due · 2', 'Tap to open · 19:30', '/posts', 'posts:19:30']]);

    const d = realRig('2026-11-02T13:55:00.000Z');
    d.test.setSettings({ lockScreenDetails: true });
    d.add('19:30', { platform: 'instagram', kind: 'reel', where: '@example.studio' });
    d.add('19:30', { where: 'r/exampletools' });
    d.add('19:30', { where: 'r/exampletools', kind: 'comment' });
    await d.run(6);
    expect(d.sent.map((p) => [p.title, p.body])).toEqual([['Posts due · 3', 'Instagram · @example.studio, Reddit · r/exampletools · 19:30']]);
    expect(JSON.stringify([r.sent, d.sent])).not.toContain(LIFE_MARKER);
  });

  it('postPush: platform other, no where, a long where with a newline is one line and clipped; an unreadable post keeps the generic body', () => {
    const base = { id: 'p1', status: 'idea' as const, createdAt: AT_1930, updatedAt: AT_1930 };
    const at = new Date(AT_1930);
    const tz = 'Asia/Kolkata';
    expect(postPush([{ ...base, platform: 'other', kind: 'video', where: '@example' }], ['p1'], at, false, tz, true).body).toBe('Video · @example · 19:30');
    expect(postPush([{ ...base, platform: 'x', kind: 'thread' }], ['p1'], at, false, tz, true).body).toBe('Thread on X · 19:30');
    const long = postPush([{ ...base, platform: 'reddit', kind: 'post', where: `r/example\n${'a'.repeat(60)}` }], ['p1'], at, false, tz, true).body;
    expect(long).not.toContain('\n');
    expect(long).toMatch(/^Post on Reddit · r\/example a+… · 19:30$/);
    expect(postPush([null], ['p1'], at, true, tz, true)).toMatchObject({ title: 'Post due', body: 'Missed at 19:30 · Tap to open · 19:30', url: '/posts?id=p1' });
    expect(postPush([null, null], ['p1', 'p2'], at, false, tz, true)).toMatchObject({ title: 'Posts due · 2', body: 'Tap to open · 19:30', tag: 'posts:19:30' });
  });
});
