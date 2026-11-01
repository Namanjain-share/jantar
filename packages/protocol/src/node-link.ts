/**
 * v0.6 Fleet: the link between a paired server (a node) and the hub.
 *
 * One WebSocket per node, dialled by the node to `<remote.publicUrl>` +
 * NODE_LINK_PATH, through the hub's own front door. Text frames, one JSON
 * message each, `k` naming the kind; both ends check every frame with the
 * schemas here. Pinned Ed25519 keys both ways: the node checks the hub's
 * signature against the key in its join line, the hub the node's against
 * the key it paired with. The signed texts are protocol: build them only
 * with `pairSigText` and `linkSigText`.
 *
 *   hub  -> node  challenge {v, nonce}
 *   node -> hub   auth {nodeId, nonce, proto, version, os, backend, readOnly, accessRefused, sig}
 *   hub  -> node  welcome {sig, name}
 *   node -> hub   snapshot {state} | {bulk}     exactly once, first after welcome
 *   node -> hub   event {event}                  the node's own events, re-emitted by the hub after checks
 *   hub  -> node  call {id, route, params, query, body?, idem?, actor, bulk?}
 *   node -> hub   result {id, status, body} | {id, status, bulk}
 *   both          chunk {id, i, data}            a bulk's bytes, base64, in order
 *   both          heartbeat {ts}
 *
 * Not exported from the package index: it is the subpath
 * `@jantar/protocol/node-link`, imported by the daemon and the fixtures
 * only, so none of it reaches the phone's bundle.
 */
import { z } from 'zod';
import { API_PREFIX } from './constants.js';
import {
  AccountIdSchema,
  AccountSchema,
  AccountsModeSchema,
  AlertSchema,
  FeaturesSchema,
  IsoDateSchema,
  LaunchJobSchema,
  NodeBackendSchema,
  NodeIdSchema,
  NodeOsSchema,
  PendingRequestSchema,
  ScopeSchema,
  SendJobSchema,
  SessionSchema,
} from './models.js';
import type { RouteName } from './api.js';

/** The link's own version. Up on a frame change, or an existing event's schema change an older hub would refuse; a new event type needs none. */
export const NODE_PROTO = 1;

/** Where a node dials (the upgrade is taken before the API sees it). */
export const NODE_LINK_PATH = `${API_PREFIX}/node/link`;

/** The prefix of a join line: `jantar node join jn1.<base64url JSON>`. */
export const JOIN_TOKEN_PREFIX = 'jn1.';

const KIB = 1024;
const MIB = 1024 * KIB;

