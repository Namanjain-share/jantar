/**
 * The HTML reader (spec 3.6): meta pairs, ld+json blocks, the title and the
 * main text of a page, in-house and linear-time.
 *
 * One hand-written scan over the body (at most 5 MB): `indexOf` and
 * `charCodeAt` only, every position visited a fixed number of times, so a
 * hostile page (5 MB of "<", an unclosed comment, attribute or quote, deep
 * nesting, one 5 MB attribute) is read in well under a second and the job's
 * timer can always fire. No regular expression ever runs over page text;
 * entities are decoded with one simple pattern on a value already cut
 * (≤ 2,000 chars for a meta value, a text run for the main text).
 *
 * Main text: the first <article>'s, else the first <main>'s, else every <p>,
 * leaving out script, style, noscript, template, svg, nav, header, footer,
 * aside, form, select and button. JSON is parsed by the caller, on blocks
 * already cut to ≤ 50,000 chars (`cutJson`).
 */
import { INTEL_READ_LIMITS } from '@jantar/protocol';

export interface HtmlRead {
  title?: string;
  /** og:, twitter:, article:, al:, description, author and itemprop pairs (keys lower case), at most 60, values at most 2,000. */
  meta: { k: string; v: string }[];
  /** At most 5 ld+json blocks, each at most 50,000 chars. */
  jsonld: string[];
  /** The main text, whitespace collapsed, at most `textMax`. */
  text: string;
  /** The <html lang>, when given. */
  lang?: string;
}

const META_MAX = 60;
const META_VALUE_MAX = 2000;
const JSONLD_MAX = 5;
const TITLE_MAX = 2000;

/** Elements whose content is not markup. */
const RAW = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
/** Containers whose text is never the page's main text. */
const SKIP = new Set(['nav', 'header', 'footer', 'aside', 'form', 'select', 'button', 'svg', 'math', 'dialog', 'menu']);
/** Elements that end a run of text (a space goes between their texts). */
const BLOCKS = new Set(['p', 'div', 'br', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'main', 'blockquote', 'tr', 'td', 'th', 'pre', 'figcaption', 'dd', 'dt']);

const KEEP_META = (k: string) =>
  k.startsWith('og:') || k.startsWith('twitter:') || k.startsWith('article:') || k.startsWith('al:') || k.startsWith('itemprop:') || k === 'description' || k === 'author';

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  bull: '•',
  laquo: '«',
  raquo: '»',
};

/** Entities in a short value (never a whole page): one pattern with no nested quantifier. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, (m, body: string) => {
    if (body.startsWith('#')) {
      const n = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return m;
      return String.fromCodePoint(n);
    }
    return NAMED[body.toLowerCase()] ?? m;
  });
}

/** Whitespace runs as one space, trimmed (linear). */
export function collapse(s: string): string {
  let out = '';
  let space = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c || c === 0xa0) {
      space = out.length > 0;
      continue;
    }
    if (space) {
      out += ' ';
      space = false;
    }
    out += s[i];
  }
  return out;
}

function isNameChar(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x5f || c === 0x3a;
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c || c === 0x2f;
}

interface Tag {
  name: string;
  closing: boolean;
  attrs: Map<string, string>;
  /** Where the scan goes on (after the ">"). */
  end: number;
}

/**
 * The tag starting at `lt` (the "<"), or null when what follows is not a
 * tag (text) and the index to go on from, or -1 when the tag never ends (the
 * scan stops: nothing after it is markup we can trust). Attribute values are
 * cut to META_VALUE_MAX + some, never copied whole.
 */
