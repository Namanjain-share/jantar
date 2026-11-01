/**
 * v0.4 Intel shelf: items read from JSONL files named on the Mac (a bot's
 * `intel.jsonl`, say) plus the daemon's own captures file, deduped by id and
 * followed for appends. Read-only on the phone except for new captures.
 *
 * No path ever crosses the wire: a source is named by an id and a label
 * taken from its file name.
 */
import { z } from 'zod';
import { INTEL_PAGE_MAX } from './constants.js';
import { FolderPathSchema } from './life.js';
import { IsoDateSchema } from './models.js';

/** The shelf key: `<source id>:<the record's id>` (the client URL-encodes it in paths). */
export const IntelIdSchema = z.string().regex(/^[\x21-\x7e]{1,160}$/);
export type IntelId = z.infer<typeof IntelIdSchema>;

/** An http(s) link; anything else in a record is dropped (never a `javascript:` or `data:` URL). */
const LinkSchema = z.url({ protocol: /^https?$/ }).max(2000);

export const IntelItemSchema = z.object({
  id: IntelIdSchema,
  /** The source's id (from its file name). */
  source: z.string(),
  at: IsoDateSchema.nullable(),
  title: z.string().min(1).max(300),
  url: LinkSchema.optional(),
  type: z.string().max(40).optional(),
  tags: z.array(z.string().max(40)).max(20),
  /** "What it is". */
  summary: z.string().max(2000).optional(),
  /** "Why it matters". */
  why: z.string().max(2000).optional(),
  /** Every other plain field of the record, in file order. A value that is one whole http(s) URL is shown as a link. */
  fields: z.array(z.object({ key: z.string().max(40), value: z.string().max(2000) })).max(20),
});
export type IntelItem = z.infer<typeof IntelItemSchema>;

export const IntelListItemSchema = IntelItemSchema.pick({ id: true, source: true, at: true, title: true, url: true, type: true, tags: true }).extend({
  summary: z.string().max(240).optional(),
});
export type IntelListItem = z.infer<typeof IntelListItemSchema>;

/** GET /v1/intel: newest first; `before` is the previous page's `next`. */
export const IntelListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  type: z.string().max(40).optional(),
  tag: z.string().max(40).optional(),
  before: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(INTEL_PAGE_MAX).default(50),
  /**
   * v0.5.3: `best` (the default with a search) ranks the items that match
   * every word, best place first, then newest; `new` (the default without
   * one) is newest first.
   */
  sort: z.enum(['best', 'new']).optional(),
});
export type IntelListQuery = z.infer<typeof IntelListQuerySchema>;
export const IntelListResponseSchema = z.object({
  items: z.array(IntelListItemSchema),
  next: z.string().nullable(),
  /** Items matching the filters, over every page. */
  total: z.number().int(),
  types: z.array(z.object({ type: z.string(), n: z.number().int() })),
  tags: z.array(z.object({ tag: z.string(), n: z.number().int() })).max(30),
});
export type IntelListResponse = z.infer<typeof IntelListResponseSchema>;

export const IntelParamsSchema = z.object({ id: IntelIdSchema });
export const IntelItemResponseSchema = z.object({ item: IntelItemSchema });
export type IntelItemResponse = z.infer<typeof IntelItemResponseSchema>;

/** POST /v1/intel/captures: one new item, appended to the daemon's captures file. */
export const IntelCaptureBodySchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
  url: LinkSchema.optional(),
  type: z.string().max(40).optional(),
  tags: z.array(z.string().min(1).max(40)).max(10).optional(),
  note: z.string().max(2000).optional(),
  /**
   * The folder of the session or shell that ran `jantar intel` (the CLI sends
   * its own); kept in the capture record. ctl.sock only: over TCP a body with
   * it is 400 (api/app.ts CTL_ONLY_FIELDS).
   */
  cwd: FolderPathSchema.optional(),
  /**
   * v0.5.3: `jantar mcp` marks what a Claude session saved; the item page
   * shows "via claude". ctl.sock only, like `cwd` (CTL_ONLY_FIELDS).
   */
  via: z.literal('claude').optional(),
});
export type IntelCaptureBody = z.infer<typeof IntelCaptureBodySchema>;
/** `duplicate`: an item with that url was already on the shelf; nothing was written. */
export const IntelCaptureReplySchema = z.object({ id: IntelIdSchema, duplicate: z.boolean() });
export type IntelCaptureReply = z.infer<typeof IntelCaptureReplySchema>;

export const IntelSourceSchema = z.object({
  id: z.string(),
  label: z.string(),
  items: z.number().int(),
  /** Lines skipped: too long, not a JSON object, or no title. */
  skipped: z.number().int(),
  /** A fixed sentence when the source is refused or unreadable; never its path or contents. */
  error: z.string().optional(),
  updatedAt: IsoDateSchema.nullable(),
});
export type IntelSource = z.infer<typeof IntelSourceSchema>;
/** GET /v1/intel/sources: never a path, for any caller (the CLI prints paths from the local config). */
export const IntelSourcesResponseSchema = z.object({ sources: z.array(IntelSourceSchema) });
export type IntelSourcesResponse = z.infer<typeof IntelSourcesResponseSchema>;

/** v0.5.3: at most this many words in a shelf search, each at most SEARCH_TERM_MAX characters. */
export const SEARCH_TERMS_MAX = 8;
export const SEARCH_TERM_MAX = 100;

/**
 * The words of a shelf search (v0.5.3), shared by the daemon's match and the
 * phone's highlight: split on spaces, a "double-quoted phrase" kept whole (an
 * unclosed quote runs to the end), lowercased with toLowerCase(), blanks and
 * repeats dropped, at most SEARCH_TERMS_MAX terms of at most SEARCH_TERM_MAX
 * characters. No accent folding: stripping marks would merge Devanagari
 * vowel signs. Only spaces: no terms (no search).
 */
export function searchTerms(q: string): string[] {
  const out: string[] = [];
  for (const m of q.matchAll(/"([^"]*)"?|([^\s"]+)/g)) {
    const term = (m[1] ?? m[2] ?? '').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, SEARCH_TERM_MAX);
    if (term === '' || out.includes(term)) continue;
    out.push(term);
    if (out.length === SEARCH_TERMS_MAX) break;
  }
  return out;
}
