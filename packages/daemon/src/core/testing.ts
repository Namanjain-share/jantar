/**
 * Test doubles for every builder: a fake ExecFile that records calls, a fixed
 * process probe, and `createTestContext()` which builds a full DaemonContext
 * on a FakeClock, MemoryStore and in-memory Db. Nothing here touches the
 * real machine unless a test passes a real implementation in.
 */
import { dayKeyOf, isValidTimeZone } from '@jantar/life-core';
import {
  LifeSettingsSchema,
  MEETING_SHOTS_TOTAL_MAX_BYTES,
  PROTOCOL_VERSION,
  SettingsSchema,
  defaultSettings,
  type AccountsMode,
  type Pane,
  type ProjectView,
  type Settings,
  type TodoBody,
} from '@jantar/protocol';
import type {
  Actor,
  AskService,
  Bins,
  CcwLegacySource,
  DaemonContext,
  ExecFile,
  ExecOptions,
  ExecResult,
  FinanceModule,
  FoodModule,
  IntelService,
  LifeCore,
  LifePush,
  LifeResult,
  LifeService,
  MedicinesModule,
  MeetingCapture,
  MeetingLibrary,
  MeetingSummaries,
  MeetingsCore,
  MeetingsService,
  MeetingsStore,
  PaneFinder,
  Parts,
  Paths,
  PingHandler,
  PingKind,
  PingRow,
  PlacesModule,
  ProcessProbe,
  Scheduler,
  TodosModule,
  UsageSource,
} from '../contracts.js';
import { openLifeDb } from '../life/db.js';
import { openMeetingsDb, type MeetingsDb } from '../meetings/db.js';
import { createMeetingsStore } from '../meetings/store.js';
import { MemorySettingsStore, resolvePaths } from '../config.js';
import { FakeClock } from './clock.js';
import { memoryLogger } from './log.js';
import { createMemoryDb } from './memory-db.js';
import { newId } from './ids.js';
import { NotImplementedError, notBuilt } from './not-implemented.js';
import { MemoryStore } from './store.js';

export interface ExecCall {
  file: string;
  args: string[];
  opts: ExecOptions;
}

export type ExecHandler = (
  call: ExecCall,
) => Partial<ExecResult> | undefined | Promise<Partial<ExecResult> | undefined>;

/**
 * An ExecFile that never spawns anything. Handlers run in order; the first
 * one returning a result wins. Unhandled calls exit 127 ("not faked").
 */
export function createFakeExec(...handlers: ExecHandler[]): ExecFile & { calls: ExecCall[]; handle(h: ExecHandler): void } {
  const calls: ExecCall[] = [];
  const list = [...handlers];
  const fn = (async (file: string, args: readonly string[], opts: ExecOptions = {}) => {
    const call: ExecCall = { file, args: [...args], opts };
    calls.push(call);
    for (const h of list) {
      const r = await h(call);
      if (r) return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 0, ...r };
    }
    return { code: 127, signal: null, stdout: '', stderr: `not faked: ${file}`, timedOut: false, truncated: false, durationMs: 0 };
  }) as ExecFile & { calls: ExecCall[]; handle(h: ExecHandler): void };
  fn.calls = calls;
  fn.handle = (h) => {
    list.push(h);
  };
  return fn;
}

/** Match a call by binary basename (or full path) and, optionally, its first args. */
export function onCommand(
  name: string,
  result: Partial<ExecResult> | ((call: ExecCall) => Partial<ExecResult>),
  argsPrefix: string[] = [],
): ExecHandler {
  return (call) => {
    const base = call.file.split('/').pop();
    if (call.file !== name && base !== name) return undefined;
    if (!argsPrefix.every((a, i) => call.args[i] === a)) return undefined;
    return typeof result === 'function' ? result(call) : result;
  };
}

/** A process probe that says "alive" only for the given pids. */
export function fixedProbe(alive: Iterable<number> = []): ProcessProbe & { alive: Set<number> } {
  const set = new Set(alive);
  return { alive: set, isAlive: (pid) => set.has(pid) };
}

