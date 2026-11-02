/**
 * v0.9 Log a comment (life/posts), on createTestLifeCore (in-memory life.db,
 * FakeClock, recording scheduler), and its route through the API:
 *
 * - a posted create: postedAt is the clock, the posted link, text and where
 *   kept; it is history, so it passes the 200-open cap; a posted link with
 *   idea or ready is refused; the same posted link twice is conflict until
 *   the first is deleted or leaves posted; it never rings;
 * - the week counts a logged Reddit comment against { reddit, comment } and
 *   { reddit }, not { reddit, post };
 * - Today's comments: the Life zone's midnights (23:59 and 00:00 IST are two
 *   days), only kind comment, the goal ceil(comment goals' perWeek / 7);
 * - Done lists the newest 300;
 * - routes: a phone's posted add answers { id } and audits the id only; a
 *   ctl.sock posted add counts against the 30 an hour.
 * Synthetic values only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LIFE_MARKER } from '@jantar/fixtures';
import { LIFE_LIMITS, POSTS_DONE_PAGE, PostsResponseSchema, SettingsSchema, type PostBody, type PostsResponse } from '@jantar/protocol';
import type { Actor, LifeService, PostsModule } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { createTestContext, createTestLifeCore, type TestLifeCore } from '../../src/core/testing.js';
import { POSTS_CTL_LIMITED } from '../../src/api/routes/posts.js';
import { V07_LIMITS } from '../../src/api/services.js';
import { POSTS_SENTENCES, buildPostsModule } from '../../src/life/posts/module.js';
import { h, makeApi, makeFakes, pairCookie, type TestApi } from '../api/fakes.js';

const PHONE: Actor = { kind: 'device', deviceId: 'dev-phone', scopes: ['read', 'control'] };
const NOW = '2026-11-02T06:00:00.000Z'; // Monday 2 Nov, 06:00 UTC
const LINK = 'https://www.reddit.com/r/exampletools/s/AbCdEf1234';

let core: TestLifeCore | undefined;
let api: TestApi | undefined;
afterEach(async () => {
  core?.close();
  core = undefined;
  await api?.close();
  api = undefined;
});

function rig(tz = 'UTC', at = NOW): { core: TestLifeCore; posts: PostsModule } {
  core = createTestLifeCore({ tz, clock: new FakeClock(at), settings: { posts: true } });
  const ctx = createTestContext({ clock: core.clock });
  const f = makeFakes(ctx);
  return { core, posts: buildPostsModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy }) };
}

function ok<T>(r: { ok: true; value: T } | { ok: false; code: string; reason: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return r.value;
}

/** A logged comment: posted now, with its link. */
const comment = (over: Partial<PostBody> = {}): PostBody => ({ platform: 'reddit', kind: 'comment', status: 'posted', postedUrl: LINK, where: 'r/exampletools', ...over });
const log = (posts: PostsModule, over: Partial<PostBody> = {}) => ok(posts.create(comment(over), PHONE)).id;
const done = (posts: PostsModule): PostsResponse => PostsResponseSchema.parse(ok(posts.list({ done: true })));
const open = (posts: PostsModule): PostsResponse => PostsResponseSchema.parse(ok(posts.list({ done: false })));

