/**
 * The in-page reader (`@jantar/protocol/page-read`, spec 3.7), run as both
 * page tiers run it: its source sent into a fresh page (here a jsdom window
 * built from a synthetic post page at the post's own URL) and its promise
 * awaited. So every test also proves it is self-contained.
 *
 * - It reads the post, not the page: each platform's caption or body,
 *   author, handle, time, top comments (Reddit, LinkedIn), and media on
 *   the platform's own CDN only; never the nav, the account menu or the
 *   comment box, where the synthetic signed-in user's name is planted.
 * - X's focal post, not the reply above it; a web article without its
 *   header, nav, aside, footer or script.
 * - A login wall says `login`, a missing post `not_found`.
 * - Frames: n = min(asked, ceil(duration / 2)) seeked to (k + 0.5) / n;
 *   a tainted canvas or a video that never loads gives none, never an error.
 * - Everything within the daemon's caps (PageReadSchema, strict).
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { POST_PAGES, SIGNED_IN_MARKER, TINY_JPEG_DATA_URL, type PostPageName } from '@jantar/fixtures';
import { PageReadSchema, type IntelPlatform } from '@jantar/protocol';
import { readPage, type PageRead, type PageReadArgs } from '@jantar/protocol/page-read';

const PLATFORM: Record<PostPageName, IntelPlatform> = {
  instagram: 'instagram',
  instagramLogin: 'instagram',
  youtube: 'youtube',
  tiktok: 'tiktok',
  x: 'x',
  reddit: 'reddit',
  linkedin: 'linkedin',
  web: 'web',
  notFound: 'instagram',
};

type Win = JSDOM['window'] & { eval(code: string): unknown };

/** A fresh page at `url` holding `html`; `prepare` may stub what jsdom lacks (a video, a canvas, the clock). */
function pageOf(html: string, url: string, prepare?: (w: Win) => void): Win {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window as Win;
  prepare?.(w);
  return w;
}

/** Run readPage in the page as a tier does: its source, then its args as JSON. */
async function run(w: Win, args: PageReadArgs): Promise<PageRead> {
  return (await (w.eval(`(${readPage.toString()})(${JSON.stringify(args)})`) as Promise<PageRead>)) as PageRead;
}

async function read(name: PostPageName, over: Partial<PageReadArgs> = {}, prepare?: (w: Win) => void): Promise<PageRead> {
  const p = POST_PAGES[name];
  const out = await run(pageOf(p.html, p.url, prepare), { platform: PLATFORM[name], frames: 0, textMax: 40_000, ...over });
  // Every read passes the daemon's own strict check.
  expect(PageReadSchema.strict().safeParse(out).success, JSON.stringify(PageReadSchema.strict().safeParse(out).error?.issues)).toBe(true);
  return out;
}