export const TEST_BINS: Bins = {
  node: process.execPath,
  ps: '/fake/bin/ps',
  osascript: '/fake/bin/osascript',
  lsof: '/fake/bin/lsof',
  cswap: '/fake/bin/cswap',
  claude: '/fake/bin/claude',
  terminalNotifier: null,
  screencapture: null,
  tmux: null,
  sips: null,
};

export interface TestContextOptions {
  /** Synthetic user home (e.g. makeFakeHome().home). Default: a non-existent placeholder. */
  userHome?: string;
  /** State dir. Default: <userHome>/.jantar */
  home?: string;
  paths?: Paths;
  settings?: Settings;
  clock?: FakeClock;
  exec?: ExecFile;
  proc?: ProcessProbe;
  bins?: Partial<Bins>;
  env?: Record<string, string | undefined>;
  /** v0.4: what ctx.accountsMode() answers. Default cswap (every v0.3 test ran with cswap). */
  accountsMode?: AccountsMode;
}

export type TestContext = DaemonContext & {
  clock: FakeClock;
  store: MemoryStore;
  settings: MemorySettingsStore;
  log: ReturnType<typeof memoryLogger>;
};

export function createTestContext(opts: TestContextOptions = {}): TestContext {
  const userHome = opts.userHome ?? '/nonexistent/jantar-test-home';
  const env = opts.env ?? { HOME: userHome, LC_ALL: 'C', TZ: 'UTC' };
  const paths = opts.paths ?? resolvePaths({ env, userHome, ...(opts.home ? { home: opts.home } : {}) });
  const clock = opts.clock ?? new FakeClock();
  const log = memoryLogger();
  return {
    version: { daemon: '0.0.0-test', protocol: PROTOCOL_VERSION },
    paths,
    env,
    settings: new MemorySettingsStore(opts.settings ?? defaultSettings()),
    bins: { ...TEST_BINS, ...opts.bins },
    clock,
    exec: opts.exec ?? createFakeExec(),
    proc: opts.proc ?? fixedProbe(),
    log,
    store: new MemoryStore({ clock, log }),
    db: createMemoryDb(),
    accountsMode: () => opts.accountsMode ?? 'cswap',
  };
}

/** The v0.3 parts. */
export type V03Parts = Pick<Parts, 'files' | 'changes' | 'rewrite' | 'launcher' | 'controls'>;
/** The parts notBuiltParts() gives: v0.3's, v0.4's (life, intel), v0.5's (meetings) and v0.5.3's (ask). */
export type NotBuiltParts = V03Parts & Pick<Parts, 'life' | 'intel' | 'meetings' | 'ask'>;

/**
 * v0.3, v0.4, v0.5 and v0.5.3 parts that start, stop and answer every call with
 * NotImplementedError (the API's 501), for tests that do not exercise them.
 * Unlike each part's own WP0 stub (replaced when its package lands), these
 * stay inert, so a test can swap in just the part it is about:
 * `{ ...notBuiltParts(), rewrite }`. Life and Meetings are never broken here.
 */
