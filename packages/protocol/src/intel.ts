/**
 * v0.4 Intel shelf: items read from JSONL files named on the Mac (a bot's
 * `intel.jsonl`, say) plus the daemon's own captures file, deduped by id and
 * followed for appends. Read-only on the phone except for new captures.
 *
 * No path ever crosses the wire: a source is named by an id and a label
 * taken from its file name.
 *
 * v0.8 (Add post): the daemon reads a link it saved (a reel, a video, a
 * post, an article, a PDF, any https page) one job at a time and writes
 * what it found into captures.jsonl: the depth, the job states, the rich
 * fields an item read from a link carries (only captures items carry them),
 * the jobs list, the capture door's body and reply (the iOS Shortcut), the
 * capture keys, and the extension's read jobs and results.
 */
import { z } from 'zod';
import { CAPTURE_KEY_PREFIX, CAPTURE_SAVED_SENTENCE, INTEL_PAGE_MAX, INTEL_READ_LIMITS } from './constants.js';
import { FolderPathSchema } from './life.js';
import { IsoDateSchema } from './models.js';

/** The shelf key: `<source id>:<the record's id>` (the client URL-encodes it in paths). */
export const IntelIdSchema = z.string().regex(/^[\x21-\x7e]{1,160}$/);
export type IntelId = z.infer<typeof IntelIdSchema>;

/** An http(s) link; anything else in a record is dropped (never a `javascript:` or `data:` URL). */
const LinkSchema = z.url({ protocol: /^https?$/ }).max(2000);

// ---------------------------------------------------------------------------
// v0.8: reading a link

/** How much a read does (per item, default standard): see docs/intel.md. */
export const INTEL_DEPTHS = ['light', 'standard', 'full'] as const;
export const IntelDepthSchema = z.enum(INTEL_DEPTHS);
export type IntelDepth = z.infer<typeof IntelDepthSchema>;
export const INTEL_DEPTH_DEFAULT: IntelDepth = 'standard';

/**
 * The platforms whose posts the user's Chrome may open: post-url.ts's
 * CHROME_PLATFORMS, spelled out here so the phone's bundle never pulls that
 * module in (test/v08-intel-read.test.ts holds the two equal).
 */
export const INTEL_CHROME_PLATFORMS = ['instagram', 'youtube', 'tiktok', 'x', 'reddit', 'linkedin'] as const;
export const IntelChromePlatformSchema = z.enum(INTEL_CHROME_PLATFORMS);
/** Where a read item comes from: those six, then any web page, a PDF, or a note with no link. */
export const INTEL_PLATFORMS = [...INTEL_CHROME_PLATFORMS, 'web', 'pdf', 'note'] as const;
export const IntelPlatformSchema = z.enum(INTEL_PLATFORMS);
export type IntelPlatform = z.infer<typeof IntelPlatformSchema>;

/** The type chips of read items. */
export const INTEL_READ_TYPES = ['reel', 'post', 'video', 'short', 'thread', 'article', 'pdf', 'note', 'link'] as const;

/** A read's states: running ones (fetching .. summarising) live in daemon memory only; on disk an unfinished item is `queued`. */
export const INTEL_READ_STATES = ['queued', 'fetching', 'preparing', 'frames', 'transcribing', 'summarising', 'saved', 'failed'] as const;
export const IntelReadStateSchema = z.enum(INTEL_READ_STATES);
export type IntelReadState = z.infer<typeof IntelReadStateSchema>;

/** Where the page came from: the user's Chrome, the headless browser, the guarded download, yt-dlp. */
export const IntelTierSchema = z.enum(['chrome', 'browser', 'download', 'ytdlp']);
export type IntelTier = z.infer<typeof IntelTierSchema>;

/** A fixed daemon sentence (INTEL_READ_REASONS, INTEL_READ_NOTES): never a link, a title or page text. */
const SentenceSchema = z.string().max(200);