describe('readPage reads the post, not the page', () => {
  for (const name of ['instagram', 'youtube', 'tiktok', 'x', 'reddit', 'linkedin', 'web'] as const) {
    it(`${name}: the post's own words and author; nothing of the signed-in user`, async () => {
      const page = POST_PAGES[name];
      const r = await read(name);
      expect(r.finalUrl).toBe(page.url);
      expect(r.text).toContain(page.caption);
      if (page.author) expect(r.author).toBe(page.author);
      if (page.handle) expect(r.handle).toBe(page.handle);
      expect(JSON.stringify(r)).not.toContain(SIGNED_IN_MARKER);
      expect(r.why).toBeUndefined();
    });
  }

  it('instagram: the caption, the time, the post image, the poster and the embedded file; never the avatar or another host', async () => {
    const r = await read('instagram');
    expect(r.publishedAt).toBe('2026-10-30T08:00:00.000Z');
    expect(r.title).toBe('Example Cook on Instagram: "Three ways to cook dal at home."');
    expect(r.meta).toContainEqual({ k: 'og:image', v: 'https://scontent.cdninstagram.com/v/synthetic/cover.jpg' });
    expect(r.media).toEqual([
      { kind: 'image', url: 'https://scontent.cdninstagram.com/v/synthetic/slide1.jpg', w: 1080, h: 1350 },
      { kind: 'image', url: 'https://scontent.cdninstagram.com/v/synthetic/poster.jpg' },
      { kind: 'video', url: 'https://scontent.cdninstagram.com/v/synthetic/reel.mp4?a=1&b=2' },
    ]);
  });

  it("x: the focal post (its status id), not the reply above it; its photo; the tab's unread count dropped from the title", async () => {
    const r = await read('x');
    expect(r.text).not.toContain('A reply above the post');
    expect(r.publishedAt).toBe('2026-10-30T09:15:00.000Z');
    expect(r.media).toEqual([{ kind: 'image', url: 'https://pbs.twimg.com/media/SyntheticA.jpg', w: 1200, h: 675 }]);
    expect(r.title?.startsWith('Example Dev on X')).toBe(true);
  });

  it('reddit: the title and body, the top-level comments only', async () => {
    const r = await read('reddit');
    expect(r.text.startsWith('Simple backups for a home server')).toBe(true);
    expect(r.publishedAt).toBe('2026-10-28T12:00:00.000Z');
    expect(r.comments).toEqual([
      { author: 'example_helper', text: 'Use one tool and test restores.' },
      { author: 'example_second', text: 'Two copies, one off site.' },
    ]);
  });

  it('linkedin: the post text, its image, its comment; the comment box is not a comment', async () => {
    const r = await read('linkedin');
    expect(r.comments).toEqual([{ author: 'Example Reader', text: 'Congrats on shipping.' }]);
    expect(r.media).toEqual([{ kind: 'image', url: 'https://media.licdn.com/dms/image/synthetic/post.jpg', w: 1200, h: 627 }]);
  });

  it('youtube: the title and description, the channel, the published date from the page', async () => {
    const r = await read('youtube');
    expect(r.text.startsWith('A synthetic kitchen garden')).toBe(true);
    expect(r.text).not.toContain('Up next');
    expect(r.publishedAt).toBe('2026-10-01T10:00:00-07:00');
  });

  it('web: the article without its header, nav, aside, footer or script; the author from the meta', async () => {
    const r = await read('web');
    expect(r.text).toContain('Second paragraph.');
    for (const gone of ['Related: something else', '© Example', 'window.x', 'Home · Blog']) expect(r.text).not.toContain(gone);
    expect(r.publishedAt).toBe('2026-10-20T07:00:00Z');
    expect(r.media).toEqual([]);
  });

  it('a login wall says login; a missing post says not_found; neither has text', async () => {
    expect(await read('instagramLogin')).toMatchObject({ text: '', why: 'login' });
    expect(await read('notFound')).toMatchObject({ text: '', why: 'not_found' });
  });
});

