/**
 * Event stream.
 *
 * Every event is `{seq, ts, type, sid?, account?, data}`. `seq` is assigned by
 * the daemon's store, increases by exactly 1 per event across the whole
 * daemon, and is what `WS /v1/events?after=<seq>` resumes from.
 *
 * Which events change state (see reducer.ts):
 * - state events: session.added / updated / removed, pending.opened / resolved,
 *   usage.updated, move.*, send.progress, rewrite.progress, launch.progress,
 *   daemon.version, and alert.* (appended to the alerts feed). files.changed
 *   only moves its session's counter in `fileTicks` (no path, no tool);
 *   life.changed (v0.4) only moves `lifeTick`; primer.status (v0.4) sets
 *   `primer`.
 * - moment events: session.done / waiting / reminder, usage.threshold,
 *   planner.no_room, device.pending. They drive notifications and never
 *   change state, so an emitter that changes a session also emits
 *   `session.updated` (e.g. Stop hook: `session.updated {status:'idle',
 *   lastReply}` then `session.done {lastReply}`).
 */
import { z } from 'zod';
import {
  AccountIdSchema,
  AccountSchema,
  AccountsModeSchema,
  AlertSchema,
  FeaturesSchema,
  FileToolSchema,
  FileOpSchema,
  IsoDateSchema,
  LaunchJobSchema,
  MoveSchema,
  PendingRequestSchema,
  PendingStateSchema,
  RewriteJobSchema,
  SendJobSchema,
  SessionOptionalKeySchema,
  SessionPatchSchema,
  SessionSchema,
} from './models.js';
import { PrimerStatusSchema } from './primer.js';

export const EVENT = {
  SESSION_ADDED: 'session.added',
  SESSION_REMOVED: 'session.removed',
  SESSION_UPDATED: 'session.updated',
  SESSION_DONE: 'session.done',
  SESSION_WAITING: 'session.waiting',
  SESSION_REMINDER: 'session.reminder',
  PENDING_OPENED: 'pending.opened',
  PENDING_RESOLVED: 'pending.resolved',
  ALERT_BLOCKED: 'alert.blocked',
  ALERT_REJECTED: 'alert.rejected',
  ALERT_LIMIT: 'alert.limit',
  ALERT_ERROR: 'alert.error',
  USAGE_UPDATED: 'usage.updated',
  USAGE_THRESHOLD: 'usage.threshold',
  MOVE_SWITCHING: 'move.switching',
  MOVE_SAVING: 'move.saving',
  MOVE_RESTARTING: 'move.restarting',
  MOVE_CONTINUING: 'move.continuing',
  MOVE_SWITCHED: 'move.switched',
  MOVE_PARKED: 'move.parked',
  MOVE_RESUMED: 'move.resumed',
  MOVE_STUCK: 'move.stuck',
  /** A move file disappeared (ccw-legacy) without a final step. */
  MOVE_CLEARED: 'move.cleared',
  PLANNER_NO_ROOM: 'planner.no_room',
  SEND_PROGRESS: 'send.progress',
  DEVICE_PENDING: 'device.pending',
  DAEMON_VERSION: 'daemon.version',
  /** v0.3: a rewrite job changed state (never carries text). */
  REWRITE_PROGRESS: 'rewrite.progress',
  /** v0.3: a launch moved to a new stage. */
  LAUNCH_PROGRESS: 'launch.progress',
  /** v0.3: a session's transcript shows a new file op (the changes index listens; never file content). */
  FILES_CHANGED: 'files.changed',
  /**
   * v0.4: something in Life or the Intel shelf changed. Carries nothing (no
   * module, id or text): it reaches every device, read-only ones included,
   * and only moves `state.lifeTick`, which Life and Intel screens reload on.
   */
  LIFE_CHANGED: 'life.changed',
  /** v0.4: who primes free 5-hour windows, and Jantar's last prime (no push; the Accounts screen shows it). */
  PRIMER_STATUS: 'primer.status',
} as const;

export type EventType = (typeof EVENT)[keyof typeof EVENT];
export const EVENT_TYPES: readonly EventType[] = Object.values(EVENT);