/** Every limit of the link, by name. */
export const NODE_LIMITS = Object.freeze({
  /** One frame at most, both ways (a larger one closes 1009). The phone's /v1/events stays at 4096. */
  frameBytes: MIB,
  /** One chunk's bytes before base64. */
  chunkBytes: 512 * KIB,
  /** A bulk towards the hub (a result's body, a snapshot) at most. */
  bulkToHubBytes: 16 * MIB,
  /** A bulk towards a node (an upload) at most. */
  bulkToNodeBytes: 20 * MIB,
  /** Bulks being assembled at once, per direction, per link. */
  bulkInFlight: 4,
  /** Calls in flight to one node (the 17th is 429). */
  callsInFlight: 16,
  callTimeoutMs: 30_000,
  /** launchStart and uploadCreate. */
  longCallTimeoutMs: 60_000,
  /** Sessions one node may have on the hub. */
  sessions: 64,
  /** Open cards one node may have on the hub. */
  openCards: 32,
  /** Serialized size of one node's sessions, cards, sends, launches, alerts and view on the hub, after clipping. */
  stateBytes: 4 * MIB,
  /** Any string a node supplies that has no `*_TEXT_MAX` of its own. */
  fieldMax: 1024,
  /** One string leaf of a card's input. */
  cardStringMax: 8_000,
  /** A card's whole input, serialized; over it the input becomes {} with the "too large" line. */
  cardInputBytes: 64 * KIB,
  /** Items per array inside a card's input. */
  cardArrayMax: 200,
  /** Nesting inside a card's input. */
  cardDepthMax: 8,
  /** A card's suggestions: items, and bytes serialized. */
  suggestionsMax: 16,
  suggestionsBytes: 16 * KIB,
  /** A card's questions, and each option label. */
  questionsMax: 8,
  labelMax: 1024,
  /** Events per node per 10 s (the node merges session.updated to stay under; the hub closes 1013 above). */
  eventsPer10s: 300,
  /** Refused events per node per minute before the link closes 4400. */
  refusalsPerMin: 20,
  /** Web Push notifications per node per minute, on top of the global mute. */
  pushesPerMin: 10,
  /** `auth` must arrive within this (else 4408). */
  handshakeMs: 10_000,
  /** Unauthenticated sockets on the hub at once: this plus one per paired node. */
  unauthSockets: 8,
  /** Handshakes a minute per rate key: this plus `handshakesPerNode` per paired node. */
  handshakesPerMin: 10,
  handshakesPerNode: 2,
  /** Added to the hub's replay ring per paired node (fixed when the daemon starts). */
  ringPerNode: 1_000,
  /** The node gives a link up after this long with no frame. */
  watchdogMs: 45_000,
  /** Reconnect waits: the full-jitter cap, the slow retry (Fleet off, Access refused, replaced) and the hourly one (removed, versions differ). */
  backoffCapMs: 60_000,
  slowRetryMs: 600_000,
  hourlyRetryMs: 3_600_000,
  /** A link up this long resets the backoff. */
  backoffResetMs: 60_000,
});

/** Close codes of the link (WebSocket's own 1001, 1009, 1013 too). */
export const NODE_CLOSE = Object.freeze({
  goingAway: 1001,
  tooBig: 1009,
  slow: 1013,
  /** A bad frame, a second snapshot, a bad bulk, too many refusals, over the state budget, a frame the side may not send. */
  protocol: 4400,
  /** Unknown, revoked or idle node key. */
  unknown: 4401,
  /** Fleet was turned off at the Mac. */
  fleetOff: 4403,
  handshakeTimeout: 4408,
  /** A newer link came with the same key. */
  replaced: 4409,
  /** Link versions differ. */
  version: 4426,
  rateLimited: 4429,
});

/**
 * Every id a node supplies (sid, card id, job id, launch id, call id):
 * checked before any lookup. Never `__proto__`: copied into a plain record
 * it would become the record's prototype.
 */
export const NODE_SUPPLIED_ID = /^(?!__proto__$)[A-Za-z0-9_-]{1,80}$/;

/** How the hub finds the node a forwarded route goes to. */
export type NodeTargetKind =
  /** `:sid` names a session; `state.sessions[sid].node` */
  | 'sid'
  /** `:id` names a card; its session's node */
  | 'card'
  /** `:id` names a launch; `state.launches[id].node` */
  | 'launch'
  /** `?node=<id>` names the machine (absent: the Mac) */
  | 'query';

/**
 * The phone's routes a hub forwards to a node, and the only ones a node runs
 * from its link (the route name picks the path; never a path from the hub).
 */
export const NODE_ROUTES = Object.freeze({
  getTranscript: 'sid',
  getScreen: 'sid',
  sendPrompt: 'sid',
  focusSession: 'sid',
  sessionKey: 'sid',
  sessionMode: 'sid',
  sessionCommand: 'sid',
  sessionDialog: 'sid',
  sessionKeypad: 'sid',
  uploadCreate: 'sid',
  uploadDelete: 'sid',
  decidePending: 'card',
  launchGet: 'launch',
  launchAnswer: 'launch',
  launchPreview: 'query',
  launchStart: 'query',
  launchHistory: 'query',
  foldersRoots: 'query',
  foldersList: 'query',
  foldersRecent: 'query',
  foldersPin: 'query',
  foldersCreate: 'query',
  refreshUsage: 'query',
} as const satisfies Partial<Record<RouteName, NodeTargetKind>>);
export type NodeRouteName = keyof typeof NODE_ROUTES;

