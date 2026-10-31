/**
 * v0.5 Meetings: the Chrome extension keeps a call's live captions (Google's
 * and Microsoft's own transcription) and the screenshots the user clicks,
 * and the daemon keeps them in meetings.db and <state dir>/meetings/.
 *
 * Two kinds of caller:
 * - The extension's service worker, on `/v1/ext/` routes only, with its own
 *   key (EXTENSION_KEY_HEADER), from loopback. Every capture write is an
 *   idempotent upsert keyed by the extension's client id for "this tab's
 *   call"; a 404 means "no open meeting with this client id".
 * - The phone, at control scope (reads included), and the CLI on ctl.sock
 *   for status, list, get and the screenshot bytes (the export).
 *
 * Write replies carry ids only (`{ id }` or `{ ok: true }`); the one reply
 * with a secret is the pairing claim's key, sent once. No meeting text or
 * image bytes ever go into an event: meetings tick the text-free
 * `life.changed {}`, never on caption lines.
 */
import { z } from 'zod';
import { MEETING_LIMITS, MEETING_SHOT_BODY_MAX } from './constants.js';
import { LifeIdSchema } from './life.js';
import { IsoDateSchema } from './models.js';

/**
 * No control characters (a name, people): C0, DEL and C1 would break a line
 * in the export and the phone, and the bidi embeddings, overrides and
 * isolates would turn the text around it.
 */
const NO_CONTROL = /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]*$/;
const text = (max: number) => z.string().trim().min(1).max(max).regex(NO_CONTROL, { message: 'no control characters' });
const msSinceEpoch = z.number().int().min(0);

// ---------------------------------------------------------------------------
// The extension's routes (`/v1/ext/`)

export const MeetingSiteSchema = z.enum(['meet', 'teams']);
export type MeetingSite = z.infer<typeof MeetingSiteSchema>;
/** Why a meeting ended. 'stale' is the daemon's own: nothing heard from the extension for MEETING_STALE_MS. */
export const EndReasonSchema = z.enum(['user', 'left', 'closed', 'stale']);
export type EndReason = z.infer<typeof EndReasonSchema>;
/** The extension's uuid for one tab's call. */
export const ClientIdParamsSchema = z.object({ clientId: z.uuid() });
export type ClientIdParams = z.infer<typeof ClientIdParamsSchema>;

/**
 * One caption line as the extension's tracker last saw it. Idempotent: the
 * daemon keeps the highest `rev` per `lineId` (a retry or a late correction
 * is harmless). `lineId` is `<page nonce>-<counter>`.
 */
export const LineUpsertSchema = z.strictObject({
  lineId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  rev: z.number().int().min(1).max(1_000_000),
  /** Control characters become spaces in the daemon; a blank one is "Unknown". */
  speaker: z.string().max(MEETING_LIMITS.speaker),
  text: z.string().min(1).max(MEETING_LIMITS.lineText),
  /** ms since epoch, when the line was first seen. */
  at: msSinceEpoch,
});
export type LineUpsert = z.infer<typeof LineUpsertSchema>;

/** Open (or update) this tab's meeting: Start from the popup, or a screenshot before Start. */
export const ExtOpenBodySchema = z.strictObject({
  site: MeetingSiteSchema,
  name: text(MEETING_LIMITS.name),
  projectId: LifeIdSchema.optional(),
  people: text(MEETING_LIMITS.people).optional(),
  autoTodos: z.boolean(),
  /** true: Start (read captions); false: made by a screenshot before Start. A later true turns notes on; never back off. */
  captions: z.boolean(),
  at: msSinceEpoch,
});
export type ExtOpenBody = z.infer<typeof ExtOpenBodySchema>;

/** An empty list is the keep-alive (the extension sends one a minute while the tab is in the call). */
export const ExtLinesBodySchema = z.strictObject({ lines: z.array(LineUpsertSchema).max(MEETING_LIMITS.linesPerPost) });
export type ExtLinesBody = z.infer<typeof ExtLinesBodySchema>;

/** A screenshot: `captureVisibleTab`'s data URL as it came, with the extension's uuid for this shot (a retry stores one file). */
export const ExtShotBodySchema = z.strictObject({
  key: z.uuid(),
  at: msSinceEpoch,
  image: z.string().startsWith('data:image/jpeg;base64,').max(MEETING_SHOT_BODY_MAX - 1024),
});
export type ExtShotBody = z.infer<typeof ExtShotBodySchema>;

