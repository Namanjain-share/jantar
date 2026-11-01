/**
 * Data model. Every shape that crosses a process
 * boundary is a zod schema; the TypeScript types are inferred from them.
 *
 * Conventions:
 * - Timestamps are ISO-8601 strings (`new Date(ms).toISOString()` is always valid).
 * - Optional fields are omitted, never `null`, unless the schema says `.nullable()`.
 * - An `AccountId` is the cswap slot number.
 */
import { z } from 'zod';
import {
  BACKGROUND_NAME_MAX,
  BACKGROUND_NAMES_MAX,
  BACKGROUND_TASKS_MAX,
  DIALOG_COUNTDOWN_TIME,
  SLASH_ARGS_MAX,
} from './constants.js';

// ---------------------------------------------------------------------------
// Primitives

export const IsoDateSchema = z.iso.datetime({ offset: true });
export type IsoDate = z.infer<typeof IsoDateSchema>;

export const AccountIdSchema = z.number().int().nonnegative();
export type AccountId = z.infer<typeof AccountIdSchema>;

/** v0.6: a paired machine's id (a ulid the hub gives it when it pairs). */
export const NodeIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export type NodeId = z.infer<typeof NodeIdSchema>;

/**
 * Device scopes, a chain: admin ⊃ launch ⊃ control ⊃ read. `launch` (v0.3)
 * starts new sessions and creates folders; no pairing grants it by default.
 */
export const ScopeSchema = z.enum(['read', 'control', 'launch', 'admin']);
export type Scope = z.infer<typeof ScopeSchema>;

export const NotifyKindSchema = z.enum([
  'permission',
  'question',
  'plan',
  'done',
  'blocked',
  'limit',
  'error',
  'usage',
  'reminder',
  'send-failed',
  /** v0.3: a session was started from a phone, or its launch needs you or failed. Pushed to every device. */
  'launch',
  /** v0.3: a device kept asking for protected files. Locked on, like "send-failed". */
  'security',
  /**
   * v0.4: a medicine is due or running low. Reaches every control-scope device with a push
   * subscription whatever kinds it chose, and mute never silences it.
   */
  'med',
  /** v0.4: a timed todo or a bill is due. Every control-scope device, whatever kinds it chose; mute holds it. */
  'life',
]);
export type NotifyKind = z.infer<typeof NotifyKindSchema>;

// ---------------------------------------------------------------------------
// Move (ccw's move schema, so parked moves can be imported later)

export const MoveStepSchema = z.enum(['saving', 'restarting', 'continuing', 'parked', 'stuck']);
export type MoveStep = z.infer<typeof MoveStepSchema>;

export const MoveSchema = z.object({
  sid: z.string().min(1),
  from: AccountIdSchema,
  to: AccountIdSchema.optional(),
  step: MoveStepSchema,
  why: z.string(),
  since: IsoDateSchema,
  ownerPid: z.number().int().optional(),
  wakeAt: IsoDateSchema.optional(),
  at: IsoDateSchema.optional(),
  ranOut: z.boolean().optional(),
  retry: z.boolean().optional(),
  orphan: z.boolean().optional(),
  name: z.string().optional(),
  folder: z.string().optional(),
});
export type Move = z.infer<typeof MoveSchema>;

// ---------------------------------------------------------------------------
// Session