function readTag(html: string, lt: number): Tag | null | -1 {
  let i = lt + 1;
  let closing = false;
  if (html.charCodeAt(i) === 0x2f) {
    closing = true;
    i += 1;
  }
  const start = i;
  while (i < html.length && isNameChar(html.charCodeAt(i))) i += 1;
  if (i === start) return null;
  const name = html.slice(start, Math.min(i, start + 40)).toLowerCase();
  const attrs = new Map<string, string>();
  const n = html.length;
  for (;;) {
    while (i < n && isSpace(html.charCodeAt(i))) i += 1;
    if (i >= n) return -1;
    if (html.charCodeAt(i) === 0x3e) return { name, closing, attrs, end: i + 1 };
    const an = i;
    while (i < n) {
      const c = html.charCodeAt(i);
      if (c === 0x3d || c === 0x3e || isSpace(c)) break;
      i += 1;
    }
    if (i >= n) return -1;
    const attr = html.slice(an, Math.min(i, an + 60)).toLowerCase();
    if (i === an) {
      // a stray character: skip it
      i += 1;
      continue;
    }
    while (i < n && (html.charCodeAt(i) === 0x20 || html.charCodeAt(i) === 0x0a || html.charCodeAt(i) === 0x09 || html.charCodeAt(i) === 0x0d)) i += 1;
    if (html.charCodeAt(i) !== 0x3d) {
      if (!attrs.has(attr)) attrs.set(attr, '');
      continue;
    }
    i += 1;
    while (i < n && (html.charCodeAt(i) === 0x20 || html.charCodeAt(i) === 0x0a || html.charCodeAt(i) === 0x09 || html.charCodeAt(i) === 0x0d)) i += 1;
    if (i >= n) return -1;
    const q = html.charCodeAt(i);
    let vs: number;
    let ve: number;
    if (q === 0x22 || q === 0x27) {
      vs = i + 1;
      ve = html.indexOf(q === 0x22 ? '"' : "'", vs);
      if (ve < 0) return -1;
      i = ve + 1;
    } else {
      vs = i;
      while (i < n) {
        const c = html.charCodeAt(i);
        if (c === 0x3e || c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) break;
        i += 1;
      }
      ve = i;
    }
    if (!attrs.has(attr)) attrs.set(attr, html.slice(vs, Math.min(ve, vs + META_VALUE_MAX + 200)));
  }
}

/** Text collected up to a cap, runs separated by one space. */
class TextBuf {
  parts: string[] = [];
  len = 0;
  constructor(private readonly max: number) {}
  get full(): boolean {
    return this.len >= this.max;
  }
  add(raw: string): void {
    if (this.full) return;
    const t = collapse(decodeEntities(raw.length > this.max ? raw.slice(0, this.max * 2) : raw));
    if (t === '') return;
    this.parts.push(t);
    this.len += t.length + 1;
  }
  text(): string {
    const s = this.parts.join(' ');
    return s.length > this.max ? s.slice(0, this.max) : s;
  }
}

/** Read a page. `textMax` caps the main text (default 40,000). */
export function readHtml(html: string, opts: { textMax?: number } = {}): HtmlRead {
  const textMax = opts.textMax ?? INTEL_READ_LIMITS.pageTextMax;
  const lower = html.toLowerCase();
  const meta: { k: string; v: string }[] = [];
  const jsonld: string[] = [];
  let title: string | undefined;
  let lang: string | undefined;
  const article = new TextBuf(textMax);
  const main = new TextBuf(textMax);
  const paras = new TextBuf(textMax);
  let articleDepth = 0;
  let articleDone = false;
  let mainDepth = 0;
  let mainDone = false;
  let pDepth = 0;
  let skipDepth = 0;

  const text = (raw: string) => {
    if (skipDepth > 0 || raw === '') return;
    if (articleDepth > 0) article.add(raw);
    if (mainDepth > 0) main.add(raw);
    if (pDepth > 0) paras.add(raw);
  };

  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      text(html.slice(i, Math.min(n, i + textMax * 2)));
      break;
    }
    if (lt > i) text(html.slice(i, Math.min(lt, i + textMax * 2)));
    const next = html.charCodeAt(lt + 1);
    if (next === 0x21) {
      // <!-- comment -->, <!DOCTYPE>, <![CDATA[ ]]>
      if (html.startsWith('<!--', lt)) {
        const e = html.indexOf('-->', lt + 4);
        if (e < 0) break;
        i = e + 3;
      } else {
        const e = html.indexOf('>', lt + 2);
        if (e < 0) break;
        i = e + 1;
      }
      continue;
    }
    if (next === 0x3f) {
      const e = html.indexOf('>', lt + 2);
      if (e < 0) break;
      i = e + 1;
      continue;
    }
    const tag = readTag(html, lt);
    if (tag === -1) break;
    if (tag === null) {
      text('<');
      i = lt + 1;
      continue;
    }
    i = tag.end;
    const { name, closing, attrs } = tag;
    if (closing) {
      if (name === 'article' && articleDepth > 0) {
        articleDepth -= 1;
        if (articleDepth === 0) articleDone = true;
      } else if (name === 'main' && mainDepth > 0) {
        mainDepth -= 1;
        if (mainDepth === 0) mainDone = true;
      } else if (name === 'p' && pDepth > 0) pDepth -= 1;
      else if (SKIP.has(name) && skipDepth > 0) skipDepth -= 1;
      if (BLOCKS.has(name)) text(' ');
      continue;
    }
    if (name === 'html' && lang === undefined) {
      const l = attrs.get('lang');
      if (l) lang = l.slice(0, 20);
    }
    if (name === 'meta' && meta.length < META_MAX) {
      const key = (attrs.get('property') ?? attrs.get('name') ?? (attrs.has('itemprop') ? `itemprop:${attrs.get('itemprop')}` : '')).trim().toLowerCase();
      const content = attrs.get('content');
      if (key && content !== undefined && KEEP_META(key)) {
        const v = collapse(decodeEntities(content)).slice(0, META_VALUE_MAX);
        if (v) meta.push({ k: key.slice(0, 100), v });
      }
      continue;
    }
    if (RAW.has(name)) {
      // Its content runs to the closing tag (case aside); never parsed as markup.
      const close = lower.indexOf(`</${name}`, i);
      const contentEnd = close < 0 ? n : close;
      if (name === 'title' && title === undefined) title = collapse(decodeEntities(html.slice(i, Math.min(contentEnd, i + TITLE_MAX * 2)))).slice(0, TITLE_MAX);
      if (name === 'script' && jsonld.length < JSONLD_MAX && (attrs.get('type') ?? '').trim().toLowerCase() === 'application/ld+json') {
        const block = html.slice(i, Math.min(contentEnd, i + INTEL_READ_LIMITS.jsonBlockMax)).trim();
        if (block) jsonld.push(block);
      }
      if (close < 0) break;
      const gt = html.indexOf('>', close);
      if (gt < 0) break;
      i = gt + 1;
      continue;
    }
    if (name === 'article' && !articleDone) articleDepth += 1;
    else if (name === 'main' && !mainDone) mainDepth += 1;
    else if (name === 'p') pDepth += 1;
    else if (SKIP.has(name)) skipDepth += 1;
    if (BLOCKS.has(name)) text(' ');
  }

  const best = article.len > 0 ? article.text() : main.len > 0 ? main.text() : paras.text();
  return { ...(title ? { title } : {}), meta, jsonld, text: best, ...(lang ? { lang } : {}) };
}