export const ExtEndBodySchema = z.strictObject({ reason: z.enum(['user', 'left', 'closed']), at: msSinceEpoch });
export type ExtEndBody = z.infer<typeof ExtEndBodySchema>;

/** A project the assign sheet offers: id, name and emoji only (never notes or folders). */
export const ExtProjectSchema = z.object({ id: LifeIdSchema, name: z.string(), emoji: z.string().optional() });
export type ExtProject = z.infer<typeof ExtProjectSchema>;
/** `projects` is null while Todos are off or Life is broken (the sheet hides Project). */
export const ExtInfoSchema = z.object({ projects: z.array(ExtProjectSchema).max(200).nullable() });
export type ExtInfo = z.infer<typeof ExtInfoSchema>;

export const ExtPairClaimBodySchema = z.strictObject({ code: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) });
export type ExtPairClaimBody = z.infer<typeof ExtPairClaimBodySchema>;
/** The key, sent this once (the daemon keeps only its hash); `id` is the extension's row. */
export const ExtPairClaimReplySchema = z.object({ id: LifeIdSchema, key: z.string() });
export type ExtPairClaimReply = z.infer<typeof ExtPairClaimReplySchema>;
/** What `jantar pair --extension` prints as `jantar-ext:<port>:<code>`. */
export const ExtPairStartReplySchema = z.object({ code: z.string(), port: z.number().int().nullable(), expiresAt: IsoDateSchema });
export type ExtPairStartReply = z.infer<typeof ExtPairStartReplySchema>;
export const ExtUnpairReplySchema = z.object({ ok: z.literal(true), revoked: z.number().int() });
export type ExtUnpairReply = z.infer<typeof ExtUnpairReplySchema>;

// ---------------------------------------------------------------------------
// Meetings as the phone and the CLI read them

export const SummaryStateSchema = z.enum(['none', 'queued', 'running', 'done', 'failed']);
export type SummaryState = z.infer<typeof SummaryStateSchema>;
/** An action item; `todoId` once it is in the project's todos. */
export const ActionItemSchema = z.object({ title: z.string().min(1).max(200), owner: z.string().max(60).optional(), todoId: LifeIdSchema.optional() });
export type ActionItem = z.infer<typeof ActionItemSchema>;

export const MeetingSummarySchema = z.object({
  state: SummaryStateSchema,
  /** Fixed daemon text, for none and failed. */
  reason: z.string().max(200).optional(),
  /** done */
  text: z.string().max(2000).optional(),
  decisions: z.array(z.string().max(300)).max(20),
  items: z.array(ActionItemSchema).max(30),
  at: IsoDateSchema.optional(),
});
export type MeetingSummary = z.infer<typeof MeetingSummarySchema>;

export const MeetingSchema = z.object({
  id: LifeIdSchema,
  site: MeetingSiteSchema,
  name: z.string(),
  people: z.string().optional(),
  projectId: LifeIdSchema.optional(),
  /** Resolved at read; absent when the project is gone or Todos are off. */
  projectName: z.string().optional(),
  autoTodos: z.boolean(),
  /** Start was pressed (captions read). */
  notes: z.boolean(),
  startedAt: IsoDateSchema,
  endedAt: IsoDateSchema.nullable(),
  endReason: EndReasonSchema.optional(),
  lines: z.number().int(),
  shots: z.number().int(),
  summary: SummaryStateSchema,
  /** List only: the summary's first 160 characters. */
  gist: z.string().max(160).optional(),
});
export type Meeting = z.infer<typeof MeetingSchema>;

export const MeetingLineSchema = z.object({ id: z.string(), at: IsoDateSchema, speaker: z.string(), text: z.string() });
export type MeetingLine = z.infer<typeof MeetingLineSchema>;
export const MeetingShotSchema = z.object({ id: LifeIdSchema, at: IsoDateSchema, bytes: z.number().int() });
export type MeetingShot = z.infer<typeof MeetingShotSchema>;
/** One meeting with its summary, every line (by time) and every screenshot (by time). */
export const MeetingDetailSchema = z.object({
  meeting: MeetingSchema,
  summary: MeetingSummarySchema,
  lines: z.array(MeetingLineSchema),
  shots: z.array(MeetingShotSchema),
});
export type MeetingDetail = z.infer<typeof MeetingDetailSchema>;

