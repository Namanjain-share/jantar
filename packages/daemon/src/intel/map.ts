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
 *
 * v0.8: in the daemon's own captures file only (`source === 'captures'`), an
 * item read from a link carries typed keys (CAPTURE_RICH_KEYS): platform,
 * creator, posted_at, depth, read, caption, transcript, on_screen, points,
 * background, note, frames, each checked and cut, never a field. In any
 * other source they stay plain fields, so a bot's file can never claim
 * frames, a job state or media. `{ id, deleted: true }` in captures is a
 * tombstone: that id leaves the shelf.
 */
import {
  INTEL_READ_LIMITS,
  IntelDepthSchema,
  IntelItemSchema,
  IntelPlatformSchema,
  IntelReadSchema,
  type IntelItem,
  type IntelListItem,
} from '@jantar/protocol';
import { sha256Hex } from '../core/hash.js';
import { isObj, toEpochMs } from '../sources/lib/values.js';

export interface MappedRecord {
  /** The record's own id (or its hash); the item's id is `<source>:<rid>`. */
  rid: string;
  item: IntelItem;
  /** Epoch ms of `item.at`, -1 without one (sorts last). */
  atMs: number;
  /** v0.8, captures only: a tombstone (the shelf drops `rid`; `item` is a placeholder). */
  deleted?: true;
}

/** v0.8: the source whose records may carry the typed keys of a read item. */
const CAPTURES = 'captures';

/** v0.8: the typed keys of an item read from a link (captures only). */
export const CAPTURE_RICH_KEYS: readonly string[] = [
  'platform',
  'creator',
  'posted_at',
  'depth',
  'read',
  'caption',
  'transcript',
  'on_screen',
  'points',
  'background',
  'note',
  'frames',
  'deleted',
];

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

/** The record's own id when it fits (printable, short), else ''. */
function ownId(raw: Record<string, unknown>, source: string): string {
  const own = typeof raw.id === 'string' ? raw.id : typeof raw.id === 'number' && Number.isSafeInteger(raw.id) ? String(raw.id) : '';
  return own.length <= RID_MAX && source.length + 1 + own.length <= WIRE_ID_MAX && RID.test(own) ? own : '';
}

/**
 * v0.8: what the captures store needs of a line: its record id as the shelf
 * keys it (mapRecord's rule) and whether it is a tombstone, or null when the
 * shelf would skip it (no title, not an object). A tombstone needs its own id.
 */
export function recordKey(raw: unknown, source: string): { rid: string; deleted: boolean } | null {
  if (!isObj(raw)) return null;
  if (source === CAPTURES && raw.deleted === true) {
    const own = ownId(raw, source);
    return own ? { rid: own, deleted: true } : null;
  }
  const title = first(raw, ['title', 'name', 'headline'], (v) => text(v, TITLE_MAX));
  if (!title) return null;
  const url = first(raw, ['url', 'link'], httpLink);
  return { rid: ownId(raw, source) || sha256Hex(`${source}\n${url?.value ?? ''}\n${title.value}`).slice(0, 24), deleted: false };
}

