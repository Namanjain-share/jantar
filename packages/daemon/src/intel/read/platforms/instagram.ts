/**
 * Instagram (spec 3.6): the post page's og tags, which the honest User-Agent
 * gets in full, or an in-page read.
 *
 *   og:title        `<Name> on Instagram: "<caption>"`
 *   og:description  `<likes>, <comments> - <handle> on <Month d, yyyy>: "<caption…>"`
 *   og:url          `https://www.instagram.com/<handle>/reel/<code>/`
 *   og:image        the cover (a signed CDN URL, fetched at once)
 *
 * Media URLs from a read are kept only on Instagram's CDNs.
 */
import type { PageReadParsed } from '@jantar/protocol';
import { metaOf, readHtml } from '../html.js';
import { body, claudeMeta, emptyFields, fromPageRead, httpsUrl, isShellTitle, isoOf, line, type PageFields } from './common.js';

const CDN = ['cdninstagram.com', 'fbcdn.net'];

function onCdn(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return CDN.some((c) => h === c || h.endsWith(`.${c}`)) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** `<Name> on Instagram: "<caption>"` → name and caption (the quotes optional). */
export function splitOgTitle(t: string | undefined): { name?: string; caption?: string } {
  if (!t) return {};
  const marker = ' on Instagram';
  const at = t.indexOf(marker);
  if (at < 0) return {};
  const name = t.slice(0, at).trim();
  let rest = t.slice(at + marker.length).trim();
  if (rest.startsWith(':')) rest = rest.slice(1).trim();
  if (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) rest = rest.slice(1, -1);
  return { ...(name ? { name } : {}), ...(rest ? { caption: rest } : {}) };
}

/** The handle and date in og:description (`... - <handle> on March 12, 2025: ...`). */
export function splitOgDescription(d: string | undefined): { handle?: string; date?: string } {
  if (!d) return {};
  const dash = d.indexOf(' - ');
  if (dash < 0) return {};
  const rest = d.slice(dash + 3, dash + 3 + 200);
  const m = /^([A-Za-z0-9._]{1,30}) on ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(rest);
  if (!m) return {};
  return { handle: m[1] as string, date: m[2] as string };
}

/** The handle in og:url's path (`/<handle>/reel/<code>/`). */
function handleOfUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const m = /^\/([A-Za-z0-9._]{1,30})\/(reel|p|tv)\//.exec(new URL(u).pathname);
    return m ? (m[1] as string) : undefined;
  } catch {
    return undefined;
  }
}

function fromMeta(f: PageFields, meta: { k: string; v: string }[]): PageFields {
  const og = splitOgTitle(metaOf(meta, 'og:title'));
  const desc = splitOgDescription(metaOf(meta, 'og:description', 'description'));
  if (!f.text && og.caption) f.text = body(og.caption, 40_000);
  if (!f.creator && og.name) f.creator = line(og.name, 80);
  const handle = f.handle ?? desc.handle ?? handleOfUrl(metaOf(meta, 'og:url'));
  if (handle) f.handle = handle.startsWith('@') ? handle : `@${handle}`;
  if (!f.postedAt && desc.date) {
    // "October 30, 2026" has no zone: noon UTC keeps the day the same everywhere.
    const at = isoOf(`${desc.date} 12:00 UTC`);
    if (at) f.postedAt = at;
  }
  if (!f.cover) f.cover = onCdn(httpsUrl(metaOf(meta, 'og:image')));
  f.meta = claudeMeta(meta);
  return f;
}

/** The downloader's read of the post page. */
export function instagramFromHtml(html: string): PageFields {
  const page = readHtml(html, { textMax: 0 });
  const f = fromMeta(emptyFields(), page.meta);
  const title = page.title ?? metaOf(page.meta, 'og:title');
  if (isShellTitle(title) && !f.text) f.why = 'login';
  return f;
}

/** An in-page read (Chrome or the headless browser). */
export function instagramFromPage(read: PageReadParsed): PageFields {
  const f = fromPageRead(read);
  f.cover = onCdn(f.cover);
  f.images = f.images.map(onCdn).filter((u): u is string => !!u);
  f.video = onCdn(f.video);
  try {
    const path = new URL(read.finalUrl).pathname.toLowerCase();
    if (path.startsWith('/accounts/login') || path.startsWith('/challenge')) f.why = 'login';
  } catch {
    // keep what the read said
  }
  return fromMeta(f, read.meta);
}
