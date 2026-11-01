/**
 * v0.8: the post links the user's own Chrome may open (`@jantar/protocol/post-url`).
 *
 * The user's logged-in Chrome is the one place a link acts as the user, so
 * it only ever opens a post on one of six platforms, by exact shape, on the
 * platform's own www host. The daemon reads a saved link with
 * `chromePostOf`, then builds the URL it queues from the platform and the
 * parts alone (`chromePathOf` on CHROME_POST_HOSTS[platform]): the link the
 * user typed is never sent to Chrome as typed. The extension runs the same
 * `chromePostOf` on the job and on every URL its tab reaches, and closes the
 * tab on the first one that is off-shape.
 *
 * Off-shape is everything else on those hosts too: a profile, a link shim
 * (`l.instagram.com`, `out.reddit.com`, `/redirect`, `/redir/redirect`), a
 * login, logout or OAuth page, a subdomain, a port, userinfo, http.
 *
 * Imports nothing and holds no URL literal: the extension bundles it.
 */

/** The platforms whose posts the user's Chrome may open. */
export const CHROME_PLATFORMS = ['instagram', 'youtube', 'tiktok', 'x', 'reddit', 'linkedin'] as const;
export type ChromePlatform = (typeof CHROME_PLATFORMS)[number];

/** Each platform's one host (exact: no other subdomain, no port). */
export const CHROME_POST_HOSTS: Readonly<Record<ChromePlatform, string>> = Object.freeze({
  instagram: 'www.instagram.com',
  youtube: 'www.youtube.com',
  tiktok: 'www.tiktok.com',
  x: 'x.com',
  reddit: 'www.reddit.com',
  linkedin: 'www.linkedin.com',
});

/** What a post link is (the item's type chip). */
export type ChromePostKind = 'reel' | 'post' | 'video' | 'short' | 'thread';

/**
 * A post link read by shape. `parts` holds only ids that matched their
 * pattern; the URL to open is rebuilt from them (chromePathOf).
 * - instagram: { code }       youtube: { v }          tiktok: { user, id }
 * - x: { id }                 reddit: { sub, id } or { sub, share }
 * - linkedin: { urn, id } (urn: activity, share or ugcPost)
 */
export interface ChromePost {
  platform: ChromePlatform;
  kind: ChromePostKind;
  parts: Readonly<Record<string, string>>;
}

// The ids, all anchored where they are used.
const CODE = '[A-Za-z0-9_-]{5,40}';
const VIDEO = '[A-Za-z0-9_-]{11}';
const TT_USER = '[A-Za-z0-9._]{2,24}';
const IG_USER = '[A-Za-z0-9._]{1,30}';
const HANDLE = '[A-Za-z0-9_]{1,15}';
const NUM = '\\d{6,25}';
const SUB = '[A-Za-z0-9_]{2,21}';
const REDDIT_ID = '[a-z0-9]{2,10}';
const SHARE = '[A-Za-z0-9]{6,16}';
const SLUG = '[A-Za-z0-9_%-]{1,200}';
const LI_TAIL = '[A-Za-z0-9_-]{1,16}';
const URN_KINDS = 'activity|share|ugcPost';
const URN = `(${URN_KINDS})`;

/** Anchored around the whole pattern, alternatives included. */
const re = (s: string) => new RegExp(`^(?:${s})$`);

const IG_POST = re(`/(reel|reels|p|tv)/(${CODE})/?`);
const IG_USER_POST = re(`/${IG_USER}/(reel|p)/(${CODE})/?`);
const YT_SHORT = re(`/shorts/(${VIDEO})/?`);
const YT_LIVE = re(`/live/(${VIDEO})/?`);
const YT_V = re(VIDEO);
const TT_POST = re(`/@(${TT_USER})/(video|photo)/(${NUM})/?`);
const X_POST = re(`/(?:${HANDLE}|i|i/web)/status/(${NUM})/?`);
const RD_THREAD = re(`/r/(${SUB})/comments/(${REDDIT_ID})(?:/${SLUG})?/?`);
const RD_SHARE = re(`/r/(${SUB})/s/(${SHARE})/?`);
const LI_POSTS = re(`/posts/${SLUG}-${URN}-(${NUM})-${LI_TAIL}/?`);
const LI_FEED = re(`/feed/update/urn:li:${URN}:(${NUM})/?`);

/** The longest link read (the protocol's link cap). */
const HREF_MAX = 2000;

/** The six hosts, by host. */
function platformOfHost(host: string): ChromePlatform | null {
  for (const p of CHROME_PLATFORMS) if (CHROME_POST_HOSTS[p] === host) return p;
  return null;
}

/**
 * The post a link names, or null when it is not one of the shapes (spec
 * 3.2's table): https, no port, no userinfo, the platform's exact host, the
 * path matching. The query and the hash are ignored, except YouTube's `v`
 * (exactly one, on /watch).
 */
