/**
 * The readers of fetched text (spec 3.6), tests G18 and the adapters:
 *
 * - G18: every extractor is linear-time. 5 MB of "<", of an unclosed
 *   comment, attribute or quote, of nested tags, one 5 MB attribute and
 *   deeply nested ld+json each read in under a second on the HTML reader,
 *   the JSON cutter and every platform's adapter, so the job's 8-minute
 *   timer can always fire.
 * - The adapters on canned, synthetic pages and JSON (made-up creators,
 *   example links): what each platform's shape gives, which media URLs are
 *   kept (the platform's CDN only), the login and region cases, and the good
 *   read rule.
 */
import { describe, expect, it } from 'vitest';
import type { PageReadParsed } from '@jantar/protocol';
import { cutJson, decodeEntities, jsonAfter, ldObjects, readHtml } from '../../src/intel/read/html.js';
import { checkPageRead, fromPageRead, isGood, type PageFields } from '../../src/intel/read/platforms/common.js';
import { instagramFromHtml, instagramFromPage, splitOgDescription, splitOgTitle } from '../../src/intel/read/platforms/instagram.js';
import {
  isTiktokRegionPage,
  linkedinFromHtml,
  linkedinFromPage,
  pickXVariant,
  redditFromOembed,
  redditFromPage,
  syndicationToken,
  tiktokFromOembed,
  tiktokFromPage,
  xFromOembed,
  xFromPage,
  xFromSyndication,
} from '../../src/intel/read/platforms/social.js';
import { webFromHtml, webFromPage } from '../../src/intel/read/platforms/web.js';
import { youtubeFromOembed, youtubeFromWatch, ytCoverUrls, ytFrameUrls } from '../../src/intel/read/platforms/youtube.js';
import { creatorOf, ytdlpFields } from '../../src/intel/read/pipeline.js';

const MB5 = 5 * 1024 * 1024;

/** Hostile 5 MB inputs (G18). */
function hostile(): Record<string, string> {
  const fill = (unit: string) => unit.repeat(Math.ceil(MB5 / unit.length)).slice(0, MB5);
  return {
    lt: fill('<'),
    ltSlash: fill('</'),
    comment: `<html><body><p>start</p><!--${fill('a-')}`,
    commentOpeners: fill('<!--'),
    attribute: `<html><head><meta property="og:title" content="${fill('x')}`,
    singleQuote: `<div title='${fill('y')}`,
    attrs: `<div ${fill('a=b ')}`,
    unclosedTag: `<div${fill(' ')}`,
    nested: fill('<div>'),
    nestedP: fill('<p><span>'),
    bigAttr: `<html><head><meta property="og:description" content="${fill('z')}"><title>t</title></head><body><article><p>Body</p></article></body></html>`,
    ldjson: `<script type="application/ld+json">${fill('{"a":')}`,
    ldNested: `<script type="application/ld+json">${'['.repeat(24_000)}${']'.repeat(24_000)}</script>${fill('<p>x</p>')}`,
    ldQuotes: `<script type="application/ld+json">{"a":"${fill('\\"')}</script>`,
    scripts: fill('<script>'),
    entities: `<article><p>${fill('&amp;&#x41;&bogus;')}</p></article>`,
    playerJson: `<script>var ytInitialPlayerResponse = {"videoDetails":${fill('{"a":[')}`,
    playerString: `"videoDetails":{"title":"${fill('\\u')}`,
    captionTracks: `"captionTracks":${fill('[')}`,
    ampersands: fill('&'),
    rawText: `<title>${fill('t')}`,
  };
}

function timed(fn: () => unknown): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

/** An in-page read of `text` with `meta`. */
function page(over: Partial<PageReadParsed> = {}): PageReadParsed {
  return { finalUrl: 'https://www.example.test/post', meta: [], jsonld: [], text: '', media: [], frames: [], ...over };
}

// ---------------------------------------------------------------- G18