/** `GET /v1/meetings`: newest first; `project` a project id or 'none'; `q` matches name, people, summary and any line. */
export const MeetingsQuerySchema = z.object({
  project: z.union([LifeIdSchema, z.literal('none')]).optional(),
  q: z.string().trim().min(1).max(MEETING_LIMITS.search).optional(),
  /** The cursor from `next`. */
  before: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(MEETING_LIMITS.page).default(30),
});
export type MeetingsQuery = z.infer<typeof MeetingsQuerySchema>;
export const MeetingsListSchema = z.object({
  meetings: z.array(MeetingSchema),
  next: z.string().nullable(),
  /** The newest open meeting, whatever the filter (the "Meeting running" line). */
  running: MeetingSchema.nullable(),
});
export type MeetingsList = z.infer<typeof MeetingsListSchema>;

export const MeetingParamsSchema = z.object({ id: LifeIdSchema });
export const MeetingShotParamsSchema = z.object({ id: LifeIdSchema, shotId: LifeIdSchema });
/** `n`: the action item's place in the summary's list. */
export const MeetingItemParamsSchema = z.object({ id: LifeIdSchema, n: z.coerce.number().int().min(0).max(29) });
export type MeetingItemParams = z.infer<typeof MeetingItemParamsSchema>;

/** Edit on the phone: name, project (null clears), people (null clears); `autoTodos` is honoured only before the summary runs. */
export const MeetingPatchSchema = z
  .strictObject({
    name: text(MEETING_LIMITS.name).optional(),
    projectId: LifeIdSchema.nullable().optional(),
    people: text(MEETING_LIMITS.people).nullable().optional(),
    autoTodos: z.boolean().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: 'change at least one field' });
export type MeetingPatch = z.infer<typeof MeetingPatchSchema>;

export const MeetingsStatusSchema = z.object({
  /** settings meetings.enabled */
  on: z.boolean(),
  /** meetings.db is open. */
  open: z.boolean(),
  /** The fixed sentence while meetings.db will not open. */
  broken: z.string().optional(),
  meetings: z.number().int(),
  /** Open meetings. */
  running: z.number().int(),
  /** Every screenshot together (of MEETING_SHOTS_TOTAL_MAX_BYTES). */
  shotsBytes: z.number().int(),
  summary: z.object({ available: z.boolean(), reason: z.string().optional() }),
  /** Paired extensions that are not revoked. */
  extensions: z.array(z.object({ id: LifeIdSchema, pairedAt: IsoDateSchema, lastSeenAt: IsoDateSchema.nullable() })),
});
export type MeetingsStatus = z.infer<typeof MeetingsStatusSchema>;

// ---------------------------------------------------------------------------
// The Markdown export (the CLI's export, and the phone's Export text)

const SITE_NAME: Readonly<Record<MeetingSite, string>> = { meet: 'Google Meet', teams: 'Microsoft Teams' };

/** User text placed inside a line: `<` is `&lt;` (no HTML), and `[` and `]` are escaped (no links or remote images). */
function inertInline(text: string): string {
  return text.replace(/</g, '&lt;').replace(/([[\]])/g, '\\$1');
}

/**
 * User text that starts a line: inline-inert, leading spaces dropped (no
 * indented code), and a line that would start a block gets a backslash on its
 * first mark: a heading (`#`, or `===` and `---` under the line before), a
 * quote, a bullet, a rule (`***`, `___`), a code fence (three backticks or
 * `~~~`) or a table row (`|`, or a delimiter row such as `:-- | --:`). A
 * numbered item (`2.`, `1)`) gets it before the `.` or `)`: CommonMark
 * escapes punctuation only, so `\2.` would show its backslash.
 */
function inertLine(line: string): string {
  const t = inertInline(line).trimStart();
  const digits = /^\d+(?=[.)](?:\s|$))/.exec(t)?.[0];
  if (digits) return `${digits}\\${t.slice(digits.length)}`;
  return /^[#>*+=~`|:_-]/.test(t) ? `\\${t}` : t;
}

/** Text that may hold several lines (a summary), each made inert. */
function inert(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => inertLine(l))
    .join('\n');
}

function parts(at: Date, timeZone: string, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-GB', { timeZone, ...opts }).formatToParts(at)) out[p.type] = p.value;
  return out;
}

