/**
 * Links (spec 3.1, 3.2).
 *
 * - `acceptText`: the first http(s) link in what the user sent becomes the
 *   item's link (trailing `)].,;!?'"` stripped, http made https), the rest
 *   its note. No link: a note item. A link that breaks the URL rules
 *   (guard.ts checkUrl: userinfo, a port, an IP literal, a local name) is
 *   refused, and nothing is saved.
 * - `canonical`: tracking parameters stripped, the platforms' hosts made
 *   one (their m. and mobile. dropped, instagram.com → www.instagram.com,
 *   twitter.com → x.com, youtu.be/<id> → /watch?v=<id>), no fragment. Dedupe
 *   compares canonical links.
 * - `kindOf`: the platform and type chip by exact shape (post-url.ts
 *   chromePostOf for the six platforms; a .pdf path; any other https link is
 *   `web`).
 * - `chromeUrlOf`: the URL the user's Chrome may open, rebuilt from the
 *   platform and the post's parts on its www host, never the link as typed.
 * - `isShortLink`: links resolved inside the job (headers only, through the
 *   guard) before they are read.
 */
import { CHROME_POST_HOSTS, chromePathOf, chromePostOf, type ChromePost } from '@jantar/protocol/post-url';
import { INTEL_READ_LIMITS, type IntelPlatform } from '@jantar/protocol';
import { checkUrl, normHost, type UrlRefusal } from './guard.js';

/** Characters a link found in text never ends with. */
const TRAILING = new Set([')', ']', '.', ',', ';', '!', '?', "'", '"', '>', '}']);

export type Accepted = { ok: true; link: string | null; note: string | null } | { ok: false; why: UrlRefusal };

/** Where the first http(s) link starts in `text` (case aside), or -1. */
function linkStart(text: string): number {
  const lower = text.toLowerCase();
  const a = lower.indexOf('https://');
  const b = lower.indexOf('http://');
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

/** The text's link and note: the link canonical, the note trimmed and cut. */
export function acceptText(text: string, own: ReadonlySet<string>): Accepted {
  const t = text.trim();
  const at = linkStart(t);
  if (at < 0) return { ok: true, link: null, note: cutNote(t) };
  let end = at;
  while (end < t.length && !/[\s<>"]/.test(t[end] as string)) end += 1;
  let raw = t.slice(at, end);
  while (raw.length > 0 && TRAILING.has(raw[raw.length - 1] as string)) raw = raw.slice(0, -1);
  const checked = checkUrl(raw, own, { upgrade: true });
  if (!checked.ok) return checked;
  const rest = `${t.slice(0, at)} ${t.slice(at + raw.length)}`.trim();
  return { ok: true, link: canonical(checked.url.href), note: cutNote(rest) };
}

function cutNote(s: string): string | null {
  const t = s.trim();
  if (t === '') return null;
  return t.length > INTEL_READ_LIMITS.noteMax ? t.slice(0, INTEL_READ_LIMITS.noteMax).trimEnd() : t;
}

/** Query keys stripped everywhere (and `utm_*`). */
const STRIP = new Set(['igsh', 'igshid', 'si', 'rcm', 'share_id', 'xmt', 'fbclid', 'gclid', 'ref', 'ref_src', 'mibextid']);

/** Bare and mobile hosts of the platforms, made the one host each uses. */
const HOSTS: Readonly<Record<string, string>> = {
  'instagram.com': 'www.instagram.com',
  'youtube.com': 'www.youtube.com',
  'tiktok.com': 'www.tiktok.com',
  'reddit.com': 'www.reddit.com',
  'old.reddit.com': 'www.reddit.com',
  'new.reddit.com': 'www.reddit.com',
  'np.reddit.com': 'www.reddit.com',
  'linkedin.com': 'www.linkedin.com',
  'twitter.com': 'x.com',
  'www.twitter.com': 'x.com',
  'www.x.com': 'x.com',
};

/** The hosts the platforms use. */
const PLATFORM_HOSTS: ReadonlySet<string> = new Set(Object.values(HOSTS));

/** The canonical form of an https link the URL rules passed (unchanged when it is not a URL). */
export function canonical(href: string): string {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return href;
  }
  let host = normHost(u.hostname);
  // m. and mobile. only on the platforms' hosts: on any other site it may be another site.
  const bare = host.startsWith('m.') ? host.slice(2) : host.startsWith('mobile.') ? host.slice('mobile.'.length) : host;
  if (HOSTS[bare] !== undefined || PLATFORM_HOSTS.has(bare)) host = bare;
  host = HOSTS[host] ?? host;
  if (host === 'youtu.be') {
    const id = u.pathname.split('/')[1] ?? '';
    if (/^[A-Za-z0-9_-]{11}$/.test(id)) {
      const t = u.searchParams.get('t');
      return `https://www.youtube.com/watch?v=${id}${t && /^\d{1,6}s?$/.test(t) ? `&t=${t}` : ''}`;
    }
  }
  u.hostname = host;
  u.hash = '';
  const keep = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    const key = k.toLowerCase();
    if (STRIP.has(key) || key.startsWith('utm_')) continue;
    if (key === 'feature' && host === 'www.youtube.com') continue;
    if ((key === 's' || key === 't') && host === 'x.com') continue;
    keep.append(k, v);
  }
  const q = keep.toString();
  u.search = q === '' ? '' : `?${q}`;
  return u.href;
}

/** The type chips of read items. */
export type ReadType = 'reel' | 'post' | 'video' | 'short' | 'thread' | 'article' | 'pdf' | 'note' | 'link';

export interface LinkKind {
  platform: IntelPlatform;
  type: ReadType;
  /** One of the six platforms' post shapes (post-url.ts), when it is one. */
  post: ChromePost | null;
}

/** The platform and type of a canonical link (null: a note). */
export function kindOf(link: string | null): LinkKind {
  if (link === null) return { platform: 'note', type: 'note', post: null };
  const post = chromePostOf(link);
  if (post) return { platform: post.platform, type: post.kind, post };
  let path = '';
  try {
    path = new URL(link).pathname.toLowerCase();
  } catch {
    // not a URL: a web link
  }
  if (path.endsWith('.pdf')) return { platform: 'pdf', type: 'pdf', post: null };
  return { platform: 'web', type: 'link', post: null };
}

/** The URL the user's Chrome may open for `post`: rebuilt on the platform's www host, or null. */
export function chromeUrlOf(post: ChromePost | null): string | null {
  if (!post) return null;
  const path = chromePathOf(post);
  return path === null ? null : `https://${CHROME_POST_HOSTS[post.platform]}${path}`;
}

const SHORT_HOSTS = new Set(['t.co', 'lnkd.in', 'bit.ly', 'redd.it', 'vt.tiktok.com', 'vm.tiktok.com']);

/** A link that only redirects to the post: resolved inside the job before it is read. */
export function isShortLink(link: string): boolean {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return false;
  }
  const host = normHost(u.hostname);
  if (SHORT_HOSTS.has(host)) return true;
  if (host === 'www.tiktok.com' && /^\/t\/[A-Za-z0-9]+\/?$/.test(u.pathname)) return true;
  return host === 'www.reddit.com' && /^\/r\/[A-Za-z0-9_]{2,21}\/s\/[A-Za-z0-9]{6,16}\/?$/.test(u.pathname);
}

