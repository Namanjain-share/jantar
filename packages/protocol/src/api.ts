/**
 * REST API types for every route, plus the WebSocket messages of
 * `WS /v1/events`.
 *
 * Rules every route follows:
 * - Bodies are zod-validated; errors are `{error:{code,message}}`, never raw
 *   internal errors.
 * - Writes accept an `Idempotency-Key` header and are audited.
 * - Every `/v1` route needs a paired-device cookie (or arrives on ctl.sock).
 * - ctl.sock (the `jantar` CLI's Unix socket) speaks the same HTTP API, as
 *   actor "cli" with all scopes, but only routes marked `ctl: true` are served
 *   there. Approvals are never accepted on ctl.sock (self-approval guard).
 */
import { z } from 'zod';
import {
  AccountIdSchema,
  AccountSchema,
  AlertSchema,
  AttachmentRefSchema,
  AuditEntrySchema,
  ControlKeySchema,
  DevicePublicSchema,
  FileChangeSchema,
  FileListingSchema,
  FileOpSchema,
  FileRootSchema,
  FileStatSchema,
  FileTextSchema,
  FolderEntrySchema,
  IsoDateSchema,
  LaunchEffortSchema,
  LaunchFlagsSchema,
  LaunchJobSchema,
  LaunchModelSchema,
  LaunchNameSchema,
  LaunchPermissionSchema,
  LaunchPreviewSchema,
  MoveSchema,
  PastSessionSchema,
  NotifyKindSchema,
  PaneSchema,
  PendingRequestSchema,
  PermissionModeNameSchema,
  PushSubscriptionSchema,
  RewriteDetailSchema,
  RewriteJobSchema,
  RewriteModelSchema,
  ScopeSchema,
  SendJobSchema,
  SessionCommandBodySchema,
  SessionSchema,
  TerminalDialogSchema,
  TranscriptItemSchema,
  UploadIdSchema,
  UploadKindSchema,
  type PermissionModeName,
  type Scope,
} from './models.js';
import { SettingsPatchSchema, SettingsSchema } from './settings.js';
import {
  DEVICE_SECRET_WS_PREFIX,
  DIALOG_GATES,
  DIALOG_TEXT_MAX,
  DIALOG_TEXT_MIN,
  EVENTS_WS_PROTOCOL,
  FILES_CHANGES_LIMIT,
  FILES_LIST_LIMIT,
  FILES_TEXT_WINDOW,
  LAUNCH_HISTORY_LIMIT,
  KEYPAD_LINES,
  LAUNCH_PROMPT_MAX,
  MEETING_SHOT_BODY_MAX,
  REWRITE_TEXT_MAX,
  UPLOADS_PER_PROMPT,
  UPLOAD_MAX_BYTES,
} from './constants.js';
import {
  BillBodySchema,
  BillPaidBodySchema,
  BillPatchSchema,
  BudgetBodySchema,
  DayParamsSchema,
  DayQuerySchema,
  DoseBodySchema,
  DoseParamsSchema,
  FoodBodySchema,
  FoodDaySchema,
  FoodEstimateBodySchema,
  FoodEstimateSchema,
  FoodPatchSchema,
  FoodTargetsBodySchema,
  IdReplySchema,
  LifeBackupResponseSchema,
  LifeIdParamsSchema,
  LifeRestoreBodySchema,
  LifeRestoreResponseSchema,
  LifeStatusSchema,
  MedicineBodySchema,
  MedicinePatchSchema,
  MedicinesResponseSchema,
  MoneyBodySchema,
  MoneyMonthSchema,
  MoneyPatchSchema,
  MoneyQuerySchema,
  OkReplySchema,
  PlaceBodySchema,
  PlacePatchSchema,
  PlacesQuerySchema,
  PlacesResponseSchema,
  ProjectBodySchema,
  ProjectPatchSchema,
  ProjectsResponseSchema,
  SnoozeBodySchema,
  TodaySchema,
  TodoBodySchema,
  TodoDoneBodySchema,
  TodoPatchSchema,
  TodosQuerySchema,
  TodosResponseSchema,
  WeightBodySchema,
} from './life.js';
import {
  IntelCaptureBodySchema,
  IntelCaptureReplySchema,
  IntelItemResponseSchema,
  IntelListQuerySchema,
  IntelListResponseSchema,
  IntelParamsSchema,
  IntelSourcesResponseSchema,
} from './intel.js';
import {
  ClientIdParamsSchema,
  ExtEndBodySchema,
  ExtInfoSchema,
  ExtLinesBodySchema,
  ExtOpenBodySchema,
  ExtPairClaimBodySchema,
  ExtPairClaimReplySchema,
  ExtPairStartReplySchema,
  ExtShotBodySchema,
  ExtUnpairReplySchema,
  MeetingDetailSchema,
  MeetingItemParamsSchema,
  MeetingParamsSchema,
  MeetingPatchSchema,
  MeetingShotParamsSchema,
  MeetingsListSchema,
  MeetingsQuerySchema,
  MeetingsStatusSchema,
} from './meetings.js';
import { StateSchema } from './state.js';
import { EventSchema } from './events.js';

// ---------------------------------------------------------------------------
// Errors

