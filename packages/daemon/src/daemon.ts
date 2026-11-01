/**
 * Builds and starts a whole jantard (integration step).
 *
 * This is the one place the work packages are wired together, in the order
 * docs/LAYOUT.md gives ("Order of startup"):
 *
 *   1. createDaemonContext({ openDb: openSqliteDb }) (the settings file is
 *      migrated to version 2 first; another daemon on the state dir stops it)
 *   2. persist events (and card history) to SQLite
 *   3. parts: ccwLegacy -> sessions -> transcripts -> transcriptWatcher ->
 *      usage -> hooks -> terminal -> writer -> notifiers -> files -> changes
 *      -> rewrite -> launcher -> controls -> life -> intel -> meetings ->
 *      primer -> notifications -> api (the v0.3, v0.4 and v0.5 parts sit
 *      behind their switches; the API refuses their routes while a switch
 *      is off)
 *   4. startServices() in that order; stop() runs them down in reverse.
 *
 * v0.6 Fleet: the role decides the wiring (config.ts roleOf: a node when
 * <state dir>/node/node.json exists).
 * - hub: as above, plus `fleet` after notifications and before api (inert
 *   while settings fleet.enabled is off). The terminal is Terminal.app.
 * - node: ccwLegacy (inert) -> sessions -> transcripts -> transcriptWatcher
 *   -> usage -> hooks -> terminal (terminal/pick.ts: tmux on Linux, none on
 *   Windows) -> writer -> files (policy only) -> launcher -> controls -> api
 *   (the control socket and the link app, no TCP) -> nodeLink. No Changes,
 *   Rewrite, Life, Intel, Meetings, primer or pushes (modes.ts stand-ins,
 *   which open no file and start no timer); `notifiers` is [].
 *
 * main.ts calls startDaemon() with the command-line flags; the end-to-end
 * tests call it with a synthetic HOME and a scripted terminal, so both run
 * exactly this wiring.
 */
import { errorBody } from '@jantar/protocol';
import type {
  ChangesService,
  Clock,
  DaemonContext,
  DbOpener,
  FilesService,
  IntelService,
  LifeService,
  LinkInjector,
  Logger,
  MeetingsService,
  NodeLinkService,
  Notifier,
  NotificationRouter,
  Parts,
  ProcessProbe,
  RewriteService,
  Service,
  TerminalBackend,
} from './contracts.js';
import { roleOf, type Env } from './config.js';
import { createDaemonContext } from './context.js';
import { startServices, type NamedService } from './lifecycle.js';
import { DAEMON_LOG_FILES, LogRotator } from './log-rotate.js';
import {
  NullTerminalBackend,
  inertCcwLegacy,
  nodeOffParts,
  offFleet,
  offNodeLink,
  readOnlyHooks,
  readOnlyLauncher,
  readOnlyLifeBuilders,
  readOnlyRewrite,
  readOnlySettings,
  readOnlyTerminal,
  readOnlyUsage,
  readOnlyWriter,
  type DaemonMode,
  type TerminalMode,
} from './modes.js';
import { openSqliteDb, persistEvents, persistPendingHistory } from './db/index.js';
import { createCcwLegacySource } from './sources/ccw-legacy/index.js';
import { createSessionSource } from './sources/claude-files/index.js';
import { createUsageSource } from './sources/cswap/index.js';
import { createTranscriptReader, createTranscriptWatcher } from './sources/transcripts/index.js';
import { createHooksBridge } from './hooks/index.js';
import { nodeBackendOf, pickTerminal } from './terminal/pick.js';
import { createWriter } from './writer/index.js';
import { createChangesService, createFilesService } from './files/index.js';
import { createRewriteService } from './rewrite/index.js';
import { createLauncher } from './launcher/index.js';
import { createControlsService } from './controls/index.js';
import { createLifeService, LIFE_MODULE_BUILDERS } from './life/index.js';
import { buildLifeService } from './life/service.js';
import { createIntelService } from './intel/index.js';
import { createMeetingsService } from './meetings/index.js';
import { createPrimer } from './primer/index.js';
import { WebPushNotifier, createNotificationRouter, createNotifiers, type PushSender } from './notify/index.js';
import { createApiServerWith, type ApiOptions, type ApiServerImpl } from './api/index.js';
import { createFleet } from './fleet/index.js';
import { createNodeLink } from './node/index.js';
import { createExecutor } from './node/executor.js';

