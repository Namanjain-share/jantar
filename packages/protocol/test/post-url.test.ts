/**
 * v0.8 G15: the post links the user's Chrome may open (post-url.ts).
 * Every shape of spec 3.2's table is read and rebuilt on the platform's www
 * host from its parts alone; link shims, redirects, login, logout and OAuth
 * pages, profiles, other hosts and subdomains, ports, userinfo and http are
 * refused. The module imports nothing and holds no URL literal (the
 * extension bundles it). Synthetic ids only.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHROME_PLATFORMS, CHROME_POST_HOSTS, chromePathOf, chromePostOf, isLoginPath, type ChromePost } from '../src/post-url.js';

const SOURCE = readFileSync(new URL('../src/post-url.ts', import.meta.url), 'utf8');

/** The URL the daemon queues: the platform's host and the rebuilt path. */
function rebuilt(post: ChromePost): string | null {
  const path = chromePathOf(post);
  return path === null ? null : new URL(path, `https://${CHROME_POST_HOSTS[post.platform]}`).href;
}

const YT = 'Ab1_Cd2-Ef3';
const CASES: [string, Pick<ChromePost, 'platform' | 'kind'>, string][] = [
  // Instagram: reel, reels, tv and p, with and without a username before, query and hash ignored.
  ['https://www.instagram.com/reel/AbC123xyz/', { platform: 'instagram', kind: 'reel' }, 'https://www.instagram.com/reel/AbC123xyz/'],
  ['https://www.instagram.com/reels/AbC123xyz', { platform: 'instagram', kind: 'reel' }, 'https://www.instagram.com/reel/AbC123xyz/'],
  ['https://www.instagram.com/tv/AbC123xyz/', { platform: 'instagram', kind: 'reel' }, 'https://www.instagram.com/reel/AbC123xyz/'],
  ['https://www.instagram.com/p/AbC-12_xyz/?igsh=abc123&utm_source=ig_web#top', { platform: 'instagram', kind: 'post' }, 'https://www.instagram.com/p/AbC-12_xyz/'],
  ['https://www.instagram.com/example_cook/reel/AbC123xyz/', { platform: 'instagram', kind: 'reel' }, 'https://www.instagram.com/reel/AbC123xyz/'],
  ['https://www.instagram.com/example.cook/p/AbC123xyz/', { platform: 'instagram', kind: 'post' }, 'https://www.instagram.com/p/AbC123xyz/'],
  // YouTube: watch (exactly one v), shorts and live.
  [`https://www.youtube.com/watch?v=${YT}&t=42s&si=xyz`, { platform: 'youtube', kind: 'video' }, `https://www.youtube.com/watch?v=${YT}`],
  [`https://www.youtube.com/shorts/${YT}`, { platform: 'youtube', kind: 'short' }, `https://www.youtube.com/shorts/${YT}`],
  [`https://www.youtube.com/shorts/${YT}/?feature=share`, { platform: 'youtube', kind: 'short' }, `https://www.youtube.com/shorts/${YT}`],
  [`https://www.youtube.com/live/${YT}`, { platform: 'youtube', kind: 'video' }, `https://www.youtube.com/watch?v=${YT}`],
  // TikTok: video and photo.
  ['https://www.tiktok.com/@example.cook/video/7300000000000000001', { platform: 'tiktok', kind: 'reel' }, 'https://www.tiktok.com/@example.cook/video/7300000000000000001'],
  ['https://www.tiktok.com/@example_cook/photo/7300000000000000002?lang=en', { platform: 'tiktok', kind: 'post' }, 'https://www.tiktok.com/@example_cook/photo/7300000000000000002'],
  // X: a handle's status, /i/status and /i/web/status, all rebuilt as /i/status.
  ['https://x.com/example_dev/status/1850000000000000001?s=20', { platform: 'x', kind: 'post' }, 'https://x.com/i/status/1850000000000000001'],
  ['https://x.com/i/status/1850000000000000002', { platform: 'x', kind: 'post' }, 'https://x.com/i/status/1850000000000000002'],
  ['https://x.com/i/web/status/1850000000000000003/', { platform: 'x', kind: 'post' }, 'https://x.com/i/status/1850000000000000003'],
  // Reddit: a thread with and without its slug, and a share link.
  ['https://www.reddit.com/r/exampletools/comments/1abc2d/a_made_up_thread/', { platform: 'reddit', kind: 'thread' }, 'https://www.reddit.com/r/exampletools/comments/1abc2d/'],
  ['https://www.reddit.com/r/exampletools/comments/1abc2d', { platform: 'reddit', kind: 'thread' }, 'https://www.reddit.com/r/exampletools/comments/1abc2d/'],
  ['https://www.reddit.com/r/exampletools/s/AbCdEf123', { platform: 'reddit', kind: 'thread' }, 'https://www.reddit.com/r/exampletools/s/AbCdEf123'],
  // LinkedIn: a post's page (activity, share, ugcPost) and the feed's urn.
  ['https://www.linkedin.com/posts/example-person_some-title-activity-7250000000000000001-AbCd/', { platform: 'linkedin', kind: 'post' }, 'https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000001/'],
  ['https://www.linkedin.com/posts/example-person_x-share-7250000000000000002-Xy_9?utm_source=share', { platform: 'linkedin', kind: 'post' }, 'https://www.linkedin.com/feed/update/urn:li:share:7250000000000000002/'],
  ['https://www.linkedin.com/posts/example-person_x-ugcPost-7250000000000000003-Q1', { platform: 'linkedin', kind: 'post' }, 'https://www.linkedin.com/feed/update/urn:li:ugcPost:7250000000000000003/'],
  ['https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000004/', { platform: 'linkedin', kind: 'post' }, 'https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000004/'],
];

