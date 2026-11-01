/**
 * v0.8: the in-page reader both page tiers run (`@jantar/protocol/page-read`).
 *
 * The extension runs `readPage` in the user's Chrome with
 * `chrome.scripting.executeScript({ func: readPage, args: [args] })` (the
 * ISOLATED world), and the headless browser tier with
 * `page.evaluate(readPage, args)`. Both send the function's source to the
 * page and wait for the promise it returns, so it imports nothing, closes
 * over nothing and defines its helpers inside itself. It is typed with
 * small local shapes (no DOM library in the protocol's or the daemon's
 * build) and holds no URL literal (the extension's bundle check); a URL is
 * checked with `new URL()` and its protocol.
 *
 * It reads the post, not the page: the post's own container (per platform,
 * best effort, with the meta and ld+json blocks as the fallback the daemon
 * reads), its caption or body, author, time, media and top comments. Never
 * `document.body.innerText`, the header, nav, sidebars, notifications or
 * anything naming the signed-in user; a web page's text skips script,
 * style, nav, header, footer, aside, forms and buttons. Every part is cut
 * to its cap here, and checked and cut again by the daemon
 * (PageReadSchema in intel.ts): what it returns is untrusted.
 *
 * Frames: n = min(args.frames, ceil(duration / 2)), at least 1, from the
 * post's main <video>, seeked to (k + 0.5) / n of its duration and drawn at
 * long edge 640 as JPEG 0.6, all within 15 s. A video that never loads
 * (8 s), a live one, or a tainted canvas gives no frames, never an error.
 * Media URLs are kept only when https and on the platform's own CDN.
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
  /** At most 12, https only, on the platform's CDN. */
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
export async function readPage(args: PageReadArgs): Promise<PageRead> {
  // --- the page's shapes, as far as this reads them (no DOM library here)
  interface Nd {
    nodeType: number;
    nodeName: string;
    nodeValue: string | null;
    childNodes: ArrayLike<Nd>;
  }
  interface El extends Nd {
    textContent: string | null;
    getAttribute(name: string): string | null;
    querySelector(selector: string): El | null;
    querySelectorAll(selector: string): ArrayLike<El>;
  }
  interface Video extends El {
    readyState: number;
    duration: number;
    currentTime: number;
    videoWidth: number;
    videoHeight: number;
    muted: boolean;
    pause(): void;
    addEventListener(type: string, fn: () => void): void;
    removeEventListener(type: string, fn: () => void): void;
  }
  interface Ctx2d {
    drawImage(source: unknown, x: number, y: number, w: number, h: number): void;
  }
  interface Canvas {
    width: number;
    height: number;
    getContext(kind: '2d'): Ctx2d | null;
    toDataURL(type: string, quality: number): string;
  }
  interface Doc {
    title: string;
    querySelector(selector: string): El | null;
    querySelectorAll(selector: string): ArrayLike<El>;
    createElement(tag: 'canvas'): Canvas;
  }
  const g = globalThis as unknown as { document: Doc; location: { href: string } };
  const doc = g.document;

  // --- caps (the daemon's PageReadSchema)
  const META_MAX = 60;
  const META_VALUE_MAX = 2000;
  const JSONLD_MAX = 5;
  const JSONLD_CHARS = 50_000;
  const TITLE_MAX = 2000;
  const NAME_MAX = 200;
  const WHEN_MAX = 100;
  const MEDIA_MAX = 12;
  const MEDIA_MIN_PX = 150;
  const COMMENTS_MAX = 10;
  const COMMENT_MAX = 500;
  const FRAMES_MAX = 20;
  const FRAME_EDGE = 640;
  const FRAME_CHARS = 'data:image/jpeg;base64,'.length + Math.ceil((200 * 1024) / 3) * 4;
  const LOAD_MS = 8_000;
  const SEEK_MS = 3_000;
  const FRAMES_MS = 15_000;
  const KEEP = /^(og:|twitter:|article:)|^(description|author)$/;

  const platform = args.platform;
  const textMax = Math.max(0, Math.min(Math.floor(Number(args.textMax) || 0), 40_000));
  const wantFrames = Math.max(0, Math.min(Math.floor(Number(args.frames) || 0), FRAMES_MAX));

  // --- helpers
  const one = (s: string | null | undefined, max: number): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  /** Block text: runs of spaces made one, at most two line breaks in a row. */
  const block = (s: string, max: number): string =>
    s
      .replace(/[ \t\f\v\r ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, max);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'BUTTON', 'SVG', 'IFRAME', 'SELECT', 'TEXTAREA', 'INPUT', 'DIALOG']);
  const BLOCK = new Set(['P', 'DIV', 'BR', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'PRE', 'TR', 'FIGCAPTION', 'DD', 'DT']);
  /** The text under `root`, blocks on their own lines, skipping what is never the post; stops past `max`. Iterative: no deep recursion. */
  const textUnder = (root: El | null, max: number): string => {
    if (!root || max <= 0) return '';
    let out = '';
    const stack: (Nd | '\n')[] = [root];
    while (stack.length > 0 && out.length <= max * 1.2 + 100) {
      const n = stack.pop() as Nd | '\n';
      if (n === '\n') {
        out += '\n';
        continue;
      }
      if (n.nodeType === 3) {
        out += n.nodeValue ?? '';
        continue;
      }
      if (n.nodeType !== 1) continue;
      const name = n.nodeName.toUpperCase();
      if (SKIP.has(name) && n !== root) continue;
      if (name === 'BR') {
        out += '\n';
        continue;
      }
      const isBlock = BLOCK.has(name);
      if (isBlock) stack.push('\n');
      const kids = n.childNodes;
      for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i];
        if (k) stack.push(k);
      }
      if (isBlock) out += '\n';
    }
    return block(out, max);
  };
  const first = (root: El | Doc | null, selectors: readonly string[]): El | null => {
    if (!root) return null;
    for (const s of selectors) {
      try {
        const el = root.querySelector(s);
        if (el) return el;
      } catch {
        // a selector this page's engine does not take
      }
    }
    return null;
  };
  const attr = (el: El | null, name: string, max: number): string => one(el?.getAttribute(name), max);
  const httpsUrl = (raw: string | null | undefined): URL | null => {
    if (!raw) return null;
    try {
      const u = new URL(raw, g.location.href);
      return u.protocol === 'https:' && u.username === '' && u.password === '' ? u : null;
    } catch {
      return null;
    }
  };

  // --- the head: meta pairs, ld+json, title (as wave 0 read them)
  const meta: { k: string; v: string }[] = [];
  const metas = doc.querySelectorAll('meta[property], meta[name], meta[itemprop]');
  for (let i = 0; i < metas.length && meta.length < META_MAX; i++) {
    const el = metas[i];
    if (!el) continue;
    const k = one(el.getAttribute('property') ?? el.getAttribute('name') ?? el.getAttribute('itemprop'), 100).toLowerCase();
    const v = one(el.getAttribute('content'), META_VALUE_MAX);
    if (k && v && KEEP.test(k)) meta.push({ k, v });
  }
  const metaOf = (k: string): string => meta.find((m) => m.k === k)?.v ?? '';

  const jsonld: string[] = [];
  const blocks = doc.querySelectorAll('script[type="application/ld+json"]');
  for (let i = 0; i < blocks.length && jsonld.length < JSONLD_MAX; i++) {
    const text = (blocks[i]?.textContent ?? '').trim();
    if (text) jsonld.push(text.slice(0, JSONLD_CHARS));
  }

  // A tab's unread count ("(3) ") is the page's chrome, not the post.
  const title = one(doc.title, TITLE_MAX).replace(/^\(\d{1,6}\+?\)\s*/, '');

  // --- the post's own container and fields, per platform (best effort)
  interface Shape {
    roots: readonly string[];
    text: readonly string[];
    author: readonly string[];
    handle?: readonly string[];
    time: readonly string[];
    comments?: { item: string; author: readonly string[]; authorAttr?: string; text: readonly string[] };
  }
  const SHAPES: Partial<Record<IntelPlatform, Shape>> = {
    instagram: {
      roots: ['article', 'main [role="presentation"]', 'main'],
      text: ['h1', 'span[dir="auto"] h1'],
      author: ['header a[href][role="link"]', 'header a[href]', 'a[href][role="link"]'],
      time: ['time[datetime]'],
    },
    youtube: {
      roots: ['ytd-watch-metadata', '#above-the-fold', 'ytd-reel-video-renderer[is-active]', 'ytd-watch-flexy', '#primary'],
      text: ['#description-inline-expander', 'ytd-text-inline-expander', '#description', '.description'],
      author: ['#owner ytd-channel-name a', 'ytd-channel-name a', '#channel-name a', '.ytd-channel-name a'],
      time: ['meta[itemprop="datePublished"]', 'meta[itemprop="uploadDate"]'],
    },
    tiktok: {
      roots: ['[data-e2e="browse-video"]', '[data-e2e="detail-video"]', 'main'],
      text: ['[data-e2e="browse-video-desc"]', '[data-e2e="video-desc"]'],
      author: ['[data-e2e="browse-username"]', '[data-e2e="video-author-uniqueid"]'],
      time: ['time[datetime]'],
    },
    x: {
      roots: ['article[data-testid="tweet"]', 'main article'],
      text: ['[data-testid="tweetText"]'],
      author: ['[data-testid="User-Name"] span', '[data-testid="User-Name"]'],
      handle: ['[data-testid="User-Name"] a[href]'],
      time: ['time[datetime]'],
    },
    reddit: {
      roots: ['shreddit-post', '#siteTable .thing.link', 'main article'],
      text: ['[slot="text-body"]', 'div[id$="-post-rtjson-content"]', '.usertext-body .md', '.expando .md'],
      author: ['a.author', '[slot="authorName"]'],
      time: ['time[datetime]'],
      comments: { item: 'shreddit-comment[depth="0"], .commentarea > .sitetable > .thing.comment', author: ['a.author'], authorAttr: 'author', text: ['[slot="comment"]', '.usertext-body .md', '.md'] },
    },
    linkedin: {
      roots: ['.feed-shared-update-v2', '[data-urn*="urn:li:activity"]', 'main article', 'article'],
      text: ['.update-components-text', '.feed-shared-inline-show-more-text', '.feed-shared-text', '.attributed-text-segment-list__content', '[data-test-id="main-feed-activity-card__commentary"]'],
      author: ['.update-components-actor__title span[aria-hidden="true"]', '.update-components-actor__name', '.update-components-actor__title', '[data-test-id="main-feed-activity-card__entity-lockup"] a'],
      time: ['time[datetime]', '.update-components-actor__sub-description span[aria-hidden="true"]', 'time'],
      comments: {
        item: '.comments-comment-item, article.comments-comment-entity, [data-test-id="comments-container"] section',
        author: ['.comments-post-meta__name-text', '.comments-comment-meta__description-title', '.comment__author'],
        text: ['.comments-comment-item__main-content', '.comments-comment-item-content-body', '.comment__text'],
      },
    },
  };

  /** The page's own id for this post, so X's focal tweet is told from replies around it. */
  const xStatus = (() => {
    const m = /\/status\/(\d{6,25})/.exec(g.location.href);
    return m ? m[1] : null;
  })();

  const pickRoot = (shape: Shape): El | null => {
    if (platform === 'x' && xStatus) {
      const all = doc.querySelectorAll('article[data-testid="tweet"]');
      for (let i = 0; i < all.length; i++) {
        const a = all[i];
        const link = a?.querySelector(`a[href*="/status/${xStatus}"] time`);
        if (a && link) return a;
      }
    }
    return first(doc, shape.roots);
  };

  /** Web pages: <article>, else <main>, else the parent of the most paragraph text. */
  const webRoot = (): El | null => {
    const direct = first(doc, ['article', 'main', '[role="main"]']);
    if (direct) return direct;
    const ps = doc.querySelectorAll('p');
    let best: El | null = null;
    let bestLen = 0;
    const totals = new Map<El, number>();
    for (let i = 0; i < ps.length && i < 2000; i++) {
      const p = ps[i] as (El & { parentElement?: El | null }) | undefined;
      const parent = p?.parentElement ?? null;
      if (!p || !parent) continue;
      const len = (totals.get(parent) ?? 0) + (p.textContent ?? '').length;
      totals.set(parent, len);
      if (len > bestLen) {
        best = parent;
        bestLen = len;
      }
    }
    return best;
  };

  const shape = SHAPES[platform];
  const root: El | null = shape ? pickRoot(shape) : platform === 'web' ? webRoot() : null;

  let text = '';
  let author = '';
  let handle = '';
  let publishedAt = '';
  let comments: { author: string; text: string }[] | undefined;

  if (shape && root) {
    text = textUnder(first(root, shape.text), textMax);
    if (platform === 'reddit') {
      const postTitle = attr(root, 'post-title', 300) || one(first(root, ['a.title', 'h1'])?.textContent, 300);
      text = block([postTitle, text].filter(Boolean).join('\n\n'), textMax);
      author = attr(root, 'author', NAME_MAX);
      publishedAt = attr(root, 'created-timestamp', WHEN_MAX);
    }
    if (platform === 'youtube') {
      const heading = one(first(root, ['h1', 'h2', '#title'])?.textContent, 300);
      text = block([heading, text].filter(Boolean).join('\n\n'), textMax);
    }
    const authorEl = first(root, shape.author);
    author ||= one(authorEl?.textContent, NAME_MAX);
    const handleEl = shape.handle ? first(root, shape.handle) : authorEl;
    const href = handleEl?.getAttribute('href') ?? '';
    const h = /^\/@?([A-Za-z0-9._]{1,30})\/?$/.exec(href);
    if (h?.[1]) handle = h[1];
    if (platform === 'instagram' && handle && !author) author = handle;
    const timeEl = first(platform === 'youtube' ? doc : root, shape.time);
    publishedAt ||= one(timeEl?.getAttribute('datetime') ?? timeEl?.getAttribute('content') ?? (timeEl?.nodeName.toUpperCase() === 'TIME' ? timeEl.textContent : ''), WHEN_MAX);
    if (shape.comments) {
      const items = root.querySelectorAll(shape.comments.item);
      const scope = items.length > 0 ? items : doc.querySelectorAll(shape.comments.item);
      const out: { author: string; text: string }[] = [];
      for (let i = 0; i < scope.length && out.length < COMMENTS_MAX; i++) {
        const c = scope[i];
        if (!c) continue;
        const who = (shape.comments.authorAttr ? attr(c, shape.comments.authorAttr, NAME_MAX) : '') || one(first(c, shape.comments.author)?.textContent, NAME_MAX);
        const said = one(textUnder(first(c, shape.comments.text), COMMENT_MAX * 2), COMMENT_MAX);
        if (said) out.push({ author: who, text: said });
      }
      if (out.length > 0) comments = out;
    }
  } else if (platform === 'web' && root) {
    text = textUnder(root, textMax);
    author = one(metaOf('author') || metaOf('article:author'), NAME_MAX);
    publishedAt = one(metaOf('article:published_time'), WHEN_MAX);
  }

  // --- media: https on the platform's own CDN, never an avatar-sized picture
  const CDN: Partial<Record<IntelPlatform, readonly string[]>> = {
    instagram: ['cdninstagram.com', 'fbcdn.net'],
    youtube: ['ytimg.com'],
    tiktok: ['tiktokcdn.com'],
    x: ['twimg.com'],
    reddit: ['redd.it'],
    linkedin: ['licdn.com'],
  };
  const suffixes = CDN[platform] ?? [];
  const onCdn = (u: URL | null): u is URL => {
    if (!u) return false;
    if (platform === 'web') return true;
    const host = u.hostname.toLowerCase();
    return suffixes.some((s) => host === s || host.endsWith(`.${s}`));
  };
  const media: PageRead['media'] = [];
  const seen = new Set<string>();
  const addMedia = (kind: 'image' | 'video', raw: string | null | undefined, w?: number, h?: number) => {
    if (media.length >= MEDIA_MAX) return;
    const u = httpsUrl(raw);
    if (!onCdn(u) || u.href.length > 2000 || seen.has(u.href)) return;
    seen.add(u.href);
    media.push({ kind, url: u.href, ...(w ? { w: Math.min(Math.round(w), 100_000) } : {}), ...(h ? { h: Math.min(Math.round(h), 100_000) } : {}) });
  };
  if (root && platform !== 'web') {
    const imgs = root.querySelectorAll('img');
    for (let i = 0; i < imgs.length && media.length < MEDIA_MAX; i++) {
      const img = imgs[i] as (El & { naturalWidth?: number; naturalHeight?: number; currentSrc?: string; src?: string }) | undefined;
      if (!img) continue;
      const w = img.naturalWidth || Number(img.getAttribute('width')) || 0;
      const h = img.naturalHeight || Number(img.getAttribute('height')) || 0;
      if (Math.max(w, h) < MEDIA_MIN_PX) continue;
      addMedia('image', img.currentSrc || img.getAttribute('src'), w, h);
    }
    const posters = root.querySelectorAll('video[poster]');
    for (let i = 0; i < posters.length; i++) addMedia('image', posters[i]?.getAttribute('poster'));
  }
  if (platform === 'instagram') {
    // Logged-in pages carry the post's own files in embedded JSON: cut a short piece after each key, never a regex over the whole script.
    const scripts = doc.querySelectorAll('script[type="application/json"]');
    for (let i = 0; i < scripts.length && media.length < MEDIA_MAX; i++) {
      const s = scripts[i]?.textContent ?? '';
      let at = s.indexOf('"video_versions"');
      for (let hits = 0; at >= 0 && hits < 4 && media.length < MEDIA_MAX; hits++) {
        const piece = s.slice(at, at + 4000);
        const m = /"url":"(https:[^"]{1,2000})"/.exec(piece);
        if (m?.[1]) addMedia('video', m[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&'));
        at = s.indexOf('"video_versions"', at + 16);
      }
    }
  }

  // --- what the page says about itself
  let why: PageRead['why'];
  if (!text) {
    const heading = one(first(doc, ['main h1', 'main h2', 'h1', 'h2'])?.textContent, 300);
    if (/isn.t available|doesn.t exist|page not found|no longer available|been removed|been deleted|this post is unavailable/i.test(heading)) why = 'not_found';
    else if (doc.querySelector('input[type="password"]')) why = 'login';
  }

  // --- frames from the post's main <video>
  const frames: PageRead['frames'] = [];
  let duration: number | undefined;
  const video = (root?.querySelector('video') ?? doc.querySelector('video')) as Video | null;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  /** Wait for `event` on the video, or `ms`; true when it came. */
  const once = (v: Video, event: string, ms: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      let done = false;
      const end = (ok: boolean) => {
        if (done) return;
        done = true;
        v.removeEventListener(event, onEvent);
        clearTimeout(timer);
        resolve(ok);
      };
      const onEvent = () => end(true);
      const timer = setTimeout(() => end(false), ms);
      v.addEventListener(event, onEvent);
    });
  if (video) {
    try {
      video.muted = true;
      // The duration is read when the page already has it; a wait for it only when frames are wanted.
      if (video.readyState < 1 && wantFrames > 0) await once(video, 'loadedmetadata', LOAD_MS);
      const d = Number(video.duration);
      if (Number.isFinite(d) && d > 0) duration = Math.round(d * 10) / 10;
      if (wantFrames > 0 && duration !== undefined && video.readyState >= 1) {
        const n = Math.max(1, Math.min(wantFrames, Math.ceil(d / 2)));
        const deadline = Date.now() + FRAMES_MS;
        video.pause();
        const canvas = doc.createElement('canvas');
        for (let k = 0; k < n && Date.now() < deadline; k++) {
          const t = ((k + 0.5) / n) * d;
          const seeked = once(video, 'seeked', SEEK_MS);
          video.currentTime = t;
          await seeked;
          if (video.readyState < 2) await Promise.race([once(video, 'loadeddata', SEEK_MS), sleep(SEEK_MS)]);
          const w = video.videoWidth;
          const h = video.videoHeight;
          if (!w || !h) continue;
          const scale = Math.min(1, FRAME_EDGE / Math.max(w, h));
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          const ctx = canvas.getContext('2d');
          if (!ctx) break;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          // A cross-origin video taints the canvas: toDataURL throws, and the frames end here.
          let jpeg = canvas.toDataURL('image/jpeg', 0.6);
          if (jpeg.length > FRAME_CHARS) jpeg = canvas.toDataURL('image/jpeg', 0.4);
          if (jpeg.startsWith('data:image/jpeg;base64,') && jpeg.length <= FRAME_CHARS) frames.push({ at: Math.round(t * 10) / 10, jpeg });
        }
        video.pause();
      }
    } catch {
      // No frames: never an error.
    }
  }

  return {
    finalUrl: String(g.location.href).slice(0, 2000),
    ...(title ? { title } : {}),
    meta,
    jsonld,
    text,
    ...(author ? { author: one(author, NAME_MAX) } : {}),
    ...(handle ? { handle } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    media,
    frames,
    ...(duration !== undefined ? { duration } : {}),
    ...(comments ? { comments } : {}),
    ...(why ? { why } : {}),
  };
}
