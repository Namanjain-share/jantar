/**
 * TikTok, X, Reddit and LinkedIn (spec 3.6): each one's public JSON or page
 * shape, and its in-page read.
 *
 * - TikTok: oEmbed (title = caption, author_name, author_unique_id,
 *   thumbnail_url). A redirect to a region page (`/in/about`, …) ends the
 *   tiers with the TikTok reason.
 * - X: the syndication JSON (text, user, created_at, photos, the mp4
 *   variants: the smallest at 360p or more), else publish.x.com's oEmbed (a
 *   blockquote whose text is read).
 * - Reddit: oEmbed (title, author) only: a partial read, the thread itself
 *   needs the user's Chrome.
 * - LinkedIn: ld+json `SocialMediaPosting` (articleBody, author,
 *   datePublished, image, comment[] ≤ 10).
 */
import type { PageReadParsed } from '@jantar/protocol';
import { ldIs, ldObjects, metaOf, readHtml } from '../html.js';
import { body, claudeMeta, emptyFields, fromPageRead, httpsUrl, isoOf, line, type PageFields } from './common.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function onHosts(url: string | undefined, hosts: readonly string[]): string | undefined {
  if (!url) return undefined;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return hosts.some((c) => h === c || h.endsWith(`.${c}`)) ? url : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ TikTok

/** Whether a final URL is TikTok's region page (it sends this Mac there today). */
export function isTiktokRegionPage(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)tiktok\.com$/.test(u.hostname) && /^\/[a-z]{2}\/about\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

export function tiktokFromOembed(json: unknown): PageFields {
  const f = emptyFields();
  if (!isObj(json)) return f;
  f.text = body(json.title, 4000);
  const author = line(json.author_name, 80);
  if (author) f.creator = author;
  const handle = line(json.author_unique_id, 40);
  if (handle) f.handle = `@${handle}`;
  f.cover = onHosts(httpsUrl(json.thumbnail_url), ['tiktokcdn.com', 'tiktokcdn-us.com']);
  return f;
}

export function tiktokFromPage(read: PageReadParsed): PageFields {
  const f = fromPageRead(read);
  f.cover = onHosts(f.cover, ['tiktokcdn.com', 'tiktokcdn-us.com']);
  f.video = onHosts(f.video, ['tiktokcdn.com', 'tiktokcdn-us.com']);
  f.images = f.images.map((u) => onHosts(u, ['tiktokcdn.com', 'tiktokcdn-us.com'])).filter((u): u is string => !!u);
  if (isTiktokRegionPage(read.finalUrl)) f.why = 'tiktok';
  return f;
}

// ------------------------------------------------------------------ X

/** The syndication endpoint's token for a post id (react-tweet's formula). */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

/** The mp4 variant to read: the smallest at 360p or more (else the smallest), on video.twimg.com. */
export function pickXVariant(variants: unknown): string | undefined {
  if (!Array.isArray(variants)) return undefined;
  const mp4 = variants
    .filter(isObj)
    .filter((v) => v.content_type === 'video/mp4')
    .map((v) => {
      const url = onHosts(httpsUrl(v.url), ['video.twimg.com']);
      const size = url ? /\/(\d{2,4})x(\d{2,4})\//.exec(url) : null;
      const short = size ? Math.min(Number(size[1]), Number(size[2])) : 0;
      return { url, bitrate: typeof v.bitrate === 'number' ? v.bitrate : 0, short };
    })
    .filter((v): v is { url: string; bitrate: number; short: number } => !!v.url)
    .sort((a, b) => a.bitrate - b.bitrate);
  return (mp4.find((v) => v.short >= 360) ?? mp4[0])?.url;
}

export function xFromSyndication(json: unknown): PageFields {
  const f = emptyFields();
  if (!isObj(json)) return f;
  f.text = body(json.text, 25_000);
  const user = isObj(json.user) ? json.user : null;
  const name = line(user?.name, 80);
  if (name) f.creator = name;
  const handle = line(user?.screen_name, 40);
  if (handle) f.handle = `@${handle}`;
  const at = isoOf(json.created_at);
  if (at) f.postedAt = at;
  if (Array.isArray(json.photos)) {
    for (const p of json.photos.filter(isObj)) {
      const u = onHosts(httpsUrl(p.url), ['twimg.com']);
      if (u && f.images.length < 4) f.images.push(u);
    }
  }
  if (Array.isArray(json.mediaDetails)) {
    for (const m of json.mediaDetails.filter(isObj)) {
      const info = isObj(m.video_info) ? m.video_info : null;
      if (info && !f.video) {
        const v = pickXVariant(info.variants);
        if (v) f.video = v;
        const ms = Number(info.duration_millis);
        if (Number.isFinite(ms) && ms > 0) f.duration = ms / 1000;
        const poster = onHosts(httpsUrl(m.media_url_https), ['twimg.com']);
        if (poster && !f.cover) f.cover = poster;
      }
    }
  }
  if (!f.cover && f.images.length) f.cover = f.images[0];
  return f;
}