export const ALERT_EVENT_TYPES = [
  EVENT.ALERT_BLOCKED,
  EVENT.ALERT_REJECTED,
  EVENT.ALERT_LIMIT,
  EVENT.ALERT_ERROR,
] as const;

export const MOVE_EVENT_TYPES = [
  EVENT.MOVE_SWITCHING,
  EVENT.MOVE_SAVING,
  EVENT.MOVE_RESTARTING,
  EVENT.MOVE_CONTINUING,
  EVENT.MOVE_SWITCHED,
  EVENT.MOVE_PARKED,
  EVENT.MOVE_RESUMED,
  EVENT.MOVE_STUCK,
] as const;

/** Move events after which the move is over and is dropped from state. */
export const MOVE_FINAL_EVENT_TYPES: readonly EventType[] = [
  EVENT.MOVE_SWITCHED,
  EVENT.MOVE_RESUMED,
  EVENT.MOVE_CLEARED,
];

// ---------------------------------------------------------------------------
// Payload schemas

const alertData = z.object({ alert: AlertSchema });
const moveData = z.object({ move: MoveSchema });

export const EventDataSchemas = {
  'session.added': z.object({ session: SessionSchema }),
  'session.removed': z.object({
    /** e.g. "ended", "pid-gone", "pid-reused", "file-removed" */
    reason: z.string().optional(),
  }),
  'session.updated': z.object({
    patch: SessionPatchSchema,
    /** Optional fields to clear (JSON cannot carry `undefined`). */
    unset: z.array(SessionOptionalKeySchema).optional(),
  }),
  'session.done': z.object({
    lastReply: z.object({ text: z.string(), at: IsoDateSchema }).optional(),
  }),
  'session.waiting': z.object({
    waitingFor: z.string().optional(),
    pendingId: z.string().optional(),
  }),
  'session.reminder': z.object({
    afterMin: z.number().positive(),
    waitingSince: IsoDateSchema,
  }),
  'pending.opened': z.object({ pending: PendingRequestSchema }),
  'pending.resolved': z.object({
    id: z.string().min(1),
    state: PendingStateSchema.exclude(['open']),
    decidedBy: z.string().optional(),
    decision: z.unknown().optional(),
    reason: z.string().optional(),
  }),
  'alert.blocked': alertData,
  'alert.rejected': alertData,
  'alert.limit': alertData,
  'alert.error': alertData,
  'usage.updated': z.object({
    accounts: z.array(AccountSchema),
    activeAccount: AccountIdSchema.nullable(),
    fetchedAt: IsoDateSchema,
    source: z.enum(['cache', 'cli']),
  }),
  'usage.threshold': z.object({
    /** "five_hour", "seven_day" or "scoped:<name>" */
    window: z.string().min(1),
    pct: z.number(),
    threshold: z.number(),
  }),
  'move.switching': moveData,
  'move.saving': moveData,
  'move.restarting': moveData,
  'move.continuing': moveData,
  'move.switched': moveData,
  'move.parked': moveData,
  'move.resumed': moveData,
  'move.stuck': moveData,
  'move.cleared': z.object({}),
  'planner.no_room': z.object({
    sids: z.array(z.string()),
    why: z.string(),
    group: z.string().optional(),
  }),
  'send.progress': z.object({ job: SendJobSchema }),
  'device.pending': z.object({
    pairId: z.string().min(1),
    name: z.string().optional(),
    expiresAt: IsoDateSchema,
  }),
  'daemon.version': z.object({
    protocol: z.number().int().positive(),
    daemonVersion: z.string(),
    webHash: z.string().nullable(),
    /** v0.3: re-sent whenever a switch changes. Absent from older daemons (= everything off). */
    features: FeaturesSchema.optional(),
    /** v0.4: one Claude login (single) or cswap's accounts (cswap), found at daemon start. */
    accountsMode: AccountsModeSchema.optional(),
  }),
  'rewrite.progress': z.object({ job: RewriteJobSchema }),
  'launch.progress': z.object({ job: LaunchJobSchema }),
  'files.changed': z.object({
    changeId: z.string(),
    /** Absolute path the op names. */
    path: z.string(),
    tool: FileToolSchema,
    at: IsoDateSchema,
    status: FileOpSchema.shape.status,
    opId: z.string(),
    /** Byte offset of the tool_result line, so the index can re-read that one line (never diff hunks: decision U9). */
    transcriptOffset: z.number().int().nonnegative(),
    byAgent: z.boolean(),
  }),
  'life.changed': z.strictObject({}),
  'primer.status': z.object({ status: PrimerStatusSchema }),
} as const satisfies Record<EventType, z.ZodType>;