describe('logging a comment', () => {
  it('saves it posted at the clock, with its link, text and where; the reply is the id', () => {
    const { posts, core } = rig();
    core.clock.set('2026-11-02T15:44:00.000Z');
    const r = posts.create(comment({ text: '  What I wrote.\n\nA second line.  ' }), PHONE);
    const { id } = ok(r);
    expect(ok(r)).toEqual({ id });
    expect(done(posts).posts).toEqual([
      {
        id,
        platform: 'reddit',
        kind: 'comment',
        where: 'r/exampletools',
        text: 'What I wrote.\n\nA second line.',
        status: 'posted',
        postedAt: '2026-11-02T15:44:00.000Z',
        postedUrl: LINK,
        createdAt: '2026-11-02T15:44:00.000Z',
        updatedAt: '2026-11-02T15:44:00.000Z',
      },
    ]);
    expect(open(posts).posts).toEqual([]);
    expect(core.changedCount).toBe(1);
    // Posted with no link is fine too (the API is general).
    const bare = ok(posts.create({ platform: 'x', kind: 'comment', status: 'posted' }, PHONE)).id;
    expect(done(posts).posts.find((p) => p.id === bare)).toMatchObject({ status: 'posted', postedAt: '2026-11-02T15:44:00.000Z' });
  });

  it('is history: it is accepted with 200 open posts, while an idea is still refused', () => {
    const { posts } = rig();
    for (let i = 0; i < LIFE_LIMITS.openPosts; i++) ok(posts.create({ platform: 'reddit' }, PHONE));
    expect(posts.create({ platform: 'reddit' }, PHONE)).toEqual({ ok: false, code: 'conflict', reason: POSTS_SENTENCES.full });
    expect(posts.create({ platform: 'reddit', status: 'ready' }, PHONE)).toEqual({ ok: false, code: 'conflict', reason: POSTS_SENTENCES.full });
    log(posts);
    expect(done(posts).posts).toHaveLength(1);
  });

  it('a posted link with idea or ready is the postedLink sentence, and nothing is stored', () => {
    const { posts, core } = rig();
    for (const status of [undefined, 'idea', 'ready'] as const) {
      const body: PostBody = { platform: 'reddit', kind: 'comment', postedUrl: LINK, ...(status ? { status } : {}) };
      expect(posts.create(body, PHONE), String(status)).toEqual({ ok: false, code: 'invalid_request', reason: POSTS_SENTENCES.postedLink });
    }
    expect(open(posts).posts).toEqual([]);
    expect(done(posts).posts).toEqual([]);
    expect(core.changedCount).toBe(0);
  });

  it('the same posted link twice is conflict; once the first is deleted or leaves posted, it is accepted again', () => {
    const { posts } = rig();
    const first = log(posts);
    expect(posts.create(comment({ text: 'Again' }), PHONE)).toEqual({ ok: false, code: 'conflict', reason: POSTS_SENTENCES.logged });
    expect(POSTS_SENTENCES.logged).toBe('You logged that link already.');
    expect(done(posts).posts).toHaveLength(1);
    // Another link is fine; the same one with a different query is another string.
    log(posts, { postedUrl: 'https://www.reddit.com/r/exampletools/s/ZyXwVu9876' });
    log(posts, { postedUrl: `${LINK}?utm_source=share` });
    ok(posts.remove(first, PHONE));
    const second = log(posts);
    // Not posted (back to ready) clears the posted link, so the link is free again.
    ok(posts.update(second, { status: 'ready' }, PHONE));
    const third = log(posts);
    // A link set on an edit counts as logged too.
    ok(posts.update(third, { postedUrl: 'https://www.reddit.com/r/exampletools/s/QqQqQq1111' }, PHONE));
    expect(posts.create(comment({ postedUrl: 'https://www.reddit.com/r/exampletools/s/QqQqQq1111' }), PHONE)).toMatchObject({ ok: false, code: 'conflict' });
    log(posts);
  });

  it('never rings, even with a due time', () => {
    const { posts, core } = rig();
    const id = log(posts, { due: { day: '2026-11-02', time: '21:00' } });
    expect(core.scheduler.row('post', id)).toBeUndefined();
    expect(core.scheduler.calls.filter((c) => c.op === 'set')).toEqual([]);
    expect(done(posts).posts[0]).toMatchObject({ id, due: { day: '2026-11-02', time: '21:00' } });
  });

  it('the week counts it against { reddit, comment } and { reddit }, not { reddit, post }', () => {
    const { posts } = rig();
    ok(posts.setGoals({ goals: [{ platform: 'reddit', kind: 'comment', perWeek: 35 }, { platform: 'reddit', perWeek: 6 }, { platform: 'x', kind: 'post', perWeek: 3 }] }, PHONE));
    log(posts);
    log(posts, { postedUrl: 'https://www.reddit.com/r/exampletools/comments/1abc2de/comment/kx9y8z7/' });
    const week = open(posts).week;
    expect(week.posted).toBe(2);
    expect(week.goals).toEqual([
      { platform: 'reddit', kind: 'comment', perWeek: 35, done: 2 },
      { platform: 'reddit', perWeek: 6, done: 2 },
      { platform: 'x', kind: 'post', perWeek: 3, done: 0 },
    ]);
    ok(posts.setGoals({ goals: [{ platform: 'reddit', kind: 'post', perWeek: 2 }] }, PHONE));
    expect(open(posts).week.goals).toEqual([{ platform: 'reddit', kind: 'post', perWeek: 2, done: 0 }]);
  });
});