describe('readPage keeps to its caps', () => {
  it('the text to textMax, 60 meta pairs, 5 ld+json blocks of 50,000, 12 media', async () => {
    const metas = Array.from({ length: 80 }, (_, i) => `<meta property="og:x${i}" content="${'v'.repeat(3000)}">`).join('');
    const lds = Array.from({ length: 8 }, () => `<script type="application/ld+json">${'x'.repeat(60_000)}</script>`).join('');
    const imgs = Array.from({ length: 20 }, (_, i) => `<img src="https://pbs.twimg.com/media/S${i}.jpg" width="800" height="600">`).join('');
    const html = `<!doctype html><html><head>${metas}${lds}</head><body><main><article data-testid="tweet"><div data-testid="tweetText">${'word '.repeat(5000)}</div>${imgs}</article></main></body></html>`;
    const r = await run(pageOf(html, 'https://x.com/i/status/1850000000000000001'), { platform: 'x', frames: 0, textMax: 1000 });
    expect(r.text.length).toBeLessThanOrEqual(1000);
    expect(r.meta).toHaveLength(60);
    expect(r.meta.every((m) => m.v.length <= 2000)).toBe(true);
    expect(r.jsonld).toHaveLength(5);
    expect(r.jsonld.every((j) => j.length === 50_000)).toBe(true);
    expect(r.media).toHaveLength(12);
    expect(PageReadSchema.strict().safeParse(r).success).toBe(true);
  });

  it('a deep, wide hostile page reads fast and stays in bounds', async () => {
    const deep = `${'<div>'.repeat(3000)}deep${'</div>'.repeat(3000)}`;
    const wide = '<span>x</span>'.repeat(20_000);
    const html = `<!doctype html><html><body><article>${deep}${wide}</article></body></html>`;
    const w = pageOf(html, 'https://example.com/a');
    const started = Date.now();
    const r = await run(w, { platform: 'web', frames: 0, textMax: 40_000 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.text.length).toBeLessThanOrEqual(40_000);
    expect(r.text).toContain('deep');
  });

  it('holds no URL literal and imports nothing: its source runs in a fresh page', () => {
    const src = readFileSync(new URL('../../protocol/src/page-read.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/https?:\/\//);
    expect(src.match(/^import\b.*$/gm)).toEqual(["import type { IntelPlatform } from './intel.js';"]);
  });
});

/** A <video> that loads `duration` seconds and seeks at once, and a canvas that draws (jsdom has neither). */
function playable(duration: number, opts: { taint?: boolean; never?: boolean } = {}) {
  const seeks: number[] = [];
  const prepare = (w: Win) => {
    const video = w.document.querySelector('video');
    if (!video) throw new Error('no video on the page');
    let now = 0;
    Object.defineProperties(video, {
      readyState: { get: () => (opts.never ? 0 : 4) },
      duration: { get: () => (opts.never ? Number.NaN : duration) },
      videoWidth: { get: () => 1280 },
      videoHeight: { get: () => 720 },
      currentTime: {
        get: () => now,
        set: (t: number) => {
          now = t;
          seeks.push(t);
          setTimeout(() => video.dispatchEvent(new w.Event('seeked')), 0);
        },
      },
      pause: { value: () => undefined },
    });
    const proto = w.HTMLCanvasElement.prototype as unknown as { getContext: () => unknown; toDataURL: () => string };
    proto.getContext = () => ({ drawImage: () => undefined });
    proto.toDataURL = () => {
      if (opts.taint) throw new w.DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
      return TINY_JPEG_DATA_URL;
    };
    // The page's clock 100 times faster: the 8 s load wait takes 80 ms here.
    const fast = w.setTimeout.bind(w);
    (w as unknown as { setTimeout: (fn: () => void, ms: number) => unknown }).setTimeout = (fn: () => void, ms: number) => fast(fn, Math.ceil((ms ?? 0) / 100));
  };
  return { prepare, seeks };
}

describe('readPage frames', () => {
  it('a 10 s reel asked for 4: four frames at (k + 0.5) / 4 of it, with the times and the duration', async () => {
    const v = playable(10);
    const r = await read('instagram', { frames: 4 }, v.prepare);
    expect(r.duration).toBe(10);
    expect(v.seeks).toEqual([1.25, 3.75, 6.25, 8.75]);
    expect(r.frames).toEqual([1.3, 3.8, 6.3, 8.8].map((at) => ({ at, jpeg: TINY_JPEG_DATA_URL })));
  });

  it('a 3 s clip asked for 4 gets ceil(3 / 2) = 2; asked for 0, none and no seek', async () => {
    const two = playable(3);
    expect((await read('tiktok', { frames: 4 }, two.prepare)).frames).toHaveLength(2);
    const none = playable(3);
    const r = await read('tiktok', { frames: 0 }, none.prepare);
    expect(r.frames).toEqual([]);
    expect(none.seeks).toEqual([]);
    expect(r.duration).toBe(3);
  });

  it('a tainted canvas gives no frames, never an error', async () => {
    const v = playable(10, { taint: true });
    const r = await read('instagram', { frames: 4 }, v.prepare);
    expect(r.frames).toEqual([]);
    expect(r.text).toContain(POST_PAGES.instagram.caption);
  });

  it('a video that never loads gives no frames after the load wait, never an error', async () => {
    const v = playable(10, { never: true });
    const r = await read('youtube', { frames: 4 }, v.prepare);
    expect(r.frames).toEqual([]);
    expect(r.duration).toBeUndefined();
    expect(v.seeks).toEqual([]);
  });
});