export type EventDataMap = { [K in EventType]: z.infer<(typeof EventDataSchemas)[K]> };

/** Event types whose envelope must carry `sid`. */
export const SID_REQUIRED: ReadonlySet<EventType> = new Set<EventType>([
  EVENT.SESSION_ADDED,
  EVENT.SESSION_REMOVED,
  EVENT.SESSION_UPDATED,
  EVENT.SESSION_DONE,
  EVENT.SESSION_WAITING,
  EVENT.SESSION_REMINDER,
  EVENT.PENDING_OPENED,
  EVENT.PENDING_RESOLVED,
  ...MOVE_EVENT_TYPES,
  EVENT.MOVE_CLEARED,
  EVENT.SEND_PROGRESS,
  EVENT.REWRITE_PROGRESS,
  EVENT.FILES_CHANGED,
]);

/** Event types whose envelope must carry `account`. */
export const ACCOUNT_REQUIRED: ReadonlySet<EventType> = new Set<EventType>([EVENT.USAGE_THRESHOLD]);

// ---------------------------------------------------------------------------
// Envelopes

function variant<K extends EventType>(type: K) {
  return z.object({
    seq: z.number().int().positive(),
    ts: IsoDateSchema,
    type: z.literal(type),
    sid: z.string().min(1).optional(),
    account: AccountIdSchema.optional(),
    data: EventDataSchemas[type] as (typeof EventDataSchemas)[K],
  });
}

const variants = EVENT_TYPES.map((t) => variant(t)) as unknown as [
  ReturnType<typeof variant<EventType>>,
  ...ReturnType<typeof variant<EventType>>[],
];

const EventUnionSchema = z.discriminatedUnion('type', variants);

/** A daemon event. Also checks the per-type `sid` / `account` requirements. */
export const EventSchema = EventUnionSchema.superRefine((ev, ctx) => {
  if (SID_REQUIRED.has(ev.type) && !ev.sid) {
    ctx.addIssue({ code: 'custom', path: ['sid'], message: `${ev.type} requires sid` });
  }
  if (ACCOUNT_REQUIRED.has(ev.type) && ev.account === undefined) {
    ctx.addIssue({ code: 'custom', path: ['account'], message: `${ev.type} requires account` });
  }
});

/** One event of a given type. */
export type EventOf<K extends EventType> = K extends EventType
  ? {
      seq: number;
      ts: string;
      type: K;
      sid?: string;
      account?: number;
      data: EventDataMap[K];
    }
  : never;

/** Any daemon event (a discriminated union on `type`). */
export type DaemonEvent = EventOf<EventType>;

/** What an emitter passes to the store; the store assigns `seq` (and `ts` if absent). */
export type EventInput<K extends EventType = EventType> = K extends EventType
  ? {
      type: K;
      sid?: string;
      account?: number;
      ts?: string;
      data: EventDataMap[K];
    }
  : never;

export function isEventType(t: string): t is EventType {
  return (EVENT_TYPES as readonly string[]).includes(t);
}

export function isAlertEvent(ev: DaemonEvent): ev is EventOf<(typeof ALERT_EVENT_TYPES)[number]> {
  return (ALERT_EVENT_TYPES as readonly string[]).includes(ev.type);
}

export function isMoveEvent(ev: DaemonEvent): ev is EventOf<(typeof MOVE_EVENT_TYPES)[number]> {
  return (MOVE_EVENT_TYPES as readonly string[]).includes(ev.type);
}

/** Parse and validate one event; throws a readable error on bad input. */
export function parseEvent(input: unknown): DaemonEvent {
  const r = EventSchema.safeParse(input);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new Error(`invalid event: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'unknown'}`);
  }
  return r.data as DaemonEvent;
}
