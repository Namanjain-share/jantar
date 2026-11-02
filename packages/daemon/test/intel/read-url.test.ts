/**
 * Links (spec 3.1, 3.2): what a save accepts, the canonical link (dedupe),
 * the platform and type by exact shape, the Chrome URL the daemon rebuilds
 * (never the link as typed), short links, the pending title and Full's
 * related links (the user's own note only). Synthetic links only.
 */
import { describe, expect, it } from 'vitest';
import { INTEL_READ_LIMITS } from '@jantar/protocol';
import { acceptText, canonical, chromeUrlOf, isShortLink, kindOf, noteLinks, pendingTitle } from '../../src/intel/read/url.js';

const OWN = new Set(['jantar.example.test', 'my-mac']);

describe('acceptText (spec 3.1)', () => {
  it('the first link is the item\'s, trailing punctuation stripped; the rest is the note', () => {
    expect(acceptText('look at this (https://www.instagram.com/reel/AbC123xyz/?igsh=abc). so good', OWN)).toEqual({
      ok: true,
      link: 'https://www.instagram.com/reel/AbC123xyz/',
      note: 'look at this ( ). so good',
    });
    expect(acceptText('https://example.com/a https://example.com/b', OWN)).toEqual({ ok: true, link: 'https://example.com/a', note: 'https://example.com/b' });
  });

  it('http is made https; no link at all is a note item', () => {
    expect(acceptText('http://example.com/page', OWN)).toEqual({ ok: true, link: 'https://example.com/page', note: null });
    expect(acceptText('  just a thought to keep  ', OWN)).toEqual({ ok: true, link: null, note: 'just a thought to keep' });
  });

  it('a link that breaks the URL rules is refused (nothing is saved)', () => {
    for (const bad of ['https://user:pw@example.com/', 'https://example.com:8443/', 'https://127.0.0.1/x', 'https://[::1]/', 'https://printer.local/', 'https://intranet/', 'https://jantar.example.test/v1', 'https://my-mac/']) {
      expect(acceptText(`save ${bad}`, OWN), bad).toMatchObject({ ok: false });
    }
  });

  it('the note is cut to noteMax', () => {
    const r = acceptText(`https://example.com/a ${'n'.repeat(5_000)}`, OWN);
    expect(r.ok && r.note?.length).toBe(INTEL_READ_LIMITS.noteMax);
  });
});

describe('canonical (spec 3.2)', () => {
  it('drops tracking parameters and the fragment; keeps the rest', () => {
    expect(canonical('https://example.com/a?utm_source=x&utm_medium=y&id=7&fbclid=1&gclid=2&ref=3#top')).toBe('https://example.com/a?id=7');
    expect(canonical('https://www.instagram.com/reel/AbC123xyz/?igsh=abc&igshid=def')).toBe('https://www.instagram.com/reel/AbC123xyz/');
  });

  it('makes each platform one host', () => {
    expect(canonical('https://instagram.com/p/AbC123xyz/')).toBe('https://www.instagram.com/p/AbC123xyz/');
    expect(canonical('https://m.youtube.com/watch?v=AbCdEfGhIjK&feature=share')).toBe('https://www.youtube.com/watch?v=AbCdEfGhIjK');
    expect(canonical('https://youtu.be/AbCdEfGhIjK?si=zzz')).toBe('https://www.youtube.com/watch?v=AbCdEfGhIjK');
    expect(canonical('https://twitter.com/example/status/1850000000000000000?s=20&t=abc')).toBe('https://x.com/example/status/1850000000000000000');
    expect(canonical('https://mobile.twitter.com/example/status/1850000000000000000')).toBe('https://x.com/example/status/1850000000000000000');
    expect(canonical('https://old.reddit.com/r/example/comments/abc123/a_thread/')).toBe('https://www.reddit.com/r/example/comments/abc123/a_thread/');
    expect(canonical('https://linkedin.com/feed/update/urn:li:activity:7250000000000000000/')).toBe('https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000000/');
  });

  it('m. and mobile. are dropped only on the platforms\' hosts (elsewhere it may be another site)', () => {
    expect(canonical('https://m.example.com/x')).toBe('https://m.example.com/x');
    expect(canonical('https://mobile.example.com/x')).toBe('https://mobile.example.com/x');
    expect(canonical('https://m.tiktok.com/v/1')).toBe('https://www.tiktok.com/v/1');
    expect(canonical('https://m.x.com/example/status/1850000000000000000')).toBe('https://x.com/example/status/1850000000000000000');
  });

  it('dedupe: two shares of one post are the same link', () => {
    expect(canonical('https://instagram.com/reel/AbC123xyz/?igsh=one')).toBe(canonical('https://www.instagram.com/reel/AbC123xyz/?igsh=two&utm_source=ig_web_copy_link'));
  });
});

