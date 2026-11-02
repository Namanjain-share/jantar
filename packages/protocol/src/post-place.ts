/**
 * v0.9 Log a comment: where a comment's link points, read from the link
 * alone. Pure and synchronous: it never fetches, opens or checks the link.
 *
 * Not `post-url.ts`: `chromePostOf` is the Chrome security gate (exact
 * hosts, post shapes only), and a comment link does not match it. This only
 * names the platform by the host (any subdomain of the platform's domains),
 * and Reddit's `r/<sub>` or `u/<name>` from the path's first two segments.
 * On X, Threads and TikTok a reply's link names the user's own handle, and
 * the ids on YouTube and LinkedIn are not readable places, so they get no
 * where (the user can type one). Any other https host is `other`, with the
 * host as the where.
 */
import { POST_LINK_MAX, POST_WHERE_MAX } from './constants.js';
import { PostLinkSchema, type PostPlatform } from './life.js';

/** Where a comment's link points, read from the link alone (never fetched): Reddit's r/<sub> from the path, else the platform. */
export interface PostPlace {
  platform: PostPlatform;
  where?: string;
}

/** Each platform's domains; a domain matches itself and any subdomain. */
const DOMAINS: readonly (readonly [PostPlatform, readonly string[]])[] = [
  ['reddit', ['reddit.com', 'redd.it', 'reddit.app.link']],
  ['x', ['x.com', 'twitter.com']],
  ['linkedin', ['linkedin.com', 'lnkd.in']],
  ['youtube', ['youtube.com', 'youtu.be']],
  ['tiktok', ['tiktok.com']],
  ['threads', ['threads.net', 'threads.com']],
  ['instagram', ['instagram.com']],
  ['facebook', ['facebook.com', 'fb.com', 'fb.watch']],
  ['hn', ['news.ycombinator.com']],
];

const SUB = /^[A-Za-z0-9_]{2,21}$/;
const USER = /^[A-Za-z0-9_-]{3,20}$/;

/** Reddit's where from the path's first two segments: r/<sub> as written, u/<name>, or none. */
function redditWhere(pathname: string): string | undefined {
  const [first, second] = pathname.split('/').filter(Boolean);
  if (first === undefined || second === undefined) return undefined;
  const head = first.toLowerCase();
  if (head === 'r' && SUB.test(second)) return `r/${second}`;
  if ((head === 'user' || head === 'u') && USER.test(second)) return `u/${second}`;
  return undefined;
}

/** The platform and where of an https link, or null when it is not a whole https link (no scheme-less guess). */
export function postPlaceOf(href: string): PostPlace | null {
  const s = href.trim();
  if (s === '' || s.length > POST_LINK_MAX || !PostLinkSchema.safeParse(s).success) return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const on = (d: string) => host === d || host.endsWith(`.${d}`);
  const hit = DOMAINS.find(([, domains]) => domains.some(on));
  if (hit) {
    const [platform] = hit;
    if (platform !== 'reddit') return { platform };
    const where = redditWhere(url.pathname);
    return where ? { platform, where } : { platform };
  }
  const bare = host.replace(/^www\./, '');
  return bare && bare.length <= POST_WHERE_MAX ? { platform: 'other', where: bare } : { platform: 'other' };
}