/** Whether a route name (from a frame) is one a node runs. Own keys only. */
export function isNodeRoute(route: string): route is NodeRouteName {
  return Object.hasOwn(NODE_ROUTES, route);
}

/** Routes that wait `longCallTimeoutMs` instead of `callTimeoutMs`. */
export const LONG_NODE_ROUTES: ReadonlySet<NodeRouteName> = new Set<NodeRouteName>(['launchStart', 'uploadCreate']);

// ---------------------------------------------------------------------------
// Signed texts (protocol: never rebuilt elsewhere)

/** What the hub signs when a node pairs: its id and the public key it claimed with. */
export function pairSigText(nodeId: string, publicKey: string): string {
  return `jantar-node-pair/1\n${nodeId}\n${publicKey}`;
}

/** What each side signs in the handshake: its own label, the node, and both nonces (fresh each time, no clocks). */
export function linkSigText(side: 'node' | 'hub', nodeId: string, hubNonce: string, nodeNonce: string): string {
  return `jantar-node-link/1\n${side}\n${nodeId}\n${hubNonce}\n${nodeNonce}`;
}

// ---------------------------------------------------------------------------
// Frames

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const B64URL_64 = /^[A-Za-z0-9_-]{86}$/;
const NodeSuppliedIdSchema = z.string().regex(NODE_SUPPLIED_ID);