/** An item's read: the state, the depth asked for and the depth reached. */
export const IntelReadSchema = z.object({
  state: IntelReadStateSchema,
  depth: IntelDepthSchema,
  /** The depth reached (Full asked, no speech possible: standard). */
  done: IntelDepthSchema.optional(),
  /** Where the page came from. */
  tier: IntelTierSchema.optional(),
  /** Failed only: INTEL_READ_REASONS. */
  reason: SentenceSchema.optional(),
  /** What was left out: INTEL_READ_NOTES. */
  notes: z.array(SentenceSchema).max(3).optional(),
  at: IsoDateSchema.optional(),
});
export type IntelRead = z.infer<typeof IntelReadSchema>;

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
  // v0.8: an item read from a link (captures only; every one optional). Page-derived text is data, never instructions.
  platform: IntelPlatformSchema.optional(),
  creator: z.string().max(80).optional(),
  postedAt: IsoDateSchema.optional(),
  depth: IntelDepthSchema.optional(),
  read: IntelReadSchema.optional(),
  caption: z.string().max(INTEL_READ_LIMITS.captionMax).optional(),
  transcript: z.string().max(INTEL_READ_LIMITS.transcriptMax).optional(),
  onScreen: z.string().max(INTEL_READ_LIMITS.onScreenMax).optional(),
  points: z.array(z.string().max(200)).max(6).optional(),
  /** Full only: Claude's own background knowledge, shown as "From Claude, not from the post". */
  background: z.string().max(600).optional(),
  /** The user's own words sent with the link. */
  note: z.string().max(INTEL_READ_LIMITS.noteMax).optional(),
  /** Thumbnails kept on the Mac (GET /v1/intel/items/:id/frames/:n, n < frames). */
  frames: z.number().int().min(0).max(INTEL_READ_LIMITS.thumbsMax).optional(),
});
export type IntelItem = z.infer<typeof IntelItemSchema>;