export interface DaemonOptions {
  /** Environment (HOME, JANTAR_HOME, ...). Default process.env. */
  env?: Env;
  /** TCP port; overrides settings.remote.port. 0 picks a free port. */
  port?: number;
  /** Refuse every action on sessions, terminals, cards, cswap and settings (see modes.ts). */
  readOnly?: boolean;
  /**
   * Terminal backend. Default: Terminal.app (v0.6: on a node, by platform:
   * terminal/pick.ts). `false` turns terminal access off (--no-terminal); a
   * function injects another backend (tests).
   */
  terminal?: false | ((ctx: DaemonContext) => TerminalBackend);
  log?: Logger;
  /** Default openSqliteDb. */
  openDb?: DbOpener;
  /** Process probe override (tests on a synthetic HOME with made-up pids). */
  proc?: ProcessProbe;
  /** Look binaries up on $PATH as well (tests, manual runs). Default false, as under launchd. */
  usePath?: boolean;
  /** Extra API options (control socket path, web dist, cookie flags; tests). */
  api?: Omit<ApiOptions, 'port' | 'readOnly' | 'mode'>;
  /** Rotate the launchd log files in paths.logsDir. Default true. */
  rotateLogs?: boolean;
  /** More notification channels next to Web Push (tests record what would be pushed). */
  extraNotifiers?: (ctx: DaemonContext) => Notifier[];
  /** Web Push's sender (tests record each payload instead of sending it to a push service). */
  pushSender?: PushSender;
  /** Default the system clock (end-to-end tests move theirs forward to a Life ping's time). */
  clock?: Clock;
}

export interface RunningDaemon {
  readonly ctx: DaemonContext;
  readonly parts: Parts;
  readonly mode: DaemonMode;
  /** The bound TCP address. */
  address(): { host: string; port: number } | null;
  /** Stop every service in reverse order and close the database. Idempotent. */
  stop(): Promise<void>;
}

