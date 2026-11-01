/**
 * The Intel shelf's small rules (v0.4 spec 5.8): which values are links,
 * how dates read, how typed tags split, and where each view lives; v0.5.3
 * which words a search marks in a row; v0.8 (Add post) the words for a
 * read's depth, platform and state, and which jobs the Reading strip shows.
 * Pure, so the screens stay thin and the rules are tested on their own.
 */
import {
  CLI_NAME,
  searchTerms,
  type IntelDepth,
  type IntelItem,
  type IntelJob,
  type IntelPlatform,
  type IntelReadState,
  type IntelTier,
} from '@jantar/protocol';
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

/** "1 match", "12 matches": the count line while a search has words. */
export function matchesWord(n: number): string {
  return `${new Intl.NumberFormat().format(n)} ${n === 1 ? 'match' : 'matches'}`;
}

/** The words of a shelf search, as the daemon matches them (protocol searchTerms); none without a search. */
export function termsOf(q: string | undefined): string[] {
  return q ? searchTerms(q) : [];
}

export interface Piece {
  text: string;
  /** One of the search's words (or two touching): the row shows it in a <mark>. */
  hit: boolean;
}

/**
 * `text` in pieces, the places any of `terms` (lowercased) appears marked,
 * without case. When lowercasing changes the text's length (an `İ` grows),
 * offsets would drift, so nothing is marked. The pieces always join back to
 * `text`.
 */
export function marks(text: string, terms: readonly string[]): Piece[] {
  const lower = text.toLowerCase();
  const spans: [number, number][] = [];
  if (lower.length === text.length) {
    for (const t of terms) for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + t.length)) spans.push([i, i + t.length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const out: Piece[] = [];
  let at = 0;
  for (const [from, to] of spans) {
    if (to <= at) continue;
    const last = out.at(-1);
    if (from > at) out.push({ text: text.slice(at, from), hit: false });
    else if (last?.hit) {
      // Overlapping or touching the last mark: one mark.
      last.text += text.slice(at, to);
      at = to;
      continue;
    }
    out.push({ text: text.slice(Math.max(from, at), to), hit: true });
    at = to;
  }
  if (at < text.length || out.length === 0) out.push({ text: text.slice(at), hit: false });
  return out;
}

// ---------------------------------------------------------------------------
// v0.8: reading links (Add post)

/** The fixed words of Add post, the Reading strip and a read item (spec 8). */
export const READ_COPY = {
  sheet: 'Add post',
  lead: 'A reel, video, post, article, PDF or any link, or just text.',
  box: 'Link or text',
  saved: 'Saved. Reading it on your Mac.',
  already: 'Already saved.',
  again: 'Reading it again on your Mac.',
  byHand: 'Add by hand',
  sent: 'The page, pictures and what is said go to Claude.',
  /** Under "What's sent" (docs/intel.md and SECURITY.md list the same). */
  sentAll:
    "The Mac fetches the link itself, with no cookies; with Read saved links on in Jantar's Chrome extension, your Chrome opens the post as you. " +
    "Sent to Claude on your account: the caption or text, the page's details and top comments, the text read from frames, what is said (Full), " +
    'the text of links in your note (Full), your note, and the frames as pictures. Speech is turned into text on the Mac: no audio leaves it.',
  reading: 'Reading',
  failed: "Couldn't read",
  deleted: 'Deleted from the shelf.',
  background: 'From Claude, not from the post',
} as const;

/** A depth as the phone names it. */
export const DEPTH_LABEL: Readonly<Record<IntelDepth, string>> = { light: 'Light', standard: 'Standard', full: 'Full' };

/** What each depth does, in one line (under the depth control). */
export const DEPTH_LINE: Readonly<Record<IntelDepth, string>> = {
  light: 'The page, caption and a summary',
  standard: 'Also looks at frames and the text on screen',
  full: 'Also listens, and reads links in your note',
};

export const PLATFORM_LABEL: Readonly<Record<IntelPlatform, string>> = {
  instagram: 'Instagram',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  x: 'X',
  reddit: 'Reddit',
  linkedin: 'LinkedIn',
  web: 'Web',
  pdf: 'PDF',
  note: 'Note',
};

/** A read still on its way: waiting, or one of the steps the Mac is in. */
export function unfinished(state: IntelReadState): boolean {
  return state !== 'saved' && state !== 'failed';
}

/** A read's state in words; while fetching, where the page comes from. */
export function stateWord(state: IntelReadState, tier?: IntelTier): string {
  switch (state) {
    case 'queued':
      return 'Waiting';
    case 'fetching':
      return tier === 'chrome' ? 'Opening in Chrome' : tier === 'download' || tier === 'ytdlp' ? 'Downloading' : 'Opening the page';
    case 'preparing':
      return 'Getting the Mac ready (once)';
    case 'frames':
      return 'Looking at frames';
    case 'transcribing':
      return 'Listening';
    case 'summarising':
      return 'Summarising';
    case 'saved':
      return 'Saved';
    case 'failed':
      return READ_COPY.failed;
  }
}

/** A saved job stays in the strip this long after it ended; one still on its way or failed stays while the Mac lists it. */
export const SAVED_SHOWN_MS = 60 * 60_000;

/** The jobs the Reading strip shows, in the Mac's order. */
export function stripJobs(jobs: readonly IntelJob[], now: number): IntelJob[] {
  return jobs.filter((j) => {
    if (j.state !== 'saved') return true;
    const end = Date.parse(j.endedAt ?? j.queuedAt);
    return Number.isFinite(end) && now - end <= SAVED_SHOWN_MS;
  });
}

/** "www.example.com", or '' when `url` is not a link. */
export function hostOf(url: string | undefined | null): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** A job's name in the strip: its title, else its link's host. */
export function jobName(j: Pick<IntelJob, 'title' | 'url'>): string {
  return j.title.trim() || hostOf(j.url) || 'A note';
}

/**
 * Open original: only an https address (a read item's link is always one;
 * anything else, a `javascript:` or `http:` value included, gets no button).
 */
export function httpsHref(value: string | undefined | null): string | null {
  const href = httpHref(value);
  return href && href.startsWith('https://') ? href : null;
}

/** An item read from a link (Add post, the Shortcut, Ask): it carries a read or a platform. */
export function isRead(item: Pick<IntelItem, 'read' | 'platform'>): boolean {
  return item.read !== undefined || item.platform !== undefined;
}

/** "@example_cook · Instagram · 30 Oct": who, where and when, as the page gave them. */
export function bylineOf(item: Pick<IntelItem, 'creator' | 'platform' | 'postedAt'>, now: number): string {
  return [item.creator, item.platform ? PLATFORM_LABEL[item.platform] : null, item.postedAt ? shelfDate(item.postedAt, now) : null].filter(Boolean).join(' · ');
}