/** v0.8: a captures line's typed keys, each checked and cut (anything else is dropped). */
function richOf(raw: Record<string, unknown>): Partial<IntelItem> {
  const out: Partial<IntelItem> = {};
  const platform = IntelPlatformSchema.safeParse(raw.platform);
  if (platform.success) out.platform = platform.data;
  const creator = text(raw.creator, 80);
  if (creator) out.creator = creator;
  const posted = toEpochMs(raw.posted_at);
  if (posted !== undefined) out.postedAt = new Date(posted).toISOString();
  const depth = IntelDepthSchema.safeParse(raw.depth);
  if (depth.success) out.depth = depth.data;
  const read = IntelReadSchema.safeParse(raw.read);
  if (read.success) out.read = read.data;
  const caption = longText(raw.caption, INTEL_READ_LIMITS.captionMax);
  if (caption) out.caption = caption;
  const transcript = longText(raw.transcript, INTEL_READ_LIMITS.transcriptMax);
  if (transcript) out.transcript = transcript;
  const onScreen = longText(raw.on_screen, INTEL_READ_LIMITS.onScreenMax);
  if (onScreen) out.onScreen = onScreen;
  if (Array.isArray(raw.points)) {
    const points = raw.points.map((p) => text(p, 200)).filter((p): p is string => p !== undefined).slice(0, 6);
    if (points.length) out.points = points;
  }
  const background = longText(raw.background, 600);
  if (background) out.background = background;
  const note = longText(raw.note, INTEL_READ_LIMITS.noteMax);
  if (note) out.note = note;
  if (typeof raw.frames === 'number' && Number.isInteger(raw.frames) && raw.frames >= 0) out.frames = Math.min(raw.frames, INTEL_READ_LIMITS.thumbsMax);
  return out;
}

/** Text that keeps its line breaks, trimmed and cut. */
function longText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : cut(t, max);
}

/**
 * A parsed line as an item of `source`, or null when it is not a JSON
 * object or has no title (the follower counts it as skipped).
 */
export function mapRecord(raw: unknown, source: string): MappedRecord | null {
  if (!isObj(raw)) return null;
  const rich = source === CAPTURES;
  if (rich && raw.deleted === true) {
    const own = ownId(raw, source);
    if (!own) return null;
    return { rid: own, deleted: true, atMs: -1, item: { id: `${source}:${own}`, source, at: null, title: '-', tags: [], fields: [] } };
  }
  const title = first(raw, ['title', 'name', 'headline'], (v) => text(v, TITLE_MAX));
  if (!title) return null;
  const url = first(raw, ['url', 'link'], httpLink);
  const at = first(raw, ['captured_at', 'created_at', 'at', 'ts', 'date'], readAt);
  const type = first(raw, ['type', 'kind'], (v) => text(v, TYPE_MAX));
  const tags = first(raw, ['tags'], readTags);
  const summary = first(raw, ['what_it_is', 'summary', 'description', 'text'], (v) => text(v, TEXT_MAX));
  const why = first(raw, ['why_it_matters', 'why'], (v) => text(v, TEXT_MAX));

  const used = new Set(['id', ...(rich ? CAPTURE_RICH_KEYS : [])]);
  for (const hit of [title, url, at, type, tags, summary, why]) if (hit) used.add(hit.key);
  const fields: IntelItem['fields'] = [];
  for (const [key, v] of Object.entries(raw)) {
    if (used.has(key)) continue;
    const value = fieldValue(v);
    if (value === undefined) continue;
    fields.push({ key: key.slice(0, FIELD_KEY_MAX), value });
    if (fields.length === FIELDS_MAX) break;
  }

  const rid = ownId(raw, source) || sha256Hex(`${source}\n${url?.value ?? ''}\n${title.value}`).slice(0, 24);

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
  if (rich) Object.assign(item, richOf(raw));
  return { rid, item, atMs: at ? at.value : -1 };
}

/** The list row of an item: no why, no fields, the summary cut for two lines. v0.8: platform, creator, the read's state and reason, a thumb. */
export function listItem(item: IntelItem): IntelListItem {
  const row: IntelListItem = { id: item.id, source: item.source, at: item.at, title: item.title, tags: item.tags };
  if (item.url !== undefined) row.url = item.url;
  if (item.type !== undefined) row.type = item.type;
  if (item.summary !== undefined) row.summary = cut(item.summary, SUMMARY_LIST_MAX);
  if (item.platform !== undefined) row.platform = item.platform;
  if (item.creator !== undefined) row.creator = item.creator;
  if (item.read !== undefined) row.read = { state: item.read.state, ...(item.read.reason !== undefined ? { reason: item.read.reason } : {}) };
  if ((item.frames ?? 0) > 0) row.thumb = true;
  return row;
}
