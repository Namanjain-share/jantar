/**
 * v0.13 Work: the owner's projects as a hub, one search across Jantar, and
 * projects made from his client folders (P1); his clients and companies,
 * the log of calls, meetings and notes, follow-ups (todos with a client),
 * meetings linked to clients, import and export (P2). Deals and insights
 * (P3) add their shapes and routes here.
 *
 * This is the subpath `@jantar/protocol/work`, never exported from the
 * package index (as `@jantar/protocol/people` is not): none of it lands in
 * the owner's main bundle, only in Work's own lazy chunks. The daemon
 * serves WORK_ROUTES with the rest (its ALL_ROUTES), so every isolation
 * suite that walks that table covers them.
 *
 * Rules (life.ts's, and these):
 * - Owner-only. Every Work route is a `control` route on his host, never
 *   under `/v1/p/`. Work's fields never go into TodoBodySchema,
 *   TodoPatchSchema, ProjectBodySchema or ProjectPatchSchema: her own to-do
 *   and project routes reuse those (`@jantar/protocol/people`), so Work
 *   extends them in owner-only schemas instead.
 * - Bodies are strict; writes answer ids (and counts) only; a refusal is a
 *   fixed daemon sentence, never a client's name, phone or e-mail.
 */
import { z } from 'zod';
import type { RouteDef } from './api.js';
import {
  DueSchema,
  FolderPathSchema,
  IdReplySchema,
  LifeIdParamsSchema,
  LifeIdSchema,
  LongNotesSchema,
  OkReplySchema,
  ProjectBodySchema,
  ProjectViewSchema,
  TodoSchema,
  TodoTitleSchema,
} from './life.js';
import { IsoDateSchema } from './models.js';

/** Work's caps (LIFE_LIMITS' style); a call past one is refused with a fixed sentence. */
export const WORK_LIMITS = Object.freeze({
  /** GET /v1/search: the query's length, and the most results in one group. */
  searchMin: 2,
  searchMax: 80,
  searchPerGroup: 5,
  /** POST /v1/work/seed: folders in one call. */
  seedItems: 50,
  /** The project hub: its newest done todos, and the weeks of its done trend (oldest first, this week last). */
  hubRecentDone: 10,
  hubWeeks: 8,
  /** An active project with no change to it or its todos in more than this many days is quiet. */
  projectQuietDays: 14,
  // --- P2: clients, the log, follow-ups, import
  /** Clients and companies, every one (past included). */
  contacts: 5000,
  deals: 5000,
  openDeals: 500,
  /** Log rows (calls, meetings, e-mails, messages, notes, stage moves). */
  logRows: 50_000,
  stages: 12,
  businesses: 5,
  /** One contact's phones, e-mails, links and tags; the ids he ruled "not a duplicate". */
  phones: 5,
  emails: 5,
  links: 5,
  tags: 10,
  notDuplicateOf: 50,
  /** GET /v1/work/clients: rows in one answer (the rest are counted in `more`). */
  clientsPage: 500,
  /** The client hub's log page, and the project hub's. */
  clientLog: 30,
  projectLog: 20,
  /** A company's people on its hub. */
  hubPeople: 100,
  /** POST /v1/work/clients/similar: matches at most. */
  similar: 5,
  /** GET /v1/work/clients/names: ids at most. */
  names: 100,
  /** PUT /v1/work/meetings/:meetingId/clients: clients one meeting links at most. */
  meetingClients: 8,
  /** Today's Work card: check-ins named (the rest counted). */
  checkInsShown: 3,
  /** Quiet after this many days with no touch, unless Work's settings say otherwise. */
  quietDays: 14,
  /** An import: rows in one file, and its text (a JSON body of 1.25 MiB carries it). */
  importRows: 2000,
  importBytes: 1_000_000,
  importBodyBytes: 1_310_720,
  importColumns: 100,
  /** A preview is kept this long (at most this many at a time) for the import that follows it. */
  importPreviewMs: 30 * 60_000,
  importPreviews: 2,
  /** An import can be undone for this long; the newest this many are listed. */
  importUndoDays: 7,
  importsKept: 10,
});

// ---------------------------------------------------------------------------
// P2: clients and companies (work_contacts)

export const ContactKindSchema = z.enum(['person', 'company']);
export type ContactKind = z.infer<typeof ContactKindSchema>;
/** Lead, client or past (W7): winning a deal makes a contact a client; losing one never demotes a client. */
export const ContactStateSchema = z.enum(['lead', 'client', 'past']);
export type ContactState = z.infer<typeof ContactStateSchema>;
/**
 * Who wrote the words when it isn't him: `import` (a CSV or vCard row, or blanks an import filled) or
 * `meeting` (a name he tapped from a meeting's people). Set by the daemon, never by a body, kept by every
 * edit. Chat frames such a contact as data and taints its turn.
 */
export const ContactFromSchema = z.enum(['import', 'meeting']);
export type ContactFrom = z.infer<typeof ContactFromSchema>;

export const ContactNameSchema = z.string().trim().min(1).max(80);
/** A phone as he typed it (digits, spaces, +, -, ., /, parentheses); compared by its last 10 digits. */
export const ContactPhoneValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .regex(/^[0-9+\-.()/\s]+$/, { message: 'a phone number' })
  .refine((v) => /\d/.test(v), { message: 'a phone number' });
export const ContactPhoneSchema = z.strictObject({ value: ContactPhoneValueSchema, label: z.string().trim().min(1).max(20).optional() });
export type ContactPhone = z.infer<typeof ContactPhoneSchema>;
/** Stored as typed (trimmed); compared lower-cased. */
export const ContactEmailSchema = z.string().trim().max(120).pipe(z.email());
/** https only; its kind (LinkedIn, a website) is read from the host. */
export const ContactLinkSchema = z.url({ protocol: /^https$/ }).max(300);
export const ContactTagSchema = z.string().trim().min(1).max(30);
const ShortText = (n: number) => z.string().trim().min(1).max(n);
export const CheckInDaysSchema = z.number().int().min(7).max(365);