export const ErrorCodeSchema = z.enum([
  'unauthorized', // 401: no or unknown device cookie
  'forbidden', // 403: wrong Origin, missing scope, or route not allowed here
  'not_found', // 404
  'invalid_request', // 400: body/query/params failed validation
  'conflict', // 409: e.g. the card is already closed
  'needs_confirm', // 409: a second tap is required (e.g. "always allow" for Bash)
  'refused', // 422: preconditions failed (the reason says which)
  'payload_too_large', // 413
  'rate_limited', // 429
  'unavailable', // 503: a dependency is down (terminal unreadable, cswap missing)
  'not_implemented', // 501
  'internal', // 500
  // v0.3
  'unsupported_media_type', // 415: files/raw for anything but an allowlisted image or PDF
  'screenshots_off', // 403: screenshots are switched off on the Mac
  'mode_unavailable', // 409: that permission mode is not in this session's cycle
  'input_not_empty', // 409: the input box holds a draft (a key's Return would submit it)
  'dialog_open', // 409: a dialog is on screen (a key would answer it)
  'escape_unverified', // 409: Escape is refused while controls.escapeVerified is off
  'tab_not_visible', // 409: another tab is showing in that window (use the text peek)
  // v0.4
  'life_unavailable', // 503: life.db would not open (the file is untouched; restore a backup at the Mac)
  'estimate_failed', // 502: Ask Claude gave no usable estimate (type the calories instead)
  // v0.4.2
  'length_required', // 411: an upload without a Content-Length (its size is checked before the body is read)
  // v0.5
  'meetings_unavailable', // 503: meetings.db would not open (the file is untouched; move it aside at the Mac)
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ERROR_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  conflict: 409,
  needs_confirm: 409,
  refused: 422,
  payload_too_large: 413,
  rate_limited: 429,
  unavailable: 503,
  not_implemented: 501,
  internal: 500,
  unsupported_media_type: 415,
  screenshots_off: 403,
  mode_unavailable: 409,
  input_not_empty: 409,
  dialog_open: 409,
  escape_unverified: 409,
  tab_not_visible: 409,
  life_unavailable: 503,
  estimate_failed: 502,
  length_required: 411,
  meetings_unavailable: 503,
};

export const ErrorBodySchema = z.object({
  error: z.object({ code: ErrorCodeSchema, message: z.string() }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

export const OkSchema = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------
// Shared params / queries

const limit = (def: number, max: number) => z.coerce.number().int().min(1).max(max).default(def);

export const SidParamsSchema = z.object({ sid: z.string().min(1).max(128) });
export const IdParamsSchema = z.object({ id: z.string().min(1).max(128) });
export const JobParamsSchema = z.object({ jobId: z.string().min(1).max(128) });

// ---------------------------------------------------------------------------
// Payloads

export const StateResponseSchema = z.object({
  seq: z.number().int().nonnegative(),
  /** Changes on every daemon start; a client that sees a new epoch resyncs. */
  epoch: z.string(),
  state: StateSchema,
});

export const SessionsResponseSchema = z.object({ sessions: z.array(SessionSchema) });

export const SessionResponseSchema = z.object({
  session: SessionSchema,
  pending: z.array(PendingRequestSchema),
  pane: PaneSchema.nullable(),
});

export const TranscriptQuerySchema = z.object({
  /** Opaque cursor from a previous page's `nextBefore`. */
  before: z.string().max(256).optional(),
  limit: limit(50, 200),
});
export const TranscriptResponseSchema = z.object({
  items: z.array(TranscriptItemSchema),
  /** Pass as `before` to get older items; null when there are none. */
  nextBefore: z.string().nullable(),
});

export const ScreenQuerySchema = z.object({ lines: limit(80, 400) });
export const ScreenResponseSchema = z.object({
  text: z.string(),
  lines: z.number().int().nonnegative(),
  at: IsoDateSchema,
  backend: z.string(),
  /** v0.4.2: the dialog this screen shows, when Jantar can turn it into buttons. */
  dialog: TerminalDialogSchema.optional(),
  /** v0.4.2: why a dialog-looking screen gets no buttons (one of DIALOG_NOTES). */
  dialogNote: z.string().max(200).optional(),
  /**
   * v0.4.2: sha256 hex of the lines this reply shows (the lines under the
   * last box edge left out, unless a pointer row comes after that edge):
   * the keypad sends it back, and keys are typed only while the Mac still
   * shows exactly those lines. Optional so older replies parse; the daemon
   * always sends it.
   */
  screenKey: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export const PromptBodySchema = z
  .object({
    /** v0.4.2: may be blank when attachments are given (the daemon then writes the opening line). */
    text: z.string().max(16_000).default(''),
    /** What to do if the input box already holds a real draft (tmux only can tell). */
    onDraft: z.enum(['refuse', 'replace']).default('refuse'),
    /**
     * v0.3: the rewrite job this text came from. The daemon compares sha256(text)
     * with the job's hashes to set SendJob.origin, and marks the job sent.
     */
    rewriteJobId: z.string().min(1).max(128).optional(),
    /**
     * v0.4.2: uploads of this session to name in the prompt. The daemon
     * appends an "Attached files:" block with each one's label and absolute
     * path after the text (uploads/compose.ts); the rewrite origin is still
     * taken from `text` alone.
     */
    attachments: z.array(AttachmentRefSchema).max(UPLOADS_PER_PROMPT).optional(),
  })
  .refine((b) => b.text.trim() !== '' || (b.attachments?.length ?? 0) > 0, { message: 'text is empty (and no files are attached)', path: ['text'] });
export type PromptBody = z.infer<typeof PromptBodySchema>;
export const PromptAcceptedSchema = z.object({ jobId: z.string(), job: SendJobSchema });

export const SendJobResponseSchema = z.object({ job: SendJobSchema });

export const PendingListResponseSchema = z.object({ pending: z.array(PendingRequestSchema) });

export const DecisionBodySchema = z
  .object({
    behavior: z.enum(['allow', 'deny']),
    /** Index into the card's `suggestions` ("always allow"). Clients never send rule objects. */
    suggestion: z.number().int().min(0).optional(),
    /** AskUserQuestion answers keyed by question text; arrays are joined with ",". */
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    /** Deny reason, or "revise the plan" feedback. */
    message: z.string().max(4000).optional(),
    /** Deny and end the turn. */
    interrupt: z.boolean().optional(),
    /**
     * Plan approval: also switch the session's permission mode. v0.4.2:
     * `auto` (needs confirm: true, as CONFIRM_MODES says) and only where the
     * card's `planModes` offers it.
     */
    mode: z.enum(['acceptEdits', 'default', 'auto']).optional(),
    /**
     * v0.4.2: several of the card's suggestions at once, by index (Claude's
     * own "Yes, and allow access to … for this session" row applies every
     * session-scoped one together). Never together with `suggestion`.
     */
    suggestions: z.array(z.number().int().min(0)).min(1).max(8).optional(),
    /** Second tap for dangerous choices (always-allow on Bash). */
    confirm: z.boolean().optional(),
  })
  .superRefine((b, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (b.behavior !== 'allow' && (b.suggestion !== undefined || b.suggestions !== undefined || b.answers !== undefined)) {
      issue('behavior', 'suggestion and answers only apply to allow');
    }
    if (b.suggestion !== undefined && b.suggestions !== undefined) issue('suggestions', 'send suggestion or suggestions, not both');
    if (b.suggestions && new Set(b.suggestions).size !== b.suggestions.length) issue('suggestions', 'each suggestion once');
    if (b.mode === 'auto' && b.confirm !== true) issue('confirm', 'approving with auto mode needs confirm: true');
  });
export type DecisionBody = z.infer<typeof DecisionBodySchema>;
export const DecisionResponseSchema = z.object({ pending: PendingRequestSchema });

export const AccountsResponseSchema = z.object({
  accounts: z.array(AccountSchema),
  activeAccount: AccountIdSchema.nullable(),
  fetchedAt: IsoDateSchema.nullable(),
  source: z.enum(['cache', 'cli']).nullable(),
});

export const PlanResponseSchema = z.object({
  /** v0.1 only reads what ccw already computed; "none" when ccw is absent. */
  source: z.enum(['ccw-legacy', 'none']),
  /** The account ccw would move onto next, if any. */
  next: AccountIdSchema.nullable(),
  accounts: z.array(
    z.object({
      id: AccountIdSchema,
      burnPctPerMin: z.number(),
      fullInMin: z.number().optional(),
      ridesReset: z.boolean(),
      usable: z.boolean(),
    }),
  ),
  updatedAt: IsoDateSchema.nullable(),
  /**
   * The autoswitch ceiling in force, in % of a 5-hour window: ccw's
   * switch.json while ccw runs, else settings `autoswitch.ceiling`. Here so
   * read-scope devices (which cannot read settings) can draw the ceiling tick.
   */
  ceiling: z.number().min(1).max(100).optional(),
  /** The same for the weekly window (`weekly_ceiling`). */
  weeklyCeiling: z.number().min(1).max(100).optional(),
});

export const MovesResponseSchema = z.object({
  moves: z.array(MoveSchema),
  source: z.enum(['ccw-legacy', 'none']),
});

export const BurnResponseSchema = z.object({
  sessions: z.array(
    z.object({ sid: z.string(), pctPerMin: z.number(), updatedAt: IsoDateSchema }),
  ),
  source: z.enum(['ccw-legacy', 'none']),
});

export const AlertsQuerySchema = z.object({
  /** Only alerts from events with seq greater than this. */
  after: z.coerce.number().int().min(0).optional(),
  limit: limit(50, 200),
});
export const AlertsResponseSchema = z.object({
  alerts: z.array(AlertSchema),
  seq: z.number().int().nonnegative(),
});

export const UsageRefreshResponseSchema = z.object({
  queued: z.boolean(),
  reason: z.string().optional(),
  nextAllowedAt: IsoDateSchema.nullable(),
});

export const SettingsResponseSchema = z.object({ settings: SettingsSchema });

export const MuteBodySchema = z.object({
  /** 0 unmutes. */
  minutes: z.number().int().min(0).max(24 * 60),
});
export const MuteResponseSchema = z.object({ mutedUntil: IsoDateSchema.nullable() });

export const PairStartBodySchema = z.object({
  name: z.string().min(1).max(64).optional(),
  /** Defaults to read + control. Only ctl.sock or an admin device may ask for admin. */
  scopes: z.array(ScopeSchema).min(1).optional(),
});
export const PairStartResponseSchema = z.object({
  /** One-time code (128 bits, base64url). */
  code: z.string().min(16),
  /** `<base>/pair#c=<code>`: the code rides in the fragment so it is never logged. */
  url: z.string(),
  expiresAt: IsoDateSchema,
});

export const PairClaimBodySchema = z.object({
  code: z.string().min(16).max(128),
  name: z.string().min(1).max(64),
});
/** A device secret: 32 random bytes, base64url. */
export const DeviceSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const PairClaimResponseSchema = z.object({
  device: DevicePublicSchema,
  /**
   * Shown once, here. The web app keeps it in IndexedDB and sends it in
   * DEVICE_SECRET_HEADER on writes and as a subprotocol on the event stream.
   */
  deviceSecret: DeviceSecretSchema,
});

export const DevicesResponseSchema = z.object({ devices: z.array(DevicePublicSchema) });
export const DeviceResponseSchema = z.object({ device: DevicePublicSchema });

export const AuditQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: limit(100, 500),
});
export const AuditResponseSchema = z.object({ entries: z.array(AuditEntrySchema) });

export const PushSubscribeBodySchema = z.object({
  subscription: PushSubscriptionSchema,
  kinds: z.array(NotifyKindSchema).optional(),
});
export const PushUnsubscribeBodySchema = z.object({ endpoint: z.url() });
export const VapidKeyResponseSchema = z.object({ publicKey: z.string().min(1) });

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  protocol: z.number().int(),
  daemonVersion: z.string(),
});

export const EventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
});

// ---------------------------------------------------------------------------
// v0.3 payloads

/** "0" or "1" in a query string, as a boolean. */
const flag01 = z.enum(['0', '1']).transform((v) => v === '1');
/** A root id from FileRoot.id: "s.<sid>" or "r.<id>". */
const RootParamSchema = z.string().min(1).max(160);
/** A relative POSIX path under a root ('' = the root). The daemon's path policy does the real checks. */
const RelPathSchema = z.string().max(1024);

// --- Rewrite

export const RewriteStartBodySchema = z.strictObject({
  text: z
    .string()
    .min(1)
    .max(REWRITE_TEXT_MAX)
    .refine((t) => t.trim() !== '', { message: 'text is empty' }),
  /** This run only (the sheet's "Rewrite with Sonnet"); default settings.rewrite.model. */
  model: RewriteModelSchema.optional(),
});
export type RewriteStartBody = z.infer<typeof RewriteStartBodySchema>;
export const RewriteStartResponseSchema = z.object({ jobId: z.string(), job: RewriteJobSchema });
export const RewriteJobResponseSchema = z.object({ job: RewriteJobSchema });

// --- Files

