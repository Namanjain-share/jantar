/**
 * Posts (v0.7, life/posts), on createTestLifeCore (in-memory life.db,
 * FakeClock, recording scheduler), and their routes through the API:
 *
 * - CRUD: defaults (kind post, status idea), empty text and notes left out,
 *   null clears, ids-only replies;
 * - the cap: 200 open (idea and ready); posted and skipped ones don't count,
 *   and back to the list from posted holds it;
 * - status rules: postedAt stamped once on the way into posted, cleared with
 *   the posted link on the way out; a posted link only while posted;
 * - the open list sorts as todos do; the done list is the newest 100;
 * - the week: its Monday for each weekday, across a month and a year end;
 *   counts across Sunday 23:59 to Monday 00:00 in Asia/Kolkata and in
 *   America/New_York (the week the clocks go back); goals with and without
 *   a kind; goals in meta, a bad meta value reading as none;
 * - a row that fails its schema is left out and counted;
 * - Today's part { today, late };
 * - routes: ids-only replies, audit rows with the target id only, no post
 *   text in events, audit or logs; ctl.sock lists and adds, at most 30 adds
 *   an hour, while a device's add is still accepted.
 * Synthetic values only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LIFE_MARKER, postBody } from '@jantar/fixtures';
import { LIFE_LIMITS, POSTS_DONE_PAGE, PostsResponseSchema, SettingsSchema, type Post, type PostBody, type PostsResponse } from '@jantar/protocol';
import type { Actor, LifeService, PostsModule } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { createTestContext, createTestLifeCore, type TestContext, type TestLifeCore } from '../../src/core/testing.js';
import { POSTS_CTL_LIMITED } from '../../src/api/routes/posts.js';
import { V07_LIMITS } from '../../src/api/services.js';
import { POSTS_SENTENCES, buildPostsModule, weekOf } from '../../src/life/posts/module.js';
import { POST_GOALS_KEY } from '../../src/life/posts/repo.js';
import { h, makeApi, makeFakes, pairCookie, type TestApi } from '../api/fakes.js';

const PHONE: Actor = { kind: 'device', deviceId: 'dev-phone', scopes: ['read', 'control'] };
const NOW = '2026-11-02T06:00:00.000Z'; // Monday 2 Nov, 06:00 UTC
const GHOST = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';

let core: TestLifeCore | undefined;
let api: TestApi | undefined;
afterEach(async () => {
  core?.close();
  core = undefined;
  await api?.close();
  api = undefined;
});

function rig(tz = 'UTC', at = NOW): { core: TestLifeCore; posts: PostsModule; ctx: TestContext } {
  core = createTestLifeCore({ tz, clock: new FakeClock(at), settings: { posts: true } });
  const ctx = createTestContext({ clock: core.clock });
  const f = makeFakes(ctx);
  return { core, ctx, posts: buildPostsModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy }) };
}

function ok<T>(r: { ok: true; value: T } | { ok: false; code: string; reason: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return r.value;
}

const add = (posts: PostsModule, over: Partial<PostBody> = {}) => ok(posts.create(postBody(over), PHONE)).id;
const open = (posts: PostsModule): PostsResponse => PostsResponseSchema.parse(ok(posts.list({ done: false })));
const done = (posts: PostsModule): PostsResponse => PostsResponseSchema.parse(ok(posts.list({ done: true })));
const find = (posts: PostsModule, id: string): Post => {
  const p = [...open(posts).posts, ...done(posts).posts].find((x) => x.id === id);
  if (!p) throw new Error(`no post ${id}`);
  return p;
};

describe('posts', () => {
  it('adds a post with its fields; kind defaults to post and status to idea; the reply is the id', () => {
    const { posts, core } = rig();
    const r = posts.create(postBody({}, { timed: { day: '2026-11-02', time: '19:30' } }), PHONE);
    const { id } = ok(r);
    expect(ok(r)).toEqual({ id });
    expect(find(posts, id)).toEqual({
      id,
      platform: 'reddit',
      kind: 'post',
      where: 'r/exampletools',
      title: 'Typing into Terminal from a phone',
      text: 'Synthetic post text.\n\nA second paragraph.',
      notes: 'Synthetic notes: flair Example, attach one screenshot',
      link: 'https://www.example.com/submit',
      due: { day: '2026-11-02', time: '19:30' },
      status: 'idea',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const bare = ok(posts.create({ platform: 'instagram' }, PHONE)).id;
    expect(find(posts, bare)).toEqual({ id: bare, platform: 'instagram', kind: 'post', status: 'idea', createdAt: NOW, updatedAt: NOW });
    expect(core.changedCount).toBe(2);
  });

  it('leaves empty text and notes out (only spaces), and keeps newlines inside the text', () => {
    const { posts } = rig();
    const id = ok(posts.create({ platform: 'x', kind: 'thread', text: '  \n ', notes: '   ', where: ' ', title: '  ' }, PHONE)).id;
    const p = find(posts, id);
    for (const k of ['text', 'notes', 'where', 'title'] as const) expect(p[k], k).toBeUndefined();
    ok(posts.update(id, { text: '  one\ntwo  ', notes: 'flair\nExample' }, PHONE));
    expect(find(posts, id)).toMatchObject({ text: 'one\ntwo', notes: 'flair\nExample' });
    ok(posts.update(id, { notes: '  ' }, PHONE));
    expect(find(posts, id).notes).toBeUndefined();
  });

  it('a PATCH changes fields; null clears where, title, text, notes, link and due; an unknown post is not_found', () => {
    const { posts } = rig();
    const id = add(posts, { due: { day: '2026-11-03', time: '19:30' } });
    ok(posts.update(id, { platform: 'instagram', kind: 'reel', where: '@example.studio', status: 'ready' }, PHONE));
    expect(find(posts, id)).toMatchObject({ platform: 'instagram', kind: 'reel', where: '@example.studio', status: 'ready' });
    ok(posts.update(id, { where: null, title: null, text: null, notes: null, link: null, due: null }, PHONE));
    const p = find(posts, id);
    for (const k of ['where', 'title', 'text', 'notes', 'link', 'due'] as const) expect(p[k], k).toBeUndefined();
    expect(posts.update(GHOST, { status: 'ready' }, PHONE)).toEqual({ ok: false, code: 'not_found', reason: POSTS_SENTENCES.none });
    expect(posts.remove(GHOST, PHONE)).toEqual({ ok: false, code: 'not_found', reason: POSTS_SENTENCES.none });
    ok(posts.remove(id, PHONE));
    expect(open(posts).posts).toEqual([]);
  });

  it('a due day that does not exist (31 Nov, 29 Feb 2027) is refused on create and on edit, and nothing is stored', () => {
    const { posts } = rig();
    for (const day of ['2026-11-31', '2027-02-29']) {
      expect(posts.create({ platform: 'reddit', due: { day, time: '19:30' } }, PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: POSTS_SENTENCES.noDay });
    }
    expect(open(posts).posts).toEqual([]);
    const id = add(posts, { due: { day: '2026-11-30', time: '19:30' } });
    expect(posts.update(id, { due: { day: '2026-11-31', time: '19:30' } }, PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: POSTS_SENTENCES.noDay });
    expect(find(posts, id).due).toEqual({ day: '2026-11-30', time: '19:30' });
    // A leap day that exists is fine.
    ok(posts.update(id, { due: { day: '2028-02-29' } }, PHONE));
    expect(POSTS_SENTENCES.noDay).toBe('That date does not exist.');
  });

  it('status rules: postedAt stamped once into posted, cleared with the posted link out of it; a posted link only while posted', () => {
    const { posts, core } = rig();
    const id = add(posts);
    expect(posts.update(id, { postedUrl: 'https://www.example.com/r/exampletools/1' }, PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: POSTS_SENTENCES.postedLink });
    core.clock.set('2026-11-02T14:11:00.000Z');
    ok(posts.update(id, { status: 'posted' }, PHONE));
    expect(find(posts, id)).toMatchObject({ status: 'posted', postedAt: '2026-11-02T14:11:00.000Z' });
    core.clock.set('2026-11-02T14:20:00.000Z');
    // Already posted: the time stays; the link may follow.
    ok(posts.update(id, { status: 'posted', postedUrl: 'https://www.example.com/r/exampletools/1' }, PHONE));
    expect(find(posts, id)).toMatchObject({ postedAt: '2026-11-02T14:11:00.000Z', postedUrl: 'https://www.example.com/r/exampletools/1' });
    ok(posts.update(id, { postedUrl: null }, PHONE));
    expect(find(posts, id).postedUrl).toBeUndefined();
    ok(posts.update(id, { postedUrl: 'https://www.example.com/r/exampletools/1' }, PHONE));
    // Not posted: back to ready, both cleared.
    ok(posts.update(id, { status: 'ready' }, PHONE));
    const back = find(posts, id);
    expect(back.status).toBe('ready');
    expect(back.postedAt).toBeUndefined();
    expect(back.postedUrl).toBeUndefined();
    // Out of posted with a link in the same PATCH is refused.
    ok(posts.update(id, { status: 'posted' }, PHONE));
    expect(posts.update(id, { status: 'skipped', postedUrl: 'https://www.example.com/x' }, PHONE)).toMatchObject({ ok: false, code: 'invalid_request' });
    // Skipped to posted stamps the time again.
    ok(posts.update(id, { status: 'skipped' }, PHONE));
    expect(find(posts, id).postedAt).toBeUndefined();
    core.clock.set('2026-11-02T15:00:00.000Z');
    ok(posts.update(id, { status: 'posted' }, PHONE));
    expect(find(posts, id).postedAt).toBe('2026-11-02T15:00:00.000Z');
  });

  it('the cap: 200 open posts; posted and skipped ones do not count; back to the list from posted holds it', () => {
    const { posts } = rig();
    const ids: string[] = [];
    for (let i = 0; i < LIFE_LIMITS.openPosts; i++) ids.push(ok(posts.create({ platform: 'reddit' }, PHONE)).id);
    expect(posts.create({ platform: 'reddit' }, PHONE)).toEqual({ ok: false, code: 'conflict', reason: POSTS_SENTENCES.full });
    expect(POSTS_SENTENCES.full).toBe('You have 200 posts to make. Post, skip or delete one to add another.');
    ok(posts.update(ids[0] as string, { status: 'posted' }, PHONE));
    ok(posts.update(ids[1] as string, { status: 'skipped' }, PHONE));
    ok(posts.create({ platform: 'reddit' }, PHONE));
    ok(posts.create({ platform: 'reddit' }, PHONE));
    expect(posts.create({ platform: 'reddit' }, PHONE)).toMatchObject({ ok: false, code: 'conflict' });
    expect(posts.update(ids[0] as string, { status: 'ready' }, PHONE)).toEqual({ ok: false, code: 'conflict', reason: POSTS_SENTENCES.full });
    expect(open(posts).posts).toHaveLength(LIFE_LIMITS.openPosts);
  });

  it('the open list sorts by day, then time (untimed after timed), undated last, then createdAt; done is the newest 100', () => {
    const { posts, core } = rig();
    const undated = add(posts);
    core.clock.advance(1000);
    const allDay = add(posts, { due: { day: '2026-11-02' } });
    const late = add(posts, { due: { day: '2026-11-02', time: '19:30' } });
    const early = add(posts, { due: { day: '2026-11-02', time: '08:00' } });
    const tomorrow = add(posts, { due: { day: '2026-11-03', time: '07:00' } });
    const yesterday = add(posts, { due: { day: '2026-11-01' } });
    expect(open(posts).posts.map((p) => p.id)).toEqual([yesterday, early, late, allDay, tomorrow, undated]);

    const doneIds: string[] = [];
    for (let i = 0; i < POSTS_DONE_PAGE + 5; i++) {
      core.clock.advance(60_000);
      const id = ok(posts.create({ platform: 'x' }, PHONE)).id;
      ok(posts.update(id, { status: i % 2 ? 'posted' : 'skipped' }, PHONE));
      doneIds.push(id);
    }
    const page = done(posts).posts;
    expect(page).toHaveLength(POSTS_DONE_PAGE);
    expect(page.map((p) => p.id)).toEqual(doneIds.slice(-POSTS_DONE_PAGE).reverse());
    expect(open(posts).posts).toHaveLength(6);
  });

  it('a row that fails its schema is left out and counted in the log, without its content', () => {
    const { posts, core, ctx } = rig();
    const id = add(posts);
    core.db.prepare("INSERT INTO posts (id, status, due_day, posted_at, updated_at, json) VALUES ('bad1', 'idea', NULL, NULL, ?, ?)").run(NOW, `{"id":"bad1","platform":"myspace","text":"${LIFE_MARKER}"}`);
    core.db.prepare("INSERT INTO posts (id, status, due_day, posted_at, updated_at, json) VALUES ('bad2', 'idea', NULL, NULL, ?, 'not json')").run(NOW);
    expect(open(posts).posts.map((p) => p.id)).toEqual([id]);
    const warn = ctx.log.records.find((r) => r.msg === 'life rows left out: they no longer parse');
    expect(warn?.fields).toMatchObject({ table: 'posts', rows: 2 });
    expect(JSON.stringify(ctx.log.records)).not.toContain(LIFE_MARKER);
  });

  it("Today's part: open posts due today, and due before today; posted, undated and later ones not", () => {
    const { posts } = rig();
    add(posts, { due: { day: '2026-11-02', time: '19:30' } });
    add(posts, { due: { day: '2026-11-02' } });
    add(posts, { due: { day: '2026-10-31', time: '19:30' } });
    add(posts, { due: { day: '2026-11-03', time: '19:30' } });
    add(posts);
    const posted = add(posts, { due: { day: '2026-11-02', time: '08:00' } });
    ok(posts.update(posted, { status: 'posted' }, PHONE));
    expect(posts.today('2026-11-02')).toEqual({ posts: { today: 2, late: 1 } });
    expect(posts.today('2026-11-03')).toEqual({ posts: { today: 1, late: 3 } });
  });
});

describe('the week and the goals', () => {
  it("the week's Monday for each weekday, across a month end and a year end", () => {
    for (let i = 0; i < 7; i++) {
      const day = `2026-11-0${2 + i}`;
      expect(weekOf(day), day).toEqual({ from: '2026-11-02', to: '2026-11-08' });
    }
    expect(weekOf('2026-11-01')).toEqual({ from: '2026-10-26', to: '2026-11-01' });
    expect(weekOf('2026-10-26')).toEqual({ from: '2026-10-26', to: '2026-11-01' });
    for (const day of ['2026-12-28', '2026-12-31', '2027-01-01', '2027-01-03']) expect(weekOf(day), day).toEqual({ from: '2026-12-28', to: '2027-01-03' });
    expect(weekOf('2027-01-04')).toEqual({ from: '2027-01-04', to: '2027-01-10' });
  });

  /** Mark a new post posted at `iso`. */
  function postedAt(c: TestLifeCore, posts: PostsModule, iso: string, over: Partial<PostBody> = {}): string {
    c.clock.set(iso);
    const id = ok(posts.create({ platform: 'reddit', ...over }, PHONE)).id;
    ok(posts.update(id, { status: 'posted' }, PHONE));
    return id;
  }

  it('Asia/Kolkata: a post at Sunday 23:59 counts in its week; at Monday 00:00 the new week starts at 0 and counts its own', () => {
    const { posts, core } = rig('Asia/Kolkata', '2026-11-02T06:00:00.000Z');
    postedAt(core, posts, '2026-11-08T18:29:00.000Z'); // Sun 8 Nov 23:59 IST
    let week = open(posts).week;
    expect(week).toMatchObject({ from: '2026-11-02', to: '2026-11-08', posted: 1 });
    postedAt(core, posts, '2026-11-08T18:30:00.000Z'); // Mon 9 Nov 00:00 IST
    week = open(posts).week;
    expect(week).toMatchObject({ from: '2026-11-09', to: '2026-11-15', posted: 1 });
    expect(open(posts).today).toBe('2026-11-09');
  });

  it('America/New_York, the week the clocks go back: Monday 26 Oct 00:00 EDT to Monday 2 Nov 00:00 EST', () => {
    const { posts, core } = rig('America/New_York', '2026-10-25T16:00:00.000Z');
    postedAt(core, posts, '2026-10-26T03:59:00.000Z'); // Sun 25 Oct 23:59 EDT: the week before
    postedAt(core, posts, '2026-10-26T04:00:00.000Z'); // Mon 26 Oct 00:00 EDT
    postedAt(core, posts, '2026-11-02T04:59:00.000Z'); // Sun 1 Nov 23:59 EST
    expect(open(posts).week).toMatchObject({ from: '2026-10-26', to: '2026-11-01', posted: 2 });
    core.clock.set('2026-11-02T05:00:00.000Z'); // Mon 2 Nov 00:00 EST
    expect(open(posts).week).toMatchObject({ from: '2026-11-02', to: '2026-11-08', posted: 0 });
    postedAt(core, posts, '2026-11-02T05:00:00.000Z');
    expect(open(posts).week.posted).toBe(1);
  });

  it('a goal counts its platform, and its kind when it has one; skipped posts never count', () => {
    const { posts, core } = rig();
    ok(posts.setGoals({ goals: [{ platform: 'instagram', kind: 'reel', perWeek: 3 }, { platform: 'reddit', perWeek: 6 }] }, PHONE));
    postedAt(core, posts, '2026-11-02T07:00:00.000Z', { platform: 'instagram', kind: 'reel' });
    postedAt(core, posts, '2026-11-02T07:01:00.000Z', { platform: 'instagram', kind: 'story' });
    postedAt(core, posts, '2026-11-02T07:02:00.000Z', { platform: 'reddit', kind: 'post' });
    postedAt(core, posts, '2026-11-02T07:03:00.000Z', { platform: 'reddit', kind: 'comment' });
    const skipped = ok(posts.create({ platform: 'reddit' }, PHONE)).id;
    ok(posts.update(skipped, { status: 'skipped' }, PHONE));
    const week = open(posts).week;
    expect(week.posted).toBe(4);
    expect(week.goals).toEqual([
      { platform: 'instagram', kind: 'reel', perWeek: 3, done: 1 },
      { platform: 'reddit', perWeek: 6, done: 2 },
    ]);
  });

  it('goals live in meta; [] removes the key; a bad value reads as none and is logged by key only', () => {
    const { posts, core, ctx } = rig();
    ok(posts.setGoals({ goals: [{ platform: 'x', perWeek: 5 }] }, PHONE));
    expect(JSON.parse(core.db.meta(POST_GOALS_KEY) ?? 'null')).toEqual([{ platform: 'x', perWeek: 5 }]);
    ok(posts.setGoals({ goals: [] }, PHONE));
    expect(core.db.meta(POST_GOALS_KEY)).toBeUndefined();
    expect(open(posts).week.goals).toEqual([]);
    core.db.setMeta(POST_GOALS_KEY, `[{"platform":"myspace","perWeek":1,"note":"${LIFE_MARKER}"}]`);
    expect(open(posts).week.goals).toEqual([]);
    core.db.setMeta(POST_GOALS_KEY, '{oops');
    expect(open(posts).week.goals).toEqual([]);
    const warns = ctx.log.records.filter((r) => r.msg === 'life meta value left out: it does not parse');
    expect(warns).toHaveLength(2);
    expect(warns[0]?.fields).toMatchObject({ key: POST_GOALS_KEY });
    expect(JSON.stringify(ctx.log.records)).not.toContain(LIFE_MARKER);
    // A duplicate platform and kind is refused by the module too.
    expect(posts.setGoals({ goals: [{ platform: 'x', perWeek: 1 }, { platform: 'x', perWeek: 2 }] }, PHONE)).toMatchObject({ ok: false, code: 'invalid_request' });
  });
});