export function notBuiltParts(): NotBuiltParts {
  const nb = (what: string) => (): never => {
    throw new NotImplementedError(what);
  };
  const life = { start: async () => {}, stop: async () => {} };
  const files = nb('Files');
  const changes = nb('Changed files');
  const rewrite = nb('Rewrite');
  const launch = nb('Starting sessions');
  const controls = nb('Controls');
  return {
    files: {
      ...life,
      policy: { roots: files, root: files, openForRead: files, openDir: files, resolveDir: files, isProtected: files, underRoot: files, locate: files },
      roots: files,
      list: files,
      stat: files,
      text: files,
      raw: files,
      // A refusal note is fire and forget: nothing to refuse.
      denied: () => {},
    },
    changes: { ...life, forSession: changes, change: changes, recent: changes, changedPathsFor: changes },
    rewrite: { ...life, submit: rewrite, get: rewrite, cancel: rewrite, originFor: rewrite, markSent: rewrite, releaseOrigin: rewrite },
    launcher: {
      ...life,
      folders: { roots: launch, list: launch, recent: launch, pin: launch, create: launch },
      preview: launch,
      launch,
      get: launch,
      list: launch,
      answer: launch,
    },
    controls: { ...life, key: controls, setMode: controls, command: controls, screenshot: controls, answerDialog: controls, keypad: controls },
    // Each module is an object too, so a route reaching s.deps.life.<module>.<method>() answers 501, not a TypeError's 500.
    life: notBuilt<LifeService>('Life', {
      ...life,
      broken: () => null,
      todos: notBuilt<TodosModule>('Life'),
      medicines: notBuilt<MedicinesModule>('Life'),
      food: notBuilt<FoodModule>('Life', { estimateStatus: () => ({ available: false, reason: 'Ask Claude is not built yet.' }) }),
      places: notBuilt<PlacesModule>('Life'),
      finance: notBuilt<FinanceModule>('Life'),
    }),
    intel: notBuilt<IntelService>('The Intel shelf', { ...life }),
    meetings: notBuilt<MeetingsService>('Meetings', {
      ...life,
      broken: () => null,
      status: () => ({ on: false, open: false, meetings: 0, running: 0, shotsBytes: 0, summary: { available: false }, extensions: [] }),
      capture: notBuilt<MeetingCapture>('Meetings'),
      library: notBuilt<MeetingLibrary>('Meetings'),
      summaries: notBuilt<MeetingSummaries>('Meetings'),
    }),
    ask: notBuilt<AskService>('Ask', { ...life }),
  };
}

// ---------------------------------------------------------------------------
// v0.4 Life

/** A Scheduler that only records what producers asked for (module tests); nothing is ever sent. */
export class RecordingScheduler implements Scheduler {
  readonly handlers = new Map<PingKind, PingHandler>();
  /** `${kind}|${ref}|${sub}` -> the row as producers left it. */
  readonly rows = new Map<string, PingRow>();
  /** Every set and clear, in order. */
  readonly calls: ({ op: 'set'; kind: PingKind; ref: string; sub: string; nextAt: string | null } | { op: 'clear'; kind: PingKind; ref: string; sub?: string })[] = [];
  pokes = 0;

  register(h: PingHandler): void {
    this.handlers.set(h.kind, h);
  }

  set(kind: PingKind, ref: string, sub: string, nextAt: Date | null): void {
    const at = nextAt ? nextAt.toISOString() : null;
    this.calls.push({ op: 'set', kind, ref, sub, nextAt: at });
    const key = `${kind}|${ref}|${sub}`;
    const prev = this.rows.get(key);
    this.rows.set(key, { id: prev?.id ?? key, kind, ref, sub, nextAt: at, claimedAt: null, failures: 0, lastSentAt: prev?.lastSentAt ?? null });
  }

  clear(kind: PingKind, ref: string, sub?: string): void {
    this.calls.push(sub === undefined ? { op: 'clear', kind, ref } : { op: 'clear', kind, ref, sub });
    for (const [key, row] of this.rows) if (row.kind === kind && row.ref === ref && (sub === undefined || row.sub === sub)) this.rows.delete(key);
  }

  poke(): void {
    this.pokes += 1;
  }

  /** The row for (kind, ref, sub), to hand to its handler's check, push and next. */
  row(kind: PingKind, ref: string, sub = ''): PingRow | undefined {
    return this.rows.get(`${kind}|${ref}|${sub}`);
  }

  /** Rows of one kind (all kinds when omitted). */
  list(kind?: PingKind): PingRow[] {
    return [...this.rows.values()].filter((r) => kind === undefined || r.kind === kind);
  }
}

/**
 * Records Life pushes for a scheduler or push test; `result` is what each
 * send answers (v0.5.3: `offline`, the failures that never left the Mac).
 */
export interface PushSpy {
  pushes: LifePush[];
  result: { delivered: number; failed: number; offline?: number };
  send(p: LifePush): Promise<{ delivered: number; failed: number; offline?: number }>;
}

