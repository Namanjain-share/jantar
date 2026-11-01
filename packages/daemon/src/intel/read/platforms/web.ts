/**
 * Any other https page (spec 3.6): og/twitter/article meta, ld+json
 * (`NewsArticle`, `Article`, `BlogPosting`, …), `<title>`, the main text
 * (html.ts), `og:image` as the article's picture, and `og:video` when it is
 * a direct https mp4.
 */
import type { PageReadParsed } from '@jantar/protocol';
import { ldIs, ldObjects, metaOf, readHtml, type HtmlRead } from '../html.js';
import { body, claudeMeta, emptyFields, fromPageRead, httpsUrl, isoOf, line, type PageFields } from './common.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const ARTICLES = ['NewsArticle', 'Article', 'BlogPosting', 'TechArticle', 'Report', 'ScholarlyArticle', 'AnalysisNewsArticle'];

function authorOf(a: unknown): string | undefined {
  if (typeof a === 'string') return line(a, 80);
  if (Array.isArray(a)) return authorOf(a[0]);
  return isObj(a) ? line(a.name, 80) : undefined;
}

/** An og:video that is a direct https mp4. */
function mp4Of(v: string | undefined): string | undefined {
  const u = httpsUrl(v);
  if (!u) return undefined;
  try {
    return new URL(u).pathname.toLowerCase().endsWith('.mp4') ? u : undefined;
  } catch {
    return undefined;
  }
}

function fromParts(page: Pick<HtmlRead, 'title' | 'meta' | 'jsonld'>, text: string, f: PageFields = emptyFields()): PageFields {
  const art = ldObjects(page.jsonld).find((o) => ldIs(o, ...ARTICLES));
  const title = line(metaOf(page.meta, 'og:title', 'twitter:title') ?? art?.headline ?? page.title, 300);
  if (title) f.title = title;
  if (!f.text) f.text = body(text, 40_000);
  const author = f.creator ?? authorOf(art?.author) ?? line(metaOf(page.meta, 'author', 'article:author'), 80);
  if (author) f.creator = author;
  const at = f.postedAt ?? isoOf(metaOf(page.meta, 'article:published_time') ?? art?.datePublished);
  if (at) f.postedAt = at;
  f.cover = f.cover ?? httpsUrl(metaOf(page.meta, 'og:image', 'twitter:image'));
  f.video = f.video ?? mp4Of(metaOf(page.meta, 'og:video:secure_url', 'og:video:url', 'og:video'));
  f.article = !!art || metaOf(page.meta, 'og:type') === 'article';
  f.meta = claudeMeta(page.meta);
  return f;
}

export function webFromHtml(html: string): PageFields {
  const page = readHtml(html);
  return fromParts(page, page.text);
}

export function webFromPage(read: PageReadParsed): PageFields {
  const f = fromPageRead(read);
  return fromParts({ ...(read.title ? { title: read.title } : {}), meta: read.meta, jsonld: read.jsonld }, read.text, f);
}