export const FilesRootsResponseSchema = z.object({ roots: z.array(FileRootSchema) });
export const FilesListQuerySchema = z.object({
  root: RootParamSchema,
  path: RelPathSchema.default(''),
  /** The previous page's `next`. */
  after: z.string().max(1024).optional(),
  limit: limit(FILES_LIST_LIMIT, FILES_LIST_LIMIT),
  hidden: flag01.default(false),
});
export type FilesListQuery = z.infer<typeof FilesListQuerySchema>;
export const FilesPathQuerySchema = z.object({ root: RootParamSchema, path: RelPathSchema });
export type FilesPathQuery = z.infer<typeof FilesPathQuerySchema>;
export const FilesTextQuerySchema = z.object({
  root: RootParamSchema,
  path: RelPathSchema,
  offset: z.coerce.number().int().min(0).default(0),
  max: limit(FILES_TEXT_WINDOW, FILES_TEXT_WINDOW),
});
export type FilesTextQuery = z.infer<typeof FilesTextQuerySchema>;
export const FilesChangesQuerySchema = z.object({
  since: IsoDateSchema.optional(),
  limit: limit(100, FILES_CHANGES_LIMIT),
});
export type FilesChangesQuery = z.infer<typeof FilesChangesQuerySchema>;
export const FilesChangesResponseSchema = z.object({ changes: z.array(FileChangeSchema) });
export const SessionChangesResponseSchema = z.object({
  changes: z.array(FileChangeSchema),
  /** Backfill of the transcript: bytes read so far of `total`. */
  scan: z.object({ done: z.boolean(), bytes: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  truncated: z.boolean(),
});
export const ChangeParamsSchema = z.object({ sid: z.string().min(1).max(128), changeId: z.string().min(1).max(128) });
export const SessionChangeResponseSchema = z.object({ change: FileChangeSchema, ops: z.array(FileOpSchema) });

// --- Folders

export const FoldersListQuerySchema = z.object({
  root: RootParamSchema,
  path: RelPathSchema.default(''),
  after: z.string().max(1024).optional(),
  showHidden: flag01.default(false),
});
export type FoldersListQuery = z.infer<typeof FoldersListQuerySchema>;
export const FoldersListResponseSchema = z.object({
  root: z.string(),
  path: z.string(),
  display: z.string(),
  entries: z.array(FolderEntrySchema),
  next: z.string().nullable(),
  hiddenProtected: z.number().int().nonnegative(),
  truncated: z.boolean(),
  /**
   * Folders this listing holds over all its pages ("Showing 500 of 812").
   * With `truncated` it counts only the entries read, so it is a floor.
   * Absent from daemons before it existed.
   */
  total: z.number().int().nonnegative().optional(),
});
export const FolderRecentSchema = z.object({
  rootId: z.string(),
  path: z.string(),
  display: z.string(),
  lastUsed: IsoDateSchema,
  lastAccount: AccountIdSchema.optional(),
  name: z.string().optional(),
});
export const FoldersRecentResponseSchema = z.object({ recent: z.array(FolderRecentSchema).max(8) });
export const FolderPinBodySchema = z.strictObject({ root: RootParamSchema, path: RelPathSchema, pinned: z.boolean() });
export type FolderPinBody = z.infer<typeof FolderPinBodySchema>;
/** A new folder's name: no leading dot, no "/", no trailing space or dot. */
export const FolderNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,59}$/)
  .refine((n) => !/[ .]$/.test(n), { message: 'a folder name cannot end in a space or a dot' });
export const FolderCreateBodySchema = z.strictObject({ root: RootParamSchema, parent: RelPathSchema, name: FolderNameSchema });
export type FolderCreateBody = z.infer<typeof FolderCreateBodySchema>;
export const FolderCreateResponseSchema = z.object({ root: z.string(), path: z.string() });

// --- Launch

/** The account asked for: a number, or "auto" (most room, U3). Digits only: `?account=` is a 400, not account 0. */
const AccountChoiceSchema = z.union([z.literal('auto'), z.string().regex(/^\d{1,6}$/).transform(Number)]);

export const LaunchPreviewQuerySchema = z.object({
  root: RootParamSchema,
  path: RelPathSchema.default(''),
  account: AccountChoiceSchema.default('auto'),
  /** Any picks the sheet already changed; the rest come from this device's last start or launch.defaultFlags. */
  permission: LaunchPermissionSchema.optional(),
  chrome: flag01.optional(),
  effort: LaunchEffortSchema.optional(),
  model: LaunchModelSchema.optional(),
  /** The Name typed on the sheet: the command shows it in place of the suggested one. */
  name: LaunchNameSchema.optional(),
  /** v0.4: resume this past conversation of the folder (an id from GET /v1/launch/history). */
  resume: z.uuid().optional(),
});
export type LaunchPreviewQuery = z.infer<typeof LaunchPreviewQuerySchema>;

/** POST /v1/launches. Strict: unknown keys (args, extraArgs, profile, ...) are 400. */
export const LaunchStartBodySchema = z.strictObject({
  root: RootParamSchema,
  path: RelPathSchema,
  account: z.union([z.literal('auto'), AccountIdSchema]),
  flags: LaunchFlagsSchema,
  /** --name; default the folder's basename (plus -2, -3 when taken). */
  name: LaunchNameSchema.optional(),
  /** Sent with proof once the session is ready. */
  prompt: z.string().min(1).max(LAUNCH_PROMPT_MAX).optional(),
  /** Required to start on a held account. */
  confirmHeld: z.boolean().optional(),
  /**
   * v0.4: resume this past conversation (`--resume <id>`, no `--session-id`).
   * Per start, never remembered with the flags; the daemon refuses an id it
   * did not list in this folder's history, and a running one.
   */
  resume: z.uuid().optional(),
});
export type LaunchStartBody = z.infer<typeof LaunchStartBodySchema>;
/** GET /v1/launch/history: a folder's past conversations, newest first. */
export const LaunchHistoryQuerySchema = z.object({ root: RootParamSchema, path: RelPathSchema.default('') });
export type LaunchHistoryQuery = z.infer<typeof LaunchHistoryQuerySchema>;
export const LaunchHistoryResponseSchema = z.object({ sessions: z.array(PastSessionSchema).max(LAUNCH_HISTORY_LIMIT) });
export type LaunchHistoryResponse = z.infer<typeof LaunchHistoryResponseSchema>;
export const LaunchJobResponseSchema = z.object({ job: LaunchJobSchema });
export const LaunchGetResponseSchema = z.object({
  job: LaunchJobSchema,
  /** Last few screen lines, emails and tokens masked; failures and dialogs only. Never in events. */
  screenTail: z.string().optional(),
});
export const LaunchListQuerySchema = z.object({ active: flag01.default(false) });
export type LaunchListQuery = z.infer<typeof LaunchListQuerySchema>;
export const LaunchListResponseSchema = z.object({ jobs: z.array(LaunchJobSchema) });
/** Answer the startup dialog a launch waits on: the option index and the title the phone showed. */
export const LaunchAnswerBodySchema = z.strictObject({
  option: z.number().int().min(0).max(20),
  title: z.string().min(1).max(200),
});
export type LaunchAnswerBody = z.infer<typeof LaunchAnswerBodySchema>;

export const DeviceScopesBodySchema = z
  .strictObject({ add: z.array(ScopeSchema).max(4).optional(), remove: z.array(ScopeSchema).max(4).optional() })
  .refine((b) => (b.add?.length ?? 0) + (b.remove?.length ?? 0) > 0, { message: 'add or remove at least one scope' });
export type DeviceScopesBody = z.infer<typeof DeviceScopesBodySchema>;

// --- Controls

export const SessionKeyBodySchema = z.strictObject({ key: ControlKeySchema });
export type SessionKeyBody = z.infer<typeof SessionKeyBodySchema>;
/**
 * Modes in which Claude runs commands without asking: a switch to one needs
 * `confirm: true` (on the phone, the start sheet's sentence and a 2-second
 * hold), as /clear and /rewind do.
 */
export const CONFIRM_MODES: readonly PermissionModeName[] = ['bypassPermissions', 'auto'];
export const SessionModeBodySchema = z
  .strictObject({ mode: PermissionModeNameSchema, confirm: z.boolean().optional() })
  .superRefine((b, ctx) => {
    if (CONFIRM_MODES.includes(b.mode) && b.confirm !== true) ctx.addIssue({ code: 'custom', path: ['confirm'], message: `switching to ${b.mode} needs confirm: true` });
  });
export type SessionModeBody = z.infer<typeof SessionModeBodySchema>;
export const SessionModeResponseSchema = z.object({ mode: PermissionModeNameSchema, steps: z.number().int().nonnegative() });
export const SessionCommandResponseSchema = z.object({ proven: z.boolean() });
export const ScreenshotQuerySchema = z.object({
  /** Long edge in px; default settings.screenshots.maxEdge. */
  max: z.coerce.number().int().min(320).max(4000).optional(),
  format: z.enum(['png', 'jpeg']).optional(),
  /** 1: select a background tab, capture, restore (control scope and screenshots.allowSelect). */
  select: flag01.default(false),
  /** 1: native resolution, capped at SCREENSHOT_FULL_MAX_BYTES. */
  full: flag01.default(false),
});
export type ScreenshotQuery = z.infer<typeof ScreenshotQuerySchema>;

// ---------------------------------------------------------------------------
// v0.4.2 payloads: dialog answers, the keypad, uploads

/**
 * Text for a dialog's input row. One printable character can act as a key
 * in Claude's dialogs (`q`, `j`, `k`, `n`), and a leading `/`, `!`, `#` or
 * `@` may be read as a command, bash mode, a note or a mention: the run must
 * be 2 to 700 characters on one line, with none of those up front and no
 * `@` mention inside.
 */
