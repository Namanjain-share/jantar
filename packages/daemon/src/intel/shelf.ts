/**
 * The shelf in memory (v0.4 spec 4.9): the items of every source, keyed by
 * record id per source (a later record with the same id replaces the
 * earlier), newest first. On the wire an item's id is
 * `<source id>:<record id>`, so two sources never collide.
 *
 * Order: `at` descending, then file order descending (items with no time
 * last). Past INTEL_MAX_ITEMS in total the oldest are dropped and counted.
 * Search is a case-insensitive substring over the title, summary, why, tags
 * and field values; `type` filters exactly and `tag` case-insensitively.
 * `types` is counted over the items the search and tag let through, and
 * the top 30 `tags` over those the search and type let through, so the
 * chips still offer the other choices while one is picked.
 *
 * A capture made from the CLI keeps the folder it ran in (`cwd`) in the
 * captures file; the shelf leaves that field out, so no Mac path reaches a
 * phone or a search.
 */
import { INTEL_MAX_ITEMS, type IntelItem, type IntelListQuery, type IntelListResponse } from '@jantar/protocol';
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

function matches(item: IntelItem, re: RegExp): boolean {
  return (
    re.test(item.title) ||
    (item.summary !== undefined && re.test(item.summary)) ||
    (item.why !== undefined && re.test(item.why)) ||
    item.tags.some((t) => re.test(t)) ||
    item.fields.some((f) => re.test(f.value))
  );
}

/** The `next` cursor after `e`: `<at>|<source>|<record id>`. */
function cursorOf(e: Entry): string {
  return `${e.item.at ?? ''}|${e.source}|${e.rid}`;
}

/** Where the page after `cursor` starts in `items` (newest first). */
function startAfter(items: readonly Entry[], cursor: string): number {
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
    const needle = q.q?.trim();
    const re = needle ? new RegExp(escapeRegExp(needle), 'i') : null;
    const tag = q.tag?.toLowerCase();
    const shown: Entry[] = [];
    const types = new Map<string, number>();
    const tags = new Map<string, { tag: string; n: number }>();
    for (const e of this.order()) {
      if (re && !matches(e.item, re)) continue;
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
    const start = q.before ? startAfter(shown, q.before) : 0;
    const page = shown.slice(start, start + q.limit);
    const last = page.at(-1);
    return {
      items: page.map((e) => listItem(e.item)),
      next: last && start + page.length < shown.length ? cursorOf(last) : null,
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
