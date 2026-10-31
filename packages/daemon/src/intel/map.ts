/**
 * One JSONL record as a shelf item (v0.4 spec 4.9). The common fields are
 * mapped by name, the first candidate that gives a usable value winning;
 * every other plain field is kept as a label and a value, so any bot's
 * records work without a schema. Records come from other programs, so
 * nothing here trusts a field's type.
 *
 *   id       id (printable, at most 128), else sha256(source, url, title)
 *   title    title, name, headline (required: no title, no item)
 *   url      url, link (http and https only)
 *   at       captured_at, created_at, at, ts, date (ISO text, epoch s or ms)
 *   type     type, kind
 *   tags     tags (an array; its strings only, at most 20)
 *   summary  what_it_is, summary, description, text
 *   why      why_it_matters, why
 *   fields   every other string, number, boolean or array of strings, in
 *            file order, at most 20; objects are skipped
 */
import { IntelItemSchema, type IntelItem, type IntelListItem } from '@jantar/protocol';
import { sha256Hex } from '../core/hash.js';
import { isObj, toEpochMs } from '../sources/lib/values.js';

export interface MappedRecord {
  /** The record's own id (or its hash); the item's id is `<source>:<rid>`. */
  rid: string;
  item: IntelItem;
  /** Epoch ms of `item.at`, -1 without one (sorts last). */
  atMs: number;
}

const TITLE_MAX = 300;
const TYPE_MAX = 40;
const TAG_MAX = 40;
const TAGS_MAX = 20;
const TEXT_MAX = 2000;
const FIELD_KEY_MAX = 40;
const FIELDS_MAX = 20;
const RID_MAX = 128;
/** IntelIdSchema's length: a record id that would not fit after its source is hashed instead. */
const WIRE_ID_MAX = 160;
const SUMMARY_LIST_MAX = 240;

const RID = /^[\x21-\x7e]+$/;
const LINK = IntelItemSchema.shape.url;

/** `s` cut to `max` UTF-16 units with an ellipsis, never splitting a surrogate pair. */
export function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max - 1;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${s.slice(0, end)}…`;
}

function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : cut(t, max);
}

/**
 * An http(s) link the protocol accepts, as the URL parser writes it (a space
 * in the path becomes %20, so the phone's one-whole-address check agrees),
 * or undefined (never a `javascript:`, `data:` or relative URL).
 */
export function httpLink(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t === '' || !LINK.safeParse(t).success) return undefined;
  let href: string;
  try {
    href = new URL(t).href;
  } catch {
    return undefined;
  }
  // Encoding can push a link past the protocol's length.
  return LINK.safeParse(href).success ? href : undefined;
}

/** The first of `keys` whose value `read` accepts, and that key. */
function first<T>(rec: Record<string, unknown>, keys: readonly string[], read: (v: unknown) => T | undefined): { key: string; value: T } | null {
  for (const key of keys) {
    if (!Object.hasOwn(rec, key)) continue;
    const value = read(rec[key]);
    if (value !== undefined) return { key, value };
  }
  return null;
}

function readTags(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const t of v) {
    if (typeof t !== 'string' || t.trim() === '') continue;
    out.push(t.trim().slice(0, TAG_MAX));
    if (out.length === TAGS_MAX) break;
  }
  return out;
}

function readAt(v: unknown): number | undefined {
  return toEpochMs(v);
}

function fieldValue(v: unknown): string | undefined {
  if (typeof v === 'string') return text(v, TEXT_MAX);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : undefined;
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) return text(v.join(', '), TEXT_MAX);
  return undefined;
}

/**
 * A parsed line as an item of `source`, or null when it is not a JSON
 * object or has no title (the follower counts it as skipped).
 */
export function mapRecord(raw: unknown, source: string): MappedRecord | null {
  if (!isObj(raw)) return null;
  const title = first(raw, ['title', 'name', 'headline'], (v) => text(v, TITLE_MAX));
  if (!title) return null;
  const url = first(raw, ['url', 'link'], httpLink);
  const at = first(raw, ['captured_at', 'created_at', 'at', 'ts', 'date'], readAt);
  const type = first(raw, ['type', 'kind'], (v) => text(v, TYPE_MAX));
  const tags = first(raw, ['tags'], readTags);
  const summary = first(raw, ['what_it_is', 'summary', 'description', 'text'], (v) => text(v, TEXT_MAX));
  const why = first(raw, ['why_it_matters', 'why'], (v) => text(v, TEXT_MAX));

  const used = new Set(['id']);
  for (const hit of [title, url, at, type, tags, summary, why]) if (hit) used.add(hit.key);
  const fields: IntelItem['fields'] = [];
  for (const [key, v] of Object.entries(raw)) {
    if (used.has(key)) continue;
    const value = fieldValue(v);
    if (value === undefined) continue;
    fields.push({ key: key.slice(0, FIELD_KEY_MAX), value });
    if (fields.length === FIELDS_MAX) break;
  }

  const own = typeof raw.id === 'string' ? raw.id : typeof raw.id === 'number' && Number.isSafeInteger(raw.id) ? String(raw.id) : '';
  const fits = own.length <= RID_MAX && source.length + 1 + own.length <= WIRE_ID_MAX && RID.test(own);
  const rid = fits ? own : sha256Hex(`${source}\n${url?.value ?? ''}\n${title.value}`).slice(0, 24);

  const item: IntelItem = {
    id: `${source}:${rid}`,
    source,
    at: at ? new Date(at.value).toISOString() : null,
    title: title.value,
    tags: tags?.value ?? [],
    fields,
  };
  if (url) item.url = url.value;
  if (type) item.type = type.value;
  if (summary) item.summary = summary.value;
  if (why) item.why = why.value;
  return { rid, item, atMs: at ? at.value : -1 };
}

/** The list row of an item: no why, no fields, the summary cut for two lines. */
export function listItem(item: IntelItem): IntelListItem {
  const row: IntelListItem = { id: item.id, source: item.source, at: item.at, title: item.title, tags: item.tags };
  if (item.url !== undefined) row.url = item.url;
  if (item.type !== undefined) row.type = item.type;
  if (item.summary !== undefined) row.summary = cut(item.summary, SUMMARY_LIST_MAX);
  return row;
}