export function createPushSpy(result: PushSpy['result'] = { delivered: 1, failed: 0 }): PushSpy {
  const spy: PushSpy = {
    pushes: [],
    result,
    send: async (p) => {
      spy.pushes.push(p);
      return { ...spy.result };
    },
  };
  return spy;
}

/**
 * v0.5.3: a PaneFinder for the notification router's tests: answers `pane`
 * (default: no tab) for every session, and records which sessions it was
 * asked about, in order.
 */
export function fakePanes(pane: Pane | null | 'timeout' = null): PaneFinder & { asked: string[]; pane: Pane | null | 'timeout' } {
  const panes = {
    asked: [] as string[],
    pane,
    find: async (session: { sid: string }) => {
      panes.asked.push(session.sid);
      return panes.pane;
    },
  };
  return panes;
}

export interface TestLifeCoreOptions {
  clock?: FakeClock;
  /** The Life zone when settings name none (the Mac's zone in the real service). Default UTC. */
  tz?: string;
  /** life.* settings over the defaults (every module off, no zone, no currency). */
  settings?: Partial<Settings['life']>;
}

export type TestLifeCore = LifeCore & {
  clock: FakeClock;
  scheduler: RecordingScheduler;
  /** How many times `changed()` ran (each would emit life.changed {}). */
  readonly changedCount: number;
  /** Not called by the core: hand it to whatever sends (the scheduler). */
  pushes: PushSpy;
  /** Replace life.* settings (a zone or switch change). */
  setSettings(next: Partial<Settings['life']>): void;
  close(): void;
};

/**
 * A LifeCore for module tests: an in-memory life.db with LIFE_MIGRATIONS
 * applied, a FakeClock, a RecordingScheduler, a `changed` counter and a
 * push spy. Close it in afterEach.
 */
export function createTestLifeCore(opts: TestLifeCoreOptions = {}): TestLifeCore {
  const opened = openLifeDb(':memory:');
  if (!opened.ok) throw new Error(`in-memory life.db: ${opened.code}`);
  const clock = opts.clock ?? new FakeClock();
  const tz = opts.tz ?? 'UTC';
  let life = LifeSettingsSchema.parse(opts.settings ?? {});
  let changed = 0;
  // As the service does: life.timezone when set and known to this runtime, else the zone the core started with.
  const zone = () => (life.timezone && isValidTimeZone(life.timezone) ? life.timezone : tz);
  const core: TestLifeCore = {
    db: opened.db,
    tz: zone,
    now: () => new Date(clock.now()),
    today: () => dayKeyOf(new Date(clock.now()), zone()),
    settings: () => life,
    changed: () => {
      changed += 1;
    },
    scheduler: new RecordingScheduler(),
    newId,
    clock,
    get changedCount() {
      return changed;
    },
    pushes: createPushSpy(),
    setSettings: (next) => {
      life = LifeSettingsSchema.parse({ ...life, ...next });
    },
    close: () => opened.db.close(),
  };
  return core;
}

// ---------------------------------------------------------------------------
// v0.5 Meetings

/** What the fake todos module of createTestMeetingsCore did, and what it answers. */
export interface FakeTodos {
  /** listProjects answers these (each with open 0, overdue 0 unless given). */
  projects: ProjectView[];
  /** Every createTodo, in order, with the id it answered. */
  created: { body: TodoBody; actor: Actor; id: string }[];
  /** Every removeTodo, in order. */
  removed: { id: string; actor: Actor }[];
  /** When set, createTodo answers this instead (a cap, Life broken). */
  createFails: LifeResult<never> | null;
  /** When set, listProjects answers this instead (Life closed). */
  listFails: LifeResult<never> | null;
}

export interface TestMeetingsCoreOptions {
  clock?: FakeClock;
  /** Settings over the defaults (meetings.enabled is on unless given; life.todos as given). */
  settings?: Record<string, unknown>;
  /** The fake todos module's projects. */
  projects?: ProjectView[];
  /** Default MEETING_SHOTS_TOTAL_MAX_BYTES. */
  shotsTotalMax?: number;
  readOnly?: boolean;
  /** Passed to createTestContext (e.g. `home` on a temp dir, so paths.meetingsDir is real). */
  ctx?: TestContextOptions;
  /** The Mac's zone when settings name none. Default UTC. */
  tz?: string;
}