export const DialogTextSchema = z
  .string()
  .trim()
  .min(DIALOG_TEXT_MIN)
  .max(DIALOG_TEXT_MAX)
  .refine((t) => !/[\u0000-\u001f\u007f-\u009f]/u.test(t), { message: 'one line, no control characters' })
  .refine((t) => !/^[/!#@]/u.test(t) && !/\s@/u.test(t), { message: 'no leading / ! # @ and no @ mention' });

/** POST /v1/sessions/:sid/dialog: answer the dialog the phone was shown. */
export const SessionDialogBodySchema = z.strictObject({
  /** TerminalDialog.fingerprint of the dialog the phone showed: nothing is typed unless the Mac still shows it. */
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  /** Index into TerminalDialog.options. */
  option: z.number().int().min(0).max(11),
  /** Only for a `text` row, and required there. */
  text: DialogTextSchema.optional(),
  /** Required for a row with `hold` (the phone's 2-second hold). */
  confirm: z.boolean().optional(),
});
export type SessionDialogBody = z.infer<typeof SessionDialogBodySchema>;
export const SessionDialogResponseSchema = z.object({
  /** done: the dialog closed or another one shows (two reads agree). unchanged: Jantar saw no change. */
  outcome: z.enum(['done', 'unchanged']),
  /** The screen after the answer: the next question, the new box states, or null when the dialog closed. */
  dialog: TerminalDialogSchema.nullable(),
});
export type SessionDialogResponse = z.infer<typeof SessionDialogResponseSchema>;

/**
 * POST /v1/sessions/:sid/keypad: arrows and one Return, in one write, on a
 * screen with no buttons. No text, ever. Up waits for DIALOG_GATES.up.
 */
export const SessionKeypadBodySchema = z
  .strictObject({
    /** ScreenResponse.screenKey of the screen the phone showed. */
    screen: z.string().regex(/^[0-9a-f]{64}$/),
    /** How many lines that screen read had (the `lines` it was asked for). */
    lines: z.number().int().min(KEYPAD_LINES).max(80),
    /** Rows to move before the Return: positive is down. */
    move: z.number().int().min(-20).max(20).default(0),
    key: z.enum(['enter', 'escape']).default('enter'),
  })
  .refine((b) => b.key === 'enter' || b.move === 0, { message: 'escape takes no moves', path: ['move'] })
  .refine((b) => b.move >= 0 || DIALOG_GATES.up, { message: 'moving up is not confirmed yet', path: ['move'] });
export type SessionKeypadBody = z.infer<typeof SessionKeypadBodySchema>;

/** POST /v1/sessions/:sid/uploads?ext=: the stored extension for text and office files (the bytes decide the rest). */
export const UploadQuerySchema = z.object({ ext: z.string().regex(/^[a-z0-9]{1,8}$/).optional() });
export type UploadQuery = z.infer<typeof UploadQuerySchema>;
/** An upload as the phone knows it: its id, what the bytes are and their size. Never a path. */
export const UploadInfoSchema = z.object({ id: UploadIdSchema, kind: UploadKindSchema, bytes: z.number().int().nonnegative() });
export type UploadInfo = z.infer<typeof UploadInfoSchema>;
export const UploadResponseSchema = z.object({ upload: UploadInfoSchema });
export type UploadResponse = z.infer<typeof UploadResponseSchema>;
export const UploadParamsSchema = z.object({ sid: z.string().min(1).max(128), id: UploadIdSchema });
export type UploadParams = z.infer<typeof UploadParamsSchema>;

// ---------------------------------------------------------------------------
// Route table

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * The switch a route sits behind (Mac only). v0.3: settings `<feature>.enabled`.
 * v0.4: 'life' is on while any Life module is; each module name reads
 * `life.<module>`; 'intel' reads `intel.enabled`. v0.5: 'meetings' reads
 * `meetings.enabled`.
 */
export type FeatureSwitch =
  | 'files'
  | 'launch'
  | 'rewrite'
  | 'controls'
  | 'screenshots'
  | 'life'
  | 'todos'
  | 'medicines'
  | 'food'
  | 'places'
  | 'finance'
  | 'intel'
  | 'meetings';

export interface RouteDef {
  method: HttpMethod | 'WS';
  /** Fastify-style path with `:params`. */
  path: string;
  /**
   * Scope a device needs. "public" routes need no cookie (/healthz and the
   * two pairing claims). v0.5: "extension" routes take no device at all,
   * only the paired Chrome extension's key (EXTENSION_KEY_HEADER), from
   * loopback, with its bound Origin (daemon api/app.ts gate).
   */
  scope: Scope | 'public' | 'extension';
  phase: 'v0.1' | 'v0.2' | 'v0.3' | 'v0.4' | 'v0.4.2' | 'v0.5';
  /**
   * While this switch is off the route answers 403 with the sentence that
   * turns it on (screenshots: 403 screenshots_off), before validation and
   * before its handler runs.
   */
  feature?: FeatureSwitch;
  /**
   * The handler answers with bytes, not JSON (an image, a PDF). It returns a
   * RawReply (daemon api/routes.ts) and the pipeline sends it as is; errors
   * are still JSON.
   */
  rawResponse?: boolean;
  /**
   * v0.4.2: the route takes raw bytes (`application/octet-stream`, exactly),
   * not JSON, up to `maxBytes`. The daemon gives it its own body parser and
   * runs the device, scope, Origin and secret checks, the Content-Length
   * check, the per-device byte budget and the in-flight cap before a byte of
   * the body is read. No `body` schema and no Idempotency-Key replay.
   */
  rawBody?: { maxBytes: number };
  /** Served on ctl.sock for the CLI. */
  ctl: boolean;
  /**
   * Only the Mac may call it (ctl.sock): over TCP an admin device is refused
   * too, with the sentence that names the CLI command (daemon api/app.ts
   * LOCAL_ONLY_REFUSED). Implies `ctl: true`.
   */
  localOnly?: boolean;
  /** Success status code (default 200). */
  status?: number;
  /**
   * v0.5: this route's body limit in bytes, instead of MAX_BODY_BYTES
   * (passed to the route; its 413 names it). Only the extension's screenshot
   * upload sets one. Never with `rawBody` (whose `maxBytes` the daemon
   * would take instead), and no `extension` route takes raw bytes (its gate
   * would run twice): v0.5.1, pinned in test/v05-routes.test.ts.
   */
  bodyLimit?: number;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  response?: z.ZodType;
  summary: string;
}

function route<T extends RouteDef>(r: T): T {
  return r;
}

export const ROUTES = {
  health: route({
    method: 'GET', path: '/healthz', scope: 'public', phase: 'v0.1', ctl: true,
    response: HealthResponseSchema, summary: 'Liveness check (outside /v1, no data).',
  }),
  getState: route({
    method: 'GET', path: '/v1/state', scope: 'read', phase: 'v0.1', ctl: true,
    response: StateResponseSchema, summary: 'Full snapshot plus seq (polling fallback for the WebSocket).',
  }),
  listSessions: route({
    method: 'GET', path: '/v1/sessions', scope: 'read', phase: 'v0.1', ctl: true,
    response: SessionsResponseSchema, summary: 'All live sessions.',
  }),
  getSession: route({
    method: 'GET', path: '/v1/sessions/:sid', scope: 'read', phase: 'v0.1', ctl: true,
    params: SidParamsSchema, response: SessionResponseSchema, summary: 'One session with its cards and pane.',
  }),
  getTranscript: route({
    method: 'GET', path: '/v1/sessions/:sid/transcript', scope: 'read', phase: 'v0.1', ctl: true,
    params: SidParamsSchema, query: TranscriptQuerySchema, response: TranscriptResponseSchema,
    summary: 'Transcript page, newest first (text only in v0.1).',
  }),
  getScreen: route({
    method: 'GET', path: '/v1/sessions/:sid/screen', scope: 'read', phase: 'v0.1', ctl: true,
    params: SidParamsSchema, query: ScreenQuerySchema, response: ScreenResponseSchema,
    summary: 'The last N lines of the terminal tab (bounded read).',
  }),
  sendPrompt: route({
    method: 'POST', path: '/v1/sessions/:sid/prompt', scope: 'control', phase: 'v0.1', ctl: true, status: 202,
    params: SidParamsSchema, body: PromptBodySchema, response: PromptAcceptedSchema,
    summary: 'Queue a prompt; progress arrives as send.progress until proven by the transcript.',
  }),
  getSend: route({
    method: 'GET', path: '/v1/sends/:jobId', scope: 'read', phase: 'v0.1', ctl: true,
    params: JobParamsSchema, response: SendJobResponseSchema,
    summary: 'One send job (lets the CLI poll a send).',
  }),
  focusSession: route({
    method: 'POST', path: '/v1/sessions/:sid/focus', scope: 'control', phase: 'v0.1', ctl: true,
    params: SidParamsSchema, response: OkSchema, summary: "Bring the session's tab to the front on the Mac.",
  }),
  listPending: route({
    method: 'GET', path: '/v1/pending', scope: 'read', phase: 'v0.1', ctl: true,
    response: PendingListResponseSchema, summary: 'Open approval / question / plan cards.',
  }),
  decidePending: route({
    method: 'POST', path: '/v1/pending/:id/decision', scope: 'control', phase: 'v0.1', ctl: false,
    params: IdParamsSchema, body: DecisionBodySchema, response: DecisionResponseSchema,
    summary: 'Answer a card. Never served on ctl.sock.',
  }),
  listAccounts: route({
    method: 'GET', path: '/v1/accounts', scope: 'read', phase: 'v0.1', ctl: true,
    response: AccountsResponseSchema, summary: 'cswap accounts with usage windows.',
  }),
  getPlan: route({
    method: 'GET', path: '/v1/plan', scope: 'read', phase: 'v0.1', ctl: true,
    response: PlanResponseSchema, summary: 'Read-only "next" and "full in" (from ccw while it runs).',
  }),
  listMoves: route({
    method: 'GET', path: '/v1/moves', scope: 'read', phase: 'v0.1', ctl: true,
    response: MovesResponseSchema, summary: 'Moves in progress, parked or stuck.',
  }),
  getBurn: route({
    method: 'GET', path: '/v1/burn', scope: 'read', phase: 'v0.1', ctl: true,
    response: BurnResponseSchema, summary: 'Per-session burn rates (from ccw while it runs).',
  }),
  listAlerts: route({
    method: 'GET', path: '/v1/alerts', scope: 'read', phase: 'v0.1', ctl: true,
    query: AlertsQuerySchema, response: AlertsResponseSchema, summary: 'Alerts feed.',
  }),
  refreshUsage: route({
    method: 'POST', path: '/v1/usage/refresh', scope: 'control', phase: 'v0.1', ctl: true, status: 202,
    response: UsageRefreshResponseSchema, summary: 'Ask the single cswap poller for a refresh (debounced).',
  }),
  getSettings: route({
    method: 'GET', path: '/v1/settings', scope: 'admin', phase: 'v0.1', ctl: true,
    response: SettingsResponseSchema, summary: 'Current settings.',
  }),
  patchSettings: route({
    method: 'PATCH', path: '/v1/settings', scope: 'admin', phase: 'v0.1', ctl: true,
    body: SettingsPatchSchema, response: SettingsResponseSchema,
    summary: 'Deep-merge a settings patch (see applySettingsPatch).',
  }),
  muteNotify: route({
    method: 'POST', path: '/v1/notify/mute', scope: 'control', phase: 'v0.1', ctl: true,
    body: MuteBodySchema, response: MuteResponseSchema, summary: 'Mute pushes for N minutes (0 unmutes).',
  }),
  pairStart: route({
    method: 'POST', path: '/v1/pair/start', scope: 'admin', phase: 'v0.1', ctl: true,
    body: PairStartBodySchema, response: PairStartResponseSchema, summary: 'Create a one-time pairing code.',
  }),
  pairClaim: route({
    method: 'POST', path: '/v1/pair/claim', scope: 'public', phase: 'v0.1', ctl: false,
    body: PairClaimBodySchema, response: PairClaimResponseSchema,
    summary: 'Trade a pairing code for a device cookie and a device secret (rate limited per caller).',
  }),
  listDevices: route({
    method: 'GET', path: '/v1/devices', scope: 'admin', phase: 'v0.1', ctl: true,
    response: DevicesResponseSchema, summary: 'Paired devices.',
  }),
  revokeDevice: route({
    method: 'DELETE', path: '/v1/devices/:id', scope: 'admin', phase: 'v0.1', ctl: true,
    params: IdParamsSchema, response: DeviceResponseSchema, summary: 'Revoke a device.',
  }),
  listAudit: route({
    method: 'GET', path: '/v1/audit', scope: 'admin', phase: 'v0.1', ctl: true,
    query: AuditQuerySchema, response: AuditResponseSchema, summary: 'Audit log of every write.',
  }),
  pushSubscribe: route({
    method: 'POST', path: '/v1/push/subscribe', scope: 'read', phase: 'v0.1', ctl: false,
    body: PushSubscribeBodySchema, response: OkSchema, summary: 'Register this device for Web Push.',
  }),
  pushUnsubscribe: route({
    method: 'DELETE', path: '/v1/push/subscribe', scope: 'read', phase: 'v0.1', ctl: false,
    body: PushUnsubscribeBodySchema, response: OkSchema, summary: 'Remove a Web Push subscription.',
  }),
  vapidKey: route({
    method: 'GET', path: '/v1/push/vapid-public-key', scope: 'read', phase: 'v0.1', ctl: false,
    response: VapidKeyResponseSchema,
    summary: 'VAPID public key for PushManager.subscribe.',
  }),
  events: route({
    method: 'WS', path: '/v1/events', scope: 'read', phase: 'v0.1', ctl: true,
    query: EventsQuerySchema, summary: 'Event stream: hello, then snapshot or replay, then live events.',
  }),

  // --- v0.3 Rewrite (decisions U5, U6): the prompt text never leaves GET /v1/rewrite/:jobId.
  // Like the spec's voice routes: started and cancelled from a device only, readable on ctl.sock.
  rewriteStart: route({
    method: 'POST', path: '/v1/sessions/:sid/rewrite', scope: 'control', phase: 'v0.3', ctl: false, status: 202, feature: 'rewrite',
    params: SidParamsSchema, body: RewriteStartBodySchema, response: RewriteStartResponseSchema,
    summary: 'Turn typed or dictated text into a prompt with a headless Claude run; progress arrives as rewrite.progress.',
  }),
  rewriteGet: route({
    method: 'GET', path: '/v1/rewrite/:jobId', scope: 'control', phase: 'v0.3', ctl: true, feature: 'rewrite',
    params: JobParamsSchema, response: RewriteDetailSchema,
    summary: 'A rewrite job with its texts. Owner only; anyone else gets 404.',
  }),
  rewriteCancel: route({
    method: 'DELETE', path: '/v1/rewrite/:jobId', scope: 'control', phase: 'v0.3', ctl: false, feature: 'rewrite',
    params: JobParamsSchema, response: RewriteJobResponseSchema, summary: 'Cancel a rewrite job and drop its texts. Owner only.',
  }),

  // --- v0.3 Files (U9: which files sessions changed, opened at their current content; no git, no diffs)
  filesRoots: route({
    method: 'GET', path: '/v1/files/roots', scope: 'control', phase: 'v0.3', ctl: false, feature: 'files',
    response: FilesRootsResponseSchema, summary: 'Roots the phone may browse: configured roots plus live session folders.',
  }),
  filesList: route({
    method: 'GET', path: '/v1/files/list', scope: 'control', phase: 'v0.3', ctl: false, feature: 'files',
    query: FilesListQuerySchema, response: FileListingSchema, summary: 'One page of a directory (protected entries hidden and counted).',
  }),
  filesStat: route({
    method: 'GET', path: '/v1/files/stat', scope: 'control', phase: 'v0.3', ctl: false, feature: 'files',
    query: FilesPathQuerySchema, response: FileStatSchema, summary: "A file's size, time and kind.",
  }),
  filesText: route({
    method: 'GET', path: '/v1/files/text', scope: 'control', phase: 'v0.3', ctl: false, feature: 'files',
    query: FilesTextQuerySchema, response: FileTextSchema, summary: 'One window of a text file, as JSON.',
  }),
  filesRaw: route({
    method: 'GET', path: '/v1/files/raw', scope: 'control', phase: 'v0.3', ctl: false, feature: 'files', rawResponse: true,
    query: FilesPathQuerySchema, summary: 'Bytes of a raster image or a PDF only, with a sandbox CSP (415 for anything else).',
  }),
  filesChanges: route({
    method: 'GET', path: '/v1/files/changes', scope: 'control', phase: 'v0.3', ctl: false, feature: 'files',
    query: FilesChangesQuerySchema, response: FilesChangesResponseSchema,
    summary: 'Files changed across live sessions, newest first.',
  }),
  sessionChanges: route({
    method: 'GET', path: '/v1/sessions/:sid/changes', scope: 'control', phase: 'v0.3', ctl: false, feature: 'files',
    params: SidParamsSchema, response: SessionChangesResponseSchema, summary: 'Files this session created or changed (from its transcript).',
  }),
  sessionChange: route({
    method: 'GET', path: '/v1/sessions/:sid/changes/:changeId', scope: 'control', phase: 'v0.3', ctl: false, feature: 'files',
    params: ChangeParamsSchema, response: SessionChangeResponseSchema, summary: 'One changed file with each op on it.',
  }),

  // --- v0.3 Folders and new sessions (U7: allowlisted flags, no free-text argv)
  foldersRoots: route({
    method: 'GET', path: '/v1/folders/roots', scope: 'control', phase: 'v0.3', ctl: true, feature: 'launch',
    response: FilesRootsResponseSchema, summary: 'The same roots as Files, for the new-session browser.',
  }),
  foldersList: route({
    method: 'GET', path: '/v1/folders', scope: 'control', phase: 'v0.3', ctl: true, feature: 'launch',
    query: FoldersListQuerySchema, response: FoldersListResponseSchema, summary: 'Folders (dirs only) under a root, pinned and live first.',
  }),
  foldersRecent: route({
    method: 'GET', path: '/v1/folders/recent', scope: 'control', phase: 'v0.3', ctl: true, feature: 'launch',
    response: FoldersRecentResponseSchema, summary: 'Folders sessions ran in lately (at most 8).',
  }),
  foldersPin: route({
    method: 'PUT', path: '/v1/folders/pins', scope: 'control', phase: 'v0.3', ctl: false, feature: 'launch',
    body: FolderPinBodySchema, response: OkSchema, summary: 'Pin or unpin a folder in the browser.',
  }),
  foldersCreate: route({
    method: 'POST', path: '/v1/folders', scope: 'launch', phase: 'v0.3', ctl: true, status: 201, feature: 'launch',
    body: FolderCreateBodySchema, response: FolderCreateResponseSchema, summary: 'Create one folder (not recursive; 409 if it exists).',
  }),
  launchPreview: route({
    method: 'GET', path: '/v1/launch/preview', scope: 'control', phase: 'v0.3', ctl: true, feature: 'launch',
    query: LaunchPreviewQuerySchema, response: LaunchPreviewSchema, summary: 'What the start sheet shows: account pick, flags and the command line.',
  }),
  launchStart: route({
    method: 'POST', path: '/v1/launches', scope: 'launch', phase: 'v0.3', ctl: true, status: 202, feature: 'launch',
    body: LaunchStartBodySchema, response: LaunchJobResponseSchema,
    summary: 'Start a session in a new Terminal window (Idempotency-Key required); progress arrives as launch.progress.',
  }),
  launchGet: route({
    method: 'GET', path: '/v1/launches/:id', scope: 'read', phase: 'v0.3', ctl: true, feature: 'launch',
    params: IdParamsSchema, response: LaunchGetResponseSchema, summary: 'One launch, with the masked screen tail on failures and dialogs.',
  }),
  launchList: route({
    method: 'GET', path: '/v1/launches', scope: 'read', phase: 'v0.3', ctl: true, feature: 'launch',
    query: LaunchListQuerySchema, response: LaunchListResponseSchema, summary: 'Recent launches (?active=1: unfinished only).',
  }),
  launchAnswer: route({
    method: 'POST', path: '/v1/launches/:id/answer', scope: 'launch', phase: 'v0.3', ctl: false, feature: 'launch',
    params: IdParamsSchema, body: LaunchAnswerBodySchema, response: LaunchJobResponseSchema,
    summary: 'Answer the startup dialog a launch waits on. Never served on ctl.sock.',
  }),
  deviceScopes: route({
    method: 'POST', path: '/v1/devices/:id/scopes', scope: 'admin', phase: 'v0.3', ctl: true, localOnly: true,
    params: IdParamsSchema, body: DeviceScopesBodySchema, response: DeviceResponseSchema,
    summary: "Add or remove a device's scopes (jantar devices grant <device> launch).",
  }),

  // --- v0.3 Controls (addendum): never on ctl.sock, so a session cannot press keys into itself
  sessionKey: route({
    method: 'POST', path: '/v1/sessions/:sid/keys', scope: 'control', phase: 'v0.3', ctl: false, feature: 'controls',
    params: SidParamsSchema, body: SessionKeyBodySchema, response: OkSchema, summary: 'Press one whitelisted key in the session (gated, audited).',
  }),
  sessionMode: route({
    method: 'POST', path: '/v1/sessions/:sid/mode', scope: 'control', phase: 'v0.3', ctl: false, feature: 'controls',
    params: SidParamsSchema, body: SessionModeBodySchema, response: SessionModeResponseSchema,
    summary: 'Step the permission mode with Shift+Tab until it reads the target (409 mode_unavailable).',
  }),
  sessionCommand: route({
    method: 'POST', path: '/v1/sessions/:sid/command', scope: 'control', phase: 'v0.3', ctl: false, feature: 'controls',
    params: SidParamsSchema, body: SessionCommandBodySchema, response: SessionCommandResponseSchema,
    summary: 'Send an allowlisted slash command through the writer, with proof (clear and rewind need confirm).',
  }),
  sessionScreenshot: route({
    method: 'GET', path: '/v1/sessions/:sid/screenshot', scope: 'read', phase: 'v0.3', ctl: false, feature: 'screenshots', rawResponse: true,
    params: SidParamsSchema, query: ScreenshotQuerySchema,
    summary: "Image of the session's Terminal window (select=1 needs control scope and screenshots.allowSelect).",
  }),

  // --- v0.4 Life. Every route needs control, reads included: a read-only device never sees health,
  // money or food. Only lifeStatus is on ctl.sock among the module routes; backup and restore are
  // ctl.sock only (localOnly). Writes answer ids only.
  lifeStatus: route({
    method: 'GET', path: '/v1/life/status', scope: 'control', phase: 'v0.4', ctl: true,
    response: LifeStatusSchema, summary: 'Which Life modules are on, the zone and currency, backups, and who would get a medicine ping.',
  }),
  lifeToday: route({
    method: 'GET', path: '/v1/life/today', scope: 'control', phase: 'v0.4', ctl: false, feature: 'life',
    query: DayQuerySchema, response: TodaySchema, summary: "One day across the modules that are on: doses, due todos, calories, bills.",
  }),
  lifeBackup: route({
    method: 'POST', path: '/v1/life/backup', scope: 'control', phase: 'v0.4', ctl: true, localOnly: true,
    response: LifeBackupResponseSchema, summary: 'Back life.db up now into <state dir>/backups (jantar life backup).',
  }),
  lifeRestore: route({
    method: 'POST', path: '/v1/life/restore', scope: 'control', phase: 'v0.4', ctl: true, localOnly: true,
    body: LifeRestoreBodySchema, response: LifeRestoreResponseSchema,
    summary: 'Put a backup back as life.db, keeping the current file beside it (jantar life restore <file>).',
  }),

  projectsList: route({
    method: 'GET', path: '/v1/projects', scope: 'control', phase: 'v0.4', ctl: false, feature: 'todos',
    response: ProjectsResponseSchema, summary: 'Projects with their open and overdue todo counts.',
  }),
  projectCreate: route({
    method: 'POST', path: '/v1/projects', scope: 'control', phase: 'v0.4', ctl: false, feature: 'todos',
    body: ProjectBodySchema, response: IdReplySchema, summary: 'Add a project.',
  }),
  projectUpdate: route({
    method: 'PATCH', path: '/v1/projects/:id', scope: 'control', phase: 'v0.4', ctl: false, feature: 'todos',
    params: LifeIdParamsSchema, body: ProjectPatchSchema, response: OkReplySchema, summary: 'Change a project (null clears a field).',
  }),
  projectDelete: route({
    method: 'DELETE', path: '/v1/projects/:id', scope: 'control', phase: 'v0.4', ctl: false, feature: 'todos',
    params: LifeIdParamsSchema, response: OkReplySchema, summary: 'Delete a project; its todos move to no project.',
  }),
  todosList: route({
    method: 'GET', path: '/v1/todos', scope: 'control', phase: 'v0.4', ctl: false, feature: 'todos',
    query: TodosQuerySchema, response: TodosResponseSchema, summary: 'Open todos by due, or the newest done ones (?done=1).',
  }),
  todoCreate: route({
    method: 'POST', path: '/v1/todos', scope: 'control', phase: 'v0.4', ctl: false, feature: 'todos',
    body: TodoBodySchema, response: IdReplySchema, summary: 'Add a todo (a due time makes it a reminder).',
  }),
  todoUpdate: route({
    method: 'PATCH', path: '/v1/todos/:id', scope: 'control', phase: 'v0.4', ctl: false, feature: 'todos',
    params: LifeIdParamsSchema, body: TodoPatchSchema, response: OkReplySchema, summary: 'Change a todo (null clears a field).',
  }),
  todoDone: route({
    method: 'POST', path: '/v1/todos/:id/done', scope: 'control', phase: 'v0.4', ctl: false, feature: 'todos',
    params: LifeIdParamsSchema, body: TodoDoneBodySchema, response: OkReplySchema,
    summary: 'Done or Undo; Done on a repeating todo moves its due day on.',
  }),
  todoSnooze: route({
    method: 'POST', path: '/v1/todos/:id/snooze', scope: 'control', phase: 'v0.4', ctl: false, feature: 'todos',
    params: LifeIdParamsSchema, body: SnoozeBodySchema, response: OkReplySchema, summary: "Move a todo's due day and time by a preset.",
  }),
  todoDelete: route({
    method: 'DELETE', path: '/v1/todos/:id', scope: 'control', phase: 'v0.4', ctl: false, feature: 'todos',
    params: LifeIdParamsSchema, response: OkReplySchema, summary: 'Delete a todo.',
  }),

  medsGet: route({
    method: 'GET', path: '/v1/medicines', scope: 'control', phase: 'v0.4', ctl: false, feature: 'medicines',
    query: DayQuerySchema, response: MedicinesResponseSchema, summary: "A day's dose checklist (today or before) and every medicine.",
  }),
  medCreate: route({
    method: 'POST', path: '/v1/medicines', scope: 'control', phase: 'v0.4', ctl: false, feature: 'medicines',
    body: MedicineBodySchema, response: IdReplySchema, summary: 'Add a medicine.',
  }),
  medUpdate: route({
    method: 'PATCH', path: '/v1/medicines/:id', scope: 'control', phase: 'v0.4', ctl: false, feature: 'medicines',
    params: LifeIdParamsSchema, body: MedicinePatchSchema, response: OkReplySchema,
    summary: 'Change a medicine; a schedule change applies from today, a new pill count is a refill.',
  }),
  medStop: route({
    method: 'POST', path: '/v1/medicines/:id/stop', scope: 'control', phase: 'v0.4', ctl: false, feature: 'medicines',
    params: LifeIdParamsSchema, response: OkReplySchema, summary: 'Stop taking a medicine today; its pings end.',
  }),
  medDelete: route({
    method: 'DELETE', path: '/v1/medicines/:id', scope: 'control', phase: 'v0.4', ctl: false, feature: 'medicines',
    params: LifeIdParamsSchema, response: OkReplySchema, summary: 'Delete a medicine and its dose history.',
  }),
  doseLog: route({
    method: 'POST', path: '/v1/medicines/:id/doses', scope: 'control', phase: 'v0.4', ctl: false, feature: 'medicines',
    params: LifeIdParamsSchema, body: DoseBodySchema, response: IdReplySchema,
    summary: 'Taken, Skip or Took it at… for one dose time of one day (one row per time).',
  }),
  doseUndo: route({
    method: 'DELETE', path: '/v1/medicines/:id/doses/:doseId', scope: 'control', phase: 'v0.4', ctl: false, feature: 'medicines',
    params: DoseParamsSchema, response: OkReplySchema, summary: 'Undo a logged dose (a taken one gives its pills back).',
  }),

  foodDay: route({
    method: 'GET', path: '/v1/food', scope: 'control', phase: 'v0.4', ctl: false, feature: 'food',
    query: DayQuerySchema, response: FoodDaySchema, summary: "A day's food and calories against the target, saved foods and weight.",
  }),
  foodAdd: route({
    method: 'POST', path: '/v1/food', scope: 'control', phase: 'v0.4', ctl: false, feature: 'food',
    body: FoodBodySchema, response: IdReplySchema, summary: 'Log a food (or a saved one by id).',
  }),
  foodUpdate: route({
    method: 'PATCH', path: '/v1/food/:id', scope: 'control', phase: 'v0.4', ctl: false, feature: 'food',
    params: LifeIdParamsSchema, body: FoodPatchSchema, response: OkReplySchema, summary: 'Change a logged food.',
  }),
  foodDelete: route({
    method: 'DELETE', path: '/v1/food/:id', scope: 'control', phase: 'v0.4', ctl: false, feature: 'food',
    params: LifeIdParamsSchema, response: OkReplySchema, summary: 'Delete a logged food.',
  }),
  foodSavedDelete: route({
    method: 'DELETE', path: '/v1/food/saved/:id', scope: 'control', phase: 'v0.4', ctl: false, feature: 'food',
    params: LifeIdParamsSchema, response: OkReplySchema, summary: 'Forget a saved food.',
  }),
  foodTargets: route({
    method: 'PUT', path: '/v1/food/targets', scope: 'control', phase: 'v0.4', ctl: false, feature: 'food',
    body: FoodTargetsBodySchema, response: OkReplySchema, summary: 'Set the daily calorie target and the goal weight.',
  }),
  foodEstimate: route({
    method: 'POST', path: '/v1/food/estimate', scope: 'control', phase: 'v0.4', ctl: false, feature: 'food',
    body: FoodEstimateBodySchema, response: FoodEstimateSchema,
    summary: 'Ask Claude for the calories in a meal; nothing is saved (sent with no Idempotency-Key).',
  }),
  weightSet: route({
    method: 'PUT', path: '/v1/weights/:day', scope: 'control', phase: 'v0.4', ctl: false, feature: 'food',
    params: DayParamsSchema, body: WeightBodySchema, response: OkReplySchema, summary: "Log a day's weight (today or before; replaces that day's).",
  }),
  weightDelete: route({
    method: 'DELETE', path: '/v1/weights/:day', scope: 'control', phase: 'v0.4', ctl: false, feature: 'food',
    params: DayParamsSchema, response: OkReplySchema, summary: "Delete a day's weight.",
  }),

  placesList: route({
    method: 'GET', path: '/v1/places', scope: 'control', phase: 'v0.4', ctl: false, feature: 'places',
    query: PlacesQuerySchema, response: PlacesResponseSchema, summary: 'Cafés, best rated first (?filter=tried|want).',
  }),
  placeCreate: route({
    method: 'POST', path: '/v1/places', scope: 'control', phase: 'v0.4', ctl: false, feature: 'places',
    body: PlaceBodySchema, response: IdReplySchema, summary: 'Add a café with its dishes.',
  }),
  placeUpdate: route({
    method: 'PATCH', path: '/v1/places/:id', scope: 'control', phase: 'v0.4', ctl: false, feature: 'places',
    params: LifeIdParamsSchema, body: PlacePatchSchema, response: OkReplySchema, summary: 'Change a café (dishes replace wholesale).',
  }),
  placeDelete: route({
    method: 'DELETE', path: '/v1/places/:id', scope: 'control', phase: 'v0.4', ctl: false, feature: 'places',
    params: LifeIdParamsSchema, response: OkReplySchema, summary: 'Delete a café.',
  }),

  moneyMonth: route({
    method: 'GET', path: '/v1/money', scope: 'control', phase: 'v0.4', ctl: false, feature: 'finance',
    query: MoneyQuerySchema, response: MoneyMonthSchema, summary: "A month's entries, totals by category with budgets, and every bill.",
  }),
  moneyAdd: route({
    method: 'POST', path: '/v1/money', scope: 'control', phase: 'v0.4', ctl: false, feature: 'finance',
    body: MoneyBodySchema, response: IdReplySchema, summary: 'Log an expense or income.',
  }),
  moneyUpdate: route({
    method: 'PATCH', path: '/v1/money/:id', scope: 'control', phase: 'v0.4', ctl: false, feature: 'finance',
    params: LifeIdParamsSchema, body: MoneyPatchSchema, response: OkReplySchema, summary: 'Change an entry.',
  }),
  moneyDelete: route({
    method: 'DELETE', path: '/v1/money/:id', scope: 'control', phase: 'v0.4', ctl: false, feature: 'finance',
    params: LifeIdParamsSchema, response: OkReplySchema, summary: 'Delete an entry.',
  }),
  budgetSet: route({
    method: 'PUT', path: '/v1/money/budgets', scope: 'control', phase: 'v0.4', ctl: false, feature: 'finance',
    body: BudgetBodySchema, response: OkReplySchema, summary: "Set or remove a category's monthly budget.",
  }),
  billCreate: route({
    method: 'POST', path: '/v1/bills', scope: 'control', phase: 'v0.4', ctl: false, feature: 'finance',
    body: BillBodySchema, response: IdReplySchema, summary: 'Add a monthly or yearly bill.',
  }),
  billUpdate: route({
    method: 'PATCH', path: '/v1/bills/:id', scope: 'control', phase: 'v0.4', ctl: false, feature: 'finance',
    params: LifeIdParamsSchema, body: BillPatchSchema, response: OkReplySchema, summary: 'Change a bill.',
  }),
  billPaid: route({
    method: 'POST', path: '/v1/bills/:id/paid', scope: 'control', phase: 'v0.4', ctl: false, feature: 'finance',
    params: LifeIdParamsSchema, body: BillPaidBodySchema, response: IdReplySchema,
    summary: "Mark a bill paid: log the expense (its id is the reply) and move the due day a month or a year on.",
  }),
  billDelete: route({
    method: 'DELETE', path: '/v1/bills/:id', scope: 'control', phase: 'v0.4', ctl: false, feature: 'finance',
    params: LifeIdParamsSchema, response: OkReplySchema, summary: 'Delete a bill.',
  }),

  // --- v0.4 Intel shelf: on ctl.sock too, so a bot or a session can add a capture with `jantar intel`.
  intelList: route({
    method: 'GET', path: '/v1/intel', scope: 'control', phase: 'v0.4', ctl: true, feature: 'intel',
    query: IntelListQuerySchema, response: IntelListResponseSchema, summary: 'Shelf items, newest first, with search and type and tag filters.',
  }),
  intelGet: route({
    method: 'GET', path: '/v1/intel/items/:id', scope: 'control', phase: 'v0.4', ctl: true, feature: 'intel',
    params: IntelParamsSchema, response: IntelItemResponseSchema, summary: 'One shelf item with every field.',
  }),
  intelCapture: route({
    method: 'POST', path: '/v1/intel/captures', scope: 'control', phase: 'v0.4', ctl: true, feature: 'intel',
    body: IntelCaptureBodySchema, response: IntelCaptureReplySchema, summary: 'Add an item to the shelf (a duplicate url writes nothing).',
  }),
  intelSources: route({
    method: 'GET', path: '/v1/intel/sources', scope: 'control', phase: 'v0.4', ctl: true, feature: 'intel',
    response: IntelSourcesResponseSchema, summary: 'The shelf\'s sources with counts and errors (never a path).',
  }),

  // --- v0.4 Resume: a folder's past conversations, for the start sheet.
  launchHistory: route({
    method: 'GET', path: '/v1/launch/history', scope: 'control', phase: 'v0.4', ctl: true, feature: 'launch',
    query: LaunchHistoryQuerySchema, response: LaunchHistoryResponseSchema, summary: "A folder's past conversations, newest first, to resume.",
  }),

  // --- v0.4.2 The screen path and attachments. Never on ctl.sock: a session must not answer its own
  // dialogs, and uploads exist only to be sent from the phone. Dialog answers and the keypad sit behind
  // the Controls switch.
  sessionDialog: route({
    method: 'POST', path: '/v1/sessions/:sid/dialog', scope: 'control', phase: 'v0.4.2', ctl: false, feature: 'controls',
    params: SidParamsSchema, body: SessionDialogBodySchema, response: SessionDialogResponseSchema,
    summary: 'Answer the dialog Claude shows in the terminal, typed only while the Mac still shows exactly that dialog.',
  }),
  sessionKeypad: route({
    method: 'POST', path: '/v1/sessions/:sid/keypad', scope: 'control', phase: 'v0.4.2', ctl: false, feature: 'controls',
    params: SidParamsSchema, body: SessionKeypadBodySchema, response: OkSchema,
    summary: 'Move and press Return on a screen with no buttons, only while the Mac still shows the lines the phone saw.',
  }),
  uploadCreate: route({
    method: 'POST', path: '/v1/sessions/:sid/uploads', scope: 'control', phase: 'v0.4.2', ctl: false, status: 201,
    rawBody: { maxBytes: UPLOAD_MAX_BYTES },
    params: SidParamsSchema, query: UploadQuerySchema, response: UploadResponseSchema,
    summary: 'Store one file from the phone (raw bytes) for a prompt of this session; the reply is its id, never a path.',
  }),
  uploadDelete: route({
    method: 'DELETE', path: '/v1/sessions/:sid/uploads/:id', scope: 'control', phase: 'v0.4.2', ctl: false,
    params: UploadParamsSchema, response: OkSchema, summary: 'Remove an upload of this session from the Mac (404 when it is gone).',
  }),

  // --- v0.5 Meetings: pairing the Chrome extension (on the Mac, then a claim from the extension itself).
  extPairStart: route({
    method: 'POST', path: '/v1/ext/pair/start', scope: 'admin', phase: 'v0.5', ctl: true, localOnly: true,
    response: ExtPairStartReplySchema, summary: 'A one-time code for the Chrome extension (the Mac only: jantar pair --extension).',
  }),
  extPairClaim: route({
    method: 'POST', path: '/v1/ext/pair', scope: 'public', phase: 'v0.5', ctl: false,
    body: ExtPairClaimBodySchema, response: ExtPairClaimReplySchema,
    summary: 'Trade a code for the extension key (only from the published extension ID, from loopback; the key is sent once).',
  }),
  extUnpair: route({
    method: 'POST', path: '/v1/ext/unpair', scope: 'admin', phase: 'v0.5', ctl: true, localOnly: true,
    response: ExtUnpairReplySchema, summary: 'Revoke every paired extension (the Mac only).',
  }),

  // --- v0.5 Meetings: the extension's capture routes (its key, loopback, its bound Origin).
  extInfo: route({
    method: 'GET', path: '/v1/ext/info', scope: 'extension', phase: 'v0.5', ctl: false, feature: 'meetings',
    response: ExtInfoSchema, summary: "The assign sheet's projects (id, name, emoji), or null while Todos are off.",
  }),
  extMeetingOpen: route({
    method: 'POST', path: '/v1/ext/meetings/:clientId', scope: 'extension', phase: 'v0.5', ctl: false, feature: 'meetings',
    params: ClientIdParamsSchema, body: ExtOpenBodySchema, response: IdReplySchema,
    summary: "Open (or update) this tab's meeting: Start, or a screenshot before Start.",
  }),
  extMeetingLines: route({
    method: 'POST', path: '/v1/ext/meetings/:clientId/lines', scope: 'extension', phase: 'v0.5', ctl: false, feature: 'meetings',
    params: ClientIdParamsSchema, body: ExtLinesBodySchema, response: OkReplySchema,
    summary: 'Caption lines, highest revision kept per line (an empty list is the keep-alive).',
  }),
  extMeetingShot: route({
    method: 'POST', path: '/v1/ext/meetings/:clientId/shots', scope: 'extension', phase: 'v0.5', ctl: false, feature: 'meetings',
    bodyLimit: MEETING_SHOT_BODY_MAX,
    params: ClientIdParamsSchema, body: ExtShotBodySchema, response: IdReplySchema,
    summary: 'A screenshot (a JPEG data URL), stored once per key.',
  }),
  extMeetingEnd: route({
    method: 'POST', path: '/v1/ext/meetings/:clientId/end', scope: 'extension', phase: 'v0.5', ctl: false, feature: 'meetings',
    params: ClientIdParamsSchema, body: ExtEndBodySchema, response: OkReplySchema,
    summary: "End this tab's meeting (and queue its summary).",
  }),

  // --- v0.5 Meetings: the phone (control, reads included) and the CLI's export (status, list, get, shot on ctl.sock).
  meetingsStatus: route({
    method: 'GET', path: '/v1/meetings/status', scope: 'control', phase: 'v0.5', ctl: true,
    response: MeetingsStatusSchema, summary: 'Meetings on or off, open or broken, counts, the screenshots size, summaries and paired extensions.',
  }),
  meetingsList: route({
    method: 'GET', path: '/v1/meetings', scope: 'control', phase: 'v0.5', ctl: true, feature: 'meetings',
    query: MeetingsQuerySchema, response: MeetingsListSchema, summary: 'Meetings, newest first, by project and search, with the running one.',
  }),
  meetingGet: route({
    method: 'GET', path: '/v1/meetings/:id', scope: 'control', phase: 'v0.5', ctl: true, feature: 'meetings',
    params: MeetingParamsSchema, response: MeetingDetailSchema, summary: 'One meeting: its summary, every line and every screenshot.',
  }),
  meetingShot: route({
    method: 'GET', path: '/v1/meetings/:id/shots/:shotId', scope: 'control', phase: 'v0.5', ctl: true, feature: 'meetings', rawResponse: true,
    params: MeetingShotParamsSchema, summary: "A screenshot's bytes (image/jpeg).",
  }),
  meetingUpdate: route({
    method: 'PATCH', path: '/v1/meetings/:id', scope: 'control', phase: 'v0.5', ctl: false, feature: 'meetings',
    params: MeetingParamsSchema, body: MeetingPatchSchema, response: OkReplySchema, summary: 'Change the name, project or people.',
  }),
  meetingDelete: route({
    method: 'DELETE', path: '/v1/meetings/:id', scope: 'control', phase: 'v0.5', ctl: false, feature: 'meetings',
    params: MeetingParamsSchema, response: OkReplySchema, summary: 'Delete a meeting with its screenshots (an open one is ended first).',
  }),
  meetingSummarize: route({
    method: 'POST', path: '/v1/meetings/:id/summary', scope: 'control', phase: 'v0.5', ctl: false, feature: 'meetings',
    params: MeetingParamsSchema, response: OkReplySchema, summary: 'Write the summary now (Summarize, or Try again after a failure).',
  }),
  meetingItemTodo: route({
    method: 'POST', path: '/v1/meetings/:id/items/:n/todo', scope: 'control', phase: 'v0.5', ctl: false, feature: 'meetings',
    params: MeetingItemParamsSchema, response: IdReplySchema, summary: "Add an action item to its project's todos (the reply is the todo's id).",
  }),
  meetingItemUntodo: route({
    method: 'DELETE', path: '/v1/meetings/:id/items/:n/todo', scope: 'control', phase: 'v0.5', ctl: false, feature: 'meetings',
    params: MeetingItemParamsSchema, response: OkReplySchema, summary: 'Remove the todo an action item made (a todo already gone is fine).',
  }),
} as const satisfies Record<string, RouteDef>;

export type RouteName = keyof typeof ROUTES;

/** Fill a route's `:params`: buildPath(ROUTES.getSession, {sid}) -> "/v1/sessions/<sid>". */
export function buildPath(r: Pick<RouteDef, 'path'>, params: Record<string, string> = {}): string {
  return r.path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
    const v = params[name];
    if (v === undefined) throw new Error(`missing path param ${name} for ${r.path}`);
    return encodeURIComponent(v);
  });
}

