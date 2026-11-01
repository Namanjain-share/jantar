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
 *      ask -> primer -> notifications -> api (the v0.3, v0.4, v0.5 and
 *      v0.5.3 parts sit behind their switches; the API refuses their routes
 *      while a switch is off)
 *   4. startServices() in that order; stop() runs them down in reverse.
 *
 * v0.5.3: one PaneLookup (api/services.ts) is built on the terminal before
 * the notifications part, and both the router (Claude's countdown, read off
 * an unattended ask's screen) and the API use it, so they share its cache.
 *
 * main.ts calls startDaemon() with the command-line flags; the end-to-end
 * tests call it with a synthetic HOME and a scripted terminal, so both run
 * exactly this wiring.
 */
import type {
  Clock,
  DaemonContext,
  DbOpener,
  Logger,
  Notifier,
  Parts,
  ProcessProbe,
  TerminalBackend,
} from './contracts.js';
import type { Env } from './config.js';
import { createDaemonContext } from './context.js';
import { startServices, type NamedService } from './lifecycle.js';
import { DAEMON_LOG_FILES, LogRotator } from './log-rotate.js';
import {
  NullTerminalBackend,
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
import { createTerminalAppBackend } from './terminal/terminal-app/index.js';
import { createWriter } from './writer/index.js';
import { createChangesService, createFilesService } from './files/index.js';
import { createRewriteService } from './rewrite/index.js';
import { createLauncher } from './launcher/index.js';
import { createControlsService } from './controls/index.js';
import { createLifeService, LIFE_MODULE_BUILDERS } from './life/index.js';
import { buildLifeService } from './life/service.js';
import { createIntelService } from './intel/index.js';
import { createMeetingsService } from './meetings/index.js';
import { createAskService } from './ask/index.js';
import { createPrimer } from './primer/index.js';
import { WebPushNotifier, createNotificationRouter, createNotifiers, type PushSender } from './notify/index.js';
import { PaneLookup, createApiServerWith, type ApiOptions } from './api/index.js';

export interface DaemonOptions {
  /** Environment (HOME, JANTAR_HOME, ...). Default process.env. */
  env?: Env;
  /** TCP port; overrides settings.remote.port. 0 picks a free port. */
  port?: number;
  /** Refuse every action on sessions, terminals, cards, cswap and settings (see modes.ts). */
  readOnly?: boolean;
  /**
   * Terminal backend. Default: Terminal.app. `false` turns terminal access off
   * (--no-terminal); a function injects another backend (tests).
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
  const terminalMode: TerminalMode = opts.terminal === false ? 'off' : opts.terminal ? 'injected' : 'terminal-app';
  const mode: DaemonMode = { readOnly, terminal: terminalMode };

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
    const ccwLegacy = createCcwLegacySource(ctx, {});
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
          : createTerminalAppBackend(ctx, {});
    const terminal = readOnly ? readOnlyTerminal(rawTerminal) : rawTerminal;
    const rawWriter = createWriter(ctx, { sessions, terminal, transcripts, hooks, ccwLegacy });
    const writer = readOnly ? readOnlyWriter(rawWriter) : rawWriter;
    const webPush = opts.pushSender ? [new WebPushNotifier(ctx, { sender: opts.pushSender })] : createNotifiers(ctx, {});
    const notifiers = [...webPush, ...(opts.extraNotifiers?.(ctx) ?? [])];
    // v0.3. Files only read, so --read-only leaves them be; the terminal and
    // writer wrappers above already cover keys, windows and slash commands.
    const files = createFilesService(ctx, { sessions, notifiers });
    const changes = createChangesService(ctx, { sessions, transcripts, files });
    const rawRewrite = createRewriteService(ctx, { sessions, transcripts, hooks, usage, ccwLegacy, files, changes });
    const rewrite = readOnly ? readOnlyRewrite(rawRewrite) : rawRewrite;
    const rawLauncher = createLauncher(ctx, { sessions, terminal, writer, usage, ccwLegacy, files, notifiers });
    const launcher = readOnly ? readOnlyLauncher(rawLauncher) : rawLauncher;
    const controls = createControlsService(ctx, { sessions, terminal, writer, hooks, transcripts, ccwLegacy });
    // v0.4. Life writes are allowed under --read-only (it is about sessions), but not Ask Claude (it spends quota);
    // Life catches its own start errors.
    const lifeDeps = { sessions, usage, ccwLegacy, notifiers };
    const life = readOnly ? buildLifeService(ctx, lifeDeps, readOnlyLifeBuilders(LIFE_MODULE_BUILDERS)) : createLifeService(ctx, lifeDeps);
    const intel = createIntelService(ctx, { files });
    // v0.5. Meetings are told --read-only, not wrapped: capture and edits are Jantar's own files, summaries spend quota.
    const meetings = createMeetingsService(ctx, { life, usage, ccwLegacy }, { readOnly });
    // v0.5.3. Ask is told --read-only too: its taps are Life writes (allowed), its runs spend quota (never).
    const ask = createAskService(ctx, { life, usage, ccwLegacy }, { readOnly });
    // v0.4. Primes free 5-hour windows while accounts.prime is on; never under --read-only (it runs cswap).
    const primer = createPrimer(ctx, { usage, ccwLegacy }, { readOnly });
    const panes = new PaneLookup(terminal, ctx, undefined, opts.api?.paneLookupTimeoutMs);
    const notifications = createNotificationRouter(ctx, { notifiers, terminal, panes });
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
        ask,
        panes,
      },
      apiOpts,
    );
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
      ask,
      notifications,
      api,
    };

    // 4. Services, in order.
    const services: NamedService[] = [];
    if (opts.rotateLogs !== false) {
      services.push(['logRotator', new LogRotator({ logsDir: ctx.paths.logsDir, clock: ctx.clock, log, files: DAEMON_LOG_FILES })]);
    }
    services.push(
      ['ccwLegacy', ccwLegacy],
      ['sessions', sessions],
      ['transcriptWatcher', transcriptWatcher],
      ['usage', usage],
      ['hooks', hooks],
      ['writer', writer],
      ['files', files],
      ['changes', changes],
      ['rewrite', rewrite],
      ['launcher', launcher],
      ['controls', controls],
      ['life', life],
      ['intel', intel],
      ['meetings', meetings],
      ['ask', ask],
      ['primer', primer],
      ['notifications', notifications],
      ['api', api],
    );
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