export type TestMeetingsCore = MeetingsCore & {
  ctx: TestContext;
  clock: FakeClock;
  /** The in-memory meetings.db (MEETINGS_MIGRATIONS applied) behind store(). */
  db: MeetingsDb;
  /** The store, never null here (store() answers it too). */
  meetings: MeetingsStore;
  /** How many times `changed()` ran (each would emit life.changed {}). */
  readonly ticks: number;
  /** Every enqueueSummary(id), in order. */
  enqueued: string[];
  /** Every cancelSummary(id), in order. */
  cancelled: string[];
  todos: FakeTodos;
  /** Replace settings (a switch or zone change); they merge over the current ones. */
  setSettings(patch: Record<string, unknown>): void;
  close(): void;
};

/**
 * A MeetingsCore for builder tests (WP-MS, WP-SU): an in-memory migrated
 * meetings.db behind `store()`, a test context on a FakeClock with Meetings
 * on, a `life` whose todos module records createTodo and removeTodo and
 * answers listProjects from `projects` (every other Life call is 501), a
 * tick counter and the summaries queued and cancelled. Close it in afterEach.
 */
export function createTestMeetingsCore(opts: TestMeetingsCoreOptions = {}): TestMeetingsCore {
  const opened = openMeetingsDb(':memory:');
  if (!opened.ok) throw new Error(`in-memory meetings.db: ${opened.code}`);
  const clock = opts.clock ?? new FakeClock();
  const settings = SettingsSchema.parse({ meetings: { enabled: true }, ...opts.settings });
  const ctx = createTestContext({ ...opts.ctx, clock, settings });
  const store = createMeetingsStore(opened.db, ctx.log);
  let ticks = 0;
  const todos: FakeTodos = { projects: opts.projects ?? [], created: [], removed: [], createFails: null, listFails: null };
  const todosModule = notBuilt<TodosModule>('Life', {
    name: 'todos',
    listProjects: () => todos.listFails ?? { ok: true, value: { projects: todos.projects } },
    createTodo: (body: TodoBody, actor: Actor) => {
      if (todos.createFails) return todos.createFails;
      const id = newId();
      todos.created.push({ body, actor, id });
      return { ok: true, value: { id } };
    },
    removeTodo: (id: string, actor: Actor) => {
      todos.removed.push({ id, actor });
      return { ok: true, value: true };
    },
  });
  const life = notBuilt<LifeService>('Life', { start: async () => {}, stop: async () => {}, broken: () => null, todos: todosModule });
  const tz = opts.tz ?? 'UTC';
  const core: TestMeetingsCore = {
    ctx,
    life,
    usage: notBuilt<UsageSource>('Usage', { start: async () => {}, stop: async () => {}, latest: () => null }),
    ccwLegacy: notBuilt<CcwLegacySource>('ccw', { start: async () => {}, stop: async () => {}, present: () => false }),
    readOnly: opts.readOnly === true,
    shotsTotalMax: opts.shotsTotalMax ?? MEETING_SHOTS_TOTAL_MAX_BYTES,
    store: () => store,
    tz: () => {
      const z = ctx.settings.get().life.timezone;
      return z && isValidTimeZone(z) ? z : tz;
    },
    newId,
    changed: () => {
      ticks += 1;
    },
    enqueueSummary: (id) => {
      core.enqueued.push(id);
    },
    cancelSummary: (id) => {
      core.cancelled.push(id);
    },
    clock,
    db: opened.db,
    meetings: store,
    get ticks() {
      return ticks;
    },
    enqueued: [],
    cancelled: [],
    todos,
    setSettings: (patch) => {
      void ctx.settings.patch(patch);
    },
    close: () => opened.db.close(),
  };
  return core;
}
