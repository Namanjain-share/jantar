/**
 * v0.8: the in-page reader both page tiers run (`@jantar/protocol/page-read`).
 *
 * The extension runs `readPage` in the user's Chrome with
 * `chrome.scripting.executeScript({ func: readPage, args: [args] })` (the
 * ISOLATED world), and the headless browser tier with
 * `page.evaluate(readPage, args)`. Both send the function's source to the
 * page, so it imports nothing, closes over nothing and defines its helpers
 * inside itself. It is typed with small local shapes (no DOM library in the
 * protocol's or the daemon's build) and holds no URL literal (the
 * extension's bundle check); a URL is checked with `new URL()` and its
 * protocol.
 *
 * It reads the post, not the page: never `document.body.innerText`, the
 * header, nav, sidebars or anything naming the signed-in user. What it
 * returns is untrusted: the daemon checks and cuts every field again
 * (PageReadSchema in intel.ts).
 *
 * Wave 0 reads the title, the meta pairs and the ld+json blocks; lane C
 * completes it (the post's text, author, time, media, top comments and the
 * main video's canvas frames).
 */
import type { IntelPlatform } from './intel.js';

export interface PageReadArgs {
  platform: IntelPlatform;
  /** Canvas frames from the page's main <video>, 0..20 (the Chrome tier asks at most 4). */
  frames: number;
  /** The post's own text kept, at most (≤ 40,000). */
  textMax: number;
}

export interface PageRead {
  /** The page's URL when it was read (the tier re-checks it). */
  finalUrl: string;
  title?: string;
  /** At most 60 og:, twitter:, article:, description and author pairs, each value at most 2,000 characters. */
  meta: { k: string; v: string }[];
  /** At most 5 ld+json blocks, each at most 50,000 characters. */
  jsonld: string[];
  /** The post's own text (caption, body), at most textMax. */
  text: string;
  author?: string;
  handle?: string;
  publishedAt?: string;
  /** At most 12, https only. */
  media: { kind: 'image' | 'video'; url: string; w?: number; h?: number }[];
  /** At most `frames` JPEG data URLs from the page's main <video>, each at most 200 KB, with the time (s). */
  frames: { at: number; jpeg: string }[];
  /** The main <video>'s duration (s), when known. */
  duration?: number;
  /** Reddit and LinkedIn: at most 10, each text at most 500. */
  comments?: { author: string; text: string }[];
  /** What the page itself says. */
  why?: 'login' | 'not_found' | 'blocked';
}

/** Read the post on the current page. Runs in the page: self-contained. */
export function readPage(args: PageReadArgs): PageRead {
  interface El {
    getAttribute(name: string): string | null;
    textContent: string | null;
  }
  interface Doc {
    title: string;
    querySelectorAll(selector: string): ArrayLike<El>;
  }
  const g = globalThis as unknown as { document: Doc; location: { href: string } };
  const doc = g.document;
  const META_MAX = 60;
  const META_VALUE_MAX = 2000;
  const JSONLD_MAX = 5;
  const JSONLD_CHARS = 50_000;
  const TITLE_MAX = 2000;
  const KEEP = /^(og:|twitter:|article:)|^(description|author)$/;

  const clean = (s: string | null | undefined, max: number): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

  const meta: { k: string; v: string }[] = [];
  const metas = doc.querySelectorAll('meta[property], meta[name]');
  for (let i = 0; i < metas.length && meta.length < META_MAX; i++) {
    const el = metas[i];
    if (!el) continue;
    const k = clean(el.getAttribute('property') ?? el.getAttribute('name'), 100).toLowerCase();
    const v = clean(el.getAttribute('content'), META_VALUE_MAX);
    if (k && v && KEEP.test(k)) meta.push({ k, v });
  }

  const jsonld: string[] = [];
  const blocks = doc.querySelectorAll('script[type="application/ld+json"]');
  for (let i = 0; i < blocks.length && jsonld.length < JSONLD_MAX; i++) {
    const text = (blocks[i]?.textContent ?? '').trim();
    if (text) jsonld.push(text.slice(0, JSONLD_CHARS));
  }

  const title = clean(doc.title, TITLE_MAX);
  // `args` is read so the shape stays the one both tiers send; wave 0 keeps no text and no frames.
  const textMax = Math.max(0, Math.min(Number(args.textMax) || 0, 40_000));
  return {
    finalUrl: String(g.location.href),
    ...(title ? { title } : {}),
    meta,
    jsonld,
    text: ''.slice(0, textMax),
    media: [],
    frames: [],
  };
}