const PLATFORM_NAMES: Readonly<Record<IntelPlatform, string>> = {
  instagram: 'Instagram',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  x: 'X',
  reddit: 'Reddit',
  linkedin: 'LinkedIn',
  web: 'Web',
  pdf: 'PDF',
  note: 'Note',
};

export function platformName(p: IntelPlatform): string {
  return PLATFORM_NAMES[p];
}

const TYPE_WORDS: Readonly<Record<ReadType, string>> = {
  reel: 'reel',
  post: 'post',
  video: 'video',
  short: 'Short',
  thread: 'thread',
  article: 'article',
  pdf: 'PDF',
  note: 'note',
  link: 'link',
};

/** The pending item's title, made by the daemon (spec 2.1): "Instagram reel", a host and path, a note's first line. */
export function pendingTitle(link: string | null, kind: LinkKind, note: string | null): string {
  const max = INTEL_READ_LIMITS.pendingTitleMax;
  if (link === null) {
    const first = (note ?? '').split(/\r\n?|\n|\u2028|\u2029/).find((l) => l.trim() !== '')?.trim() ?? 'Note';
    return first.length > max ? `${first.slice(0, max - 1)}…` : first;
  }
  if (kind.post) return `${platformName(kind.platform)} ${TYPE_WORDS[kind.type]}`;
  let hostPath = link;
  try {
    const u = new URL(link);
    hostPath = `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    // keep the link
  }
  return hostPath.length > max ? `${hostPath.slice(0, max - 1)}…` : hostPath;
}

/** Up to `max` distinct https links in the user's own note (Full's related pages), each passing the URL rules. */
export function noteLinks(note: string | null, own: ReadonlySet<string>, max: number = INTEL_READ_LIMITS.relatedMax): string[] {
  if (!note) return [];
  const out: string[] = [];
  let rest = note;
  while (out.length < max) {
    const at = linkStart(rest);
    if (at < 0) break;
    let end = at;
    while (end < rest.length && !/[\s<>"]/.test(rest[end] as string)) end += 1;
    let raw = rest.slice(at, end);
    rest = rest.slice(end);
    while (raw.length > 0 && TRAILING.has(raw[raw.length - 1] as string)) raw = raw.slice(0, -1);
    if (!raw.toLowerCase().startsWith('https://')) continue;
    const checked = checkUrl(raw, own);
    if (!checked.ok) continue;
    const c = canonical(checked.url.href);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}