export function chromePostOf(href: string): ChromePost | null {
  if (typeof href !== 'string' || href.length > HREF_MAX) return null;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return null;
  const platform = platformOfHost(u.hostname);
  if (!platform) return null;
  const path = u.pathname;
  let m: RegExpExecArray | null;
  switch (platform) {
    case 'instagram':
      if ((m = IG_POST.exec(path))) return { platform, kind: m[1] === 'p' ? 'post' : 'reel', parts: { code: m[2] as string } };
      if ((m = IG_USER_POST.exec(path))) return { platform, kind: m[1] === 'p' ? 'post' : 'reel', parts: { code: m[2] as string } };
      return null;
    case 'youtube': {
      if (path === '/watch') {
        const vs = u.searchParams.getAll('v');
        const v = vs.length === 1 ? (vs[0] as string) : '';
        return YT_V.test(v) ? { platform, kind: 'video', parts: { v } } : null;
      }
      if ((m = YT_SHORT.exec(path))) return { platform, kind: 'short', parts: { v: m[1] as string } };
      if ((m = YT_LIVE.exec(path))) return { platform, kind: 'video', parts: { v: m[1] as string } };
      return null;
    }
    case 'tiktok':
      if ((m = TT_POST.exec(path))) return { platform, kind: m[2] === 'photo' ? 'post' : 'reel', parts: { user: m[1] as string, id: m[3] as string } };
      return null;
    case 'x':
      if ((m = X_POST.exec(path))) return { platform, kind: 'post', parts: { id: m[1] as string } };
      return null;
    case 'reddit':
      if ((m = RD_THREAD.exec(path))) return { platform, kind: 'thread', parts: { sub: m[1] as string, id: m[2] as string } };
      if ((m = RD_SHARE.exec(path))) return { platform, kind: 'thread', parts: { sub: m[1] as string, share: m[2] as string } };
      return null;
    case 'linkedin':
      if ((m = LI_POSTS.exec(path)) || (m = LI_FEED.exec(path))) return { platform, kind: 'post', parts: { urn: m[1] as string, id: m[2] as string } };
      return null;
  }
}

/** One part, checked against its pattern again (parts never come from anywhere but chromePostOf, and are checked anyway). */
function part(parts: Readonly<Record<string, string>>, key: string, pattern: string): string | null {
  const v = Object.hasOwn(parts, key) ? parts[key] : undefined;
  return typeof v === 'string' && re(pattern).test(v) ? v : null;
}

/**
 * The path (and YouTube's `?v=`) to open on CHROME_POST_HOSTS[platform], rebuilt
 * from the parts alone, or null when a part is missing or off-pattern:
 * `/reel/<c>/` or `/p/<c>/`, `/watch?v=<v>` or `/shorts/<v>`,
 * `/@<u>/video/<n>` or `/@<u>/photo/<n>`, `/i/status/<n>`,
 * `/r/<s>/comments/<r>/` or `/r/<s>/s/<code>`, `/feed/update/urn:li:<urn>:<n>/`.
 */
export function chromePathOf(post: ChromePost): string | null {
  const { platform, kind, parts } = post;
  switch (platform) {
    case 'instagram': {
      const code = part(parts, 'code', CODE);
      if (!code || (kind !== 'reel' && kind !== 'post')) return null;
      return kind === 'post' ? `/p/${code}/` : `/reel/${code}/`;
    }
    case 'youtube': {
      const v = part(parts, 'v', VIDEO);
      if (!v || (kind !== 'video' && kind !== 'short')) return null;
      return kind === 'short' ? `/shorts/${v}` : `/watch?v=${v}`;
    }
    case 'tiktok': {
      const user = part(parts, 'user', TT_USER);
      const id = part(parts, 'id', NUM);
      if (!user || !id || (kind !== 'reel' && kind !== 'post')) return null;
      return `/@${user}/${kind === 'post' ? 'photo' : 'video'}/${id}`;
    }
    case 'x': {
      const id = part(parts, 'id', NUM);
      return id && kind === 'post' ? `/i/status/${id}` : null;
    }
    case 'reddit': {
      const sub = part(parts, 'sub', SUB);
      if (!sub || kind !== 'thread') return null;
      const id = part(parts, 'id', REDDIT_ID);
      if (id) return `/r/${sub}/comments/${id}/`;
      const share = part(parts, 'share', SHARE);
      return share ? `/r/${sub}/s/${share}` : null;
    }
    case 'linkedin': {
      const urn = part(parts, 'urn', URN_KINDS);
      const id = part(parts, 'id', NUM);
      return urn && id && kind === 'post' ? `/feed/update/urn:li:${urn}:${id}/` : null;
    }
    default:
      return null;
  }
}

/** Each platform's sign-in, sign-up and checkpoint paths (a tab that lands on one says `login`). */
const LOGIN_PATHS: Readonly<Record<ChromePlatform, readonly string[]>> = Object.freeze({
  instagram: ['/accounts/login', '/accounts/signup', '/accounts/onetap', '/challenge', '/login'],
  youtube: ['/signin', '/login'],
  tiktok: ['/login', '/signup'],
  x: ['/i/flow/login', '/i/flow/signup', '/login', '/account/access'],
  reddit: ['/login', '/account/login', '/register'],
  linkedin: ['/authwall', '/uas/login', '/login', '/checkpoint', '/signup'],
});

/** Whether a path on a platform's host is its login wall (`/accounts/login`, `/i/flow/login`, `/authwall`, ...), case aside. */
export function isLoginPath(platform: ChromePlatform, pathname: string): boolean {
  const p = typeof pathname === 'string' ? pathname.toLowerCase() : '';
  const list = Object.hasOwn(LOGIN_PATHS, platform) ? LOGIN_PATHS[platform] : [];
  return list.some((x) => {
    const l = x.toLowerCase();
    return p === l || p.startsWith(`${l}/`);
  });
}