// ---------------------------------------------------------------------------
// WebSocket /v1/events

export const WsHelloSchema = z.object({
  kind: z.literal('hello'),
  protocol: z.number().int().positive(),
  daemonVersion: z.string(),
  webHash: z.string().nullable(),
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
});

export const WsServerMessageSchema = z.discriminatedUnion('kind', [
  WsHelloSchema,
  z.object({ kind: z.literal('snapshot'), seq: z.number().int().nonnegative(), state: StateSchema }),
  z.object({ kind: z.literal('event'), event: EventSchema }),
  z.object({ kind: z.literal('heartbeat'), seq: z.number().int().nonnegative(), ts: IsoDateSchema }),
  z.object({ kind: z.literal('error'), error: ErrorBodySchema.shape.error }),
]);
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;

/** Subprotocols a client offers on `WS /v1/events`: the daemon selects EVENTS_WS_PROTOCOL and never echoes the secret. */
export function eventsSocketProtocols(secret: string): string[] {
  return [EVENTS_WS_PROTOCOL, `${DEVICE_SECRET_WS_PREFIX}${secret}`];
}

/** The device secret from a `Sec-WebSocket-Protocol` header (comma separated), if one was offered. */
export function secretFromSocketProtocols(header: string | string[] | undefined): string | undefined {
  const list = (Array.isArray(header) ? header.join(',') : (header ?? '')).split(',').map((p) => p.trim());
  const hit = list.find((p) => p.startsWith(DEVICE_SECRET_WS_PREFIX));
  return hit ? hit.slice(DEVICE_SECRET_WS_PREFIX.length) || undefined : undefined;
}