/** A client or a company as stored (work_contacts.json) and as read. */
export const ContactSchema = z.object({
  id: LifeIdSchema,
  name: ContactNameSchema,
  kind: ContactKindSchema,
  state: ContactStateSchema,
  /** A person's company (a `kind: company` contact); never on a company. */
  companyId: LifeIdSchema.optional(),
  /** A person's role ("Head of Ops"). */
  title: ShortText(60).optional(),
  phones: z.array(ContactPhoneSchema).max(WORK_LIMITS.phones),
  emails: z.array(ContactEmailSchema).max(WORK_LIMITS.emails),
  links: z.array(ContactLinkSchema).max(WORK_LIMITS.links),
  city: ShortText(60).optional(),
  tags: z.array(ContactTagSchema).max(WORK_LIMITS.tags),
  /** The standing description. */
  notes: LongNotesSchema.optional(),
  source: ShortText(60).optional(),
  /** A company's client folder (seeded from folders); `jantar mcp`'s client_here finds a company by it. */
  folder: FolderPathSchema.optional(),
  /** "Check in every N days" (W25): shown on Today, never rings. */
  checkInDays: CheckInDaysSchema.optional(),
  from: ContactFromSchema.optional(),
  /** The import it came from (its Undo). */
  importBatch: LifeIdSchema.optional(),
  /** His "not a duplicate" rulings (P3's merge). */
  notDuplicateOf: z.array(LifeIdSchema).max(WORK_LIMITS.notDuplicateOf).optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type Contact = z.infer<typeof ContactSchema>;
/** A contact as its hub shows it: with its newest touch (a logged call, meeting, e-mail, message or note). */
export const ContactViewSchema = ContactSchema.extend({ lastTouchAt: IsoDateSchema.optional() });
export type ContactView = z.infer<typeof ContactViewSchema>;

/** A contact named elsewhere (a project's client, a person's company). */
export const WorkClientRefSchema = z.object({ id: LifeIdSchema, name: z.string(), state: ContactStateSchema, from: ContactFromSchema.optional() });
export type WorkClientRef = z.infer<typeof WorkClientRefSchema>;

/** Amounts per currency (integer hundredths); never added across currencies (W17). null: no currency set. */
export const WorkSumSchema = z.object({ currency: z.string().regex(/^[A-Z]{3}$/).nullable(), amount: z.number().int() });
export type WorkSum = z.infer<typeof WorkSumSchema>;

/** One row of the Clients list. `next`: the earliest open follow-up (W12). */
export const WorkClientRowSchema = z.object({
  id: LifeIdSchema,
  name: z.string(),
  kind: ContactKindSchema,
  state: ContactStateSchema,
  company: z.object({ id: LifeIdSchema, name: z.string() }).optional(),
  title: z.string().optional(),
  next: z.object({ todoId: LifeIdSchema, title: z.string(), due: DueSchema.optional() }).optional(),
  lastTouchAt: IsoDateSchema.optional(),
  openDeals: z.object({ count: z.number().int().nonnegative(), sums: z.array(WorkSumSchema) }),
  tags: z.array(z.string()),
  from: ContactFromSchema.optional(),
  /** A check-in cadence that is due (no touch in `checkInDays`). */
  checkInDue: z.literal(true).optional(),
});
export type WorkClientRow = z.infer<typeof WorkClientRowSchema>;

export const WORK_CLIENT_SORTS = ['name', 'touch', 'next'] as const;
/**
 * `?q=` (name, company, e-mails, phones by digits), `state`, `kind`, `tag`, `company` (a company's people),
 * `quiet` (no touch in that many days), `business` (a project of that business), `checkIn=1` (a check-in
 * due), `sort` (name, newest touch, or soonest follow-up).
 */
export const WorkClientsQuerySchema = z.object({
  q: z.string().trim().min(1).max(80).optional(),
  state: ContactStateSchema.optional(),
  kind: ContactKindSchema.optional(),
  tag: ContactTagSchema.optional(),
  company: LifeIdSchema.optional(),
  quiet: z.coerce.number().int().min(1).max(365).optional(),
  business: LifeIdSchema.optional(),
  checkIn: z.enum(['0', '1']).transform((v) => v === '1').optional(),
  sort: z.enum(WORK_CLIENT_SORTS).default('name'),
});
export type WorkClientsQuery = z.infer<typeof WorkClientsQuerySchema>;
export const WorkClientsResponseSchema = z.object({ clients: z.array(WorkClientRowSchema).max(WORK_LIMITS.clientsPage), more: z.number().int().nonnegative() });
export type WorkClientsResponse = z.infer<typeof WorkClientsResponseSchema>;

const NO_COMPANY_ON_COMPANY = { message: 'a company has no company', path: ['companyId'] };
/**
 * POST /v1/work/clients: add a client in about ten seconds (W3). `companyName` makes the company, or reuses
 * one with the same name, in the same transaction; a company has none. One phone and one e-mail here; the
 * rest through PATCH. `from` is never a body's: the daemon sets it.
 */
export const WorkClientCreateBodySchema = z
  .strictObject({
    name: ContactNameSchema,
    kind: ContactKindSchema.optional(),
    state: ContactStateSchema.optional(),
    companyId: LifeIdSchema.optional(),
    companyName: ContactNameSchema.optional(),
    phone: ContactPhoneValueSchema.optional(),
    email: ContactEmailSchema.optional(),
    title: ShortText(60).optional(),
    tags: z.array(ContactTagSchema).max(WORK_LIMITS.tags).optional(),
    notes: LongNotesSchema.optional(),
    source: ShortText(60).optional(),
    city: ShortText(60).optional(),
    folder: FolderPathSchema.optional(),
    checkInDays: CheckInDaysSchema.optional(),
  })
  .refine((b) => !(b.companyId && b.companyName), { message: 'a company id or a company name, not both', path: ['companyName'] })
  .refine((b) => b.kind !== 'company' || (b.companyId === undefined && b.companyName === undefined), NO_COMPANY_ON_COMPANY);
export type WorkClientCreateBody = z.infer<typeof WorkClientCreateBodySchema>;
export const WorkClientCreateReplySchema = z.object({ id: LifeIdSchema, companyId: LifeIdSchema.optional() });
export type WorkClientCreateReply = z.infer<typeof WorkClientCreateReplySchema>;

/** PATCH /v1/work/clients/:id: every field optional; null clears the optional ones; the lists replace. */
export const WorkClientPatchSchema = z.strictObject({
  name: ContactNameSchema.optional(),
  kind: ContactKindSchema.optional(),
  state: ContactStateSchema.optional(),
  companyId: LifeIdSchema.nullable().optional(),
  title: ShortText(60).nullable().optional(),
  phones: z.array(ContactPhoneSchema).max(WORK_LIMITS.phones).optional(),
  emails: z.array(ContactEmailSchema).max(WORK_LIMITS.emails).optional(),
  links: z.array(ContactLinkSchema).max(WORK_LIMITS.links).optional(),
  city: ShortText(60).nullable().optional(),
  tags: z.array(ContactTagSchema).max(WORK_LIMITS.tags).optional(),
  notes: LongNotesSchema.nullable().optional(),
  source: ShortText(60).nullable().optional(),
  folder: FolderPathSchema.nullable().optional(),
  checkInDays: CheckInDaysSchema.nullable().optional(),
});
export type WorkClientPatch = z.infer<typeof WorkClientPatchSchema>;

/** DELETE /v1/work/clients/:id: its deals and log rows go; its todos and projects stay, unlinked (W30). */
export const WorkClientDeleteReplySchema = z.object({ ok: z.literal(true), removed: z.object({ deals: z.number().int(), log: z.number().int() }) });
export type WorkClientDeleteReply = z.infer<typeof WorkClientDeleteReplySchema>;

/** POST /v1/work/clients/similar (a POST, so a phone or an e-mail never sits in a URL); `except`: the contact being edited. */
export const WorkClientSimilarBodySchema = z
  .strictObject({ name: ContactNameSchema.optional(), email: z.string().trim().min(3).max(120).optional(), phone: ContactPhoneValueSchema.optional(), except: LifeIdSchema.optional() })
  .refine((b) => b.name !== undefined || b.email !== undefined || b.phone !== undefined, { message: 'a name, an e-mail or a phone' });
export type WorkClientSimilarBody = z.infer<typeof WorkClientSimilarBodySchema>;
/** Strongest first: the same e-mail, the same phone (its last 10 digits), then the same name (a hint only). Never blocks (W29). */
export const WorkSimilarWhySchema = z.enum(['email', 'phone', 'name']);
export const WorkClientSimilarReplySchema = z.object({
  matches: z.array(z.object({ id: LifeIdSchema, name: z.string(), company: z.object({ id: LifeIdSchema, name: z.string() }).optional(), why: WorkSimilarWhySchema })).max(WORK_LIMITS.similar),
});
export type WorkClientSimilarReply = z.infer<typeof WorkClientSimilarReplySchema>;

/** GET /v1/work/clients/names?ids=a,b: the names for a client chip on todos (ids it doesn't know are left out). */
export const WorkClientNamesQuerySchema = z.object({
  ids: z
    .string()
    .max(27 * WORK_LIMITS.names)
    .transform((v) => v.split(',').filter(Boolean))
    .pipe(z.array(LifeIdSchema).min(1).max(WORK_LIMITS.names)),
});
export type WorkClientNamesQuery = z.infer<typeof WorkClientNamesQuerySchema>;
export const WorkClientNamesReplySchema = z.object({ clients: z.array(z.object({ id: LifeIdSchema, name: z.string() })) });
export type WorkClientNamesReply = z.infer<typeof WorkClientNamesReplySchema>;

// ---------------------------------------------------------------------------
// P2: the log (work_log)

/** What he logs with a client (a touch, W14). */
export const WORK_LOG_KINDS = ['call', 'meeting', 'email', 'message', 'note'] as const;
export const WorkLogKindSchema = z.enum(WORK_LOG_KINDS);
export type WorkLogKind = z.infer<typeof WorkLogKindSchema>;
/** As stored: his kinds, plus the daemon's `stage` (a deal's move, P3) and `created`. */
export const WorkStoredLogKindSchema = z.enum([...WORK_LOG_KINDS, 'stage', 'created']);
export type WorkStoredLogKind = z.infer<typeof WorkStoredLogKindSchema>;
export const WorkLogDirectionSchema = z.enum(['out', 'in']);
export const WorkLogOutcomeSchema = z.enum(['good', 'neutral', 'bad', 'no_answer']);
export const WorkLogBodyTextSchema = z.string().max(2000);
export const WorkLogMinutesSchema = z.number().int().min(0).max(600);

/** A log row's own words and facts (work_log.json). A `meeting` row with a meeting id carries none: its name is the meeting's. */
export const WorkLogJsonSchema = z.object({
  body: WorkLogBodyTextSchema.optional(),
  direction: WorkLogDirectionSchema.optional(),
  minutes: WorkLogMinutesSchema.optional(),
  outcome: WorkLogOutcomeSchema.optional(),
  stageFrom: z.string().max(40).optional(),
  stageTo: z.string().max(40).optional(),
  from: z.enum(['import']).optional(),
  /** A meeting linked because its project has this client (W15); he linked the rest by hand. */
  auto: z.literal(true).optional(),
  /** He unlinked this meeting from this client: kept so the automatic link doesn't come back; never shown. */
  off: z.literal(true).optional(),
  updatedAt: IsoDateSchema.optional(),
});
export type WorkLogJson = z.infer<typeof WorkLogJsonSchema>;

/**
 * One row of a client's or a project's log, newest first. `followup`: a done follow-up (a todo with this
 * client), merged in by its done time (W13); its id is the todo's. A `meeting` row with a meeting id names
 * the meeting (its name and start, joined from meetings.db at read; a row whose meeting is gone is left out).
 */
export const WorkLogRowSchema = z.object({
  id: LifeIdSchema,
  kind: z.enum([...WORK_LOG_KINDS, 'stage', 'created', 'followup']),
  at: IsoDateSchema,
  contactId: LifeIdSchema.optional(),
  dealId: LifeIdSchema.optional(),
  projectId: LifeIdSchema.optional(),
  meetingId: LifeIdSchema.optional(),
  meeting: z.object({ name: z.string(), startedAt: IsoDateSchema }).optional(),
  body: z.string().optional(),
  direction: WorkLogDirectionSchema.optional(),
  minutes: z.number().int().optional(),
  outcome: WorkLogOutcomeSchema.optional(),
  stageFrom: z.string().optional(),
  stageTo: z.string().optional(),
  /** A follow-up's title; `todoFrom`: the todo's own mark (a meeting's action item). */
  title: z.string().optional(),
  todoFrom: z.enum(['meeting']).optional(),
  from: z.enum(['import']).optional(),
  auto: z.literal(true).optional(),
});
export type WorkLogRow = z.infer<typeof WorkLogRowSchema>;

/** The next page of a log: `<at>~<id>` of the last row shown. */
export const WorkLogCursorSchema = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z~[0-9A-HJKMNP-TV-Z]{26}$/);
export const WorkClientLogQuerySchema = z.object({ before: WorkLogCursorSchema.optional() });
export type WorkClientLogQuery = z.infer<typeof WorkClientLogQuerySchema>;
export const WorkLogPageSchema = z.object({ log: z.array(WorkLogRowSchema).max(WORK_LIMITS.clientLog), next: WorkLogCursorSchema.optional() });
export type WorkLogPage = z.infer<typeof WorkLogPageSchema>;

/** A follow-up made with a log row (W13): a todo with this client, in his space. */
export const WorkNextStepSchema = z.strictObject({ title: TodoTitleSchema, due: DueSchema, dealId: LifeIdSchema.optional(), projectId: LifeIdSchema.optional() });
export type WorkNextStep = z.infer<typeof WorkNextStepSchema>;

/** POST /v1/work/clients/:id/log: a call, meeting, e-mail, message or note, and its next step, in one transaction. */
export const WorkLogAddBodySchema = z.strictObject({
  kind: WorkLogKindSchema,
  /** When it happened (default now); never more than a few minutes ahead. */
  at: IsoDateSchema.optional(),
  direction: WorkLogDirectionSchema.optional(),
  minutes: WorkLogMinutesSchema.optional(),
  outcome: WorkLogOutcomeSchema.optional(),
  body: WorkLogBodyTextSchema.optional(),
  dealId: LifeIdSchema.optional(),
  projectId: LifeIdSchema.optional(),
  next: WorkNextStepSchema.optional(),
});
export type WorkLogAddBody = z.infer<typeof WorkLogAddBodySchema>;
export const WorkLogAddReplySchema = z.object({ id: LifeIdSchema, todoId: LifeIdSchema.optional() });
export type WorkLogAddReply = z.infer<typeof WorkLogAddReplySchema>;
/** PATCH /v1/work/log/:id (his own rows only; null clears). */
export const WorkLogPatchSchema = z.strictObject({
  kind: WorkLogKindSchema.optional(),
  at: IsoDateSchema.optional(),
  direction: WorkLogDirectionSchema.nullable().optional(),
  minutes: WorkLogMinutesSchema.nullable().optional(),
  outcome: WorkLogOutcomeSchema.nullable().optional(),
  body: WorkLogBodyTextSchema.nullable().optional(),
  dealId: LifeIdSchema.nullable().optional(),
  projectId: LifeIdSchema.nullable().optional(),
});
export type WorkLogPatch = z.infer<typeof WorkLogPatchSchema>;

// ---------------------------------------------------------------------------
// P2: one client as a hub (GET /v1/work/clients/:id)

/** "Check in every N days": `since` whole days since the last touch (null: never touched); `due` once it is N or more. */
export const WorkCheckInSchema = z.object({ every: z.number().int(), since: z.number().int().nullable(), due: z.boolean() });

export const WorkClientHubSchema = z.object({
  contact: ContactViewSchema,
  /** A person's company. */
  company: WorkClientRefSchema.optional(),
  /** A company's people. */
  people: z.array(WorkClientRowSchema).max(WORK_LIMITS.hubPeople).optional(),
  /** Its projects (and, for a person, its company's), owner-space only. */
  projects: z.array(ProjectViewSchema),
  /** Its open follow-ups, by due. */
  followUps: z.array(TodoSchema),
  log: z.array(WorkLogRowSchema).max(WORK_LIMITS.clientLog),
  logNext: WorkLogCursorSchema.optional(),
  checkIn: WorkCheckInSchema.optional(),
  openDeals: z.object({ count: z.number().int().nonnegative(), sums: z.array(WorkSumSchema) }),
});
export type WorkClientHub = z.infer<typeof WorkClientHubSchema>;

// ---------------------------------------------------------------------------
// P2: meetings linked to clients (W15). The link lives in Work (work_log rows with a meeting id).

export const WorkMeetingParamsSchema = z.object({ meetingId: LifeIdSchema });
/** PUT /v1/work/meetings/:meetingId/clients: the meeting's clients, replacing the set (Unlink is leaving one out). */
export const WorkMeetingClientsBodySchema = z.strictObject({ clientIds: z.array(LifeIdSchema).max(WORK_LIMITS.meetingClients) });
export type WorkMeetingClientsBody = z.infer<typeof WorkMeetingClientsBodySchema>;
/**
 * GET /v1/work/meetings/:meetingId/suggest: the clients linked now (`auto`: through its project), the
 * project's client, and each name in the meeting's people with a client of that name when there is one.
 * The names are the meeting's (other people's words): only his tap links or makes anything.
 */
export const WorkMeetingSuggestReplySchema = z.object({
  linked: z.array(z.object({ id: LifeIdSchema, name: z.string(), auto: z.boolean() })),
  auto: z.object({ id: LifeIdSchema, name: z.string() }).optional(),
  people: z.array(z.object({ index: z.number().int().nonnegative(), text: z.string(), match: z.object({ id: LifeIdSchema, name: z.string() }).optional() })),
});
export type WorkMeetingSuggestReply = z.infer<typeof WorkMeetingSuggestReplySchema>;
/** POST /v1/work/meetings/:meetingId/clients/new: a client made from one of the meeting's people (by index), marked `from: 'meeting'`, and linked. */
export const WorkMeetingClientNewBodySchema = z.strictObject({ person: z.number().int().min(0).max(49), kind: ContactKindSchema.optional(), state: ContactStateSchema.optional() });
export type WorkMeetingClientNewBody = z.infer<typeof WorkMeetingClientNewBodySchema>;

// ---------------------------------------------------------------------------
// P2: import and export (W27). Never another app's database: only a file he hands over.

/** Where an imported column can go (life-core's IMPORT_FIELDS; a test pins them equal). */
export const WORK_IMPORT_FIELDS = ['name', 'firstName', 'lastName', 'email', 'phone', 'company', 'title', 'tags', 'notes', 'source', 'city', 'state', 'website', 'linkedin', 'skip'] as const;
export const WorkImportFieldSchema = z.enum(WORK_IMPORT_FIELDS);
export type WorkImportField = z.infer<typeof WorkImportFieldSchema>;

/** POST /v1/work/import/preview: a CSV or vCard file's text (at most 1 MB), and a column mapping to use instead of the guessed one (CSV). */
export const WorkImportPreviewBodySchema = z.strictObject({
  format: z.enum(['csv', 'vcf']),
  text: z.string().min(1).max(WORK_LIMITS.importBytes),
  mapping: z.array(WorkImportFieldSchema).max(WORK_LIMITS.importColumns).optional(),
});
export type WorkImportPreviewBody = z.infer<typeof WorkImportPreviewBodySchema>;

/** One row as Work would store it (after the caps: what doesn't fit is clipped or dropped). */
export const WorkImportFieldsSchema = z.object({
  name: z.string(),
  kind: ContactKindSchema,
  company: z.string().optional(),
  title: z.string().optional(),
  emails: z.array(z.string()),
  phones: z.array(z.string()),
  tags: z.array(z.string()),
  notes: z.string().optional(),
  source: z.string().optional(),
  city: z.string().optional(),
  state: ContactStateSchema.optional(),
  links: z.array(z.string()),
});
export type WorkImportFields = z.infer<typeof WorkImportFieldsSchema>;
export const WorkImportActionSchema = z.enum(['add', 'skip', 'fill']);
export type WorkImportAction = z.infer<typeof WorkImportActionSchema>;
/**
 * The preview: the columns and their mapping, and each row with its duplicate warning and default (Skip for
 * the same e-mail or phone, Add for a name-only match or none). A row with no name is skipped (`problem`).
 */
export const WorkImportPreviewReplySchema = z.object({
  previewId: LifeIdSchema,
  format: z.enum(['csv', 'vcf']),
  columns: z.array(z.string()).max(WORK_LIMITS.importColumns),
  mapping: z.array(WorkImportFieldSchema).max(WORK_LIMITS.importColumns),
  rows: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        fields: WorkImportFieldsSchema,
        dup: z.object({ id: LifeIdSchema, name: z.string(), why: WorkSimilarWhySchema }).optional(),
        action: WorkImportActionSchema,
      }),
    )
    .max(WORK_LIMITS.importRows),
  /** Rows left out: no name, or past the 2,000-row cap. */
  skipped: z.number().int().nonnegative(),
  expiresAt: IsoDateSchema,
});
export type WorkImportPreviewReply = z.infer<typeof WorkImportPreviewReplySchema>;