describe('v0.8 G15: chromePostOf', () => {
  it('reads every shape of the table and rebuilds it on the www host from the parts alone', () => {
    for (const [href, want, url] of CASES) {
      const post = chromePostOf(href);
      expect(post, href).toMatchObject(want);
      expect(rebuilt(post as ChromePost), href).toBe(url);
      // The rebuilt URL is itself a post of the same platform and kind: what the extension checks again.
      expect(chromePostOf(url), url).toEqual(post);
    }
    // Every platform has a case.
    expect(new Set(CASES.map(([, p]) => p.platform))).toEqual(new Set(CHROME_PLATFORMS));
  });

  it('refuses link shims, redirects, login, logout and OAuth pages, profiles and anything off-shape', () => {
    const refused = [
      'https://l.instagram.com/?u=https%3A%2F%2Fexample.com%2F&e=x',
      'https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2F',
      'https://l.threads.com/?u=https%3A%2F%2Fexample.com%2F',
      'https://out.reddit.com/t3_1abc2d?url=https%3A%2F%2Fexample.com%2F',
      'https://www.youtube.com/redirect?q=https%3A%2F%2Fexample.com%2F',
      'https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Fexample.com%2F',
      'https://www.instagram.com/accounts/login/?next=/reel/AbC123xyz/',
      'https://www.instagram.com/accounts/logout/',
      'https://www.facebook.com/dialog/oauth?client_id=1',
      'https://www.instagram.com/dialog/oauth?client_id=1',
      'https://x.com/i/flow/login',
      'https://www.linkedin.com/authwall?trk=x',
      // Profiles and other pages on the six hosts.
      'https://www.instagram.com/example_cook/',
      'https://www.instagram.com/stories/example_cook/3300000000000000000/',
      'https://www.youtube.com/@example_channel',
      'https://www.youtube.com/channel/UCexample',
      'https://www.youtube.com/playlist?list=PLexample',
      'https://www.tiktok.com/@example_cook',
      'https://x.com/example_dev',
      'https://x.com/example_dev/status/1850000000000000001/photo/1',
      'https://www.reddit.com/r/exampletools/',
      'https://www.reddit.com/user/example_user/',
      'https://www.linkedin.com/in/example-person/',
      // YouTube's watch needs exactly one good v.
      'https://www.youtube.com/watch',
      'https://www.youtube.com/watch?v=short',
      `https://www.youtube.com/watch?v=${YT}&v=${YT}`,
      // Hosts: non-www, other subdomains, look-alikes, Threads and Facebook (web links), youtu.be, twitter.com.
      'https://instagram.com/reel/AbC123xyz/',
      'https://m.instagram.com/reel/AbC123xyz/',
      'https://help.instagram.com/reel/AbC123xyz/',
      'https://www.instagram.com.example.com/reel/AbC123xyz/',
      'https://www.instagram.com./reel/AbC123xyz/',
      'https://www.threads.net/@example_cook/post/AbC123xyz',
      'https://www.facebook.com/reel/1234567890123',
      `https://youtu.be/${YT}`,
      `https://m.youtube.com/watch?v=${YT}`,
      'https://twitter.com/example_dev/status/1850000000000000001',
      'https://mobile.x.com/i/status/1850000000000000001',
      'https://old.reddit.com/r/exampletools/comments/1abc2d/',
      // A port, userinfo, http and other schemes.
      'https://www.instagram.com:8443/reel/AbC123xyz/',
      'https://user:pass@www.instagram.com/reel/AbC123xyz/', // jantar-secrets-allow: made-up userinfo, which must be refused
      'https://user@x.com/i/status/1850000000000000001', // jantar-secrets-allow: made-up userinfo, which must be refused
      'http://www.instagram.com/reel/AbC123xyz/',
      'javascript:alert(1)',
      'data:text/html,<p>x</p>',
      // Off-pattern ids.
      'https://www.instagram.com/reel/abc/',
      'https://x.com/i/status/12345',
      'https://www.reddit.com/r/exampletools/comments/NOT_LOWER/',
      'https://www.linkedin.com/feed/update/urn:li:comment:7250000000000000004/',
      // Not a URL, or too long.
      'not a url',
      '',
      `https://www.instagram.com/reel/AbC123xyz/?pad=${'a'.repeat(2000)}`,
    ];
    for (const href of refused) expect(chromePostOf(href), href).toBeNull();
  });

  it('rebuilds nothing from parts that are missing or off-pattern', () => {
    expect(chromePathOf({ platform: 'instagram', kind: 'reel', parts: { code: 'x/../y' } })).toBeNull();
    expect(chromePathOf({ platform: 'instagram', kind: 'thread', parts: { code: 'AbC123xyz' } })).toBeNull();
    expect(chromePathOf({ platform: 'youtube', kind: 'video', parts: {} })).toBeNull();
    expect(chromePathOf({ platform: 'x', kind: 'post', parts: { id: '1850000000000000001?x' } })).toBeNull();
    expect(chromePathOf({ platform: 'reddit', kind: 'thread', parts: { sub: 'exampletools' } })).toBeNull();
    expect(chromePathOf({ platform: 'linkedin', kind: 'post', parts: { urn: 'activity|comment', id: '7250000000000000001' } })).toBeNull();
    expect(chromePathOf({ platform: 'tiktok', kind: 'reel', parts: { user: 'example', id: '7300000000000000001', extra: 'x' } })).toBe('/@example/video/7300000000000000001');
  });
});