describe('G18: every extractor is linear-time on hostile 5 MB input', () => {
  const inputs = hostile();
  const extractors: Record<string, (s: string) => unknown> = {
    readHtml: (s) => readHtml(s),
    readHtmlNoText: (s) => readHtml(s, { textMax: 0 }),
    instagramFromHtml,
    linkedinFromHtml,
    webFromHtml,
    youtubeFromWatch: (s) => youtubeFromWatch(s),
    jsonAfterDetails: (s) => jsonAfter(s, '"videoDetails":'),
    jsonAfterTracks: (s) => jsonAfter(s, '"captionTracks":'),
    cutJson: (s) => cutJson(s, Math.max(0, s.indexOf('{'))),
    xFromOembed: (s) => xFromOembed({ html: s, author_name: s }),
    ldObjects: (s) => ldObjects([s.slice(0, 50_000)]),
  };

  for (const [name, fn] of Object.entries(extractors)) {
    it(`${name}: each hostile input in under a second`, () => {
      for (const [kind, input] of Object.entries(inputs)) {
        const ms = timed(() => fn(input));
        expect(ms, `${name} on ${kind}`).toBeLessThan(1_000);
      }
    }, 120_000);
  }

  it('the in-page read adapters: the largest read the schema allows, in under a second each', () => {
    const big = 'x'.repeat(40_000);
    const raw = page({
      title: '<'.repeat(2000),
      meta: Array.from({ length: 60 }, (_v, i) => ({ k: i % 2 ? 'og:title' : 'og:description', v: `${'"'.repeat(900)} on Instagram: ${'&amp;'.repeat(200)}` })),
      jsonld: Array.from({ length: 5 }, () => `${'['.repeat(24_000)}${']'.repeat(24_000)}`),
      text: big,
      author: ' '.repeat(200),
      handle: '@'.repeat(200),
      publishedAt: '9'.repeat(100),
      comments: Array.from({ length: 10 }, () => ({ author: 'a'.repeat(200), text: '&'.repeat(500) })),
    });
    const read = checkPageRead(raw) as PageReadParsed;
    expect(read).not.toBeNull();
    for (const fn of [instagramFromPage, tiktokFromPage, xFromPage, redditFromPage, linkedinFromPage, webFromPage, fromPageRead]) {
      expect(timed(() => fn(read)), fn.name).toBeLessThan(1_000);
    }
  });

  it('a decoded entity run, a deep ld+json nest and an unclosed JSON give nothing, never a throw', () => {
    expect(decodeEntities('&amp;&lt;&#65;&#x42;&#0;&#xD800;&nope;')).toBe('&<AB&#0;&#xD800;&nope;');
    expect(ldObjects([`${'['.repeat(20_000)}{"@type":"Article"}${']'.repeat(20_000)}`])).toEqual([]);
    expect(cutJson('{"a":"}', 0)).toBeNull();
    expect(jsonAfter('"videoDetails": {"title":"t"}', '"videoDetails":')).toEqual({ title: 't' });
  });
});

// ---------------------------------------------------------------- the HTML reader