describe("Today's comments", () => {
  it('Asia/Kolkata: one at 23:59 and one at 00:00 land in different days', () => {
    const { posts, core } = rig('Asia/Kolkata');
    core.clock.set('2026-11-02T18:29:00.000Z'); // Mon 2 Nov 23:59 IST
    log(posts);
    core.clock.set('2026-11-02T18:30:00.000Z'); // Tue 3 Nov 00:00 IST
    log(posts, { postedUrl: 'https://www.reddit.com/r/exampletools/s/ZyXwVu9876' });
    core.clock.set('2026-11-02T18:40:00.000Z'); // Tue 3 Nov 00:10 IST
    ok(posts.create({ platform: 'x', kind: 'comment', status: 'posted', postedUrl: 'https://x.com/example_user/status/1234567890123456789' }, PHONE));
    expect(posts.today('2026-11-02').posts?.comments).toEqual({ done: 1 });
    expect(posts.today('2026-11-03').posts?.comments).toEqual({ done: 2 });
    expect(posts.today('2026-11-04').posts?.comments).toEqual({ done: 0 });
  });

  it("the goal is a day's share of the comment goals, rounded up; a goal with no kind or another kind is none", () => {
    const { posts } = rig();
    log(posts);
    const goals = (g: { platform: 'reddit' | 'x'; kind?: 'comment' | 'post'; perWeek: number }[]) => {
      ok(posts.setGoals({ goals: g }, PHONE));
      return posts.today('2026-11-02').posts?.comments;
    };
    expect(goals([{ platform: 'reddit', kind: 'comment', perWeek: 35 }])).toEqual({ done: 1, goal: 5 });
    expect(goals([{ platform: 'reddit', kind: 'comment', perWeek: 20 }, { platform: 'x', kind: 'comment', perWeek: 10 }])).toEqual({ done: 1, goal: 5 });
    expect(goals([{ platform: 'reddit', kind: 'comment', perWeek: 50 }])).toEqual({ done: 1, goal: 8 });
    expect(goals([{ platform: 'reddit', kind: 'comment', perWeek: 1 }])).toEqual({ done: 1, goal: 1 });
    expect(goals([{ platform: 'reddit', perWeek: 35 }])).toEqual({ done: 1 });
    expect(goals([{ platform: 'reddit', kind: 'post', perWeek: 35 }])).toEqual({ done: 1 });
    expect(goals([])).toEqual({ done: 1 });
  });

  it('counts only comments: a logged post, an idea comment and a skipped comment do not', () => {
    const { posts } = rig();
    log(posts, { kind: 'post' });
    ok(posts.create({ platform: 'reddit', kind: 'comment' }, PHONE));
    const skipped = ok(posts.create({ platform: 'reddit', kind: 'comment' }, PHONE)).id;
    ok(posts.update(skipped, { status: 'skipped' }, PHONE));
    expect(posts.today('2026-11-02').posts?.comments).toEqual({ done: 0 });
    // A comment marked Posted with the square counts as well.
    const marked = ok(posts.create({ platform: 'reddit', kind: 'comment' }, PHONE)).id;
    ok(posts.update(marked, { status: 'posted' }, PHONE));
    expect(posts.today('2026-11-02').posts?.comments).toEqual({ done: 1 });
  });
});

