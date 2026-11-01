/**
 * The shelf in memory (v0.4 spec 4.9): the items of every source, keyed by
 * record id per source (a later record with the same id replaces the
 * earlier), newest first. On the wire an item's id is
 * `<source id>:<record id>`, so two sources never collide.
 *
 * Order: `at` descending, then file order descending (items with no time
 * last). Past INTEL_MAX_ITEMS in total the oldest are dropped and counted.
 * `type` filters exactly and `tag` case-insensitively. `types` is counted
 * over the items the search and tag let through, and the top 30 `tags` over
 * those the search and type let through, so the chips still offer the other
 * choices while one is picked.
 *
 * v0.5.3 search (one implementation for the phone, the CLI's list and
 * `jantar mcp`): the query's words (protocol searchTerms: a "quoted phrase"
 * is one) must every one appear, without case, in the title, what it is,
 * why it matters, the type, a tag, the link or a field value. Under `best`
 * (the default with words) each word scores the best place it was found:
 * a word start in the title 6, elsewhere in the title 4, equal to a tag or
 * the type 3, inside one 2, anywhere else 1; the sum ranks the list, newest
 * first within a score. `new` (the default without words) keeps the order
 * above. Each entry keeps its lowercased text from the first search on (a
 * changed record is a new entry, so it is never stale).
 *
 * A capture made from the CLI keeps the folder it ran in (`cwd`) in the
 * captures file; the shelf leaves that field out, so no Mac path reaches a
 * phone or a search.
 */
import { INTEL_MAX_ITEMS, searchTerms, type IntelItem, type IntelListQuery, type IntelListResponse } from '@jantar/protocol';
import { listItem, type MappedRecord } from './map.js';
import { CAPTURES_SOURCE } from './sources.js';

const TAGS_SHOWN = 30;

interface Entry {
  source: string;
  rid: string;
  item: IntelItem;
  atMs: number;
  /** Arrival order: file order within a source. */
  seq: number;
  /** What a search reads, lowercased; built the first time one does (textOf). */
  text?: SearchText;
}

interface SearchText {
  /** Every searched field, one per line (a word never spans two). */
  all: string;
  title: string;
  type: string;
  tags: string[];
}

/** A search word, with its "starts a word in the title" test. */
interface Term {
  word: string;
  start: RegExp;
}

/** The item as the shelf holds it: a capture without its CLI folder. */
function shelved(source: string, item: IntelItem): IntelItem {
  if (source !== CAPTURES_SOURCE || !item.fields.some((f) => f.key === 'cwd')) return item;
  return { ...item, fields: item.fields.filter((f) => f.key !== 'cwd') };
}

function newestFirst(a: Entry, b: Entry): number {
  return b.atMs - a.atMs || b.seq - a.seq;
}