describe('the HTML reader', () => {
  const html = `<!doctype html><html lang="en-GB"><head>
    <title>Example Article &amp; More</title>
    <meta property="og:title" content="An example article">
    <meta property="og:description" content="A synthetic description.">
    <meta name="author" content="Example Writer">
    <meta property="og:image" content="https://cdn.example.test/picture.jpg">
    <meta name="viewport" content="width=device-width">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"An example article","author":{"name":"Example Writer"},"datePublished":"2026-10-30T08:00:00Z"}</script>
    <script>var secret = "never text";</script><style>.x{}</style>
  </head><body>
    <header><nav>Home Sign in <a href="/me">signed-in-user-marker</a></nav></header>
    <aside>Related stuff</aside>
    <article><h1>An example article</h1><p>First paragraph of a synthetic article.</p><p>Second &mdash; with <b>bold</b> text.</p></article>
    <footer>Copyright</footer>
  </body></html>`;

  it('meta pairs, ld+json blocks, the title, the lang and the main text (never nav, header, footer, aside or script)', () => {
    const r = readHtml(html);
    expect(r.title).toBe('Example Article & More');
    expect(r.lang).toBe('en-GB');
    expect(r.meta).toEqual(
      expect.arrayContaining([
        { k: 'og:title', v: 'An example article' },
        { k: 'og:description', v: 'A synthetic description.' },
        { k: 'author', v: 'Example Writer' },
      ]),
    );
    expect(r.meta.some((m) => m.k === 'viewport')).toBe(false);
    expect(r.jsonld).toHaveLength(1);
    expect(r.text).toContain('First paragraph of a synthetic article.');
    expect(r.text).toContain('Second — with bold text.');
    for (const never of ['signed-in-user-marker', 'never text', 'Related stuff', 'Copyright', 'Sign in']) expect(r.text).not.toContain(never);
  });

  it('textMax cuts the main text', () => {
    expect(readHtml(html, { textMax: 10 }).text.length).toBeLessThanOrEqual(10);
    expect(readHtml(html, { textMax: 0 }).text).toBe('');
  });

  it('a web page: title, author, date, picture, article chip; good only with enough text', () => {
    const f = webFromHtml(html);
    expect(f).toMatchObject({ title: 'An example article', creator: 'Example Writer', postedAt: '2026-10-30T08:00:00.000Z', cover: 'https://cdn.example.test/picture.jpg', article: true });
    // A title with a description is good; an app shell is not.
    expect(isGood('web', f)).toBe(true);
    expect(isGood('web', webFromHtml('<title>Log in</title>'))).toBe(false);
    const long = webFromHtml(`<html><body><main><p>${'A synthetic sentence about tools. '.repeat(10)}</p></main></body></html>`);
    expect(long.article).toBe(false);
    expect(isGood('web', long)).toBe(true);
  });

  it('og:video is kept only when it is a direct https mp4', () => {
    const f = webFromHtml('<meta property="og:video" content="https://cdn.example.test/v.mp4"><meta property="og:title" content="t">');
    expect(f.video).toBe('https://cdn.example.test/v.mp4');
    expect(webFromHtml('<meta property="og:video" content="https://cdn.example.test/player.html">').video).toBeUndefined();
    expect(webFromHtml('<meta property="og:video" content="http://cdn.example.test/v.mp4">').video).toBeUndefined();
  });
});

// ---------------------------------------------------------------- per platform