/** publish.x.com's oEmbed: the blockquote's text and the author. */
export function xFromOembed(json: unknown): PageFields {
  const f = emptyFields();
  if (!isObj(json)) return f;
  const html = typeof json.html === 'string' ? json.html.slice(0, 50_000) : '';
  if (html) {
    const p = readHtml(`<article>${html}</article>`, { textMax: 25_000 });
    // The blockquote ends with "— Name (@handle) date": the post's text is before it.
    const dash = p.text.lastIndexOf('— ');
    f.text = body(dash > 0 ? p.text.slice(0, dash) : p.text, 25_000);
  }
  const name = line(json.author_name, 80);
  if (name) f.creator = name;
  return f;
}

export function xFromPage(read: PageReadParsed): PageFields {
  const f = fromPageRead(read);
  f.cover = onHosts(f.cover, ['twimg.com']);
  f.images = f.images.map((u) => onHosts(u, ['twimg.com'])).filter((u): u is string => !!u);
  f.video = onHosts(f.video, ['video.twimg.com']);
  return f;
}

// ------------------------------------------------------------------ Reddit

export function redditFromOembed(json: unknown): PageFields {
  const f = emptyFields();
  if (!isObj(json)) return f;
  const title = line(json.title, 300);
  if (title) f.title = title;
  const author = line(json.author_name, 80);
  if (author) f.creator = author.startsWith('u/') ? author : `u/${author}`;
  return f;
}

export function redditFromPage(read: PageReadParsed): PageFields {
  const f = fromPageRead(read);
  f.cover = onHosts(f.cover, ['redd.it', 'redditmedia.com', 'redditstatic.com']);
  f.images = f.images.map((u) => onHosts(u, ['redd.it', 'redditmedia.com'])).filter((u): u is string => !!u);
  // Reddit's video is DASH: never a file to read.
  delete f.video;
  return f;
}

// ------------------------------------------------------------------ LinkedIn

function authorName(a: unknown): string | undefined {
  if (typeof a === 'string') return line(a, 80);
  if (Array.isArray(a)) return authorName(a[0]);
  return isObj(a) ? line(a.name, 80) : undefined;
}

function imageUrl(v: unknown): string | undefined {
  if (typeof v === 'string') return httpsUrl(v);
  if (Array.isArray(v)) return imageUrl(v[0]);
  return isObj(v) ? httpsUrl(v.url ?? v.contentUrl) : undefined;
}

export function linkedinFromHtml(html: string): PageFields {
  const page = readHtml(html, { textMax: 0 });
  const f = emptyFields();
  f.meta = claudeMeta(page.meta);
  const post = ldObjects(page.jsonld).find((o) => ldIs(o, 'SocialMediaPosting', 'DiscussionForumPosting', 'Article', 'NewsArticle'));
  if (post) {
    f.text = body(post.articleBody ?? post.text, 25_000);
    const headline = line(post.headline, 300);
    if (headline) f.title = headline;
    const author = authorName(post.author);
    if (author) f.creator = author;
    const at = isoOf(post.datePublished);
    if (at) f.postedAt = at;
    f.cover = onHosts(imageUrl(post.image), ['licdn.com']);
    if (Array.isArray(post.comment)) {
      f.comments = post.comment
        .filter(isObj)
        .slice(0, 10)
        .map((c) => ({ author: authorName(c.author) ?? '', text: body(c.text, 500) }))
        .filter((c) => c.text !== '');
    }
  }
  if (!f.text) f.text = body(metaOf(page.meta, 'og:description', 'description'), 4000);
  if (!f.cover) f.cover = onHosts(httpsUrl(metaOf(page.meta, 'og:image')), ['licdn.com']);
  const title = (page.title ?? '').toLowerCase();
  if (!post && (title.includes('sign in') || title.includes('sign up') || title.includes('authwall'))) f.why = 'login';
  return f;
}

export function linkedinFromPage(read: PageReadParsed): PageFields {
  const f = fromPageRead(read);
  f.cover = onHosts(f.cover, ['licdn.com']);
  f.images = f.images.map((u) => onHosts(u, ['licdn.com'])).filter((u): u is string => !!u);
  f.video = onHosts(f.video, ['licdn.com']);
  return f;
}