/** "10:02" in `timeZone`. */
function hhmm(iso: string, timeZone: string): string {
  const p = parts(new Date(iso), timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${p.hour}:${p.minute}`;
}

/** "Fri 30 Oct 2026" in `timeZone`. */
function dayOf(iso: string, timeZone: string): string {
  const p = parts(new Date(iso), timeZone, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
}

/** What the summary section says when there is no summary text. */
function summaryNote(d: MeetingDetail): string {
  const s = d.summary;
  if (d.meeting.endedAt === null) return 'The summary comes after the meeting ends.';
  if (s.state === 'queued' || s.state === 'running') return 'The summary is being written.';
  return s.reason ?? 'No summary.';
}

export interface MeetingMarkdownOptions {
  /** IANA zone for the day and every time. */
  timeZone: string;
  /** Where screenshot `n` (1-based, in time order) is, for an image link; null (or absent) writes its time only. */
  shotRef?: (s: MeetingShot, n: number) => string | null;
}

/**
 * A meeting as Markdown, shared by the CLI and the phone. Pure. Every piece
 * of user text (name, people, project, summary, decisions, items, speakers,
 * captions) is made inert, so a caption cannot add headings, lists, rules,
 * code fences, tables, links or HTML. The transcript joins consecutive lines
 * of one speaker into one turn and puts each screenshot at its time.
 */
export function meetingMarkdown(d: MeetingDetail, opts: MeetingMarkdownOptions): string {
  const tz = opts.timeZone;
  const m = d.meeting;
  const done = d.summary.state === 'done';
  /** Blocks of the file, joined by one blank line. */
  const blocks: string[] = [`# ${inertInline(m.name)}`];
  const when = m.endedAt ? `${hhmm(m.startedAt, tz)} to ${hhmm(m.endedAt, tz)}` : `from ${hhmm(m.startedAt, tz)}`;
  blocks.push(`${dayOf(m.startedAt, tz)} · ${when} · ${SITE_NAME[m.site]}`);
  const who = [m.projectName ? `Project: ${inertInline(m.projectName)}` : null, m.people ? `People: ${inertInline(m.people)}` : null].filter(Boolean);
  if (who.length > 0) blocks.push(who.join(' · '));

  blocks.push('## Summary', done && d.summary.text ? inert(d.summary.text) : `*${summaryNote(d)}*`);
  if (done && d.summary.decisions.length > 0) {
    blocks.push('## Decisions', d.summary.decisions.map((x) => `- ${inertInline(x)}`).join('\n'));
  }
  if (done && d.summary.items.length > 0) {
    const items = d.summary.items.map((i) => `- [${i.todoId ? 'x' : ' '}] ${inertInline(i.title)}${i.owner ? ` (${inertInline(i.owner)})` : ''}`);
    blocks.push('## Action items', items.join('\n'));
  }

  blocks.push('## Transcript');
  const lines = [...d.lines].sort((a, b) => a.at.localeCompare(b.at));
  const shots = [...d.shots].sort((a, b) => a.at.localeCompare(b.at));
  if (lines.length === 0 && shots.length === 0) blocks.push('*No transcript.*');
  const shotBlock = (s: MeetingShot, n: number): string => {
    const ref = opts.shotRef?.(s, n) ?? null;
    const at = hhmm(s.at, tz);
    return ref ? `![Screenshot ${at}](${ref.replace(/[()\s]/g, encodeURIComponent)})` : `*Screenshot ${at}*`;
  };
  let turn: string[] | null = null;
  let speaker: string | null = null;
  let next = 0;
  const endTurn = () => {
    if (turn) blocks.push(turn.join('\n'));
    turn = null;
    speaker = null;
  };
  for (const l of lines) {
    // A screenshot taken before this line ends the turn it fell in.
    for (; next < shots.length && (shots[next] as MeetingShot).at <= l.at; next += 1) {
      endTurn();
      blocks.push(shotBlock(shots[next] as MeetingShot, next + 1));
    }
    if (turn === null || l.speaker !== speaker) {
      endTurn();
      turn = [`**${inertInline(l.speaker).replace(/\*/g, '\\*')}** ${hhmm(l.at, tz)}`];
      speaker = l.speaker;
    }
    (turn as string[]).push(inertLine(l.text));
  }
  endTurn();
  for (; next < shots.length; next += 1) blocks.push(shotBlock(shots[next] as MeetingShot, next + 1));
  return `${blocks.join('\n\n')}\n`;
}