/** A frame's bytes that follow as chunks: their size and sha256 (hex). */
export const BulkSchema = z.strictObject({
  size: z.number().int().nonnegative().max(Math.max(NODE_LIMITS.bulkToHubBytes, NODE_LIMITS.bulkToNodeBytes)),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Bulk = z.infer<typeof BulkSchema>;

/**
 * What a node sends of itself on every (re)connect: its own sessions, open
 * cards, unfinished sends and launches plus the newest 20 of each, the
 * newest 20 alerts, its switches and accounts mode, its accounts and usage.
 * Clipped by the node before sending, and again by the hub.
 */
export const NodeSnapshotSchema = z.object({
  sessions: z.record(z.string(), SessionSchema),
  pending: z.record(z.string(), PendingRequestSchema),
  sends: z.record(z.string(), SendJobSchema),
  launches: z.record(z.string(), LaunchJobSchema),
  alerts: z.array(AlertSchema),
  daemon: z.object({ features: FeaturesSchema, accountsMode: AccountsModeSchema }),
  accounts: z.record(z.string(), AccountSchema),
  activeAccount: AccountIdSchema.nullable(),
  usage: z.object({ fetchedAt: IsoDateSchema.nullable(), source: z.enum(['cache', 'cli']).nullable() }),
});
export type NodeSnapshot = z.infer<typeof NodeSnapshotSchema>;

/** Who a forwarded call is for: the phone (its scopes, never admin), or `cli` for the hub's CLI. */
export const NodeCallActorSchema = z.strictObject({
  deviceId: z.string().min(1).max(128),
  deviceName: z.string().min(1).max(64),
  scopes: z.array(ScopeSchema).max(4),
});
export type NodeCallActor = z.infer<typeof NodeCallActorSchema>;

export const ChallengeFrameSchema = z.strictObject({
  k: z.literal('challenge'),
  v: z.literal(1),
  /** 32 random bytes, base64url. */
  nonce: z.string().regex(B64URL_32),
});

export const AuthFrameSchema = z.strictObject({
  k: z.literal('auth'),
  nodeId: NodeIdSchema,
  nonce: z.string().regex(B64URL_32),
  proto: z.number().int().positive(),
  version: z.string().min(1).max(64),
  os: NodeOsSchema,
  backend: NodeBackendSchema,
  readOnly: z.boolean(),
  /** Cloudflare Access refusals since the node's last good link. */
  accessRefused: z.number().int().nonnegative(),
  sig: z.string().regex(B64URL_64),
});

export const WelcomeFrameSchema = z.strictObject({
  k: z.literal('welcome'),
  sig: z.string().regex(B64URL_64),
  /** The name the hub gave this node. */
  name: z.string().min(1).max(24),
});

/** Exactly one of `state` and `bulk` (the snapshot's JSON follows as chunks with id "snapshot"). */
export const SnapshotFrameSchema = z
  .strictObject({ k: z.literal('snapshot'), state: NodeSnapshotSchema.optional(), bulk: BulkSchema.optional() })
  .refine((f) => (f.state === undefined) !== (f.bulk === undefined), { message: 'a snapshot has a state or a bulk' });

/**
 * One of the node's own events. Only its `type` is checked here: the hub
 * drops a type it does not know before it parses the rest (a newer node's
 * event), so this frame never fails on one.
 */
export const EventFrameSchema = z.strictObject({
  k: z.literal('event'),
  event: z.looseObject({ type: z.string().min(1).max(64) }),
});

/**
 * A phone's call, forwarded. `route` is any string here: the node runs only
 * NODE_ROUTES and answers anything else 404. `bulk`: an upload's bytes follow.
 */
export const CallFrameSchema = z.strictObject({
  k: z.literal('call'),
  id: NodeSuppliedIdSchema,
  route: z.string().min(1).max(64),
  params: z.record(z.string(), z.string().max(1024)),
  query: z.record(z.string(), z.string().max(2048)),
  body: z.unknown().optional(),
  /** `<deviceId>:<Idempotency-Key>`: the node's own cache decides replays. */
  idem: z.string().min(1).max(320).optional(),
  actor: NodeCallActorSchema,
  bulk: BulkSchema.optional(),
});

/** A call's answer: the reply's JSON body, or a bulk carrying it. */
export const ResultFrameSchema = z
  .strictObject({
    k: z.literal('result'),
    id: NodeSuppliedIdSchema,
    status: z.number().int().min(100).max(599),
    body: z.unknown().optional(),
    bulk: BulkSchema.optional(),
  })
  .refine((f) => f.body === undefined || f.bulk === undefined, { message: 'a result has a body or a bulk' });

/** One piece of a bulk: `id` names the frame it completes (a call's or result's id, or "snapshot"). */
export const ChunkFrameSchema = z.strictObject({
  k: z.literal('chunk'),
  id: NodeSuppliedIdSchema,
  i: z.number().int().nonnegative(),
  /** Base64 of at most `chunkBytes` bytes. */
  data: z.string().max(Math.ceil(NODE_LIMITS.chunkBytes / 3) * 4),
});

export const HeartbeatFrameSchema = z.strictObject({
  k: z.literal('heartbeat'),
  ts: IsoDateSchema,
});

/** Every frame kind, by `k`. */
export const NODE_FRAME_SCHEMAS = {
  challenge: ChallengeFrameSchema,
  auth: AuthFrameSchema,
  welcome: WelcomeFrameSchema,
  snapshot: SnapshotFrameSchema,
  event: EventFrameSchema,
  call: CallFrameSchema,
  result: ResultFrameSchema,
  chunk: ChunkFrameSchema,
  heartbeat: HeartbeatFrameSchema,
} as const;
export type NodeFrameKind = keyof typeof NODE_FRAME_SCHEMAS;
export type NodeFrame = { [K in NodeFrameKind]: z.infer<(typeof NODE_FRAME_SCHEMAS)[K]> }[NodeFrameKind];
export type NodeFrameOf<K extends NodeFrameKind> = z.infer<(typeof NODE_FRAME_SCHEMAS)[K]>;

/** Frames each side may send: anything else from that side is a protocol error (4400). */
export const NODE_SENDS: ReadonlySet<NodeFrameKind> = new Set<NodeFrameKind>(['auth', 'snapshot', 'event', 'result', 'chunk', 'heartbeat']);
export const HUB_SENDS: ReadonlySet<NodeFrameKind> = new Set<NodeFrameKind>(['challenge', 'welcome', 'call', 'chunk', 'heartbeat']);

export function isNodeFrameKind(k: unknown): k is NodeFrameKind {
  return typeof k === 'string' && Object.hasOwn(NODE_FRAME_SCHEMAS, k);
}

/** A forwarded call as the hub makes it and the node's executor runs it (the call frame without `k` and `bulk`). */
export type NodeCallRequest = Omit<NodeFrameOf<'call'>, 'k' | 'bulk'>;

/** A call's answer: the node's own status and JSON body, or the hub's node_offline / node_timeout. */
export interface NodeCallReply {
  status: number;
  body: unknown;
}

// ---------------------------------------------------------------------------
// Join lines (`jantar node pair` prints them; `jantar node join` takes one)

/** What a join line carries: the hub's URL, a one-time 128-bit code, and the hub's public key to pin. Nothing long-lived or secret. */
export interface JoinToken {
  /** The hub's front door (an origin: https, or http on loopback for tests). */
  url: string;
  /** The one-time pairing code (base64url). */
  code: string;
  /** The hub's Ed25519 public key: 32 raw bytes, base64url. */
  hubKey: string;
}

export type JoinTokenResult = { ok: true; token: JoinToken } | { ok: false; reason: string };

/** A join line is at most this long. */
export const JOIN_TOKEN_MAX = 1024;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]']);

/** A hub URL a node may dial: https anywhere, http only on this machine's loopback; an origin, no credentials. */
export function hubOrigin(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  if (u.protocol === 'https:') return u.origin;
  if (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)) return u.origin;
  return null;
}