/** Create every part, start the services in order, and return the running daemon. */
export async function startDaemon(opts: DaemonOptions = {}): Promise<RunningDaemon> {
  const readOnly = opts.readOnly === true;

  const ctxOpts: Parameters<typeof createDaemonContext>[0] = { openDb: opts.openDb ?? openSqliteDb };
  if (opts.env) ctxOpts.env = opts.env;
  if (opts.log) ctxOpts.log = opts.log;
  if (opts.usePath !== undefined) ctxOpts.usePath = opts.usePath;
  if (opts.clock) ctxOpts.clock = opts.clock;
  const base = await createDaemonContext(ctxOpts);

  let ctx: DaemonContext = base;
  if (opts.proc) ctx = { ...ctx, proc: opts.proc };
  if (readOnly) ctx = { ...ctx, settings: readOnlySettings(ctx.settings) };
  const log = ctx.log;
  // v0.6: a hub, or a node (a paired server) when node.json is there.
  const role = roleOf(ctx.paths);
  const picked = opts.terminal === undefined ? pickTerminal(ctx, role) : null;
  const terminalMode: TerminalMode = opts.terminal === false ? 'off' : opts.terminal ? 'injected' : (picked?.mode ?? 'terminal-app');
  const mode: DaemonMode = { readOnly, terminal: terminalMode, role };
  const node = role === 'node';

  // 2. Persistence, before any part can emit.
  const unpersist = [persistEvents(ctx.store, ctx.db, log), persistPendingHistory(ctx.store, ctx.db, log)];
  const closeDb = () => {
    for (const u of unpersist) u();
    try {
      ctx.db.close();
    } catch (e) {
      log.warn('closing the database failed', { error: String(e) });
    }
  };

  let parts: Parts;
  let stopServices: () => Promise<void>;
  try {
    // 3. Parts.
    // v0.6: ccw is the Mac's legacy tool; a node never reads for it.
    const ccwLegacy = node ? inertCcwLegacy() : createCcwLegacySource(ctx, {});
    const sessions = createSessionSource(ctx, {});
    const transcripts = createTranscriptReader(ctx, {});
    const transcriptWatcher = createTranscriptWatcher(ctx, { sessions, transcripts });
    const rawUsage = createUsageSource(ctx, { ccwLegacy });
    const usage = readOnly ? readOnlyUsage(rawUsage) : rawUsage;
    // Read-only: blocking PermissionRequest hooks get "no decision" at once
    // (maxBlocking 0), so Claude asks in the terminal; the card is still shown.
    const rawHooks = createHooksBridge(ctx, { sessions, transcripts }, readOnly ? { maxBlocking: 0 } : undefined);
    const hooks = readOnly ? readOnlyHooks(rawHooks) : rawHooks;
    const rawTerminal: TerminalBackend =
      opts.terminal === false
        ? new NullTerminalBackend()
        : opts.terminal
          ? opts.terminal(ctx)
          : (picked?.backend ?? new NullTerminalBackend());
    const terminal = readOnly ? readOnlyTerminal(rawTerminal) : rawTerminal;
    const rawWriter = createWriter(ctx, { sessions, terminal, transcripts, hooks, ccwLegacy });
    const writer = readOnly ? readOnlyWriter(rawWriter) : rawWriter;
    // v0.6: a node pushes nothing (the hub pushes for it, from the events it re-emits).
    const webPush = node ? [] : opts.pushSender ? [new WebPushNotifier(ctx, { sender: opts.pushSender })] : createNotifiers(ctx, {});
    const notifiers = node ? [] : [...webPush, ...(opts.extraNotifiers?.(ctx) ?? [])];
    // v0.3. Files only read, so --read-only leaves them be; the terminal and
    // writer wrappers above already cover keys, windows and slash commands.
    // v0.6: on a node only the path policy is used (the launcher's folders); its routes are never served there.
    const files: FilesService = createFilesService(ctx, { sessions, notifiers });
    const off = node ? nodeOffParts() : null;
    const changes: ChangesService = off ? off.changes : createChangesService(ctx, { sessions, transcripts, files });
    const rawRewrite: RewriteService = off ? off.rewrite : createRewriteService(ctx, { sessions, transcripts, hooks, usage, ccwLegacy, files, changes });
    const rewrite = readOnly && !off ? readOnlyRewrite(rawRewrite) : rawRewrite;
    const rawLauncher = createLauncher(ctx, { sessions, terminal, writer, usage, ccwLegacy, files, notifiers });
    const launcher = readOnly ? readOnlyLauncher(rawLauncher) : rawLauncher;
    const controls = createControlsService(ctx, { sessions, terminal, writer, hooks, transcripts, ccwLegacy });
    // v0.4. Life writes are allowed under --read-only (it is about sessions), but not Ask Claude (it spends quota);
    // Life catches its own start errors.
    const lifeDeps = { sessions, usage, ccwLegacy, notifiers };
    const life: LifeService = off
      ? off.life
      : readOnly
        ? buildLifeService(ctx, lifeDeps, readOnlyLifeBuilders(LIFE_MODULE_BUILDERS))
        : createLifeService(ctx, lifeDeps);
    const intel: IntelService = off ? off.intel : createIntelService(ctx, { files });
    // v0.5. Meetings are told --read-only, not wrapped: capture and edits are Jantar's own files, summaries spend quota.
    const meetings: MeetingsService = off ? off.meetings : createMeetingsService(ctx, { life, usage, ccwLegacy }, { readOnly });
    // v0.4. Primes free 5-hour windows while accounts.prime is on; never under --read-only (it runs cswap).
    const primer: Service | null = off ? null : createPrimer(ctx, { usage, ccwLegacy }, { readOnly });
    const notifications: NotificationRouter = off ? off.notifications : createNotificationRouter(ctx, { notifiers });
    // v0.6: the hub's Fleet part (inert while Fleet is off), or a node's link to its hub. The node's
    // executor runs the hub's calls through the api's link app, which exists once the api has started.
    const fleet = node ? offFleet() : createFleet(ctx, {});
    let apiRef: ApiServerImpl | null = null;
    const injector: LinkInjector = {
      inject: (req) => apiRef?.link()?.inject(req) ?? Promise.resolve({ status: 503, body: errorBody('unavailable', 'jantard is starting') }),
    };
    // What the node reports of itself in its auth frame: the phone offers typing and starting only where they work.
    const nodeLink: NodeLinkService = node
      ? createNodeLink(ctx, { executor: createExecutor(ctx, injector), self: { backend: nodeBackendOf(mode, rawTerminal), readOnly } })
      : offNodeLink();
    const apiOpts: ApiOptions = { ...opts.api, mode };
    if (opts.port !== undefined) apiOpts.port = opts.port;
    const api = createApiServerWith(
      ctx,
      {
        sessions,
        transcripts,
        transcriptWatcher,
        usage,
        ccwLegacy,
        hooks,
        terminal,
        writer,
        notifiers,
        files,
        changes,
        rewrite,
        launcher,
        controls,
        life,
        intel,
        meetings,
        fleet,
        nodeLink,
      },
      apiOpts,
    );
    apiRef = api;
    parts = {
      sessions,
      transcripts,
      transcriptWatcher,
      usage,
      ccwLegacy,
      hooks,
      terminal,
      writer,
      notifiers,
      files,
      changes,
      rewrite,
      launcher,
      controls,
      life,
      intel,
      meetings,
      notifications,
      fleet,
      nodeLink,
      api,
    };

    // 4. Services, in order.
    const services: NamedService[] = [];
    if (opts.rotateLogs !== false) {
      services.push(['logRotator', new LogRotator({ logsDir: ctx.paths.logsDir, clock: ctx.clock, log, files: DAEMON_LOG_FILES })]);
    }
    services.push(['ccwLegacy', ccwLegacy], ['sessions', sessions], ['transcriptWatcher', transcriptWatcher], ['usage', usage], ['hooks', hooks]);
    // v0.6: a backend with work of its own (tmux's pane tick) runs between the hooks and the writer.
    const start = terminal.start?.bind(terminal);
    const stop = terminal.stop?.bind(terminal);
    if (start && stop) services.push(['terminal', { start, stop }]);
    services.push(['writer', writer], ['files', files]);
    if (node) {
      services.push(['launcher', launcher], ['controls', controls], ['api', api], ['nodeLink', nodeLink]);
    } else {
      services.push(
        ['changes', changes],
        ['rewrite', rewrite],
        ['launcher', launcher],
        ['controls', controls],
        ['life', life],
        ['intel', intel],
        ['meetings', meetings],
        ...(primer ? ([['primer', primer]] as NamedService[]) : []),
        ['notifications', notifications],
        ['fleet', fleet],
        ['api', api],
      );
    }
    stopServices = await startServices(services, log);
  } catch (e) {
    closeDb();
    throw e;
  }

  log.info('jantard started', {
    pid: process.pid,
    version: ctx.version.daemon,
    port: parts.api.address()?.port,
    readOnly,
    terminal: terminalMode,
    role,
    home: ctx.paths.home,
  });

  let stopping: Promise<void> | null = null;
  return {
    ctx,
    parts,
    mode,
    address: () => parts.api.address(),
    stop() {
      stopping ??= (async () => {
        try {
          await stopServices();
        } finally {
          closeDb();
          log.info('jantard stopped');
        }
      })();
      return stopping;
    },
  };
}