/** A url as the shelf compares them (scheme and host case, a bare host's "/"). */
export function urlKey(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textOf(e: Entry): SearchText {
  if (!e.text) {
    const { item } = e;
    const tags = item.tags.map((t) => t.toLowerCase());
    const type = item.type?.toLowerCase() ?? '';
    const title = item.title.toLowerCase();
    const rest = [item.summary, item.why, item.url, ...item.fields.map((f) => f.value)].filter((v) => v !== undefined);
    e.text = { all: [title, type, ...tags, ...rest.map((v) => v.toLowerCase())].join('\n'), title, type, tags };
  }
  return e.text;
}

/**
 * The query's words. A word start is the title's start or a place after
 * anything but a letter, a mark or a digit (a Devanagari vowel sign is no
 * word break).
 */
function termsOf(q: string | undefined): Term[] {
  return searchTerms(q ?? '').map((word) => ({ word, start: new RegExp(`(?:^|[^\\p{L}\\p{M}\\p{N}])${escapeRegExp(word)}`, 'u') }));
}

/** The sum over the words of the best place each was found (the module comment's points). */
function scoreOf(t: SearchText, terms: readonly Term[]): number {
  let score = 0;
  for (const { word, start } of terms) {
    if (start.test(t.title)) score += 6;
    else if (t.title.includes(word)) score += 4;
    else if (t.type === word || t.tags.includes(word)) score += 3;
    else if (t.type.includes(word) || t.tags.some((x) => x.includes(word))) score += 2;
    else score += 1;
  }
  return score;
}

/** Best score first; the order given (newest first) within a score. */
function ranked(items: readonly Entry[], terms: readonly Term[]): Entry[] {
  return items
    .map((e, i) => ({ e, i, score: scoreOf(textOf(e), terms) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.e);
}

/** The `next` cursor after `e`: `<at>|<source>|<record id>`. */
function cursorOf(e: Entry): string {
  return `${e.item.at ?? ''}|${e.source}|${e.rid}`;
}

/** The `next` cursor under `best`: `#<where the next page starts>|<source>|<record id of the last item>`. */
function bestCursorOf(e: Entry, offset: number): string {
  return `#${offset}|${e.source}|${e.rid}`;
}

/**
 * Where the page after a `best` cursor starts: right after its item while
 * that is still in the list, else at its offset. A cursor of the other kind
 * starts from the top.
 */
function startAfterBest(items: readonly Entry[], cursor: string): number {
  const i = cursor.indexOf('|');
  const j = cursor.indexOf('|', i + 1);
  if (!cursor.startsWith('#') || i < 0 || j < 0) return 0;
  const source = cursor.slice(i + 1, j);
  const rid = cursor.slice(j + 1);
  const hit = items.findIndex((e) => e.source === source && e.rid === rid);
  if (hit >= 0) return hit + 1;
  const offset = Number(cursor.slice(1, i));
  return Number.isSafeInteger(offset) && offset >= 0 ? Math.min(offset, items.length) : 0;
}

/** Where the page after `cursor` starts in `items` (newest first). */
function startAfter(items: readonly Entry[], cursor: string): number {
  // A `best` cursor (startAfterBest) starts from the top.
  if (cursor.startsWith('#')) return 0;
  const i = cursor.indexOf('|');
  const j = cursor.indexOf('|', i + 1);
  if (i < 0 || j < 0) return 0;
  const at = cursor.slice(0, i);
  const source = cursor.slice(i + 1, j);
  const rid = cursor.slice(j + 1);
  const hit = items.findIndex((e) => e.source === source && e.rid === rid);
  if (hit >= 0) return hit + 1;
  // That item is gone (replaced or dropped): carry on from anything older than it.
  if (at === '') {
    // Undated items keep no time to compare: start again at the first, so none is lost (the phone shows each id once).
    const undated = items.findIndex((e) => e.atMs < 0);
    return undated < 0 ? items.length : undated;
  }
  const atMs = Date.parse(at);
  const next = items.findIndex((e) => e.atMs < atMs);
  return next < 0 ? items.length : next;
}

export class Shelf {
  private readonly bySource = new Map<string, Map<string, Entry>>();
  private seq = 0;
  private sorted: Entry[] | null = null;
  private urls: Map<string, string> | null = null;
  /** Items dropped for the cap since start. */
  dropped = 0;

  constructor(private readonly max = INTEL_MAX_ITEMS) {}

  /** A whole read of `source`: what it had is replaced by `records`. */
  replace(source: string, records: readonly MappedRecord[]): void {
    this.bySource.set(source, new Map());
    this.add(source, records);
  }

  /** Appended records of `source` (an id it already has is replaced). */
  add(source: string, records: readonly MappedRecord[]): void {
    let items = this.bySource.get(source);
    if (!items) {
      items = new Map();
      this.bySource.set(source, items);
    }
    for (const r of records) items.set(r.rid, { source, rid: r.rid, item: shelved(source, r.item), atMs: r.atMs, seq: this.seq++ });
    this.changed();
    this.cap();
  }

  /** A source that left the settings (or Intel turned off). */
  remove(source: string): void {
    if (this.bySource.delete(source)) this.changed();
  }

  clear(): void {
    this.bySource.clear();
    this.changed();
  }

  count(source: string): number {
    return this.bySource.get(source)?.size ?? 0;
  }

  size(): number {
    let n = 0;
    for (const items of this.bySource.values()) n += items.size;
    return n;
  }

  get(id: string): IntelItem | null {
    const i = id.indexOf(':');
    if (i < 0) return null;
    return this.bySource.get(id.slice(0, i))?.get(id.slice(i + 1))?.item ?? null;
  }

  /** The id of the newest item with this url, if any. */
  findUrl(url: string): string | null {
    if (!this.urls) {
      this.urls = new Map();
      for (const e of this.order()) {
        if (e.item.url === undefined) continue;
        const key = urlKey(e.item.url);
        if (!this.urls.has(key)) this.urls.set(key, e.item.id);
      }
    }
    return this.urls.get(urlKey(url)) ?? null;
  }

  list(q: IntelListQuery): IntelListResponse {
    const terms = termsOf(q.q);
    const best = terms.length > 0 && q.sort !== 'new';
    const tag = q.tag?.toLowerCase();
    let shown: Entry[] = [];
    const types = new Map<string, number>();
    const tags = new Map<string, { tag: string; n: number }>();
    for (const e of this.order()) {
      if (terms.length && !terms.every((t) => textOf(e).all.includes(t.word))) continue;
      const typeOk = q.type === undefined || e.item.type === q.type;
      const tagOk = tag === undefined || e.item.tags.some((t) => t.toLowerCase() === tag);
      if (tagOk && e.item.type !== undefined) types.set(e.item.type, (types.get(e.item.type) ?? 0) + 1);
      if (typeOk) {
        for (const t of new Set(e.item.tags.map((x) => x.toLowerCase()))) {
          const c = tags.get(t);
          if (c) c.n += 1;
          else tags.set(t, { tag: e.item.tags.find((x) => x.toLowerCase() === t) ?? t, n: 1 });
        }
      }
      if (typeOk && tagOk) shown.push(e);
    }
    if (best) shown = ranked(shown, terms);
    const start = q.before ? (best ? startAfterBest(shown, q.before) : startAfter(shown, q.before)) : 0;
    const page = shown.slice(start, start + q.limit);
    const last = page.at(-1);
    const end = start + page.length;
    return {
      items: page.map((e) => listItem(e.item)),
      next: last && end < shown.length ? (best ? bestCursorOf(last, end) : cursorOf(last)) : null,
      total: shown.length,
      types: [...types].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n || a.type.localeCompare(b.type)),
      tags: [...tags.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)).slice(0, TAGS_SHOWN),
    };
  }

  private order(): Entry[] {
    if (!this.sorted) {
      const all: Entry[] = [];
      for (const items of this.bySource.values()) for (const e of items.values()) all.push(e);
      this.sorted = all.sort(newestFirst);
    }
    return this.sorted;
  }

  private changed(): void {
    this.sorted = null;
    this.urls = null;
  }

  /** Over the cap: drop the oldest. */
  private cap(): void {
    let over = this.size() - this.max;
    if (over <= 0) return;
    const order = this.order();
    for (let i = order.length - 1; i >= 0 && over > 0; i--, over--) {
      const e = order[i] as Entry;
      this.bySource.get(e.source)?.delete(e.rid);
      this.dropped += 1;
    }
    this.changed();
  }
}
