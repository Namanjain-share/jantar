/**
 * YouTube (spec 3.6): oEmbed (title, author), then the watch page's
 * `ytInitialPlayerResponse` for the details. That object is far larger than
 * any block we parse, so only its parts are cut out and parsed:
 * `"videoDetails":{…}` (title, author, lengthSeconds, keywords,
 * shortDescription) and `"captionTracks":[…]` (whether captions exist and
 * their languages). Frames come from i.ytimg.com (hq1..hq3), the cover from
 * maxresdefault (else hqdefault): no video download.
 */
import type { PageReadParsed } from '@jantar/protocol';
import { jsonAfter, metaOf, readHtml } from '../html.js';
import { body, claudeMeta, emptyFields, fromPageRead, isoOf, line, type PageFields } from './common.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The i.ytimg.com frames (about 25/50/75 %) and covers of a video id. */
export function ytFrameUrls(id: string): string[] {
  return ['hq1', 'hq2', 'hq3'].map((n) => `https://i.ytimg.com/vi/${id}/${n}.jpg`);
}
export function ytCoverUrls(id: string): string[] {
  return [`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`];
}

/** oEmbed's title and author. */
export function youtubeFromOembed(json: unknown): PageFields {
  const f = emptyFields();
  if (!isObj(json)) return f;
  const title = line(json.title, 300);
  if (title) f.title = title;
  const author = line(json.author_name, 80);
  if (author) f.creator = author;
  return f;
}

/** The watch page: videoDetails, caption languages, the publish date. */
export function youtubeFromWatch(html: string, into: PageFields = emptyFields()): PageFields {
  const f = into;
  const details = jsonAfter(html, '"videoDetails":');
  if (isObj(details)) {
    const title = line(details.title, 300);
    if (title) f.title = title;
    const author = line(details.author, 80);
    if (author) f.creator = author;
    const secs = Number(details.lengthSeconds);
    if (Number.isFinite(secs) && secs > 0) f.duration = secs;
    const desc = body(details.shortDescription, 40_000);
    if (desc) f.text = desc;
    if (Array.isArray(details.keywords)) {
      const words = details.keywords.filter((k): k is string => typeof k === 'string').slice(0, 15);
      if (words.length) f.meta = [...f.meta, { k: 'keywords', v: words.join(', ').slice(0, 500) }];
    }
  }
  const tracks = jsonAfter(html, '"captionTracks":');
  const langs = Array.isArray(tracks) ? tracks.filter(isObj).map((t) => (typeof t.languageCode === 'string' ? t.languageCode : '')).filter((l) => /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(l)) : [];
  const page = readHtml(html, { textMax: 0 });
  const lang = langs[0]?.split('-')[0] ?? page.lang?.split('-')[0];
  f.youtube = { ...(lang && /^[a-z]{2,3}$/.test(lang) ? { lang } : {}), captions: langs.length > 0 };
  const at = isoOf(metaOf(page.meta, 'itemprop:datepublished', 'itemprop:uploaddate'));
  if (at && !f.postedAt) f.postedAt = at;
  f.meta = [...claudeMeta(page.meta), ...f.meta.filter((m) => m.k === 'keywords')];
  return f;
}

/** An in-page read (Chrome). */
export function youtubeFromPage(read: PageReadParsed): PageFields {
  return fromPageRead(read);
}
