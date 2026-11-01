/**
 * The state every client (web, phone, CLI, notifiers) rebuilds from the event
 * stream with `reduce()`. The daemon's store holds the same object.
 */
import { z } from 'zod';
import {
  AccountIdSchema,
  AccountSchema,
  AccountsModeSchema,
  AlertSchema,
  FeaturesSchema,
  IsoDateSchema,
  LaunchJobSchema,
  MoveSchema,
  NO_FEATURES,
  NodeViewSchema,
  PendingRequestSchema,
  RewriteJobSchema,
  SendJobSchema,
  SessionSchema,
  type Features,
} from './models.js';
import { PrimerStatusSchema } from './primer.js';

export const DaemonInfoSchema = z.object({
  protocol: z.number().int().positive(),
  daemonVersion: z.string(),
  webHash: z.string().nullable(),
  /** v0.3 feature switches (see FeaturesSchema); absent = everything off. */
  features: FeaturesSchema.optional(),
  /** v0.4: single (one Claude login) or cswap (many accounts); absent from older daemons (= cswap). */
  accountsMode: AccountsModeSchema.optional(),
});
export type DaemonInfo = z.infer<typeof DaemonInfoSchema>;

export const StateSchema = z.object({
  /** seq of the last event applied (0 = none). */
  seq: z.number().int().nonnegative(),
  /** sid -> session */
  sessions: z.record(z.string(), SessionSchema),
  /** pending id -> open or decided card (closed cards are dropped) */
  pending: z.record(z.string(), PendingRequestSchema),
  /** String(account id) -> account */
  accounts: z.record(z.string(), AccountSchema),
  activeAccount: AccountIdSchema.nullable(),
  usage: z.object({
    fetchedAt: IsoDateSchema.nullable(),
    source: z.enum(['cache', 'cli']).nullable(),
  }),
  /** sid -> move in progress, parked or stuck */
  moves: z.record(z.string(), MoveSchema),
  /** job id -> send job (recent ones) */
  sends: z.record(z.string(), SendJobSchema),
  /** v0.3: job id -> rewrite job (recent ones, capped at REWRITE_CAP; no text) */
  rewrites: z.record(z.string(), RewriteJobSchema),
  /** v0.3: launch id -> launch job (recent ones, capped at LAUNCH_CAP) */
  launches: z.record(z.string(), LaunchJobSchema),
  /**
   * v0.3: sid -> how many `files.changed` events that session has had: a
   * counter (never a path) that moves on every Write or Edit, so the Files
   * views refresh even when the count of changed files stays the same.
   * Absent from daemons before it existed.
   */
  fileTicks: z.record(z.string(), z.number().int().nonnegative()).optional(),
  /**
   * v0.4: how many `life.changed` events there have been. One counter for
   * all of Life and the Intel shelf, never per module, so a read-only device
   * learns only that something changed. Absent from older daemons.
   */
  lifeTick: z.number().int().nonnegative().optional(),
  /**
   * v0.4: who primes free 5-hour windows, and Jantar's last prime (the last
   * `primer.status`). Absent until the daemon's primer reports, and from
   * older daemons.
   */
  primer: PrimerStatusSchema.optional(),
  /** newest first, capped at ALERTS_CAP */
  alerts: z.array(AlertSchema),
  daemon: DaemonInfoSchema.nullable(),
  /**
   * v0.6: node id -> paired machine (Fleet). Empty, or absent from older
   * daemons, while no server is paired: the phone then shows exactly what
   * v0.5 showed. Its sessions sit in `sessions` with `node` set.
   */
  nodes: z.record(z.string(), NodeViewSchema).optional(),
});
export type State = z.infer<typeof StateSchema>;

export function emptyState(): State {
  return {
    seq: 0,
    sessions: {},
    pending: {},
    accounts: {},
    activeAccount: null,
    usage: { fetchedAt: null, source: null },
    moves: {},
    sends: {},
    rewrites: {},
    launches: {},
    fileTicks: {},
    lifeTick: 0,
    alerts: [],
    daemon: null,
    nodes: {},
  };
}

/** The feature switches in a state (everything off until the daemon reports them). */
export function stateFeatures(state: Pick<State, 'daemon'>): Readonly<Features> {
  return state.daemon?.features ?? NO_FEATURES;
}