export const IntelListItemSchema = IntelItemSchema.pick({ id: true, source: true, at: true, title: true, url: true, type: true, tags: true }).extend({
  summary: z.string().max(240).optional(),
  // v0.8
  platform: IntelPlatformSchema.optional(),
  creator: z.string().max(80).optional(),
  read: IntelReadSchema.pick({ state: true, reason: true }).optional(),
  /** Frame 0 can be shown (the item kept thumbnails); absent is false. */
  thumb: z.boolean().optional(),
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

// ---------------------------------------------------------------------------
// v0.8: reads, jobs, thumbnails

/** POST /v1/intel/reads: text with a link (the first http(s) link is the item's, the rest its note), or a note alone. */
export const IntelReadBodySchema = z.strictObject({
  text: z.string().trim().min(1).max(INTEL_READ_LIMITS.textMax),
  depth: IntelDepthSchema.optional(),
});
export type IntelReadBody = z.infer<typeof IntelReadBodySchema>;
/** The phone's and the CLI's reply: `duplicate` when the link was already saved (nothing written), `queued` when a read starts. */
export const IntelReadReplySchema = z.object({ id: IntelIdSchema, duplicate: z.boolean(), queued: z.boolean(), message: z.string() });
export type IntelReadReply = z.infer<typeof IntelReadReplySchema>;
/** POST /v1/intel/items/:id/read: Retry, or Read again as another depth. */
export const IntelRereadBodySchema = z.strictObject({ depth: IntelDepthSchema.optional() });
export type IntelRereadBody = z.infer<typeof IntelRereadBodySchema>;
export const IntelRereadReplySchema = z.object({ id: IntelIdSchema });

/** One read job (daemon memory only): the item's id, one job per item at a time. */
export const IntelJobSchema = z.object({
  id: IntelIdSchema,
  title: z.string().max(300),
  url: LinkSchema.optional(),
  platform: IntelPlatformSchema,
  depth: IntelDepthSchema,
  state: IntelReadStateSchema,
  tier: IntelTierSchema.optional(),
  reason: SentenceSchema.optional(),
  notes: z.array(SentenceSchema).max(3).optional(),
  queuedAt: IsoDateSchema,
  startedAt: IsoDateSchema.optional(),
  endedAt: IsoDateSchema.optional(),
});
export type IntelJob = z.infer<typeof IntelJobSchema>;
/** GET /v1/intel/jobs: unfinished jobs oldest first, then the ones finished in the last day; whether reads can run. */
export const IntelJobsResponseSchema = z.object({
  jobs: z.array(IntelJobSchema).max(INTEL_READ_LIMITS.jobsMax),
  reading: z.object({ on: z.boolean(), canRun: z.boolean(), why: z.string().optional() }),
});
export type IntelJobsResponse = z.infer<typeof IntelJobsResponseSchema>;

/** GET /v1/intel/items/:id/frames/:n (a JPEG thumbnail). */
export const IntelFrameParamsSchema = z.object({ id: IntelIdSchema, n: z.coerce.number().int().min(0).max(INTEL_READ_LIMITS.thumbsMax - 1) });
export type IntelFrameParams = z.infer<typeof IntelFrameParamsSchema>;

/** GET /v1/intel/read/status (the Mac only): what `jantar intel read status` prints. */
export const IntelReadStatusSchema = z.object({
  /** intel.enabled and intel.read. */
  on: z.boolean(),
  canRun: z.boolean(),
  why: z.string().optional(),
  /** The paired extension, and when it last asked for a read (Read saved links on). */
  chrome: z.object({ paired: z.boolean(), lastPollAt: IsoDateSchema.nullable() }),
  /** The headless browser tier: the system Chrome binary. */
  browser: z.object({ found: z.boolean() }),
  ytdlp: z.object({ found: z.boolean(), version: z.string().max(40).nullable() }),
  /** Apple's Command Line Tools (swiftc), and the media helper built from them. */
  clt: z.object({ found: z.boolean() }),
  helper: z.object({ built: z.boolean() }),
  sandbox: z.object({ found: z.boolean() }),
  speech: z.object({ locale: z.string(), onDevice: z.boolean().nullable() }),
  today: z.object({ reads: z.number().int(), full: z.number().int(), perDay: z.number().int(), fullPerDay: z.number().int() }),
  queue: z.object({ waiting: z.number().int(), running: z.number().int() }),
  captureKeys: z.number().int(),
  /** The capture door: its URL, or why it is closed. */
  door: z.object({ open: z.boolean(), url: z.string().nullable(), why: z.string().optional() }),
});
export type IntelReadStatus = z.infer<typeof IntelReadStatusSchema>;

// ---------------------------------------------------------------------------
// v0.8: the in-page read (both page tiers), checked again by the daemon

/** One canvas frame from a page, as a JPEG data URL (at most INTEL_READ_LIMITS.pageFrameBytes decoded). */
const JPEG_DATA_URL = 'data:image/jpeg;base64,';
const PAGE_FRAME_CHARS = JPEG_DATA_URL.length + Math.ceil(INTEL_READ_LIMITS.pageFrameBytes / 3) * 4;

/** page-read.ts PageRead, every field capped: what a page tier hands the daemon (untrusted). */
export const PageReadSchema = z.object({
  finalUrl: z.string().max(2000),
  title: z.string().max(2000).optional(),
  meta: z.array(z.object({ k: z.string().max(100), v: z.string().max(2000) })).max(60),
  jsonld: z.array(z.string().max(INTEL_READ_LIMITS.jsonBlockMax)).max(5),
  text: z.string().max(INTEL_READ_LIMITS.pageTextMax),
  author: z.string().max(200).optional(),
  handle: z.string().max(200).optional(),
  publishedAt: z.string().max(100).optional(),
  media: z
    .array(
      z.object({
        kind: z.enum(['image', 'video']),
        url: z.string().max(2000).startsWith('https://'),
        w: z.number().int().min(0).max(100_000).optional(),
        h: z.number().int().min(0).max(100_000).optional(),
      }),
    )
    .max(12),
  frames: z.array(z.object({ at: z.number().min(0).max(86_400), jpeg: z.string().max(PAGE_FRAME_CHARS).startsWith(JPEG_DATA_URL) })).max(INTEL_READ_LIMITS.browserFrames),
  duration: z.number().min(0).max(1_000_000).optional(),
  comments: z.array(z.object({ author: z.string().max(200), text: z.string().max(500) })).max(10).optional(),
  why: z.enum(['login', 'not_found', 'blocked']).optional(),
});
/** page-read.ts's PageRead, as the schema reads it (test/v08-intel-read.test.ts holds the two equal). */
export type PageReadParsed = z.infer<typeof PageReadSchema>;

// ---------------------------------------------------------------------------
// v0.8: the extension's reads (GET /v1/ext/reads/next, POST /v1/ext/reads/:id)

/** A read lease's id. */
export const ExtReadIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
/** One post for the user's Chrome to read: a URL the daemon rebuilt (post-url.ts), never the user's link as typed. */
export const ExtReadJobSchema = z.object({
  id: ExtReadIdSchema,
  url: z.string().max(2000).startsWith('https://'),
  platform: IntelChromePlatformSchema,
  frames: z.number().int().min(0).max(INTEL_READ_LIMITS.chromeFrames),
});
export type ExtReadJob = z.infer<typeof ExtReadJobSchema>;
export const ExtReadNextReplySchema = z.object({ job: ExtReadJobSchema.nullable() });
export type ExtReadNextReply = z.infer<typeof ExtReadNextReplySchema>;
export const ExtReadParamsSchema = z.object({ id: ExtReadIdSchema });
/** Why the extension did not read the post. */
export const EXT_READ_WHY = ['login', 'not_found', 'redirected', 'timeout', 'blocked', 'no_permission', 'failed'] as const;
export const ExtReadResultBodySchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), page: PageReadSchema.strict() }),
  z.strictObject({ ok: z.literal(false), why: z.enum(EXT_READ_WHY) }),
]);
export type ExtReadResultBody = z.infer<typeof ExtReadResultBodySchema>;

