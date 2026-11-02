/**
 * v0.9 Log a comment, the protocol's part: `postPlaceOf` reads a comment's
 * link for its platform and where (never fetched); a post body may be
 * posted with its link; Today's posts part may count today's comments
 * against a goal; a comment goal names its platform; Done is 300. The
 * route stays the same. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import {
  POSTS_DONE_PAGE,
  POST_PLATFORMS,
  PostBodySchema,
  PostWhereSchema,
  ROUTES,
  TodaySchema,
  postGoalLabel,
  postGoalLabels,
  postPlaceOf,
  type PostPlace,
} from '../src/index.js';

const SUB = { platform: 'reddit', where: 'r/exampletools' };

describe('postPlaceOf: Reddit', () => {
  it('reads r/<sub> from the desktop comment link, the app share link and old permalinks, on any reddit host', () => {
    for (const href of [
      'https://www.reddit.com/r/exampletools/comments/1abc2de/comment/kx9y8z7/?utm_source=share&utm_medium=web3x',
      'https://www.reddit.com/r/exampletools/s/AbCdEf1234',
      'https://reddit.com/r/exampletools/s/AbCdEf1234',
      'https://old.reddit.com/r/exampletools/comments/1abc2de/example_slug/kx9y8z7/?context=3',
      'https://sh.reddit.com/r/exampletools/comments/1abc2de/example_slug/kx9y8z7/?context=3',
      'https://np.reddit.com/r/exampletools/comments/1abc2de/example_slug/kx9y8z7/?context=3',
      'https://m.reddit.com/r/exampletools/comments/1abc2de/example_slug/kx9y8z7/?context=3',
      'https://www.reddit.com/r/exampletools',
      '  https://www.reddit.com/r/exampletools/s/AbCdEf1234  ',
    ]) {
      expect(postPlaceOf(href), href).toEqual(SUB);
    }
  });

  it("keeps the sub's case as written, and takes R/ too", () => {
    expect(postPlaceOf('https://www.reddit.com/r/ExampleTools/s/AbCdEf1234')).toEqual({ platform: 'reddit', where: 'r/ExampleTools' });
    expect(postPlaceOf('https://www.reddit.com/R/exampletools/comments/1abc2de/')).toEqual(SUB);
  });

  it('reads u/<name> from user/ and u/ paths', () => {
    expect(postPlaceOf('https://www.reddit.com/user/example_user/comments/1abc2de/comment/kx9y8z7/')).toEqual({ platform: 'reddit', where: 'u/example_user' });
    expect(postPlaceOf('https://www.reddit.com/u/example_user/')).toEqual({ platform: 'reddit', where: 'u/example_user' });
    expect(postPlaceOf('https://www.reddit.com/u/ab')).toEqual({ platform: 'reddit' });
  });

  it('gives no where for a short link, a bare /comments/ link, or a sub that is too long or has a dash', () => {
    for (const href of [
      'https://redd.it/1abc2de',
      'https://www.reddit.com/comments/1abc2de',
      'https://reddit.app.link/AbCdEf1234',
      `https://www.reddit.com/r/${'a'.repeat(22)}/s/AbCdEf1234`,
      'https://www.reddit.com/r/example-tools/s/AbCdEf1234',
      'https://www.reddit.com/r/',
      'https://www.reddit.com/',
    ]) {
      expect(postPlaceOf(href), href).toEqual({ platform: 'reddit' });
    }
    expect(postPlaceOf(`https://www.reddit.com/r/${'a'.repeat(21)}/s/AbCdEf1234`)).toEqual({ platform: 'reddit', where: `r/${'a'.repeat(21)}` });
  });

  it("reads the host in any case, with one trailing dot", () => {
    expect(postPlaceOf('https://WWW.Reddit.COM/r/exampletools/s/AbCdEf1234')).toEqual(SUB);
    expect(postPlaceOf('https://www.reddit.com./r/exampletools/s/AbCdEf1234')).toEqual(SUB);
  });
});

describe('postPlaceOf: the other platforms', () => {
  it('names each platform by its domains and any subdomain, with no where', () => {
    const rows: [string, PostPlace['platform']][] = [
      ['https://x.com/example_user/status/1234567890123456789', 'x'],
      ['https://twitter.com/example_user/status/1234567890123456789', 'x'],
      ['https://mobile.twitter.com/example_user/status/1234567890123456789', 'x'],
      ['https://www.linkedin.com/feed/update/urn:li:comment:(activity:1234567890,1234567891)/', 'linkedin'],
      ['https://lnkd.in/AbCdEf', 'linkedin'],
      ['https://www.youtube.com/watch?v=AbCdEfGhIjK&lc=UgxExample', 'youtube'],
      ['https://youtu.be/AbCdEfGhIjK', 'youtube'],
      ['https://m.youtube.com/watch?v=AbCdEfGhIjK', 'youtube'],
      ['https://www.tiktok.com/@example_user/video/1234567890123456789', 'tiktok'],
      ['https://www.threads.net/@example_user/post/AbCdEf', 'threads'],
      ['https://www.threads.com/@example_user/post/AbCdEf', 'threads'],
      ['https://www.instagram.com/p/AbCdEf/c/1234567890/', 'instagram'],
      ['https://www.facebook.com/example.page/posts/1234567890?comment_id=987654321', 'facebook'],
      ['https://fb.com/example.page', 'facebook'],
      ['https://fb.watch/AbCdEf/', 'facebook'],
      ['https://news.ycombinator.com/item?id=12345678', 'hn'],
      ['https://reddit.app.link/AbCdEf1234', 'reddit'],
      ['https://redd.it/1abc2de', 'reddit'],
    ];
    for (const [href, platform] of rows) expect(postPlaceOf(href), href).toEqual({ platform });
    // Every platform but other is reached by some row.
    expect(new Set(rows.map(([, p]) => p))).toEqual(new Set(POST_PLATFORMS.filter((p) => p !== 'other')));
  });

  it('reads a look-alike host as other, with its host', () => {
    expect(postPlaceOf('https://notreddit.com/r/exampletools/s/AbCdEf1234')).toEqual({ platform: 'other', where: 'notreddit.com' });
    expect(postPlaceOf('https://reddit.com.example.net/r/exampletools')).toEqual({ platform: 'other', where: 'reddit.com.example.net' });
    expect(postPlaceOf('https://x.com.example.org/example_user/status/1')).toEqual({ platform: 'other', where: 'x.com.example.org' });
    expect(postPlaceOf('https://ycombinator.com/companies')).toEqual({ platform: 'other', where: 'ycombinator.com' });
  });

  it('gives other the host without www., or no where past 80 characters', () => {
    expect(postPlaceOf('https://www.example.com/discussions/1#comment-2')).toEqual({ platform: 'other', where: 'example.com' });
    expect(postPlaceOf('https://forum.example.org/t/1')).toEqual({ platform: 'other', where: 'forum.example.org' });
    const long = `${'a'.repeat(60)}.${'b'.repeat(30)}.example`;
    expect(postPlaceOf(`https://${long}/t/1`)).toEqual({ platform: 'other' });
  });
});

describe('postPlaceOf: not a link', () => {
  it('is null for http, other schemes, no scheme, empty, spaces only and past 2,000 characters', () => {
    for (const href of [
      'http://www.reddit.com/r/exampletools/s/AbCdEf1234',
      'javascript:alert(1)',
      'reddit.com/r/exampletools/s/AbCdEf1234',
      'www.reddit.com/r/exampletools',
      'r/exampletools',
      '',
      '   ',
      `https://www.reddit.com/r/exampletools/${'a'.repeat(2_001 - 'https://www.reddit.com/r/exampletools/'.length)}`,
    ]) {
      expect(postPlaceOf(href), href.slice(0, 60)).toBeNull();
    }
    const at2000 = `https://www.reddit.com/r/exampletools/${'a'.repeat(2_000 - 'https://www.reddit.com/r/exampletools/'.length)}`;
    expect(at2000).toHaveLength(2_000);
    expect(postPlaceOf(at2000)).toEqual(SUB);
  });

  it('every where it gives passes PostWhereSchema', () => {
    for (const href of [
      'https://www.reddit.com/r/exampletools/s/AbCdEf1234',
      'https://www.reddit.com/u/example_user',
      'https://www.example.com/a',
      'https://sub.example.co.uk/a',
      `https://www.reddit.com/r/${'a'.repeat(21)}/s/AbCdEf1234`,
      `https://${'a'.repeat(63)}.example.com/a`,
    ]) {
      const place = postPlaceOf(href);
      expect(place, href).not.toBeNull();
      if (place?.where !== undefined) expect(PostWhereSchema.safeParse(place.where).success, href).toBe(true);
    }
  });
});

describe('a posted post body', () => {
  const body = { platform: 'reddit', kind: 'comment', status: 'posted', postedUrl: 'https://www.reddit.com/r/exampletools/s/AbCdEf1234', where: 'r/exampletools', text: 'What I wrote.' };

  it('takes status posted and the posted link', () => {
    expect(PostBodySchema.safeParse(body).success).toBe(true);
    expect(PostBodySchema.safeParse({ platform: 'reddit', status: 'posted' }).success).toBe(true);
  });

  it('still refuses skipped, postedAt and unknown keys; the posted link is https only', () => {
    expect(PostBodySchema.safeParse({ ...body, status: 'skipped' }).success).toBe(false);
    expect(PostBodySchema.safeParse({ ...body, postedAt: '2026-11-02T14:00:00.000Z' }).success).toBe(false);
    expect(PostBodySchema.safeParse({ ...body, comment: true }).success).toBe(false);
    for (const bad of ['http://www.reddit.com/r/exampletools/s/AbCdEf1234', 'javascript:alert(1)', 'www.reddit.com/r/exampletools', '']) {
      expect(PostBodySchema.safeParse({ ...body, postedUrl: bad }).success, bad).toBe(false);
    }
    expect(PostBodySchema.safeParse({ ...body, postedUrl: `https://www.example.com/${'a'.repeat(2_000)}` }).success).toBe(false);
  });

  it('goes to the same route, which says so', () => {
    expect(ROUTES.postCreate).toMatchObject({ method: 'POST', path: '/v1/posts', ctl: true, feature: 'posts', body: PostBodySchema });
    expect(ROUTES.postCreate.summary).toContain('log one already posted');
  });
});

describe("Today's comments, the goal labels and Done", () => {
  const today = (posts: unknown) => TodaySchema.safeParse({ day: '2026-11-02', posts }).success;

  it("Today's posts part may count today's comments, with or without a goal", () => {
    expect(today({ today: 1, late: 0 })).toBe(true);
    expect(today({ today: 1, late: 0, comments: { done: 3, goal: 5 } })).toBe(true);
    expect(today({ today: 1, late: 0, comments: { done: 0 } })).toBe(true);
    expect(today({ today: 1, late: 0, comments: { done: 3, goal: 0 } })).toBe(false);
    expect(today({ today: 1, late: 0, comments: { done: -1 } })).toBe(false);
    expect(today({ today: 1, late: 0, comments: { done: 1.5, goal: 5 } })).toBe(false);
  });

  it('a comment goal names its platform; other goals read as before', () => {
    expect(postGoalLabel({ platform: 'reddit', kind: 'comment' })).toBe('Reddit comments');
    expect(postGoalLabel({ platform: 'x', kind: 'comment' })).toBe('X comments');
    expect(postGoalLabel({ platform: 'hn', kind: 'comment' })).toBe('Hacker News comments');
    expect(postGoalLabel({ platform: 'instagram', kind: 'reel' })).toBe('Reels');
    expect(postGoalLabel({ platform: 'reddit' })).toBe('Reddit');
    expect(postGoalLabels([{ platform: 'reddit', kind: 'comment' }, { platform: 'x', kind: 'comment' }, { platform: 'reddit', kind: 'post' }])).toEqual([
      'Reddit comments',
      'X comments',
      'Posts',
    ]);
    expect(postGoalLabels([{ platform: 'reddit', kind: 'comment' }, { platform: 'reddit' }, { platform: 'instagram', kind: 'reel' }])).toEqual([
      'Reddit comments',
      'Reddit',
      'Reels',
    ]);
    expect(postGoalLabels([{ platform: 'instagram', kind: 'reel' }, { platform: 'facebook', kind: 'reel' }])).toEqual(['Instagram reels', 'Facebook reels']);
  });

  it('Done shows the newest 300', () => {
    expect(POSTS_DONE_PAGE).toBe(300);
  });
});
