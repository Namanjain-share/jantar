/**
 * The Intel shelf's small rules (v0.4 spec 5.8): which values are links,
 * how dates read, how typed tags split, and where each view lives. Pure,
 * so the screens stay thin and the rules are tested on their own.
 */
import { CLI_NAME } from '@jantar/protocol';
import { routePath } from '../../../lib/router.js';

/** Items per page: the first load and each Show more. */
export const PAGE = 50;
export const SEARCH_DEBOUNCE_MS = 300;

export const NO_SOURCES = 'Add a JSONL file on your Mac:';
/** A template, not a literal: the sentence sweep cannot stand in a .jsonl file for its argument. */
export const ADD_SOURCE_COMMAND = `${CLI_NAME} intel source add <file.jsonl>`;
export const NOTHING_MATCHES = 'Nothing on the shelf matches.';
export const ALREADY_THERE = 'Already on the shelf.';
export const ADDED = 'Added to the shelf.';
export const LINK_HINT = 'A link starts with http:// or https://';

export interface ShelfFilters {
  q?: string | undefined;
  type?: string | undefined;
  tag?: string | undefined;
}

/**
 * The address to open when `value` is one whole http(s) URL, else null:
 * never a `javascript:` or `data:` URL, a relative path, or a sentence that
 * merely holds a link.
 */
export function httpHref(value: string | undefined | null): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!/^https?:\/\/\S+$/i.test(v)) return null;
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '' ? u.href : null;
  } catch {
    return null;
  }
}

/** The view of the list with these filters (and an item open on top, when given). */
export function shelfPath(f: ShelfFilters, item?: string): string {
  return routePath({ name: 'intel', ...(f.q ? { q: f.q } : {}), ...(f.type ? { type: f.type } : {}), ...(f.tag ? { tag: f.tag } : {}), ...(item ? { item } : {}) });
}

export function hasFilters(f: ShelfFilters): boolean {
  return Boolean(f.q || f.type || f.tag);
}

/** "Hooks, cli , hooks" as tags: trimmed, no blanks, each once. */
export function tagsFrom(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(',')) {
    const t = raw.trim();
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "29 Oct", or "29 Oct 2025" from another year, in the phone's own zone. */
export function shelfDate(iso: string | null, now: number): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "29 Oct 2026 08:00", for the item page. */
export function shelfTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "1 item", "612 items". */
export function itemsWord(n: number): string {
  return `${new Intl.NumberFormat().format(n)} ${n === 1 ? 'item' : 'items'}`;
}