describe('Done', () => {
  it(`lists the newest ${POSTS_DONE_PAGE} of ${POSTS_DONE_PAGE + 1} logged`, () => {
    const { posts, core } = rig();
    expect(POSTS_DONE_PAGE).toBe(300);
    const ids: string[] = [];
    for (let i = 0; i <= POSTS_DONE_PAGE; i++) {
      core.clock.advance(60_000);
      ids.push(log(posts, { postedUrl: `https://www.reddit.com/r/exampletools/s/Ab${String(i).padStart(6, '0')}` }));
    }
    const page = done(posts).posts;
    expect(page).toHaveLength(POSTS_DONE_PAGE);
    expect(page.map((p) => p.id)).toEqual(ids.slice(1).reverse());
  });
});

describe('the logged add through the API', () => {
  const POSTS_ON = SettingsSchema.parse({ life: { posts: true } });

  async function postsApi() {
    let built: TestLifeCore | undefined;
    api = await makeApi({
      ctx: { settings: POSTS_ON, clock: new FakeClock(NOW) },
      deps: (ctx, f) => {
        built = createTestLifeCore({ clock: ctx.clock, settings: { posts: true } });
        const posts = buildPostsModule(built, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
        return { life: notBuilt<LifeService>('Life', { start: async () => {}, stop: async () => {}, broken: () => null, posts }) };
      },
    });
    core = built;
    const { cookie } = await pairCookie(api, ['read', 'control']);
    return { api, cookie };
  }

  it("a phone's posted add answers { id }; the audit row holds the id only; the text and the link reach no event, audit or log", async () => {
    const { api, cookie } = await postsApi();
    const link = `https://www.reddit.com/r/exampletools/s/${LIFE_MARKER.replace(/-/g, '')}`;
    const res = await api.tcp.inject({ method: 'POST', url: '/v1/posts', headers: h(cookie), payload: comment({ postedUrl: link, text: `Said ${LIFE_MARKER}` }) });
    expect(res.statusCode).toBe(200);
    const { id } = res.json() as { id: string };
    expect(res.json()).toEqual({ id });
    const again = await api.tcp.inject({ method: 'POST', url: '/v1/posts', headers: h(cookie), payload: comment({ postedUrl: link }) });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toEqual({ code: 'conflict', message: POSTS_SENTENCES.logged });
    const list = PostsResponseSchema.parse((await api.tcp.inject({ method: 'GET', url: '/v1/posts?done=1', headers: h(cookie) })).json());
    expect(list.posts.map((p) => [p.id, p.kind, p.status, p.postedUrl])).toEqual([[id, 'comment', 'posted', link]]);
    const audit = api.ctx.db.audit.list().filter((a) => a.action === 'postCreate');
    expect(audit[0]?.target).toBe(id);
    for (const a of audit) {
      expect([id, undefined]).toContain(a.target ?? undefined);
      expect(a.params).toEqual({});
    }
    const r = api.ctx.store.replay(0);
    const marker = LIFE_MARKER.replace(/-/g, '');
    const seen = JSON.stringify([r.kind === 'events' ? r.events : [], api.ctx.db.audit.list(), api.ctx.log.records, res.json(), again.json()]);
    expect(seen).not.toContain(LIFE_MARKER);
    expect(seen).not.toContain(marker);
  });

  it('a ctl.sock posted add counts against the 30 an hour: the 31st is 429', async () => {
    const { api } = await postsApi();
    for (let i = 0; i < V07_LIMITS.postCtl.limit; i++) {
      const res = await api.ctl.inject({ method: 'POST', url: '/v1/posts', payload: comment({ postedUrl: `https://www.reddit.com/r/exampletools/s/Ab${String(i).padStart(6, '0')}` }) });
      expect(res.statusCode, `log ${i + 1}`).toBe(200);
    }
    const over = await api.ctl.inject({ method: 'POST', url: '/v1/posts', payload: comment({ postedUrl: 'https://www.reddit.com/r/exampletools/s/ZyXwVu9876' }) });
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toEqual({ code: 'rate_limited', message: POSTS_CTL_LIMITED });
  });
});
