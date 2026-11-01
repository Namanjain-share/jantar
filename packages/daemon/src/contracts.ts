/**
 * jantard internal contracts.
 *
 * FROZEN. Every work package implements against these interfaces and none of
 * them edits this file. If a contract has to change, ask the integration
 * owner (see docs/LAYOUT.md); the change then lands in one commit together
 * with every implementation it affects.
 *
 * Ground rules that apply to every implementation:
 * - Everything external is injected through `DaemonContext` (clock, exec,
 *   process probe, paths, binaries, logger), so tests run on a synthetic HOME
 *   with fake binaries and never touch the user's real setup.
 * - External programs run through `ctx.exec` with argv only, never a shell.
 *   osascript gets its script on stdin; user text only ever travels in argv.
 * - Operational failures are values (`{ok:false, ...}`), not exceptions.
 *   Throwing is for programming errors.
 * - Never log or emit prompt bodies, tokens, keys or credential file contents.
 * - State changes go through `ctx.store.emit()`; nobody keeps a second copy of
 *   session / pending / account state.
 */
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Duplex } from 'node:stream';
import type {
  Account,
  AskList,
  AskWriteAction,
  AccountId,
  AccountsMode,
  BillBody,
  BillPaidBody,
  BillPatch,
  BudgetBody,
  DoseBody,
  FoodBody,
  FoodDay,
  FoodEstimate,
  FoodPatch,
  FoodTargetsBody,
  FolderTodoBody,
  FolderTodosResponse,
  IntelCaptureBody,
  IntelItem,
  IntelListQuery,
  IntelListResponse,
  IntelSourcesResponse,
  LifeStatus,
  MedicineBody,
  MedicinePatch,
  MedicinesResponse,
  MoneyBody,
  MoneyMonth,
  MoneyPatch,
  PlaceBody,
  PlacePatch,
  PlacesQuery,
  PlacesResponse,
  PostBody,
  PostGoalsBody,
  PostPatch,
  PostsQuery,
  PostsResponse,
  ProjectBody,
  ProjectPatch,
  ProjectsResponse,
  SnoozePreset,
  Today,
  TodoBody,
  TodoPatch,
  TodosQuery,
  TodosResponse,
  WeightBody,
  EndReason,
  ExtEndBody,
  ExtInfo,
  ExtLinesBody,
  ExtOpenBody,
  ExtShotBody,
  MeetingDetail,
  MeetingPatch,
  MeetingSite,
  MeetingSummary,
  MeetingsList,
  MeetingsQuery,
  MeetingsStatus,
  AuditEntry,
  AttachmentRef,
  ControlKey,
  DaemonEvent,
  DecisionBody,
  Device,
  DialogKind,
  DialogRole,
  ErrorCode,
  EventInput,
  EventOf,
  EventType,
  FileChange,
  FileListing,
  FileOp,
  FileRoot,
  FileStat,
  FileText,
  FilesListQuery,
  FilesTextQuery,
  FolderCreateBody,
  FolderCreateResponse,
  FolderPinBody,
  FolderRecent,
  FoldersListQuery,
  FoldersListResponse,
  HookPayload,
  LaunchAnswerBody,
  LaunchFlags,
  LaunchJob,
  LaunchPreview,
  LaunchPreviewQuery,
  LaunchStartBody,
  Move,
  NotifyKind,
  Pane,
  PaneBackend,
  PaneForeground,
  PatchResult,
  PendingRequest,
  PermissionModeName,
  PlanResponse,
  PushSubscriptionRecord,
  RewriteDetail,
  RewriteJob,
  RewriteModel,
  Scope,
  SendJob,
  SendOrigin,
  Session,
  SessionDialogBody,
  SessionKeypadBody,
  SessionNow,
  Settings,
  SlashCommand,
  State,
  TerminalDialog,
  TranscriptItem,
  UploadInfo,
  MachinesPairBody,
  MachinesPairReply,
  NodeBackend,
  NodeOs,
  NodePairBody,
  NodePairReply,
  NodeRow,
  RouteName,
} from '@jantar/protocol';
import type { NodeCallActor, NodeCallReply, NodeCallRequest, NodeRouteName, NodeSnapshot } from '@jantar/protocol/node-link';

export type Unsubscribe = () => void;

// ===========================================================================
// Injection: clock, exec, process probe, logger, binaries, paths, settings

/** Opaque timer handle (real timers and FakeClock timers both fit). */
export type TimerId = { readonly __timerId: unique symbol };

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** ISO-8601 string of `ms` (default: now). */
  iso(ms?: number): string;
  setTimeout(fn: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId | undefined): void;
  setInterval(fn: () => void, ms: number): TimerId;
  clearInterval(id: TimerId | undefined): void;
  /** Resolves after `ms`; rejects with an AbortError if `signal` aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface ExecOptions {
  cwd?: string;
  /** The child's complete environment (not merged). Default: the daemon's env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Written to stdin, which is then closed. Without it stdin is empty. */
  input?: string;
  /** SIGTERM after this long, SIGKILL 1 s later. Default 15 000. */
  timeoutMs?: number;
  /** Max captured bytes per stream; the rest is dropped and `truncated` set. Default 4 MiB. */
  maxBuffer?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  /** Exit code; null when killed by a signal or never started. */
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  /** Set when the binary could not be started (e.g. ENOENT, EACCES). */
  spawnError?: string;
  durationMs: number;
}

/** Run `file` (an absolute path) with `args`. Never uses a shell. Always resolves. */
export type ExecFile = (file: string, args: readonly string[], opts?: ExecOptions) => Promise<ExecResult>;

export interface ProcessProbe {
  /** `kill(pid, 0)`: true if the pid exists (EPERM counts as alive). */
  isAlive(pid: number): boolean;
}

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

/**
 * Absolute paths to external programs, resolved from settings.bins, then PATH
 * at install time, then well-known locations. null = not available.
 */
export interface Bins {
  node: string;
  ps: string;
  osascript: string | null;
  lsof: string | null;
  cswap: string | null;
  claude: string | null;
  terminalNotifier: string | null;
  /** /usr/sbin/screencapture: terminal screenshots (v0.3). */
  screencapture: string | null;
  tmux: string | null;
  /** /usr/bin/sips: resizes terminal screenshots (v0.3). */
  sips: string | null;
}

/** Every path the daemon uses. Built by `resolvePaths()` in config.ts. */
export interface Paths {
  /** State dir: $JANTAR_HOME or ~/.jantar (mode 0700). */
  home: string;
  configFile: string;
  dbFile: string;
  runDir: string;
  hooksSock: string;
  ctlSock: string;
  logsDir: string;
  pushDir: string;
  vapidFile: string;
  binDir: string;
  /** Installed copy of the hook client: <home>/bin/jantar-hook */
  hookBin: string;
  /** Built web app served at / (packages/web/dist, or $JANTAR_WEB_DIST). */
  webDist: string;
  /**
   * v0.3: terminal screenshots land here for a moment: <runDir>/shots. Not
   * created at startup; whoever writes there creates it 0700 and unlinks
   * every file in a `finally`.
   */
  shotsDir: string;
  /** v0.3: Rewrite's own dir (the empty cwd of each run, the system prompt copy): <home>/rewrite. Created on demand, 0700. */
  rewriteDir: string;
  /** Files shipped with the daemon package (packages/daemon/assets), e.g. assets/rewrite/system-v1.md. Read-only. */
  assetsDir: string;
  /** v0.4: Life's own database, <home>/life.db (0600). Never moved aside, never pruned (life/db.ts). */
  lifeDb: string;
  /** v0.4: nightly copies of life.db, <home>/backups (0700, created on demand). */
  backupsDir: string;
  /** v0.4: the Intel shelf's own files (captures.jsonl), <home>/intel (0700, created on demand). */
  intelDir: string;
  /** v0.4: Ask Claude's run dir (the empty cwd, the system prompt copy), <home>/food-estimate (0700, created on demand). */
  foodEstimateDir: string;
  /**
   * v0.5.3: Ask's run dir, <home>/ask (0700, created on demand): only the
   * system prompt copy and the empty work/ cwd. No chat text is ever
   * written there (turns live in memory).
   */
  askDir: string;
  /**
   * v0.4.2: files from the phone, <home>/uploads/<sid>/<id>.<ext> (dirs 0700,
   * files 0600, created on demand by the UploadStore, swept after
   * UPLOAD_KEEP_MS).
   */
  uploadsDir: string;
  /** v0.5: Meetings' own database, <home>/meetings.db (0600). Refused, never reset, when it will not open (meetings/db.ts). */
  meetingsDb: string;
  /** v0.5: meeting screenshots, <home>/meetings/<meeting id>/<shot id>.jpg (0700 dirs, 0600 files, created on demand). */
  meetingsDir: string;
  /** v0.5: the summary run's dir (the empty cwd, the system prompt copy), <home>/meeting-summary (0700, created on demand). */
  meetingSummaryDir: string;
  /** v0.6: the hub's Fleet files, <home>/fleet (0700, made by the first `jantar fleet on`). */
  fleetDir: string;
  /** v0.6: the hub's Ed25519 key, <home>/fleet/hub-key.pem (PKCS8, 0600). Only its public half ever leaves the Mac (in join lines). */
  hubKeyFile: string;
  /** v0.6: a paired server's own files, <home>/node (0700). */
  nodeDir: string;
  /**
   * v0.6: <home>/node/node.json (0600): written by `jantar node join` once the
   * hub's signature checks, deleted by `jantar node leave`. Its presence makes
   * the daemon a node (config.ts roleOf).
   */
  nodeFile: string;

  /** Read-only inputs, all under the (possibly synthetic) user home. */
  userHome: string;
  /** ~/.claude (default login; its sessions/ and projects/) */
  claudeHome: string;
  /** ~/.claude/settings.json (the hooks installer edits it, nothing else does) */
  claudeSettings: string;
  /** ~/.claude/projects (transcripts, shared by profiles that use --share-history) */
  claudeProjects: string;
  /** ~/.claude-swap-backup */
  cswapRoot: string;
  /** ~/.claude-swap-backup/sessions (one <n>-<slug>/ config dir per profile) */
  cswapProfiles: string;
  cswapSequence: string;
  cswapUsageCache: string;
  /** ~/.config/ccw (read-only while ccw runs) */
  ccwDir: string;
  ccwSwitchDir: string;
  ccwSwitchJson: string;
  ccwBurnJson: string;
  ccwActiveJson: string;
}

export interface SettingsStore {
  get(): Settings;
  /** Validate, deep-merge and save atomically (0600). The daemon is the only writer. */
  patch(patch: unknown): Promise<PatchResult>;
  /** Called after every successful change. */
  subscribe(fn: (next: Settings, prev: Settings) => void): Unsubscribe;
}

// ===========================================================================
// Store / Bus

export type EventListener = (ev: DaemonEvent) => void;

export type Replay =
  | { kind: 'events'; events: DaemonEvent[] }
  | { kind: 'snapshot'; seq: number; state: State };

export interface Bus {
  /** seq of the last emitted event (0 before any). */
  readonly seq: number;
  /**
   * Assign the next seq (and `ts` if absent), validate, apply the shared
   * reducer, keep the event in the replay ring, then notify subscribers.
   * Subscribers always see events in seq order, even when one of them emits
   * from inside its callback. Throws on an invalid event (a programming error).
   */
  emit<K extends EventType>(input: EventInput<K>): EventOf<K>;
  /** Called with every event after it has been applied. Listener errors are caught and logged. */
  subscribe(fn: EventListener): Unsubscribe;
  /**
   * WebSocket resume: the events after `after`, or a snapshot when `after` is
   * older than the ring or newer than `seq` (the daemon restarted).
   */
  replay(after: number): Replay;
}