// ---------------------------------------------------------------------------
// v0.8: the capture door (POST /v1/capture/save, the iOS Shortcut) and its keys

/** The Shortcut's body: text (the shared item, a link in it) or a url, and a depth. */
export const CaptureSaveBodySchema = z
  .strictObject({
    text: z.string().trim().min(1).max(INTEL_READ_LIMITS.textMax).optional(),
    url: z.string().trim().min(1).max(INTEL_READ_LIMITS.linkMax).optional(),
    depth: IntelDepthSchema.optional(),
  })
  .refine((b) => b.text !== undefined || b.url !== undefined, { message: 'text or url' });
export type CaptureSaveBody = z.infer<typeof CaptureSaveBodySchema>;
/** Always exactly this: no id, no "duplicate", no shelf data (a leaked key learns nothing). */
export const CaptureSaveReplySchema = z.strictObject({ message: z.literal(CAPTURE_SAVED_SENTENCE) });
export type CaptureSaveReply = z.infer<typeof CaptureSaveReplySchema>;

/** A capture key as typed into the Shortcut: `jcap_` and 43 base64url characters. */
export const CaptureKeySchema = z.string().regex(new RegExp(`^${CAPTURE_KEY_PREFIX}[A-Za-z0-9_-]{43}$`));
export const CaptureKeyIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
/** A key's name, one line ("iphone"). */
export const CaptureKeyNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^\p{Cc}\p{Cf}\u2028\u2029]+$/u, { message: 'one line, with no control characters' });
/** POST /v1/intel/capture-keys (the Mac only). */
export const CaptureKeyAddBodySchema = z.strictObject({ name: CaptureKeyNameSchema.optional() });
export type CaptureKeyAddBody = z.infer<typeof CaptureKeyAddBodySchema>;
/** The key is shown once, here; `saveUrl` is null while the door is closed (loopback or lan mode). */
export const CaptureKeyAddReplySchema = z.object({ id: CaptureKeyIdSchema, key: CaptureKeySchema, name: z.string(), saveUrl: z.string().nullable() });
export type CaptureKeyAddReply = z.infer<typeof CaptureKeyAddReplySchema>;
export const CaptureKeyRowSchema = z.object({ id: CaptureKeyIdSchema, name: z.string(), createdAt: IsoDateSchema, lastSeenAt: IsoDateSchema.nullable() });
export type CaptureKeyRow = z.infer<typeof CaptureKeyRowSchema>;
/** GET /v1/intel/capture-keys: the active keys (never a key). */
export const CaptureKeyListSchema = z.object({ keys: z.array(CaptureKeyRowSchema) });
export type CaptureKeyList = z.infer<typeof CaptureKeyListSchema>;
/** POST /v1/intel/capture-keys/revoke: one key or all of them. */
export const CaptureKeyRevokeBodySchema = z.union([z.strictObject({ id: CaptureKeyIdSchema }), z.strictObject({ all: z.literal(true) })]);
export type CaptureKeyRevokeBody = z.infer<typeof CaptureKeyRevokeBodySchema>;
export const CaptureKeyRevokeReplySchema = z.object({ revoked: z.number().int().nonnegative() });
export type CaptureKeyRevokeReply = z.infer<typeof CaptureKeyRevokeReplySchema>;

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