/** The link's WebSocket URL for a hub origin (https -> wss, http -> ws). */
export function linkUrl(origin: string): string {
  return `${origin.replace(/^http/, 'ws')}${NODE_LINK_PATH}`;
}

function bytesOfBase64url(s: string): number | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  return Buffer.from(s, 'base64url').length;
}

/** Encode a join line. Throws on a value that would not decode (a programming error). */
export function encodeJoinToken(t: JoinToken): string {
  const line = `${JOIN_TOKEN_PREFIX}${Buffer.from(JSON.stringify({ u: t.url, c: t.code, h: t.hubKey }), 'utf8').toString('base64url')}`;
  const back = decodeJoinToken(line);
  if (!back.ok) throw new Error(`join line would not decode: ${back.reason}`);
  return line;
}

/** Decode and check a join line. Pure: nothing is fetched or stored. */
export function decodeJoinToken(line: string): JoinTokenResult {
  const bad = (reason: string): JoinTokenResult => ({ ok: false, reason });
  const text = line.trim();
  if (!text.startsWith(JOIN_TOKEN_PREFIX)) return bad(`a join line starts with ${JOIN_TOKEN_PREFIX}`);
  if (text.length > JOIN_TOKEN_MAX) return bad('the join line is too long');
  const body = text.slice(JOIN_TOKEN_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return bad('the join line is mistyped');
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return bad('the join line is mistyped');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return bad('the join line is mistyped');
  const { u, c, h } = json as Record<string, unknown>;
  if (typeof u !== 'string' || typeof c !== 'string' || typeof h !== 'string') return bad('the join line is mistyped');
  const url = hubOrigin(u);
  if (!url) return bad('the join line names an address servers cannot use (https only)');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(c) || (bytesOfBase64url(c) ?? 0) < 16) return bad('the join line is mistyped');
  if (!B64URL_32.test(h) || bytesOfBase64url(h) !== 32) return bad("the join line's key is not a key");
  return { ok: true, token: { url, code: c, hubKey: h } };
}