export interface Store extends Bus {
  getState(): Readonly<State>;
  snapshot(): { seq: number; state: State };
  /** Changes on every daemon start (sent in `hello`). */
  readonly epoch: string;
}

// ===========================================================================
// Db (SQLite in WAL mode at paths.dbFile; synchronous API)

export interface EventLog {
  append(ev: DaemonEvent): void;
  /** Events with seq > after, oldest first. */
  since(after: number, opts?: { limit?: number; types?: readonly EventType[] }): DaemonEvent[];
  /** Newest first (feeds such as GET /alerts). */
  latest(opts: { limit: number; types?: readonly EventType[]; after?: number }): DaemonEvent[];
  /** Highest stored seq, 0 when empty. The store continues from here after a restart. */
  maxSeq(): number;
  /** Delete all but the newest `keep` events; returns how many were deleted. */
  prune(keep: number): number;
}

export interface AuditLog {
  append(entry: Omit<AuditEntry, 'seq'>): AuditEntry;
  /** Oldest first after `after`; newest `limit` when `after` is absent. */
  list(opts?: { after?: number; limit?: number }): AuditEntry[];
}

export interface DeviceRepo {
  insert(device: Device): void;
  get(id: string): Device | null;
  byKeyHash(keyHash: string): Device | null;
  list(): Device[];
  touch(id: string, at: string): void;
  revoke(id: string, at: string): Device | null;
  /** v0.3: replace a device's scopes (already normalized by the caller). Null for an unknown id. */
  setScopes(id: string, scopes: readonly Scope[]): Device | null;
}

export interface PushSubRepo {
  /** Keyed by subscription endpoint. */
  upsert(rec: PushSubscriptionRecord): void;
  remove(endpoint: string): boolean;
  removeForDevice(deviceId: string): number;
  list(): PushSubscriptionRecord[];
}

export interface PendingHistory {
  /** Insert or replace by id. */
  record(p: PendingRequest): void;
  get(id: string): PendingRequest | null;
  list(opts?: { sid?: string; limit?: number }): PendingRequest[];
}

/** Small persistent flags: reminder "told" marks, cooldowns, VAPID metadata, ... */
export interface KvStore {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

/** v0.3: every launch, saved at each stage change (migration 3, table `launches`). */
export interface LaunchRepo {
  /** Insert or replace by id. */
  save(job: LaunchJob): void;
  get(id: string): LaunchJob | null;
  /** Newest first (by createdAt). `unfinished`: only jobs not at a final stage (LAUNCH_FINAL_STAGES). */
  list(opts?: { limit?: number; unfinished?: boolean }): LaunchJob[];
}

export interface FolderPin {
  rootId: string;
  /** Relative path under the root ('' = the root itself). */
  rel: string;
  label?: string;
  pinnedAt: string;
  /** Actor id ("device:<id>" or "cli"). */
  by: string;
}

/** A folder a session ran in (one row per cwd, updated on every session.added). */
export interface FolderSeen {
  /** Absolute realpath. */
  cwd: string;
  lastSeenAt: string;
  account?: AccountId;
  name?: string;
}

/** v0.3: pinned folders and folders sessions ran in (tables `folders_pinned`, `folders_seen`). */
export interface FolderRepo {
  /** Insert or replace by (rootId, rel). */
  pin(p: FolderPin): void;
  /** False when it was not pinned. */
  unpin(rootId: string, rel: string): boolean;
  pins(): FolderPin[];
  /** Insert or replace by cwd. */
  seen(row: FolderSeen): void;
  /** Newest first. */
  recentSeen(limit: number): FolderSeen[];
}

/** v0.3: the launch flags each actor last started a session with (table `launch_flags`; the start sheet begins there). */
export interface LaunchFlagsRepo {
  /** `actor` is an actor id: "device:<id>" or "cli". */
  get(actor: string): LaunchFlags | null;
  set(actor: string, flags: LaunchFlags, at: string): void;
}

/** One headless Rewrite run, for burn attribution. Never any text. */
export interface RewriteRun {
  id: string;
  at: string;
  account: AccountId | null;
  model: string;
  ok: boolean;
  ms: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  promptVersion: string | null;
  /** "ready", or a RewriteFailure code. */
  outcome: string;
}

/** v0.3: table `rewrite_runs`. */
export interface RewriteRunRepo {
  /** Insert or replace by id. */
  record(run: RewriteRun): void;
  /** Newest first. */
  list(opts?: { limit?: number }): RewriteRun[];
}

/**
 * v0.5: a paired Chrome extension (migration 4, table `extensions`). Its key
 * is stored only as `sha256('jantar-extension-key:' + key)`; the Origin it
 * claimed from is bound to it.
 */
export interface ExtensionRecord {
  id: string;
  keyHash: string;
  /** chrome-extension://<EXTENSION_ID>, bound at the claim. */
  origin: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

/**
 * v0.6: a paired server (migration 5, table `nodes`). The hub keeps its
 * public key only; the name is the hub's (unique among live nodes). A
 * revoked row stays, for the audit log.
 */
export interface NodeRecord {
  /** A ulid. */
  id: string;
  name: string;
  /** Ed25519 public key: 32 raw bytes, base64url. */
  publicKey: string;
  os: NodeOs;
  /** Its Jantar version at pairing, then at each handshake. */
  version: string;
  createdAt: string;
  /** Written at most every 5 minutes while linked. */
  lastSeenAt: string | null;
  revokedAt: string | null;
}

/** v0.6: table `nodes` (auth/nodes.ts is its only writer). */
export interface NodesRepo {
  /** Throws when a live node already has the name (a unique index): the caller checks first. */
  insert(rec: NodeRecord): void;
  get(id: string): NodeRecord | null;
  /** The live (not revoked) node with this name, if any. */
  byName(name: string): NodeRecord | null;
  /** Oldest first, revoked ones included. */
  list(): NodeRecord[];
  touch(id: string, at: string): void;
  /** The OS and version a node reported on its latest handshake. */
  setInfo(id: string, info: { os: NodeOs; version: string }): void;
  /** Sets revokedAt (once); null for an unknown id. */
  revoke(id: string, at: string): NodeRecord | null;
}

/** v0.5: table `extensions` (auth/extensions.ts is its only user). */
export interface ExtensionsRepo {
  insert(rec: ExtensionRecord): void;
  get(id: string): ExtensionRecord | null;
  byKeyHash(keyHash: string): ExtensionRecord | null;
  /** Oldest first, revoked ones included. */
  list(): ExtensionRecord[];
  touch(id: string, at: string): void;
  /** Sets revokedAt (once); null for an unknown id. */
  revoke(id: string, at: string): ExtensionRecord | null;
}

export interface Db {
  readonly events: EventLog;
  readonly audit: AuditLog;
  readonly devices: DeviceRepo;
  readonly pushSubs: PushSubRepo;
  readonly pending: PendingHistory;
  readonly kv: KvStore;
  /** v0.3 */
  readonly launches: LaunchRepo;
  readonly folders: FolderRepo;
  readonly launchFlags: LaunchFlagsRepo;
  readonly rewriteRuns: RewriteRunRepo;
  /** v0.5 */
  readonly extensions: ExtensionsRepo;
  /** v0.6 */
  readonly nodes: NodesRepo;
  close(): void;
}

/** Opens (and migrates) the database. */
export type DbOpener = (paths: Paths, log: Logger) => Db;

// ===========================================================================
// Context handed to every module

export interface DaemonContext {
  readonly version: { readonly daemon: string; readonly protocol: number };
  readonly paths: Paths;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly settings: SettingsStore;
  readonly bins: Bins;
  readonly clock: Clock;
  readonly exec: ExecFile;
  readonly proc: ProcessProbe;
  readonly log: Logger;
  readonly store: Store;
  readonly db: Db;
  /**
   * v0.4: one Claude login ("single", account 0) or cswap's accounts
   * ("cswap"), resolved once at start by config.ts resolveAccountsMode
   * (JANTAR_ACCOUNTS=single forces single; else cswap when bins.cswap is
   * found and paths.cswapProfiles exists). Read by usage, sessions, the
   * launcher, Rewrite and Ask Claude; sent as state.daemon.accountsMode.
   */
  accountsMode(): AccountsMode;
}

/** Something with a lifecycle. `stop()` must clear every timer, watcher and socket. */
export interface Service {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Who asked for something. Written to the audit log as `actorId()` (core/actor.ts).
 * v0.5's `extension` is the paired Chrome extension on its capture routes:
 * every check that lets an actor act names the kinds it allows (cli, a
 * device with a scope), so a kind it does not name is refused.
 */
export type Actor =
  | { kind: 'device'; deviceId: string; scopes: readonly Scope[] }
  | { kind: 'cli' }
  | { kind: 'system' }
  | { kind: 'extension'; extensionId: string };

// ===========================================================================
// Sources (work package B)

/** One Claude session file as read from disk, before hooks / transcripts are merged in. */
export interface SessionRecord {
  sid: string;
  pid: number;
  procStart: string;
  version?: string;
  /** The config dir the file was found under (~/.claude or a cswap profile dir). */
  configDir: string;
  account: AccountId | null;
  cwd: string;
  name?: string;
  entrypoint: string;
  kind?: string;
  /** Claude's own status word ("busy", "idle", "waiting", ...). */
  rawStatus: string;
  waitingFor?: string;
  /** Epoch ms. */
  statusUpdatedAt?: number;
  updatedAt?: number;
  startedAt?: number;
  /** Absolute path of the session file. */
  file: string;
}

/**
 * Discovers sessions in ~/.claude/sessions and every cswap profile's
 * sessions/ dir. Drops dead pids, reused pids (procStart mismatch, `ps` run
 * with LC_ALL=C) and headless sdk-cli sessions; dedupes by sid. While
 * started it emits session.added / updated / removed (status merged with
 * core/status.ts).
 */
export interface SessionSource extends Service {
  scan(): Promise<SessionRecord[]>;
  current(): readonly SessionRecord[];
  /** The cswap account a config dir belongs to (null if unknown). */
  accountForConfigDir(configDir: string): AccountId | null;
}

export interface TranscriptEntry {
  /** Byte offset of the line's first byte. */
  offset: number;
  /** Line length in bytes, without the newline. */
  length: number;
  type: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  raw: Record<string, unknown>;
}

export interface TranscriptTail {
  now?: SessionNow;
  lastReply?: { text: string; at: string };
  /** Timestamp of the newest real user prompt (a reply older than this is stale). */
  lastUserPromptAt?: string;
  mode?: string;
  away?: string;
  errorLast?: string;
}

/** Reads `<projects>/<encoded cwd>/<sid>.jsonl` files. Caches paths and offsets; no glob per call. */
export interface TranscriptReader {
  pathFor(
    sid: string,
    hint?: { cwd?: string; configDir?: string; transcriptPath?: string },
  ): Promise<string | null>;
  /** Current byte length (the writer records it before typing). */
  size(path: string): Promise<number>;
  /** Complete lines from `offset`; a partial last line is left for the next call. */
  readFrom(
    path: string,
    offset: number,
    opts?: { maxBytes?: number },
  ): Promise<{ entries: TranscriptEntry[]; next: number }>;
  /** Bounded tail parse for display. */
  tail(path: string): Promise<TranscriptTail>;
  /** GET /sessions/:sid/transcript (text only in v0.1), newest first. */
  page(
    sid: string,
    opts: { before?: string; limit: number },
  ): Promise<{ items: TranscriptItem[]; nextBefore: string | null }>;
}

/**
 * Watches transcripts of live sessions: emits session.updated (now, lastReply,
 * mode, away, errorLast; statusSource "transcript" when it infers status) and
 * alert.blocked / rejected / limit / error. First read backfills at most
 * ALERT_BACKFILL_BYTES.
 */
export type TranscriptWatcher = Service;

export interface UsageSnapshot {
  accounts: Account[];
  activeAccount: AccountId | null;
  fetchedAt: string;
  source: 'cache' | 'cli';
}

/**
 * cswap usage. Reads sequence.json + cache/usage.json (schemaVersion 2,
 * identity-checked) for display. At most one env-scrubbed `cswap list --json`
 * poller, and only when settings.usage.poller allows it. Never touches
 * tokens, credentials or the usage endpoint. Emits usage.updated and
 * usage.threshold.
 */
export interface UsageSource extends Service {
  read(): Promise<UsageSnapshot | null>;
  latest(): UsageSnapshot | null;
  /** Debounced; returns at once. */
  requestRefresh(reason: string): { queued: boolean; reason?: string; nextAllowedAt: string | null };
  isPolling(): boolean;
}

export interface CcwBurn {
  sid: string;
  pctPerMin: number;
  updatedAt: string;
}

/** Read-only view of the legacy ccw tool's files while it still runs. Never writes there. */
export interface CcwLegacySource extends Service {
  /** ~/.config/ccw exists. */
  present(): boolean;
  /** ccw's bot is running (then ccw keeps cswap's cache fresh and owns autoswitch). */
  botRunning(): Promise<boolean>;
  moves(): Promise<Move[]>;
  moveFor(sid: string): Promise<Move | null>;
  /** ccw holds `<sid>.lock`: a move is in progress, do not type. */
  moveLocked(sid: string): Promise<boolean>;
  burn(): Promise<CcwBurn[]>;
  plan(): Promise<PlanResponse>;
  switchConfig(): Promise<{ on: boolean; dryRun: boolean; hold: AccountId[]; groups: string[][] } | null>;
}

// ===========================================================================
// Hooks bridge (work package C)

export type DecideResult =
  | { ok: true; pending: PendingRequest }
  | {
      ok: false;
      code: 'not_found' | 'conflict' | 'needs_confirm' | 'invalid_request' | 'forbidden';
      message: string;
    };

/**
 * Unix socket server at paths.hooksSock (0600, dir 0700). Accepts hook
 * events only (docs/hook-protocol.md). Holds blocking PermissionRequest
 * hooks open as pending cards; emits pending.opened / resolved and
 * session.updated with statusSource "hook".
 */
export interface HooksBridge extends Service {
  readonly socketPath: string;
  open(): PendingRequest[];
  get(id: string): PendingRequest | undefined;
  /** Single use: a decided or closed card returns `conflict`. Only paired devices reach this. */
  decide(id: string, decision: DecisionBody, actor: Actor): Promise<DecideResult>;
  /** Validated hook events in client-timestamp order. */
  onHookEvent(fn: (payload: HookPayload) => void): Unsubscribe;
  /** Hook events have been seen for this session. */
  hasHooks(sid: string): boolean;
}

// ===========================================================================
// Terminal and writer (work package D)

export type TerminalErrorCode =
  | 'not_found'
  | 'unreadable'
  | 'permission'
  | 'timeout'
  | 'unsupported'
  | 'failed'
  /** v0.3: the tab is not the one showing in its window, or the window is minimized or hidden (screenshots). */
  | 'not_visible'
  /**
   * v0.4.2: a compare-and-type write (`PressKeyOptions.expect`) found the
   * tab no longer showing the expected text, so nothing was typed.
   */
  | 'changed';

export type OpResult<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; code: TerminalErrorCode; reason: string };

export interface PaneTarget {
  tty?: string;
  pid?: number;
  sid?: string;
}

/** v0.3: `pressKey` options. */
export interface PressKeyOptions {
  /** Press the key this many times in one write (up and down only; default 1, at most 20). */
  repeat?: number;
  /**
   * clearInput only, and required for it: the rows Claude's input box shows
   * (InputBox.rows, 1 to 30), read under the pane's writer lock just before.
   * The bytes are cut to that draft; without it nothing is typed.
   */
  rows?: number;
  /**
   * v0.4.2, with up, down and enter only: text typed after the arrows in the
   * same write (a dialog's input row). 2 to 700 characters, one line, no
   * control characters, the leading-character and `@` rules of
   * DialogTextSchema; refused otherwise, before anything runs.
   */
  text?: string;
  /**
   * v0.4.2, any key: compare-and-type. The write happens only if the tab's
   * text, read inside the same AppleScript run just before `do script`,
   * still contains this exact text (case and white space count): otherwise
   * nothing is typed and the result is `{ok: false, code: 'changed'}`. The
   * caller passes the raw lines it parsed (terminal/dialog.ts rawSlice). An
   * empty value or one holding NUL is refused before osascript runs.
   *
   * v0.5.2: or the two parts of those lines around the time in Claude's
   * auto-block countdown (terminal/dialog.ts rawExpect), the second found
   * right after the first with only a time (1 to TYPEIF_GAP_CHARS digits and
   * colons) between them. Up to EXPECT_PARTS_MAX parts, each with at least
   * EXPECT_PART_MIN characters other than white space (terminal-app/keys.ts),
   * or nothing runs.
   */
  expect?: string | readonly string[];
}

/** v0.3: what `getScreenshot` is asked for. */
export interface ScreenshotRequest {
  /** Long edge in px after `sips -Z` (default settings.screenshots.maxEdge). */
  maxEdge?: number;
  format?: 'png' | 'jpeg';
  /**
   * 'never' (default): capture only when the pane's tab is the selected one,
   * else fail with 'not_visible'. 'if-safe': select it, capture, re-select the
   * previous tab, but never while Terminal is the active app and this is its
   * front window (that would take the user's keystrokes).
   */
  select?: 'never' | 'if-safe';
  /** Native resolution (cap SCREENSHOT_FULL_MAX_BYTES instead of SCREENSHOT_MAX_BYTES). */
  full?: boolean;
}

/** v0.3: one capture of a pane's Terminal window. */
export interface TerminalShot {
  bytes: Buffer;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  at: string;
  windowId: string;
  /** A background tab was selected for the capture (and the previous one re-selected). */
  disturbed: boolean;
}

export interface TerminalBackend {
  readonly kind: PaneBackend;
  available(): Promise<boolean>;
  findPane(target: PaneTarget): Promise<Pane | null>;
  /**
   * Last `lines` lines of visible text. Bounded: never the full scrollback.
   * v0.4.1: `tabRows` is the tab's height in rows, where the backend can tell
   * (Clear draft refuses without it: controls/keys.ts).
   * v0.4.2: `raw` is the tab's visible text exactly as the terminal gave it
   * (its own line ends and trailing spaces), where the backend can give it;
   * the dialog answer and the keypad parse it and cut their compare-and-type
   * text from it, and refuse without it.
   */
  readScreen(pane: Pane, opts?: { lines?: number }): Promise<OpResult<{ text: string; at: string; tabRows?: number; raw?: string }>>;
  /** Text in Claude's input box. `styled: false` = the backend cannot tell a dim suggestion from a draft. */
  readInputBox(pane: Pane): Promise<OpResult<{ text: string; styled: boolean }>>;
  /** Type literal text with no implicit newline. */
  type(pane: Pane, text: string): Promise<OpResult>;
  pressEnter(pane: Pane): Promise<OpResult>;
  /** Clear a one-row input line (End, then Ctrl-U), where the backend can. */
  clearInput?(pane: Pane): Promise<OpResult>;
  focus(pane: Pane): Promise<OpResult>;
  foregroundOf(pane: Pane): Promise<PaneForeground>;