describe('v0.8 G15: isLoginPath', () => {
  it("knows each platform's login wall, case aside, and nothing else", () => {
    expect(isLoginPath('instagram', '/accounts/login/')).toBe(true);
    expect(isLoginPath('instagram', '/Accounts/Login')).toBe(true);
    expect(isLoginPath('instagram', '/challenge/action/')).toBe(true);
    expect(isLoginPath('x', '/i/flow/login')).toBe(true);
    expect(isLoginPath('linkedin', '/authwall')).toBe(true);
    expect(isLoginPath('linkedin', '/uas/login')).toBe(true);
    expect(isLoginPath('linkedin', '/checkpoint/lg/login')).toBe(true);
    expect(isLoginPath('reddit', '/login/')).toBe(true);
    expect(isLoginPath('tiktok', '/login')).toBe(true);
    expect(isLoginPath('instagram', '/reel/AbC123xyz/')).toBe(false);
    expect(isLoginPath('instagram', '/accounts/loginx')).toBe(false);
    expect(isLoginPath('x', '/example_dev/status/1850000000000000001')).toBe(false);
    expect(isLoginPath('reddit', '/r/exampletools/comments/1abc2d/')).toBe(false);
  });
});

describe('v0.8 G15: the module', () => {
  it('imports nothing and holds no URL literal', () => {
    expect(SOURCE).not.toMatch(/^\s*import\s/m);
    expect(SOURCE).not.toMatch(/\brequire\(/);
    expect(SOURCE).not.toMatch(/https?:\/\//);
  });

  it('has exactly the six hosts, no wildcard', () => {
    expect({ ...CHROME_POST_HOSTS }).toEqual({
      instagram: 'www.instagram.com',
      youtube: 'www.youtube.com',
      tiktok: 'www.tiktok.com',
      x: 'x.com',
      reddit: 'www.reddit.com',
      linkedin: 'www.linkedin.com',
    });
    expect(Object.isFrozen(CHROME_POST_HOSTS)).toBe(true);
  });
});
