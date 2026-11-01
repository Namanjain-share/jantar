/**
 * What every tier and adapter hands the pipeline: the post's fields, read
 * from a page (an in-page read from Chrome or the headless browser, or the
 * downloader's HTML and JSON). Everything here is untrusted page text: it
 * reaches Claude only inside its fenced tags, and the phone only as text.
 *
 * `fromPageRead` checks an in-page read again (PageReadSchema, every field
 * capped) and takes what every platform shares; each platform's adapter
 * then reads its own shapes. `isGood` is spec 3.3's rule.
 */
import { PageReadSchema, type IntelPlatform, type PageReadParsed } from '@jantar/protocol';
import { collapse, decodeEntities, metaOf } from '../html.js';

/** A canvas frame from a page, decoded (JPEG bytes, magic checked by the caller). */
export interface PageFrame {
  at: number;
  jpeg: Buffer;
}

export interface PageFields {
  /** The page's or post's title (an article's headline, a video's title). */
  title?: string;
  /** The post's own text: caption, body, description. */
  text: string;
  /** As the page gave it (a display name or a handle): page text. */
  creator?: string;
  handle?: string;
  /** As the page gave it, made ISO when it parses. */
  postedAt?: string;
  /** Selected meta pairs for Claude. */
  meta: { k: string; v: string }[];
  /** The cover or the article's picture (https). */
  cover?: string;
  /** The post's own images (carousel, X photos), https, at most 4. */
  images: string[];
  /** A direct https mp4 of the post's video. */
  video?: string;
  /** Seconds, when the page said. */
  duration?: number;
  comments?: { author: string; text: string }[];
  /** Canvas frames an in-page read drew. */
  frames: PageFrame[];
  /** An article (og:type article or an Article ld+json): the type chip. */
  article?: boolean;
  /** YouTube: the video's language and whether it has caption tracks. */
  youtube?: { lang?: string; captions: boolean };
  /** What the page itself said, when it was not the post. */
  why?: 'login' | 'notFound' | 'tiktok' | 'reddit' | 'blocked';
}

export function emptyFields(): PageFields {
  return { text: '', meta: [], images: [], frames: [] };
}

/** One line of page text: entities decoded, whitespace collapsed, cut. */
export function line(s: unknown, max: number): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = collapse(decodeEntities(s.length > max * 4 ? s.slice(0, max * 4) : s));
  if (t === '') return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

/** Page text that may keep line breaks: each line collapsed, cut. */
export function body(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  const cut = s.length > max * 2 ? s.slice(0, max * 2) : s;
  const lines = decodeEntities(cut)
    .split(/\r\n?|\n/)
    .map((l) => collapse(l))
    .filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''));
  const t = lines.join('\n').trim();
  return t.length > max ? t.slice(0, max) : t;
}

/** An https URL as given (null for anything else). */
export function httpsUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 2000) return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** An ISO time from a page's date, or undefined. */
export function isoOf(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof v !== 'string' || v.length > 100) return undefined;
  const t = v.trim();
  // A date with no time is that day everywhere: noon UTC, never the Mac's own midnight.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T12:00:00Z` : t);
  if (Number.isNaN(d.getTime())) return undefined;
  const y = d.getUTCFullYear();
  return y < 1990 || y > 2100 ? undefined : d.toISOString();
}

/** Meta pairs Claude sees (the descriptive ones only). */
const META_FOR_CLAUDE = /^(og:(title|description|site_name|type)|twitter:(title|description)|description|author|article:(published_time|author|section|tag))$/;

export function claudeMeta(meta: readonly { k: string; v: string }[]): { k: string; v: string }[] {
  return meta.filter((m) => META_FOR_CLAUDE.test(m.k)).slice(0, 12);
}

/** An in-page read checked and cut again (untrusted), or null when it does not fit the schema. */
export function checkPageRead(raw: unknown): PageReadParsed | null {
  const r = PageReadSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** The frames of an in-page read, decoded; any that is not a JPEG is dropped. */
export function framesOf(read: PageReadParsed): PageFrame[] {
  const out: PageFrame[] = [];
  for (const f of read.frames) {
    const b64 = f.jpeg.slice('data:image/jpeg;base64,'.length);
    const jpeg = Buffer.from(b64, 'base64');
    if (jpeg.length > 3 && jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg[2] === 0xff) out.push({ at: f.at, jpeg });
  }
  return out;
}

/** The fields every platform shares from an in-page read. */
export function fromPageRead(read: PageReadParsed): PageFields {
  const f = emptyFields();
  f.meta = read.meta;
  const title = line(read.title, 300);
  if (title) f.title = title;
  f.text = body(read.text, 40_000);
  const creator = line(read.author, 80);
  if (creator) f.creator = creator;
  const handle = line(read.handle, 80);
  if (handle) f.handle = handle;
  const at = isoOf(read.publishedAt);
  if (at) f.postedAt = at;
  f.cover = httpsUrl(metaOf(read.meta, 'og:image', 'twitter:image'));
  for (const m of read.media) {
    if (m.kind === 'image' && f.images.length < 4 && m.url !== f.cover) f.images.push(m.url);
    if (m.kind === 'video' && !f.video) f.video = m.url;
  }
  if (!f.cover && f.images.length) f.cover = f.images[0];
  if (read.duration !== undefined) f.duration = read.duration;
  if (read.comments?.length) f.comments = read.comments.map((c) => ({ author: line(c.author, 80) ?? '', text: body(c.text, 500) })).filter((c) => c.text !== '');
  f.frames = framesOf(read);
  if (read.why === 'login') f.why = 'login';
  else if (read.why === 'not_found') f.why = 'notFound';
  else if (read.why === 'blocked') f.why = 'blocked';
  return f;
}

/** The platforms' own names: a page whose title is only that is an app shell. */
const SHELL_TITLES = new Set(['instagram', 'youtube', 'tiktok', 'x', 'twitter', 'reddit', 'linkedin', 'log in', 'login', 'sign in', 'sign up']);

export function isShellTitle(t: string | undefined): boolean {
  if (!t) return true;
  const s = t.toLowerCase().replace(/\s*[-|•·]\s*(instagram|youtube|tiktok|x|reddit|linkedin)$/, '').trim();
  return SHELL_TITLES.has(s);
}

/**
 * Spec 3.3's good read: the post's text (at least one character), or for a
 * video platform a title and a creator, or for a web page main text of at
 * least 200 characters (or a title with a description). A login wall, an
 * app shell or an empty read is not good.
 */
export function isGood(platform: IntelPlatform, f: PageFields | null): boolean {
  if (!f || f.why === 'login' || f.why === 'notFound' || f.why === 'tiktok' || f.why === 'blocked') return false;
  const text = f.text.trim().length;
  switch (platform) {
    case 'youtube':
    case 'tiktok':
      return text > 0 || (!!f.title && !isShellTitle(f.title) && !!(f.creator ?? f.handle));
    case 'instagram':
    case 'x':
    case 'linkedin':
      return text > 0;
    case 'reddit':
      return text > 0 || (f.comments?.length ?? 0) > 0;
    case 'pdf':
      return text > 0 || !!f.title;
    case 'web':
      return text >= 200 || (!!f.title && !isShellTitle(f.title) && !!metaOf(f.meta, 'og:description', 'description', 'twitter:description'));
    case 'note':
      return true;
  }
}

/** A partial read worth keeping when nothing was good (a title, a creator or some text). */
export function hasSomething(f: PageFields | null): boolean {
  return !!f && (f.text.trim() !== '' || (!!f.title && !isShellTitle(f.title)) || !!f.creator);
}