export const WsClientMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ping') }),
]);
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;


// ---------------------------------------------------------------------------
// Inferred types for handlers and clients

export type StateResponse = z.infer<typeof StateResponseSchema>;
export type SessionsResponse = z.infer<typeof SessionsResponseSchema>;
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
export type TranscriptQuery = z.infer<typeof TranscriptQuerySchema>;
export type TranscriptResponse = z.infer<typeof TranscriptResponseSchema>;
export type ScreenQuery = z.infer<typeof ScreenQuerySchema>;
export type ScreenResponse = z.infer<typeof ScreenResponseSchema>;
export type PromptAccepted = z.infer<typeof PromptAcceptedSchema>;
export type SendJobResponse = z.infer<typeof SendJobResponseSchema>;
export type PendingListResponse = z.infer<typeof PendingListResponseSchema>;
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;
export type AccountsResponse = z.infer<typeof AccountsResponseSchema>;
export type PlanResponse = z.infer<typeof PlanResponseSchema>;
export type MovesResponse = z.infer<typeof MovesResponseSchema>;
export type BurnResponse = z.infer<typeof BurnResponseSchema>;
export type AlertsQuery = z.infer<typeof AlertsQuerySchema>;
export type AlertsResponse = z.infer<typeof AlertsResponseSchema>;
export type UsageRefreshResponse = z.infer<typeof UsageRefreshResponseSchema>;
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;
export type MuteBody = z.infer<typeof MuteBodySchema>;
export type MuteResponse = z.infer<typeof MuteResponseSchema>;
export type PairStartBody = z.infer<typeof PairStartBodySchema>;
export type PairStartResponse = z.infer<typeof PairStartResponseSchema>;
export type PairClaimBody = z.infer<typeof PairClaimBodySchema>;
export type PairClaimResponse = z.infer<typeof PairClaimResponseSchema>;
export type DevicesResponse = z.infer<typeof DevicesResponseSchema>;
export type DeviceResponse = z.infer<typeof DeviceResponseSchema>;
export type AuditQuery = z.infer<typeof AuditQuerySchema>;
export type AuditResponse = z.infer<typeof AuditResponseSchema>;
export type PushSubscribeBody = z.infer<typeof PushSubscribeBodySchema>;
export type PushUnsubscribeBody = z.infer<typeof PushUnsubscribeBodySchema>;
export type VapidKeyResponse = z.infer<typeof VapidKeyResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type EventsQuery = z.infer<typeof EventsQuerySchema>;
export type WsHello = z.infer<typeof WsHelloSchema>;
export type RewriteStartResponse = z.infer<typeof RewriteStartResponseSchema>;
export type RewriteJobResponse = z.infer<typeof RewriteJobResponseSchema>;
export type FilesRootsResponse = z.infer<typeof FilesRootsResponseSchema>;
export type FilesChangesResponse = z.infer<typeof FilesChangesResponseSchema>;
export type SessionChangesResponse = z.infer<typeof SessionChangesResponseSchema>;
export type SessionChangeResponse = z.infer<typeof SessionChangeResponseSchema>;
export type FoldersListResponse = z.infer<typeof FoldersListResponseSchema>;
export type FolderRecent = z.infer<typeof FolderRecentSchema>;
export type FoldersRecentResponse = z.infer<typeof FoldersRecentResponseSchema>;
export type FolderCreateResponse = z.infer<typeof FolderCreateResponseSchema>;
export type LaunchJobResponse = z.infer<typeof LaunchJobResponseSchema>;
export type LaunchGetResponse = z.infer<typeof LaunchGetResponseSchema>;
export type LaunchListResponse = z.infer<typeof LaunchListResponseSchema>;
export type SessionModeResponse = z.infer<typeof SessionModeResponseSchema>;
export type SessionCommandResponse = z.infer<typeof SessionCommandResponseSchema>;