describe('Instagram', () => {
  const HTML = `<html><head><title>Example Cook on Instagram: "Three ways to cook dal at home"</title>
    <meta property="og:title" content="Example Cook on Instagram: &quot;Three ways to cook dal at home&quot;">
    <meta property="og:description" content="1,234 likes, 56 comments - example_cook on October 30, 2026: &quot;Three ways to cook dal&quot;">
    <meta property="og:url" content="https://www.instagram.com/example_cook/reel/AbC123xyz/">
    <meta property="og:image" content="https://scontent.cdninstagram.com/v/t51/cover.jpg?sig=synthetic">
  </head><body></body></html>`;

  it('og tags: the caption, the name, the handle, the date and the cover on the CDN', () => {
    const f = instagramFromHtml(HTML);
    expect(f).toMatchObject({ text: 'Three ways to cook dal at home', creator: 'Example Cook', handle: '@example_cook', cover: 'https://scontent.cdninstagram.com/v/t51/cover.jpg?sig=synthetic' });
    expect(f.postedAt).toBe('2026-10-30T12:00:00.000Z');
    expect(isGood('instagram', f)).toBe(true);
  });

  it('a reel with no caption is still good: its creator and its cover (the content is on screen or spoken)', () => {
    const f = instagramFromHtml(
      '<html><head><title>Example Cook on Instagram</title><meta property="og:title" content="Example Cook on Instagram"><meta property="og:description" content="1,204 likes, 33 comments - example_cook on October 30, 2026"><meta property="og:image" content="https://scontent.cdninstagram.com/cover.jpg"></head></html>',
    );
    expect(f).toMatchObject({ text: '', creator: 'Example Cook', handle: '@example_cook', cover: 'https://scontent.cdninstagram.com/cover.jpg' });
    expect(f.why).toBeUndefined();
    expect(isGood('instagram', f)).toBe(true);
    // No picture or video, or no creator: not good.
    expect(isGood('instagram', { ...f, cover: undefined })).toBe(false);
    expect(isGood('instagram', { ...f, creator: undefined, handle: undefined })).toBe(false);
    // A login wall stays a hard stop, whatever else the page has.
    expect(isGood('instagram', { ...f, why: 'login' })).toBe(false);
    // The same for a media-only X post and a TikTok with no caption; LinkedIn still needs its text.
    const media: PageFields = { text: '', creator: 'Example Person', handle: '@example_person', meta: [], images: ['https://pbs.twimg.com/a.jpg'], frames: [] };
    expect(isGood('x', media)).toBe(true);
    expect(isGood('tiktok', { ...media, images: [], video: 'https://v16.tiktokcdn.com/v.mp4' })).toBe(true);
    expect(isGood('linkedin', media)).toBe(false);
  });

  it('the app shell is a login wall; a cover off the CDN is dropped', () => {
    const shell = instagramFromHtml('<html><head><title>Instagram</title></head></html>');
    expect(shell.why).toBe('login');
    expect(isGood('instagram', shell)).toBe(false);
    expect(instagramFromHtml(HTML.replace('scontent.cdninstagram.com', 'cdn.example.test')).cover).toBeUndefined();
  });

  it('splits og:title and og:description; anything else gives nothing', () => {
    expect(splitOgTitle('Example Cook on Instagram: "A caption"')).toEqual({ name: 'Example Cook', caption: 'A caption' });
    expect(splitOgTitle('Just a title')).toEqual({});
    expect(splitOgDescription('10 likes - example_cook on March 12, 2025: "x"')).toEqual({ handle: 'example_cook', date: 'March 12, 2025' });
    expect(splitOgDescription('no dash here')).toEqual({});
  });

  it('an in-page read: media kept only on the CDN; a login page says so', () => {
    const f = instagramFromPage(
      page({
        finalUrl: 'https://www.instagram.com/reel/AbC123xyz/',
        text: 'A caption from the page',
        author: 'Example Cook',
        media: [
          { kind: 'video', url: 'https://scontent.cdninstagram.com/v.mp4' },
          { kind: 'image', url: 'https://cdn.example.test/other.jpg' },
        ],
      }),
    );
    expect(f.video).toBe('https://scontent.cdninstagram.com/v.mp4');
    expect(f.images).toEqual([]);
    expect(instagramFromPage(page({ finalUrl: 'https://www.instagram.com/accounts/login/' })).why).toBe('login');
  });
});

describe('YouTube', () => {
  const WATCH = `<html lang="en"><head><meta itemprop="datePublished" content="2026-10-29"></head><body><script>var ytInitialPlayerResponse = {"responseContext":{},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=AbCdEfGhIjK","languageCode":"hi","kind":"asr"}]}},"videoDetails":{"videoId":"AbCdEfGhIjK","title":"Example video \\u0026 more","lengthSeconds":"125","keywords":["example","synthetic"],"author":"Example Channel","shortDescription":"A synthetic description.\\nSecond line."}};</script></body></html>`;

  it('oEmbed, then the watch page\'s details and caption languages', () => {
    const f = youtubeFromWatch(WATCH, youtubeFromOembed({ title: 'From oEmbed', author_name: 'Example Channel' }));
    expect(f).toMatchObject({ title: 'Example video & more', creator: 'Example Channel', duration: 125, text: 'A synthetic description.\nSecond line.', youtube: { lang: 'hi', captions: true } });
    expect(f.postedAt).toBe('2026-10-29T12:00:00.000Z');
    expect(f.meta).toContainEqual({ k: 'keywords', v: 'example, synthetic' });
    expect(isGood('youtube', f)).toBe(true);
  });

  it('oEmbed alone is good (a title and a creator); no page and no oEmbed is not', () => {
    expect(isGood('youtube', youtubeFromOembed({ title: 'Example video', author_name: 'Example Channel' }))).toBe(true);
    expect(isGood('youtube', youtubeFromOembed(null))).toBe(false);
  });

  it('frames and covers come from i.ytimg.com by id', () => {
    expect(ytFrameUrls('AbCdEfGhIjK')).toEqual([1, 2, 3].map((n) => `https://i.ytimg.com/vi/AbCdEfGhIjK/hq${n}.jpg`));
    expect(ytCoverUrls('AbCdEfGhIjK')).toEqual(['https://i.ytimg.com/vi/AbCdEfGhIjK/maxresdefault.jpg', 'https://i.ytimg.com/vi/AbCdEfGhIjK/hqdefault.jpg']);
  });
});