/** The first value of `key` among the pairs (keys lower case). */
export function metaOf(meta: readonly { k: string; v: string }[], ...keys: string[]): string | undefined {
  for (const key of keys) {
    const hit = meta.find((m) => m.k === key);
    if (hit && hit.v !== '') return hit.v;
  }
  return undefined;
}

/**
 * The JSON value (object or array) that starts at `from` in `text`, cut by
 * a linear scan that knows strings and escapes, or null when it does not
 * close within `max` chars.
 */
export function cutJson(text: string, from: number, max: number = INTEL_READ_LIMITS.jsonBlockMax): string | null {
  const open = text.charCodeAt(from);
  if (open !== 0x7b && open !== 0x5b) return null;
  let depth = 0;
  let inString = false;
  const end = Math.min(text.length, from + max);
  for (let i = from; i < end; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i += 1;
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) depth += 1;
    else if (c === 0x7d || c === 0x5d) {
      depth -= 1;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

/** JSON.parse of `block` (already cut), or null. */
export function parseJson(block: string | null | undefined): unknown {
  if (!block || block.length > INTEL_READ_LIMITS.jsonBlockMax) return null;
  try {
    return JSON.parse(block);
  } catch {
    return null;
  }
}

/**
 * The value after the first `"<key>":` in `text` (a marker found with
 * indexOf), cut with cutJson and parsed, or null.
 */
export function jsonAfter(text: string, marker: string, max: number = INTEL_READ_LIMITS.jsonBlockMax): unknown {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  let i = at + marker.length;
  while (i < text.length && (text.charCodeAt(i) === 0x20 || text.charCodeAt(i) === 0x3a)) i += 1;
  return parseJson(cutJson(text, i, max));
}

/** The ld+json objects of a page, @graph entries flattened (at most 40). */
export function ldObjects(blocks: readonly string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const push = (v: unknown) => {
    if (out.length >= 40) return;
    if (Array.isArray(v)) for (const x of v) push(x);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      out.push(o);
      if (Array.isArray(o['@graph'])) push(o['@graph']);
    }
  };
  for (const b of blocks) push(parseJson(b));
  return out;
}

/** Whether an ld+json object's @type is (or includes) one of `types`. */
export function ldIs(o: Record<string, unknown>, ...types: string[]): boolean {
  const t = o['@type'];
  if (typeof t === 'string') return types.includes(t);
  return Array.isArray(t) && t.some((x) => typeof x === 'string' && types.includes(x));
}