export const SessionStatusSchema = z.enum(['working', 'idle', 'waiting', 'compacting', 'ended']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/** Precedence, highest first: hook > session-file > transcript (docs/hook-protocol.md, section 7). */
export const StatusSourceSchema = z.enum(['hook', 'session-file', 'transcript']);
export type StatusSource = z.infer<typeof StatusSourceSchema>;

export const SessionNowSchema = z.object({
  kind: z.enum(['tool', 'said', 'prompt']),
  tool: z.string().optional(),
  text: z.string(),
});
export type SessionNow = z.infer<typeof SessionNowSchema>;

const backgroundCount = () => z.number().int().positive().max(BACKGROUND_TASKS_MAX).optional();

/**
 * v0.6.1: work Claude Code still runs in the background for a session, read
 * from its main transcript. Counts are left out when 0, so `{}` means nothing
 * runs. Only workflows and agents make a session look working; shells and
 * monitors are a quiet count (a long-lived monitor would otherwise keep a
 * session busy forever). Never a task's prompt, description, command,
 * summary, output file or id.
 */
export const SessionBackgroundSchema = z.object({
  /** Dynamic workflows (the Workflow tool) still running. */
  workflows: backgroundCount(),
  /** Background agents (the Agent tool, launched async) still running. */
  agents: backgroundCount(),
  /** Background shells (Bash run_in_background, or moved to the background on a timeout). */
  shells: backgroundCount(),
  /** Monitors (the Monitor tool) not yet ended, stopped or expired. */
  monitors: backgroundCount(),
  /** When the oldest running workflow or agent was launched. Present exactly when workflows or agents are. */
  since: IsoDateSchema.optional(),
  /** The running workflows' names (meta.name), newest first. */
  names: z.array(z.string().min(1).max(BACKGROUND_NAME_MAX)).min(1).max(BACKGROUND_NAMES_MAX).optional(),
});
export type SessionBackground = z.infer<typeof SessionBackgroundSchema>;

export const SessionSchema = z.object({
  sid: z.string().min(1),
  pid: z.number().int(),
  /** Process start time as Claude wrote it in its session file (compare with `ps -o lstart=`). */
  procStart: z.string(),
  version: z.string().optional(),
  /** Fixed when the session starts, from its config dir; null when it can't be told. */
  account: AccountIdSchema.nullable(),
  configDir: z.string(),
  cwd: z.string(),
  /** Display name of the project folder (basename of cwd). */
  folder: z.string(),
  name: z.string().optional(),
  /** "cli" for interactive terminals; "sdk-cli" sessions are dropped by discovery. */
  entrypoint: z.string(),
  kind: z.string().optional(),
  status: SessionStatusSchema,
  statusSource: StatusSourceSchema,
  /** When the current status began. */
  statusSince: IsoDateSchema,
  /**
   * Time of the newest observation that agreed with `status` (hook client
   * timestamp, session-file statusUpdatedAt, ...). Older observations lose.
   */
  statusAt: IsoDateSchema.optional(),
  /** What a waiting session is waiting for, as Claude's session file says. */
  waitingFor: z.string().optional(),
  now: SessionNowSchema.optional(),
  lastReply: z.object({ text: z.string(), at: IsoDateSchema }).optional(),
  mode: z.string().optional(),
  /** Claude's away summary, when present. */
  away: z.string().optional(),
  subagentsRunning: z.number().int().nonnegative(),
  errorLast: z.string().optional(),
  paneId: z.string().optional(),
  tty: z.string().optional(),
  transcriptPath: z.string().optional(),
  startedAt: IsoDateSchema.optional(),
  group: z.string().optional(),
  move: MoveSchema.optional(),
  burn: z.object({ pctPerMin: z.number(), updatedAt: IsoDateSchema }).optional(),
  /** v0.3: how many files Claude created or changed in this session (from its transcript), while Files is on. */
  filesChanged: z.number().int().nonnegative().optional(),
  /**
   * v0.6.1: background work still running (SessionBackgroundSchema). Absent
   * (an older daemon, or a session that never ran any) and `{}` both mean
   * none. Cleared by a patch to `{}`, never by `unset`: a 0.6.0 hub refuses an
   * unset key it does not know, which would cost a mixed Fleet its link.
   */
  background: SessionBackgroundSchema.optional(),
  /**
   * v0.6: the paired machine (node id) this session runs on; absent = the
   * hub's own session. Stamped by the hub when a node reports it, never
   * patched or unset (a session never changes machine).
   */
  node: NodeIdSchema.optional(),
});
export type Session = z.infer<typeof SessionSchema>;

export const SessionKeySchema = SessionSchema.keyof();
export type SessionKey = z.infer<typeof SessionKeySchema>;

/** Optional session fields: the only ones `session.updated` may unset. */
export const SessionOptionalKeySchema = z.enum([
  'version',
  'name',
  'kind',
  'statusAt',
  'waitingFor',
  'now',
  'lastReply',
  'mode',
  'away',
  'errorLast',
  'paneId',
  'tty',
  'transcriptPath',
  'startedAt',
  'group',
  'move',
  'burn',
  'filesChanged',
]);
export type SessionOptionalKey = z.infer<typeof SessionOptionalKeySchema>;

/** Fields to merge into a session. `sid` comes from the event envelope; v0.6's `node` is never patched (a patch carrying it loses it). */
export const SessionPatchSchema = SessionSchema.omit({ sid: true, node: true }).partial();
export type SessionPatch = z.infer<typeof SessionPatchSchema>;

// ---------------------------------------------------------------------------
// Pane (a terminal tab / tmux pane)

export const PaneBackendSchema = z.enum(['terminal-app', 'tmux', 'iterm2']);
export type PaneBackend = z.infer<typeof PaneBackendSchema>;

export const PaneForegroundSchema = z.enum(['claude', 'shell', 'other', 'gone']);
export type PaneForeground = z.infer<typeof PaneForegroundSchema>;

export const PaneSchema = z.object({
  id: z.string().min(1),
  backend: PaneBackendSchema,
  /** Backend-specific locator (Terminal.app: "window-id:tab-index"; tmux: "%3"). */
  handle: z.string(),
  tty: z.string(),
  foreground: PaneForegroundSchema,
  title: z.string().optional(),
  /**
   * The Claude pid this pane was looked up for. Foreground checks use it, so
   * two sessions on one tty (one suspended with Ctrl-Z) never borrow each
   * other's answer.
   */
  pid: z.number().int().positive().optional(),
});
export type Pane = z.infer<typeof PaneSchema>;

// ---------------------------------------------------------------------------
// Pending request (an approval / question / plan card)

export const PendingKindSchema = z.enum(['permission', 'question', 'plan', 'subagent-info']);
export type PendingKind = z.infer<typeof PendingKindSchema>;

export const PendingStateSchema = z.enum([
  'open',
  'decided',
  'confirmed',
  'handled-in-terminal',
  'closed',
]);
export type PendingState = z.infer<typeof PendingStateSchema>;

export const QuestionOptionSchema = z.looseObject({
  label: z.string(),
  description: z.string().optional(),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

/** One entry of AskUserQuestion's `tool_input.questions`. Answers are keyed by `question`. */
export const QuestionSchema = z.looseObject({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(QuestionOptionSchema),
  multiSelect: z.boolean().optional(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const PendingRequestSchema = z.object({
  /** ulid plus 96 random bits: unguessable and single-use. */
  id: z.string().min(26),
  sid: z.string().min(1),
  kind: PendingKindSchema,
  tool: z.string(),
  input: z.unknown(),
  /** Claude's `permission_suggestions`; a decision picks one by index. */
  suggestions: z.array(z.unknown()),
  questions: z.array(QuestionSchema).optional(),
  /** `sid|tool_name|canonical(tool_input)` */
  correlationKey: z.string(),
  createdAt: IsoDateSchema,
  /** Don't push before this time: auto-approved requests close within the settle window. */
  settleUntil: IsoDateSchema,
  state: PendingStateSchema,
  decidedBy: z.string().optional(),
  decision: z.unknown().optional(),
  /** Set for subagent requests; those cards are informational only. */
  agentId: z.string().optional(),
  closedAt: IsoDateSchema.optional(),
  closeReason: z.string().optional(),
  /**
   * v0.4.2, plan cards only: the modes the card may approve with, in Claude's
   * order. `auto` only once a hook payload of this session carried
   * `permission_mode: "auto"` (Claude shows "Yes, and use auto mode" only
   * when the account allows it); otherwise `acceptEdits`. The daemon refuses
   * a mode not listed.
   */
  planModes: z.array(z.enum(['auto', 'acceptEdits', 'default'])).optional(),
});
export type PendingRequest = z.infer<typeof PendingRequestSchema>;

// ---------------------------------------------------------------------------
// Account (one cswap slot)

export const UsageWindowSchema = z.object({
  /** "five_hour", "seven_day" or "scoped:<model name>" */
  kind: z.string().min(1),
  pct: z.number(),
  resetsAt: IsoDateSchema.optional(),
  willLastToReset: z.boolean().optional(),
  projectedExhaustionAt: IsoDateSchema.optional(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

export const AccountProjectionSchema = z.object({
  burnPctPerMin: z.number(),
  fullInMin: z.number().optional(),
  ridesReset: z.boolean(),
  usable: z.boolean(),
});
export type AccountProjection = z.infer<typeof AccountProjectionSchema>;

export const AccountSchema = z.object({
  id: AccountIdSchema,
  alias: z.string().optional(),
  /** Never the full address: see `maskEmail()`. */
  emailMasked: z.string(),
  /** cswap's active account, i.e. the plain `claude` login on ~/.claude. */
  isDefaultLogin: z.boolean(),
  disabled: z.boolean(),
  /** In the autoswitch hold list. */
  held: z.boolean(),
  /** cswap usageStatus: ok, token_expired, api_key, relogin_required, unavailable, ... */
  usageStatus: z.string(),
  fetchedAt: IsoDateSchema.optional(),
  ageS: z.number().optional(),
  windows: z.array(UsageWindowSchema),
  projection: AccountProjectionSchema.optional(),
});
export type Account = z.infer<typeof AccountSchema>;

// ---------------------------------------------------------------------------
// Send job (one typed prompt, proven by the transcript)

export const SendStageSchema = z.enum([
  'queued',
  'checking',
  'typed',
  'enter',
  'proven',
  'proven-merged',
  'failed',
  'refused',
]);
export type SendStage = z.infer<typeof SendStageSchema>;

/** Stages after which a job never changes again. */
export const SEND_FINAL_STAGES: readonly SendStage[] = ['proven', 'proven-merged', 'failed', 'refused'];

export const SendProofSchema = z.object({
  kind: z.enum(['user', 'queued_command', 'queue-operation']),
  uuid: z.string().optional(),
  at: IsoDateSchema,
});
export type SendProof = z.infer<typeof SendProofSchema>;

/**
 * Where a prompt's text came from (v0.3), computed by the daemon from
 * sha256(text), never taken from the client: "rewrite" is the written prompt
 * unchanged, "rewrite-edited" an edited one, "rewrite-raw" what the user said
 * ("Send what I said"). Jobs sent without a rewriteJobId carry no origin
 * (typed).
 */
export const SendOriginSchema = z.enum(['typed', 'rewrite', 'rewrite-edited', 'rewrite-raw']);
export type SendOrigin = z.infer<typeof SendOriginSchema>;

export const SendJobSchema = z.object({
  id: z.string().min(1),
  sid: z.string().min(1),
  /** Unknown until the pane is found (a job refused early has none). */
  paneId: z.string().optional(),
  /** sha256 of the prompt text: prompt bodies are not stored in events or logs. */
  textHash: z.string(),
  textLength: z.number().int().nonnegative(),
  idempotencyKey: z.string().optional(),
  stage: SendStageSchema,
  proof: SendProofSchema.optional(),
  attempts: z.number().int().nonnegative(),
  reason: z.string().optional(),
  actor: z.string().optional(),
  /** v0.3: set when the prompt came through Rewrite (see SendOriginSchema). */
  origin: SendOriginSchema.optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type SendJob = z.infer<typeof SendJobSchema>;

// ---------------------------------------------------------------------------
// Device (a paired browser / phone)

export const DeviceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** sha256 of the device key. The key itself is never stored. */
  keyHash: z.string(),
  /**
   * sha256 of the device secret, the second credential writes and the event
   * stream need. Missing on devices paired before it existed: they can read
   * but must pair again to write.
   */
  secretHash: z.string().optional(),
  scopes: z.array(ScopeSchema).min(1),
  createdAt: IsoDateSchema,
  lastSeenAt: IsoDateSchema,
  revokedAt: IsoDateSchema.optional(),
  userAgent: z.string().optional(),
});
export type Device = z.infer<typeof DeviceSchema>;

/** What the API returns about a device: never the key or secret hashes. */
export const DevicePublicSchema = DeviceSchema.omit({ keyHash: true, secretHash: true });
export type DevicePublic = z.infer<typeof DevicePublicSchema>;

// ---------------------------------------------------------------------------
// Audit log

export const AuditResultSchema = z.enum(['ok', 'refused', 'failed']);
export type AuditResult = z.infer<typeof AuditResultSchema>;

export const AuditEntrySchema = z.object({
  seq: z.number().int().positive(),
  ts: IsoDateSchema,
  /** "device:<id>", "cli", "local-ui" or "system" */
  actor: z.string(),
  action: z.string(),
  target: z.string().optional(),
  /** Redacted: no prompt bodies, keys or tokens. */
  params: z.unknown(),
  result: AuditResultSchema,
  detail: z.string().optional(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// ---------------------------------------------------------------------------
// Alerts feed

export const AlertKindSchema = z.enum(['blocked', 'rejected', 'limit', 'error']);
export type AlertKind = z.infer<typeof AlertKindSchema>;

export const AlertSchema = z.object({
  id: z.string().min(1),
  ts: IsoDateSchema,
  kind: AlertKindSchema,
  sid: z.string().optional(),
  account: AccountIdSchema.optional(),
  /** "status · folder · session" */
  label: z.string(),
  /** One line: what happened. */
  what: z.string(),
  why: z.string().optional(),
  /** Longer text (the transcript line it came from). */
  full: z.string().optional(),
  /** v0.6: the paired machine the alert came from (stamped by the hub); absent = the hub. */
  node: NodeIdSchema.optional(),
});
export type Alert = z.infer<typeof AlertSchema>;

// ---------------------------------------------------------------------------
// Transcript view (v0.1 is text only)

export const TranscriptItemSchema = z.object({
  /** Transcript entry uuid, or "@<byte offset>" when the entry has none. */
  id: z.string().min(1),
  at: IsoDateSchema.optional(),
  role: z.enum(['user', 'assistant', 'system']),
  kind: z.enum(['text', 'tool_use', 'tool_result', 'queued', 'meta']),
  text: z.string(),
  tool: z.string().optional(),
  isSidechain: z.boolean().optional(),
});
export type TranscriptItem = z.infer<typeof TranscriptItemSchema>;

// ---------------------------------------------------------------------------
// Web Push

export const PushSubscriptionSchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
export type PushSubscriptionJSON = z.infer<typeof PushSubscriptionSchema>;

export const PushSubscriptionRecordSchema = z.object({
  subscription: PushSubscriptionSchema,
  deviceId: z.string().min(1),
  kinds: z.array(NotifyKindSchema).optional(),
  createdAt: IsoDateSchema,
});
export type PushSubscriptionRecord = z.infer<typeof PushSubscriptionRecordSchema>;

// ===========================================================================
// v0.3

// ---------------------------------------------------------------------------
// Controls: permission modes, control keys, slash commands

/** Claude Code's permission modes as its hooks name them (the mode labelled "Manual" is "default"). */
export const PermissionModeNameSchema = z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto']);
export type PermissionModeName = z.infer<typeof PermissionModeNameSchema>;

/**
 * The only keys the daemon types outside a prompt. The bytes per key live in
 * the daemon (terminal/terminal-app/keys.ts); a client only ever names one.
 * - up, down, enter: menus (the launcher answering a startup dialog)
 * - shiftTab: one permission-mode step
 * - interrupt: Ctrl+C; quit: Ctrl+C twice in one write
 * - clearInput: End and Ctrl+U, as many as the draft's rows need; refused
 *   while settings.controls.clearVerified is off
 * - escape: refused while settings.controls.escapeVerified is off
 */
export const ControlKeySchema = z.enum(['up', 'down', 'enter', 'shiftTab', 'interrupt', 'clearInput', 'quit', 'escape']);
export type ControlKey = z.infer<typeof ControlKeySchema>;

export const SLASH_COMMAND_NAMES = ['plan', 'model', 'effort', 'compact', 'clear', 'rewind'] as const;
export const SlashCommandNameSchema = z.enum(SLASH_COMMAND_NAMES);
export type SlashCommandName = z.infer<typeof SlashCommandNameSchema>;
/** `/model <arg>`: a bare `/model` opens a picker that the typed Return would answer, so an argument is required. */
export const SLASH_MODEL_ARGS = ['default', 'opus', 'sonnet', 'haiku', 'fable'] as const;
/** `/effort <arg>`, required for the same reason. */
export const SLASH_EFFORT_ARGS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'auto'] as const;

// C0 and C1 controls and DEL: arguments are typed into the terminal.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/u;

function checkSlashArgs(c: { name: SlashCommandName; args?: string | undefined }, ctx: z.RefinementCtx): void {
  const args = c.args;
  const issue = (message: string) => ctx.addIssue({ code: 'custom', path: ['args'], message });
  if (args !== undefined && CONTROL_CHARS.test(args)) issue('args must not contain control characters');
  switch (c.name) {
    case 'model':
      if (args === undefined || !(SLASH_MODEL_ARGS as readonly string[]).includes(args)) issue(`model must be one of ${SLASH_MODEL_ARGS.join(', ')}`);
      break;
    case 'effort':
      if (args === undefined || !(SLASH_EFFORT_ARGS as readonly string[]).includes(args)) issue(`effort must be one of ${SLASH_EFFORT_ARGS.join(', ')}`);
      break;
    case 'clear':
    case 'rewind':
      if (args !== undefined && args !== '') issue(`/${c.name} takes no arguments`);
      break;
    default:
      break;
  }
}

const slashCommandFields = {
  name: SlashCommandNameSchema,
  args: z.string().max(SLASH_ARGS_MAX).optional(),
};

/**
 * A slash command the daemon types through the writer (with proof). `plan`
 * and `compact` take optional free text; `model` and `effort` take one word
 * from a fixed list; `clear` and `rewind` take nothing.
 */
export const SlashCommandSchema = z.strictObject(slashCommandFields).superRefine(checkSlashArgs);
export type SlashCommand = z.infer<typeof SlashCommandSchema>;

/** Slash commands the phone must confirm (`confirm: true` in the request body). */
export const CONFIRM_SLASH_COMMANDS: readonly SlashCommandName[] = ['clear', 'rewind'];

/** POST /v1/sessions/:sid/command */
export const SessionCommandBodySchema = z
  .strictObject({ ...slashCommandFields, confirm: z.boolean().optional() })
  .superRefine((c, ctx) => {
    checkSlashArgs(c, ctx);
    if (CONFIRM_SLASH_COMMANDS.includes(c.name) && c.confirm !== true) {
      ctx.addIssue({ code: 'custom', path: ['confirm'], message: `/${c.name} needs confirm: true` });
    }
  });
export type SessionCommandBody = z.infer<typeof SessionCommandBodySchema>;

// ---------------------------------------------------------------------------
// Rewrite: dictated or typed text turned into a prompt by a headless Claude run

export const RewriteModelSchema = z.enum(['opus', 'sonnet', 'haiku']);
export type RewriteModel = z.infer<typeof RewriteModelSchema>;

/** queued -> writing -> ready | failed | cancelled; ready -> sent once the prompt is sent with its rewriteJobId. */
export const RewriteStateSchema = z.enum(['queued', 'writing', 'ready', 'failed', 'cancelled', 'sent']);
export type RewriteState = z.infer<typeof RewriteStateSchema>;
/** States after which a rewrite job never changes again. */
export const REWRITE_FINAL_STATES: readonly RewriteState[] = ['failed', 'cancelled', 'sent'];

/**
 * Why a rewrite failed (the job's `reason` is the sentence the sheet shows;
 * "Send what I said" always stays one tap away).
 * - no_account: no account has room (never a kept account (settings accounts.kept); over the 5-hour or weekly ceiling)
 * - unavailable: cswap or claude is missing
 * - failed: the run ended in an error (an auth error, is_error, a non-success result)
 * - timeout: no result in rewrite.timeoutS
 * - flags_rejected: cswap or claude refused an option the prompt writer can't run
 *   without (or one it couldn't read); only the droppable tuning options are ever left out
 * - empty: the run wrote nothing
 */
export const RewriteFailureSchema = z.enum(['no_account', 'unavailable', 'failed', 'timeout', 'flags_rejected', 'empty']);
export type RewriteFailure = z.infer<typeof RewriteFailureSchema>;

/** What the guards found in a written prompt. Public: counts only, never the tokens themselves. */
export const RewriteFlagsSchema = z.object({
  /** Much longer than what the user said (len > 2.5 x input + 300). */
  expanded: z.boolean(),
  /** How many file names, paths, flags or backticked tokens appear that the input and context do not have. */
  newTokens: z.number().int().nonnegative(),
  /** The prompt starts with "!" or "/". */
  leading: z.enum(['bang', 'slash']).nullable(),
  /** A "Here is the prompt:" preface was stripped. */
  preface: z.boolean(),
});
export type RewriteFlags = z.infer<typeof RewriteFlagsSchema>;

/**
 * A rewrite job as events and state carry it: never any text, so it can go
 * in the event ring that every device receives.
 */
export const RewriteJobSchema = z.object({
  id: z.string().min(1).max(128),
  sid: z.string().min(1),
  /** The device that asked (null: not a device; the API starts jobs for devices only). Only the owner can read or cancel the job. */
  deviceId: z.string().nullable(),
  state: RewriteStateSchema,
  /** The model the run uses: rewrite.model unless the request named one. */
  model: RewriteModelSchema,
  /** The account the run uses, once picked. */
  account: AccountIdSchema.optional(),
  /** sha256 and length of what the user said. */
  input: z.object({ hash: z.string(), length: z.number().int().nonnegative() }),
  /** Set at ready: sha256, length and guard flags of the written prompt. */
  prompt: z.object({ hash: z.string(), length: z.number().int().nonnegative(), flags: RewriteFlagsSchema }).optional(),
  failure: RewriteFailureSchema.optional(),
  /** One fixed daemon sentence for failed (never model output or user text). */
  reason: z.string().max(300).optional(),
  /** Run time in ms (spawn to result). */
  ms: z.number().int().nonnegative().optional(),
  /** System prompt version, e.g. "v1". */
  promptVersion: z.string().max(16).optional(),
  /** The send job, once sent. */
  sendJobId: z.string().optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  /** When the daemon drops the texts (REWRITE_TTL_MS after the job ended). */
  expiresAt: IsoDateSchema.optional(),
});
export type RewriteJob = z.infer<typeof RewriteJobSchema>;

/** GET /v1/rewrite/:jobId, owner only: the texts live here and in daemon memory, nowhere else. */
export const RewriteDetailSchema = z.object({
  state: RewriteStateSchema,
  /** The written prompt (ready and sent, until the texts expire). */
  prompt: z.string().optional(),
  /** The sentence to show on failed. */
  error: z.string().optional(),
  job: RewriteJobSchema,
  /** What the user said, for the sheet's "You said". */
  input: z.string().optional(),
  /** The tokens counted in prompt.flags.newTokens, to underline in the sheet. */
  newTokens: z.array(z.string().max(200)).max(50).optional(),
});
export type RewriteDetail = z.infer<typeof RewriteDetailSchema>;

// ---------------------------------------------------------------------------
// Launch: new sessions from the phone, with allowlisted flags (U7)

export const LaunchPermissionSchema = z.enum(['skip', 'auto', 'acceptEdits', 'plan', 'manual']);
export type LaunchPermission = z.infer<typeof LaunchPermissionSchema>;
export const LaunchEffortSchema = z.enum(['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
export type LaunchEffort = z.infer<typeof LaunchEffortSchema>;
export const LaunchModelSchema = z.enum(['default', 'opus', 'sonnet', 'haiku', 'fable']);
export type LaunchModel = z.infer<typeof LaunchModelSchema>;

/**
 * The start sheet's pickers. The daemon turns these into claude flags with
 * `launchFlagArgs` and nothing else: there is no way to pass free-text flags.
 */
export const LaunchFlagsSchema = z.strictObject({
  permission: LaunchPermissionSchema,
  chrome: z.boolean(),
  effort: LaunchEffortSchema,
  model: LaunchModelSchema,
});
export type LaunchFlags = z.infer<typeof LaunchFlagsSchema>;

/**
 * Where a device that never started a session begins (v0.4): Claude asks
 * before running tools, no Chrome, Claude's own default effort and model.
 * A version-1 config that lacked `launch.defaultFlags` gets the v0.3 values
 * written in by the settings migration (V03_LAUNCH_FLAGS).
 */
export const DEFAULT_LAUNCH_FLAGS: Readonly<LaunchFlags> = Object.freeze({
  permission: 'manual',
  chrome: false,
  effort: 'default',
  model: 'default',
});

/** v0.3's defaults (skip, Chrome, ultracode): what the settings migration keeps for a version-1 config that never set its own. */
export const V03_LAUNCH_FLAGS: Readonly<LaunchFlags> = Object.freeze({
  permission: 'skip',
  chrome: true,
  effort: 'ultracode',
  model: 'default',
});

/**
 * Every pick names its mode. "Ask me" too: with no flag, the default mode in
 * the account's own Claude settings wins, and a session started that way
 * came up in auto (spike L-manual, docs/real-mac-checks.md). Claude Code
 * 2.1.314 takes `--permission-mode manual`; an older one that does not
 * know the name refuses the flag, so the start fails instead of coming up in
 * another mode.
 */
const PERMISSION_ARGS: Readonly<Record<LaunchPermission, readonly string[]>> = {
  skip: ['--dangerously-skip-permissions'],
  auto: ['--permission-mode', 'auto'],
  acceptEdits: ['--permission-mode', 'acceptEdits'],
  plan: ['--permission-mode', 'plan'],
  manual: ['--permission-mode', 'manual'],
};

/**
 * The claude flags for a set of picks (U7's table, in its order: permission,
 * Chrome, effort, model). The one allowlist: the daemon builds the typed
 * command from this, and the start sheet shows it verbatim.
 */
export function launchFlagArgs(flags: LaunchFlags): string[] {
  const out = [...PERMISSION_ARGS[flags.permission]];
  if (flags.chrome) out.push('--chrome');
  if (flags.effort !== 'default') out.push('--effort', flags.effort);
  if (flags.model !== 'default') out.push('--model', flags.model);
  return out;
}

/** Claude won't ask before running commands (skip or auto): a 2.0 s hold and the warning sentence. */
export function launchFlagsDangerous(flags: Pick<LaunchFlags, 'permission'>): boolean {
  return flags.permission === 'skip' || flags.permission === 'auto';
}

export const LaunchStageSchema = z.enum([
  'queued',
  'opening',
  'starting',
  'dialog',
  'ready',
  'prompting',
  'done',
  'done-no-prompt',
  'ready-prompt-failed',
  'failed',
  'refused',
  'stalled',
]);
export type LaunchStage = z.infer<typeof LaunchStageSchema>;
/** Stages after which a launch never changes again. */
export const LAUNCH_FINAL_STAGES: readonly LaunchStage[] = ['done', 'done-no-prompt', 'ready-prompt-failed', 'failed', 'refused', 'stalled'];

/** `--name` for a new session: no spaces (ccw's relaunch splits flags on spaces). */
export const LaunchNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/);

/** A launch as events and state carry it. Never the first prompt's text, never screen text. */
export const LaunchJobSchema = z.object({
  id: z.string().min(1).max(128),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  /** "device:<id>" or "cli". */
  actor: z.string(),
  rootId: z.string(),
  /** Absolute realpath of the folder. */
  folder: z.string(),
  /** The folder as the phone shows it ("~/Desktop/work/foo"). */
  display: z.string(),
  account: AccountIdSchema,
  /** v0.4 `resume`: the conversation lives in one profile's own projects dir, which pins its account. */
  accountSource: z.enum(['auto', 'manual', 'group', 'resume']),
  requested: z.union([AccountIdSchema, z.literal('auto')]),
  /** The account the session really started on, when it differs (its config dir said so). */
  actualAccount: AccountIdSchema.nullable().optional(),
  flags: LaunchFlagsSchema,
  /** launchFlagsDangerous(flags). */
  dangerous: z.boolean(),
  name: z.string(),
  /**
   * The --session-id the daemon passed. v0.4: for a resume, the conversation's
   * own id until the session is matched, then the matched one.
   */
  sid: z.string(),
  /** v0.4: the start typed `--resume <sid>` (a past conversation of that folder) instead of a new session id. */
  resumed: z.boolean().optional(),
  tty: z.string().optional(),
  windowId: z.string().optional(),
  stage: LaunchStageSchema,
  /** The startup dialog waiting on the phone (stage "dialog"). */
  dialog: z
    .object({ title: z.string(), options: z.array(z.string()), current: z.number().int(), since: IsoDateSchema })
    .optional(),
  /** The first prompt: hash and length only. */
  prompt: z.object({ hash: z.string(), length: z.number().int().nonnegative(), sendJobId: z.string().optional() }).optional(),
  steps: z.array(z.object({ at: IsoDateSchema, stage: LaunchStageSchema, detail: z.string().max(120) })).max(20),
  /** User-facing sentence on failed, refused or stalled. */
  reason: z.string().optional(),
  /** v0.6: the paired machine the session starts on (stamped by the hub); absent = the hub. */
  node: NodeIdSchema.optional(),
});
export type LaunchJob = z.infer<typeof LaunchJobSchema>;

/**
 * v0.4: one past conversation of a folder (GET /v1/launch/history), from the
 * transcripts Claude keeps under `projects/<encoded folder>/`. The daemon
 * lists them itself; a start may resume only an id it listed.
 */
export const PastSessionSchema = z.object({
  id: z.uuid(),
  /** The account whose own projects dir keeps it (a resume pins that account); null: the shared dir. */
  account: AccountIdSchema.nullable(),
  lastAt: IsoDateSchema,
  /** The first line the user typed, masked as a launch screen tail is (e-mail addresses, tokens), at most 80 characters. */
  first: z.string().max(80).optional(),
  /** A running session has this id (it cannot be resumed while it runs). */
  live: z.boolean(),
});
export type PastSession = z.infer<typeof PastSessionSchema>;

/** One account row of the start sheet's account picker. */
export const LaunchAccountSchema = z.object({
  id: AccountIdSchema,
  label: z.string(),
  fiveHourPct: z.number().optional(),
  sevenDayPct: z.number().optional(),
  resetsAt: IsoDateSchema.optional(),
  live: z.number().int().nonnegative(),
  selectable: z.boolean(),
  /** Why it is not selectable ("token expired", "past the ceiling", ...). */
  why: z.string().optional(),
  held: z.boolean(),
});
export type LaunchAccount = z.infer<typeof LaunchAccountSchema>;

export const LaunchWarningSchema = z.object({
  /** name: the Name asked for is already a live or starting session's (the start would be refused). */
  kind: z.enum(['group', 'stale', 'effort', 'held', 'name']),
  text: z.string(),
  /** The account a quick choice would switch to ("Use 04"). */
  account: AccountIdSchema.optional(),
});
export type LaunchWarning = z.infer<typeof LaunchWarningSchema>;

/** GET /v1/launch/preview: everything the start sheet shows before the hold. */
export const LaunchPreviewSchema = z.object({
  root: z.string(),
  path: z.string(),
  display: z.string(),
  account: z.object({
    /** null: Auto has nothing usable (a manual pick still works). */
    pick: AccountIdSchema.nullable(),
    /** v0.4 `resume`: the conversation to resume pins its account. */
    source: z.enum(['auto', 'manual', 'group', 'resume']),
    /** Mono-ready, e.g. "most room · 5h 12% · resets in 3h40 · 14:20". */
    reason: z.string(),
  }),
  accounts: z.array(LaunchAccountSchema),
  /** Where the pickers start: the flags asked for, else this device's last used, else launch.defaultFlags. */
  flags: LaunchFlagsSchema,
  /** settings.launch.defaultFlags. */
  defaults: LaunchFlagsSchema,
  /** launchFlagArgs(flags). */
  args: z.array(z.string()),
  /** The whole line the daemon would type for these values, with the session id shown as "<session id>". */
  command: z.string(),
  /** Suggested --name. */
  name: z.string(),
  warnings: z.array(LaunchWarningSchema),
});
export type LaunchPreview = z.infer<typeof LaunchPreviewSchema>;

// ---------------------------------------------------------------------------
// Files and folders (one path policy: roots set on the Mac, a hard denylist)

/**
 * A root clients may browse. Ids are "s.<sid>" for a live session's folder
 * and "r.<id>" for a root configured on the Mac (folders.roots). Clients send
 * (root id, relative path) pairs, never absolute paths.
 */
export const FileRootSchema = z.object({
  id: z.string(),
  kind: z.enum(['session', 'configured']),
  label: z.string(),
  sid: z.string().optional(),
  /** "~/Desktop/work" */
  display: z.string(),
  /** The root is $HOME: home mode hides ~/Library and top-level dot entries. */
  home: z.boolean(),
  /** Absolute realpath; only for an admin device or the CLI. */
  path: z.string().optional(),
});
export type FileRoot = z.infer<typeof FileRootSchema>;

export const FileKindSchema = z.enum(['text', 'markdown', 'image', 'svg', 'pdf', 'notebook', 'binary']);
export type FileKind = z.infer<typeof FileKindSchema>;

export const FileEntrySchema = z.object({
  name: z.string(),
  type: z.enum(['file', 'dir', 'link', 'other']),
  size: z.number().int().optional(),
  mtime: IsoDateSchema.optional(),
  /** For links: only "inside" links can be opened. */
  link: z.enum(['inside', 'outside', 'broken']).optional(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const FileListingSchema = z.object({
  root: z.string(),
  path: z.string(),
  entries: z.array(FileEntrySchema),
  /** Cursor for the next page (the last name), null at the end. */
  next: z.string().nullable(),
  /** Protected entries left out of the list. */
  hiddenProtected: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
/** Named FileListing, not FileList, so it never shadows the DOM type. */
export type FileListing = z.infer<typeof FileListingSchema>;

export const FileStatSchema = z.object({
  type: z.enum(['file', 'dir']),
  size: z.number().int(),
  mtime: IsoDateSchema,
  kind: FileKindSchema,
  language: z.string().optional(),
});
export type FileStat = z.infer<typeof FileStatSchema>;

export const FileTextWarningSchema = z.enum(['bidi', 'secret-like', 'minified', 'truncated-line']);
export type FileTextWarning = z.infer<typeof FileTextWarningSchema>;

/** One window of a text file (always JSON, rendered as text nodes). */
export const FileTextSchema = z.object({
  text: z.string(),
  offset: z.number().int().nonnegative(),
  /** Offset of the next window, null at the end. */
  next: z.number().int().nullable(),
  size: z.number().int().nonnegative(),
  bom: z.boolean(),
  eol: z.enum(['lf', 'crlf', 'mixed']),
  language: z.string().optional(),
  mtime: IsoDateSchema,
  warnings: z.array(FileTextWarningSchema),
});
export type FileText = z.infer<typeof FileTextSchema>;

export const FileToolSchema = z.enum(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
export type FileTool = z.infer<typeof FileToolSchema>;

/** One Write / Edit / MultiEdit / NotebookEdit call, paired with its tool result. */
export const FileOpSchema = z.object({
  opId: z.string(),
  tool: FileToolSchema,
  at: IsoDateSchema,
  status: z.enum(['ok', 'rejected', 'blocked', 'error', 'pending']),
  added: z.number().int().nullable(),
  removed: z.number().int().nullable(),
  /** Counts estimated without a structuredPatch. */
  approx: z.boolean(),
  /** Made by a subagent. */
  byAgent: z.boolean(),
  /** The transcript line was over 1 MiB (only its start was read). */
  large: z.boolean(),
});
export type FileOp = z.infer<typeof FileOpSchema>;

/** One file a session created or changed, with its ops summed up. */
export const FileChangeSchema = z.object({
  changeId: z.string(),
  sid: z.string(),
  /** Absolute path. */
  path: z.string(),
  /** Root and relative path to open it in the viewer, when it lies under a root. */
  rootId: z.string().optional(),
  rel: z.string().optional(),
  viewable: z.enum(['yes', 'outside', 'protected', 'missing']),
  firstAt: IsoDateSchema,
  lastAt: IsoDateSchema,
  ops: z.number().int().nonnegative(),
  tools: z.array(z.string()),
  created: z.boolean(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  last: FileOpSchema.pick({ status: true, tool: true, at: true }),
});
export type FileChange = z.infer<typeof FileChangeSchema>;

/** A folder in the new-session browser (dirs only). */
export const FolderEntrySchema = z.object({
  name: z.string(),
  link: z.boolean(),
  /** Name checks only: nothing inside is read. */
  git: z.boolean(),
  claudeMd: z.boolean(),
  /** Live sessions whose folder is this one. */
  live: z.number().int().nonnegative(),
  lastAccount: AccountIdSchema.optional(),
  lastUsed: IsoDateSchema.optional(),
  pinned: z.boolean(),
});
export type FolderEntry = z.infer<typeof FolderEntrySchema>;

/**
 * v0.4: how the daemon found Claude accounts at start. "cswap" when cswap
 * and its profiles are there (many accounts, usage, holds, autoswitch);
 * "single" otherwise (one Claude login, account 0). JANTAR_ACCOUNTS=single
 * forces single (tests). v0.6 "dirs", on a paired Linux or Windows machine
 * without cswap only: `~/.claude` and every `~/.claude-<name>` dir holding a
 * `.claude.json` is an account, numbered once per dir and never renumbered;
 * no usage numbers.
 */
export const AccountsModeSchema = z.enum(['single', 'cswap', 'dirs']);
export type AccountsMode = z.infer<typeof AccountsModeSchema>;

// ---------------------------------------------------------------------------
// Feature switches, as every client sees them

/**
 * Which v0.3 features the Mac has switched on (settings files.enabled,
 * launch.enabled, rewrite.enabled, controls.enabled, screenshots.*,
 * controls.escapeVerified, controls.clearVerified). The daemon puts them in `daemon.version`, so
 * clients hide what is off without reading settings (admin only).
 */
export const FeaturesSchema = z.object({
  files: z.boolean(),
  launch: z.boolean(),
  rewrite: z.boolean(),
  controls: z.boolean(),
  screenshots: z.boolean(),
  /** `select=1` screenshots are allowed (screenshots.allowSelect). */
  screenshotSelect: z.boolean(),
  /** The escape key is allowed (controls.escapeVerified). */
  escape: z.boolean(),
  /** Clear draft is allowed (controls.clearVerified). Optional on the wire: an older daemon never sends it. */
  clearDraft: z.boolean().default(false),
  /**
   * v0.4: any Life module is on (settings life.*). Which modules are on is
   * never here: `GET /v1/life/status` tells control devices only, so a
   * read-only device cannot learn that medicines or money are in use.
   */
  life: z.boolean().default(false),
  /** v0.4: the Intel shelf is on (settings intel.enabled). */
  intel: z.boolean().default(false),
  /** v0.5: Meetings are on (settings meetings.enabled). Never which meeting runs: that is a control read. */
  meetings: z.boolean().default(false),
  /** v0.5.3: Ask is on (settings ask.enabled). Why it can't run is in `GET /v1/ask`, a control read. */
  ask: z.boolean().default(false),
  /** v0.6: Fleet is on at the Mac (settings fleet.enabled): paired servers may link. */
  fleet: z.boolean().default(false),
});
export type Features = z.infer<typeof FeaturesSchema>;

/** Everything off: what a client assumes until the daemon says otherwise. */
export const NO_FEATURES: Readonly<Features> = Object.freeze({
  files: false,
  launch: false,
  rewrite: false,
  controls: false,
  screenshots: false,
  screenshotSelect: false,
  escape: false,
  clearDraft: false,
  life: false,
  intel: false,
  meetings: false,
  ask: false,
  fleet: false,
});

// ===========================================================================
// v0.4.2

// ---------------------------------------------------------------------------
// A dialog Claude shows in the terminal, read from the screen (the screen
// path: sessions without a hook card, subagent prompts). The daemon parses it
// (terminal/dialog.ts) and returns it with GET /v1/sessions/:sid/screen; the
// phone answers it with the fingerprint it was shown.

/** permission: "Do you want to …?"; plan: "Ready to code?"; question, multi (checkboxes), review ("Ready to submit your answers?"). */
export const DialogKindSchema = z.enum(['permission', 'plan', 'question', 'multi', 'review']);
export type DialogKind = z.infer<typeof DialogKindSchema>;

export const DialogRoleSchema = z.enum(['pick', 'text', 'toggle', 'submit', 'chat', 'locked']);
export type DialogRole = z.infer<typeof DialogRoleSchema>;

/** What a hold row saves; the phone shows DIALOG_HOLD_COPY[hold] under it. */
export const DialogHoldSchema = z.enum(['context', 'block', 'reads', 'mode', 'rule']);
export type DialogHold = z.infer<typeof DialogHoldSchema>;

export const DialogOptionSchema = z.object({
  /** Claude's label, number prefix removed, wrapped lines joined with one space (≤ 400 chars). */
  label: z.string().max(400),
  /** Description lines under a question's option, joined (≤ 300 chars). */
  detail: z.string().max(300).optional(),
  /**
   * pick: choose it. text: an input row, needs text. toggle: a multi-select box. submit: the
   * multi-select Submit/Next row. chat: "Chat about this". locked: shown, not answerable here.
   */
  role: DialogRoleSchema,
  /** Rows that draw a box ([ ] / [✔]): the box is ticked on the Mac. */
  checked: z.boolean().optional(),
  /** Saves something or switches mode: the phone holds, the daemon wants confirm: true. */
  hold: DialogHoldSchema.optional(),
  /** Why a locked row can't be used from the phone: one of DIALOG_NOTES. */
  note: z.string().max(200).optional(),
});
export type DialogOption = z.infer<typeof DialogOptionSchema>;

export const TerminalDialogSchema = z.object({
  kind: DialogKindSchema,
  /** "Ready to code?", "Overwrite file", "Bash command", a single question's header; '' when off screen. */
  title: z.string().max(200),
  /** The question line(s) right above the options, squashed (≤ 600 chars). */
  question: z.string().max(600),
  /** What the dialog shows between its top and its question (command, diff, visible plan, review answers). */
  body: z.array(z.string().max(300)).max(40),
  /** Several questions: the tab bar, ☒ answered. */
  tabs: z.array(z.object({ label: z.string().max(80), answered: z.boolean() })).max(12).optional(),
  options: z.array(DialogOptionSchema).min(2).max(12),
  /** The highlighted row (❯). */
  current: z.number().int().min(0).max(11),
  /**
   * v0.5.2: how long until Claude blocks the request by itself, as its
   * countdown inside the dialog showed it at this read ("1:33", "about 2
   * minutes"; DIALOG_COUNTDOWN_TIME): an unattended agent's ask (a
   * workflow's, a subagent's) waits about two minutes. The countdown's line
   * is not in `body`, and this field is not in the fingerprint: it ticks
   * every second, so a tap made at 1:33 still answers at 1:32.
   */
  blocksIn: z.string().max(32).regex(DIALOG_COUNTDOWN_TIME).optional(),
  /** sha256 hex of everything above but `blocksIn`; the answer route compares it. */
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type TerminalDialog = z.infer<typeof TerminalDialogSchema>;

/** v0.5.2: a `blocksIn` time in seconds ("1:33" is 93, "about 2 minutes" 120), or null for any other text. */
export function countdownSeconds(time: string): number | null {
  const clock = /^(\d{1,2}):(\d{2})$/u.exec(time);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const about = /^about (\d{1,3}) (minute|second)s?$/u.exec(time);
  return about ? Number(about[1]) * (about[2] === 'minute' ? 60 : 1) : null;
}

// ---------------------------------------------------------------------------
// Attachments: files from the phone, stored on the Mac and named in a prompt

/** An upload's id: a lowercase ULID, generated by the daemon (never a client's file name). */
export const UploadIdSchema = z.string().regex(/^[0-9a-hjkmnp-tv-z]{26}$/);
export type UploadId = z.infer<typeof UploadIdSchema>;

/** What the daemon read in an upload's bytes: an image Claude sees, a PDF, an office document, or text. */
export const UploadKindSchema = z.enum(['image', 'pdf', 'office', 'text']);
export type UploadKind = z.infer<typeof UploadKindSchema>;

/** One attachment of a prompt: an upload of this session and the name the phone shows for it. */
export const AttachmentRefSchema = z.strictObject({
  upload: UploadIdSchema,
  /** The file's own name (untrusted: the daemon cleans and quotes it in the prompt). */
  label: z.string().min(1).max(200),
});
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

// ===========================================================================
// v0.6: Fleet (paired machines, each with its own Claude sessions)

/** The machine a node runs on (`wsl`: Linux inside Windows' WSL2, read from /proc/sys/kernel/osrelease). */
export const NodeOsSchema = z.enum(['macos', 'linux', 'wsl', 'windows']);
export type NodeOs = z.infer<typeof NodeOsSchema>;

/** How a node reaches its Claude terminals: Terminal.app, tmux, or none (native Windows: watch and cards only). */
export const NodeBackendSchema = z.enum(['terminal-app', 'tmux', 'none']);
export type NodeBackend = z.infer<typeof NodeBackendSchema>;

/** Something the phone says about a node: `version`, its link version differs from the Mac's. */
export const NodeProblemSchema = z.enum(['version']);
export type NodeProblem = z.infer<typeof NodeProblemSchema>;

/**
 * A paired machine as the phone sees it (`state.nodes[id]`), replaced whole
 * by every `node.updated`. The name is the hub's (`jantar node pair --name`),
 * never the node's own. Its accounts are its own: they never go into
 * `state.accounts` (every server has an account 0).
 */
export const NodeViewSchema = z.object({
  id: NodeIdSchema,
  name: z.string().min(1).max(24),
  os: NodeOsSchema,
  backend: NodeBackendSchema,
  online: z.boolean(),
  /** When `online` last changed (the link opened or closed). */
  since: IsoDateSchema,
  /** The node's Jantar version (the Machines screen shows it when it differs from the Mac's). */
  version: z.string().max(64),
  /** The node runs with --read-only: every write is refused there. */
  readOnly: z.boolean(),
  /** Cloudflare Access refusals the node counted while it was away (reported on its next link). */
  accessRefused: z.number().int().nonnegative(),
  /** The node's own switches (controls, launch, ...); Files, Rewrite, screenshots, Life, Intel, Meetings and Fleet are always off there. */
  features: FeaturesSchema,
  accountsMode: AccountsModeSchema,
  /** String(account id) -> account, as state.accounts is. */
  accounts: z.record(z.string(), AccountSchema),
  activeAccount: AccountIdSchema.nullable(),
  usage: z.object({
    fetchedAt: IsoDateSchema.nullable(),
    source: z.enum(['cache', 'cli']).nullable(),
  }),
  problem: NodeProblemSchema.optional(),
});
export type NodeView = z.infer<typeof NodeViewSchema>;

/** One pairing as the Mac keeps it (GET /v1/machines, admin): no key, ever. */
export const NodeRowSchema = z.object({
  id: NodeIdSchema,
  name: z.string().min(1).max(24),
  os: NodeOsSchema,
  /** Unknown (null) until the node's first link. */
  backend: NodeBackendSchema.nullable(),
  version: z.string().max(64),
  createdAt: IsoDateSchema,
  lastSeenAt: IsoDateSchema.nullable(),
  revokedAt: IsoDateSchema.nullable(),
  online: z.boolean(),
  /** Its sessions on the board now. */
  sessions: z.number().int().nonnegative(),
  readOnly: z.boolean(),
  accessRefused: z.number().int().nonnegative(),
  /** How its last link ended (a NODE_CLOSE code or a WebSocket one), since the hub started; null when none has. */
  lastClose: z.object({ code: z.number().int(), at: IsoDateSchema }).nullable(),
  problem: NodeProblemSchema.optional(),
});
export type NodeRow = z.infer<typeof NodeRowSchema>;