  /**
   * v0.3 (WP-L, terminal-app/open-window.ts): open a NEW Terminal window that
   * runs `command` (the launcher builds it; it never holds a control
   * character), then re-raise the window that was in front before. Never
   * types into an existing tab.
   */
  openWindow?(command: string): Promise<OpResult<{ tty: string; windowId: string }>>;
  /**
   * v0.3 (WP-C, terminal-app/keys.ts): type one whitelisted key's bytes. A
   * whitelist, not a way around `type()`'s refusal of control characters:
   * only ControlKey names come in. On Terminal.app every write ends with one
   * Return (`do script`), which in a menu is the selection itself. Callers
   * apply the gates (controls/keys.ts) and hold the pane's writer lock.
   */
  pressKey?(pane: Pane, key: ControlKey, opts?: PressKeyOptions): Promise<OpResult>;
  /** v0.3 (WP-C, terminal-app/shot.ts): an image of the pane's window (`screencapture -l`, never by focusing it). */
  getScreenshot?(pane: Pane, opts?: ScreenshotRequest): Promise<OpResult<TerminalShot>>;
  /**
   * v0.6: a backend with work of its own between calls (tmux's 10 s tick that
   * ties live sessions to panes and sets `session.paneId`). daemon.ts starts
   * it with the other services, after the writer, and stops it in reverse;
   * the --read-only wrapper passes both through.
   */
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export interface SubmitRequest {
  sid: string;
  text: string;
  onDraft: 'refuse' | 'replace';
  idempotencyKey?: string;
  actor: Actor;
  /** v0.3: copied onto the job (SendJob.origin). Computed by the API from a rewrite job, never taken from a client. */
  origin?: SendOrigin;
}

export type SubmitResult =
  | { ok: true; job: SendJob; duplicate: boolean }
  | { ok: false; code: 'not_found' | 'refused'; reason: string; job?: SendJob };

/**
 * One queue per pane, held from precheck to proof (send-with-proof:
 * writer/send.ts). Emits send.progress at every stage; a failure is pushed at once.
 */
export interface Writer extends Service {
  submit(req: SubmitRequest): Promise<SubmitResult>;
  get(jobId: string): SendJob | undefined;
  /** Resolves at a final stage, or after `timeoutMs` with the job as it stands. */
  wait(jobId: string, timeoutMs?: number): Promise<SendJob | undefined>;
  /**
   * v0.3: run `task` holding the pane's lock, the same per-pane queue every
   * send holds from precheck to proof, so a key press, a mode step or a
   * screenshot never lands between a send's typing and its Enter. The task
   * starts after every earlier send on that pane has settled (which can take
   * minutes while one waits for its proof: callers that cannot wait should
   * race it with their own timeout). Resolves or rejects with the task.
   * Never call `submit` and wait for it from inside `task`: the send queues
   * behind the task on the same lock. `submit` refuses /clear (its proof is
   * in the next transcript, writer/text.ts), so /clear is typed under this
   * lock with `type` + `pressEnter` and proven by the SessionStart hook
   * (`source: "clear"`).
   */
  withPaneLock<T>(pane: Pane, task: () => Promise<T>): Promise<T>;
}

// ===========================================================================
// Notifications and API (work package E)

export interface Notification {
  kind: NotifyKind;
  title: string;
  body: string;
  sid?: string;
  pendingId?: string;
  /** Path to open when tapped, e.g. "/s/<sid>?card=<id>". */
  url?: string;
  /** Collapses repeats (one per session and kind). */
  tag?: string;
  ts: string;
  /**
   * v0.4: only devices holding this scope get it (Web Push drops every
   * subscription whose device lacks it). Life pushes carry `control`, so a
   * read-only device never gets a medicine or a bill.
   */
  minScope?: Scope;
  /**
   * v0.5.3: Claude's countdown runs out then (ISO); urgent group, TTL from it.
   * Only on a `permission` push (protocol alertGroupOf).
   */
  deadline?: string;
}

export interface Notifier {
  /** v0.5.3: unchanged (a Pushover channel is not in this release). */
  readonly channel: 'webpush' | 'mac' | 'telegram';
  /** `offline` (v0.5.3): failures where the push never left the Mac: DNS or connect. */
  send(n: Notification): Promise<{ delivered: number; failed: number; offline?: number }>;
}

/**
 * v0.5.3: finds a session's terminal pane (api/services.ts PaneLookup: a 5 s
 * cache, one lookup per session at a time, 'timeout' after
 * PANE_LOOKUP_TIMEOUT_MS). daemon.ts builds one and gives it to the API and
 * to the notification router (the countdown probe), so both share it.
 */
export interface PaneFinder {
  find(session: Session): Promise<Pane | null | 'timeout'>;
}

/** Subscribes to the bus; applies kinds, mute, settle delay and 10/30 min reminders; fans out. */
export type NotificationRouter = Service;

/**
 * Fastify on 127.0.0.1:<port> plus the same API on paths.ctlSock for the CLI.
 * v0.6: on a node there is no TCP listener at all; the API is the control
 * socket plus the in-process `link` app the hub's calls run through.
 */
export interface ApiServer extends Service {
  address(): { host: string; port: number } | null;
  /** v0.6: the link app on a node (null on the hub, and before start). */
  link(): LinkInjector | null;
}

// ===========================================================================
// v0.3: Files, Rewrite, Folders + launch, Controls
//
// Each part is wired here through `<part>/index.ts`, which imports the
// implementation from `<part>/service.ts` (files: also `files/changes.ts`).
// Feature switches (settings *.enabled) are checked by the API before any
// route handler runs; a part still checks its own switch where it acts on
// its own (the changes index only counts while files.enabled).

// --- Files (WP-FP: path policy and content) ---------------------------------

export type FileRefusalCode =
  | 'no_root' // unknown root id
  | 'bad_path' // not a clean relative POSIX path
  | 'protected' // the hard denylist (or extraDeny, or home mode)
  | 'outside' // the realpath left the root (a symlink out, a swap race)
  | 'not_file'
  | 'not_dir'
  | 'missing'
  | 'too_large'
  | 'os_permission' // macOS privacy (TCC) refused the read
  | 'unsupported_type'; // raw bytes asked for anything but an allowlisted image or PDF

/** Why the policy said no. `message` is a sentence the phone can show; it never quotes file content. */
export interface FileRefusal {
  refused: FileRefusalCode;
  message: string;
}

/** A root as the policy knows it: the API's FileRoot plus its realpath. */
export interface ResolvedRoot {
  /** "s.<sid>" (a live session's folder) or "r.<id>" (settings.folders.roots). */
  id: string;
  kind: 'session' | 'configured';
  label: string;
  sid?: string;
  /** realpath of the root dir. */
  real: string;
  /** The path as configured (or the session's cwd) when it is not `real`: paths are matched to roots by both names. Never sent to a client. */
  given?: string;
  /** "~/Desktop/work" */
  display: string;
  /** The root is $HOME (home mode). */
  home: boolean;
}

/** A regular file opened by the policy. Every later read goes through `fh`, never the path; the caller closes it. */
export interface OpenedFile {
  fh: FileHandle;
  /** fh.stat() */
  stat: Stats;
  /** realpath */
  real: string;
  /** Normalized relative path under the root. */
  rel: string;
  root: ResolvedRoot;
}

export interface DirEntryInfo {
  name: string;
  type: 'file' | 'dir' | 'link' | 'other';
  size?: number;
  mtimeMs?: number;
  /** For links: only "inside" links can be opened. */
  link?: 'inside' | 'outside' | 'broken';
}

export interface OpenedDir {
  real: string;
  rel: string;
  root: ResolvedRoot;
  /** Sorted: dirs first, then by name. Protected entries are left out. */
  entries: DirEntryInfo[];
  hiddenProtected: number;
  /** More than `maxScan` entries were there. */
  truncated: boolean;
}

/**
 * The one path authority (v0.3 spec 4.4.2), used by Files, Folders, the
 * launcher and Rewrite's context: roots from the Mac plus live session
 * folders, realpath containment, the hard denylist on the lexical and the
 * real path, O_NOFOLLOW opens. It does not depend on files.enabled. Nothing
 * else in the daemon opens a user file by a path that came from a client.
 */
export interface FilePolicy {
  roots(): Promise<ResolvedRoot[]>;
  root(rootId: string): Promise<ResolvedRoot | null>;
  /** Open a regular file for reading (two-phase check, O_NOFOLLOW, inode re-check). */
  openForRead(rootId: string, rel: string): Promise<OpenedFile | FileRefusal>;
  /** List a dir. Dotfiles only with `hidden` (the denylist still applies); `dirsOnly` for the folder browser. Default maxScan 10 000. */
  openDir(rootId: string, rel: string, opts?: { hidden?: boolean; dirsOnly?: boolean; maxScan?: number }): Promise<OpenedDir | FileRefusal>;
  /** Check a directory without listing it (the launcher re-runs this at start: the folder may have been swapped for a symlink). */
  resolveDir(rootId: string, rel: string): Promise<{ real: string; rel: string; root: ResolvedRoot; display: string } | FileRefusal>;
  /** Whether an absolute path is protected, by name and by realpath prefix (no disk access for the name rules). */
  isProtected(absPath: string): boolean;
  /**
   * Whether an absolute path lies under a root by name alone (the root's
   * realpath or the path it was given as; macOS's /tmp, /var and /etc as
   * /private/...). No disk access past the roots' own (cached): a path
   * outside every root is never resolved, since a realpath under
   * ~/Documents or ~/Desktop can bring up a macOS privacy prompt.
   */
  underRoot(absPath: string): Promise<boolean>;
  /**
   * Which root an absolute path lies under, and its relative path there
   * (changes rows link to the viewer with it). `protected` for a path the
   * denylist names or whose realpath it names; `outside` for one outside
   * every root (by name, never touching the disk) or whose realpath leaves
   * its root; `missing` only inside a root.
   */
  locate(absPath: string): Promise<{ rootId: string; rel: string } | FileRefusal>;
}

/** Bytes for GET /v1/files/raw: an allowlisted image or a PDF whose magic bytes match its extension. The route streams `fh` and closes it. */
export interface RawFile {
  fh: FileHandle;
  size: number;
  /** From the daemon's own table, never from the file. */
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/avif' | 'image/heic' | 'application/pdf';
  /** Basename, for content-disposition. */
  name: string;
}

/**
 * Files (WP-FP): the policy plus the read-only routes. Implementations
 * audit (files.read once per device and path per 10 min, files.denied
 * always), rate-limit per device and push `security` after 5 protected or
 * outside refusals in 10 min. Actor matters for all three and for `roots`
 * (absolute paths only for an admin device or the CLI).
 */
export interface FilesService extends Service {
  readonly policy: FilePolicy;
  roots(actor: Actor): Promise<FileRoot[]>;
  list(q: FilesListQuery, actor: Actor): Promise<FileListing | FileRefusal>;
  stat(q: { root: string; path: string }, actor: Actor): Promise<FileStat | FileRefusal>;
  text(q: FilesTextQuery, actor: Actor): Promise<FileText | FileRefusal>;
  raw(q: { root: string; path: string }, actor: Actor): Promise<RawFile | FileRefusal>;
  /**
   * A refusal the policy gave another part (the folder browser, the start
   * sheet's preview): audited as `files.denied`, and a protected or outside
   * one counts toward the probe alarm, as Files' own do.
   */
  denied(actor: Actor, root: string, rel: string, reason: FileRefusalCode): void;
}

// --- Changed files (WP-FC: the index built from transcripts) ----------------

export interface SessionChanges {
  changes: FileChange[];
  /** Transcript backfill: bytes read so far of `total`. */
  scan: { done: boolean; bytes: number; total: number };
  truncated: boolean;
}

export interface ChangeDetail {
  change: FileChange;
  ops: FileOp[];
}

/**
 * Which files sessions created or changed (U9: no git, no diffs), from
 * Write / Edit / MultiEdit / NotebookEdit tool calls in their transcripts.
 * Fed live by `files.changed` events (the transcript watcher's scanner hook)
 * and backfilled per session on first request. While files.enabled is on it
 * keeps `session.updated {filesChanged}` current (debounced).
 */
export interface ChangesService extends Service {
  /** Null for an unknown session. The first call starts that session's backfill. */
  forSession(sid: string): Promise<SessionChanges | null>;
  change(sid: string, changeId: string): Promise<ChangeDetail | null>;
  /** Across live sessions, newest first. */
  recent(opts: { since?: string; limit: number }): FileChange[];
  /** Absolute paths a session changed (Rewrite's vocabulary). */
  changedPathsFor(sid: string): string[];
}

// --- Rewrite (WP-R) ---------------------------------------------------------

export type RewriteSubmitResult =
  | { ok: true; job: RewriteJob }
  | { ok: false; code: 'not_found' | 'refused' | 'rate_limited' | 'unavailable'; reason: string };

/**
 * Rewrite (U5, U6): one throwaway `cswap run --share-history N -- -p` per
 * request, no tools, hooks off, the fixed system prompt
 * (assets/rewrite/system-v1.md), the context on stdin, 120 s timeout.
 * Texts live only in memory, for REWRITE_TTL_MS after the job ends. Jobs
 * belong to the actor that started them (the API starts them for devices
 * only); everyone else gets null, which the API answers as 404. Every state
 * change emits `rewrite.progress` with the text-free RewriteJob.
 *
 * Hashes (RewriteJob.input.hash, .prompt.hash) are sha256 hex of the text
 * after `trim()`: the web client trims what it sends (sends.post), and the
 * API hashes the body text exactly as received.
 */
export interface RewriteService extends Service {
  /** Answers at once with the queued job (or why not); the run happens in the background. (`start` is the Service lifecycle.) */
  submit(req: { sid: string; text: string; model?: RewriteModel }, actor: Actor): Promise<RewriteSubmitResult>;
  get(jobId: string, actor: Actor): RewriteDetail | null;
  /**
   * Kill the run if any, drop the texts, state "cancelled". 'claimed': a
   * send holds the job (originFor), so the prompt is being typed and the
   * job ends "sent"; it is not cancelled under it.
   */
  cancel(jobId: string, actor: Actor): RewriteJob | 'claimed' | null;
  /**
   * POST /sessions/:sid/prompt with a rewriteJobId: compare `textHash`
   * (sha256 hex of the text being sent) with the job's prompt and input
   * hashes. Null when the job is unknown, another actor's, for another
   * session, or not ready (the API answers 404); 'claimed' while another
   * send with this job is on its way to the writer (409, nothing typed).
   * An origin claims the job for this send until `markSent` (the writer
   * took it) or `releaseOrigin` (it did not), so two sends with one job
   * and different Idempotency-Keys never both type.
   */
  originFor(jobId: string, sid: string, textHash: string, actor: Actor): SendOrigin | 'claimed' | null;
  /** The writer accepted the send: state "sent" with `sendJobId`, texts dropped. */
  markSent(jobId: string, sendJobId: string): void;
  /** The send that claimed the job typed nothing (refused, or a duplicate): the job can be sent again. */
  releaseOrigin(jobId: string): void;
}

// --- Folders and launch (WP-L) ----------------------------------------------

export type LaunchErrorCode = 'not_found' | 'invalid_request' | 'forbidden' | 'conflict' | 'refused' | 'rate_limited' | 'unavailable';

/** A launcher answer: the value, or an API error code and a sentence for the phone. */
export type LaunchResult<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; code: LaunchErrorCode; reason: string };

/** The new-session folder browser (dirs only, through FilesService.policy). */
export interface FolderBrowser {
  roots(actor: Actor): Promise<FileRoot[]>;
  list(q: FoldersListQuery, actor: Actor): Promise<LaunchResult<{ listing: FoldersListResponse }>>;
  recent(actor: Actor): Promise<FolderRecent[]>;
  pin(body: FolderPinBody, actor: Actor): Promise<LaunchResult>;
  /** mkdir without `recursive` (EEXIST: conflict); 10 per hour per device; audited as folder.create. */
  create(body: FolderCreateBody, actor: Actor): Promise<LaunchResult<{ created: FolderCreateResponse }>>;
}

/**
 * New sessions from the phone (U7, U8): a new Terminal window types
 * `cd -- <folder> && cs N -- <launchFlagArgs(flags)> --session-id <uuid> --name <name>`,
 * startup dialogs become "needs you" cards (no auto-trust), the first prompt
 * goes through the writer with proof. Every stage is saved (db.launches) and
 * emitted as `launch.progress`; starts, dialogs and failures are pushed to
 * every device (kind "launch").
 */
export interface Launcher extends Service {
  readonly folders: FolderBrowser;
  preview(q: LaunchPreviewQuery, actor: Actor): Promise<LaunchResult<{ preview: LaunchPreview }>>;
  /**
   * Re-validates everything (switch, scope, rate, folder, account, flags) and
   * runs the job in the background. (`start` is the Service lifecycle.)
   */
  launch(body: LaunchStartBody, actor: Actor, idempotencyKey: string): Promise<LaunchResult<{ job: LaunchJob; duplicate: boolean }>>;
  get(id: string): { job: LaunchJob; screenTail?: string } | null;
  list(opts: { active: boolean }): LaunchJob[];
  /** Refused when the dialog's title changed since the phone showed it. */
  answer(id: string, body: LaunchAnswerBody, actor: Actor): Promise<LaunchResult<{ job: LaunchJob }>>;
}

// --- Controls (WP-C) ---------------------------------------------------------

export type ControlErrorCode =
  | TerminalErrorCode
  | 'refused' // a gate failed: not claude in front, a card open, a ccw move, ...
  | 'rate_limited'
  | 'forbidden'
  | 'mode_unavailable'
  | 'input_not_empty'
  | 'dialog_open'
  | 'escape_unverified'
  | 'tab_not_visible'
  | 'screenshots_off'
  // v0.4.2 (dialog answers, the keypad)
  | 'conflict' // the dialog or screen changed since the phone read it: nothing was typed
  | 'needs_confirm' // a hold row without confirm: true
  | 'invalid_request'; // a row the phone can't answer, text where none goes, none where it must

/** A controls answer: OpResult with the controls' own refusal codes added. */
export type ControlResult<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; code: ControlErrorCode; reason: string };

export interface ScreenshotOptions {
  maxEdge?: number;
  format?: 'png' | 'jpeg';
  /** select=1: allowed only for control scope and screenshots.allowSelect. */
  select?: boolean;
  full?: boolean;
}

export interface ScreenshotResult extends TerminalShot {
  /** sha256 hex of `bytes` (the ETag). */
  etag: string;
  /** Served from the per-pane cache, no new capture. */
  cached: boolean;
}

/**
 * Controls (controls addendum): whitelisted keys behind gates (claude in
 * front, no open card, no dialog for shiftTab / clearInput / interrupt, the
 * pane's writer lock held, audited without screen text), the verified-step
 * mode loop, slash commands through the writer with proof, and screenshots
 * (cache, single flight, limits). Never reachable from ctl.sock.
 */
export interface ControlsService extends Service {
  key(sid: string, key: ControlKey, actor: Actor): Promise<ControlResult>;
  setMode(sid: string, target: PermissionModeName, actor: Actor): Promise<ControlResult<{ mode: PermissionModeName; steps: number }>>;
  command(sid: string, cmd: SlashCommand, actor: Actor): Promise<ControlResult<{ proven: boolean }>>;
  screenshot(sid: string, opts: ScreenshotOptions, actor: Actor): Promise<ControlResult<ScreenshotResult>>;
  /**
   * v0.4.2 (controls/dialog.ts): answer the terminal dialog the phone was
   * shown, by compare-and-type under the pane's writer lock (spec 2.4). Every
   * refusal types nothing; `conflict` when the dialog changed.
   */
  answerDialog(sid: string, body: SessionDialogBody, actor: Actor): Promise<ControlResult<DialogAnswer>>;
  /** v0.4.2 (controls/keypad.ts): arrows and one Return on a screen with no buttons, only while it still shows what the phone saw (spec 3.3). */
  keypad(sid: string, body: SessionKeypadBody, actor: Actor): Promise<ControlResult>;
}

/**
 * What a dialog answer reports. `outcome` and `dialog` go to the phone;
 * `kind`, `role` and `options` (the row count) only to the audit row, which
 * never holds a label, the question, the body or typed text.
 */
export interface DialogAnswer {
  outcome: 'done' | 'unchanged';
  /** The dialog on screen after the answer (the next question, new box states), or null when it closed. */
  dialog: TerminalDialog | null;
  kind: DialogKind;
  role: DialogRole;
  options: number;
}

// --- Uploads (v0.4.2) ---------------------------------------------------------

/** Why an upload call refused; the API answers with the same code and the reason. */
export type UploadErrorCode = Extract<ErrorCode, 'not_found' | 'invalid_request' | 'unsupported_media_type' | 'payload_too_large' | 'refused' | 'not_implemented'>;

export type UploadResult<T extends object = Record<never, never>> = ({ ok: true } & T) | { ok: false; code: UploadErrorCode; reason: string };

/** An attachment ready to name in a prompt: the cleaned-up label comes later (uploads/compose.ts). */
export interface ResolvedUpload {
  /** The label the phone sent, as it sent it. */
  label: string;
  /** Absolute path of the stored file. */
  path: string;
}

/**
 * Files from the phone under paths.uploadsDir (uploads/store.ts), one folder
 * per session. Built by the API's services (ApiServices.uploads), not a
 * daemon part. Never logs a file name, a label or a byte.
 */
export interface UploadStore {
  /** Store one upload of a live session: the type comes from the bytes, the name is generated. */
  save(sid: string, bytes: Buffer, opts: { ext?: string }): Promise<UploadResult<{ upload: UploadInfo }>>;
  /** Remove one upload of this session by id (`not_found` when there is none). */
  remove(sid: string, id: string): Promise<UploadResult>;
  /** The stored files for a prompt's attachments; any one missing refuses the whole list. */
  resolve(sid: string, refs: readonly AttachmentRef[]): Promise<UploadResult<{ files: ResolvedUpload[] }>>;
  /** Delete uploads older than UPLOAD_KEEP_MS; returns how many. */
  sweep(): Promise<number>;
}

// ===========================================================================
// v0.4: Life and the Intel shelf
//
// One daemon part, `life`, with six modules in their own folders
// (life/{todos,medicines,food,places,finance,posts}/; posts since v0.7), one
// database (life.db, its own migrations, refused when corrupt rather than
// reset) and one scheduler that sends every Life push. Nothing here logs or
// emits Life text: the only event is `life.changed {}`, and audit rows carry
// route names and ids.

export type LifeModuleName = 'todos' | 'medicines' | 'food' | 'places' | 'finance' | 'posts';

/**
 * Why a Life, Intel or Meetings call said no. The route turns it into the API
 * error of the same name (estimate_failed: 502; forbidden: 403, a switch the
 * call needs is off, as Meetings' Add to todos while Todos are off).
 */
export type LifeErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'forbidden'
  | 'rate_limited'
  | 'unavailable'
  | 'estimate_failed'
  /** v0.5.3: Ask while life.db is broken (503, as the pipeline answers Life's own routes). */
  | 'life_unavailable';

/**
 * A Life answer: the value, or an error code and a fixed daemon sentence
 * (never user text). `retryAfterMs` goes with rate_limited.
 */
export type LifeResult<T = true> = { ok: true; value: T } | { ok: false; code: LifeErrorCode; reason: string; retryAfterMs?: number };

/**
 * life.db, open (life/db.ts openLifeDb). node:sqlite is synchronous, so
 * every module call is too, except Ask Claude.
 */
export interface LifeDb {
  /** The connection (tests and the backup's VACUUM INTO). */
  readonly raw: DatabaseSync;
  /** The file, or ":memory:". */
  readonly file: string;
  /** A prepared statement, cached per SQL text. */
  prepare(sql: string): StatementSync;
  /** Run `fn` in one transaction (BEGIN IMMEDIATE, COMMIT, ROLLBACK on a throw); a nested call joins the outer one. */
  tx<T>(fn: () => T): T;
  /** The `meta` table: schema, kcal_target, goal_kg10, post_goals (v0.7). */
  meta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  deleteMeta(key: string): void;
  close(): void;
}

/** v0.7: `post`, a post with a day and a time (one row per open timed post, `sub` ''). */
export type PingKind = 'todo' | 'med' | 'refill' | 'bill' | 'post';

/** One row of the `pings` table: what the scheduler sends next for one source. */
export interface PingRow {
  id: string;
  kind: PingKind;
  /** The source's id (a todo, a medicine, a bill, a post). */
  ref: string;
  /** A medicine's dose time ("08:00"); '' for the rest. */
  sub: string;
  /** null: parked (nothing to send until a producer sets it again). */
  nextAt: string | null;
  claimedAt: string | null;
  failures: number;
  lastSentAt: string | null;
}

/** What one Life push says. `kind` is the NotifyKind: med (medicines, refills) or life (todos, bills, posts). */
export interface LifePush {
  kind: 'med' | 'life';
  title: string;
  body: string;
  /** A same-origin app path with ids only: /today?dose=<medId>@<HHMM>, /meds?med=, /todos?id=, /money?bill=, /posts?id=, /posts. */
  url: string;
  /** life:<kind>:<ref>, or med:<HH:MM> (posts:<HH:MM>) for a group: a repeat replaces the notification. */
  tag: string;
}

/** What a module registers for each kind it owns (`scheduler.register`, when the module is built). */
export interface PingHandler {
  readonly kind: PingKind;
  /** Rows of this kind due in the same minute with the same group key go out as one push. */
  group?(row: PingRow): string;
  /** Re-read the source just before sending; `late` = a catch-up. On a thrown error: med and refill send, others skip. */
  check(row: PingRow, dueAt: Date, late: boolean): 'send' | 'skip' | 'cancel';
  /** The push for one or more rows. */
  push(rows: readonly PingRow[], dueAt: Date, late: boolean): LifePush;
  /** The next time strictly after `after`, or null when there is none. */
  next(row: PingRow, after: Date): Date | null;
  /** Rebuild every row of this kind from the sources (start, timezone change, restore). */
  resync(): void;
}

/** The one scheduler (life/scheduler.ts): claim before send, at most once per occurrence, one catch-up after sleep. */
export interface Scheduler {
  register(h: PingHandler): void;
  /** Upsert one row; clears its claim and failures. Producers call it after every write. */
  set(kind: PingKind, ref: string, sub: string, nextAt: Date | null): void;
  /** Remove a source's rows (all of them when `sub` is omitted). */
  clear(kind: PingKind, ref: string, sub?: string): void;
  /** Re-arm the near timer after a write. */
  poke(): void;
}

/** What every module gets. Life text stays inside: nothing here logs or emits it. */
export interface LifeCore {
  /**
   * The open life.db. Read `core.db` on every call; never keep it (or a
   * statement prepared on it) from build time: a restore closes this handle
   * and puts a new one here.
   */
  readonly db: LifeDb;
  /** The Life time zone: settings life.timezone, else the Mac's zone at start. */
  tz(): string;
  now(): Date;
  /** Today's day key in tz(). */
  today(): string;
  settings(): Settings['life'];
  /** Emits `life.changed {}` (after every committed write). */
  changed(): void;
  scheduler: Scheduler;
  /** A ulid. */
  newId(): string;
}

/** What a module builder gets besides the core. */
export interface LifeModuleDeps {
  ctx: DaemonContext;
  sessions: SessionSource;
  usage: UsageSource;
  ccwLegacy: CcwLegacySource;
}

/**
 * One Life module. Its builder registers its PingHandlers with
 * `core.scheduler.register` and returns it. Reads that take a day or month
 * default to today (this month) in the Life zone.
 */
export interface LifeModule {
  readonly name: LifeModuleName;
  /** This module's part of Today for `day`; only modules that are on are asked. */
  today(day: string): Partial<Today>;
  start?(): void;
  stop?(): void;
}

/** Projects and todos (WP-LS). A reminder is a todo with a time. */
export interface TodosModule extends LifeModule {
  readonly name: 'todos';
  listProjects(): LifeResult<ProjectsResponse>;
  createProject(body: ProjectBody, actor: Actor): LifeResult<{ id: string }>;
  updateProject(id: string, patch: ProjectPatch, actor: Actor): LifeResult;
  /** Its todos move to no project. */
  removeProject(id: string, actor: Actor): LifeResult;
  listTodos(q: TodosQuery): LifeResult<TodosResponse>;
  createTodo(body: TodoBody, actor: Actor): LifeResult<{ id: string }>;
  updateTodo(id: string, patch: TodoPatch, actor: Actor): LifeResult;
  /** done=false is Undo (one-off todos; a repeating one answers conflict). Done on a repeating todo moves its due day. */
  setDone(id: string, done: boolean, actor: Actor): LifeResult;
  snooze(id: string, preset: SnoozePreset, actor: Actor): LifeResult;
  removeTodo(id: string, actor: Actor): LifeResult;
  /**
   * v0.5.3 (`jantar mcp` over ctl.sock): the project whose folder holds
   * `folder` (protocol projectFor, the deepest wins; a project linked to `/`,
   * `/Users` or the home folder only for exactly that folder) and its open
   * todos; project null and no todos when none.
   */
  forFolder(folder: string): FolderTodosResponse;
  /** v0.5.3: add a todo to that project; not_found (TODO_REASONS.noFolderProject) when none. */
  createInFolder(body: FolderTodoBody, actor: Actor): LifeResult<{ id: string }>;
}

/** Medicines (WP-MD). */
export interface MedicinesModule extends LifeModule {
  readonly name: 'medicines';
  /** `day` on or before today (default today); after it is invalid_request. */
  get(day?: string): LifeResult<MedicinesResponse>;
  create(body: MedicineBody, actor: Actor): LifeResult<{ id: string }>;
  update(id: string, patch: MedicinePatch, actor: Actor): LifeResult;
  /** Stop taking it from today (POST /v1/medicines/:id/stop); its pings end. Named apart from the lifecycle `stop`. */
  stopTaking(id: string, actor: Actor): LifeResult;
  /** Deletes its doses too. */
  remove(id: string, actor: Actor): LifeResult;
  /** Upsert on (medicine, day, slot): Taken, Skip or Took it at…. */
  logDose(medId: string, body: DoseBody, actor: Actor): LifeResult<{ id: string }>;
  undoDose(medId: string, doseId: string, actor: Actor): LifeResult;
}

/** Food, calories and weight, and Ask Claude (WP-FF). */
export interface FoodModule extends LifeModule {
  readonly name: 'food';
  day(day?: string): LifeResult<FoodDay>;
  add(body: FoodBody, actor: Actor): LifeResult<{ id: string }>;
  update(id: string, patch: FoodPatch, actor: Actor): LifeResult;
  remove(id: string, actor: Actor): LifeResult;
  removeSaved(id: string, actor: Actor): LifeResult;
  setTargets(body: FoodTargetsBody, actor: Actor): LifeResult;
  /** `day` on or before today; replaces that day's weight. */
  setWeight(day: string, body: WeightBody, actor: Actor): LifeResult;
  removeWeight(day: string, actor: Actor): LifeResult;
  /** One headless claude run through rewrite/run.ts's shared runner; saves nothing. `signal` aborts when the request closes. */
  estimate(text: string, signal: AbortSignal, actor: Actor): Promise<LifeResult<FoodEstimate>>;
  /** Whether Ask Claude can run on this Mac (LifeStatus.estimate). */
  estimateStatus(): { available: boolean; reason?: string };
}

/** Cafés (WP-FF). Always sorted by best. */
export interface PlacesModule extends LifeModule {
  readonly name: 'places';
  list(filter: PlacesQuery['filter']): LifeResult<PlacesResponse>;
  create(body: PlaceBody, actor: Actor): LifeResult<{ id: string }>;
  update(id: string, patch: PlacePatch, actor: Actor): LifeResult;
  remove(id: string, actor: Actor): LifeResult;
}

/**
 * Posts (v0.7): plans for what the user posts on social media by hand.
 * Jantar never posts, never fetches a link and calls no network. A post with
 * a day and a time rings like a todo (PingKind 'post'); the module owns
 * postedAt (stamped into posted, cleared out of it). Logs, events and audit
 * rows carry ids only: no text, title, notes, where or link.
 */
export interface PostsModule extends LifeModule {
  readonly name: 'posts';
  /** Open (idea and ready) by due, or the newest posted and skipped (`done`), with this week against the goals. */
  list(q: PostsQuery): LifeResult<PostsResponse>;
  /** An idea or ready post; past LIFE_LIMITS.openPosts it is conflict. */
  create(body: PostBody, actor: Actor): LifeResult<{ id: string }>;
  /** Any status to any other; a posted link only while posted (else invalid_request). */
  update(id: string, patch: PostPatch, actor: Actor): LifeResult;
  remove(id: string, actor: Actor): LifeResult;
  /** Replaces the weekly goals (meta 'post_goals'; [] removes the key). */
  setGoals(body: PostGoalsBody, actor: Actor): LifeResult;
}

/** Finance and bills (WP-FF). */
export interface FinanceModule extends LifeModule {
  readonly name: 'finance';
  /** `month` (YYYY-MM, default this month). */
  month(month?: string): LifeResult<MoneyMonth>;
  add(body: MoneyBody, actor: Actor): LifeResult<{ id: string }>;
  update(id: string, patch: MoneyPatch, actor: Actor): LifeResult;
  remove(id: string, actor: Actor): LifeResult;
  setBudget(body: BudgetBody, actor: Actor): LifeResult;
  createBill(body: BillBody, actor: Actor): LifeResult<{ id: string }>;
  updateBill(id: string, patch: BillPatch, actor: Actor): LifeResult;
  /** Logs the expense (its id is the value) and moves nextDue a month or a year on. */
  paid(id: string, body: BillPaidBody, actor: Actor): LifeResult<{ id: string }>;
  removeBill(id: string, actor: Actor): LifeResult;
}

/**
 * The Life part (WP-LS: life/service.ts). Opens life.db when a module is on,
 * builds the modules, runs the scheduler and the nightly backup. A failed
 * open is `broken`: Life answers 503 and the rest of the daemon carries on.
 */
export interface LifeService extends Service {
  status(): LifeStatus;
  /**
   * The fixed sentence (LIFE_BROKEN_REASON) while life.db would not open,
   * else null. The API asks it before every Life route but status, backup
   * and restore, so it must be cheap and never throw.
   */
  broken(): string | null;
  /** `day` default today; only the modules that are on. */
  today(day?: string): LifeResult<Today>;
  readonly todos: TodosModule;
  readonly medicines: MedicinesModule;
  readonly food: FoodModule;
  readonly places: PlacesModule;
  readonly finance: FinanceModule;
  /** v0.7. */
  readonly posts: PostsModule;
  /** VACUUM INTO <backupsDir>/life-YYYY-MM-DD.db (0600). Refused while broken or closed: there is nothing open to copy. */
  backup(): Promise<LifeResult<{ file: string; at: string }>>;
  /** Put a backup (a `life-*.db` name inside backupsDir) back; the current file is kept beside it. Allowed while broken. */
  restore(file: string): Promise<LifeResult<{ kept: string }>>;
}

/** Builds one module from the core (the builders in life/<module>/module.ts). */
export type LifeModuleBuilder<M extends LifeModule> = (core: LifeCore, deps: LifeModuleDeps) => M;

export interface LifeModuleBuilders {
  todos: LifeModuleBuilder<TodosModule>;
  medicines: LifeModuleBuilder<MedicinesModule>;
  food: LifeModuleBuilder<FoodModule>;
  places: LifeModuleBuilder<PlacesModule>;
  finance: LifeModuleBuilder<FinanceModule>;
  posts: LifeModuleBuilder<PostsModule>;
}

/**
 * The Intel shelf (WP-IN: intel/service.ts): JSONL files named on the Mac
 * plus <intelDir>/captures.jsonl, read into memory and followed for appends.
 * Emits `life.changed` at most every 2 s while items change. No path ever
 * leaves it.
 */
export interface IntelService extends Service {
  list(q: IntelListQuery): IntelListResponse;
  get(id: string): IntelItem | null;
  /**
   * A url already on the shelf answers its id with `duplicate: true` and
   * writes nothing. v0.5.3: `via: 'claude'` for what `jantar mcp` saves.
   */
  capture(body: IntelCaptureBody, from: { via: 'phone' | 'cli' | 'claude'; cwd?: string }): Promise<LifeResult<{ id: string; duplicate: boolean }>>;
  sources(): IntelSourcesResponse['sources'];
}

// ===========================================================================
// v0.5: Meetings
//
// One daemon part, `meetings` (meetings/index.ts, the shell), with its own
// database (meetings.db: refused, never reset, when it will not open) and
// screenshots as files under paths.meetingsDir. Three builders fill it in:
// capture (the extension's routes), library (the phone's and the CLI's
// reads and edits, the sweep) and summaries (one headless Claude run per
// ended meeting, action items to todos). Nothing here logs, emits or audits
// meeting text or image bytes: the one event is `life.changed {}`, never on
// caption lines.

/** A Meetings answer: Life's codes and fixed sentences (the routes use lifeValue and lifeAudit). */
export type MeetingsResult<T = true> = LifeResult<T>;

/** What meetings.db keeps in a meeting row's `json` (zod-checked on read and write: meetings/store.ts MeetingRecordSchema). */
export interface MeetingRecord {
  name: string;
  site: MeetingSite;
  people?: string;
  autoTodos: boolean;
  /** Start was pressed: captions are read. Never goes back to false. */
  notes: boolean;
  endReason?: EndReason;
  summary: MeetingSummary;
}

/** One `meetings` row with its record. Times are ISO strings. */
export interface MeetingRow {
  id: string;
  /** The extension that made it (jantar.db extensions.id). */
  extId: string;
  /** That extension's uuid for the tab's call. */
  clientId: string;
  startedAt: string;
  endedAt: string | null;
  /** The last open, line, keep-alive or screenshot (the stale sweep reads it). */
  lastAt: string;
  /** A life.db project id; may dangle. */
  projectId: string | null;
  record: MeetingRecord;
}

/** One stored caption line: the highest revision the extension sent. `at` is ms since epoch. */
export interface StoredLine {
  lineId: string;
  rev: number;
  at: number;
  speaker: string;
  text: string;
}

/** One stored screenshot row; the file is <meetingsDir>/<meeting id>/<id>.jpg. `at` is ms since epoch. */
export interface StoredShot {
  id: string;
  /** The extension's uuid for this shot (a retry stores nothing new). */
  key: string;
  at: number;
  bytes: number;
}

/**
 * meetings.db, open (meetings/store.ts). Synchronous (node:sqlite); every
 * read checks a record with zod and skips a row that fails (logged by code).
 */
export interface MeetingsStore {
  byClient(extId: string, clientId: string): MeetingRow | null;
  /** Inserts a new row; a second one with the same (extId, clientId) throws (a programming error: open is an upsert). */
  create(row: MeetingRow): void;
  get(id: string): MeetingRow | null;
  /** Replace the record through `fn` in one transaction; false when the row is gone. */
  update(id: string, fn: (r: MeetingRecord) => MeetingRecord): boolean;
  setProject(id: string, projectId: string | null): boolean;
  /** `last_at` = at (ISO). */
  touch(id: string, at: string): void;
  /** Ends an open meeting (ended_at, the record's endReason); false when it is gone or already ended. */
  end(id: string, at: string, reason: EndReason): boolean;
  /** The row with its lines and shot rows (the files are the caller's). */
  remove(id: string): boolean;
  count(): number;
  /** Meetings not ended. */
  openCount(): number;
  /**
   * Newest first by (started_at, id). `before` is the cursor `<started_at>|<id>`
   * from `next`; `q` matches name, people and summary inside the record and any
   * line's text (LIKE on escaped input); `project` 'none' is no project.
   */
  list(q: MeetingsQuery): { rows: MeetingRow[]; next: string | null };
  /** The newest meeting not ended, whatever a filter says (the "Meeting running" line). */
  newestOpen(): MeetingRow | null;
  /** Insert each line, or replace it when its `rev` is higher; returns how many changed. */
  upsertLines(id: string, lines: readonly StoredLine[]): number;
  /** By `at`, then lineId. */
  lines(id: string): StoredLine[];
  lineCount(id: string): number;
  /** Which of `lineIds` the meeting already holds (ids only: a post near the line cap asks it). */
  knownLineIds(id: string, lineIds: readonly string[]): Set<string>;
  /** The characters of every line's text together. */
  lineChars(id: string): number;
  /** A known `key` returns its existing id with `duplicate: true` and writes nothing. */
  addShot(id: string, shot: StoredShot): { id: string; duplicate: boolean };
  /** The meeting's screenshot with the extension's `key`: a retry is answered before any file is written. */
  shotByKey(id: string, key: string): StoredShot | null;
  /** By `at`. */
  shots(id: string): StoredShot[];
  shot(id: string, shotId: string): StoredShot | null;
  shotCount(id: string): number;
  /** Every screenshot's bytes together. */
  shotBytesTotal(): number;
  /** Open meetings whose last_at is before `beforeIso`. */
  staleOpen(beforeIso: string): MeetingRow[];
  /** Meetings whose summary is queued or running (left by a restart). */
  summaryWaiting(): MeetingRow[];
}

/**
 * What the builders share (meetings/index.ts makes it). Read `store()` on
 * every call and again after every await: it is null while Meetings are off
 * or broken, and the shell closes meetings.db when they turn off, whatever is
 * still in flight (a store kept across an await may be closed: drop the
 * result then).
 */
export interface MeetingsCore {
  readonly ctx: DaemonContext;
  /** life.todos for projects and todos (a closed stand-in answers 'unavailable' while Life is off or broken). */
  readonly life: LifeService;
  readonly usage: UsageSource;
  readonly ccwLegacy: CcwLegacySource;
  /** jantard --read-only: capture and edits work, summaries never run. */
  readonly readOnly: boolean;
  /** MEETING_SHOTS_TOTAL_MAX_BYTES; tests lower it. */
  readonly shotsTotalMax: number;
  store(): MeetingsStore | null;
  /** settings life.timezone when this runtime knows it, else the Mac's zone. */
  tz(): string;
  /** A ulid. */
  newId(): string;
  /** Emits `life.changed {}` at once. Never called for caption lines or keep-alives. */
  changed(): void;
  /** Queue a summary (wired to summaries.enqueue). */
  enqueueSummary(id: string): void;
  /** A deleted meeting's summary stops (wired to summaries.cancel). */
  cancelSummary(id: string): void;
}

/** The extension's capture routes (WP-MS: meetings/capture.ts `buildCapture(core)`). A 404 is "no open meeting with this client id". */
export interface MeetingCapture {
  info(): MeetingsResult<ExtInfo>;
  /** Upsert on (extId, clientId). */
  open(extId: string, clientId: string, body: ExtOpenBody): MeetingsResult<{ id: string }>;
  /** An empty list is the keep-alive: it touches last_at and never ticks. */
  lines(extId: string, clientId: string, body: ExtLinesBody): MeetingsResult;
  shot(extId: string, clientId: string, body: ExtShotBody): Promise<MeetingsResult<{ id: string }>>;
  /** Idempotent: an ended meeting answers the same. `lines` and `shots` are counts for the audit row. */
  end(extId: string, clientId: string, body: ExtEndBody): MeetingsResult<{ id: string; lines: number; shots: number }>;
}

/** The phone's and the CLI's reads and edits (WP-MS: meetings/library.ts `buildLibrary(core)`). */
export interface MeetingLibrary {
  list(q: MeetingsQuery): MeetingsResult<MeetingsList>;
  get(id: string): MeetingsResult<MeetingDetail>;
  /** The screenshot row's size, read before its file (a device past its byte budget costs no read). */
  shotSize(id: string, shotId: string): MeetingsResult<{ bytes: number }>;
  /** The JPEG's bytes (opened O_NOFOLLOW, a regular file of at most MEETING_SHOT_MAX_BYTES). */
  shotFile(id: string, shotId: string): Promise<MeetingsResult<{ body: Buffer }>>;
  update(id: string, patch: MeetingPatch, actor: Actor): MeetingsResult;
  /** Rows and folder; an open meeting is ended first (no summary queued). */
  remove(id: string, actor: Actor): Promise<MeetingsResult>;
  /** End stale open meetings ('stale'), remove orphan ulid folders. */
  sweep(now: number): Promise<void>;
}

/** The summary queue and action items (WP-SU: meetings/summary.ts `buildSummaries(core)`). */
export interface MeetingSummaries {
  status(): { available: boolean; reason?: string };
  /** Set the record's summary to queued and kick the queue (one run at a time, daemon-wide). */
  enqueue(id: string): void;
  /** The phone's Summarize or Try again. */
  request(id: string, actor: Actor): MeetingsResult;
  addTodo(id: string, n: number, actor: Actor): MeetingsResult<{ id: string }>;
  removeTodo(id: string, n: number, actor: Actor): MeetingsResult;
  /** At open: a summary left queued or running by a restart is marked failed (Try again). */
  start(): void;
  /** At close: the running one is aborted and it and the queued ones are marked failed. */
  stop(): void;
  /** Its meeting was deleted: a run going for it is aborted (its result would be dropped), a queued one dropped. */
  cancel(id: string): void;
}

/**
 * The Meetings part (meetings/index.ts). Opens meetings.db while
 * meetings.enabled is on, closes it when it turns off; a failed open makes
 * `broken()` the fixed sentence (503 on every meetings route). Sweeps at
 * start and every 5 minutes while open.
 */
export interface MeetingsService extends Service {
  /** Never throws. */
  status(): MeetingsStatus;
  /** Cheap and never throws: the pipeline asks it on every route behind the meetings switch. */
  broken(): string | null;
  readonly capture: MeetingCapture;
  readonly library: MeetingLibrary;
  readonly summaries: MeetingSummaries;
}

// ===========================================================================
// v0.5.3: Ask

/**
 * The Ask part (ask/service.ts): this device's turns in memory, one headless
 * Claude run at a time (the shared runner), and the taps that add a card's
 * item to Life (through the Life modules, the tapping device as actor) or
 * undo it. Every call names the actor; a turn is its owner's alone (anyone
 * else gets not_found). Nothing here logs, emits or audits chat text: the
 * one event is `life.changed {}`.
 */
export interface AskService extends Service {
  /** This device's turns, oldest first, and whether Ask can run now. */
  list(actor: Actor): LifeResult<AskList>;
  /** Queue a turn (one unfinished per device); the value is its id. */
  send(text: string, actor: Actor): LifeResult<{ id: string }>;
  /** A waiting or running turn of this device becomes cancelled; a finished one is left as it is. */
  cancel(id: string, actor: Actor): LifeResult;
  /** Forget this device's turns (its unfinished one is stopped). */
  clear(actor: Actor): LifeResult;
  /** Add card `n`'s item to Life (as `edit` says, when given); the value is the new item's id. */
  add(id: string, n: number, edit: AskWriteAction | undefined, actor: Actor): LifeResult<{ id: string }>;
  skip(id: string, n: number, actor: Actor): LifeResult;
  /** Delete the item card `n` added, as it is now. */
  undo(id: string, n: number, actor: Actor): LifeResult;
}

// ===========================================================================
// v0.6: Fleet
//
// One codebase, two roles (config.ts roleOf): a daemon with
// <state dir>/node/node.json is a node (a paired server: no TCP listener, no
// Life, Intel, Meetings, primer, Rewrite or pushes), else the hub. On the hub
// the `fleet` part serves the link while settings fleet.enabled is on, keeps
// each node's view and re-emits its checked, clipped events into the hub's
// own store, and forwards the phone's calls for a node's sessions. On a node
// the `nodeLink` part dials the hub, sends its snapshot and events, and runs
// the hub's calls through the node's own API (the `link` transport). Each
// side has an inert stand-in for the other's part (modes.ts).

/** v0.6: what this daemon is. */
export type DaemonRole = 'hub' | 'node';

/**
 * v0.6: <state dir>/node/node.json (0600 in a 0700 dir; on Windows the
 * profile's ACL). Written by `jantar node join` only once the hub's
 * signature checks; `jantar node access` rewrites `cfAccess`; read again
 * before every reconnect. Never logged; `jantar node status` shows the hub's
 * host and the Access client id only.
 */
export interface NodeFile {
  v: 1;
  /** The hub's front door (an origin). */
  url: string;
  nodeId: string;
  /** The name the hub gave this node. */
  name: string;
  /** The hub's public key, pinned at join (base64url, 32 bytes). */
  hubKey: string;
  /** This node's Ed25519 private key, PKCS8 PEM. */
  privateKey: string;
  /** Cloudflare Access service token headers, sent on the pairing POST and every upgrade. */
  cfAccess: { clientId: string; clientSecret: string } | null;
}

/** v0.6: the paired machine a forwarded call goes to (FleetService.target). */
export interface FleetTarget {
  nodeId: string;
  name: string;
}

/** v0.6: why a Fleet call said no; the API answers with the same code (node_version: 426, the link versions differ). */
export type FleetErrorCode = Extract<
  ErrorCode,
  'unauthorized' | 'forbidden' | 'not_found' | 'invalid_request' | 'conflict' | 'rate_limited' | 'unavailable' | 'not_implemented' | 'node_version'
>;

/** v0.6: a Fleet answer, or an API error code and a fixed sentence (`headers`: retry-after on rate_limited). */
export type FleetResult<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; code: FleetErrorCode; reason: string; headers?: Record<string, string> };