describe('posts routes', () => {
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

  it('write replies are ids or ok; audit rows hold the target id; no post text in events, audit, logs or write replies', async () => {
    const { api, cookie } = await postsApi();
    const add = await api.tcp.inject({ method: 'POST', url: '/v1/posts', headers: h(cookie), payload: postBody({}, { marked: true, timed: { day: '2026-11-02', time: '19:30' } }) });
    expect(add.statusCode).toBe(200);
    const { id } = add.json() as { id: string };
    expect(add.json()).toEqual({ id });
    const patch = await api.tcp.inject({ method: 'PATCH', url: `/v1/posts/${id}`, headers: h(cookie), payload: { notes: `more ${LIFE_MARKER}`, status: 'posted' } });
    expect(patch.json()).toEqual({ ok: true });
    const link = await api.tcp.inject({ method: 'PATCH', url: `/v1/posts/${id}`, headers: h(cookie), payload: { postedUrl: `https://www.example.com/p/${LIFE_MARKER}` } });
    expect(link.json()).toEqual({ ok: true });
    const goals = await api.tcp.inject({ method: 'PUT', url: '/v1/posts/goals', headers: h(cookie), payload: { goals: [{ platform: 'reddit', perWeek: 6 }] } });
    expect(goals.json()).toEqual({ ok: true });
    const list = PostsResponseSchema.parse((await api.tcp.inject({ method: 'GET', url: '/v1/posts?done=1', headers: h(cookie) })).json());
    expect(list.posts.map((p) => p.id)).toEqual([id]);
    expect(list.week.goals).toEqual([{ platform: 'reddit', perWeek: 6, done: 1 }]);
    const del = await api.tcp.inject({ method: 'DELETE', url: `/v1/posts/${id}`, headers: h(cookie) });
    expect(del.json()).toEqual({ ok: true });
    const audit = api.ctx.db.audit.list().filter((a) => a.action.startsWith('post'));
    expect(audit.map((a) => [a.action, a.target ?? null])).toEqual([
      ['postCreate', id],
      ['postUpdate', id],
      ['postUpdate', id],
      ['postGoalsSet', null],
      ['postDelete', id],
    ]);
    for (const a of audit) expect(a.params).toEqual({});
    const r = api.ctx.store.replay(0);
    expect(JSON.stringify([r.kind === 'events' ? r.events : [], api.ctx.db.audit.list(), api.ctx.log.records, add.json(), patch.json()])).not.toContain(LIFE_MARKER);
  });

  it('a posted link before posted is 400 with the sentence; links are https only; an unknown post 404', async () => {
    const { api, cookie } = await postsApi();
    const { id } = (await api.tcp.inject({ method: 'POST', url: '/v1/posts', headers: h(cookie), payload: postBody() })).json() as { id: string };
    const early = await api.tcp.inject({ method: 'PATCH', url: `/v1/posts/${id}`, headers: h(cookie), payload: { postedUrl: 'https://www.example.com/p/1' } });
    expect(early.statusCode).toBe(400);
    expect(early.json().error).toEqual({ code: 'invalid_request', message: POSTS_SENTENCES.postedLink });
    for (const link of ['http://www.example.com/submit', 'javascript:alert(1)', 'reddit://submit']) {
      const res = await api.tcp.inject({ method: 'POST', url: '/v1/posts', headers: h(cookie), payload: postBody({ link }) });
      expect(res.statusCode, link).toBe(400);
    }
    const ghost = await api.tcp.inject({ method: 'PATCH', url: `/v1/posts/${GHOST}`, headers: h(cookie), payload: { status: 'ready' } });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().error).toEqual({ code: 'not_found', message: POSTS_SENTENCES.none });
  });

  it('ctl.sock lists and adds; the 31st add there in an hour is 429 with the sentence while a device still adds; an hour later it adds again', async () => {
    const { api, cookie } = await postsApi();
    expect(V07_LIMITS.postCtl.limit).toBe(30);
    for (let i = 0; i < V07_LIMITS.postCtl.limit; i++) {
      const res = await api.ctl.inject({ method: 'POST', url: '/v1/posts', payload: { platform: 'reddit', where: 'r/exampletools' } });
      expect(res.statusCode, `add ${i + 1}`).toBe(200);
    }
    const over = await api.ctl.inject({ method: 'POST', url: '/v1/posts', payload: { platform: 'reddit' } });
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toEqual({ code: 'rate_limited', message: POSTS_CTL_LIMITED });
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect(POSTS_CTL_LIMITED).toBe('Scripts and Claude sessions added 30 posts this hour. Add more on the phone, or try again later.');
    const phone = await api.tcp.inject({ method: 'POST', url: '/v1/posts', headers: h(cookie), payload: { platform: 'instagram', kind: 'reel' } });
    expect(phone.statusCode).toBe(200);
    const list = await api.ctl.inject({ method: 'GET', url: '/v1/posts' });
    expect(PostsResponseSchema.parse(list.json()).posts).toHaveLength(V07_LIMITS.postCtl.limit + 1);
    api.ctx.clock.advance(V07_LIMITS.postCtl.windowMs);
    expect((await api.ctl.inject({ method: 'POST', url: '/v1/posts', payload: { platform: 'reddit' } })).statusCode).toBe(200);
  });
});
