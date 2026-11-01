/**
 * Tier 3a, the downloader (spec 3.6): the daemon's own guarded HTTPS fetch
 * of public pages and endpoints, with the honest User-Agent and no cookies.
 *
 *   instagram  the post page's og tags
 *   youtube    oEmbed, then the watch page's player JSON
 *   tiktok     oEmbed (a redirect to a region page: the TikTok reason)
 *   x          the syndication JSON, else publish.x.com's oEmbed
 *   reddit     oEmbed: title and author only (a partial read: the reddit reason)
 *   linkedin   the post page's ld+json SocialMediaPosting
 *   web        the page's HTML
 *
 * PDFs are fetched by the pipeline (the file goes to the media helper).
 * Adapters are pure (platforms/*.ts); this file only fetches.
 */
import { INTEL_READ_LIMITS } from '@jantar/protocol';
import type { Fetched, Guard } from '../guard.js';
import { instagramFromHtml } from '../platforms/instagram.js';
import { isGood, type PageFields } from '../platforms/common.js';
import { isTiktokRegionPage, linkedinFromHtml, redditFromOembed, syndicationToken, tiktokFromOembed, xFromOembed, xFromSyndication } from '../platforms/social.js';
import { webFromHtml } from '../platforms/web.js';
import { youtubeFromOembed, youtubeFromWatch } from '../platforms/youtube.js';
import { chromeUrlOf, type LinkKind } from '../url.js';

/** Why a tier did not read the post (INTEL_READ_REASONS keys, or `failed`). */
export type TierWhy = 'notFound' | 'login' | 'reddit' | 'tiktok' | 'timeout' | 'tooBig' | 'blocked' | 'failed' | 'unavailable';

export type TierOutcome = { ok: true; fields: PageFields } | { ok: false; why: TierWhy; partial?: PageFields };

/** A guard failure as a tier's reason. */
export function whyOf(r: Extract<Fetched, { ok: false }>): TierWhy {
  switch (r.why) {
    case 'notFound':
      return 'notFound';
    case 'blocked':
      return 'blocked';
    case 'timeout':
    case 'aborted':
      return 'timeout';
    case 'tooBig':
      return 'tooBig';
    case 'status':
      return r.status === 401 || r.status === 403 ? 'login' : 'failed';
    default:
      return 'failed';
  }
}

async function text(guard: Guard, url: string, kind: 'html' | 'json', signal?: AbortSignal): Promise<{ ok: true; text: string; url: string } | { ok: false; r: Extract<Fetched, { ok: false }> }> {
  const r = await guard.fetch(url, { kind, maxBytes: INTEL_READ_LIMITS.pageBytes, totalMs: INTEL_READ_LIMITS.pageMs, ...(signal ? { signal } : {}) });
  if (!r.ok) return { ok: false, r };
  return { ok: true, text: r.body.toString('utf8'), url: r.url };
}

function json(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function done(platform: LinkKind['platform'], f: PageFields, otherwise: TierWhy = 'notFound'): TierOutcome {
  if (isGood(platform, f)) return { ok: true, fields: f };
  return { ok: false, why: f.why === 'login' ? 'login' : f.why === 'notFound' ? 'notFound' : otherwise, partial: f };
}

/** The downloader's read of `link` (canonical) of `kind`. */
export async function downloadRead(guard: Guard, link: string, kind: LinkKind, signal?: AbortSignal): Promise<TierOutcome> {
  const post = kind.post;
  switch (kind.platform) {
    case 'instagram': {
      const page = await text(guard, chromeUrlOf(post) ?? link, 'html', signal);
      if (!page.ok) return { ok: false, why: whyOf(page.r) };
      return done('instagram', instagramFromHtml(page.text), 'login');
    }
    case 'youtube': {
      const v = post?.parts.v;
      if (!v) return { ok: false, why: 'notFound' };
      const watch = `https://www.youtube.com/watch?v=${v}`;
      const o = await text(guard, `https://www.youtube.com/oembed?url=${encodeURIComponent(chromeUrlOf(post) ?? watch)}&format=json`, 'json', signal);
      const f = o.ok ? youtubeFromOembed(json(o.text)) : youtubeFromOembed(null);
      const page = await text(guard, watch, 'html', signal);
      if (page.ok) youtubeFromWatch(page.text, f);
      if (!o.ok && !page.ok) return { ok: false, why: whyOf(o.r) };
      return done('youtube', f);
    }
    case 'tiktok': {
      const o = await text(guard, `https://www.tiktok.com/oembed?url=${encodeURIComponent(chromeUrlOf(post) ?? link)}`, 'json', signal);
      if (!o.ok) return { ok: false, why: o.r.url && isTiktokRegionPage(o.r.url) ? 'tiktok' : whyOf(o.r) };
      if (isTiktokRegionPage(o.url)) return { ok: false, why: 'tiktok' };
      return done('tiktok', tiktokFromOembed(json(o.text)));
    }
    case 'x': {
      const id = post?.parts.id;
      if (!id) return { ok: false, why: 'notFound' };
      const s = await text(guard, `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${syndicationToken(id)}`, 'json', signal);
      if (s.ok) {
        const f = xFromSyndication(json(s.text));
        if (isGood('x', f)) return { ok: true, fields: f };
      }
      const o = await text(guard, `https://publish.x.com/oembed?url=${encodeURIComponent(`https://x.com/i/status/${id}`)}&omit_script=1`, 'json', signal);
      if (!o.ok) return { ok: false, why: whyOf(o.r) };
      return done('x', xFromOembed(json(o.text)));
    }
    case 'reddit': {
      const o = await text(guard, `https://www.reddit.com/oembed?url=${encodeURIComponent(chromeUrlOf(post) ?? link)}`, 'json', signal);
      if (!o.ok) return { ok: false, why: o.r.why === 'notFound' ? 'notFound' : 'reddit' };
      // Title and author only: the thread needs the user's Chrome.
      return { ok: false, why: 'reddit', partial: redditFromOembed(json(o.text)) };
    }
    case 'linkedin': {
      const page = await text(guard, link, 'html', signal);
      if (!page.ok) return { ok: false, why: whyOf(page.r) };
      return done('linkedin', linkedinFromHtml(page.text), 'login');
    }
    case 'web': {
      const page = await text(guard, link, 'html', signal);
      if (!page.ok) return { ok: false, why: whyOf(page.r) };
      return done('web', webFromHtml(page.text));
    }
    default:
      return { ok: false, why: 'unavailable' };
  }
}