/** v0.6: one phone call the hub forwards, after its own device, scope, Origin, secret and schema checks (api/app.ts). */
export interface ForwardCall {
  route: NodeRouteName;
  params: Record<string, string>;
  query: Record<string, string>;
  /** The JSON body as the hub validated it. */
  body?: unknown;
  /** `<deviceId>:<Idempotency-Key>`: only the node's cache replays (the hub caches nothing for a forwarded call). */
  idem?: string;
  /** The phone as the hub knows it (scopes without admin), or `cli` for the hub's own CLI. */
  actor: NodeCallActor;
  /** An upload's bytes (uploadCreate), sent as the call's bulk. */
  raw?: Buffer;
}

/**
 * v0.6: the hub's Fleet part (fleet/index.ts). Always built on the hub, and
 * inert (no listener, no timer, no file) while settings fleet.enabled is off;
 * it follows the switch itself (on: the hub key, the link server; off: every
 * link closes 4403 and each node's sessions leave the board).
 */
export interface FleetService extends Service {
  /**
   * Where a route goes: null for the Mac itself, or the node that owns the
   * session, card or launch the route names, or the live node `?node=`
   * names. Never throws; never a node for a route outside NODE_ROUTES. (The
   * API answers 404 itself when `?node=` is given and this is null.)
   */
  target(route: RouteName, params: Readonly<Record<string, string>>, query: Readonly<Record<string, unknown>>): FleetTarget | null;
  /** Forward one call; never rejects. node_offline (503) and node_timeout (504) come back as replies. */
  forward(target: FleetTarget, call: ForwardCall): Promise<NodeCallReply>;
  /**
   * The link's upgrade, after api/node-upgrade.ts checked Fleet, the Host and
   * that no Origin came. Takes over the socket (answers it, or upgrades it).
   */
  acceptLink(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** POST /v1/node/pair: claim a join line's code (one generic 401 for every bad code). */
  pair(body: NodePairBody, meta: { rateKey: string }): Promise<FleetResult<{ reply: NodePairReply; nodeId: string }>>;
  /** POST /v1/machines/pair (the Mac only): one join line per server. */
  makeTokens(body: MachinesPairBody, actor: Actor): Promise<FleetResult<{ tokens: MachinesPairReply['tokens'] }>>;
  /** GET /v1/machines: every pairing, revoked ones included. */
  list(): NodeRow[];
  /** DELETE /v1/machines/:id: revoke, close its link 4401, drop it from the board. */
  revoke(id: string, actor: Actor): Promise<FleetResult<{ machine: NodeRow }>>;
}

/** v0.6: what the hub knows of a linked node from its `auth` frame. */
export interface HubLinkInfo {
  os: NodeOs;
  version: string;
  backend: NodeBackend;
  readOnly: boolean;
  accessRefused: number;
}

/** v0.6: one authenticated node link on the hub (fleet/socket.ts makes it; the registry uses it). */
export interface HubLink {
  readonly nodeId: string;
  readonly info: HubLinkInfo;
  /** Called exactly once per link, first; a second snapshot is a protocol error the socket handles. */
  onSnapshot(fn: (snap: NodeSnapshot) => void): void;
  /** Each `event` frame's event, unparsed past its `type` (the registry checks the rest). */
  onEvent(fn: (event: unknown) => void): void;
  onClose(fn: (code: number) => void): void;
  /** One call; never rejects: node_offline / node_timeout come back as values. `bulk`: an upload's bytes. */
  call(req: NodeCallRequest, bulk?: Buffer): Promise<NodeCallReply>;
  close(code: number, reason: string): void;
}

/** v0.6: the hub's link server (fleet/socket.ts createLinkServer). */
export interface LinkServer {
  /** Handshake limiter, unauthenticated-socket cap, upgrade, handshake; a verified link goes to `hooks.onLink`. */
  accept(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Close one node's link (revoked: 4401). */
  closeNode(nodeId: string, code: number, reason: string): void;
  /** Close every link (Fleet off: 4403; shutdown: 1001). */
  closeAll(code: number, reason: string): void;
  /** Links up now. */
  linked(): string[];
  stop(): Promise<void>;
}

/** v0.6: what the link server tells its owner. */
export interface LinkServerHooks {
  /** A link passed the handshake: wire its handlers before returning (its snapshot comes next). */
  onLink(link: HubLink): void;
}

/** v0.6: the node's side of a verified link (node/dialer.ts makes it; the feed and the executor use it). */
export interface NodeLink {
  sendSnapshot(snap: NodeSnapshot): void;
  sendEvent(event: DaemonEvent): void;
  onCall(fn: (req: NodeCallRequest, bulk?: Buffer) => Promise<NodeCallReply>): void;
  onClose(fn: (code: number) => void): void;
}

/** v0.6: the node's link as `jantar node status` and /ctl/status tell it. Never a secret, a URL path or a key. */
export interface NodeLinkStatus {
  /** off: not a node (or stopped); connecting; linked; waiting: backing off until `retryAt`. */
  state: 'off' | 'connecting' | 'linked' | 'waiting';
  /** The name the hub gave this node. */
  name: string | null;
  /** The hub's host name only. */
  hubHost: string | null;
  /** How the last link or attempt ended: a close code, or the upgrade's HTTP status (403 from Access, 404 with Fleet off). */
  lastClose: { code: number; at: string } | null;
  /** Cloudflare Access refusals since the last good link. */
  accessRefused: number;
  retryAt: string | null;
}

/** v0.6: the node's dialler (node/dialer.ts): dial, handshake, redial with backoff, re-reading node.json each time. */
export interface Dialer {
  /** `onLink` gets each verified link. */
  start(onLink: (link: NodeLink) => void): void;
  stop(): Promise<void>;
  status(): NodeLinkStatus;
}

/** v0.6: the node's feed (node/feed.ts): the snapshot, then its own events, clipped, under the rate budget. */
export interface NodeFeed {
  /** Send the snapshot and then live events on this link until it closes; the returned function detaches. */
  attach(link: NodeLink): Unsubscribe;
}

/** v0.6: runs the hub's calls on a node (node/executor.ts): NODE_ROUTES only, through the node's own API. */
export interface CallExecutor {
  run(req: NodeCallRequest, bulk?: Buffer): Promise<NodeCallReply>;
}

/** v0.6: one call into the node's own API on the `link` transport (api/server.ts makes it on a node). */
export interface LinkRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Path and query string, built from the route name (buildPath), never a path from the hub. */
  url: string;
  /** Becomes the device `hub.<deviceId>` with these scopes, never stored. */
  actor: NodeCallActor;
  /** Sent as the Idempotency-Key: the node's own cache replays it. */
  idem?: string;
  /** A JSON body. */
  body?: unknown;
  /** An upload's bytes (application/octet-stream), instead of `body`. */
  raw?: Buffer;
}

/** v0.6: the node API's answer: its status and parsed JSON body. */
export interface LinkResponse {
  status: number;
  body: unknown;
}

export interface LinkInjector {
  inject(req: LinkRequest): Promise<LinkResponse>;
}

/** v0.6: the node's link part (node/index.ts). On the hub an inert one (state off). */
export interface NodeLinkService extends Service {
  status(): NodeLinkStatus;
}

// ===========================================================================
// Factories (the integration step wires these in main.ts)

export type Factory<T, D = Record<never, never>> = (ctx: DaemonContext, deps: D) => T;

export interface Parts {
  sessions: SessionSource;
  transcripts: TranscriptReader;
  transcriptWatcher: TranscriptWatcher;
  usage: UsageSource;
  ccwLegacy: CcwLegacySource;
  hooks: HooksBridge;
  terminal: TerminalBackend;
  writer: Writer;
  notifiers: Notifier[];
  /** v0.3 */
  files: FilesService;
  changes: ChangesService;
  rewrite: RewriteService;
  launcher: Launcher;
  controls: ControlsService;
  /** v0.4 */
  life: LifeService;
  intel: IntelService;
  /** v0.5 */
  meetings: MeetingsService;
  /** v0.5.3 */
  ask: AskService;
  notifications: NotificationRouter;
  /** v0.6: the hub's Fleet part (inert while Fleet is off; an inert stand-in on a node). */
  fleet: FleetService;
  /** v0.6: a node's link to the hub (an inert stand-in on the hub). */
  nodeLink: NodeLinkService;
  api: ApiServer;
}

export interface Factories {
  sessions: Factory<SessionSource>;
  transcripts: Factory<TranscriptReader>;
  transcriptWatcher: Factory<TranscriptWatcher, { sessions: SessionSource; transcripts: TranscriptReader }>;
  ccwLegacy: Factory<CcwLegacySource>;
  usage: Factory<UsageSource, { ccwLegacy: CcwLegacySource }>;
  hooks: Factory<HooksBridge, { sessions: SessionSource; transcripts: TranscriptReader }>;
  terminal: Factory<TerminalBackend>;
  writer: Factory<
    Writer,
    {
      sessions: SessionSource;
      terminal: TerminalBackend;
      transcripts: TranscriptReader;
      hooks: HooksBridge;
      ccwLegacy: CcwLegacySource;
    }
  >;
  notifiers: Factory<Notifier[]>;
  /** v0.3 (WP-FP). `notifiers` push the `security` alert straight to every device. */
  files: Factory<FilesService, { sessions: SessionSource; notifiers: Notifier[] }>;
  /** v0.3 (WP-FC). */
  changes: Factory<ChangesService, { sessions: SessionSource; transcripts: TranscriptReader; files: FilesService }>;
  /** v0.3 (WP-R). */
  rewrite: Factory<
    RewriteService,
    {
      sessions: SessionSource;
      transcripts: TranscriptReader;
      hooks: HooksBridge;
      usage: UsageSource;
      ccwLegacy: CcwLegacySource;
      files: FilesService;
      changes: ChangesService;
    }
  >;
  /** v0.3 (WP-L). `notifiers` push `launch` straight to every device. */
  launcher: Factory<
    Launcher,
    {
      sessions: SessionSource;
      terminal: TerminalBackend;
      writer: Writer;
      usage: UsageSource;
      ccwLegacy: CcwLegacySource;
      files: FilesService;
      notifiers: Notifier[];
    }
  >;
  /** v0.3 (WP-C). */
  controls: Factory<
    ControlsService,
    {
      sessions: SessionSource;
      terminal: TerminalBackend;
      writer: Writer;
      hooks: HooksBridge;
      transcripts: TranscriptReader;
      ccwLegacy: CcwLegacySource;
    }
  >;
  /** v0.4 (WP-LS). `notifiers`: Life pushes go to the Web Push one only (life/push.ts). */
  life: Factory<LifeService, { sessions: SessionSource; usage: UsageSource; ccwLegacy: CcwLegacySource; notifiers: Notifier[] }>;
  /** v0.4 (WP-IN). `files`: its denylist refuses protected source paths. */
  intel: Factory<IntelService, { files: FilesService }>;
  /** v0.5 (WP0's shell; the builders are WP-MS's and WP-SU's). `life`: projects and todos; `usage` and `ccwLegacy`: the summary's account. */
  meetings: Factory<MeetingsService, { life: LifeService; usage: UsageSource; ccwLegacy: CcwLegacySource }>;
  /** v0.5.3. Only these three: no writer, terminal, launcher, controls, files or settings patch, so a model's answer reaches nothing else. */
  ask: Factory<AskService, { life: LifeService; usage: UsageSource; ccwLegacy: CcwLegacySource }>;
  /**
   * v0.5.3: `terminal` and `panes` (the API's PaneLookup, shared) let the
   * router read Claude's countdown off an unattended ask's screen; it only
   * reads (never types, no writer lock).
   */
  notifications: Factory<NotificationRouter, { notifiers: Notifier[]; terminal: TerminalBackend; panes: PaneFinder }>;
  /** v0.6 (L4's fleet/index.ts, wiring L1's link server and NodeAuth): the hub only. */
  fleet: Factory<FleetService>;
  /** v0.6 (L1's node/index.ts, with L4's feed): a node only. `executor` runs the hub's calls through the node's own API. */
  nodeLink: Factory<NodeLinkService, { executor: CallExecutor }>;
  /** v0.6: `fleet` and `nodeLink` may be left out (tests): inert stand-ins take their place. */
  api: Factory<ApiServer, Omit<Parts, 'api' | 'notifications' | 'fleet' | 'nodeLink'> & Partial<Pick<Parts, 'fleet' | 'nodeLink'>>>;
}