/** POST /v1/work/import: the preview's rows by index with what to do (a row not named is skipped), and the mapping if he changed it. */
export const WorkImportBodySchema = z.strictObject({
  previewId: LifeIdSchema,
  mapping: z.array(WorkImportFieldSchema).max(WORK_LIMITS.importColumns).optional(),
  rows: z.array(z.strictObject({ index: z.number().int().nonnegative(), action: WorkImportActionSchema })).max(WORK_LIMITS.importRows),
});
export type WorkImportBody = z.infer<typeof WorkImportBodySchema>;
export const WorkImportReplySchema = z.object({ batch: LifeIdSchema, added: z.number().int().nonnegative(), filled: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() });
export type WorkImportReply = z.infer<typeof WorkImportReplySchema>;
export const WorkImportParamsSchema = z.object({ batch: LifeIdSchema });
/** DELETE /v1/work/import/:batch: removes the contacts it added that nothing changed or linked since; the rest are kept and counted. */
export const WorkImportUndoReplySchema = z.object({ removed: z.number().int().nonnegative(), kept: z.number().int().nonnegative() });
export type WorkImportUndoReply = z.infer<typeof WorkImportUndoReplySchema>;
/** GET /v1/work/imports: the newest imports, with until when each can be undone. */
export const WorkImportsReplySchema = z.object({
  imports: z.array(z.object({ batch: LifeIdSchema, at: IsoDateSchema, added: z.number().int(), filled: z.number().int(), undoUntil: IsoDateSchema })).max(WORK_LIMITS.importsKept),
});
export type WorkImportsReply = z.infer<typeof WorkImportsReplySchema>;
/** GET /v1/work/export.csv?what=clients: a CSV of his clients (P3 adds deals). */
export const WorkExportQuerySchema = z.object({ what: z.enum(['clients']).default('clients') });
export type WorkExportQuery = z.infer<typeof WorkExportQuerySchema>;