describe('kindOf and chromeUrlOf (spec 3.2, 3.4)', () => {
  const cases: [string, string, string, string | null][] = [
    ['https://www.instagram.com/reel/AbC123xyz/', 'instagram', 'reel', 'https://www.instagram.com/reel/AbC123xyz/'],
    ['https://www.instagram.com/example_cook/reel/AbC123xyz/', 'instagram', 'reel', 'https://www.instagram.com/reel/AbC123xyz/'],
    ['https://www.instagram.com/p/AbC123xyz/', 'instagram', 'post', 'https://www.instagram.com/p/AbC123xyz/'],
    ['https://www.youtube.com/watch?v=AbCdEfGhIjK&t=30', 'youtube', 'video', 'https://www.youtube.com/watch?v=AbCdEfGhIjK'],
    ['https://www.youtube.com/shorts/AbCdEfGhIjK', 'youtube', 'short', 'https://www.youtube.com/shorts/AbCdEfGhIjK'],
    ['https://www.tiktok.com/@example.dancer/video/7400000000000000000', 'tiktok', 'reel', 'https://www.tiktok.com/@example.dancer/video/7400000000000000000'],
    ['https://x.com/example/status/1850000000000000000', 'x', 'post', 'https://x.com/i/status/1850000000000000000'],
    ['https://www.reddit.com/r/example/comments/abc123/a_thread/', 'reddit', 'thread', 'https://www.reddit.com/r/example/comments/abc123/'],
    ['https://www.linkedin.com/posts/example-founder_topic-activity-7250000000000000000-AbCd/', 'linkedin', 'post', 'https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000000/'],
    ['https://example.com/report.PDF', 'pdf', 'pdf', null],
    ['https://www.instagram.com/example_cook/', 'web', 'link', null],
    ['https://www.instagram.com/accounts/login/', 'web', 'link', null],
    ['https://l.instagram.com/?u=https%3A%2F%2Fexample.com', 'web', 'link', null],
    ['https://www.youtube.com/redirect?q=https%3A%2F%2Fexample.com', 'web', 'link', null],
    ['https://www.threads.net/@example/post/AbC', 'web', 'link', null],
    ['https://example.com/article', 'web', 'link', null],
  ];

  for (const [link, platform, type, chrome] of cases) {
    it(`${link} → ${platform} ${type}${chrome ? '' : ', never Chrome'}`, () => {
      const k = kindOf(canonical(link));
      expect(k.platform).toBe(platform);
      expect(k.type).toBe(type);
      expect(chromeUrlOf(k.post)).toBe(chrome);
    });
  }

  it('a note has no link', () => {
    expect(kindOf(null)).toEqual({ platform: 'note', type: 'note', post: null });
  });

  it('the Chrome URL never carries the query, the fragment or the handle the user typed', () => {
    const u = chromeUrlOf(kindOf(canonical('https://www.instagram.com/someone_else/reel/AbC123xyz/?igsh=x&next=https://example.com#frag')).post) as string;
    expect(u).toBe('https://www.instagram.com/reel/AbC123xyz/');
  });
});

describe('short links, the pending title, related links', () => {
  it('short links are resolved inside the job', () => {
    for (const s of ['https://t.co/AbCdEf', 'https://lnkd.in/AbCdEf', 'https://bit.ly/abc', 'https://redd.it/abc', 'https://vt.tiktok.com/ZSabc/', 'https://vm.tiktok.com/ZSabc/', 'https://www.tiktok.com/t/ZTabc/', 'https://www.reddit.com/r/example/s/AbCdEf123']) {
      expect(isShortLink(canonical(s)), s).toBe(true);
    }
    expect(isShortLink('https://example.com/a')).toBe(false);
  });

  it('the pending title is the daemon\'s own: the platform and type, a host and path, or a note\'s first line', () => {
    const ig = 'https://www.instagram.com/reel/AbC123xyz/';
    expect(pendingTitle(ig, kindOf(ig), null)).toBe('Instagram reel');
    const yt = 'https://www.youtube.com/shorts/AbCdEfGhIjK';
    expect(pendingTitle(yt, kindOf(yt), null)).toBe('YouTube Short');
    const web = 'https://www.example.com/blog/a-post';
    expect(pendingTitle(web, kindOf(web), 'my note')).toBe('example.com/blog/a-post');
    expect(pendingTitle(null, kindOf(null), '\n  first line\nsecond line')).toBe('first line');
    expect(pendingTitle(null, kindOf(null), 'x'.repeat(500)).length).toBe(INTEL_READ_LIMITS.pendingTitleMax);
  });

  it('related links: up to 3 distinct https links from the note, each passing the URL rules', () => {
    const note = 'see https://example.com/one and https://example.com/one?utm_source=x, http://example.com/plain https://127.0.0.1/x https://example.com/two https://example.com/three https://example.com/four';
    expect(noteLinks(note, OWN)).toEqual(['https://example.com/one', 'https://example.com/two', 'https://example.com/three']);
    expect(noteLinks(null, OWN)).toEqual([]);
    expect(noteLinks('no links here', OWN)).toEqual([]);
  });
});
