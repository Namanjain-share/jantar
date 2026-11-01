/**
 * v0.7 Posts, the protocol's part: five routes at control scope behind the
 * `posts` switch, only the list and an add on ctl.sock (as approved: `jantar
 * post list` and `jantar post add`), none Mac-only; strict bodies; https
 * links only; where and title one line; the text, notes and goal limits;
 * posts last among the Life modules; the goal labels. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import {
  IdReplySchema,
  LIFE_LIMITS,
  LIFE_MODULES,
  OkReplySchema,
  POST_KINDS,
  POST_KIND_LABEL,
  POST_PLATFORMS,
  POST_PLATFORM_LABEL,
  PostBodySchema,
  PostGoalsBodySchema,
  PostPatchSchema,
  PostSchema,
  PostsQuerySchema,
  PostsResponseSchema,
  ROUTES,
  SettingsSchema,
  TodaySchema,
  postGoalLabel,
  postGoalLabels,
  settingsFeatures,
  type RouteDef,
  type RouteName,
} from '../src/index.js';

const routes = Object.entries(ROUTES) as [RouteName, RouteDef][];
const v07 = routes.filter(([, r]) => r.phase === 'v0.7');
const ID = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const STAMP = '2026-11-02T14:00:00.000Z';

describe('v0.7 posts routes', () => {
  it('are five, at control scope behind posts, none Mac-only', () => {
    expect(v07.map(([n]) => n).sort()).toEqual(['postCreate', 'postDelete', 'postGoalsSet', 'postUpdate', 'postsList']);
    for (const [name, r] of v07) {
      expect(r.scope, name).toBe('control');
      expect(r.feature, name).toBe('posts');
      expect(r.localOnly, name).toBeUndefined();
      expect(r.path.startsWith('/v1/posts'), name).toBe(true);
      expect(r.summary.length, name).toBeGreaterThan(5);
      if (r.method === 'GET') expect(r.body, name).toBeUndefined();
    }
    expect(ROUTES.postGoalsSet).toMatchObject({ method: 'PUT', path: '/v1/posts/goals' });
    expect(ROUTES.postUpdate).toMatchObject({ method: 'PATCH', path: '/v1/posts/:id' });
  });

  it('only the list and an add are on ctl.sock', () => {
    expect(v07.filter(([, r]) => r.ctl).map(([n]) => n).sort()).toEqual(['postCreate', 'postsList']);
  });

  it('write replies carry ids or ok only', () => {
    expect(ROUTES.postCreate.response).toBe(IdReplySchema);
    for (const name of ['postUpdate', 'postDelete', 'postGoalsSet'] as const) expect(ROUTES[name].response, name).toBe(OkReplySchema);
  });

  it('bodies are strict', () => {
    expect(PostBodySchema.safeParse({ platform: 'reddit', posted: true }).success).toBe(false);
    expect(PostPatchSchema.safeParse({ postedAt: STAMP }).success).toBe(false);
    expect(PostGoalsBodySchema.safeParse({ goals: [], extra: 1 }).success).toBe(false);
    expect(PostGoalsBodySchema.safeParse({ goals: [{ platform: 'reddit', perWeek: 2, label: 'x' }] }).success).toBe(false);
  });
});

describe('a post body', () => {
  const ok = (over: Record<string, unknown>) => PostBodySchema.safeParse({ platform: 'reddit', ...over }).success;

  it('needs a known platform; kind, status and the rest are optional', () => {
    expect(ok({})).toBe(true);
    expect(PostBodySchema.safeParse({}).success).toBe(false);
    expect(ok({ platform: 'myspace' })).toBe(false);
    expect(ok({ kind: 'reel' })).toBe(true);
    expect(ok({ kind: 'carousel' })).toBe(false);
    for (const p of POST_PLATFORMS) expect(ok({ platform: p }), p).toBe(true);
    for (const k of POST_KINDS) expect(ok({ kind: k }), k).toBe(true);
  });

  it('is an idea or ready, never posted or skipped', () => {
    expect(ok({ status: 'idea' })).toBe(true);
    expect(ok({ status: 'ready' })).toBe(true);
    expect(ok({ status: 'posted' })).toBe(false);
    expect(ok({ status: 'skipped' })).toBe(false);
  });

  it('takes https links only, for where to post and the posted link', () => {
    expect(ok({ link: 'https://www.example.com/submit' })).toBe(true);
    for (const bad of ['http://www.example.com/submit', 'reddit://submit', 'javascript:alert(1)', 'www.example.com/submit']) {
      expect(ok({ link: bad }), bad).toBe(false);
      expect(PostPatchSchema.safeParse({ postedUrl: bad }).success, bad).toBe(false);
    }
    expect(ok({ link: `https://www.example.com/${'a'.repeat(2_000)}` })).toBe(false);
    expect(PostPatchSchema.safeParse({ postedUrl: 'https://www.example.com/r/exampletools/1' }).success).toBe(true);
    expect(PostPatchSchema.safeParse({ postedUrl: null, link: null }).success).toBe(true);
  });

  it('holds a text of up to 20,000 characters and notes of up to 2,000, newlines kept', () => {
    expect(ok({ text: 'a'.repeat(20_000) })).toBe(true);
    expect(ok({ text: 'a'.repeat(20_001) })).toBe(false);
    expect(ok({ notes: 'n'.repeat(2_000) })).toBe(true);
    expect(ok({ notes: 'n'.repeat(2_001) })).toBe(false);
    const parsed = PostBodySchema.parse({ platform: 'reddit', text: '  First line\n\nSecond line \n' });
    expect(parsed.text).toBe('First line\n\nSecond line');
    expect(ok({ text: '   ' })).toBe(false);
  });

  it('keeps where and title on one line, with no control or bidi characters', () => {
    expect(ok({ where: 'r/exampletools · weekly thread', title: 'Typing into Terminal from a phone' })).toBe(true);
    expect(ok({ where: 'w'.repeat(80) })).toBe(true);
    expect(ok({ where: 'w'.repeat(81) })).toBe(false);
    expect(ok({ title: 't'.repeat(300) })).toBe(true);
    expect(ok({ title: 't'.repeat(301) })).toBe(false);
    for (const bad of ['r/example\ntools', 'r/example\u0007tools', 'r/example‮tools', 'r/example⁦tools', 'r/example\u0085tools']) {
      expect(ok({ where: bad }), JSON.stringify(bad)).toBe(false);
      expect(ok({ title: bad }), JSON.stringify(bad)).toBe(false);
      expect(PostPatchSchema.safeParse({ where: bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(ok({ where: '   ' })).toBe(false);
  });

  it('takes a day with an optional time, as a todo does', () => {
    expect(ok({ due: { day: '2026-11-02', time: '19:30' } })).toBe(true);
    expect(ok({ due: { day: '2026-11-02' } })).toBe(true);
    expect(ok({ due: { day: '2026-11-02', time: '7pm' } })).toBe(false);
  });

  it('a patch may move to any status and clear a field with null', () => {
    for (const status of ['idea', 'ready', 'posted', 'skipped']) expect(PostPatchSchema.safeParse({ status }).success, status).toBe(true);
    expect(PostPatchSchema.safeParse({ where: null, title: null, text: null, notes: null, due: null }).success).toBe(true);
    expect(PostPatchSchema.safeParse({ platform: null }).success).toBe(false);
  });
});

describe('weekly goals', () => {
  const goals = (g: unknown[]) => PostGoalsBodySchema.safeParse({ goals: g }).success;

  it('takes up to ten, one per platform and kind, 1 to 50 a week', () => {
    expect(goals([])).toBe(true);
    expect(goals([{ platform: 'instagram', kind: 'reel', perWeek: 3 }, { platform: 'reddit', perWeek: 6 }])).toBe(true);
    // The same platform with and without a kind are two goals.
    expect(goals([{ platform: 'reddit', perWeek: 6 }, { platform: 'reddit', kind: 'comment', perWeek: 2 }])).toBe(true);
    expect(goals([{ platform: 'reddit', perWeek: 6 }, { platform: 'reddit', perWeek: 2 }])).toBe(false);
    expect(goals([{ platform: 'instagram', kind: 'reel', perWeek: 3 }, { platform: 'instagram', kind: 'reel', perWeek: 1 }])).toBe(false);
    expect(goals([{ platform: 'reddit', perWeek: 0 }])).toBe(false);
    expect(goals([{ platform: 'reddit', perWeek: 51 }])).toBe(false);
    expect(goals([{ platform: 'reddit', perWeek: 50 }])).toBe(true);
    expect(goals([{ platform: 'reddit', perWeek: 1.5 }])).toBe(false);
    // Eight kinds on X, then Reddit and Hacker News: ten. An eleventh is refused.
    const ten = [...POST_KINDS.map((kind) => ({ platform: 'x', kind, perWeek: 1 })), { platform: 'reddit', perWeek: 1 }, { platform: 'hn', perWeek: 1 }];
    expect(ten).toHaveLength(10);
    expect(goals(ten)).toBe(true);
    expect(goals([...ten, { platform: 'facebook', perWeek: 1 }])).toBe(false);
  });

  it('are named by the kind, else the platform', () => {
    expect(postGoalLabel({ platform: 'instagram', kind: 'reel' })).toBe('Reels');
    expect(postGoalLabel({ platform: 'reddit' })).toBe('Reddit');
    expect(postGoalLabel({ platform: 'hn' })).toBe('Hacker News');
    expect(postGoalLabel({ platform: 'reddit', kind: 'story' })).toBe('Stories');
  });

  it('name the platform too, in a list where two would read the same', () => {
    expect(postGoalLabels([{ platform: 'instagram', kind: 'reel' }, { platform: 'reddit' }])).toEqual(['Reels', 'Reddit']);
    expect(postGoalLabels([{ platform: 'x', kind: 'thread' }, { platform: 'threads' }])).toEqual(['X threads', 'Threads']);
    expect(postGoalLabels([{ platform: 'instagram', kind: 'reel' }, { platform: 'facebook', kind: 'reel' }, { platform: 'youtube', kind: 'short' }])).toEqual([
      'Instagram reels',
      'Facebook reels',
      'Shorts',
    ]);
    expect(postGoalLabels([])).toEqual([]);
  });
});

describe('the list, Today and the switch', () => {
  it('reads ?done=0|1, open by default', () => {
    expect(PostsQuerySchema.parse({})).toEqual({ done: false });
    expect(PostsQuerySchema.parse({ done: '1' })).toEqual({ done: true });
    expect(PostsQuerySchema.safeParse({ done: 'yes' }).success).toBe(false);
  });

  it('answers the week and the posts', () => {
    const post = { id: ID, platform: 'reddit', kind: 'post', where: 'r/exampletools', status: 'posted', postedAt: STAMP, createdAt: STAMP, updatedAt: STAMP };
    expect(PostSchema.safeParse(post).success).toBe(true);
    const reply = {
      today: '2026-11-02',
      week: { from: '2026-11-02', to: '2026-11-08', posted: 1, goals: [{ platform: 'reddit', perWeek: 6, done: 1 }] },
      posts: [post],
    };
    expect(PostsResponseSchema.safeParse(reply).success).toBe(true);
  });

  it("Today's posts part is two counts", () => {
    expect(TodaySchema.safeParse({ day: '2026-11-02', posts: { today: 2, late: 1 } }).success).toBe(true);
    expect(TodaySchema.safeParse({ day: '2026-11-02', posts: { today: -1, late: 0 } }).success).toBe(false);
  });

  it('posts are the sixth Life module, last, off by default, and turn Life on', () => {
    expect(LIFE_MODULES.at(-1)).toBe('posts');
    expect(LIFE_MODULES).toHaveLength(6);
    expect(SettingsSchema.parse({}).life.posts).toBe(false);
    expect(settingsFeatures(SettingsSchema.parse({ life: { posts: true } })).life).toBe(true);
    expect(LIFE_LIMITS.openPosts).toBe(200);
  });

  it('labels every platform and kind', () => {
    for (const p of POST_PLATFORMS) expect(POST_PLATFORM_LABEL[p].length, p).toBeGreaterThan(0);
    for (const k of POST_KINDS) expect(POST_KIND_LABEL[k]).toHaveLength(2);
  });
});