// ---------------------------------------------------------------------------
// P2: Work's own settings (W44: data in life.db, the phone may change them)

export const WorkBusinessSchema = z.object({ id: LifeIdSchema, name: z.string().trim().min(1).max(40) });
export type WorkBusiness = z.infer<typeof WorkBusinessSchema>;
/** WhatsApp needs a country code: "+91" puts it before a 10-digit number. */
export const WorkDialCodeSchema = z.string().regex(/^\+\d{1,4}$/);
export const WorkSettingsSchema = z.object({
  businesses: z.array(WorkBusinessSchema).max(WORK_LIMITS.businesses),
  dialCode: WorkDialCodeSchema.optional(),
  /** Quiet after this many days with no touch (default 14). */
  quietDays: z.number().int().min(1).max(90),
  /** life.workLockScreenNames (a Mac switch: `jantar work lockscreen names on`). Read only here. */
  lockScreenNames: z.boolean(),
});
export type WorkSettings = z.infer<typeof WorkSettingsSchema>;
/** PATCH /v1/work/settings: `businesses` replaces the list (one without an id is new; ids kept keep their projects). */
export const WorkSettingsPatchSchema = z.strictObject({
  businesses: z.array(z.strictObject({ id: LifeIdSchema.optional(), name: z.string().trim().min(1).max(40) })).max(WORK_LIMITS.businesses).optional(),
  dialCode: WorkDialCodeSchema.nullable().optional(),
  quietDays: z.number().int().min(1).max(90).optional(),
});
export type WorkSettingsPatch = z.infer<typeof WorkSettingsPatchSchema>;