describe('TikTok, X, Reddit, LinkedIn', () => {
  it('TikTok oEmbed: the caption, the creator, the handle, a cover on its CDN; the region page', () => {
    const f = tiktokFromOembed({ title: 'A synthetic dance', author_name: 'Example Dancer', author_unique_id: 'example.dancer', thumbnail_url: 'https://p16-sign.tiktokcdn.com/cover.jpeg' });
    expect(f).toMatchObject({ text: 'A synthetic dance', creator: 'Example Dancer', handle: '@example.dancer', cover: 'https://p16-sign.tiktokcdn.com/cover.jpeg' });
    expect(tiktokFromOembed({ title: 't', thumbnail_url: 'https://cdn.example.test/c.jpg' }).cover).toBeUndefined();
    expect(isTiktokRegionPage('https://www.tiktok.com/in/about')).toBe(true);
    expect(isTiktokRegionPage('https://www.tiktok.com/@example/video/1234567890')).toBe(false);
    expect(tiktokFromPage(page({ finalUrl: 'https://www.tiktok.com/in/about' })).why).toBe('tiktok');
  });

  it('X: the syndication token is react-tweet\'s formula', () => {
    const id = '1850000000000000000';
    expect(syndicationToken(id)).toBe(((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ''));
  });

  it('X syndication: text, user, time, photos and the smallest mp4 at 360p or more, on X\'s own hosts', () => {
    const f = xFromSyndication({
      text: 'A synthetic post',
      user: { name: 'Example Person', screen_name: 'example_person' },
      created_at: '2026-10-30T08:00:00.000Z',
      photos: [{ url: 'https://pbs.twimg.com/media/a.jpg' }, { url: 'https://cdn.example.test/b.jpg' }],
      mediaDetails: [
        {
          media_url_https: 'https://pbs.twimg.com/poster.jpg',
          video_info: {
            duration_millis: 30_000,
            variants: [
              { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/pl.m3u8' },
              { content_type: 'video/mp4', bitrate: 256_000, url: 'https://video.twimg.com/vid/320x180/a.mp4' },
              { content_type: 'video/mp4', bitrate: 832_000, url: 'https://video.twimg.com/vid/640x360/b.mp4' },
              { content_type: 'video/mp4', bitrate: 2_176_000, url: 'https://video.twimg.com/vid/1280x720/c.mp4' },
              { content_type: 'video/mp4', bitrate: 100, url: 'https://cdn.example.test/vid/640x360/d.mp4' },
            ],
          },
        },
      ],
    });
    expect(f).toMatchObject({ text: 'A synthetic post', creator: 'Example Person', handle: '@example_person', postedAt: '2026-10-30T08:00:00.000Z', images: ['https://pbs.twimg.com/media/a.jpg'], video: 'https://video.twimg.com/vid/640x360/b.mp4', duration: 30, cover: 'https://pbs.twimg.com/poster.jpg' });
    expect(pickXVariant([{ content_type: 'video/mp4', bitrate: 1, url: 'https://video.twimg.com/vid/320x180/a.mp4' }])).toBe('https://video.twimg.com/vid/320x180/a.mp4');
    expect(pickXVariant('nope')).toBeUndefined();
  });

  it('X oEmbed: the blockquote\'s text before its byline', () => {
    const f = xFromOembed({ html: '<blockquote class="twitter-tweet"><p lang="en">A synthetic post text</p>&mdash; Example Person (@example_person) <a href="https://x.com/i/status/1">Oct 30, 2026</a></blockquote>', author_name: 'Example Person' });
    expect(f.text).toBe('A synthetic post text');
    expect(f.creator).toBe('Example Person');
  });

  it('Reddit oEmbed: the title and u/author only (a partial read); an in-page read never keeps a video', () => {
    const f = redditFromOembed({ title: 'A synthetic thread', author_name: 'example_redditor' });
    expect(f).toMatchObject({ title: 'A synthetic thread', creator: 'u/example_redditor', text: '' });
    expect(isGood('reddit', f)).toBe(false);
    const p = redditFromPage(page({ text: 'Body', media: [{ kind: 'video', url: 'https://v.redd.it/x/DASH_720.mp4' }], comments: [{ author: 'u/a', text: 'A comment' }] }));
    expect(p.video).toBeUndefined();
    expect(isGood('reddit', p)).toBe(true);
  });

  it('LinkedIn: ld+json SocialMediaPosting, ten comments at most, a cover on licdn; the authwall is a login', () => {
    const comments = Array.from({ length: 12 }, (_v, i) => ({ '@type': 'Comment', author: { name: `Example Commenter ${i}` }, text: `Synthetic comment ${i}` }));
    const ld = { '@context': 'https://schema.org', '@type': 'SocialMediaPosting', headline: 'A synthetic post', articleBody: 'The full synthetic post body.', author: { '@type': 'Person', name: 'Example Founder' }, datePublished: '2026-10-28T09:00:00Z', image: { url: 'https://media.licdn.com/dms/image/x.jpg' }, comment: comments };
    const f = linkedinFromHtml(`<html><head><title>A synthetic post | LinkedIn</title><script type="application/ld+json">${JSON.stringify(ld)}</script></head></html>`);
    expect(f).toMatchObject({ text: 'The full synthetic post body.', title: 'A synthetic post', creator: 'Example Founder', postedAt: '2026-10-28T09:00:00.000Z', cover: 'https://media.licdn.com/dms/image/x.jpg' });
    expect(f.comments).toHaveLength(10);
    expect(isGood('linkedin', f)).toBe(true);
    expect(linkedinFromHtml('<html><head><title>Sign Up | LinkedIn</title></head></html>').why).toBe('login');
  });
});

describe('yt-dlp\'s -J as page fields', () => {
  it('title, description, uploader, time and duration; anything else is empty', () => {
    const f: PageFields = ytdlpFields({ title: 'Example clip', description: 'A synthetic clip.', uploader: 'Example Uploader', timestamp: 1_793_000_000, duration: 42 });
    expect(f).toMatchObject({ title: 'Example clip', text: 'A synthetic clip.', creator: 'Example Uploader', duration: 42 });
    expect(f.postedAt).toMatch(/^2026-/);
    expect(ytdlpFields('nope')).toEqual({ text: '', meta: [], images: [], frames: [] });
  });
});

describe("the item's creator", () => {
  it('the name and the handle, so a search for either finds it; the handle only once', () => {
    expect(creatorOf({ creator: 'Example Cook', handle: '@example_cook' })).toBe('Example Cook @example_cook');
    expect(creatorOf({ creator: 'example_cook', handle: '@example_cook' })).toBe('example_cook');
    expect(creatorOf({ handle: '@example_cook' })).toBe('@example_cook');
    expect(creatorOf({ creator: 'Example Channel' })).toBe('Example Channel');
    expect(creatorOf({})).toBeUndefined();
  });
});