// ---------------------------------------------------------------------------
// P2: `jantar mcp`'s client_here (GET /v1/folder/client, ctl.sock only)

export const FolderClientQuerySchema = z.object({ folder: FolderPathSchema });
export type FolderClientQuery = z.infer<typeof FolderClientQuerySchema>;
/** Words someone else wrote come marked with where they came from (an import, a meeting). */
export const WorkSourceSchema = z.enum(['import', 'meeting']);
/**
 * The client of a session's folder: the client of the project that holds it (the deepest), else a company
 * whose folder holds it. Its name, state, open deals, the next step and the last touch; never a phone, an
 * e-mail, notes or log text.
 */
export const FolderClientResponseSchema = z.object({
  client: z
    .object({
      id: LifeIdSchema,
      name: z.string(),
      kind: ContactKindSchema,
      state: ContactStateSchema,
      source: WorkSourceSchema.optional(),
      company: z.object({ id: LifeIdSchema, name: z.string(), source: WorkSourceSchema.optional() }).optional(),
      project: z.object({ id: LifeIdSchema, name: z.string() }).optional(),
      next: z.object({ title: z.string(), due: DueSchema.optional(), source: z.enum(['meeting']).optional() }).optional(),
      lastTouchAt: IsoDateSchema.optional(),
      openDeals: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type FolderClientResponse = z.infer<typeof FolderClientResponseSchema>;

// ---------------------------------------------------------------------------
// The project hub (GET /v1/projects/:id)

export const ProjectHealthSchema = z.object({
  /** Open todos past due (Life's rule: before today, or today at a time before now), as the project's row counts them. */
  overdue: z.number().int().nonnegative(),
  /** The soonest-due open todo, overdue or not; absent when none has a due day. */
  nextDue: z.object({ todoId: LifeIdSchema, due: DueSchema }).optional(),
  /** Whole days since the project or one of its todos last changed, for an active project quiet past WORK_LIMITS.projectQuietDays. */
  quietDays: z.number().int().positive().optional(),
  /** Todos done in each of the last WORK_LIMITS.hubWeeks weeks (Monday to Monday in the Life zone), oldest first. */
  doneByWeek: z.array(z.number().int().nonnegative()).length(WORK_LIMITS.hubWeeks),
});
export type ProjectHealth = z.infer<typeof ProjectHealthSchema>;

/**
 * One project on one screen: the project with its counts, its open todos
 * (by due), how many were done this week, the newest done, and its health.
 * Meetings come from `GET /v1/meetings?project=` (while Meetings is on), and
 * live sessions from the board's own state (the project's folder).
 */
export const ProjectHubSchema = z.object({
  project: ProjectViewSchema,
  open: z.array(TodoSchema),
  doneThisWeek: z.number().int().nonnegative(),
  recentDone: z.array(TodoSchema).max(WORK_LIMITS.hubRecentDone),
  health: ProjectHealthSchema,
  /** P2, while Work is on (his own project only): the project's client, and its newest log rows. */
  client: WorkClientRefSchema.optional(),
  log: z.array(WorkLogRowSchema).max(WORK_LIMITS.projectLog).optional(),
});
export type ProjectHub = z.infer<typeof ProjectHubSchema>;

// ---------------------------------------------------------------------------
// One search across Jantar (GET /v1/search)

/** What a result is, in the order the search sheet lists its groups. */
export const SEARCH_KINDS = ['client', 'project', 'deal', 'todo', 'meeting', 'session', 'intel', 'place', 'post'] as const;
export const SearchKindSchema = z.enum(SEARCH_KINDS);
export type SearchKind = z.infer<typeof SearchKindSchema>;

/** `?q=` (2 to 80 characters once trimmed) and `?limit=` (results per group, at most 5). */
export const SearchQuerySchema = z.object({
  q: z.string().trim().min(WORK_LIMITS.searchMin).max(WORK_LIMITS.searchMax),
  limit: z.coerce.number().int().min(1).max(WORK_LIMITS.searchPerGroup).default(WORK_LIMITS.searchPerGroup),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

/** One result: what it is, its id, the words to show, and the app path that opens it (ids only). */
export const SearchItemSchema = z.object({
  kind: SearchKindSchema,
  id: z.string().min(1).max(200),
  label: z.string().max(200),
  sub: z.string().max(200).optional(),
  href: z.string().max(400),
});
export type SearchItem = z.infer<typeof SearchItemSchema>;

export const SearchGroupSchema = z.object({ kind: SearchKindSchema, items: z.array(SearchItemSchema).min(1).max(WORK_LIMITS.searchPerGroup) });
export type SearchGroup = z.infer<typeof SearchGroupSchema>;

/** Only the groups with a match, in SEARCH_KINDS order; a group whose switch is off is never asked. */
export const SearchResponseSchema = z.object({ groups: z.array(SearchGroupSchema) });
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

// ---------------------------------------------------------------------------
// Projects from his client folders (POST /v1/work/seed)

/**
 * One folder, as the folder browsers address it (a root id from
 * `GET /v1/folders/roots` or Files' roots, and a path under it), and the
 * project's name. The root must be a configured one (folders.roots).
 */
export const WorkSeedItemSchema = z.strictObject({
  root: z.string().min(1).max(160),
  path: z.string().min(1).max(1024),
  name: ProjectBodySchema.shape.name,
});
export type WorkSeedItem = z.infer<typeof WorkSeedItemSchema>;

/** P2 `clients`: also one company client per folder (its folder set), the project's client ("Also make a client for each"). */
export const WorkSeedBodySchema = z.strictObject({ items: z.array(WorkSeedItemSchema).min(1).max(WORK_LIMITS.seedItems), clients: z.boolean().optional() });
export type WorkSeedBody = z.infer<typeof WorkSeedBodySchema>;

/** The new projects' ids, in the order given; `skipped`: folders a project already links; P2 `clients`: the companies made, in the same order. */
export const WorkSeedReplySchema = z.object({ projects: z.array(LifeIdSchema), skipped: z.number().int().nonnegative(), clients: z.array(LifeIdSchema).optional() });
export type WorkSeedReply = z.infer<typeof WorkSeedReplySchema>;

// ---------------------------------------------------------------------------
// Route tables (owner-only: control scope, his host, never under /v1/p/; the arch test pins them)

function route<T extends RouteDef>(r: T): T {
  return r;
}

/**
 * P1: one project as a hub, one search across Jantar, and projects made from
 * client folders. Reads need control too; only the seed is on ctl.sock (the
 * CLI). The search has no switch of its own: each group answers only while
 * its own part is on.
 *
 * P2: clients, the log, meetings linked to clients, import and export, and
 * Work's settings, behind the `work` switch. On ctl.sock only what the CLI
 * and `jantar mcp` need: the import, its list and undo, the export, the
 * settings read, and client_here (ctl.sock only).
 */
export const WORK_ROUTES = {
  projectGet: route({
    method: 'GET', path: '/v1/projects/:id', scope: 'control', phase: 'v0.13', ctl: false, feature: 'todos',
    params: LifeIdParamsSchema, response: ProjectHubSchema,
    summary: 'One project as a hub: its counts, open todos, the newest done, this week and its health.',
  }),
  search: route({
    method: 'GET', path: '/v1/search', scope: 'control', phase: 'v0.13', ctl: false,
    query: SearchQuerySchema, response: SearchResponseSchema,
    summary: 'Find a project, todo, meeting, session, Intel item, café or post (each group only while its part is on).',
  }),
  // Never automatic: the phone's sheet (folders picked from Launch's or Files' browser) or the Mac's CLI.
  foldersSeed: route({
    method: 'POST', path: '/v1/work/seed', scope: 'control', phase: 'v0.13', ctl: true, feature: 'work',
    body: WorkSeedBodySchema, response: WorkSeedReplySchema,
    summary: 'One project per folder under a configured root, its folder linked (a folder a project links already is skipped); P2: a company client each.',
  }),

  // --- P2: clients, the log, follow-ups, meetings, import and export, settings. Feature `work`; reads and
  // writes on his host; only what the CLI and `jantar mcp` need is on ctl.sock.
  workClients: route({
    method: 'GET', path: '/v1/work/clients', scope: 'control', phase: 'v0.13', ctl: false, feature: 'work',
    query: WorkClientsQuerySchema, response: WorkClientsResponseSchema,
    summary: 'His clients and companies, filtered and sorted, each with its next step, last touch and open deals.',
  }),
  workClientCreate: route({
    method: 'POST', path: '/v1/work/clients', scope: 'control', phase: 'v0.13', ctl: false, feature: 'work',
    body: WorkClientCreateBodySchema, response: WorkClientCreateReplySchema,
    summary: 'Add a client or a company (a company by name is made or reused in the same save).',
  }),
  workClientSimilar: route({
    method: 'POST', path: '/v1/work/clients/similar', scope: 'control', phase: 'v0.13', ctl: false, feature: 'work',
    body: WorkClientSimilarBodySchema, response: WorkClientSimilarReplySchema,
    summary: 'Clients this one may already be (the same e-mail, phone or name): a warning, never a block.',
  }),
  workClientNames: route({
    method: 'GET', path: '/v1/work/clients/names', scope: 'control', phase: 'v0.13', ctl: false, feature: 'work',
    query: WorkClientNamesQuerySchema, response: WorkClientNamesReplySchema,
    summary: "Clients' names by id, for the client chip on todos.",
  }),
  workClientGet: route({
    method: 'GET', path: '/v1/work/clients/:id', scope: 'control', phase: 'v0.13', ctl: false, feature: 'work',
    params: LifeIdParamsSchema, response: WorkClientHubSchema,
    summary: 'One client as a hub: details, company or people, projects, open follow-ups and the newest log.',
  }),
  workClientLog: route({
    method: 'GET', path: '/v1/work/clients/:id/log', scope: 'control', phase: 'v0.13', ctl: false, feature: 'work',
    params: LifeIdParamsSchema, query: WorkClientLogQuerySchema, response: WorkLogPageSchema,
    summary: "The next page of a client's log.",
  }),
  workClientUpdate: route({
    method: 'PATCH', path: '/v1/work/clients/:id', scope: 'control', phase: 'v0.13', ctl: false, feature: 'work',
    params: LifeIdParamsSchema, body: WorkClientPatchSchema, response: OkReplySchema,
    summary: 'Change a client (null clears a field).',
  }),
  workClientDelete: route({
    method: 'DELETE', path: '/v1/work/clients/:id', scope: 'control', phase: 'v0.13', ctl: false, feature: 'work',
    params: LifeIdParamsSchema, response: WorkClientDeleteReplySchema,
    summary: 'Delete a client with its deals and log; its todos and projects stay, unlinked.',
  }),
  workLogAdd: route({
    method: 'POST', path: '/v1/work/clients/:id/log', scope: 'control', phase: 'v0.13', ctl: false, feature: 'work',
    params: LifeIdParamsSchema, body: WorkLogAddBodySchema, response: WorkLogAddReplySchema,
    summary: 'Log a call, meeting, e-mail, message or note, and its next step, in one save.',
  }),
  workLogUpdate: route({
    method: 'PATCH', path: '/v1/work/log/:id', scope: 'control', phase: 'v0.13', ctl: false, feature: 'work',
    params: LifeIdParamsSchema, body: WorkLogPatchSchema, response: OkReplySchema,
    summary: 'Change a logged entry of his (null clears a field).',
  }),
  workLogDelete: route({
    method: 'DELETE', path: '/v1/work/log/:id', scope: 'control', phase: 'v0.13', ctl: false, feature: 'work',
    params: LifeIdParamsSchema, response: OkReplySchema,
    summary: 'Delete a logged entry of his.',
  }),
  // The two meeting routes answer Meetings' off sentence while Meetings is off (one feature per route).
  workMeetingClients: route({
    method: 'PUT', path: '/v1/work/meetings/:meetingId/clients', scope: 'control', phase: 'v0.13', ctl: false, feature: 'work',
    params: WorkMeetingParamsSchema, body: WorkMeetingClientsBodySchema, response: OkReplySchema,
    summary: "Set a meeting's clients (replacing them; leaving one out unlinks it).",
  }),
  workMeetingSuggest: route({
    method: 'GET', path: '/v1/work/meetings/:meetingId/suggest', scope: 'control', phase: 'v0.13', ctl: false, feature: 'work',
    params: WorkMeetingParamsSchema, response: WorkMeetingSuggestReplySchema,
    summary: "A meeting's clients now, its project's client, and its people's names matched to clients.",
  }),
  workMeetingClientNew: route({
    method: 'POST', path: '/v1/work/meetings/:meetingId/clients/new', scope: 'control', phase: 'v0.13', ctl: false, feature: 'work',
    params: WorkMeetingParamsSchema, body: WorkMeetingClientNewBodySchema, response: IdReplySchema,
    summary: "A client made from one of a meeting's people (marked as a meeting's words), linked to it.",
  }),
  workImportPreview: route({
    method: 'POST', path: '/v1/work/import/preview', scope: 'control', phase: 'v0.13', ctl: true, feature: 'work',
    bodyLimit: WORK_LIMITS.importBodyBytes,
    body: WorkImportPreviewBodySchema, response: WorkImportPreviewReplySchema,
    summary: 'Read a CSV or vCard file: its columns, each row with a duplicate warning, kept 30 minutes for the import.',
  }),
  workImport: route({
    method: 'POST', path: '/v1/work/import', scope: 'control', phase: 'v0.13', ctl: true, feature: 'work',
    body: WorkImportBodySchema, response: WorkImportReplySchema,
    summary: "Import a preview's rows as one batch (every contact marked as imported); undoable for 7 days.",
  }),
  workImports: route({
    method: 'GET', path: '/v1/work/imports', scope: 'control', phase: 'v0.13', ctl: true, feature: 'work',
    response: WorkImportsReplySchema,
    summary: 'The newest imports and until when each can be undone.',
  }),
  workImportUndo: route({
    method: 'DELETE', path: '/v1/work/import/:batch', scope: 'control', phase: 'v0.13', ctl: true, feature: 'work',
    params: WorkImportParamsSchema, response: WorkImportUndoReplySchema,
    summary: 'Undo an import: the contacts it added that nothing changed since go; the rest are counted.',
  }),
  workExport: route({
    method: 'GET', path: '/v1/work/export.csv', scope: 'control', phase: 'v0.13', ctl: true, feature: 'work', rawResponse: true,
    query: WorkExportQuerySchema,
    summary: 'His clients as a CSV file (a download or the share sheet; never written into a folder).',
  }),
  workSettings: route({
    method: 'GET', path: '/v1/work/settings', scope: 'control', phase: 'v0.13', ctl: true, feature: 'work',
    response: WorkSettingsSchema,
    summary: "Work's settings: businesses, the dial code, quiet days, and whether the lock screen names clients.",
  }),
  workSettingsUpdate: route({
    method: 'PATCH', path: '/v1/work/settings', scope: 'control', phase: 'v0.13', ctl: false, feature: 'work',
    body: WorkSettingsPatchSchema, response: OkReplySchema,
    summary: "Change Work's businesses, dial code or quiet days.",
  }),
  // `jantar mcp` (a session's folder): who the work is for; never a phone, an e-mail, notes or log text.
  workClientHere: route({
    method: 'GET', path: '/v1/folder/client', scope: 'control', phase: 'v0.13', ctl: true, localOnly: true, feature: 'work',
    query: FolderClientQuerySchema, response: FolderClientResponseSchema,
    summary: "The client of a folder's project (the deepest), or of the company whose folder holds it; null when none.",
  }),
} as const satisfies Record<string, RouteDef>;
export type WorkRouteName = keyof typeof WORK_ROUTES;
